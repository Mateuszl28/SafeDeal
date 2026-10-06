// Konfiguracja wdrożonego programu: mint testowego USDC, persony demo, oracle, reguły (initialize).
// Uruchom po `anchor deploy`:  node scripts/setup.mjs devnet   (albo localnet)
//
// Reguły zapisane przez `initialize` są niezmienne — program nie ma żadnej instrukcji, która by je zmieniała.
import fs from "node:fs";
import path from "node:path";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { createMint, getMint } from "@solana/spl-token";
import anchor from "@coral-xyz/anchor";
import {
  CLUSTER,
  KEYS,
  PROGRAM_ID,
  RPC,
  WEB_LIB,
  client,
  connection,
  demoKeys,
  deployer,
  pda,
  programFor,
  readDeployments,
  sleep,
  transferSol,
  usdc,
} from "./common.mjs";

const { BN } = anchor;

// Krótkie okna, żeby demo na żywo domknęło się w kilka minut (w produkcji: dni).
const WINDOWS = process.argv[2] === "localnet" && process.argv[3] !== "demo"
  ? // localnet: sekundy — test e2e sprawdza też rozliczenia po terminie
    { ship: 6, transit: 4, inspection: 4, response: 6, arbitration: 8, reveal: 6, archive: 4 }
  : {
  ship: 15 * 60, // sprzedawca ma tyle na nadanie
  transit: 5 * 60, // przesyłka w drodze
  inspection: 3 * 60, // okno reklamacji po doręczeniu
  response: 5 * 60, // sprzedawca odpowiada na reklamację
  arbitration: 5 * 60, // niejawne głosy
  reveal: 3 * 60, // ujawnianie głosów
  archive: 10 * 60, // po tylu od zamknięcia można zamknąć konta bez kompletu opinii
};
const BOND_BPS = 500; // kaucja w sporze: 5%
const ARBITER_STAKE = usdc(100); // minimalna kaucja, żeby wejść do puli arbitrów
const MISS_SLASH = usdc(20); // spalane z kaucji za nieoddany głos
const DEMO_STAKE = usdc(200); // persony-arbitrzy wpłacają więcej — jedna nieobecność nie wyrzuca z puli
const ARBITERS = ["Arbiter 1", "Arbiter 2", "Arbiter 3", "Arbiter 4", "Arbiter 5"];

const PERSONAS = [
  ["Alicja", "sprzedawczyni"],
  ["Bartek", "kupujący"],
  ["Celina", "obca osoba"],
  ["Arbiter 1", "arbiter"],
  ["Arbiter 2", "arbiter"],
  ["Arbiter 3", "arbiter"],
  ["Arbiter 4", "arbiter"],
  ["Arbiter 5", "arbiter"],
];
const ORACLES = ["API InPost", "Skan w paczkomacie", "Niezależny węzeł"];

/** Klucze person trafiają do web/.env.local (poza gitem) jako NEXT_PUBLIC_DEMO_KEYS — po zmianie zrestartuj `npm run dev`. */
function writeEnvKeys(j) {
  const envFile = path.join(WEB_LIB, "..", ".env.local");
  const compact = JSON.stringify({ personas: j.personas, oracles: j.oracles });
  const lines = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8").split(/\r?\n/).filter((l) => l && !l.startsWith("NEXT_PUBLIC_DEMO_KEYS=")) : [];
  lines.push(`NEXT_PUBLIC_DEMO_KEYS=${compact}`);
  fs.writeFileSync(envFile, lines.join("\n") + "\n");
}

function ensureKeys() {
  const file = path.join(KEYS, "demo-keys.json");
  const gen = (extra) => ({ ...extra, secret: Array.from(Keypair.generate().secretKey) });
  if (!fs.existsSync(file)) {
    const j = {
      note: "Klucze person demo — TYLKO Solana devnet/localnet, bez żadnej wartości.",
      personas: PERSONAS.map(([name, role]) => gen({ name, role })),
      oracles: ORACLES.map((name) => gen({ name })),
    };
    fs.mkdirSync(KEYS, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(j, null, 2));
    console.log("Wygenerowano klucze person:", file);
  } else {
    // Dopisz persony dodane w nowszej wersji (np. kolejnych arbitrów), istniejące klucze zostają.
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    const missing = PERSONAS.filter(([name]) => !j.personas.some((p) => p.name === name));
    if (missing.length) {
      j.personas.push(...missing.map(([name, role]) => gen({ name, role })));
      fs.writeFileSync(file, JSON.stringify(j, null, 2));
      console.log("Dopisano persony:", missing.map(([n]) => n).join(", "));
    }
  }
  writeEnvKeys(JSON.parse(fs.readFileSync(file, "utf8")));
  return demoKeys();
}

