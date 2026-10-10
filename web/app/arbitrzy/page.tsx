"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { Address, ArbiterAccount } from "@/lib/contracts";
import { fmtUsdc, sameAddr, short } from "@/lib/format";
import { explorerAddr, fetchArbiters, fetchPool, pdas } from "@/lib/solana";
import { nameOf, useWallet } from "@/lib/wallet";

type Row = { owner: Address; a: ArbiterAccount | null };

/**
 * Otwarta pula arbitrów. Każdy może dołączyć, wpłacając kaucję do sejfu puli (właścicielem jest program).
 * Do konkretnego sporu program losuje 3 osoby — nikt, także strony i autorzy, nie wybiera arbitrów.
 */
export default function ArbitersPage() {
  const w = useWallet();
  const [rows, setRows] = useState<Row[]>();
  const [me, setMe] = useState<ArbiterAccount | null>();
  const [poolVault, setPoolVault] = useState<bigint>();
  const [stake, setStake] = useState("");

  const d = w.deployment;
  const minStake = BigInt(d?.arbiterStake ?? 0);

  useEffect(() => {
    if (!w.program || !d) return;
    const program = w.program;
    (async () => {
      const members = await fetchPool(program);
      const accounts = await fetchArbiters(program, members);
      setRows(members.map((owner, i) => ({ owner, a: accounts[i] })));
      const vault = await w.connection.getTokenAccountBalance(pdas(d.programId).poolVault()).catch(() => null);
      if (vault) setPoolVault(BigInt(vault.value.amount));
      if (w.address) setMe((await fetchArbiters(program, [w.address]))[0]);
      else setMe(undefined);
    })().catch((e) => {
      console.error("[SafeDeal] arbiter pool", e);
      setRows([]);
    });
  }, [w.program, w.connection, d, w.address, w.refreshKey]);

  if (!d) return null;
  const inPool = !!me?.inPool;
  const amount = (() => {
    const v = Number(stake.replace(",", "."));
    return Number.isFinite(v) && v > 0 ? BigInt(Math.round(v * 1_000_000)) : minStake;
  })();

  return (
    <div className="grid">
      <section className="hero">
        <h1>Arbiters: an open pool, a randomly drawn panel</h1>
        <p>
          A dispute the parties couldn't settle themselves is decided by 3 arbiters. They aren't picked by the seller, the buyer or the
          SafeDeal team: the program draws the panel from this pool, using as randomness the hash of a block produced only after the dispute was accepted.
          Anyone who posts a bond can join.
        </p>
      </section>

      <section className="card">
        <h2>Rules</h2>
        <ul className="plain">
          <li>
            Bond: at least <b>{fmtUsdc(minStake)}</b> — held in the pool vault, which is owned by the program.
          </li>
          <li>Parties to a dispute are never drawn for their own case.</li>
          <li>Secret ballot (commit–reveal): until phase 1 ends, only vote hashes are visible on-chain.</li>
          <li>Voting with the winner: a share of the losing party's bond.</li>
          <li>
            No vote: <b>{fmtUsdc(BigInt(d.missSlash ?? 0))}</b> of the bond is burned — nobody profits from it, so nobody has an interest in
            someone else missing a vote. Bond below the minimum = removed from the pool.
          </li>
          <li>You can leave the pool and withdraw your bond once you have no unsettled cases.</li>
        </ul>
        <p className="muted small">
          Pool vault:{" "}
          <a className="mono plink" href={explorerAddr(pdas(d.programId).poolVault().toBase58(), d.cluster)} target="_blank" rel="noreferrer">
            {short(pdas(d.programId).poolVault().toBase58())} ↗
          </a>
          {poolVault !== undefined && <> · holding {fmtUsdc(poolVault)}</>}
        </p>
      </section>

      <section className="card">
        <h2>Your place in the pool</h2>
        {!w.address ? (
          <p className="muted">Connect a wallet to join.</p>
        ) : inPool ? (
          <>
            <p>
              You're in the pool with a bond of <b>{fmtUsdc(me!.stake)}</b>. Cases drawn: {me!.cases}, in progress: {me!.activeCases}.
            </p>
            <p className="muted small">
              Track record: {me!.withMajority} votes matching the verdict · {me!.againstMajority} against · {me!.missed} missed
            </p>
            <button
              className="btn ghost"
              disabled={!!w.busy || me!.activeCases > 0}
              onClick={() => w.write("leavePool", [], { label: "Left the arbiter pool" })}
            >
              Leave the pool and withdraw the bond
            </button>
            {me!.activeCases > 0 && <p className="muted small">Your cases must finish and be settled first.</p>}
          </>
        ) : (
          <>
            {me && me.stake > 0n && (
              <p className="muted small">
                You have {fmtUsdc(me.stake)} in the pool vault (outside the pool — e.g. after a penalty for a missed vote). A new bond (minimum below) is added to this amount and puts you back in the pool — or withdraw the funds
                with the button below.
              </p>
            )}
            <div className="inline">
              <input
                value={stake}
                onChange={(e) => setStake(e.target.value)}
                placeholder={`Bond in USDC (min. ${Number(minStake) / 1_000_000})`}
                inputMode="decimal"
                aria-label="Bond in USDC"
              />
              <button
                className="btn"
                disabled={!!w.busy || amount < minStake}
                onClick={() => w.write("joinPool", [amount], { label: "Joined the arbiter pool" })}
              >
                Join with a {fmtUsdc(amount)} bond
              </button>
            </div>
            {me && me.stake > 0n && me.activeCases === 0 && (
              <button className="btn ghost sm" disabled={!!w.busy} onClick={() => w.write("leavePool", [], { label: "Bond withdrawn" })}>
                Withdraw {fmtUsdc(me.stake)}
              </button>
            )}
            <p className="muted small">Get test USDC from the faucet in the header (devnet).</p>
          </>
        )}
      </section>

      <section className="card wide">
        <h2>Pool ({rows?.length ?? "…"})</h2>
        {rows === undefined ? (
          <p className="muted">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="muted">The pool is empty — disputes can't go to arbitration until at least 3 people join (plus the parties, if they're in the pool).</p>
        ) : (
          <table className="gov pool-table">
            <thead>
              <tr>
                <th>Arbiter</th>
                <th>Bond</th>
                <th>Cases</th>
                <th title="with the verdict · against · missed">✓ · ✗ · ∅</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ owner, a }) => (
                <tr key={owner}>
                  <td>
                    <Link href={`/u/${owner}`} className="plink">
                      {nameOf(owner) ?? short(owner)}
                    </Link>
                    {sameAddr(owner, w.address) && <span className="you"> you</span>}
                  </td>
                  <td className="mono" data-label="Bond">
                    {a ? fmtUsdc(a.stake) : "—"}
                  </td>
                  <td data-label="Cases">
                    {a?.cases ?? 0}
                    {a && a.activeCases > 0 && <small className="muted"> ({a.activeCases} in progress)</small>}
                  </td>
                  <td className="mono" data-label="Track record (✓ · ✗ · ∅)">
                    {a?.withMajority ?? 0} · {a?.againstMajority ?? 0} · {a?.missed ?? 0}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
