import { AnchorProvider, BN, BorshCoder, EventParser, Program, type Idl } from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Connection, PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import idlJson from "./idl/safedeal.json";
import {
  EMPTY_PROFILE,
  type Address,
  type ConfigAccount,
  type Deal,
  type Deployment,
  type Profile,
  type State,
} from "./contracts";

export const idl = idlJson as unknown as Idl;
export const coder = new BorshCoder(idl);

export const explorerTx = (sig: string, cluster = "devnet") =>
  `https://explorer.solana.com/tx/${sig}${cluster === "devnet" ? "?cluster=devnet" : "?cluster=custom&customUrl=http%3A%2F%2F127.0.0.1%3A8899"}`;
export const explorerAddr = (addr: string, cluster = "devnet") =>
  `https://explorer.solana.com/address/${addr}${cluster === "devnet" ? "?cluster=devnet" : "?cluster=custom&customUrl=http%3A%2F%2F127.0.0.1%3A8899"}`;

// ───────────────────────────── PDA ─────────────────────────────

const u64le = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};

export const pk = (a: Address | PublicKey) => (typeof a === "string" ? new PublicKey(a) : a);

export function pdas(programId: Address) {
  const pid = pk(programId);
  const find = (seeds: (Buffer | Uint8Array)[]) => PublicKey.findProgramAddressSync(seeds, pid)[0];
  return {
    config: () => find([Buffer.from("config")]),
    mintAuth: () => find([Buffer.from("mint_auth")]),
    deal: (id: bigint) => find([Buffer.from("deal"), u64le(id)]),
    vault: (deal: PublicKey) => find([Buffer.from("vault"), deal.toBuffer()]),
    profile: (owner: Address | PublicKey) => find([Buffer.from("profile"), pk(owner).toBuffer()]),
  };
}

export const ata = (mint: Address, owner: Address | PublicKey) => getAssociatedTokenAddressSync(pk(mint), pk(owner), true);

// ───────────────────────────── program ─────────────────────────────

/** Program tylko do odczytu i budowania instrukcji — podpisuje osobno persona demo albo portfel. */
export function readProgram(connection: Connection, d: Deployment) {
  const dummy = {
    publicKey: PublicKey.default,
    signTransaction: async <T,>(t: T) => t,
    signAllTransactions: async <T,>(t: T[]) => t,
  };
  const provider = new AnchorProvider(connection, dummy as never, { commitment: "confirmed" });
  return new Program({ ...idl, address: d.programId } as Idl, provider);
}

// ───────────────────────────── dekodowanie ─────────────────────────────

const hex = (bytes: number[] | Uint8Array) => "0x" + Buffer.from(bytes).toString("hex");
const big = (v: BN | number | bigint) => BigInt(v.toString());
const b58 = (p: PublicKey) => p.toBase58();

/* eslint-disable @typescript-eslint/no-explicit-any */
export function toDeal(pda: PublicKey, a: any): Deal {
  return {
    id: big(a.id),
    pda: b58(pda),
    seller: b58(a.seller),
    buyer: b58(a.buyer),
    amount: big(a.amount),
    bond: big(a.bond),
    state: a.state as State,
    deadline: big(a.deadline),
    createdAt: big(a.createdAt),
    title: a.title,
    description: a.description,
    photoUri: a.photoUri,
    photoHash: hex(a.photoHash),
    tracking: a.tracking,
    disputeReason: a.disputeReason,
    attestations: a.attestations,
    attestedMask: a.attestedMask,
    pickupAllowed: a.pickupAllowed,
    pickupHash: hex(a.pickupHash),
    settlementProposer: b58(a.settlementProposer),
    settlementBuyerAmount: big(a.settlementBuyerAmount),
    commits: (a.commits as number[][]).map(hex),
    votes: Array.from(a.votes as number[]),
    commitCount: a.commitCount,
    votesBuyer: a.votesBuyer,
    votesSeller: a.votesSeller,
    reviewedByBuyer: a.reviewedByBuyer,
    reviewedBySeller: a.reviewedBySeller,
  };
}

