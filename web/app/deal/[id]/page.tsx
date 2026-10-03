"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { STATE_LABEL, State, TIMEOUT_OUTCOME, isFinal, isZero, isZeroHash, type Address, type Deal, type Profile } from "@/lib/contracts";
import { dealsDone, fmtDuration, fmtUsdc, sameAddr, short } from "@/lib/format";
import { nameOf, useWallet } from "@/lib/wallet";
import { explorerAddr, fetchDeal, fetchProfile, pdas } from "@/lib/solana";
import { EvidenceSection, HistorySection } from "@/components/DealActivity";
import { ArbiterVote, VotingStatus } from "@/components/ArbiterVote";
import { OraclePanel } from "@/components/OraclePanel";
import { SettlementPanel } from "@/components/SettlementPanel";
import { ShareQr } from "@/components/ShareQr";
import { BuyerGuarantee } from "@/components/BuyerGuarantee";
import { ListingCard } from "@/components/ListingCard";
import { ChatPanel } from "@/components/ChatPanel";
import { ReviewPanel } from "@/components/Reviews";
import { PickupPanel } from "@/components/PickupPanel";
import { MoneyRules } from "@/components/MoneyRules";
import { BlinkShare } from "@/components/BlinkShare";
import { Pln } from "@/lib/pln";
import { parseStage } from "@/lib/project";

