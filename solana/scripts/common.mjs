// Wspólny klient dla skryptów (setup, seed, e2e, relayer). Te same PDA i instrukcje co frontend.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import anchor from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SYSVAR_SLOT_HASHES_PUBKEY,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

const { AnchorProvider, BN, Program, Wallet } = anchor;

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const WEB_LIB = path.resolve(ROOT, "..", "web", "lib");
export const KEYS = path.join(ROOT, "keys");

export const CLUSTER = process.argv[2] || process.env.CLUSTER || "localnet";
export const RPC =
  process.env.RPC || (CLUSTER === "devnet" ? "https://api.devnet.solana.com" : "http://127.0.0.1:8899");

export const idl = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts", "idl.json"), "utf8"));
export const PROGRAM_ID = new PublicKey(idl.address);
export const connection = new Connection(RPC, {
  commitment: "confirmed",
  // Alchemy i podobni nie obsługują subskrypcji — potwierdzenia przez publiczny WebSocket
  wsEndpoint: process.env.WS || (process.env.RPC && CLUSTER === "devnet" ? "wss://api.devnet.solana.com" : undefined),
});

export const usdc = (n) => BigInt(Math.round(n * 1_000_000));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function loadKeypair(file) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8"))));
}

export function deployer() {
  const file = path.join(KEYS, "deployer.json");
  if (!fs.existsSync(file)) throw new Error(`Brak ${file} — uruchom najpierw deploy (patrz README).`);
  return loadKeypair(file);
}

export function programFor(kp) {
  const provider = new AnchorProvider(connection, new Wallet(kp), { commitment: "confirmed" });
  return new Program(idl, provider);
}

// ───────────────────────────── PDA ─────────────────────────────

const u64le = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const find = (seeds) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
export const pda = {
  config: () => find([Buffer.from("config")]),
  mintAuth: () => find([Buffer.from("mint_auth")]),
  deal: (id) => find([Buffer.from("deal"), u64le(id)]),
  vault: (deal) => find([Buffer.from("vault"), deal.toBuffer()]),
  profile: (owner) => find([Buffer.from("profile"), owner.toBuffer()]),
  pool: () => find([Buffer.from("pool")]),
  poolVault: () => find([Buffer.from("pool_vault")]),
  arbiter: (owner) => find([Buffer.from("arbiter"), owner.toBuffer()]),
};
export const ata = (mint, owner) => getAssociatedTokenAddressSync(mint, owner, true);

// ───────────────────────────── hashe (jak w programie) ─────────────────────────────

export const sha256 = (...parts) => crypto.createHash("sha256").update(Buffer.concat(parts.map((p) => Buffer.from(p)))).digest();
export const voteCommitment = (id, arbiter, forBuyer, salt) =>
  sha256(u64le(id), arbiter.toBuffer(), Buffer.from([forBuyer ? 1 : 0]), salt);
export const codeBytes = (code) => sha256(Buffer.from(code));
export const pickupHash = (id, code) => sha256(u64le(id), codeBytes(code));

export const PANEL = 3;

/** Hash najwcześniejszego slotu ≥ target z sysvaru SlotHashes (jak slot_hash_at_or_after w programie). */
export function slotHashAtOrAfter(data, target) {
  const n = Number(data.readBigUInt64LE(0));
  let found = null;
  for (let i = 0; i < n; i++) {
    const off = 8 + i * 40;
    if (off + 40 > data.length) break;
    if (data.readBigUInt64LE(off) < BigInt(target)) return found;
    found = data.subarray(off + 8, off + 40);
  }
  return null;
}

/** Losowanie składu — ten sam algorytm co pick_panel w programie. */
export function pickPanel(members, id, seed, buyer, seller) {
  const cand = members.filter((m) => !m.equals(buyer) && !m.equals(seller));
  if (cand.length < PANEL) throw new Error("W puli jest za mało arbitrów");
  const out = [];
  for (let j = 0; j < PANEL; j++) {
    const h = sha256(seed, u64le(id), Buffer.from([j]));
    out.push(...cand.splice(Number(h.readBigUInt64LE(0) % BigInt(cand.length)), 1));
  }
  return out;
}

// ───────────────────────────── klient ─────────────────────────────

export async function send(ixs, signers) {
  const tx = new Transaction().add(...ixs);
  return sendAndConfirmTransaction(connection, tx, signers, { commitment: "confirmed" });
}

export async function transferSol(from, to, sol) {
  return send([SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports: Math.round(sol * LAMPORTS_PER_SOL) })], [from]);
}

