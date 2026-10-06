// Tylko serwer. Relayer w aplikacji: to samo co solana/scripts/oracle-relayer.mjs, ale bez stale działającego
// procesu — wywołuje go strona transakcji (gdy ktoś ją ogląda) i zaplanowane zadanie GitHub Actions.
//  • oracle: numer InPost → potwierdzenie po statusie „delivered” z publicznego API InPost,
//            numer DEMO-… → potwierdzenie 15 s po nadaniu (symulacja na prezentację),
//  • arbitraż: losowanie składu (draw_panel), gdy tylko minie slot losowania — może to zrobić każdy,
//    a robimy to szybko, żeby żadna strona nie przeczekała niewygodnego wyniku.
// Relayer nie ma żadnych uprawnień ponad te, które program daje każdemu kluczowi oracle / każdemu wywołującemu.
import { Keypair, Transaction, type Connection } from "@solana/web3.js";
import type { Program } from "@coral-xyz/anchor";
import { State, type Deal, type Deployment } from "./contracts";
import { buildInstructions, fetchAllDeals, fetchDeal } from "./solana";

export const DEMO_DELAY = 15;

/** Klucze źródeł statusu (demo): ORACLE_KEYS albo oracle z NEXT_PUBLIC_DEMO_KEYS (te same klucze devnetowe). */
export function oracleKeys(): Keypair[] {
  const parse = (raw?: string) => {
    try {
      const j = JSON.parse(raw || "null");
      const list: { secret: number[] }[] | number[][] | null = Array.isArray(j) ? j : j?.oracles ?? null;
      return (list ?? []).map((o) => Keypair.fromSecretKey(Uint8Array.from(Array.isArray(o) ? o : o.secret)));
    } catch {
      return [];
    }
  };
  const own = parse(process.env.ORACLE_KEYS);
  return own.length ? own : parse(process.env.NEXT_PUBLIC_DEMO_KEYS);
}

async function inpostDelivered(tracking: string): Promise<boolean> {
  try {
    const r = await fetch(`https://api-shipx-pl.easypack24.net/v1/tracking/${encodeURIComponent(tracking)}`, {
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    if (!r.ok) return false;
    const j = (await r.json()) as { status?: string; tracking_details?: { status: string }[] };
    return j.status === "delivered" || !!j.tracking_details?.some((t) => t.status === "delivered");
  } catch {
    return false;
  }
}

async function sendAs(connection: Connection, ixs: Transaction["instructions"], payer: Keypair): Promise<string> {
  const tx = new Transaction().add(...ixs);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = payer.publicKey;
  tx.sign(payer);
  const sig = await connection.sendRawTransaction(tx.serialize());
  const res = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (res.value.err) throw new Error(`odrzucona: ${JSON.stringify(res.value.err)}`);
  return sig;
}

/** Czy transakcja czeka na relayer (żeby nie odpytywać łańcucha bez potrzeby). */
export const needsRelay = (deal: Deal) =>
  (deal.state === State.Shipped && /^(DEMO-|\d{20,26}$)/.test(deal.tracking.trim())) ||
  (deal.state === State.InArbitration && !deal.panelDrawn);

/**
 * Jeden krok relayera dla jednej transakcji. Zwraca opis wykonanych akcji (pusty, gdy nic nie było do zrobienia).
 * `drawPayer` płaci opłatę za losowanie (sponsor opłat); oracle płacą za swoje potwierdzenia.
 */
export async function relayDeal(program: Program, d: Deployment, deal: Deal, drawPayer: Keypair | null, now: number): Promise<string[]> {
  const connection = program.provider.connection;
  const done: string[] = [];

  if (deal.state === State.InArbitration && !deal.panelDrawn && drawPayer) {
    if (BigInt(await connection.getSlot("confirmed")) <= deal.drawSlot) return done;
    const ixs = await buildInstructions(program, d, drawPayer.publicKey, "drawPanel", [], deal);
    await sendAs(connection, ixs, drawPayer);
    done.push(`#${deal.id}: losowanie składu`);
    return done;
  }

  if (deal.state !== State.Shipped) return done;
  const tracking = deal.tracking.trim();
  let why = "";
  if (tracking.startsWith("DEMO-")) {
    // Czas nadania z łańcucha: przy mark_shipped deadline = teraz + transit + inspection.
    const shippedAt = Number(deal.deadline) - d.windows.transit - d.windows.inspection;
    if (now - shippedAt >= DEMO_DELAY) why = "demo";
  } else if (/^\d{20,26}$/.test(tracking) && (await inpostDelivered(tracking))) {
    why = "InPost: delivered";
  }
  if (!why) return done;

  for (const [i, o] of oracleKeys().entries()) {
    if ((deal.attestedMask >> i) & 1) continue;
    const fresh = await fetchDeal(program, d, deal.id);
    if (!fresh || fresh.state !== State.Shipped) break; // kworum osiągnięte — już „doręczona”
    try {
      const ixs = await buildInstructions(program, d, o.publicKey, "confirmDelivery", [], fresh);
      await sendAs(connection, ixs, o);
      done.push(`#${deal.id}: źródło ${i + 1} potwierdza doręczenie (${why})`);
    } catch (e) {
      done.push(`#${deal.id}: źródło ${i + 1} — ${e instanceof Error ? e.message.split("\n")[0] : e}`);
    }
  }
  return done;
}

/** Przegląd wszystkich transakcji (zadanie okresowe). */
export async function relayAll(program: Program, d: Deployment, drawPayer: Keypair | null, now: number): Promise<string[]> {
  const out: string[] = [];
  for (const deal of (await fetchAllDeals(program)).filter(needsRelay)) {
    try {
      out.push(...(await relayDeal(program, d, deal, drawPayer, now)));
    } catch (e) {
      out.push(`#${deal.id}: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
    }
  }
  return out;
}
