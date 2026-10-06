"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAllDeals, type Row } from "@/components/DealList";
import { State, type ArbiterAccount } from "@/lib/contracts";
import { fmtUsdc, plural } from "@/lib/format";
import { useWallet } from "@/lib/wallet";
import { fetchArbiters, fetchPool, pdas } from "@/lib/solana";
import { ProgramRules } from "@/components/Governance";
import { Pln } from "@/lib/pln";

type Bar = { label: string; value: number };

/** Poziomy wykres słupkowy — jedna seria, więc bez legendy; wartości przy końcach słupków, tooltip na hover. */
function Bars({ title, bars, empty }: { title: string; bars: Bar[]; empty: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const total = bars.reduce((s, b) => s + b.value, 0);
  const max = Math.max(1, ...bars.map((b) => b.value));
  const sorted = [...bars].sort((a, b) => b.value - a.value);

  return (
    <section className="card">
      <h2>{title}</h2>
      {total === 0 ? (
        <p className="muted">{empty}</p>
      ) : (
        <>
          <ul className="bars" onMouseLeave={() => setHover(null)}>
            {sorted.map((b, i) => (
              <li key={b.label} onMouseEnter={() => setHover(i)} className={hover !== null && hover !== i ? "dim" : ""}>
                <span className="bar-label">{b.label}</span>
                <span className="bar-track">
                  {b.value > 0 && <span className="bar-fill" style={{ width: `${(b.value / max) * 100}%` }} />}
                  <span className="bar-value">{b.value}</span>
                </span>
                {hover === i && (
                  <span className="bar-tip" role="tooltip">
                    <b>{b.label}</b>: {b.value} z {total} ({Math.round((b.value / total) * 100)}%)
                  </span>
                )}
              </li>
            ))}
          </ul>
          <details className="as-table">
            <summary>Pokaż jako tabelę</summary>
            <table>
              <thead>
                <tr>
                  <th>Kategoria</th>
                  <th>Liczba</th>
                  <th>Udział</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((b) => (
                  <tr key={b.label}>
                    <td>{b.label}</td>
                    <td>{b.value}</td>
                    <td>{Math.round((b.value / total) * 100)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </>
      )}
    </section>
  );
}

const count = (rows: Row[], ...states: State[]) => rows.filter((d) => states.includes(d.state as State)).length;

type PoolStats = { members: number; staked: bigint; arbiters: ArbiterAccount[] };

/** Pula arbitrów z łańcucha: liczba osób, kaucje w sejfie puli i rzetelność (konta arbitrów). */
function usePoolStats(): PoolStats | undefined {
  const w = useWallet();
  const [stats, setStats] = useState<PoolStats>();
  useEffect(() => {
    if (!w.program || !w.deployment) return;
    const program = w.program;
    const d = w.deployment;
    (async () => {
      const members = await fetchPool(program);
      const arbiters = (await fetchArbiters(program, members)).filter((a): a is ArbiterAccount => !!a);
      const vault = await w.connection.getTokenAccountBalance(pdas(d.programId).poolVault()).catch(() => null);
      setStats({ members: members.length, staked: vault ? BigInt(vault.value.amount) : 0n, arbiters });
    })().catch(() => setStats(undefined));
  }, [w.program, w.deployment, w.connection, w.refreshKey]);
  return stats;
}

export default function StatsPage() {
  const w = useWallet();
  const deals = useAllDeals();
  const pool = usePoolStats();

  if (!w.deployment) return null;

  // Każda transakcja ma własny sejf; liczymy, co w nich teraz leży: wpłata + kaucje stron sporu.
  const locked = deals.reduce((sum, d) => {
    if (d.state < State.Funded || d.state >= State.Released) return sum;
    const bonds = d.state === State.Disputed ? d.bond : d.state === State.InArbitration ? 2n * d.bond : 0n;
    return sum + d.amount + bonds;
  }, 0n);

  const funded = deals.filter((d) => d.state !== State.Created && d.state !== State.Cancelled);
  const closed = funded.filter((d) => d.state >= State.Released);
  const volume = closed.reduce((s, d) => s + d.amount, 0n);
  const disputed = funded.filter((d) => d.bond > 0n).length;
  const disputeRate = funded.length ? Math.round((disputed / funded.length) * 100) : 0;
  // Bez arbitrów = nikogo nie trzeba było losować (kod, termin albo ugoda rozstrzygnęły same).
  const noArbiters = closed.filter((d) => !d.panelDrawn).length;
  const byVote = closed.filter((d) => d.panelDrawn && Math.max(d.votesBuyer, d.votesSeller) >= (w.deployment?.arbiterQuorum ?? 2)).length;
  const archived = deals.filter((d) => d.archived).length;
  const absences = pool?.arbiters.reduce((s, a) => s + a.missed, 0) ?? 0;

  const outcomes: Bar[] = [
    { label: "Wypłata dla sprzedawcy", value: count(deals, State.Released) },
    { label: "Zwrot dla kupującego", value: count(deals, State.Refunded) },
    { label: "Ugoda stron", value: count(deals, State.Settled) },
    { label: "Podział 50/50", value: count(deals, State.Split) },
    { label: "Anulowana oferta", value: count(deals, State.Cancelled) },
  ];
  const pipeline: Bar[] = [
    { label: "Czeka na kupującego", value: count(deals, State.Created) },
    { label: "Opłacona, przed nadaniem", value: count(deals, State.Funded) },
    { label: "W drodze", value: count(deals, State.Shipped) },
    { label: "Okno reklamacji", value: count(deals, State.Delivered) },
    { label: "Spór lub arbitraż", value: count(deals, State.Disputed, State.InArbitration) },
  ];

  return (
    <div className="grid">
      <section className="hero">
        <h1>Statystyki na żywo</h1>
        <p>Liczone bezpośrednio z publicznego rejestru — każdy może je sprawdzić, nikt nie może ich podkręcić.</p>
      </section>

      <section className="card wide tiles">
        <div className="tile">
          <span className="tile-label">Teraz zablokowane w sejfach</span>
          <b>{fmtUsdc(locked)}</b>
          <Pln usdc={locked} />
          <span className="muted small">wpłaty i kaucje, których nikt nie może ruszyć</span>
        </div>
        <div className="tile">
          <span className="tile-label">Przeszło przez SafeDeal</span>
          <b>{fmtUsdc(volume)}</b>
          <Pln usdc={volume} />
          <span className="muted small">{plural(closed.length, "zamknięta transakcja", "zamknięte transakcje", "zamkniętych transakcji")}</span>
        </div>
        <div className="tile">
          <span className="tile-label">Trafiło do sporu</span>
          <b>{disputeRate}%</b>
          <span className="muted small">
            {disputed} z {funded.length} opłaconych transakcji
          </span>
        </div>
        <div className="tile">
          <span className="tile-label">Zamknięte bez arbitrów</span>
          <b>
            {noArbiters}/{closed.length}
          </b>
          <span className="muted small">kod, termin lub ugoda rozstrzygnęły same</span>
        </div>
      </section>

      <section className="card wide">
        <h2>Arbitrzy i porządki</h2>
        <div className="tiles">
          <div className="tile">
            <span className="tile-label">Otwarta pula arbitrów</span>
            <b>{pool ? plural(pool.members, "osoba", "osoby", "osób") : "…"}</b>
            <span className="muted small">
              {pool ? <>kaucje w sejfie puli: {fmtUsdc(pool.staked)}</> : "wczytuję…"} ·{" "}
              <Link href="/arbitrzy" className="plink">
                pula →
              </Link>
            </span>
          </div>
          <div className="tile">
            <span className="tile-label">Spory rozstrzygnięte głosami</span>
            <b>{byVote}</b>
            <span className="muted small">skład losowany z puli, głosy niejawne</span>
          </div>
          <div className="tile">
            <span className="tile-label">Ukarane nieobecności</span>
            <b>{pool ? absences : "…"}</b>
            <span className="muted small">arbiter bez głosu traci {fmtUsdc(BigInt(w.deployment.missSlash ?? 0))} kaucji (spalane)</span>
          </div>
          <div className="tile">
            <span className="tile-label">Zamknięte konta</span>
            <b>{archived}</b>
            <span className="muted small">rent wrócił do sprzedawców; opis zostaje w historii łańcucha</span>
          </div>
        </div>
      </section>

      <Bars title="Jak kończą się transakcje" bars={outcomes} empty="Żadna transakcja jeszcze się nie zakończyła." />
      <Bars title="Transakcje w toku" bars={pipeline} empty="Nic nie jest teraz w toku." />
      <ProgramRules />
    </div>
  );
}
