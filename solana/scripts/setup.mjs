// Konfiguracja wdrożonego programu: mint testowego USDC, persony demo, oracle, reguły (initialize).
// Uruchom po `anchor deploy`:  node scripts/setup.mjs devnet   (albo localnet)
//
// Reguły zapisane przez `initialize` są niezmienne — program nie ma żadnej instrukcji, która by je zmieniała.
import fs from "node:fs";
import path from "node:path";
import { Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { createMint } from "@solana/spl-token";
import anchor from "@coral-xyz/anchor";
import {
  CLUSTER,
  KEYS,
  PROGRAM_ID,
  RPC,
  WEB_LIB,
  connection,
  demoKeys,
  deployer,
  pda,
  programFor,
  readDeployments,
  sleep,
  transferSol,
} from "./common.mjs";

const { BN } = anchor;

// Krótkie okna, żeby demo na żywo domknęło się w kilka minut (w produkcji: dni).
const WINDOWS = process.argv[2] === "localnet" && process.argv[3] !== "demo"
  ? // localnet: sekundy — test e2e sprawdza też rozliczenia po terminie
    { ship: 6, transit: 4, inspection: 4, response: 6, arbitration: 8, reveal: 6 }
  : {
  ship: 15 * 60, // sprzedawca ma tyle na nadanie
  transit: 5 * 60, // przesyłka w drodze
  inspection: 3 * 60, // okno reklamacji po doręczeniu
  response: 5 * 60, // sprzedawca odpowiada na reklamację
  arbitration: 5 * 60, // niejawne głosy
  reveal: 3 * 60, // ujawnianie głosów
};
const BOND_BPS = 500; // kaucja w sporze: 5%

const PERSONAS = [
  ["Alicja", "sprzedawczyni"],
  ["Bartek", "kupujący"],
  ["Celina", "obca osoba"],
  ["Arbiter 1", "arbiter"],
  ["Arbiter 2", "arbiter"],
  ["Arbiter 3", "arbiter"],
];
const ORACLES = ["API InPost", "Skan w paczkomacie", "Niezależny węzeł"];

/** Klucze person trafiają do web/.env.local (poza gitem) jako NEXT_PUBLIC_DEMO_KEYS — po zmianie zrestartuj `npm run dev`. */
function writeEnvKeys(j) {
  const envFile = path.join(WEB_LIB, "..", ".env.local");
  const compact = JSON.stringify({ personas: j.personas, oracles: j.oracles });
  const lines = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8").split(/?
/).filter((l) => l && !l.startsWith("NEXT_PUBLIC_DEMO_KEYS=")) : [];
  lines.push(`NEXT_PUBLIC_DEMO_KEYS=${compact}`);
  fs.writeFileSync(envFile, lines.join("
") + "
");
}

function ensureKeys() {
  const file = path.join(KEYS, "demo-keys.json");
  if (!fs.existsSync(file)) {
    const gen = (extra) => ({ ...extra, secret: Array.from(Keypair.generate().secretKey) });
    const j = {
      note: "Klucze person demo — TYLKO Solana devnet/localnet, bez żadnej wartości.",
      personas: PERSONAS.map(([name, role]) => gen({ name, role })),
      oracles: ORACLES.map((name) => gen({ name })),
    };
    fs.mkdirSync(KEYS, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(j, null, 2));
    console.log("Wygenerowano klucze person:", file);
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
    mint = await createMint(connection, admin, pda.mintAuth(), null, 6);
    console.log("Mint testowego USDC:", mint.toBase58());
    await program.methods
      .initialize({
        oracles: keys.oracles.map((k) => k.publicKey),
        oracleQuorum: 2,
        arbiters: ["Arbiter 1", "Arbiter 2", "Arbiter 3"].map((n) => keys.personas[n].publicKey),
        arbiterQuorum: 2,
        shipWindow: new BN(WINDOWS.ship),
        transitWindow: new BN(WINDOWS.transit),
        inspectionWindow: new BN(WINDOWS.inspection),
        responseWindow: new BN(WINDOWS.response),
        arbitrationWindow: new BN(WINDOWS.arbitration),
        revealWindow: new BN(WINDOWS.reveal),
        bondBps: BOND_BPS,
      })
      .accountsPartial({ payer: admin.publicKey, config: configPda, mint })
      .rpc();
    await sleep(500);
    cfg = await program.account.config.fetch(configPda);
    console.log("Reguły zapisane on-chain (initialize).");
  }

  all[CLUSTER] = {
    cluster: CLUSTER,
    rpc: RPC,
    programId: PROGRAM_ID.toBase58(),
    mint: mint.toBase58(),
    config: configPda.toBase58(),
    oracles: cfg.oracles.map((k) => k.toBase58()),
    oracleQuorum: cfg.oracleQuorum,
    arbiters: cfg.arbiters.map((k) => k.toBase58()),
    arbiterQuorum: cfg.arbiterQuorum,
    windows: {
      ship: Number(cfg.shipWindow),
      transit: Number(cfg.transitWindow),
      inspection: Number(cfg.inspectionWindow),
      response: Number(cfg.responseWindow),
      arbitration: Number(cfg.arbitrationWindow),
      reveal: Number(cfg.revealWindow),
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
