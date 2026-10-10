"use client";

import { useEffect, useState } from "react";
import type { Deal } from "@/lib/contracts";
import { useWallet } from "@/lib/wallet";

type ActionCard = { icon: string; title: string; description: string; label: string; disabled?: boolean; error?: { message: string } };

/**
 * Link „Blink” (Solana Actions): wklejony w post na X, w czat albo otwarty w portfelu pokazuje kartę oferty
 * z przyciskiem zakupu — kupujący płaci jednym podpisem, bez wchodzenia na stronę i bez własnego SOL.
 * „Podgląd karty” renderuje ją tak, jak zrobi to klient Blinks — z tego samego endpointu Solana Actions.
 */
export function BlinkShare({ id, deal }: { id: string; deal: Deal }) {
  const w = useWallet();
  const [copied, setCopied] = useState(false);
  const [origin, setOrigin] = useState<string>();
  const [card, setCard] = useState<ActionCard | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => setOrigin(window.location.origin), []);
  if (!origin) return null;
  const endpoint = `${origin}/api/actions/deal/${id}`;
  const action = `solana-action:${endpoint}`;
  const isLocal = /localhost|127\.0\.0\.1/.test(origin);
  const dial = `https://dial.to/?action=${encodeURIComponent(action)}&cluster=devnet`;

  async function preview() {
    setOpen(true);
    setCard(null);
    try {
      setCard((await (await fetch(endpoint)).json()) as ActionCard);
    } catch {
      setCard({ icon: "", title: "Couldn't load the card", description: "", label: "", disabled: true });
    }
  }

  return (
    <div className="blink-share">
      <button
        className="btn ghost sm"
        onClick={() => {
          navigator.clipboard.writeText(isLocal ? action : dial);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        title="Solana Action — a purchase card to paste into a post or chat"
      >
        {copied ? "Copied ✓" : "Copy Blink link ⚡"}
      </button>
      <button className="btn ghost sm" onClick={preview}>
        Preview card
      </button>

      {open && (
        <div className="blink-modal" role="dialog" aria-label="Blink card preview" onClick={() => setOpen(false)}>
          <div className="blink-frame" onClick={(e) => e.stopPropagation()}>
            <p className="muted small">This is how the offer looks when pasted into a post on X or a chat (Solana Actions):</p>
            {!card ? (
              <p className="muted">Loading the card from the Solana Actions endpoint…</p>
            ) : (
              <div className="blink-card">
                {card.icon && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={card.icon} alt="" />
                )}
                <div className="blink-body">
                  <span className="blink-host">{new URL(origin).host} · Solana devnet</span>
                  <b>{card.title}</b>
                  <p>{card.description}</p>
                  {card.error && <p className="err-text">{card.error.message}</p>}
                  <button
                    className="btn"
                    disabled={card.disabled || !!w.busy}
                    onClick={async () => {
                      if (await w.buySponsored(deal, "Bought via Blink")) setOpen(false);
                    }}
                  >
                    {card.label || "Buy"}
                  </button>
                </div>
              </div>
            )}
            <p className="muted small">
              Endpoint: <code>{endpoint}</code>
              {!isLocal && (
                <>
                  {" "}
                  ·{" "}
                  <a className="plink" href={dial} target="_blank" rel="noreferrer">
                    open in dial.to ↗
                  </a>
                </>
              )}
            </p>
            <button className="btn ghost sm" onClick={() => setOpen(false)}>
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
