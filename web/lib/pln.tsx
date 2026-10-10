"use client";

import { useEffect, useState } from "react";
import { toUsdc } from "./format";


type Rate = { mid: number; date: string };
let cached: Promise<Rate | null> | null = null;

function loadRate(): Promise<Rate | null> {
  cached ??= fetch("/api/kurs")
    .then((r) => (r.ok ? (r.json() as Promise<Rate>) : null))
    .catch(() => null);
  return cached;
}

export function useUsdPln() {
  const [rate, setRate] = useState<Rate | null>(null);
  useEffect(() => {
    loadRate().then(setRate);
  }, []);
  return rate;
}

/** „≈ 972 zł” przy kwocie w USDC — po kursie średnim NBP. Bez kursu nic nie pokazuje. */
export function Pln({ usdc, prefix = "≈ " }: { usdc: bigint; prefix?: string }) {
  const rate = useUsdPln();
  if (!rate) return null;
  const zl = toUsdc(usdc) * rate.mid;
  return (
    <span className="pln" title={`NBP average rate: 1 USD = ${rate.mid.toFixed(4)} PLN (${rate.date}). 1 USDC ≈ 1 USD.`}>
      {prefix}
      {zl.toLocaleString("en-GB", { maximumFractionDigits: 0 })} PLN
    </span>
  );
}
