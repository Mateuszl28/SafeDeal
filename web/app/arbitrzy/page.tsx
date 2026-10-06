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
      console.error("[SafeDeal] pula arbitrów", e);
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
        <h1>Arbitrzy: otwarta pula, losowany skład</h1>
        <p>
          Spór, którego strony nie załatwiły same, rozstrzyga 3 arbitrów. Nie wybiera ich ani sprzedawca, ani kupujący, ani autorzy
          SafeDeal: program losuje skład z tej puli, a źródłem losowości jest hash bloku, który powstał dopiero po przyjęciu sporu.
          Dołączyć może każdy, kto wpłaci kaucję.
        </p>
      </section>

      <section className="card">
        <h2>Zasady</h2>
        <ul className="plain">
          <li>
            Kaucja: min. <b>{fmtUsdc(minStake)}</b> — leży w sejfie puli, którego właścicielem jest program.
          </li>
          <li>Strony sporu nigdy nie trafiają do składu swojej sprawy.</li>
          <li>Głos niejawny (commit–reveal): do końca fazy 1 w sieci widać tylko odciski głosów.</li>
          <li>Głos za zwycięzcą: udział w kaucji przegranej strony.</li>
          <li>
            Brak głosu: <b>{fmtUsdc(BigInt(d.missSlash ?? 0))}</b> kaucji jest spalane — nikt na tym nie zarabia, więc nikt nie ma interesu w
            cudzej nieobecności. Kaucja poniżej minimum = wypadnięcie z puli.
          </li>
          <li>Wyjście z puli z odbiorem kaucji — gdy nie masz nierozliczonych spraw.</li>
        </ul>
        <p className="muted small">
          Sejf puli:{" "}
          <a className="mono plink" href={explorerAddr(pdas(d.programId).poolVault().toBase58(), d.cluster)} target="_blank" rel="noreferrer">
            {short(pdas(d.programId).poolVault().toBase58())} ↗
          </a>
          {poolVault !== undefined && <> · w środku {fmtUsdc(poolVault)}</>}
        </p>
      </section>

      <section className="card">
        <h2>Twoje miejsce w puli</h2>
        {!w.address ? (
          <p className="muted">Połącz portfel, aby dołączyć.</p>
        ) : inPool ? (
          <>
            <p>
              Jesteś w puli z kaucją <b>{fmtUsdc(me!.stake)}</b>. Wylosowane sprawy: {me!.cases}, w toku: {me!.activeCases}.
            </p>
            <p className="muted small">
              Rzetelność: {me!.withMajority} głosów zgodnych z werdyktem · {me!.againstMajority} przeciw · {me!.missed} nieobecności
            </p>
            <button
              className="btn ghost"
              disabled={!!w.busy || me!.activeCases > 0}
              onClick={() => w.write("leavePool", [], { label: "Wyjście z puli arbitrów" })}
            >
              Wyjdź z puli i odbierz kaucję
            </button>
            {me!.activeCases > 0 && <p className="muted small">Najpierw muszą się zakończyć i zostać rozliczone Twoje sprawy.</p>}
          </>
        ) : (
          <>
            {me && me.stake > 0n && (
              <p className="muted small">
                Masz w sejfie puli {fmtUsdc(me.stake)} (poza pulą — np. po karze za nieobecność). Nowa kaucja (min. jak niżej) dolicza się do tej kwoty i wraca Cię do puli — albo odbierz środki
                przyciskiem poniżej.
              </p>
            )}
            <div className="inline">
              <input
                value={stake}
                onChange={(e) => setStake(e.target.value)}
                placeholder={`Kaucja w USDC (min. ${Number(minStake) / 1_000_000})`}
                inputMode="decimal"
                aria-label="Kaucja w USDC"
              />
              <button
                className="btn"
                disabled={!!w.busy || amount < minStake}
                onClick={() => w.write("joinPool", [amount], { label: "Dołączono do puli arbitrów" })}
              >
                Dołącz z kaucją {fmtUsdc(amount)}
              </button>
            </div>
            {me && me.stake > 0n && me.activeCases === 0 && (
              <button className="btn ghost sm" disabled={!!w.busy} onClick={() => w.write("leavePool", [], { label: "Odebrano kaucję" })}>
                Odbierz {fmtUsdc(me.stake)}
              </button>
            )}
            <p className="muted small">Testowe USDC daje kran w nagłówku (devnet).</p>
          </>
        )}
      </section>

      <section className="card wide">
        <h2>Pula ({rows?.length ?? "…"})</h2>
        {rows === undefined ? (
          <p className="muted">Wczytuję…</p>
        ) : rows.length === 0 ? (
          <p className="muted">Pula jest pusta — spory nie mogą trafić do arbitrażu, dopóki nie dołączą co najmniej 3 osoby (+ ewentualnie strony).</p>
        ) : (
          <table className="gov">
            <thead>
              <tr>
                <th>Arbiter</th>
                <th>Kaucja</th>
                <th>Sprawy</th>
                <th title="zgodnie z werdyktem · przeciw · nieobecny">✓ · ✗ · ∅</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ owner, a }) => (
                <tr key={owner}>
                  <td>
                    <Link href={`/u/${owner}`} className="plink">
                      {nameOf(owner) ?? short(owner)}
                    </Link>
                    {sameAddr(owner, w.address) && <span className="you"> to Ty</span>}
                  </td>
                  <td className="mono">{a ? fmtUsdc(a.stake) : "—"}</td>
                  <td>
                    {a?.cases ?? 0}
                    {a && a.activeCases > 0 && <small className="muted"> ({a.activeCases} w toku)</small>}
                  </td>
                  <td className="mono">
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
