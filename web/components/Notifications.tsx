"use client";

import Link from "next/link";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { STATE_LABEL, State, isFinal, isZero, type Address, type Deal } from "@/lib/contracts";
import { fmtUsdc, short } from "@/lib/format";
import { fetchAllDeals } from "@/lib/solana";
import { nameOf, useWallet } from "@/lib/wallet";

type Notif = { key: string; id: bigint; text: string; read: boolean };
type Toast = Notif & { shownAt: number };

type Ctx = {
  list: (addr?: Address) => Notif[];
  unread: (addr?: Address) => number;
  markRead: (addr?: Address) => void;
};

const NotificationsContext = createContext<Ctx | null>(null);
export const useNotifications = () => {
  const ctx = useContext(NotificationsContext);
  if (!ctx) throw new Error("useNotifications poza NotificationsProvider");
  return ctx;
};

const who = (a: Address) => nameOf(a) ?? short(a);

/** Co pamiętamy o każdej transakcji, żeby zauważyć zmianę przy następnym odczycie. */
type Snap = { state: number; proposer: string; offer: string; rb: boolean; rs: boolean; drawn: boolean };
const snap = (d: Deal): Snap => ({
  state: d.state,
  proposer: d.settlementProposer,
  offer: String(d.settlementBuyerAmount),
  rb: d.reviewedByBuyer,
  rs: d.reviewedBySeller,
  drawn: d.panelDrawn,
});

/** Jak często sprawdzamy zmiany — publiczny serwer devnetu ma limity zapytań. */
const POLL_MS = 20_000;

type Saved = { boxes?: Record<string, Notif[]>; snaps?: Record<string, Snap> };

/**
 * Skrzynki powiadomień budowane ze ZMIAN stanu transakcji: jeden odczyt wszystkich kont co kilkanaście sekund
 * (i po każdej naszej operacji), bez przeglądania historii. Trzymamy je dla KAŻDEGO adresu, którego dotyczą —
 * w demo przełączasz osoby w jednej karcie, więc Alicja zobaczy płatność Bartka, gdy się na nią przełączysz.
 */