/** Klient akcji na transakcji — `who` podpisuje i płaci opłatę. */
export function client(mint) {
  const config = pda.config();
  const bn = (v) => new BN(v.toString());
  const ensureAta = (payer, owner) =>
    createAssociatedTokenAccountIdempotentInstruction(payer, ata(mint, owner), owner, mint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

  const fetchDeal = (id) => programFor(Keypair.generate()).account.deal.fetch(pda.deal(id));
  const dealCount = async () => BigInt((await programFor(Keypair.generate()).account.config.fetch(config)).dealCount.toString());

  async function payoutAccounts(who, id) {
    const d = await fetchDeal(id);
    const dealPda = pda.deal(id);
    return {
      d,
      pre: [ensureAta(who.publicKey, d.buyer), ensureAta(who.publicKey, d.seller)],
      accounts: {
        actor: who.publicKey,
        config,
        deal: dealPda,
        vault: pda.vault(dealPda),
        buyerAta: ata(mint, d.buyer),
        sellerAta: ata(mint, d.seller),
        buyerProfile: pda.profile(d.buyer),
        sellerProfile: pda.profile(d.seller),
        tokenProgram: TOKEN_PROGRAM_ID,
      },
    };
  }

  const api = {
    fetchDeal,
    dealCount,
    async faucet(who) {
      const p = programFor(who);
      const ix = await p.methods
        .faucet()
        .accountsPartial({
          user: who.publicKey,
          config,
          mint,
          mintAuthority: pda.mintAuth(),
          userAta: ata(mint, who.publicKey),
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .instruction();
      return send([ix], [who]);
    },
    async createDeal(who, { amount, title, buyer = null, description = "", photoUri = "", photoHash = Buffer.alloc(32), pickupAllowed = false }) {
      const id = (await dealCount()) + 1n;
      const dealPda = pda.deal(id);
      const ix = await programFor(who)
        .methods.createDeal({ amount: bn(amount), title, buyer, description, photoUri, photoHash: [...photoHash], pickupAllowed })
        .accountsPartial({
          seller: who.publicKey,
          config,
          deal: dealPda,
          vault: pda.vault(dealPda),
          mint,
          sellerProfile: pda.profile(who.publicKey),
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .instruction();
      await send([ix], [who]);
      return id;
    },
    async simple(who, method, id, args = [], role = "seller") {
      const keyName = { seller: "seller", actor: "actor", oracle: "oracle", arbiter: "arbiter" }[role];
      const accounts = { [keyName]: who.publicKey, deal: pda.deal(id) };
      if (role !== "actor") accounts.config = config;
      const ix = await programFor(who).methods[method](...args).accountsPartial(accounts).instruction();
      return send([ix], [who]);
    },
    cancel: (who, id) => api.simple(who, "cancel", id),
    markShipped: (who, id, tracking) => api.simple(who, "markShipped", id, [tracking]),
    confirmDelivery: (oracle, id) => api.simple(oracle, "confirmDelivery", id, [], "oracle"),
    commitVote: (arb, id, commitment) => api.simple(arb, "commitVote", id, [[...commitment]], "arbiter"),
    proposeSettlement: (who, id, buyerAmount) => api.simple(who, "proposeSettlement", id, [bn(buyerAmount)], "actor"),
    submitEvidence: (who, id, uri, hash, note) => api.simple(who, "submitEvidence", id, [uri, [...hash], note], "actor"),
    async fund(who, id, pickup = null) {
      const dealPda = pda.deal(id);
      const ix = await programFor(who)
        .methods.fund(pickup ? [...pickup] : null)
        .accountsPartial({
          buyer: who.publicKey,
          config,
          deal: dealPda,
          vault: pda.vault(dealPda),
          buyerAta: ata(mint, who.publicKey),
          buyerProfile: pda.profile(who.publicKey),
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .instruction();
      return send([ix], [who]);
    },
    async deposit(who, method, id, args = []) {
      const dealPda = pda.deal(id);
      const ix = await programFor(who)
        .methods[method](...args)
        .accountsPartial({
          actor: who.publicKey,
          config,
          deal: dealPda,
          vault: pda.vault(dealPda),
          actorAta: ata(mint, who.publicKey),
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction();
      return send([ix], [who]);
    },
    openDispute: (who, id, reason) => api.deposit(who, "openDispute", id, [reason]),
    respondToDispute: (who, id) => api.deposit(who, "respondToDispute", id),
    async payout(who, method, id, args = [], remaining = []) {
      const { pre, accounts } = await payoutAccounts(who, id);
      let b = programFor(who).methods[method](...args).accountsPartial(accounts);
      if (remaining.length) b = b.remainingAccounts(remaining);
      return send([...pre, await b.instruction()], [who]);
    },
    confirmReceipt: (who, id) => api.payout(who, "confirmReceipt", id),
    refundBuyer: (who, id) => api.payout(who, "refundBuyer", id),
    settleExpired: (who, id) => api.payout(who, "settleExpired", id),
    confirmPickup: (who, id, code) => api.payout(who, "confirmPickup", id, [[...codeBytes(code)]]),
    acceptSettlement: (who, id, buyerAmount) => api.payout(who, "acceptSettlement", id, [bn(buyerAmount)]),
    revealVote: (arb, id, forBuyer, salt) => api.payout(arb, "revealVote", id, [forBuyer, [...salt]]),
    fetchPool: () => programFor(Keypair.generate()).account.pool.fetch(pda.pool()),
    fetchArbiter: (owner) => programFor(Keypair.generate()).account.arbiter.fetchNullable(pda.arbiter(owner)),
    async poolAction(who, method, args = []) {
      const ix = await programFor(who)
        .methods[method](...args)
        .accountsPartial({
          owner: who.publicKey,
          config,
          pool: pda.pool(),
          poolVault: pda.poolVault(),
          arbiter: pda.arbiter(who.publicKey),
          ownerAta: ata(mint, who.publicKey),
          tokenProgram: TOKEN_PROGRAM_ID,
          ...(method === "joinPool" ? { systemProgram: SystemProgram.programId } : {}),
        })
        .instruction();
      return send([ix], [who]);
    },
    joinPool: (who, stake) => api.poolAction(who, "joinPool", [bn(stake)]),
    leavePool: (who) => api.poolAction(who, "leavePool"),
    /** Czeka na slot losowania, liczy skład z SlotHashes i wysyła draw_panel. Zwraca skład. */
    async drawPanel(who, id) {
      for (let attempt = 0; attempt < 20; attempt++) {
        const d = await fetchDeal(id);
        if (d.panelDrawn) return d.panel;
        const target = BigInt(d.drawSlot.toString());
        while (BigInt(await connection.getSlot("confirmed")) <= target) await sleep(200);
        const sysvar = await connection.getAccountInfo(SYSVAR_SLOT_HASHES_PUBKEY, "confirmed");
        const seed = slotHashAtOrAfter(sysvar.data, target);
        const remaining = seed
          ? pickPanel((await api.fetchPool()).members, BigInt(id), seed, d.buyer, d.seller).map((a) => ({
              pubkey: pda.arbiter(a),
              isSigner: false,
              isWritable: true,
            }))
          : [];
        const ix = await programFor(who)
          .methods.drawPanel()
          .accountsPartial({ actor: who.publicKey, config, pool: pda.pool(), deal: pda.deal(id), slotHashes: SYSVAR_SLOT_HASHES_PUBKEY })
          .remainingAccounts(remaining)
          .instruction();
        await send([ix], [who]);
      }
      throw new Error("Nie udało się wylosować składu");
    },
    async settleArbiter(who, id, index) {
      const d = await fetchDeal(id);
      const owner = d.panel[index];
      const dealPda = pda.deal(id);
      const ix = await programFor(who)
        .methods.settleArbiter(index)
        .accountsPartial({
          actor: who.publicKey,
          config,
          pool: pda.pool(),
          poolVault: pda.poolVault(),
          mint,
          deal: dealPda,
          vault: pda.vault(dealPda),
          arbiter: pda.arbiter(owner),
          arbiterAta: ata(mint, owner),
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction();
      return send([ensureAta(who.publicKey, owner), ix], [who]);
    },
    async closeDeal(who, id) {
      const d = await fetchDeal(id);
      const dealPda = pda.deal(id);
      const ix = await programFor(who)
        .methods.closeDeal()
        .accountsPartial({
          actor: who.publicKey,
          config,
          deal: dealPda,
          vault: pda.vault(dealPda),
          seller: d.seller,
          sellerAta: ata(mint, d.seller),
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction();
      return send([ensureAta(who.publicKey, d.seller), ix], [who]);
    },
    async review(who, id, stars, comment) {
      const d = await fetchDeal(id);
      const subject = d.buyer.equals(who.publicKey) ? d.seller : d.buyer;
      const ix = await programFor(who)
        .methods.review(stars, comment)
        .accountsPartial({ author: who.publicKey, deal: pda.deal(id), subjectProfile: pda.profile(subject) })
        .instruction();
      return send([ix], [who]);
    },
    async balance(owner) {
      try {
        return BigInt((await connection.getTokenAccountBalance(ata(mint, owner))).value.amount);
      } catch {
        return 0n;
      }
    },
  };
  return api;
}

// ───────────────────────────── pliki konfiguracyjne ─────────────────────────────

export function readDeployments() {
  const f = path.join(WEB_LIB, "deployments.json");
  try {
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    return j && typeof j === "object" && !("chainId" in (j["31337"] ?? {})) ? j : {};
  } catch {
    return {};
  }
}

export function writeDeployments(all) {
  fs.writeFileSync(path.join(WEB_LIB, "deployments.json"), JSON.stringify(all, null, 2) + "\n");
}

export function demoKeys() {
  const file = path.join(KEYS, "demo-keys.json");
  if (!fs.existsSync(file)) return null;
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  const kp = (x) => Keypair.fromSecretKey(Uint8Array.from(x.secret));
  const byName = Object.fromEntries(j.personas.map((p) => [p.name, kp(p)]));
  return { raw: j, personas: byName, oracles: j.oracles.map(kp) };
}
