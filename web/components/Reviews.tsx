"use client";

import Link from "next/link";
import { useState } from "react";
import type { ChainEvent } from "@/lib/solana";
import { pdas } from "@/lib/solana";
import { State, type Address, type Deal } from "@/lib/contracts";
import { fmtUsdc, plural, sameAddr, short } from "@/lib/format";
import { Stars, useRating } from "@/lib/ratings";
import { nameOf, useWallet } from "@/lib/wallet";
import { evAddr, evBig, useAccountEvents, useDealEvents } from "./DealActivity";

type Review = { id: bigint; author: Address; subject: Address; stars: number; comment: string; signature: string };

const RATEABLE = [State.Released, State.Refunded, State.Split, State.Settled];
const who = (a: Address) => nameOf(a) ?? short(a);

const toReviews = (events: ChainEvent[] | undefined): Review[] =>
  (events ?? [])
    .filter((e) => e.name === "Reviewed")
    .map((e) => ({
      id: evBig(e.data.id),
      author: evAddr(e.data.author),
      subject: evAddr(e.data.subject),
      stars: Number(e.data.stars),
      comment: String(e.data.comment ?? ""),
      signature: e.signature,
    }))
    .reverse();

function ReviewItem({ r, showDeal }: { r: Review; showDeal?: boolean }) {
  return (
    <li className="review">
      <div className="review-head">
        <Stars value={r.stars} />
        <span className="muted small">
          {who(r.author)} o {who(r.subject)}
          {showDeal && (
            <>
              {" · "}
              <Link href={`/deal/${r.id}`} className="plink">
                transakcja #{String(r.id)}
              </Link>
            </>
          )}
        </span>
      </div>
      {r.comment && <p>„{r.comment}”</p>}
    </li>
  );
}

/** Na stronie transakcji: opinie stron i formularz, gdy można już ocenić. */
export function ReviewPanel({ id, deal }: { id: bigint; deal: Deal }) {
  const w = useWallet();
  const reviews = toReviews(useDealEvents(deal)).filter((r) => r.id === id);
  const [stars, setStars] = useState(5);
  const [comment, setComment] = useState("");

  const s = deal.state as State;
  const isParty = sameAddr(w.address, deal.seller) || sameAddr(w.address, deal.buyer);
  const done = sameAddr(w.address, deal.buyer) ? deal.reviewedByBuyer : deal.reviewedBySeller;
  const canReview = RATEABLE.includes(s) && isParty && !done;
  if (!RATEABLE.includes(s) || (!canReview && reviews.length === 0)) return null;

  const other = sameAddr(w.address, deal.buyer) ? deal.seller : deal.buyer;

  return (
    <section className="card wide">
      <h2>Opinie</h2>
      <p className="muted small">
        Opinię może wystawić tylko strona tej transakcji, raz i dopiero po jej zamknięciu. Zapisana w publicznym rejestrze — nie da się
        jej kupić, usunąć ani zmienić.
      </p>
      {reviews.length > 0 && (
        <ul className="reviews">
          {reviews.map((r) => (
            <ReviewItem key={r.author} r={r} />
          ))}
        </ul>
      )}
      {canReview && (
        <div className="review-form">
          <span>
            Twoja ocena dla <b>{who(other)}</b>:
          </span>
          <div className="star-pick" role="radiogroup" aria-label="Ocena">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                role="radio"
                aria-checked={stars === n}
                aria-label={`${n} na 5`}
                className={n <= stars ? "on" : ""}
                onClick={() => setStars(n)}
              >
                ★
              </button>
            ))}
          </div>
          <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Krótki komentarz (opcjonalnie)" maxLength={280} />
          <button className="btn" disabled={!!w.busy} onClick={() => w.write("review", [stars, comment.trim()], { deal, label: "Zapisuję opinię" })}>
            Wystaw opinię
          </button>
        </div>
      )}
    </section>
  );
}

/** W profilu: średnia z konta profilu i lista opinii o danej osobie. */
export function ProfileReviews({ address }: { address: Address }) {
  const w = useWallet();
  const rating = useRating(address);
  // `review` zapisuje się w profilu ocenianej osoby — więc historia tego konta to komplet opinii o niej.
  const profilePda = w.deployment ? pdas(w.deployment.programId).profile(address).toBase58() : undefined;
  const reviews = toReviews(useAccountEvents(profilePda, `${rating?.count ?? ""}`)).filter((r) => sameAddr(r.subject, address));

  return (
    <section className="card wide">
      <h2>Opinie</h2>
      {!rating || rating.count === 0 ? (
        <p className="muted">Brak opinii — żadna zamknięta transakcja nie została jeszcze oceniona.</p>
      ) : (
        <>
          <p className="rating-big">
            <Stars value={rating.avg} size="1.4rem" /> <b>{rating.avg.toFixed(1)}</b>{" "}
            <span className="muted">
              · {plural(rating.count, "opinia", "opinie", "opinii")} z transakcji o łącznej wartości {fmtUsdc(rating.volume)}
            </span>
          </p>
          <ul className="reviews">
            {reviews.map((r) => (
              <ReviewItem key={`${r.id}-${r.author}`} r={r} showDeal />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/** Kompaktowo, np. w karcie „Od kogo kupujesz”. */
export function RatingInline({ address }: { address: Address }) {
  const rating = useRating(address);
  if (!rating || rating.count === 0) return <span className="muted"> · brak opinii</span>;
  return (
    <span>
      {" · "}
      <Stars value={rating.avg} /> {rating.avg.toFixed(1)} ({plural(rating.count, "opinia", "opinie", "opinii")})
    </span>
  );
}
