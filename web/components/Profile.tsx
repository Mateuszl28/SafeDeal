"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { State, type Address } from "@/lib/contracts";
import { dealsDone, fmtUsdc, sameAddr, short } from "@/lib/format";
import { fetchConfig, fetchProfile } from "@/lib/solana";
import { nameOf, useWallet } from "@/lib/wallet";
import type { Row } from "./DealList";

type Rep = { soldOk: number; boughtOk: number; won: number; lost: number };
type ArbStats = { withMajority: number; againstMajority: number; missed: number };

/** Reputacja z konta profilu w programie — nikt (także my) nie może jej podkręcić ani usunąć. */
function useReputation(address: Address) {
  const w = useWallet();
  const [rep, setRep] = useState<Rep>();
  const [arb, setArb] = useState<ArbStats>();
  const isCouncil = !!w.deployment?.arbiters.some((a) => sameAddr(a, address));

  useEffect(() => {
    if (!w.deployment || !w.program) return;
    fetchProfile(w.program, w.deployment, address)
      .then((p) => setRep({ soldOk: p.soldOk, boughtOk: p.boughtOk, won: p.disputesWon, lost: p.disputesLost }))
      .catch(() => setRep(undefined));
  }, [w.deployment, w.program, w.refreshKey, address]);

  // Statystyki arbitrów są w koncie konfiguracji — czytamy je tylko dla członków rady.
  useEffect(() => {
    if (!w.deployment || !w.program || !isCouncil) return setArb(undefined);
    fetchConfig(w.program, w.deployment)
      .then((c) => {
        const i = c.arbiters.findIndex((a) => sameAddr(a, address));
        setArb(i < 0 ? undefined : { withMajority: c.arbWithMajority[i] ?? 0, againstMajority: c.arbAgainstMajority[i] ?? 0, missed: c.arbMissed[i] ?? 0 });
      })
      .catch(() => setArb(undefined));
  }, [w.deployment, w.program, w.lastTx, isCouncil, address]);

  return { rep, arb };
}

function trustLabel(rep: Rep): { text: string; tone: "ok" | "new" | "warn" } {
  const done = rep.soldOk + rep.boughtOk;
  if (rep.lost > 0 && rep.lost >= rep.won) return { text: "Przegrane spory — zachowaj ostrożność", tone: "warn" };
  if (done === 0) return { text: "Nowy użytkownik — brak historii", tone: "new" };
  return { text: dealsDone(done), tone: "ok" };
}

export function ProfileSummary({ address, deals, compact }: { address: Address; deals: Row[]; compact?: boolean }) {
  const { rep, arb } = useReputation(address);
  const sold = deals.filter((d) => sameAddr(d.seller, address) && d.state === State.Released);
  const volume = sold.reduce((sum, d) => sum + d.amount, 0n);
  const active = deals.filter((d) => (sameAddr(d.seller, address) || sameAddr(d.buyer, address)) && d.state < State.Released);
  const label = rep && trustLabel(rep);

  return (
    <section className={`card profile ${compact ? "" : "wide"}`}>
      <div className="profile-head">
        <div>
          <h2>{nameOf(address) ?? short(address)}</h2>
          <span className="mono muted small">{address}</span>
        </div>
        {label && <span className={`trust ${label.tone}`}>{label.text}</span>}
      </div>

      {rep && (
        <div className="stats">
          <div>
            <b>{rep.soldOk}</b>
            <span>sprzedaży</span>
          </div>
          <div>
            <b>{rep.boughtOk}</b>
            <span>zakupów</span>
          </div>
          <div>
            <b>
              {rep.won}/{rep.won + rep.lost}
            </b>
            <span>wygrane spory</span>
          </div>
          <div>
            <b>{active.length}</b>
            <span>w toku</span>
          </div>
        </div>
      )}
      {!compact && volume > 0n && <p className="muted">Łącznie sprzedane z ochroną SafeDeal: {fmtUsdc(volume)}</p>}

      {arb && (
        <p className="muted small">
          Jako arbiter: {arb.withMajority} głosów zgodnych z werdyktem · {arb.againstMajority} przeciw · {arb.missed} nieobecności
        </p>
      )}
      <p className="muted small">Dane pochodzą wprost z publicznego rejestru — nie da się ich kupić, usunąć ani podkręcić.</p>
      {compact && (
        <Link href={`/u/${address}`} className="btn ghost sm">
          Zobacz pełny profil
        </Link>
      )}
    </section>
  );
}
