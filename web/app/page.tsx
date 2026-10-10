"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
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
  const [fromListing, setFromListing] = useState<string>();

  // „Sprzedaj przez SafeDeal” z serwisu z ogłoszeniami (widget.js): ?tytul=&cena=&opis=&zrodlo= wypełnia formularz.
  // Nic nie jest wysyłane bez kliknięcia „Utwórz ofertę” — sprzedawca widzi i może poprawić każde pole.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const t = q.get("tytul");
    if (!t) return;
    setKind("item");
    setTitle(t.slice(0, 80));
    const cena = q.get("cena");
    if (cena && /^\d+([.,]\d{1,6})?$/.test(cena.trim())) setPrice(cena.trim());
    const src = q.get("zrodlo");
    const safeSrc = src && /^https?:\/\//.test(src) ? src : "";
    const opis = (q.get("opis") ?? "").trim();
    setDescription([opis, safeSrc ? `Listing: ${safeSrc}` : ""].filter(Boolean).join("\n").slice(0, 480));
    if (safeSrc) {
      try {
        setFromListing(new URL(safeSrc).hostname);
      } catch {
        /* zły adres — pomijamy */
      }
    } else setFromListing("a listing");
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!w.deployment || !w.program) return;
    setFormError(undefined);
    let amount: bigint;
    try {
      amount = parseUsdc(price);
    } catch {
      return setFormError("Invalid price.");
    }
    if (!title.trim() || amount <= 0n) return;
    const target = buyer.trim();
    if (target && !isAddress(target)) return setFormError("That doesn't look like a Solana address.");
    if (new TextEncoder().encode(description.trim()).length > 500) return setFormError("The description is too long (max 500 bytes).");

    let photoUri = "";
    let photoHash = ZERO_HASH;
    if (photo) {
      try {
        const up = await uploadFile(photo);
        photoUri = up.uri;
        photoHash = up.hash;
      } catch (err) {
        return setFormError(`Couldn't upload the photo: ${err instanceof Error ? err.message : err}`);
      }
    }
    // Opis, zdjęcie i odbiór osobisty idą w JEDNEJ transakcji razem z ofertą.
    const sig = await w.write(
      "createDeal",
      [{ amount, title: title.trim(), buyer: target || null, description: description.trim(), photoUri, photoHash, pickupAllowed: pickupOk }],
      { label: "Offer created" },
    );
    if (!sig) return;
    try {
      const cfg = await fetchConfig(w.program, w.deployment);
      router.push(`/deal/${cfg.dealCount}`);
    } catch {
      w.refresh();
    }
  }

  const cases = deals.filter((d) => d.state === State.InArbitration && d.panelDrawn && d.panel.some((a) => sameAddr(a, w.address)));
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
        <h1>Buy from strangers without trust.</h1>
        <p>
          The buyer's money goes into a program vault on the Solana blockchain, not to the seller. The payout happens only after
          delivery is confirmed and the complaint window closes. If someone disappears, the outcome is already written in code.
        </p>
        <ol className="steps">
          <li><b>Payment</b> — the buyer locks USDC in the program vault</li>
          <li><b>Shipping</b> — the seller enters the tracking number</li>
          <li><b>Delivery</b> — {w.deployment?.oracleQuorum ?? 2} of {w.deployment?.oracles.length ?? 3} independent sources confirm the status</li>
          <li><b>Payout</b> — automatic once the complaint window closes</li>
        </ol>
      </section>

      <section className="card" id="nowa-oferta">
        <h2>New offer</h2>
        {fromListing && (
          <p className="muted small">
            Details from {fromListing} — check them before publishing. Once published, paste the SafeDeal offer link into your listing.
          </p>
        )}
        <div className="form-tabs" role="tablist" aria-label="Offer type">
          <button type="button" role="tab" aria-selected={kind === "item"} className={kind === "item" ? "on" : ""} onClick={() => setKind("item")}>
            Item
          </button>
          <button type="button" role="tab" aria-selected={kind === "project"} className={kind === "project" ? "on" : ""} onClick={() => setKind("project")}>
            Milestone project
          </button>
        </div>
        {kind === "project" ? (
          <ProjectForm />
        ) : (
        <form onSubmit={create} className="form">
          <label>
            What are you selling?
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Kross Esker gravel bike" maxLength={80} />
          </label>
          <label>
            Price (USDC)
            <input value={price} onChange={(e) => setPrice(e.target.value)} placeholder="250" inputMode="decimal" />
            {(() => {
              try {
                const v = parseUsdc(price);
                return v > 0n ? <Pln usdc={v} prefix="≈ " /> : null;
              } catch {
                return null;
              }
            })()}
          </label>
          <label>
            Description <small className="muted">(condition, size, defects — stored on-chain, can't be changed after payment)</small>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={400} placeholder="e.g. 54 cm frame, 800 km ridden, small scratch on the fork" />
          </label>
          <label>
            Photo <small className="muted">(optional — its fingerprint is stored on the blockchain)</small>
            <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} />
          </label>
          <label className="check">
            <input type="checkbox" checked={pickupOk} onChange={(e) => setPickupOk(e.target.checked)} />
            In-person pickup available (the buyer pays into the vault and shows a code when you meet)
          </label>
          <label>
            Specific buyer <small className="muted">(optional — wallet address)</small>
            <input value={buyer} onChange={(e) => setBuyer(e.target.value)} placeholder="Solana address, or empty = anyone" />
          </label>
          <button className="btn" disabled={!w.deployment || !!w.busy || !title.trim() || !price}>
            Create offer and link
          </button>
          {formError && <p className="err-text">{formError}</p>}
        </form>
        )}
      </section>

      {w.address ? (
        <ProfileSummary address={w.address} deals={deals} compact />
      ) : (
        <section className="card">
          <h2>Your profile</h2>
          <p className="muted">Connect a wallet to see your reputation.</p>
        </section>
      )}

      {isArbiter && (
        <DealList title="Cases you were drawn for" rows={cases} empty="No dispute is waiting for your vote." />
      )}
      <DealList title="My deals" rows={mine} empty="You don't have any deals yet." />
      <section className="card wide search-card">
        <div className="search-row">
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search offers: title or description…" aria-label="Search offers" />
          <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label="Sort">
            <option value="new">Newest</option>
            <option value="cheap">Cheapest</option>
            <option value="expensive">Most expensive</option>
          </select>
        </div>
      </section>
      <DealList title="Open offers" rows={open} empty={q ? "Nothing matches your search." : "No open offers."} />
      {rest.length > 0 && <DealList title="Other" rows={rest} />}
    </div>
  );
}