export function toProfile(a: any): Profile {
  return {
    owner: b58(a.owner),
    soldOk: a.soldOk,
    boughtOk: a.boughtOk,
    disputesWon: a.disputesWon,
    disputesLost: a.disputesLost,
    ratingCount: a.ratingCount,
    starsSum: a.starsSum,
    volume: big(a.volume),
  };
}

export function toConfig(a: any): ConfigAccount {
  return {
    mint: b58(a.mint),
    oracles: a.oracles.map(b58),
    oracleQuorum: a.oracleQuorum,
    arbiters: a.arbiters.map(b58),
    arbiterQuorum: a.arbiterQuorum,
    revealWindow: big(a.revealWindow),
    bondBps: a.bondBps,
    dealCount: big(a.dealCount),
    arbWithMajority: Array.from(a.arbWithMajority),
    arbAgainstMajority: Array.from(a.arbAgainstMajority),
    arbMissed: Array.from(a.arbMissed),
  };
}

// ───────────────────────────── odczyty ─────────────────────────────

export async function fetchConfig(program: Program, d: Deployment): Promise<ConfigAccount> {
  return toConfig(await (program.account as any).config.fetch(pdas(d.programId).config()));
}

export async function fetchDeal(program: Program, d: Deployment, id: bigint): Promise<Deal | null> {
  const pda = pdas(d.programId).deal(id);
  const a = await (program.account as any).deal.fetchNullable(pda);
  return a ? toDeal(pda, a) : null;
}

/**
 * Wszystkie transakcje programu, od najnowszej. Bez getProgramAccounts (darmowe plany RPC go nie mają):
 * licznik z konta konfiguracji, a konta ofert pobieramy po adresach PDA paczkami po 100.
 */
export async function fetchAllDeals(program: Program): Promise<Deal[]> {
  const p = pdas(program.programId.toBase58());
  const cfg = await (program.account as any).config.fetch(p.config());
  const count = Number(cfg.dealCount.toString());
  const keys = Array.from({ length: count }, (_, i) => p.deal(BigInt(count - i)));
  const out: Deal[] = [];
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    const infos = await program.provider.connection.getMultipleAccountsInfo(chunk, "confirmed");
    infos.forEach((info, j) => {
      if (info) out.push(toDeal(chunk[j], program.coder.accounts.decode("deal", info.data)));
    });
  }
  return out;
}

