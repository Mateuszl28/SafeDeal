"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { describeEvent, useDealLogs } from "@/components/DealActivity";
import { STATE_LABEL, isFinal, isZero, isZeroHash, type Deal, type State } from "@/lib/contracts";
import { fmtUsdc } from "@/lib/format";
import { visibleDescription } from "@/lib/project";
import { explorerAddr, explorerTx, fetchDeal } from "@/lib/solana";
import { nameOf, useWallet } from "@/lib/wallet";

/** Potwierdzenie transakcji do druku / PDF — same fakty z łańcucha, z hashami do samodzielnej weryfikacji. */
export default function ReceiptPage() {
  const { id: idParam } = useParams<{ id: string }>();
  const id = BigInt(idParam);
  const w = useWallet();
  const [deal, setDeal] = useState<Deal | null>();
  const entries = useDealLogs(deal);

  useEffect(() => {
    if (!w.deployment || !w.program) return;
    fetchDeal(w.program, w.deployment, id)
      .then(setDeal)
      .catch(() => setDeal((prev) => prev ?? null));
  }, [w.deployment, w.program, w.refreshKey, id]);

  if (!w.deployment) return null;
  if (deal === undefined) return <p className="muted">Loading…</p>;
  if (!deal || deal.state === 0) return <p>Deal #{idParam} does not exist.</p>;

  const s = deal.state as State;
  const party = (label: string, addr: string) => (
    <tr>
      <th>{label}</th>
      <td>
        {isZero(addr) ? "—" : nameOf(addr) ?? ""} <span className="mono">{isZero(addr) ? "" : addr}</span>
      </td>
    </tr>
  );

  return (
    <article className="receipt">
      <div className="receipt-actions no-print">
        <Link href={`/deal/${idParam}`} className="btn ghost sm">
          ← Back to the deal
        </Link>
        <button className="btn sm" onClick={() => window.print()}>
          Print / save as PDF
        </button>
      </div>

      <header>
        <p className="muted small">SafeDeal · deal receipt #{idParam}</p>
        <h1>{deal.title}</h1>
        <p className="receipt-amount">{fmtUsdc(deal.amount)}</p>
        <p>
          <b>Status:</b> {STATE_LABEL[s]}
          {!isFinal(s) && " (deal in progress — the receipt shows the state at the time of printing)"}
        </p>
      </header>

      <table className="receipt-table">
        <tbody>
          {party("Seller", deal.seller)}
          {party("Buyer", deal.buyer)}
          {deal.tracking && (
            <tr>
              <th>Parcel</th>
              <td className="mono">{deal.tracking}</td>
            </tr>
          )}
          {deal.description && (
            <tr>
              <th>Offer description</th>
              <td>{visibleDescription(deal.description)}</td>
            </tr>
          )}
          {deal.photoUri && !isZeroHash(deal.photoHash) && (
            <tr>
              <th>Offer photo fingerprint (SHA-256)</th>
              <td className="mono">{deal.photoHash}</td>
            </tr>
          )}
          <tr>
            <th>Deal account</th>
            <td className="mono">
              <a href={explorerAddr(deal.pda, w.deployment.cluster)} target="_blank" rel="noreferrer">
                {deal.pda}
              </a>
            </td>
          </tr>
          <tr>
            <th>Program</th>
            <td className="mono">{w.deployment.programId}</td>
          </tr>
          <tr>
            <th>Network</th>
            <td>Solana {w.deployment.cluster === "devnet" ? "devnet (test network)" : w.deployment.cluster}</td>
          </tr>
        </tbody>
      </table>

      <h2>Timeline (entries in the public ledger)</h2>
      <table className="receipt-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Event</th>
            <th>Transaction</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e, i) => (
            <tr key={`${e.signature}-${i}`}>
              <td className="nowrap">{e.time ? new Date(e.time * 1000).toLocaleString("en-GB") : ""}</td>
              <td>{describeEvent(e, deal)}</td>
              <td className="mono hash">
                <a href={explorerTx(e.signature, w.deployment!.cluster)} target="_blank" rel="noreferrer">
                  {e.signature}
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="muted small">
        Every entry can be verified independently in Solana Explorer by its transaction signature. Document generated{" "}
        {new Date().toLocaleString("en-GB")} from the program's data on the Solana network — SafeDeal keeps no copy it could alter.
      </p>
    </article>
  );
}
