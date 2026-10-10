"use client";

import Link from "next/link";
import type { Deal, Profile } from "@/lib/contracts";
import { dealsDone, fmtDuration, fmtUsdc, plural, short } from "@/lib/format";
import { nameOf, useWallet } from "@/lib/wallet";
import { RatingInline } from "./Reviews";
import { Pln } from "@/lib/pln";

/** Przed zakupem: od kogo kupujesz i co się stanie z pieniędzmi w każdym scenariuszu — wprost z parametrów programu. */
export function BuyerGuarantee({ deal, rep, pickup }: { deal: Deal; rep?: Profile; pickup?: boolean }) {
  const w = useWallet();
  const d = w.deployment;
  if (!d) return null;

  const seller = deal.seller;
  const done = rep ? rep.soldOk + rep.boughtOk : 0;
  const lost = rep ? rep.disputesLost : 0;
  const bond = (deal.amount * BigInt(d.bondBps)) / 10_000n;

  return (
    <section className="card wide trust-card">
      <h2>Who you're buying from</h2>
      <p>
        <Link href={`/u/${seller}`} className="plink">
          <b>{nameOf(seller) ?? short(seller)}</b>
        </Link>
        <RatingInline address={seller} />
        {" · "}
        {done === 0 ? (
          <span className="muted">new user with no history — which is exactly why you pay through the SafeDeal vault</span>
        ) : (
          <span>
            {dealsDone(done)}
            {lost > 0 && <span className="err-text"> · {plural(lost, "dispute lost", "disputes lost", "disputes lost")}</span>}
          </span>
        )}
      </p>
      <p className="muted small">You don't have to trust the seller. These rules are enforced by a program on the blockchain, regardless of what either party wants:</p>
      <ul className="guarantees">
        <li>
          Your {fmtUsdc(deal.amount)} (<Pln usdc={deal.amount} />) goes into the program's vault, not to the seller — they can't touch it.
        </li>
        <li>If the seller doesn't ship within {fmtDuration(d.windows.ship)}, the money comes back to you.</li>
        <li>
          The payout happens only after {d.oracleQuorum} of {d.oracles.length} independent sources confirm delivery and the{" "}
          {fmtDuration(d.windows.inspection)} complaint window has passed.
        </li>
        <li>
          If something's wrong, you file a complaint with a {fmtUsdc(bond)} bond — you get it back if you're right. You can also propose
          a partial refund.
        </li>
        {pickup && (
          <li>
            You can also choose in-person pickup: you pay into the vault and show the pickup code only after inspecting the item.
          </li>
        )}
      </ul>
    </section>
  );
}
