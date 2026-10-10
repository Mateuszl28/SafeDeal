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
import { ArbiterVote, VotingStatus, onPanel } from "@/components/ArbiterVote";
import { CloseDealPanel } from "@/components/CloseDealPanel";
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

  // Relayer na serwerze (oracle doręczeń, losowanie składu arbitrów) — pchamy go, gdy ktoś ogląda transakcję,
  // która na niego czeka. Wszystko, co robi, mógłby zrobić każdy; serwer ma limity częstotliwości.
  const waitsForRelay =
    !!deal &&
    ((deal.state >= State.Funded && deal.state <= State.InArbitration && deal.deadline > 0n && w.now > deal.deadline + 5n) ||
      (deal.state === State.Shipped && /^(DEMO-|\d{20,26}$)/.test(deal.tracking.trim())) ||
      (deal.state === State.InArbitration && !deal.panelDrawn) ||
      (isFinal(deal.state) && !deal.archived && deal.panelDrawn && deal.panelSettled !== 0b111));
  useEffect(() => {
    if (!waitsForRelay) return;
    fetch(`/api/relayer?deal=${idParam}`)
      .then((r) => r.json())
      .then((j: { done?: string[] }) => {
        if (j.done?.length) w.refresh();
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitsForRelay, w.refreshKey, idParam]);

  // Sejf transakcji — konto tokenowe należące do programu, nie do żadnej osoby.
  const vault = w.deployment && deal && !deal.archived ? pdas(w.deployment.programId).vault(new PublicKey(deal.pda)).toBase58() : undefined;
  useEffect(() => {
    if (!vault) return;
    w.connection
      .getTokenAccountBalance(new PublicKey(vault))
      .then((r) => setVaultBalance(BigInt(r.value.amount)))
      .catch(() => setVaultBalance(undefined));
  }, [vault, w.connection, w.refreshKey]);

  if (!w.deployment) return null;
  if (deal === undefined) return <p className="muted">Loading…</p>;
  if (deal === null) return <p>Deal #{idParam} does not exist.</p>;

  const s = deal.state as State;
  const me = w.address;
  const isSeller = sameAddr(me, deal.seller);
  const isBuyer = sameAddr(me, deal.buyer);
  const canBuy = s === State.Created && !isSeller && (isZero(deal.buyer) || isBuyer);
  const isArb = onPanel(deal, me);
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
          <span className="mono muted">Deal #{idParam}</span>
          {stage && (
            <Link href={`/projekt/${stage.project}`} className="plink small stage-link">
              Milestone {stage.index}/{stage.total} of the project — see all milestones →
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
              ? "Paid — waiting for the meetup"
              : stage && s === State.Funded
                ? "Paid — waiting for the milestone"
                : stage && s === State.Shipped
                  ? "Delivered — waiting for approval"
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
              {copied ? "Copied ✓" : "Copy listing link"}
            </button>
          )}
          {s === State.Created && <ShareQr id={idParam} />}
          {s === State.Created && !deal.pickupAllowed && <BlinkShare id={idParam} deal={deal} />}
          {s !== State.Created && (
            <Link href={`/deal/${idParam}/potwierdzenie`} className="btn ghost sm">
              Receipt (PDF)
            </Link>
          )}
          <a href={explorerAddr(deal.pda, cluster)} target="_blank" rel="noreferrer" className="plink small">
            Deal account in Solana Explorer ↗
          </a>
        </div>
        {vault && (
          <div className="vault wide">
            <span>
              🔒 <b>The money is held by the program, not the seller.</b>
            </span>
            <span>
              This deal's vault:{" "}
              <a href={explorerAddr(vault, cluster)} target="_blank" rel="noreferrer" className="mono">
                {short(vault)} ↗
              </a>{" "}
              · currently inside: <b className="mono">{vaultBalance === undefined ? "…" : fmtUsdc(vaultBalance)}</b>
            </span>
            {s === State.Created && (
              <small className="muted">Once the buyer pays, the money lands here — only the program's rules can pay it out.</small>
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
                  The deadline has passed — now <b>{TIMEOUT_OUTCOME[s]}</b>. Anyone can settle it.
                </span>
                <button className="btn" disabled={!!w.busy} onClick={() => act("settleExpired", [], "Settled after the deadline")}>
                  Settle now
                </button>
              </>
            ) : (
              <span>
                If nobody does anything within <b>{fmtDuration(left)}</b>, {TIMEOUT_OUTCOME[s]}.
              </span>
            )}
          </div>
        )}
      </section>

      <MoneyRules deal={deal} vaultBalance={vaultBalance} />

      <section className="card">
        <h2>Parties</h2>
        <Party label="Seller" addr={deal.seller} rep={reps[deal.seller]} you={isSeller} />
        <Party label="Buyer" addr={deal.buyer} rep={reps[deal.buyer]} you={isBuyer} />
        {deal.tracking && (
          <p>
            {stage ? "Work result: " : "Parcel: "}
            {stage && /^https?:\/\//.test(deal.tracking) ? (
              <a href={deal.tracking} target="_blank" rel="noreferrer" className="plink mono">
                {deal.tracking}
              </a>
            ) : (
              /^\d{20,26}$/.test(deal.tracking) ? (
                <a href={`https://inpost.pl/sledzenie-przesylek?number=${deal.tracking}`} target="_blank" rel="noreferrer" className="plink mono" title="Carrier status — the same one the oracle relayer checks in the InPost API">
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
            Complaint: “{deal.disputeReason}”
            <br />
            <small className="muted">Bond per party: {fmtUsdc(deal.bond)}</small>
          </p>
        )}
        {s === State.InArbitration && (
          <VotingStatus id={id} deal={deal} />
        )}
      </section>

      <section className="card">
        <h2>Your actions</h2>
        <div className="actions">
          {canBuy && (
            <button
              className="btn"
              disabled={!!w.busy}
              onClick={() => (w.mode === "wallet" && !deal.pickupAllowed ? w.buySponsored(deal) : act("fund", [], "Paid into the vault"))}
            >
              Buy and lock {fmtUsdc(deal.amount)} in the vault
            </button>
          )}
          {canBuy && w.mode === "wallet" && !deal.pickupAllowed && (
            <p className="muted small">A sponsor pays the network fee and a faucet tops up any missing test USDC — just sign in your wallet.</p>
          )}

          {isSeller && s === State.Created && (
            <button className="btn ghost" disabled={!!w.busy} onClick={() => act("cancel", [], "Offer cancelled")}>
              Cancel offer
            </button>
          )}

          {isSeller && s === State.Funded && !expired && !isPickup && !stage && (
            <div className="inline">
              <input value={tracking} onChange={(e) => setTracking(e.target.value)} placeholder="InPost tracking number" />
              <button className="btn" disabled={!!w.busy || !tracking.trim()} onClick={() => act("markShipped", [tracking.trim()], "Shipment reported")}>
                I've shipped the parcel
              </button>
            </div>
          )}
          {isSeller && s === State.Funded && !expired && stage && (
            <div className="inline">
              <input value={workLink} onChange={(e) => setWorkLink(e.target.value)} placeholder="Link to the work (e.g. repository, file, preview)" />
              <button className="btn" disabled={!!w.busy || !workLink.trim()} onClick={() => act("markShipped", [workLink.trim()], "Milestone delivered")}>
                Deliver milestone
              </button>
            </div>
          )}

          {isBuyer && (s === State.Shipped || s === State.Delivered) && (
            <>
              <button className="btn" disabled={!!w.busy} onClick={() => act("confirmReceipt", [], "Receipt confirmed")}>
                {stage ? "Approve milestone — pay the contractor" : "All good — pay the seller"}
              </button>
              {!expired && (
                <div className="inline col">
                  <input value={disputeText} onChange={(e) => setDisputeText(e.target.value)} placeholder="What's wrong?" />
                  <button
                    className="btn danger"
                    disabled={!!w.busy || !disputeText.trim()}
                    onClick={() => act("openDispute", [disputeText.trim()], "Complaint filed")}
                  >
                    File a complaint (bond {fmtUsdc(bond)})
                  </button>
                </div>
              )}
            </>
          )}

          {isSeller && s === State.Disputed && !expired && (
            <button
              className="btn"
              disabled={!!w.busy}
              onClick={() => act("respondToDispute", [], "Sent to arbitration")}
            >
              I disagree — go to arbitration (bond {fmtUsdc(deal.bond)})
            </button>
          )}

          {isSeller && [State.Funded, State.Shipped, State.Delivered, State.Disputed].includes(s) && (
            <button className="btn ghost" disabled={!!w.busy} onClick={() => act("refundBuyer", [], "Money refunded")}>
              {s === State.Disputed ? "Accept the complaint and refund" : "Refund the buyer"}
            </button>
          )}

          {isArb && s === State.InArbitration && !expired && (
            <ArbiterVote id={id} deal={deal} />
          )}

          {isBuyer && s === State.Funded && (
            <p className="muted">
              {stage
                ? "Waiting for the contractor to deliver the milestone. If they miss the deadline, the money comes back to you automatically."
                : isPickup
                ? "Arrange the pickup. Show the code only after inspecting the item. If the meetup doesn't happen, the money comes back to you after the deadline."
                : "Waiting for the seller to ship the parcel. If they miss the deadline, the money comes back to you automatically."}
            </p>
          )}
          {isBuyer && s === State.Disputed && (
            <p className="muted">Waiting for the seller's response. If they ignore the complaint, you win.</p>
          )}
          {(isBuyer || isSeller) && s === State.InArbitration && (
            <p className="muted">Arbiters are deciding the case. If they run out of time, the amount is split 50/50.</p>
          )}

          {!me && <p className="muted">Connect a wallet to take action.</p>}
          {me && isFinal(s) && <p className="muted">Deal closed — the money has been settled.</p>}
          {s === State.InArbitration && !deal.panelDrawn && !isBuyer && !isSeller && (
            <p className="muted">The arbiter panel hasn't been drawn yet — anyone can trigger the draw (“Parties” panel).</p>
          )}
          {me && !isFinal(s) && !isSeller && !isBuyer && !canBuy && !(isArb && s === State.InArbitration) && (
            <p className="muted">You're not a party to this deal.{expired ? " You can still settle it after the deadline." : ""}</p>
          )}
        </div>
      </section>

      <ReviewPanel id={id} deal={deal} />

      <CloseDealPanel deal={deal} />

      <SettlementPanel id={id} deal={deal} />

      <ChatPanel id={idParam} deal={deal} isArbiter={isArb} />

      <EvidenceSection id={id} deal={deal} />

      {w.mode === "demo" && !isFinal(s) && (
        <section className="card wide demo">
          <h2>Demo panel</h2>
          <p className="muted">
            Simulating the outside world: independent parcel-status sources (oracles) confirm delivery. Deadlines on devnet
            last minutes — just wait a moment.
          </p>
          {s === State.Shipped && !stage ? (
            <OraclePanel id={id} deal={deal} />
          ) : (
            <p className="muted small">Delivery confirmations are available while the parcel is in transit.</p>
          )}
        </section>
      )}
      <HistorySection id={id} deal={deal} />
    </div>
  );
}

// Etykieta stanu końcowego bez przedrostka („… — wypłacono sprzedawcy” → „wypłacono sprzedawcy”).
const finalLabel = (s: State) => STATE_LABEL[s].split(" — ").pop()!;

const STEPS: { s: State; label: string }[] = [
  { s: State.Created, label: "Offer" },
  { s: State.Funded, label: "Paid" },
  { s: State.Shipped, label: "Shipped" },
  { s: State.Delivered, label: "Delivered" },
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
        <li className="done">Milestone</li>
        <li className={s >= State.Funded && s !== State.Cancelled ? "done" : ""}>Paid</li>
        <li className={shipped ? "done" : ""}>Delivered</li>
        {disputed && <li className="done warn">Dispute</li>}
        <li className={isFinal(s) ? "done final" : ""}>{isFinal(s) ? finalLabel(s) : "Approval"}</li>
      </ol>
    );
  }
  if (pickup) {
    const met = s === State.Released;
    return (
      <ol className="timeline">
        <li className="done">Offer</li>
        <li className={s >= State.Funded ? "done" : ""}>Paid</li>
        <li className={met ? "done" : ""}>Meetup and pickup code</li>
        <li className={isFinal(s) ? "done final" : ""}>{isFinal(s) ? finalLabel(s) : "Settlement"}</li>
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
      {disputed && <li className="done warn">Dispute</li>}
      <li className={isFinal(s) ? "done final" : ""}>{isFinal(s) ? finalLabel(s) : "Settlement"}</li>
    </ol>
  );
}

function Party({ label, addr, rep, you }: { label: string; addr: Address; rep?: Profile; you: boolean }) {
  if (isZero(addr)) {
    return (
      <div className="party">
        <span className="muted">{label}</span>
        <span>anyone with the link</span>
      </div>
    );
  }
  return (
    <div className="party">
      <span className="muted">{label}</span>
      <span>
        <Link href={`/u/${addr}`} className="plink"><b>{nameOf(addr) ?? short(addr)}</b></Link> {you && <span className="you">you</span>}
        {rep && (
          <small className="muted">
            {" "}
            · ✔ {dealsDone(rep.soldOk + rep.boughtOk)} · disputes won {rep.disputesWon}/{rep.disputesWon + rep.disputesLost}
          </small>
        )}
      </span>
    </div>
  );
}
