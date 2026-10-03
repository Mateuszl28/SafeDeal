"use client";

import { useEffect, useState } from "react";
import { STATE_LABEL, State, type Address, type Deal, type Deployment } from "@/lib/contracts";
import { fmtUsdc, sameAddr, short } from "@/lib/format";
import { nameOf, useWallet } from "@/lib/wallet";
import { CHECK_LABEL, uploadFile, useHashCheck } from "@/lib/files";
import { accountEvents, explorerTx, type ChainEvent } from "@/lib/solana";
import type { Connection } from "@solana/web3.js";

export type Entry = ChainEvent;

// ───────────────────────────── odczyt historii (z pamięcią podręczną) ─────────────────────────────

// Publiczne RPC devnetu ma limity, więc historię konta pobieramy tylko wtedy, gdy coś mogło się zmienić,
// i dzielimy jeden odczyt między wszystkie komponenty na stronie (historia, dowody, opinie, potwierdzenie).
const cache = new Map<string, { version: string; promise: Promise<ChainEvent[]> }>();

export function loadAccountEvents(connection: Connection, d: Deployment, account: Address, version: string): Promise<ChainEvent[]> {
  const hit = cache.get(account);
  if (hit && hit.version === version) return hit.promise;
  const promise = accountEvents(connection, d, account, 100).catch((e) => {
    cache.delete(account);
    throw e;
  });
  cache.set(account, { version, promise });
  return promise;
}

/**
 * Zdarzenia programu z transakcji dotykających danego konta. `version` decyduje, kiedy pobrać je ponownie:
 * zmiana stanu transakcji, nasza własna transakcja albo upływ minuty (np. dowód dodany przez drugą stronę).
 */
export function useAccountEvents(account: Address | undefined, version: string) {
  const w = useWallet();
  const [events, setEvents] = useState<ChainEvent[]>();
  const minute = Math.floor(Number(w.now) / 60);
  const key = `${version}|${w.lastTx?.signature ?? ""}|${minute}`;

  useEffect(() => {
    if (!w.deployment || !account) return;
    let alive = true;
    loadAccountEvents(w.connection, w.deployment, account, key)
      .then((e) => alive && setEvents(e))
      .catch(() => alive && setEvents((prev) => prev ?? []));
    return () => {
      alive = false;
    };
  }, [w.deployment, w.connection, account, key]);

  return events;
}

/** Odcisk stanu transakcji — gdy się zmieni, w historii na pewno jest coś nowego. */
const dealVersion = (d: Deal) =>
  [d.state, d.attestations, d.commitCount, d.votesBuyer + d.votesSeller, d.settlementProposer, d.settlementBuyerAmount, d.reviewedByBuyer, d.reviewedBySeller, d.tracking].join(":");

export function useDealEvents(deal: Deal | null | undefined) {
  return useAccountEvents(deal?.pda, deal ? dealVersion(deal) : "");
}

// ───────────────────────────── opisy zdarzeń ─────────────────────────────

/** Pola zdarzeń z Anchora: PublicKey, BN, liczby i tablice bajtów — zamieniamy na proste typy. */
export const evAddr = (v: unknown): Address => (v && typeof v === "object" && "toBase58" in v ? (v as { toBase58(): string }).toBase58() : String(v ?? ""));
export const evBig = (v: unknown): bigint => (v === undefined || v === null ? 0n : BigInt(String(v)));
export const evHex = (v: unknown): string => (Array.isArray(v) || v instanceof Uint8Array ? "0x" + Buffer.from(v as number[]).toString("hex") : String(v ?? ""));

const who = (a: unknown) => {
  const addr = evAddr(a);
  return nameOf(addr) ?? short(addr);
};

export function describeEvent(e: ChainEvent, deal: Deal): string {
  const a = e.data;
  switch (e.name) {
    case "DealCreated":
      return `${who(a.seller)} wystawia ofertę za ${fmtUsdc(evBig(a.amount))}`;
    case "DealFunded":
      return `${who(a.buyer)} wpłaca ${fmtUsdc(deal.amount)} do sejfu transakcji`;
    case "DealShipped":
      return `${who(deal.seller)} nadaje przesyłkę ${String(a.tracking)}`;
    case "DeliveryAttested":
      return `Źródło statusu „${who(a.oracle)}” potwierdza doręczenie (${Number(a.count)} potwierdz.)`;
    case "DealDelivered":
      return "Wymagana liczba potwierdzeń: doręczono — rusza okno reklamacji";
    case "DisputeOpened":
      return `${who(deal.buyer)} zgłasza reklamację: „${String(a.reason)}” (kaucja ${fmtUsdc(deal.bond)})`;
    case "ArbitrationStarted":
      return `${who(deal.seller)} odrzuca reklamację i wpłaca kaucję — decydują arbitrzy`;
    case "VoteCommitted":
      return `${who(a.arbiter)} oddaje niejawny głos (zapisany tylko odcisk)`;
    case "Voted":
      return `${who(a.arbiter)} ujawnia głos: za ${a.forBuyer ? "kupującym" : "sprzedawcą"}`;
    case "Evidence":
      return `${who(a.party)} dodaje dowód${a.note ? `: ${String(a.note)}` : ""}`;
    case "PickupConfirmed":
      return "Kod odbioru prawidłowy — przedmiot wydany na spotkaniu";
    case "Reviewed": {
      const n = Number(a.stars);
      return `${who(a.author)} wystawia opinię: ${"★".repeat(n)}${"☆".repeat(5 - n)}${a.comment ? ` — „${String(a.comment)}”` : ""}`;
    }
    case "SettlementProposed":
      return `${who(a.proposer)} proponuje ugodę: ${fmtUsdc(evBig(a.buyerAmount))} wraca do kupującego`;
    case "Settled":
      return `Ugoda przyjęta: kupujący ${fmtUsdc(evBig(a.buyerAmount))}, sprzedawca ${fmtUsdc(evBig(a.sellerAmount))}`;
    case "DealClosed":
      return STATE_LABEL[Number(a.outcome) as State] ?? "Transakcja zamknięta";
    default:
      return e.name;
  }
}

