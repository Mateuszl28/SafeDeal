"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { fmtUsdc, short } from "@/lib/format";
import { explorerAddr, explorerTx, tokenBalance } from "@/lib/solana";
import { PERSONAS, useWallet } from "@/lib/wallet";
import { NotificationBell, useNotifications } from "./Notifications";

export function Header() {
  const w = useWallet();
  const n = useNotifications();
  const [balance, setBalance] = useState<bigint>();
  const cluster = w.deployment?.cluster ?? "devnet";

  useEffect(() => {
    if (!w.deployment || !w.address) return setBalance(undefined);
    tokenBalance(w.connection, w.deployment, w.address)
      .then(setBalance)
      .catch(() => setBalance(undefined));
  }, [w.deployment, w.address, w.connection, w.refreshKey]);

  return (
    <header className="header">
      <div className="header-row">
        <div className="nav">
          <Link href="/" className="brand">
            <span className="brand-mark">◆</span> SafeDeal
          </Link>
          <Link href="/">Oferty</Link>
          <Link href="/arbitrzy">Arbitrzy</Link>
          <Link href="/wtyczka">Wtyczka</Link>
          <Link href="/stats">Statystyki</Link>
          <Link href="/jury">Dla jury</Link>
          {w.address && <Link href={`/u/${w.address}`}>Mój profil</Link>}
        </div>
        <div className="seg">
          <button className={w.mode === "demo" ? "on" : ""} onClick={() => w.setMode("demo")} disabled={PERSONAS.length === 0}>
            Demo (persony)
          </button>
          <button className={w.mode === "wallet" ? "on" : ""} onClick={() => w.setMode("wallet")}>
            Portfel · Solana {cluster}
          </button>
        </div>
      </div>

      <div className="header-row">
        {w.mode === "demo" ? (
          <div className="personas">
            <span className="muted">Jesteś:</span>
            {PERSONAS.map((p) => (
              <button
                key={p.address}
                className={`chip ${w.persona?.address === p.address ? "on" : ""}`}
                onClick={() => w.setPersona(p)}
                title={p.address}
              >
                {p.name} <small>{p.role}</small>
                {n.unread(p.address) > 0 && <span className="count">{n.unread(p.address)}</span>}
              </button>
            ))}
          </div>
        ) : w.address ? (
          <div className="balance">
            <a className="mono plink" href={explorerAddr(w.address, cluster)} target="_blank" rel="noreferrer" title={w.address}>
              {short(w.address)} ↗
            </a>
            <button className="btn ghost sm" onClick={() => w.disconnect()}>
              Rozłącz
            </button>
          </div>
        ) : (
          <button className="btn" onClick={() => w.connect()}>
            Połącz portfel
          </button>
        )}

        {w.deployment && w.address && (
          <div className="balance">
            <NotificationBell />
            <span className="mono" title="Testowe USDC (devnet)">
              {balance === undefined ? "…" : fmtUsdc(balance)}
            </span>
            <span className="mono muted" title="SOL na opłaty sieci">
              {w.solBalance === undefined ? "…" : `${w.solBalance.toLocaleString("pl-PL", { maximumFractionDigits: 3 })} SOL`}
            </span>
            <button className="btn ghost sm" onClick={() => w.faucet()} disabled={!!w.busy}>
              + 1000 USDC z kranu
            </button>
            <button className="btn ghost sm" onClick={() => w.airdrop()} disabled={!!w.busy}>
              + SOL
            </button>
          </div>
        )}
      </div>

      {w.mode === "wallet" && w.address && w.solBalance !== undefined && w.solBalance < 0.01 && (
        <div className="notice onboard">
          <span>
            <b>Nowy portfel?</b> Każda operacja kosztuje ułamek grosza opłaty sieci (testowy SOL). Przygotujemy go za Ciebie:
            sponsor wyśle odrobinę testowego SOL, a kran programu — 1000 testowych USDC. Sponsor płaci tylko opłaty i nie ma
            żadnego dostępu do pieniędzy w sejfach.
          </span>
          <button className="btn" onClick={() => w.prepareWallet()} disabled={!!w.busy}>
            Przygotuj portfel do testu
          </button>
        </div>
      )}

      {!w.deployment && (
        <div className="notice">
          Brak wdrożonego programu SafeDeal dla sieci Solana. Uruchom konfigurację devnetu: <code>cd solana &amp;&amp; npm run setup:devnet</code>
          , potem odśwież stronę.
        </div>
      )}
      {w.busy && (
        <div className="toast" role="status" aria-live="polite">
          ⏳ {w.busy}…
        </div>
      )}
      {!w.busy && w.error && (
        <div className="toast err" role="alert" onClick={w.clearError}>
          {w.error} <small>(kliknij, aby zamknąć)</small>
        </div>
      )}
      {!w.busy && !w.error && w.lastTx && (
        <div className="toast ok" role="status" aria-live="polite">
          <span>
            ✓ {w.lastTx.label} —{" "}
            <a href={explorerTx(w.lastTx.signature, cluster)} target="_blank" rel="noreferrer">
              zobacz w Solana Explorer ↗
            </a>
          </span>
          <button className="toast-x" onClick={w.clearLastTx} aria-label="Zamknij">
            ×
          </button>
        </div>
      )}
    </header>
  );
}
