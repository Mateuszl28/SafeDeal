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
        <h2>Accounts closed</h2>
        <p className="muted">
          The deal is settled and its on-chain accounts have been closed — the storage deposit (rent) went back to the seller. The description, parties
          and outcome come from the event recorded in the chain history at closing; nobody can change them.
        </p>
      </section>
    );
  }

  const reviewsDone = s === State.Cancelled || (deal.reviewedByBuyer && deal.reviewedBySeller);
  const openAt = deal.closedAt + BigInt(w.deployment.windows.archive ?? 0);
  const allowed = reviewsDone || w.now > openAt;
  const toSettle = deal.panelDrawn ? deal.panel.filter((_, i) => !((deal.panelSettled >> i) & 1)).length : 0;
  const seller = nameOf(deal.seller) ?? "the seller";

  return (
    <section className="card wide">
      <h2>Deal cleanup</h2>
      <p className="muted">
        The deal account and vault take up space on the network — the seller paid a storage deposit for them
        {rent !== undefined && <> ({(rent / LAMPORTS_PER_SOL).toLocaleString("en-GB", { maximumFractionDigits: 4 })} SOL)</>}. On closing
        it goes back to {seller}. Anyone can close them — the program itself sends the rent to the seller's address.
        {toSettle > 0 && <> The program will also settle {toSettle} arbiters from the panel: rewards from the loser's bond, penalties for not voting.</>}
      </p>
      {allowed ? (
        <button className="btn ghost" disabled={!!w.busy || !w.address} onClick={() => w.write("closeDeal", [], { deal, label: "Deal accounts closed" })}>
          Close accounts and return rent to the seller
        </button>
      ) : (
        <p className="small">
          Reviews come first: closing becomes possible once both reviews are in, or in <b>{fmtDuration(openAt - w.now)}</b>.
        </p>
      )}
    </section>
  );
}
