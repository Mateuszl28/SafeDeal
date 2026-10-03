"use client";

import { useEffect, useState } from "react";

/**
 * Link „Blink” (Solana Actions): wklejony w post na X, w czat albo otwarty w portfelu pokazuje kartę oferty
 * z przyciskiem zakupu — kupujący płaci jednym podpisem, bez wchodzenia na stronę i bez własnego SOL.
 */
export function BlinkShare({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  const [origin, setOrigin] = useState<string>();
  useEffect(() => setOrigin(window.location.origin), []);
  if (!origin) return null;
  const action = `solana-action:${origin}/api/actions/deal/${id}`;
  const isLocal = /localhost|127\.0\.0\.1/.test(origin);
  const dial = `https://dial.to/?action=${encodeURIComponent(action)}&cluster=devnet`;
  return (
    <div className="blink-share">
      <button
        className="btn ghost sm"
        onClick={() => {
          navigator.clipboard.writeText(isLocal ? action : dial);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        title="Solana Action — karta zakupu do wklejenia w post lub czat"
      >
        {copied ? "Skopiowano ✓" : "Kopiuj link Blink ⚡"}
      </button>
      {!isLocal && (
        <a className="plink small" href={dial} target="_blank" rel="noreferrer">
          podgląd karty ↗
        </a>
      )}
    </div>
  );
}
