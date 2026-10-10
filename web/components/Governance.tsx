"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { Address, ConfigAccount } from "@/lib/contracts";
import { fmtDuration, fmtUsdc, short } from "@/lib/format";
import { explorerAddr, fetchPool, pdas, toConfig } from "@/lib/solana";
import { nameOf, useWallet } from "@/lib/wallet";

type Windows = { ship: number; transit: number; inspection: number; response: number; arbitration: number; reveal: number };
type Rules = { cfg: ConfigAccount; windows: Windows; pool: number };

const names = (list: readonly Address[]) => list.map((a) => nameOf(a) ?? short(a)).join(", ");

/**
 * Reguły zapisane w programie przy jego uruchomieniu. Program nie ma instrukcji administratora,
 * więc nikt — także autor — nie może ich zmienić ani wybrać arbitrów (skład losuje program z otwartej puli).
 */
export function ProgramRules() {
  const w = useWallet();
  const [rules, setRules] = useState<Rules>();

  useEffect(() => {
    if (!w.deployment || !w.program) return;
    const d = w.deployment;
    // Konto konfiguracji czytamy wprost, żeby pokazać też terminy zapisane w łańcuchu (nie tylko w pliku wdrożenia).
    (w.program.account as unknown as { config: { fetch: (k: unknown) => Promise<Record<string, unknown>> } }).config
      .fetch(pdas(d.programId).config())
      .then(async (raw) => {
        const n = (k: string, fallback: number) => (raw[k] !== undefined ? Number(String(raw[k])) : fallback);
        const pool = await fetchPool(w.program!).then((m) => m.length).catch(() => 0);
        setRules({
          pool,
          cfg: toConfig(raw),
          windows: {
            ship: n("shipWindow", d.windows.ship),
            transit: n("transitWindow", d.windows.transit),
            inspection: n("inspectionWindow", d.windows.inspection),
            response: n("responseWindow", d.windows.response),
            arbitration: n("arbitrationWindow", d.windows.arbitration),
            reveal: n("revealWindow", d.windows.reveal),
          },
        });
      })
      .catch(() => setRules(undefined));
  }, [w.deployment, w.program]);

  if (!w.deployment || !rules) return null;
  const { cfg, windows, pool } = rules;
  const cluster = w.deployment.cluster;

  return (
    <section className="card wide">
      <h2>Rules of the game</h2>
      <table className="gov">
        <tbody>
          <tr>
            <th>Delivery confirmations</th>
            <td>
              {cfg.oracleQuorum} of {cfg.oracles.length} independent parcel-status sources must agree · {names(cfg.oracles)}
            </td>
          </tr>
          <tr>
            <th>Arbiters</th>
            <td>
              open pool ({pool} members) — anyone can join with a bond of at least {fmtUsdc(cfg.arbiterStake)} · for each dispute the program draws 3
              people other than the parties · verdict at {cfg.arbiterQuorum} of 3 votes · no vote: {fmtUsdc(cfg.missSlash)} of the bond burned ·{" "}
              <Link href="/arbitrzy" className="plink">
                pool →
              </Link>
            </td>
          </tr>
          <tr>
            <th>Deadlines</th>
            <td>
              shipping: {fmtDuration(windows.ship)} · delivery: {fmtDuration(windows.transit)} · parcel inspection:{" "}
              {fmtDuration(windows.inspection)} · response to a claim: {fmtDuration(windows.response)} · arbiter voting:{" "}
              {fmtDuration(windows.arbitration)} + reveal {fmtDuration(windows.reveal)}
            </td>
          </tr>
          <tr>
            <th>Closing accounts</th>
            <td>
              after settlement anyone can close the deal's accounts — the rent goes back to the seller; after {fmtDuration(Number(cfg.archiveWindow))} even
              without both reviews
            </td>
          </tr>
          <tr>
            <th>Dispute bond</th>
            <td>{(cfg.bondBps / 100).toLocaleString("en-GB")}% of the amount — paid by each party that enters the dispute; the loser forfeits it</td>
          </tr>
          <tr>
            <th>Program</th>
            <td>
              <a className="mono" href={explorerAddr(w.deployment.programId, cluster)} target="_blank" rel="noreferrer">
                {w.deployment.programId} ↗
              </a>
            </td>
          </tr>
        </tbody>
      </table>
      <p>
        <b>There is no admin instruction — nobody can change these rules, not even the author.</b>
      </p>
    </section>
  );
}

/** Dawna nazwa — zostawiona dla zgodności importów. */
export const Governance = ProgramRules;
