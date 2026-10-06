"use client";

import { useEffect, useState } from "react";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { State, isFinal, type Deal } from "@/lib/contracts";
import { fmtDuration } from "@/lib/format";
import { pdas } from "@/lib/solana";
import { nameOf, useWallet } from "@/lib/wallet";

/**
 * Porządki po rozliczeniu: konto transakcji i sejf zajmują miejsce w sieci, za które sprzedawca zapłacił
 * kaucję za przechowywanie (rent). Po zamknięciu wraca ona do niego — adres odbiorcy jest przypięty w programie,
 * więc zamknąć może każdy. Opis transakcji zostaje w historii łańcucha.
 */
export function CloseDealPanel({ deal }: { deal: Deal }) {
  const w = useWallet();
  const [rent, setRent] = useState<number>();
  const s = deal.state as State;
  const pda = new PublicKey(deal.pda);
  const vault = w.deployment ? pdas(w.deployment.programId).vault(pda) : undefined;

  useEffect(() => {
    if (!vault || deal.archived) return;
    w.connection
      .getMultipleAccountsInfo([pda, vault], "confirmed")
      .then((infos) => setRent(infos.reduce((sum, i) => sum + (i?.lamports ?? 0), 0)))
      .catch(() => setRent(undefined));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deal.pda, deal.archived, w.connection, w.refreshKey]);

  if (!w.deployment || !isFinal(s)) return null;

  if (deal.archived) {
    return (
      <section className="card wide archived">
        <h2>Konta zamknięte</h2>
        <p className="muted">
          Transakcja jest rozliczona, a jej konta w sieci zamknięto — kaucja za przechowywanie (rent) wróciła do sprzedawcy. Opis, strony
          i wynik pochodzą ze zdarzenia zapisanego w historii łańcucha przy zamknięciu; nikt nie może ich zmienić.
        </p>
      </section>
    );
  }

  const reviewsDone = s === State.Cancelled || (deal.reviewedByBuyer && deal.reviewedBySeller);
  const openAt = deal.closedAt + BigInt(w.deployment.windows.archive ?? 0);
  const allowed = reviewsDone || w.now > openAt;
  const toSettle = deal.panelDrawn ? deal.panel.filter((_, i) => !((deal.panelSettled >> i) & 1)).length : 0;
  const seller = nameOf(deal.seller) ?? "sprzedawcy";

  return (
    <section className="card wide">
      <h2>Porządki po transakcji</h2>
      <p className="muted">
        Konto transakcji i sejf zajmują miejsce w sieci — sprzedawca zapłacił za nie kaucję za przechowywanie
        {rent !== undefined && <> ({(rent / LAMPORTS_PER_SOL).toLocaleString("pl-PL", { maximumFractionDigits: 4 })} SOL)</>}. Po zamknięciu
        wraca ona do {seller}. Zamknąć może każdy — program sam wysyła rent na adres sprzedawcy.
        {toSettle > 0 && <> Przy okazji program rozliczy {toSettle} arbitrów ze składu: nagrody z kaucji przegranego, kary za brak głosu.</>}
      </p>
      {allowed ? (
        <button className="btn ghost" disabled={!!w.busy || !w.address} onClick={() => w.write("closeDeal", [], { deal, label: "Zamknięto konta transakcji" })}>
          Zamknij konta i zwróć rent sprzedawcy
        </button>
      ) : (
        <p className="small">
          Najpierw czas na opinie: zamknięcie będzie możliwe po wystawieniu obu opinii albo za <b>{fmtDuration(openAt - w.now)}</b>.
        </p>
      )}
    </section>
  );
}
