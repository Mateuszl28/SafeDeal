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
          <Link href="/">Offers</Link>
          <Link href="/arbitrzy">Arbiters</Link>
          <Link href="/wtyczka">Widget</Link>
          <Link href="/stats">Stats</Link>
          <Link href="/jury">For the jury</Link>
          {w.address && <Link href={`/u/${w.address}`}>My profile</Link>}
        </div>
        <div className="seg">
          <button className={w.mode === "demo" ? "on" : ""} onClick={() => w.setMode("demo")} disabled={PERSONAS.length === 0}>
            Demo (personas)
          </button>
          <button className={w.mode === "wallet" ? "on" : ""} onClick={() => w.setMode("wallet")}>
            Wallet · Solana {cluster}
          </button>
        </div>
      </div>

      <div className="header-row">
        {w.mode === "demo" ? (
          <div className="personas">
            <span className="muted">You are:</span>
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
              Disconnect
            </button>
          </div>
        ) : (
          <button className="btn" onClick={() => w.connect()}>
            Connect wallet
          </button>
        )}

        {w.deployment && w.address && (
          <div className="balance">
            <NotificationBell />
            <span className="mono" title="Test USDC (devnet)">
              {balance === undefined ? "…" : fmtUsdc(balance)}
            </span>
            <span className="mono muted" title="SOL for network fees">
              {w.solBalance === undefined ? "…" : `${w.solBalance.toLocaleString("en-GB", { maximumFractionDigits: 3 })} SOL`}
            </span>
            <button className="btn ghost sm" onClick={() => w.faucet()} disabled={!!w.busy}>
              + 1000 USDC from faucet
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
            <b>New wallet?</b> Every operation costs a fraction of a cent in network fees (test SOL). We'll set it up for you:
            a sponsor sends a little test SOL and the program faucet sends 1000 test USDC. The sponsor only pays fees and has
            no access to the money in the vaults.
          </span>
          <button className="btn" onClick={() => w.prepareWallet()} disabled={!!w.busy}>
            Prepare wallet for testing
          </button>
        </div>
      )}

      {!w.deployment && (
        <div className="notice">
          No SafeDeal program deployed for this Solana network. Run the devnet setup: <code>cd solana &amp;&amp; npm run setup:devnet</code>
          , then refresh the page.
        </div>
      )}
      {w.busy && (
        <div className="toast" role="status" aria-live="polite">
          ⏳ {w.busy}…
        </div>
      )}
      {!w.busy && w.error && (
        <div className="toast err" role="alert" onClick={w.clearError}>
          {w.error} <small>(click to dismiss)</small>
        </div>
      )}
      {!w.busy && !w.error && w.lastTx && (
        <div className="toast ok" role="status" aria-live="polite">
          <span>
            ✓ {w.lastTx.label} —{" "}
            <a href={explorerTx(w.lastTx.signature, cluster)} target="_blank" rel="noreferrer">
              view in Solana Explorer ↗
            </a>
          </span>
          <button className="toast-x" onClick={w.clearLastTx} aria-label="Close">
            ×
          </button>
        </div>
      )}
    </header>
  );
}
