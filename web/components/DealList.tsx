"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { STATE_LABEL, isFinal, isZero, type Deal } from "@/lib/contracts";
import { fmtUsdc } from "@/lib/format";
import { nameOf, useWallet } from "@/lib/wallet";
import { fetchAllDeals } from "@/lib/solana";
import { Pln } from "@/lib/pln";
import { parseStage } from "@/lib/project";

/** Przy etapach zlecenia te same stany znaczą co innego niż przy paczkach. */
const STAGE_LABEL: Partial<Record<number, string>> = {
  1: "Awaiting payment",
  2: "Funded — in progress",
  3: "Delivered — awaiting approval",
  7: "Accepted — paid out",
};

/** Opis i zdjęcie oferty są teraz polami konta transakcji — wiersz listy to po prostu `Deal`. */
export type Row = Deal;
export type Listing = { description: string; photoUri: string; photoHash: string };
export const listingOf = (d: Deal): Listing => ({ description: d.description, photoUri: d.photoUri, photoHash: d.photoHash });

/** Wszystkie transakcje programu (konta PDA), od najnowszej. */
export function useAllDeals() {
  const w = useWallet();
  const [deals, setDeals] = useState<Row[]>([]);

  useEffect(() => {
    if (!w.deployment || !w.program) return setDeals([]);
    let alive = true;
    fetchAllDeals(w.program, true)
      .then((d) => alive && setDeals(d))
      .catch(() => alive && setDeals([]));
    return () => {
      alive = false;
    };
  }, [w.deployment, w.program, w.refreshKey]);

  return deals;
}

export function DealList({ title, rows, empty }: { title: string; rows: Row[]; empty?: string }) {
  return (
    <section className="card wide">
      <h2>{title}</h2>
      {rows.length === 0 ? (
        <p className="muted">{empty}</p>
      ) : (
        <ul className="list">
          {rows.map((d) => (
            <li key={String(d.id)}>
              <Link href={`/deal/${d.id}`}>
                <span className="mono muted">#{String(d.id)}</span>
                {d.photoUri ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img className="list-thumb" src={d.photoUri} alt="" />
                ) : (
                  <span className="list-thumb empty" aria-hidden="true" />
                )}
                <span className="grow">{d.title}</span>
                <span className="muted">
                  {nameOf(d.seller) ?? "seller"} → {isZero(d.buyer) ? "?" : (nameOf(d.buyer) ?? "buyer")}
                </span>
                <span className="mono">
                  {fmtUsdc(d.amount)} <Pln usdc={d.amount} />
                </span>
                <span className={`badge s${d.state} ${isFinal(d.state) ? "final" : ""}`}>
                  {(parseStage(d.description) && STAGE_LABEL[d.state]) || STATE_LABEL[d.state]}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
