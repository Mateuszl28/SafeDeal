"use client";

import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { State, isZeroHash, type Deal } from "@/lib/contracts";
import { generateCode, normalizeCode, pickupStorageKey } from "@/lib/pickup";
import { codeBytes, pickupHash } from "@/lib/solana";
import { fmtUsdc, sameAddr } from "@/lib/format";
import { PERSONAS, useWallet } from "@/lib/wallet";

function readCode(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Odbiór osobisty: kupujący dostaje tajny kod (w kontrakcie tylko jego hash), pokazuje go po obejrzeniu
 * przedmiotu, a sprzedawca podaje go programowi — wypłata natychmiast, bez wysyłki i bez oracle'i.
 */
export function PickupPanel({ id, deal, canBuy }: { id: bigint; deal: Deal; canBuy: boolean }) {
  const w = useWallet();
  const s = deal.state as State;
  const allowed = deal.pickupAllowed;
  const hash = deal.pickupHash;
  const isPickup = !isZeroHash(hash);
  const key = w.deployment ? pickupStorageKey(w.deployment.programId, id) : "";
  const isBuyer = sameAddr(w.address, deal.buyer);
  const isSeller = sameAddr(w.address, deal.seller);

  const [code, setCode] = useState<string | null>(null);
  const [qr, setQr] = useState<string>();
  const [typed, setTyped] = useState("");
  const [valid, setValid] = useState(false);

  // sprzedawca: kod sprawdzamy lokalnie tym samym hashem, który policzy program
  const normalized = normalizeCode(typed);
  const complete = normalized.replace(/-/g, "").length === 16;
  useEffect(() => {
    if (!complete) return setValid(false);
    let alive = true;
    pickupHash(id, normalized)
      .then((h) => alive && setValid(h.toLowerCase() === hash.toLowerCase()))
      .catch(() => alive && setValid(false));
    return () => {
      alive = false;
    };
  }, [complete, normalized, id, hash]);

  useEffect(() => {
    if (key && isBuyer) setCode(readCode(key));
  }, [key, isBuyer, w.refreshKey]);

  // „skan” kodu: link z ?kod= wypełnia pole sprzedawcy
  useEffect(() => {
    const fromLink = new URLSearchParams(window.location.search).get("kod");
    if (fromLink) setTyped(normalizeCode(fromLink));
  }, []);

  useEffect(() => {
    if (!code) return setQr(undefined);
    const link = `${window.location.origin}/deal/${id}?kod=${code}`;
    QRCode.toDataURL(link, { margin: 1, width: 240, color: { dark: "#13201B", light: "#FFFFFF" } })
      .then(setQr)
      .catch(() => setQr(undefined));
  }, [code, id]);

  // 1) przed zakupem: kupujący wybiera odbiór osobisty
  if (s === State.Created && allowed && canBuy) {
    return (
      <section className="card wide pickup">
        <h2>Odbiór osobisty</h2>
        <p className="muted small">
          Płacisz do sejfu programu i dostajesz tajny kod. Na spotkaniu oglądasz przedmiot i dopiero wtedy pokazujesz kod — sprzedawca
          wpisuje go i dostaje pieniądze. Jeśli do spotkania nie dojdzie, pieniądze wrócą do Ciebie po terminie.
        </p>
        <button
          className="btn"
          disabled={!!w.busy}
          onClick={async () => {
            const fresh = generateCode();
            try {
              localStorage.setItem(key, fresh);
            } catch {
              /* bez storage kod zniknie po odświeżeniu — kupujący zobaczy go jeszcze teraz */
            }
            setCode(fresh);
            await w.write("fund", [await pickupHash(id, normalizeCode(fresh))], { deal, label: "Wpłacono z odbiorem osobistym" });
          }}
        >
          Kup z odbiorem osobistym — zablokuj {fmtUsdc(deal.amount)}
        </button>
      </section>
    );
  }

  if (!isPickup || s !== State.Funded) return null;

  // 2) kupujący: kod do pokazania na spotkaniu
  if (isBuyer) {
    const seller = PERSONAS.find((p) => sameAddr(p.address, deal.seller));
    return (
      <section className="card wide pickup">
        <h2>Twój kod odbioru</h2>
        <p className="warn-text">Pokaż go dopiero, gdy obejrzysz przedmiot. Kod = zgoda na wypłatę dla sprzedawcy.</p>
        {code ? (
          <div className="pickup-code">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {qr && <img src={qr} alt="Kod QR do zeskanowania przez sprzedawcę" width={180} height={180} />}
            <div>
              <p className="mono code-text">{code}</p>
              <p className="muted small">Sprzedawca skanuje QR albo przepisuje kod. W blockchainie jest tylko jego odcisk (hash).</p>
              {w.mode === "demo" && seller && (
                <button
                  className="btn ghost sm"
                  onClick={() => {
                    w.setPersona(seller);
                    window.history.replaceState(null, "", `/deal/${id}?kod=${code}`);
                    setTyped(code);
                  }}
                >
                  Demo: zeskanuj kod jako {seller.name}
                </button>
              )}
            </div>
          </div>
        ) : (
          <p className="err-text">Kod jest zapisany tylko w przeglądarce, w której kupowałeś — otwórz transakcję tam.</p>
        )}
      </section>
    );
  }

  // 3) sprzedawca: wpisuje/skanuje kod i od razu widzi, czy jest prawidłowy
  if (isSeller) {
    return (
      <section className="card wide pickup">
        <h2>Odbiór osobisty — kod od kupującego</h2>
        <p className="muted small">Kupujący pokaże kod po obejrzeniu przedmiotu. Wydaj przedmiot dopiero, gdy kod jest prawidłowy.</p>
        <div className="inline">
          <input
            className="mono"
            value={typed}
            onChange={(e) => setTyped(normalizeCode(e.target.value))}
            placeholder="XXXX-XXXX-XXXX-XXXX"
            aria-label="Kod odbioru"
          />
          <button
            className="btn"
            disabled={!valid || !!w.busy}
            onClick={async () => w.write("confirmPickup", [await codeBytes(normalized)], { deal, label: "Potwierdzono odbiór osobisty" })}
          >
            Wydaję przedmiot — odbierz {fmtUsdc(deal.amount)}
          </button>
        </div>
        {complete && (
          <p className={valid ? "ok-text" : "err-text"}>
            {valid ? "✓ Kod prawidłowy — możesz wydać przedmiot." : "✗ Kod nieprawidłowy — nie wydawaj przedmiotu."}
          </p>
        )}
      </section>
    );
  }

  return null;
}