async function main() {
  console.log(`Klaster: ${CLUSTER} (${RPC}), program: ${PROGRAM_ID.toBase58()}`);
  const info = await connection.getAccountInfo(PROGRAM_ID);
  if (!info?.executable) throw new Error("Program nie jest wdrożony na tym klastrze — najpierw `anchor deploy`.");

  const admin = deployer();
  const keys = ensureKeys();
  const people = Object.values(keys.personas);

  if (CLUSTER === "localnet") {
    await connection.confirmTransaction(await connection.requestAirdrop(admin.publicKey, 100 * LAMPORTS_PER_SOL), "confirmed");
  }
  console.log(`Wdrażający: ${admin.publicKey.toBase58()} — ${(await connection.getBalance(admin.publicKey)) / LAMPORTS_PER_SOL} SOL`);

  // SOL na opłaty i rent dla person (sprzedawczyni płaci rent za konta ofert).
  const target = { Alicja: 0.4, Bartek: 0.25 };
  for (const [name, kp] of Object.entries(keys.personas)) {
    const want = target[name] ?? 0.05;
    const have = (await connection.getBalance(kp.publicKey)) / LAMPORTS_PER_SOL;
    if (have < want * 0.5) await transferSol(admin, kp.publicKey, want - have);
  }
  for (const kp of keys.oracles) {
    if ((await connection.getBalance(kp.publicKey)) < 0.01 * LAMPORTS_PER_SOL) await transferSol(admin, kp.publicKey, 0.03);
  }
  console.log("Persony i oracle mają SOL na opłaty.");

  const all = readDeployments();
  const configPda = pda.config();
  const program = programFor(admin);
  let cfg = await program.account.config.fetchNullable(configPda);

  let mint;
  if (cfg) {
    mint = cfg.mint;
    console.log("Program już zainicjalizowany — reguły są niezmienne, używam istniejących.");
  } else {
    // Mint testowego USDC: jedynym, kto może drukować, jest PDA programu (instrukcja `faucet`).
    // Mint z wcześniejszego setupu tego samego programu (mint authority = jego PDA) — używamy go, salda zostają.
    const prev = all[CLUSTER]?.mint;
    let reuse = null;
    if (prev) {
      try {
        const m = await getMint(connection, new PublicKey(prev), "confirmed");
        if (m.mintAuthority?.equals(pda.mintAuth())) reuse = m.address;
      } catch {
        /* mint nie istnieje na tym klastrze */
      }
    }
    mint = reuse ?? (await createMint(connection, admin, pda.mintAuth(), null, 6));
    console.log(`Mint testowego USDC${reuse ? " (istniejący)" : ""}:`, mint.toBase58());
    await program.methods
      .initialize({
        oracles: keys.oracles.map((k) => k.publicKey),
        oracleQuorum: 2,
        arbiterQuorum: 2,
        arbiterStake: new BN(ARBITER_STAKE.toString()),
        missSlash: new BN(MISS_SLASH.toString()),
        shipWindow: new BN(WINDOWS.ship),
        transitWindow: new BN(WINDOWS.transit),
        inspectionWindow: new BN(WINDOWS.inspection),
        responseWindow: new BN(WINDOWS.response),
        arbitrationWindow: new BN(WINDOWS.arbitration),
        revealWindow: new BN(WINDOWS.reveal),
        archiveWindow: new BN(WINDOWS.archive),
        bondBps: BOND_BPS,
      })
      .accountsPartial({ payer: admin.publicKey, config: configPda, pool: pda.pool(), poolVault: pda.poolVault(), mint })
      .rpc();
    await sleep(500);
    cfg = await program.account.config.fetch(configPda);
    console.log("Reguły zapisane on-chain (initialize).");
  }

  // Arbitrzy demo dołączają do otwartej puli (każdy może to zrobić z własną kaucją).
  const c = client(mint);
  for (const name of ARBITERS) {
    const kp = keys.personas[name];
    const a = await c.fetchArbiter(kp.publicKey);
    if (a?.inPool) continue;
    while ((await c.balance(kp.publicKey)) < DEMO_STAKE) await c.faucet(kp);
    await c.joinPool(kp, DEMO_STAKE);
  }
  const pool = await c.fetchPool();
  console.log(`Pula arbitrów: ${pool.members.length} osób.`);

  all[CLUSTER] = {
    cluster: CLUSTER,
    rpc: RPC,
    programId: PROGRAM_ID.toBase58(),
    mint: mint.toBase58(),
    config: configPda.toBase58(),
    oracles: cfg.oracles.map((k) => k.toBase58()),
    oracleQuorum: cfg.oracleQuorum,
    arbiterQuorum: cfg.arbiterQuorum,
    panelSize: 3,
    arbiterStake: cfg.arbiterStake.toString(),
    missSlash: cfg.missSlash.toString(),
    windows: {
      ship: Number(cfg.shipWindow),
      transit: Number(cfg.transitWindow),
      inspection: Number(cfg.inspectionWindow),
      response: Number(cfg.responseWindow),
      arbitration: Number(cfg.arbitrationWindow),
      reveal: Number(cfg.revealWindow),
      archive: Number(cfg.archiveWindow),
    },
    bondBps: cfg.bondBps,
    deployedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(WEB_LIB, "deployments.json"), JSON.stringify(all, null, 2) + "\n");
  console.log(`Zapisano web/lib/deployments.json [${CLUSTER}]`);
  console.log("Persony:", people.map((k) => k.publicKey.toBase58().slice(0, 6)).join(", "));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
