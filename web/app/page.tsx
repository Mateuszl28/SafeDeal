"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { uploadFile } from "@/lib/files";
import { Pln } from "@/lib/pln";
import { State, ZERO_HASH } from "@/lib/contracts";
import { isAddress, parseUsdc, sameAddr } from "@/lib/format";
import { fetchConfig } from "@/lib/solana";
import { useWallet } from "@/lib/wallet";
import { DealList, useAllDeals } from "@/components/DealList";
import { ProfileSummary } from "@/components/Profile";
import { ProjectForm } from "@/components/ProjectForm";

export default function Home() {
  const w = useWallet();
  const router = useRouter();
  const deals = useAllDeals();
  const [title, setTitle] = useState("");
  const [price, setPrice] = useState("");
  const [buyer, setBuyer] = useState("");
  const [description, setDescription] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [pickupOk, setPickupOk] = useState(false);
  const [formError, setFormError] = useState<string>();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"new" | "cheap" | "expensive">("new");
  const [kind, setKind] = useState<"item" | "project">("item");

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!w.deployment || !w.program) return;
    setFormError(undefined);
    let amount: bigint;
    try {
      amount = parseUsdc(price);
    } catch {
      return setFormError("Nieprawidłowa cena.");
    }
    if (!title.trim() || amount <= 0n) return;
    const target = buyer.trim();
    if (target && !isAddress(target)) return setFormError("To nie wygląda na adres Solany.");
    if (new TextEncoder().encode(description.trim()).length > 500) return setFormError("Opis jest za długi (max 500 bajtów).");

    let photoUri = "";
    let photoHash = ZERO_HASH;
    if (photo) {
      try {
        const up = await uploadFile(photo);
        photoUri = up.uri;
        photoHash = up.hash;
      } catch (err) {
        return setFormError(`Nie udało się wysłać zdjęcia: ${err instanceof Error ? err.message : err}`);
      }
    }
    // Opis, zdjęcie i odbiór osobisty idą w JEDNEJ transakcji razem z ofertą.
    const sig = await w.write(
      "createDeal",
      [{ amount, title: title.trim(), buyer: target || null, description: description.trim(), photoUri, photoHash, pickupAllowed: pickupOk }],
      { label: "Utworzono ofertę" },
    );
    if (!sig) return;
    try {
      const cfg = await fetchConfig(w.program, w.deployment);
      router.push(`/deal/${cfg.dealCount}`);
    } catch {
      w.refresh();
    }
  }

  const isCouncil = !!w.deployment?.arbiters.some((a) => sameAddr(a, w.address));
  const cases = isCouncil ? deals.filter((d) => d.state === State.InArbitration) : [];
  const isArbiter = cases.length > 0;
  const mine = deals.filter((d) => sameAddr(d.seller, w.address) || sameAddr(d.buyer, w.address));
  const q = query.trim().toLowerCase();
  const openAll = deals.filter((d) => d.state === State.Created && !sameAddr(d.seller, w.address));
  const open = openAll
    .filter((d) => !q || d.title.toLowerCase().includes(q) || d.description.toLowerCase().includes(q))
    .sort((a, b) => (sort === "new" ? 0 : sort === "cheap" ? Number(a.amount - b.amount) : Number(b.amount - a.amount)));
  const rest = deals.filter((d) => !mine.includes(d) && !openAll.includes(d) && !(isArbiter && cases.includes(d)));

  return (
    <div className="grid">
      <section className="hero">
        <h1>Kupuj od obcych bez zaufania.</h1>
        <p>
          Pieniądze kupującego trafiają do sejfu programu na blockchainie Solana, nie do sprzedawcy. Wypłata następuje dopiero po
          potwierdzeniu doręczenia i oknie na reklamację. Jeśli ktoś zniknie, wynik jest z góry zapisany w kodzie.
        </p>
        <ol className="steps">
          <li><b>Wpłata</b> — kupujący blokuje USDC w sejfie programu</li>
          <li><b>Nadanie</b> — sprzedawca podaje numer przesyłki</li>
          <li><b>Doręczenie</b> — {w.deployment?.oracleQuorum ?? 2} z {w.deployment?.oracles.length ?? 3} niezależnych źródeł potwierdza status</li>
          <li><b>Wypłata</b> — automatycznie po oknie na reklamację</li>
        </ol>
      </section>

      <section className="card">
        <h2>Nowa oferta</h2>
        <div className="form-tabs" role="tablist" aria-label="Rodzaj oferty">
          <button type="button" role="tab" aria-selected={kind === "item"} className={kind === "item" ? "on" : ""} onClick={() => setKind("item")}>
            Przedmiot
          </button>
          <button type="button" role="tab" aria-selected={kind === "project"} className={kind === "project" ? "on" : ""} onClick={() => setKind("project")}>
            Zlecenie w etapach
          </button>
        </div>
        {kind === "project" ? (
          <ProjectForm />
        ) : (
        <form onSubmit={create} className="form">
          <label>
            Co sprzedajesz?
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="np. Rower gravel Kross Esker" maxLength={80} />
          </label>
          <label>
            Cena (USDC)
            <input value={price} onChange={(e) => setPrice(e.target.value)} placeholder="250" inputMode="decimal" />
            {(() => {
              try {
                const v = parseUsdc(price);
                return v > 0n ? <Pln usdc={v} prefix="to ok. " /> : null;
              } catch {
                return null;
              }
            })()}
          </label>
          <label>
            Opis <small className="muted">(stan, rozmiar, wady — zapisany on-chain, nie zmienisz go po wpłacie)</small>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={400} placeholder="np. Rama 54, przebieg 800 km, drobna rysa na widelcu" />
          </label>
          <label>
            Zdjęcie <small className="muted">(opcjonalnie — jego odcisk trafi do blockchaina)</small>
            <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} />
          </label>
          <label className="check">
            <input type="checkbox" checked={pickupOk} onChange={(e) => setPickupOk(e.target.checked)} />
            Możliwy odbiór osobisty (kupujący płaci do sejfu i pokazuje kod na spotkaniu)
          </label>
          <label>
            Konkretny kupujący <small className="muted">(opcjonalnie — adres portfela)</small>
            <input value={buyer} onChange={(e) => setBuyer(e.target.value)} placeholder="adres Solany albo puste = każdy" />
          </label>
          <button className="btn" disabled={!w.deployment || !!w.busy || !title.trim() || !price}>
            Utwórz ofertę i link
          </button>
          {formError && <p className="err-text">{formError}</p>}
        </form>
        )}
      </section>

      {w.address ? (
        <ProfileSummary address={w.address} deals={deals} compact />
      ) : (
        <section className="card">
          <h2>Twój profil</h2>
          <p className="muted">Połącz portfel, aby zobaczyć swoją reputację.</p>
        </section>
      )}

      {isArbiter && (
        <DealList title="Sprawy czekające na radę arbitrów" rows={cases} empty="Żaden spór nie czeka na Twój głos." />
      )}
      <DealList title="Moje transakcje" rows={mine} empty="Nie masz jeszcze transakcji." />
      <section className="card wide search-card">
        <div className="search-row">
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Szukaj w ofertach: tytuł lub opis…" aria-label="Szukaj ofert" />
          <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label="Sortowanie">
            <option value="new">Najnowsze</option>
            <option value="cheap">Najtańsze</option>
            <option value="expensive">Najdroższe</option>
          </select>
        </div>
      </section>
      <DealList title="Otwarte oferty" rows={open} empty={q ? "Nic nie pasuje do wyszukiwania." : "Brak otwartych ofert."} />
      {rest.length > 0 && <DealList title="Pozostałe" rows={rest} />}
    </div>
  );
}
