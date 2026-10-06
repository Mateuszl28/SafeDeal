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
          {copied ? "Skopiowano ✓" : "Kopiuj"}
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
        <h1>Wtyczka: „Kup przez SafeDeal” w każdym ogłoszeniu</h1>
        <p>
          SafeDeal działa poza naszą stroną: sprzedawca wkleja kartę oferty w ogłoszenie na dowolnym serwisie, a serwis z ogłoszeniami
          może dodać ją jedną linijką kodu. Kupujący widzi gwarancje i kupuje jednym podpisem — pieniądze trafiają do sejfu programu, nie
          do serwisu i nie do nas.
        </p>
      </section>

      <section className="card">
        <h2>Która oferta?</h2>
        <label>
          Numer oferty
          <input value={id} onChange={(e) => setId(e.target.value.trim())} inputMode="numeric" placeholder="np. 12" />
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
          Motyw karty
          <select value={theme} onChange={(e) => setTheme(e.target.value as typeof theme)}>
            <option value="auto">jak w systemie odwiedzającego</option>
            <option value="light">jasny</option>
            <option value="dark">ciemny</option>
          </select>
        </label>
        <p className="muted small">
          Karta to zwykły HTML z naszego serwera, czytany wprost z blockchaina — działa bez JavaScriptu i nie ma dostępu do portfela ani
          danych odwiedzającego.
        </p>
      </section>

      <section className="card">
        <h2>Podgląd</h2>
        {valid ? (
          <iframe
            key={`${id}-${theme}`}
            src={`/widget/deal/${id}${themeQuery}`}
            title="Podgląd karty SafeDeal"
            style={{ border: 0, width: "100%", maxWidth: 420, height: 360, background: "transparent" }}
          />
        ) : (
          <p className="muted">Podaj numer oferty.</p>
        )}
      </section>

      {valid && (
        <section className="card wide">
          <h2>Kod do wklejenia</h2>
          <Snippet
            label="Serwis z ogłoszeniami — skrypt (raz na stronie) + miejsce na kartę"
            code={`<script src="${origin}/widget.js" async></script>\n<div data-safedeal-deal="${id}"${themeAttr}></div>`}
          />
          <Snippet
            label="Bez skryptu — iframe"
            code={`<iframe src="${origin}/widget/deal/${id}${themeQuery}" title="SafeDeal — bezpieczny zakup" style="border:0;width:100%;max-width:420px;height:300px"></iframe>`}
          />
          <Snippet label="Sprzedawca — link do wklejenia w treść ogłoszenia lub w czat" code={`${origin}/deal/${id}`} />
          <Snippet
            label="Blink (Solana Actions) — zakup prosto z posta na X lub z portfela"
            code={`https://dial.to/?action=solana-action:${encodeURIComponent(`${origin}/api/actions/deal/${id}`)}&cluster=devnet`}
          />
        </section>
      )}

      <section className="card wide">
        <h2>Dla serwisów: przycisk „Sprzedaj przez SafeDeal”</h2>
        <p className="muted">
          Serwis wstawia przycisk przy ogłoszeniu, wypełniając atrybuty danymi ogłoszenia. Kliknięcie otwiera SafeDeal z gotowym formularzem
          oferty (tytuł, cena w USDC, opis, link do ogłoszenia) — sprzedawca sprawdza dane i wystawia ofertę jednym podpisem, bez SOL.
        </p>
        <Snippet
          label="Przycisk"
          code={`<script src="${origin}/widget.js" async></script>\n<a data-safedeal-sell\n   data-title="Rower gravel Kross Esker"\n   data-price="250"\n   data-description="Rama 54 cm, przebieg ok. 800 km"\n   data-url="https://twoj-serwis.pl/ogloszenie/123"></a>`}
        />
        <p className="small">
          <a className="plink" href={`/?tytul=${encodeURIComponent("Rower gravel Kross Esker")}&cena=250&opis=${encodeURIComponent("Rama 54 cm, przebieg ok. 800 km")}&zrodlo=${encodeURIComponent("https://twoj-serwis.pl/ogloszenie/123")}#nowa-oferta`}>
            Zobacz, jak to działa →
          </a>
        </p>
      </section>
    </div>
  );
}
