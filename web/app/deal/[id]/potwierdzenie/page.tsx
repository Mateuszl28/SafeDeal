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
  if (deal === undefined) return <p className="muted">Wczytuję…</p>;
  if (!deal || deal.state === 0) return <p>Nie ma transakcji #{idParam}.</p>;

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
          ← Wróć do transakcji
        </Link>
        <button className="btn sm" onClick={() => window.print()}>
          Drukuj / zapisz jako PDF
        </button>
      </div>

      <header>
        <p className="muted small">SafeDeal · potwierdzenie transakcji #{idParam}</p>
        <h1>{deal.title}</h1>
        <p className="receipt-amount">{fmtUsdc(deal.amount)}</p>
        <p>
          <b>Status:</b> {STATE_LABEL[s]}
          {!isFinal(s) && " (transakcja w toku — potwierdzenie pokazuje stan na chwilę wydruku)"}
        </p>
      </header>

      <table className="receipt-table">
        <tbody>
          {party("Sprzedawca", deal.seller)}
          {party("Kupujący", deal.buyer)}
          {deal.tracking && (
            <tr>
              <th>Przesyłka</th>
              <td className="mono">{deal.tracking}</td>
            </tr>
          )}
          {deal.description && (
            <tr>
              <th>Opis oferty</th>
              <td>{visibleDescription(deal.description)}</td>
            </tr>
          )}
          {deal.photoUri && !isZeroHash(deal.photoHash) && (
            <tr>
              <th>Odcisk (SHA-256) zdjęcia oferty</th>
              <td className="mono">{deal.photoHash}</td>
            </tr>
          )}
          <tr>
            <th>Konto transakcji</th>
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
            <th>Sieć</th>
            <td>Solana {w.deployment.cluster === "devnet" ? "devnet (sieć testowa)" : w.deployment.cluster}</td>
          </tr>
        </tbody>
      </table>

      <h2>Przebieg (wpisy w publicznym rejestrze)</h2>
      <table className="receipt-table">
        <thead>
          <tr>
            <th>Czas</th>
            <th>Zdarzenie</th>
            <th>Transakcja</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e, i) => (
            <tr key={`${e.signature}-${i}`}>
              <td className="nowrap">{e.time ? new Date(e.time * 1000).toLocaleString("pl-PL") : ""}</td>
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
        Każdy wpis można sprawdzić samodzielnie w Solana Explorer po podpisie transakcji. Dokument wygenerowano{" "}
        {new Date().toLocaleString("pl-PL")} z danych programu w sieci Solana — SafeDeal nie przechowuje kopii, którą mógłby zmienić.
      </p>
    </article>
  );
}
