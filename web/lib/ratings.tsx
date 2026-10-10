"use client";

import { useEffect, useState } from "react";
import type { Address } from "./contracts";
import { fetchProfile } from "./solana";
import { useWallet } from "./wallet";

export type RatingSummary = { count: number; avg: number; volume: bigint };

/** Średnia ocen z konta profilu on-chain (nie z bazy aplikacji — tej nie da się podkręcić). */
export function useRating(address?: Address) {
  const w = useWallet();
  const [rating, setRating] = useState<RatingSummary>();

  useEffect(() => {
    if (!w.deployment || !w.program || !address) return setRating(undefined);
    fetchProfile(w.program, w.deployment, address)
      .then((p) => setRating({ count: p.ratingCount, avg: p.ratingCount ? p.starsSum / p.ratingCount : 0, volume: p.volume }))
      .catch(() => setRating(undefined));
  }, [w.deployment, w.program, w.refreshKey, address]);

  return rating;
}

export function Stars({ value, size = "1em" }: { value: number; size?: string }) {
  const full = Math.round(value);
  return (
    <span className="stars" style={{ fontSize: size }} aria-label={`${value.toFixed(1)} out of 5 stars`}>
      {"★".repeat(full)}
      <span className="stars-off">{"★".repeat(5 - full)}</span>
    </span>
  );
}