/** Zdarzenia z innych transakcji (konto profilu dotyka wielu ofert) odfiltrowujemy po id. */
const forDeal = (events: ChainEvent[] | undefined, id: bigint) => (events ?? []).filter((e) => evBig(e.data.id) === id);

export function useDealLogs(deal: Deal | null | undefined) {
  const events = useDealEvents(deal);
  return deal ? forDeal(events, deal.id) : [];
}

// ───────────────────────────── widoki ─────────────────────────────

const fmtTime = (t: number) => (t ? new Date(t * 1000).toLocaleString("pl-PL") : "");

export function HistorySection({ id, deal }: { id: bigint; deal: Deal }) {
  const w = useWallet();
  const events = useDealEvents(deal);
  const entries = forDeal(events, id);
  if (events === undefined) return null;
  return (
    <section className="card wide">
      <h2>Historia transakcji</h2>
      <p className="muted small">
        Każdy wpis to operacja zapisana w publicznym rejestrze Solany — nie da się jej usunąć ani zmienić. Kliknij „Explorer”, żeby
        sprawdzić ją samodzielnie, bez ufania nam.
      </p>
      {entries.length === 0 ? (
        <p className="muted small">Historia jeszcze się wczytuje albo publiczny serwer chwilowo odmówił — spróbuj za moment.</p>
      ) : (
        <ol className="history">
          {entries.map((e, i) => (
            <li key={`${e.signature}-${i}`} className={`ev-${e.name}`}>
              <span className="mono muted">{fmtTime(e.time)}</span>
              <span className="grow-text">{describeEvent(e, deal)}</span>
              <a className="mono muted" href={explorerTx(e.signature, w.deployment?.cluster)} target="_blank" rel="noreferrer" title={e.signature}>
                ↗ Explorer
              </a>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function EvidenceItem({ e }: { e: ChainEvent }) {
  const w = useWallet();
  const uri = String(e.data.uri ?? "");
  const { check, isImage } = useHashCheck(uri, evHex(e.data.contentHash));
  const note = String(e.data.note ?? "");

  return (
    <li className="evidence">
      <a href={uri} target="_blank" rel="noreferrer" className="thumb">
        {isImage ? <img src={uri} alt={note || "dowód"} /> : <span>📄</span>}
      </a>
      <div>
        <b>{who(e.data.party)}</b>
        {note ? <p>{note}</p> : null}
        <span className={`verify ${check}`}>{CHECK_LABEL[check]}</span>{" "}
        <a className="muted small" href={explorerTx(e.signature, w.deployment?.cluster)} target="_blank" rel="noreferrer">
          ↗ Explorer
        </a>
      </div>
    </li>
  );
}

export function EvidenceSection({ id, deal }: { id: bigint; deal: Deal }) {
  const w = useWallet();
  const entries = forDeal(useDealEvents(deal), id).filter((e) => e.name === "Evidence");
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState("");
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState<string>();
  const [inputKey, setInputKey] = useState(0);

  const s = deal.state as State;
  const isParty = sameAddr(w.address, deal.seller) || sameAddr(w.address, deal.buyer);
  const canAdd = isParty && s >= State.Shipped && s <= State.InArbitration;
  if (!canAdd && !entries.length) return null;

  async function submit() {
    if (!file) return;
    setUploading(true);
    setErr(undefined);
    try {
      const json = await uploadFile(file);
      const ok = await w.write("submitEvidence", [json.uri, json.hash, note.trim()], { deal, label: "Zapisuję odcisk dowodu" });
      if (ok) {
        setFile(null);
        setNote("");
        setInputKey((k) => k + 1);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  }

  return (
    <section className="card wide">
      <h2>Dowody</h2>
      <p className="muted small">
        Plik trafia do magazynu, a jego odcisk (SHA-256) — do publicznego rejestru. Każdy, np. arbiter, może sprawdzić, że nikt go
        później nie podmienił.
      </p>
      {entries.length > 0 && (
        <ul className="evidence-list">
          {entries.map((e, i) => (
            <EvidenceItem key={`${e.signature}-${i}`} e={e} />
          ))}
        </ul>
      )}
      {canAdd && (
        <div className="inline evidence-form">
          <input key={inputKey} type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Opis, np. zdjęcie uszkodzonej ramy" maxLength={120} />
          <button className="btn" disabled={!file || uploading || !!w.busy} onClick={submit}>
            {uploading ? "Wysyłam…" : "Dodaj dowód"}
          </button>
        </div>
      )}
      {err && <p className="err-text">{err}</p>}
    </section>
  );
}
