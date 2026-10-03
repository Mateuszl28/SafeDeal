"use client";

import { useState } from "react";
import { useAllDeals, type Row } from "@/components/DealList";
import { State } from "@/lib/contracts";
import { fmtUsdc, plural } from "@/lib/format";
import { useWallet } from "@/lib/wallet";
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

export default function StatsPage() {
  const w = useWallet();
  const deals = useAllDeals();

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
  const noArbiters = closed.filter((d) => d.votesBuyer + d.votesSeller === 0).length;

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
          <span className="muted small">kod lub ugoda rozstrzygnęły same</span>
        </div>
      </section>

      <Bars title="Jak kończą się transakcje" bars={outcomes} empty="Żadna transakcja jeszcze się nie zakończyła." />
      <Bars title="Transakcje w toku" bars={pipeline} empty="Nic nie jest teraz w toku." />
      <ProgramRules />
    </div>
  );
}
