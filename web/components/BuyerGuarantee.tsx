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
      <h2>Od kogo kupujesz</h2>
      <p>
        <Link href={`/u/${seller}`} className="plink">
          <b>{nameOf(seller) ?? short(seller)}</b>
        </Link>
        <RatingInline address={seller} />
        {" · "}
        {done === 0 ? (
          <span className="muted">nowy użytkownik, bez historii — i dlatego płacisz przez sejf SafeDeal</span>
        ) : (
          <span>
            {dealsDone(done)}
            {lost > 0 && <span className="err-text"> · {plural(lost, "przegrany spór", "przegrane spory", "przegranych sporów")}</span>}
          </span>
        )}
      </p>
      <p className="muted small">Nie musisz ufać sprzedawcy. Te reguły wykonuje program na blockchainie, niezależnie od woli którejkolwiek strony:</p>
      <ul className="guarantees">
        <li>
          Twoje {fmtUsdc(deal.amount)} (<Pln usdc={deal.amount} />) trafią do sejfu programu, nie do sprzedawcy — nie może ich ruszyć.
        </li>
        <li>Jeśli sprzedawca nie nada paczki w ciągu {fmtDuration(d.windows.ship)}, pieniądze wrócą do Ciebie.</li>
        <li>
          Wypłata nastąpi dopiero, gdy {d.oracleQuorum} z {d.oracles.length} niezależnych źródeł potwierdzą doręczenie i minie{" "}
          {fmtDuration(d.windows.inspection)} na reklamację.
        </li>
        <li>
          W razie problemu zgłosisz reklamację z kaucją {fmtUsdc(bond)} — wraca, jeśli masz rację. Możesz też zaproponować
          częściowy zwrot.
        </li>
        {pickup && (
          <li>
            Możesz też wybrać odbiór osobisty: płacisz do sejfu, a kod odbioru pokazujesz dopiero po obejrzeniu przedmiotu.
          </li>
        )}
      </ul>
    </section>
  );
}
