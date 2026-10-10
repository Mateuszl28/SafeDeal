"use client";

import { useEffect, useState } from "react";
import { State } from "@/lib/contracts";
import { fmtUsdc, sameAddr } from "@/lib/format";
import { useWallet } from "@/lib/wallet";
import { useAllDeals } from "@/components/DealList";

function Snippet({ label, code }: { label: string; code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="snippet">
      <div className="snippet-head">
        <b>{label}</b>
        <button
          className="btn ghost sm"
          onClick={() => {
            navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? "Copied ✓" : "Copy"}
        </button>
      </div>
      <pre className="mono">{code}</pre>
    </div>
  );
}

/**
 * „Kup przez SafeDeal” dla serwisów z ogłoszeniami i sprzedawców: karta oferty do osadzenia, link,
 * Blink oraz przycisk „Sprzedaj przez SafeDeal”, który wypełnia formularz oferty danymi z ogłoszenia.
 */
export default function PluginPage() {
  const w = useWallet();
  const deals = useAllDeals();
  const [origin, setOrigin] = useState("https://safedeal.example");
  const [id, setId] = useState("");
  const [theme, setTheme] = useState<"auto" | "light" | "dark">("auto");

  useEffect(() => setOrigin(window.location.origin), []);

  const open = deals.filter((d) => d.state === State.Created);
  const mine = open.filter((d) => sameAddr(d.seller, w.address));
  const choices = mine.length ? mine : open;
  useEffect(() => {
    if (!id && choices[0]) setId(String(choices[0].id));
  }, [id, choices]);

  const themeAttr = theme === "auto" ? "" : ` data-theme="${theme}"`;
  const themeQuery = theme === "auto" ? "" : `?theme=${theme}`;
  const valid = /^\d{1,18}$/.test(id);

  return (
    <div className="grid">
      <section className="hero">
        <h1>Plugin: “Buy with SafeDeal” in any listing</h1>
        <p>
          SafeDeal works beyond our site: a seller pastes an offer card into a listing on any marketplace, and a classifieds site
          can add it with one line of code. The buyer sees the guarantees and buys with a single signature — the money goes to the program's vault, not
          to the marketplace and not to us.
        </p>
      </section>

      <section className="card">
        <h2>Which offer?</h2>
        <label>
          Offer number
          <input value={id} onChange={(e) => setId(e.target.value.trim())} inputMode="numeric" placeholder="e.g. 12" />
        </label>
        {choices.length > 0 && (
          <div className="chips">
            {choices.slice(0, 8).map((d) => (
              <button key={String(d.id)} className={`btn ghost sm ${String(d.id) === id ? "on" : ""}`} onClick={() => setId(String(d.id))}>
                #{String(d.id)} {d.title.slice(0, 24)} · {fmtUsdc(d.amount)}
              </button>
            ))}
          </div>
        )}
        <label>
          Card theme
          <select value={theme} onChange={(e) => setTheme(e.target.value as typeof theme)}>
            <option value="auto">match the visitor's system</option>
            <option value="light">light</option>
            <option value="dark">dark</option>
          </select>
        </label>
        <p className="muted small">
          The card is plain HTML from our server, read straight from the blockchain — it works without JavaScript and has no access to the visitor's
          wallet or data.
        </p>
      </section>

      <section className="card">
        <h2>Preview</h2>
        {valid ? (
          <iframe
            key={`${id}-${theme}`}
            src={`/widget/deal/${id}${themeQuery}`}
            title="SafeDeal card preview"
            style={{ border: 0, width: "100%", maxWidth: 420, height: 360, background: "transparent" }}
          />
        ) : (
          <p className="muted">Enter an offer number.</p>
        )}
      </section>

      {valid && (
        <section className="card wide">
          <h2>Code to paste</h2>
          <Snippet
            label="Classifieds site — script (once per page) + card placeholder"
            code={`<script src="${origin}/widget.js" async></script>\n<div data-safedeal-deal="${id}"${themeAttr}></div>`}
          />
          <Snippet
            label="No script — iframe"
            code={`<iframe src="${origin}/widget/deal/${id}${themeQuery}" title="SafeDeal — safe purchase" style="border:0;width:100%;max-width:420px;height:300px"></iframe>`}
          />
          <Snippet label="Seller — link to paste into a listing or a chat" code={`${origin}/deal/${id}`} />
          <Snippet
            label="Blink (Solana Actions) — buy straight from a post on X or from a wallet"
            code={`https://dial.to/?action=solana-action:${encodeURIComponent(`${origin}/api/actions/deal/${id}`)}&cluster=devnet`}
          />
        </section>
      )}

      <section className="card wide">
        <h2>For marketplaces: a “Sell with SafeDeal” button</h2>
        <p className="muted">
          The marketplace adds the button next to a listing and fills its attributes with the listing data. Clicking it opens SafeDeal with a prefilled offer
          form (title, price in USDC, description, link to the listing) — the seller checks the details and creates the offer with one signature, no SOL needed.
        </p>
        <Snippet
          label="Button"
          code={`<script src="${origin}/widget.js" async></script>\n<a data-safedeal-sell\n   data-title="Kross Esker gravel bike"\n   data-price="250"\n   data-description="54 cm frame, approx. 800 km ridden"\n   data-url="https://your-marketplace.com/listing/123"></a>`}
        />
        <p className="small">
          <a className="plink" href={`/?tytul=${encodeURIComponent("Kross Esker gravel bike")}&cena=250&opis=${encodeURIComponent("54 cm frame, approx. 800 km ridden")}&zrodlo=${encodeURIComponent("https://your-marketplace.com/listing/123")}#nowa-oferta`}>
            See how it works →
          </a>
        </p>
      </section>
    </div>
  );
}