export default function DealPage() {
  const { id: idParam } = useParams<{ id: string }>();
  const id = BigInt(idParam);
  const w = useWallet();
  const [deal, setDeal] = useState<Deal | null>();
  const [reps, setReps] = useState<Record<string, Profile>>({});
  const [vaultBalance, setVaultBalance] = useState<bigint>();
  const [tracking, setTracking] = useState("DEMO-");
  const [workLink, setWorkLink] = useState("");
  const [disputeText, setDisputeText] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!w.deployment || !w.program) return;
    const d0 = w.deployment;
    const program = w.program;
    let alive = true;
    (async () => {
      const d = await fetchDeal(program, d0, id);
      if (!alive) return;
      if (!d || d.state === State.None) return setDeal(null);
      setDeal(d);
      const parties = [d.seller, d.buyer].filter((a) => !isZero(a));
      const entries = await Promise.all(parties.map(async (a) => [a, await fetchProfile(program, d0, a)] as const));
      if (alive) setReps(Object.fromEntries(entries));
    })().catch(() => alive && setDeal((prev) => prev ?? null));
    return () => {
      alive = false;
    };
  }, [w.deployment, w.program, w.refreshKey, id]);

  // Sejf transakcji — konto tokenowe należące do programu, nie do żadnej osoby.
  const vault = w.deployment && deal ? pdas(w.deployment.programId).vault(new PublicKey(deal.pda)).toBase58() : undefined;
  useEffect(() => {
    if (!vault) return;
    w.connection
      .getTokenAccountBalance(new PublicKey(vault))
      .then((r) => setVaultBalance(BigInt(r.value.amount)))
      .catch(() => setVaultBalance(undefined));
  }, [vault, w.connection, w.refreshKey]);

  if (!w.deployment) return null;
  if (deal === undefined) return <p className="muted">Wczytuję…</p>;
  if (deal === null) return <p>Nie ma transakcji #{idParam}.</p>;

  const s = deal.state as State;
  const me = w.address;
  const isSeller = sameAddr(me, deal.seller);
  const isBuyer = sameAddr(me, deal.buyer);
  const canBuy = s === State.Created && !isSeller && (isZero(deal.buyer) || isBuyer);
  const isArb = w.deployment.arbiters.some((a) => sameAddr(a, me));
  const isPickup = !isZeroHash(deal.pickupHash);
  const stage = parseStage(deal.description);
  const delivered = deal.attestations >= w.deployment.oracleQuorum;
  const cluster = w.deployment.cluster;
  const left = deal.deadline - w.now;
  const expired = !isFinal(s) && s !== State.Created && deal.deadline > 0n && left < 0n;
  const bond = (deal.amount * BigInt(w.deployment.bondBps)) / 10_000n;
  const act = (fn: Parameters<typeof w.write>[0], args: readonly unknown[], label: string) => w.write(fn, args, { label, deal });

  const share = typeof window !== "undefined" ? window.location.href : "";

  return (
    <div className="grid">
      <section className="card wide deal-head">
        <div>
          <span className="mono muted">Transakcja #{idParam}</span>
          {stage && (
            <Link href={`/projekt/${stage.project}`} className="plink small stage-link">
              Etap {stage.index}/{stage.total} zlecenia — zobacz wszystkie etapy →
            </Link>
          )}
          <h1>{deal.title}</h1>
          <div className="price">
            {fmtUsdc(deal.amount)} <Pln usdc={deal.amount} />
          </div>
        </div>
        <div className="deal-side">
          <span className={`badge big s${s} ${isFinal(s) ? "final" : ""}`}>
            {isPickup && s === State.Funded
              ? "Opłacona — czeka na spotkanie"
              : stage && s === State.Funded
                ? "Opłacony — czeka na oddanie etapu"
                : stage && s === State.Shipped
                  ? "Oddany — czeka na akceptację"
                  : STATE_LABEL[s]}
          </span>
          {s === State.Created && (
            <button
              className="btn ghost sm"
              onClick={() => {
                navigator.clipboard.writeText(share);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? "Skopiowano ✓" : "Kopiuj link do ogłoszenia"}
            </button>
          )}
          {s === State.Created && <ShareQr id={idParam} />}
          {s === State.Created && !deal.pickupAllowed && <BlinkShare id={idParam} />}
          {s !== State.Created && (
            <Link href={`/deal/${idParam}/potwierdzenie`} className="btn ghost sm">
              Potwierdzenie (PDF)
            </Link>
          )}
          <a href={explorerAddr(deal.pda, cluster)} target="_blank" rel="noreferrer" className="plink small">
            Konto transakcji w Solana Explorer ↗
          </a>
        </div>
        {vault && (
          <div className="vault wide">
            <span>
              🔒 <b>Pieniądze trzyma program, nie sprzedawca.</b>
            </span>
            <span>
              Sejf tej transakcji:{" "}
              <a href={explorerAddr(vault, cluster)} target="_blank" rel="noreferrer" className="mono">
                {short(vault)} ↗
              </a>{" "}
              · teraz w środku: <b className="mono">{vaultBalance === undefined ? "…" : fmtUsdc(vaultBalance)}</b>
            </span>
            {s === State.Created && (
              <small className="muted">Po wpłacie kupującego pieniądze trafią tutaj — wypłacić je mogą tylko reguły programu.</small>
            )}
          </div>
        )}
      </section>

      <ListingCard id={id} deal={deal} />

      {canBuy && <BuyerGuarantee deal={deal} rep={reps[deal.seller]} pickup={deal.pickupAllowed} />}

      <PickupPanel id={id} deal={deal} canBuy={canBuy} />

      <section className="card wide">
        <Timeline s={s} shipped={!!deal.tracking} delivered={delivered} disputed={deal.bond > 0n} pickup={isPickup} stage={!!stage} />
        {!isFinal(s) && s !== State.Created && (
          <div className={`deadline ${expired ? "expired" : ""}`}>
            {expired ? (
              <>
                <span>
                  Termin minął — teraz <b>{TIMEOUT_OUTCOME[s]}</b>. Rozliczyć może każdy.
                </span>
                <button className="btn" disabled={!!w.busy} onClick={() => act("settleExpired", [], "Rozliczono po terminie")}>
                  Rozlicz teraz
                </button>
              </>
            ) : (
              <span>
                Jeśli nikt nic nie zrobi przez <b>{fmtDuration(left)}</b>, {TIMEOUT_OUTCOME[s]}.
              </span>
            )}
          </div>
        )}
      </section>

      <MoneyRules deal={deal} vaultBalance={vaultBalance} />

      <section className="card">
        <h2>Strony</h2>
        <Party label="Sprzedawca" addr={deal.seller} rep={reps[deal.seller]} you={isSeller} />
        <Party label="Kupujący" addr={deal.buyer} rep={reps[deal.buyer]} you={isBuyer} />
        {deal.tracking && (
          <p>
            {stage ? "Efekt pracy: " : "Przesyłka: "}
            {stage && /^https?:\/\//.test(deal.tracking) ? (
              <a href={deal.tracking} target="_blank" rel="noreferrer" className="plink mono">
                {deal.tracking}
              </a>
            ) : (
              /^\d{20,26}$/.test(deal.tracking) ? (
                <a href={`https://inpost.pl/sledzenie-przesylek?number=${deal.tracking}`} target="_blank" rel="noreferrer" className="plink mono" title="Status u przewoźnika — ten sam, który relayer oracle sprawdza w API InPost">
                  {deal.tracking} ↗
                </a>
              ) : (
                <span className="mono">{deal.tracking}</span>
              )
            )}
          </p>
        )}
        {deal.disputeReason && (
          <p className="quote">
            Reklamacja: „{deal.disputeReason}”
            <br />
            <small className="muted">Kaucja każdej strony: {fmtUsdc(deal.bond)}</small>
          </p>
        )}
        {s === State.InArbitration && (
          <VotingStatus id={id} deal={deal} />
        )}
      </section>

      <section className="card">
        <h2>Twoje akcje</h2>
        <div className="actions">
          {canBuy && (
            <button
              className="btn"
              disabled={!!w.busy}
              onClick={() => (w.mode === "wallet" && !deal.pickupAllowed ? w.buySponsored(deal) : act("fund", [], "Wpłacono do sejfu"))}
            >
              Kup i zablokuj {fmtUsdc(deal.amount)} w sejfie
            </button>
          )}
          {canBuy && w.mode === "wallet" && !deal.pickupAllowed && (
            <p className="muted small">Opłatę sieci płaci sponsor, a brakujące testowe USDC doda kran — wystarczy podpisać w portfelu.</p>
          )}

          {isSeller && s === State.Created && (
            <button className="btn ghost" disabled={!!w.busy} onClick={() => act("cancel", [], "Anulowano ofertę")}>
              Anuluj ofertę
            </button>
          )}

          {isSeller && s === State.Funded && !expired && !isPickup && !stage && (
            <div className="inline">
              <input value={tracking} onChange={(e) => setTracking(e.target.value)} placeholder="Numer przesyłki InPost" />
              <button className="btn" disabled={!!w.busy || !tracking.trim()} onClick={() => act("markShipped", [tracking.trim()], "Zgłoszono nadanie")}>
                Nadałem paczkę
              </button>
            </div>
          )}
          {isSeller && s === State.Funded && !expired && stage && (
            <div className="inline">
              <input value={workLink} onChange={(e) => setWorkLink(e.target.value)} placeholder="Link do efektu pracy (np. repozytorium, plik, podgląd)" />
              <button className="btn" disabled={!!w.busy || !workLink.trim()} onClick={() => act("markShipped", [workLink.trim()], "Oddano etap")}>
                Oddaję etap
              </button>
            </div>
          )}

          {isBuyer && (s === State.Shipped || s === State.Delivered) && (
            <>
              <button className="btn" disabled={!!w.busy} onClick={() => act("confirmReceipt", [], "Potwierdzono odbiór")}>
                {stage ? "Akceptuję etap — wypłać wykonawcy" : "Wszystko OK — wypłać sprzedawcy"}
              </button>
              {!expired && (
                <div className="inline col">
                  <input value={disputeText} onChange={(e) => setDisputeText(e.target.value)} placeholder="Co jest nie tak?" />
                  <button
                    className="btn danger"
                    disabled={!!w.busy || !disputeText.trim()}
                    onClick={() => act("openDispute", [disputeText.trim()], "Zgłoszono reklamację")}
                  >
                    Zgłoś reklamację (kaucja {fmtUsdc(bond)})
                  </button>
                </div>
              )}
            </>
          )}

          {isSeller && s === State.Disputed && !expired && (
            <button
              className="btn"
              disabled={!!w.busy}
              onClick={() => act("respondToDispute", [], "Skierowano do arbitrażu")}
            >
              Nie zgadzam się — arbitraż (kaucja {fmtUsdc(deal.bond)})
            </button>
          )}

          {isSeller && [State.Funded, State.Shipped, State.Delivered, State.Disputed].includes(s) && (
            <button className="btn ghost" disabled={!!w.busy} onClick={() => act("refundBuyer", [], "Zwrócono pieniądze")}>
              {s === State.Disputed ? "Uznaj reklamację i zwróć pieniądze" : "Zwróć pieniądze kupującemu"}
            </button>
          )}

          {isArb && s === State.InArbitration && !expired && (
            <ArbiterVote id={id} deal={deal} />
          )}

          {isBuyer && s === State.Funded && (
            <p className="muted">
              {stage
                ? "Czekasz, aż wykonawca odda etap. Jeśli nie zdąży — pieniądze wrócą do Ciebie automatycznie."
                : isPickup
                ? "Umów się na odbiór. Kod pokaż dopiero po obejrzeniu przedmiotu. Jeśli do spotkania nie dojdzie — pieniądze wrócą do Ciebie po terminie."
                : "Czekasz, aż sprzedawca nada paczkę. Jeśli nie zdąży — pieniądze wrócą do Ciebie automatycznie."}
            </p>
          )}
          {isBuyer && s === State.Disputed && (
            <p className="muted">Czekasz na odpowiedź sprzedawcy. Jeśli zignoruje reklamację — wygrywasz.</p>
          )}
          {(isBuyer || isSeller) && s === State.InArbitration && (
            <p className="muted">Sprawę rozstrzygają arbitrzy. Jeśli nie zdążą — kwota zostanie podzielona 50/50.</p>
          )}

          {!me && <p className="muted">Połącz portfel, aby działać.</p>}
          {me && isFinal(s) && <p className="muted">Transakcja zamknięta — nic więcej nie da się zrobić.</p>}
          {me && !isFinal(s) && !isSeller && !isBuyer && !canBuy && !(isArb && s === State.InArbitration) && (
            <p className="muted">Nie jesteś stroną tej transakcji.{expired ? " Możesz ją jednak rozliczyć po terminie." : ""}</p>
          )}
        </div>
      </section>

      <ReviewPanel id={id} deal={deal} />

      <SettlementPanel id={id} deal={deal} />

      <ChatPanel id={idParam} deal={deal} isArbiter={isArb} />

      <EvidenceSection id={id} deal={deal} />

      {w.mode === "demo" && !isFinal(s) && (
        <section className="card wide demo">
          <h2>Panel demo</h2>
          <p className="muted">
            Symulacja świata zewnętrznego: niezależne źródła statusu przesyłki (oracle) potwierdzają doręczenie. Terminy na devnecie
            trwają minuty — wystarczy chwilę poczekać.
          </p>
          {s === State.Shipped && !stage ? (
            <OraclePanel id={id} deal={deal} />
          ) : (
            <p className="muted small">Potwierdzenia doręczenia są dostępne, gdy paczka jest w drodze.</p>
          )}
        </section>
      )}
      <HistorySection id={id} deal={deal} />
    </div>
  );
}

