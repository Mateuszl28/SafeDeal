"use client";

import { State, type Deal } from "@/lib/contracts";
import { CHECK_LABEL, useHashCheck } from "@/lib/files";
import { parseStage, visibleDescription } from "@/lib/project";

function Photo({ uri, hash }: { uri: string; hash: string }) {
  const { check } = useHashCheck(uri, hash);
  return (
    <div>
      <a href={uri} target="_blank" rel="noreferrer">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={uri} alt="Photo of the item from the offer" />
      </a>
      <span className={`verify ${check}`}>{CHECK_LABEL[check]}</span>
    </div>
  );
}

/** Opis i zdjęcie oferty — to, co kupujący widział przy zakupie. Po wpłacie program nie pozwala ich zmienić. */
export function ListingCard({ deal }: { id?: bigint; deal: Deal }) {
  if (!deal.description && !deal.photoUri) return null;
  const frozen = deal.state !== State.Created;

  return (
    <section className="card wide">
      <div className={deal.photoUri ? "listing" : ""}>
        {deal.photoUri && <Photo uri={deal.photoUri} hash={deal.photoHash} />}
        <div>
          <h2>{parseStage(deal.description) ? "Stage description" : "Seller's description"}</h2>
          {deal.description && <p className="desc">{visibleDescription(deal.description)}</p>}
          <p className="muted small">
            {frozen
              ? "The description and photo fingerprint were stored on the blockchain before payment — proof in case of a “not as described” complaint."
              : "Stored on the blockchain. The description and photo are part of the offer — the seller can't swap them."}
          </p>
        </div>
      </div>
    </section>
  );
}