export async function fetchProfile(program: Program, d: Deployment, owner: Address): Promise<Profile> {
  const a = await (program.account as any).profile.fetchNullable(pdas(d.programId).profile(owner));
  return a ? toProfile(a) : EMPTY_PROFILE(owner);
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function tokenBalance(connection: Connection, d: Deployment, owner: Address): Promise<bigint> {
  try {
    const r = await connection.getTokenAccountBalance(ata(d.mint, owner));
    return BigInt(r.value.amount);
  } catch {
    return 0n;
  }
}

// ───────────────────────────── historia (zdarzenia z logów) ─────────────────────────────

export type ChainEvent = { name: string; data: Record<string, unknown>; signature: string; time: number; signer: Address };

/**
 * Historia konta (np. PDA transakcji albo profilu): podpisy transakcji, które go dotykały,
 * i zdarzenia Anchora wyczytane z ich logów. Wszystko z łańcucha — bez własnego backendu.
 */
export async function accountEvents(connection: Connection, d: Deployment, account: Address, limit = 40): Promise<ChainEvent[]> {
  const sigs = await connection.getSignaturesForAddress(pk(account), { limit }, "confirmed");
  const ok = sigs.filter((s) => !s.err);
  if (ok.length === 0) return [];
  const txs = await connection.getTransactions(
    ok.map((s) => s.signature),
    { commitment: "confirmed", maxSupportedTransactionVersion: 0 },
  );
  const parser = new EventParser(pk(d.programId), coder);
  const out: ChainEvent[] = [];
  txs.forEach((tx, i) => {
    if (!tx?.meta?.logMessages) return;
    const signer = tx.transaction.message.staticAccountKeys[0]?.toBase58() ?? "";
    for (const ev of parser.parseLogs(tx.meta.logMessages)) {
      out.push({ name: ev.name, data: ev.data as Record<string, unknown>, signature: ok[i].signature, time: tx.blockTime ?? 0, signer });
    }
  });
  return out.sort((a, b) => a.time - b.time);
}

// ───────────────────────────── instrukcje ─────────────────────────────

export type WriteName =
  | "createDeal" | "cancel" | "fund" | "markShipped" | "confirmDelivery" | "confirmReceipt" | "confirmPickup"
  | "openDispute" | "respondToDispute" | "refundBuyer" | "commitVote" | "revealVote" | "settleExpired"
  | "submitEvidence" | "proposeSettlement" | "acceptSettlement" | "review" | "faucet";

const bytes32 = (h: string) => Array.from(Buffer.from(h.replace(/^0x/, "").padStart(64, "0"), "hex"));
const bn = (v: bigint | number) => new BN(v.toString());

/**
 * Buduje instrukcje dla danej akcji. Konta odbiorców wypłat są wyliczane z adresów zapisanych
 * w transakcji (program i tak je sprawdza); brakujące konta tokenowe tworzymy idempotentnie.
 */
export async function buildInstructions(
  program: Program,
  d: Deployment,
  signer: PublicKey,
  name: WriteName,
  args: readonly unknown[],
  deal?: Deal,
): Promise<TransactionInstruction[]> {
  const p = pdas(d.programId);
  const mint = pk(d.mint);
  const config = p.config();
  const m = program.methods as Record<string, (...a: unknown[]) => { accountsPartial: (x: object) => { remainingAccounts: (r: object[]) => { instruction: () => Promise<TransactionInstruction> }; instruction: () => Promise<TransactionInstruction> } }>;
  const ensureAta = (owner: Address | PublicKey) =>
    createAssociatedTokenAccountIdempotentInstruction(signer, ata(d.mint, owner), pk(owner), mint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

  if (name === "faucet") {
    return [
      await m.faucet().accountsPartial({
        user: signer,
        config,
        mint,
        mintAuthority: p.mintAuth(),
        userAta: ata(d.mint, signer),
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      }).instruction(),
    ];
  }

  if (name === "createDeal") {
    const [a, nextId] = args as [
      { amount: bigint; title: string; buyer?: Address | null; description?: string; photoUri?: string; photoHash?: string; pickupAllowed?: boolean },
      bigint,
    ];
    const dealPda = p.deal(nextId);
    return [
      await m
        .createDeal({
          amount: bn(a.amount),
          title: a.title,
          buyer: a.buyer ? pk(a.buyer) : null,
          description: a.description ?? "",
          photoUri: a.photoUri ?? "",
          photoHash: bytes32(a.photoHash ?? "0x"),
          pickupAllowed: !!a.pickupAllowed,
        })
        .accountsPartial({
          seller: signer,
          config,
          deal: dealPda,
          vault: p.vault(dealPda),
          mint,
          sellerProfile: p.profile(signer),
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .instruction(),
    ];
  }

  if (!deal) throw new Error("Brak transakcji");
  const dealPda = pk(deal.pda);
  const vault = p.vault(dealPda);

  switch (name) {
    case "cancel":
    case "markShipped":
      return [
        await m[name](...(name === "markShipped" ? [String(args[0])] : []))
          .accountsPartial({ seller: signer, config, deal: dealPda })
          .instruction(),
      ];
    case "fund": {
      const pickupHash = args[0] as string | undefined;
      return [
        await m
          .fund(pickupHash ? bytes32(pickupHash) : null)
          .accountsPartial({
            buyer: signer,
            config,
            deal: dealPda,
            vault,
            buyerAta: ata(d.mint, signer),
            buyerProfile: p.profile(signer),
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .instruction(),
      ];
    }
    case "openDispute":
    case "respondToDispute":
      return [
        await m[name](...(name === "openDispute" ? [String(args[0])] : []))
          .accountsPartial({ actor: signer, config, deal: dealPda, vault, actorAta: ata(d.mint, signer), tokenProgram: TOKEN_PROGRAM_ID })
          .instruction(),
      ];
    case "confirmDelivery":
      return [await m.confirmDelivery().accountsPartial({ oracle: signer, config, deal: dealPda }).instruction()];
    case "commitVote":
      return [
        await m.commitVote(bytes32(String(args[0]))).accountsPartial({ arbiter: signer, config, deal: dealPda }).instruction(),
      ];
    case "proposeSettlement":
      return [await m.proposeSettlement(bn(args[0] as bigint)).accountsPartial({ actor: signer, deal: dealPda }).instruction()];
    case "submitEvidence": {
      const [uri, hash, note] = args as [string, string, string];
      return [await m.submitEvidence(uri, bytes32(hash), note).accountsPartial({ actor: signer, deal: dealPda }).instruction()];
    }
    case "review": {
      const [stars, comment] = args as [number, string];
      const subject = signer.toBase58() === deal.buyer ? deal.seller : deal.buyer;
      return [
        await m
          .review(stars, comment)
          .accountsPartial({ author: signer, deal: dealPda, subjectProfile: p.profile(subject) })
          .instruction(),
      ];
    }
  }

  // Akcje, które mogą wypłacić pieniądze z sejfu.
  const payout = {
    actor: signer,
    config,
    deal: dealPda,
    vault,
    buyerAta: ata(d.mint, deal.buyer),
    sellerAta: ata(d.mint, deal.seller),
    buyerProfile: p.profile(deal.buyer),
    sellerProfile: p.profile(deal.seller),
    tokenProgram: TOKEN_PROGRAM_ID,
  };
  const pre = [ensureAta(deal.buyer), ensureAta(deal.seller)];
  switch (name) {
    case "confirmReceipt":
    case "refundBuyer":
    case "settleExpired":
      return [...pre, await m[name]().accountsPartial(payout).instruction()];
    case "confirmPickup":
      return [...pre, await m.confirmPickup(bytes32(String(args[0]))).accountsPartial(payout).instruction()];
    case "acceptSettlement":
      return [...pre, await m.acceptSettlement(bn(args[0] as bigint)).accountsPartial(payout).instruction()];
    case "revealVote": {
      const [forBuyer, salt] = args as [boolean, string];
      const remaining = d.arbiters.map((a) => ({ pubkey: ata(d.mint, a), isSigner: false, isWritable: true }));
      return [
        ...pre,
        ...d.arbiters.map((a) => ensureAta(a)),
        await m.revealVote(forBuyer, bytes32(salt)).accountsPartial(payout).remainingAccounts(remaining).instruction(),
      ];
    }
  }
  throw new Error(`Nieznana akcja ${name}`);
}

// ───────────────────────────── hashe (zgodne z programem) ─────────────────────────────

async function sha256(...parts: Uint8Array[]): Promise<Uint8Array> {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    buf.set(p, o);
    o += p.length;
  }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
}

const fromHex = (h: string) => new Uint8Array(Buffer.from(h.replace(/^0x/, ""), "hex"));
const toHex = (b: Uint8Array) => "0x" + Buffer.from(b).toString("hex");

/** = vote_commitment w programie: sha256(id_le ‖ arbiter ‖ za_kupującym ‖ sól). */
export async function voteCommitment(id: bigint, arbiter: Address, forBuyer: boolean, salt: string): Promise<string> {
  return toHex(await sha256(u64le(id), pk(arbiter).toBytes(), new Uint8Array([forBuyer ? 1 : 0]), fromHex(salt)));
}

/** Kod odbioru → 32 bajty, które sprzedawca podaje programowi. */
export async function codeBytes(normalizedCode: string): Promise<string> {
  return toHex(await sha256(new TextEncoder().encode(normalizedCode)));
}

/** Hash zapisywany przy wpłacie: sha256(id_le ‖ sha256(kod)) — sprawdza go confirm_pickup. */
export async function pickupHash(id: bigint, normalizedCode: string): Promise<string> {
  return toHex(await sha256(u64le(id), fromHex(await codeBytes(normalizedCode))));
}

export const randomHex32 = () => toHex(crypto.getRandomValues(new Uint8Array(32)));
