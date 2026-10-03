"use client";

import { useState } from "react";
import { State, isZero, type Deal } from "@/lib/contracts";
import { fmtUsdc, sameAddr } from "@/lib/format";
import { nameOf, useWallet } from "@/lib/wallet";

/** Ugoda: strony same dzielą kwotę (np. częściowy zwrot za usterkę) — bez czekania na arbitrów. */
export function SettlementPanel({ deal }: { id?: bigint; deal: Deal }) {
  const w = useWallet();
  const [percent, setPercent] = useState(30);

  const s = deal.state as State;
  const isBuyer = sameAddr(w.address, deal.buyer);
  const isSeller = sameAddr(w.address, deal.seller);
  const open = s >= State.Shipped && s <= State.InArbitration;

  if (!open || (!isBuyer && !isSeller)) return null;

  const offer = isZero(deal.settlementProposer)
    ? null
    : { proposer: deal.settlementProposer, buyerAmount: deal.settlementBuyerAmount };
  const proposed = (deal.amount * BigInt(percent)) / 100n;
  const mine = offer && sameAddr(offer.proposer, w.address);
  const theirs = offer && !mine;
  const bondsNote =
    s === State.InArbitration ? " Obie kaucje wracają." : s === State.Disputed ? " Kaucja kupującego wraca." : "";

  return (
    <section className="card wide settlement">
      <h2>Ugoda</h2>
      <p className="muted small">
        Zamiast sporu możecie się dogadać: część kwoty wraca do kupującego, reszta trafia do sprzedawcy. Program wypłaca od
        razu, gdy druga strona zaakceptuje.{bondsNote}
      </p>

      {theirs && (
        <div className="offer">
          <div>
            <b>{nameOf(offer.proposer) ?? "Druga strona"}</b> proponuje: <b>{fmtUsdc(offer.buyerAmount)}</b> dla kupującego,{" "}
            <b>{fmtUsdc(deal.amount - offer.buyerAmount)}</b> dla sprzedawcy.
          </div>
          <button
            className="btn"
            disabled={!!w.busy}
            onClick={() => w.write("acceptSettlement", [offer.buyerAmount], { deal, label: "Przyjęto ugodę" })}
          >
            Przyjmij ugodę
          </button>
        </div>
      )}
      {mine && (
        <p className="muted">
          Twoja propozycja: {fmtUsdc(offer.buyerAmount)} dla kupującego — czeka na drugą stronę. Możesz ją zmienić poniżej.
        </p>
      )}

      <div className="settle-form">
        <label className="grow">
          Zwrot dla kupującego: <b>{percent}%</b> = {fmtUsdc(proposed)} · sprzedawca: {fmtUsdc(deal.amount - proposed)}
          <input type="range" min={0} max={100} step={5} value={percent} onChange={(e) => setPercent(Number(e.target.value))} />
        </label>
        <button
          className="btn ghost"
          disabled={!!w.busy}
          onClick={() => w.write("proposeSettlement", [proposed], { deal, label: "Zaproponowano ugodę" })}
        >
          {offer ? "Zaproponuj inny podział" : "Zaproponuj podział"}
        </button>
      </div>
    </section>
  );
}
