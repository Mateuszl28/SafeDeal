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
                    <b>{b.label}</b>: {b.value} of {total} ({Math.round((b.value / total) * 100)}%)
                  </span>
                )}
              </li>
            ))}
          </ul>
          <details className="as-table">
            <summary>Show as table</summary>
            <table>
              <thead>
                <tr>
                  <th>Category</th>
                  <th>Count</th>
                  <th>Share</th>
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
    { label: "Payout to seller", value: count(deals, State.Released) },
    { label: "Refund to buyer", value: count(deals, State.Refunded) },
    { label: "Settlement between parties", value: count(deals, State.Settled) },
    { label: "50/50 split", value: count(deals, State.Split) },
    { label: "Cancelled offer", value: count(deals, State.Cancelled) },
  ];
  const pipeline: Bar[] = [
    { label: "Waiting for a buyer", value: count(deals, State.Created) },
    { label: "Paid, not yet shipped", value: count(deals, State.Funded) },
    { label: "In transit", value: count(deals, State.Shipped) },
    { label: "Complaint window", value: count(deals, State.Delivered) },
    { label: "Dispute or arbitration", value: count(deals, State.Disputed, State.InArbitration) },
  ];

  return (
    <div className="grid">
      <section className="hero">
        <h1>Live stats</h1>
        <p>Computed directly from the public ledger — anyone can verify them, nobody can inflate them.</p>
      </section>

      <section className="card wide tiles">
        <div className="tile">
          <span className="tile-label">Currently locked in vaults</span>
          <b>{fmtUsdc(locked)}</b>
          <Pln usdc={locked} />
          <span className="muted small">payments and bonds nobody can touch</span>
        </div>
        <div className="tile">
          <span className="tile-label">Processed through SafeDeal</span>
          <b>{fmtUsdc(volume)}</b>
          <Pln usdc={volume} />
          <span className="muted small">{plural(closed.length, "completed deal", "completed deals", "completed deals")}</span>
        </div>
        <div className="tile">
          <span className="tile-label">Went to dispute</span>
          <b>{disputeRate}%</b>
          <span className="muted small">
            {disputed} of {funded.length} funded deals
          </span>
        </div>
        <div className="tile">
          <span className="tile-label">Closed without arbiters</span>
          <b>
            {noArbiters}/{closed.length}
          </b>
          <span className="muted small">resolved by code, deadline or settlement</span>
        </div>
      </section>

      <section className="card wide">
        <h2>Arbiters and cleanup</h2>
        <div className="tiles">
          <div className="tile">
            <span className="tile-label">Open arbiter pool</span>
            <b>{pool ? plural(pool.members, "person", "people", "people") : "…"}</b>
            <span className="muted small">
              {pool ? <>bonds in the pool vault: {fmtUsdc(pool.staked)}</> : "loading…"} ·{" "}
              <Link href="/arbitrzy" className="plink">
                pool →
              </Link>
            </span>
          </div>
          <div className="tile">
            <span className="tile-label">Disputes resolved by vote</span>
            <b>{byVote}</b>
            <span className="muted small">panel drawn from the pool, secret votes</span>
          </div>
          <div className="tile">
            <span className="tile-label">Penalized absences</span>
            <b>{pool ? absences : "…"}</b>
            <span className="muted small">an arbiter who doesn't vote loses {fmtUsdc(BigInt(w.deployment.missSlash ?? 0))} of their bond (burned)</span>
          </div>
          <div className="tile">
            <span className="tile-label">Closed accounts</span>
            <b>{archived}</b>
            <span className="muted small">rent returned to sellers; the description stays in the chain history</span>
          </div>
        </div>
      </section>

      <Bars title="How deals end" bars={outcomes} empty="No deal has finished yet." />
      <Bars title="Deals in progress" bars={pipeline} empty="Nothing is in progress right now." />
      <ProgramRules />
    </div>
  );
}
