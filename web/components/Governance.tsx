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
            <th>Arbitrzy</th>
            <td>
              otwarta pula ({pool} os.) — dołączyć może każdy z kaucją min. {fmtUsdc(cfg.arbiterStake)} · do każdego sporu program losuje 3
              osoby spoza stron · werdykt przy {cfg.arbiterQuorum} z 3 głosów · brak głosu: {fmtUsdc(cfg.missSlash)} kaucji spalone ·{" "}
              <Link href="/arbitrzy" className="plink">
                pula →
              </Link>
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
            <th>Zamykanie kont</th>
            <td>
              po rozliczeniu każdy może zamknąć konta transakcji — rent wraca do sprzedawcy; po {fmtDuration(Number(cfg.archiveWindow))} także
              bez kompletu opinii
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
