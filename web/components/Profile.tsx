"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { State, type Address, type ArbiterAccount } from "@/lib/contracts";
import { dealsDone, fmtUsdc, sameAddr, short } from "@/lib/format";
import { fetchArbiters, fetchProfile } from "@/lib/solana";
import { nameOf, useWallet } from "@/lib/wallet";
import type { Row } from "./DealList";

type Rep = { soldOk: number; boughtOk: number; won: number; lost: number };

/** Reputacja z konta profilu w programie — nikt (także my) nie może jej podkręcić ani usunąć. */
function useReputation(address: Address) {
  const w = useWallet();
  const [rep, setRep] = useState<Rep>();
  const [arb, setArb] = useState<ArbiterAccount>();

  useEffect(() => {
    if (!w.deployment || !w.program) return;
    fetchProfile(w.program, w.deployment, address)
      .then((p) => setRep({ soldOk: p.soldOk, boughtOk: p.boughtOk, won: p.disputesWon, lost: p.disputesLost }))
      .catch(() => setRep(undefined));
  }, [w.deployment, w.program, w.refreshKey, address]);

  // Konto arbitra (kaucja, rzetelność) — istnieje tylko u kogoś, kto był w puli arbitrów.
  useEffect(() => {
    if (!w.program) return setArb(undefined);
    fetchArbiters(w.program, [address])
      .then(([a]) => setArb(a ?? undefined))
      .catch(() => setArb(undefined));
  }, [w.program, w.lastTx, address]);

  return { rep, arb };
}

function trustLabel(rep: Rep): { text: string; tone: "ok" | "new" | "warn" } {
  const done = rep.soldOk + rep.boughtOk;
  if (rep.lost > 0 && rep.lost >= rep.won) return { text: "Lost disputes — proceed with caution", tone: "warn" };
  if (done === 0) return { text: "New user — no history", tone: "new" };
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
            <span>sales</span>
          </div>
          <div>
            <b>{rep.boughtOk}</b>
            <span>purchases</span>
          </div>
          <div>
            <b>
              {rep.won}/{rep.won + rep.lost}
            </b>
            <span>disputes won</span>
          </div>
          <div>
            <b>{active.length}</b>
            <span>in progress</span>
          </div>
        </div>
      )}
      {!compact && volume > 0n && <p className="muted">Total sold with SafeDeal protection: {fmtUsdc(volume)}</p>}

      {arb && (
        <p className="muted small">
          As arbiter{arb.inPool ? ` (in pool, bond ${fmtUsdc(arb.stake)})` : ""}: {arb.cases} cases drawn ·{" "}
          {arb.withMajority} votes matching the verdict · {arb.againstMajority} against · {arb.missed} missed
        </p>
      )}
      <p className="muted small">This data comes straight from the public ledger — it can't be bought, deleted or inflated.</p>
      {compact && (
        <Link href={`/u/${address}`} className="btn ghost sm">
          View full profile
        </Link>
      )}
    </section>
  );
}
