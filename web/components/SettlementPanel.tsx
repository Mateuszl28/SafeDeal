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
    s === State.InArbitration ? " Both bonds are returned." : s === State.Disputed ? " The buyer's bond is returned." : "";

  return (
    <section className="card wide settlement">
      <h2>Settlement</h2>
      <p className="muted small">
        Instead of a dispute you can come to terms: part of the amount goes back to the buyer, the rest goes to the seller. The program pays out
        immediately once the other party accepts.{bondsNote}
      </p>

      {theirs && (
        <div className="offer">
          <div>
            <b>{nameOf(offer.proposer) ?? "The other party"}</b> proposes: <b>{fmtUsdc(offer.buyerAmount)}</b> to the buyer,{" "}
            <b>{fmtUsdc(deal.amount - offer.buyerAmount)}</b> to the seller.
          </div>
          <button
            className="btn"
            disabled={!!w.busy}
            onClick={() => w.write("acceptSettlement", [offer.buyerAmount], { deal, label: "Settlement accepted" })}
          >
            Accept settlement
          </button>
        </div>
      )}
      {mine && (
        <p className="muted">
          Your proposal: {fmtUsdc(offer.buyerAmount)} to the buyer — waiting for the other party. You can change it below.
        </p>
      )}

      <div className="settle-form">
        <label className="grow">
          Refund to the buyer: <b>{percent}%</b> = {fmtUsdc(proposed)} · seller: {fmtUsdc(deal.amount - proposed)}
          <input type="range" min={0} max={100} step={5} value={percent} onChange={(e) => setPercent(Number(e.target.value))} />
        </label>
        <button
          className="btn ghost"
          disabled={!!w.busy}
          onClick={() => w.write("proposeSettlement", [proposed], { deal, label: "Settlement proposed" })}
        >
          {offer ? "Propose a different split" : "Propose a split"}
        </button>
      </div>
    </section>
  );
}
