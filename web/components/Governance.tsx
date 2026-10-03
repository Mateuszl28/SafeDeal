"use client";

import { useEffect, useState } from "react";
import type { Address, ConfigAccount } from "@/lib/contracts";
import { fmtDuration, short } from "@/lib/format";
import { explorerAddr, pdas, toConfig } from "@/lib/solana";
import { nameOf, useWallet } from "@/lib/wallet";

type Windows = { ship: number; transit: number; inspection: number; response: number; arbitration: number; reveal: number };
type Rules = { cfg: ConfigAccount; windows: Windows };

const names = (list: readonly Address[]) => list.map((a) => nameOf(a) ?? short(a)).join(", ");

/**
 * Reguły zapisane w programie przy jego uruchomieniu. Program nie ma instrukcji administratora,
 * więc nikt — także autor — nie może ich zmienić ani podmienić arbitrów.
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
      .then((raw) => {
        const n = (k: string, fallback: number) => (raw[k] !== undefined ? Number(String(raw[k])) : fallback);
        setRules({
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
  const { cfg, windows } = rules;
  const cluster = w.deployment.cluster;

  return (
    <section className="card wide">
      <h2>Reguły gry</h2>
      <table className="gov">
        <tbody>
          <tr>
            <th>Potwierdzenia doręczenia</th>
            <td>
              {cfg.oracleQuorum} z {cfg.oracles.length} niezależnych źródeł statusu przesyłki musi się zgodzić · {names(cfg.oracles)}
            </td>
          </tr>
          <tr>
            <th>Rada arbitrów</th>
            <td>
              rozstrzyga spory, których strony nie załatwiły same · werdykt przy {cfg.arbiterQuorum} z {cfg.arbiters.length} głosów ·{" "}
              {names(cfg.arbiters)}
            </td>
          </tr>
          <tr>
            <th>Terminy</th>
            <td>
              nadanie: {fmtDuration(windows.ship)} · dostawa: {fmtDuration(windows.transit)} · sprawdzenie paczki:{" "}
              {fmtDuration(windows.inspection)} · odpowiedź na reklamację: {fmtDuration(windows.response)} · głosowanie arbitrów:{" "}
              {fmtDuration(windows.arbitration)} + ujawnienie {fmtDuration(windows.reveal)}
            </td>
          </tr>
          <tr>
            <th>Kaucja przy sporze</th>
            <td>{(cfg.bondBps / 100).toLocaleString("pl-PL")}% kwoty — wpłaca każda strona, która idzie w spór; przegrany ją traci</td>
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
        <b>Nie ma instrukcji administratora — tych reguł nie może zmienić nikt, także autor.</b>
      </p>
    </section>
  );
}

/** Dawna nazwa — zostawiona dla zgodności importów. */
export const Governance = ProgramRules;