export function NotificationsProvider({ children }: { children: ReactNode }) {
  const w = useWallet();
  const [boxes, setBoxes] = useState<Record<string, Notif[]>>({});
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [tick, setTick] = useState(0);
  const snaps = useRef<Record<string, Snap> | null>(null);
  const busy = useRef(false);
  const meRef = useRef(w.address);
  meRef.current = w.address;
  const boxesRef = useRef(boxes);
  boxesRef.current = boxes;

  // Skrzynki przeżywają odświeżenie strony — osobno dla każdego programu. Nowy program = czysta historia.
  const storeKey = w.deployment ? `safedeal:notifs:solana-${w.deployment.cluster}:${w.deployment.programId}` : "";
  const [loaded, setLoaded] = useState("");

  useEffect(() => {
    let saved: Saved | null = null;
    try {
      const raw = storeKey ? localStorage.getItem(storeKey) : null;
      saved = raw ? JSON.parse(raw, (k, v) => (k === "id" ? BigInt(v) : v)) : null;
    } catch {
      saved = null;
    }
    setBoxes(saved?.boxes ?? {});
    snaps.current = saved?.snaps ?? null;
    setLoaded(storeKey);
  }, [storeKey]);

  const persist = useCallback(
    (b: Record<string, Notif[]>) => {
      if (!storeKey || loaded !== storeKey) return;
      try {
        const json = JSON.stringify({ boxes: b, snaps: snaps.current }, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
        localStorage.setItem(storeKey, json);
      } catch {
        /* brak dostępu do storage — powiadomienia działają do odświeżenia strony */
      }
    },
    [storeKey, loaded],
  );

  useEffect(() => persist(boxes), [boxes, persist]);

  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), POLL_MS);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!w.deployment || !w.program || busy.current || !storeKey || loaded !== storeKey) return;
    const program = w.program;
    busy.current = true;
    (async () => {
      const deals = await fetchAllDeals(program, true);
      const prev = snaps.current;
      const next: Record<string, Snap> = {};
      for (const d of deals) next[String(d.id)] = snap(d);
      snaps.current = next;
      // Pierwszy odczyt tylko zapamiętujemy — nie zasypujemy powiadomieniami o starych sprawach.
      if (!prev) return persist(boxesRef.current);

      const fresh: Record<string, Notif[]> = {};
      const push = (to: string | undefined, id: bigint, key: string, text: string) => {
        if (!to || isZero(to)) return;
        (fresh[to] ??= []).push({ key: `${key}:${to}`, id, text, read: false });
      };

      for (const d of deals) {
        // Zamknięcie kont to tylko porządki — dane z archiwum (np. znaczniki opinii) nie są nowymi zdarzeniami.
        if (d.archived) continue;
        const before = prev[String(d.id)];
        const now = next[String(d.id)];
        const t = `„${d.title}”`;
        const k = `${d.id}:${d.state}`;
        if (!before && d.state === State.Created) {
          // nowa oferta skierowana do konkretnej osoby
          if (!isZero(d.buyer)) push(d.buyer, d.id, `${k}:new`, `${who(d.seller)} wystawia ofertę dla Ciebie: ${t} za ${fmtUsdc(d.amount)}`);
          continue;
        }
        if (!before || before.state !== now.state) {
          switch (d.state as State) {
            case State.Funded:
              push(d.seller, d.id, k, `${who(d.buyer)}: wpłata ${fmtUsdc(d.amount)} za ${t} — nadaj paczkę`);
              break;
            case State.Shipped:
              push(d.buyer, d.id, k, `${t} nadana${d.tracking ? ` (${d.tracking})` : ""}`);
              break;
            case State.Delivered:
              push(d.buyer, d.id, k, `${t} doręczona — sprawdź paczkę, trwa okno reklamacji`);
              push(d.seller, d.id, k, `${t} doręczona — wypłata po oknie reklamacji`);
              break;
            case State.Disputed:
              push(d.seller, d.id, k, `Reklamacja do ${t}: „${d.disputeReason}”`);
              break;
            case State.InArbitration:
              push(d.buyer, d.id, k, `Reklamacja do ${t} odrzucona — program losuje arbitrów`);
              break;
            default:
              if (isFinal(d.state)) {
                const text = `${t}: ${STATE_LABEL[d.state]}`;
                push(d.seller, d.id, k, text);
                push(d.buyer, d.id, k, text);
              }
          }
        }
        if (before && !isFinal(d.state) && !isZero(now.proposer) && (before.proposer !== now.proposer || before.offer !== now.offer)) {
          const other = now.proposer === d.buyer ? d.seller : d.buyer;
          push(
            other,
            d.id,
            `${d.id}:offer:${now.offer}:${now.proposer}`,
            `${who(now.proposer)} proponuje ugodę w ${t}: ${fmtUsdc(d.settlementBuyerAmount)} dla kupującego`,
          );
        }
        if (before && !before.drawn && now.drawn) {
          for (const arb of d.panel) push(arb, d.id, `${d.id}:panel`, `Wylosowano Cię do sprawy ${t} — oddaj niejawny głos`);
        }
        if (before && !before.rb && now.rb) push(d.seller, d.id, `${d.id}:review:b`, `${who(d.buyer)} wystawia Ci opinię za ${t}`);
        if (before && !before.rs && now.rs) push(d.buyer, d.id, `${d.id}:review:s`, `${who(d.seller)} wystawia Ci opinię za ${t}`);
      }

      if (!Object.keys(fresh).length) return persist(boxesRef.current);
      setBoxes((prevBoxes) => {
        const nb = { ...prevBoxes };
        for (const [addr, items] of Object.entries(fresh)) {
          // po odświeżeniu strony ta sama zmiana może przyjść drugi raz — klucz = transakcja + stan
          const known = new Set((nb[addr] ?? []).map((x) => x.key));
          nb[addr] = [...items.filter((x) => !known.has(x.key)), ...(nb[addr] ?? [])].slice(0, 50);
        }
        return nb;
      });
      const mine = meRef.current ? fresh[meRef.current] ?? [] : [];
      if (mine.length) setToasts((p) => [...p, ...mine.map((n) => ({ ...n, shownAt: Date.now() }))].slice(-4));
    })()
      .catch(() => {})
      .finally(() => {
        busy.current = false;
      });
  }, [w.deployment, w.program, w.lastTx, tick, storeKey, loaded, persist]);

  // komunikaty znikają same po kilku sekundach
  useEffect(() => {
    if (!toasts.length) return;
    const t = setTimeout(() => setToasts((prev) => prev.filter((x) => Date.now() - x.shownAt < 7000)), 1000);
    return () => clearTimeout(t);
  }, [toasts]);

  const list = useCallback((addr?: Address) => (addr ? boxes[addr] ?? [] : []), [boxes]);
  const unread = useCallback((addr?: Address) => (addr ? boxes[addr] ?? [] : []).filter((n) => !n.read).length, [boxes]);
  const markRead = useCallback(
    (addr?: Address) =>
      setBoxes((prev) => {
        if (!addr) return prev;
        const items = prev[addr];
        if (!items?.some((n) => !n.read)) return prev;
        return { ...prev, [addr]: items.map((n) => ({ ...n, read: true })) };
      }),
    [],
  );

  return (
    <NotificationsContext.Provider value={{ list, unread, markRead }}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <Link key={t.key} href={`/deal/${t.id}`} className="notif-toast" onClick={() => setToasts((p) => p.filter((x) => x.key !== t.key))}>
            🔔 {t.text}
          </Link>
        ))}
      </div>
    </NotificationsContext.Provider>
  );
}

export function NotificationBell() {
  const w = useWallet();
  const n = useNotifications();
  const [open, setOpen] = useState(false);
  const items = n.list(w.address);
  const count = n.unread(w.address);

  return (
    <div className="bell-wrap">
      <button
        className="btn ghost sm bell"
        aria-label={`Powiadomienia (${count} nowych)`}
        onClick={() => {
          setOpen((o) => !o);
          n.markRead(w.address);
        }}
      >
        🔔{count > 0 && <span className="count">{count}</span>}
      </button>
      {open && (
        <div className="bell-panel" onClick={() => setOpen(false)}>
          {items.length === 0 ? (
            <p className="muted small">Brak powiadomień. Pojawią się tu zmiany w Twoich transakcjach.</p>
          ) : (
            items.map((it) => (
              <Link key={it.key} href={`/deal/${it.id}`} className={it.read ? "" : "unread"}>
                <span className="mono muted">#{String(it.id)}</span> {it.text}
              </Link>
            ))
          )}
        </div>
      )}
    </div>
  );
}