const STEPS: { s: State; label: string }[] = [
  { s: State.Created, label: "Oferta" },
  { s: State.Funded, label: "Opłacona" },
  { s: State.Shipped, label: "Nadana" },
  { s: State.Delivered, label: "Doręczona" },
];

function Timeline({
  s,
  shipped,
  delivered,
  disputed,
  pickup,
  stage,
}: {
  s: State;
  shipped: boolean;
  delivered: boolean;
  disputed: boolean;
  pickup: boolean;
  stage: boolean;
}) {
  if (stage) {
    return (
      <ol className="timeline">
        <li className="done">Etap</li>
        <li className={s >= State.Funded && s !== State.Cancelled ? "done" : ""}>Opłacony</li>
        <li className={shipped ? "done" : ""}>Oddany</li>
        {disputed && <li className="done warn">Spór</li>}
        <li className={isFinal(s) ? "done final" : ""}>{isFinal(s) ? STATE_LABEL[s].replace("Zakończona — ", "") : "Akceptacja"}</li>
      </ol>
    );
  }
  if (pickup) {
    const met = s === State.Released;
    return (
      <ol className="timeline">
        <li className="done">Oferta</li>
        <li className={s >= State.Funded ? "done" : ""}>Opłacona</li>
        <li className={met ? "done" : ""}>Spotkanie i kod odbioru</li>
        <li className={isFinal(s) ? "done final" : ""}>{isFinal(s) ? STATE_LABEL[s].replace("Zakończona — ", "") : "Rozliczenie"}</li>
      </ol>
    );
  }
  // Stan sporu lub końcowy nie mówi, którędy transakcja przeszła — odtwarzamy to z numeru przesyłki,
  // potwierdzeń oracle'i i kaucji sporu.
  const progress =
    s === State.Cancelled
      ? State.Created
      : s < State.Disputed
        ? s
        : delivered
          ? State.Delivered
          : shipped
            ? State.Shipped
            : State.Funded;
  return (
    <ol className="timeline">
      {STEPS.map((st) => (
        <li key={st.s} className={st.s <= progress ? "done" : ""}>
          {st.label}
        </li>
      ))}
      {disputed && <li className="done warn">Spór</li>}
      <li className={isFinal(s) ? "done final" : ""}>{isFinal(s) ? STATE_LABEL[s].replace("Zakończona — ", "") : "Rozliczenie"}</li>
    </ol>
  );
}

function Party({ label, addr, rep, you }: { label: string; addr: Address; rep?: Profile; you: boolean }) {
  if (isZero(addr)) {
    return (
      <div className="party">
        <span className="muted">{label}</span>
        <span>każdy z linkiem</span>
      </div>
    );
  }
  return (
    <div className="party">
      <span className="muted">{label}</span>
      <span>
        <Link href={`/u/${addr}`} className="plink"><b>{nameOf(addr) ?? short(addr)}</b></Link> {you && <span className="you">to Ty</span>}
        {rep && (
          <small className="muted">
            {" "}
            · ✔ {dealsDone(rep.soldOk + rep.boughtOk)} · spory wygrane {rep.disputesWon}/{rep.disputesWon + rep.disputesLost}
          </small>
        )}
      </span>
    </div>
  );
}
