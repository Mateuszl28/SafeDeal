"use client";

import { useCallback, useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import { CHAT_MAX_LEN, chatPayload, type ChatMessage } from "@/lib/chat";
import { isZero, type Deal } from "@/lib/contracts";
import { sameAddr, short } from "@/lib/format";
import { nameOf, useWallet } from "@/lib/wallet";

type Checked = ChatMessage & { valid: boolean };

/** Podpis ed25519 (hex) treści `payload` kluczem `from` — to samo sprawdza serwer przy zapisie. */
function verifySignature(payload: string, signatureHex: string, from: string): boolean {
  try {
    const sig = Buffer.from(signatureHex.replace(/^0x/, ""), "hex");
    if (sig.length !== 64) return false;
    return nacl.sign.detached.verify(new TextEncoder().encode(payload), new Uint8Array(sig), new PublicKey(from).toBytes());
  } catch {
    return false;
  }
}

const TEMPLATES = ["Proszę o wysyłkę do paczkomatu: [kod paczkomatu]", "Paczka nadana, numer jest w transakcji.", "Dotarło, sprawdzam zawartość."];

/**
 * Rozmowa stron. Każda wiadomość jest podpisana kluczem nadawcy i sprawdzana tutaj, w przeglądarce —
 * nie trzeba ufać serwerowi, że nikt nie podszył się pod drugą stronę.
 */
export function ChatPanel({ id, deal, isArbiter }: { id: string; deal: Deal; isArbiter: boolean }) {
  const w = useWallet();
  const [messages, setMessages] = useState<Checked[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string>();

  const isParty = sameAddr(w.address, deal.seller) || sameAddr(w.address, deal.buyer);
  const hasBuyer = !isZero(deal.buyer);
  const programId = w.deployment?.programId ?? "";
  const cluster = w.deployment?.cluster ?? "devnet";
  const url = `/api/chat/${id}?cluster=${cluster}`;

  const verifyAll = useCallback(
    async (list: ChatMessage[]): Promise<Checked[]> =>
      Promise.all(
        list.map(async (m) => ({
          ...m,
          valid:
            (sameAddr(m.from, deal.seller) || sameAddr(m.from, deal.buyer)) &&
            verifySignature(chatPayload(cluster, programId, id, m.ts, m.text), m.signature, m.from),
        })),
      ),
    [cluster, programId, id, deal.seller, deal.buyer],
  );

  useEffect(() => {
    if (!programId || !hasBuyer) return;
    fetch(url, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : []))
      .then(verifyAll)
      .then(setMessages)
      .catch(() => {});
  }, [url, programId, hasBuyer, verifyAll, w.refreshKey]);

  if (!hasBuyer || (!isParty && !isArbiter)) return null;

  async function send() {
    const body = text.trim();
    if (!body || !w.address) return;
    setSending(true);
    setErr(undefined);
    try {
      const ts = Date.now();
      const signature = await w.signMessage(chatPayload(cluster, programId, id, ts, body));
      if (!signature) return;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: w.address, text: body, ts, signature }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      setMessages(await verifyAll(json));
      setText("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="card wide chat">
      <h2>Rozmowa</h2>
      <p className="muted small">
        Każda wiadomość jest podpisana kluczem nadawcy (bez opłat, to nie jest transakcja) i sprawdzana w Twojej przeglądarce.
        {isArbiter && !isParty && " Jako arbiter widzisz rozmowę jako materiał w sporze."}
      </p>

      {messages.length === 0 ? (
        <p className="muted">Brak wiadomości. Ustalcie np. paczkomat odbioru.</p>
      ) : (
        <ul className="messages">
          {messages.map((m) => {
            const mine = sameAddr(m.from, w.address);
            return (
              <li key={m.signature} className={mine ? "mine" : ""}>
                <div className="bubble">
                  <span className="who">
                    {nameOf(m.from) ?? short(m.from)} · {new Date(m.ts).toLocaleString("pl-PL")}
                  </span>
                  <p>{m.text}</p>
                  <span className={`sig ${m.valid ? "ok" : "bad"}`}>
                    {m.valid ? "✓ podpis zweryfikowany" : "✗ podpis nieprawidłowy — wiadomość mogła zostać podrobiona"}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {isParty && (
        <>
          <div className="templates">
            {TEMPLATES.map((t) => (
              <button key={t} className="chip" onClick={() => setText(t)}>
                {t.length > 34 ? `${t.slice(0, 32)}…` : t}
              </button>
            ))}
          </div>
          <div className="inline">
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && send()}
              placeholder="Napisz wiadomość…"
              maxLength={CHAT_MAX_LEN}
            />
            <button className="btn" disabled={sending || !text.trim()} onClick={send}>
              {sending ? "Podpisuję…" : "Podpisz i wyślij"}
            </button>
          </div>
          {err && <p className="err-text">{err}</p>}
        </>
      )}
    </section>
  );
}
