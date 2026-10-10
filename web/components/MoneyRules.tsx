"use client";

import { State, isFinal, isZeroHash, type Deal } from "@/lib/contracts";
import { fmtDuration, fmtUsdc } from "@/lib/format";
import { nameOf, useWallet } from "@/lib/wallet";
import { explorerAddr } from "@/lib/solana";

type Path = { text: string; fn: string; anyone?: boolean; when?: bigint };

/**
 * „Kto może teraz ruszyć te pieniądze?” — wprost z reguł programu dla bieżącego stanu.
 * To jest moment, w którym pośrednik przestaje być potrzebny: nie ma osoby, która decyduje —
 * są tylko warunki, a każdy z nich sprawdza program.
 */
export function MoneyRules({ deal, vaultBalance }: { deal: Deal; vaultBalance?: bigint }) {
  const w = useWallet();
  const s = deal.state as State;
  if (s === State.Created || s === State.Cancelled || s === State.None) return null;

  const seller = nameOf(deal.seller) ?? "the seller";
  const buyer = nameOf(deal.buyer) ?? "the buyer";
  const pickup = !isZeroHash(deal.pickupHash);
  const q = w.deployment?.oracleQuorum ?? 2;
  const n = w.deployment?.oracles.length ?? 3;
  const aq = w.deployment?.arbiterQuorum ?? 2;
  const an = w.deployment?.panelSize ?? 3;

  const toSeller: Path[] = [];
  const toBuyer: Path[] = [];
  const split: Path[] = [];

  if (s === State.Funded && pickup) {
    toSeller.push({ text: `${buyer} shows the secret code at the meetup, and the program checks it against the hash stored at payment`, fn: "confirm_pickup" });
    toBuyer.push({ text: "the meetup doesn't happen before the deadline — then anyone can settle", fn: "settle_expired", anyone: true, when: deal.deadline });
    toBuyer.push({ text: `${seller} voluntarily refunds the money`, fn: "refund_buyer" });
  } else if (s === State.Funded) {
    toSeller.push({ text: `${seller} ships the parcel, and then ${q} of ${n} independent sources confirm delivery or ${buyer} accepts it`, fn: "mark_shipped → …" });
    toBuyer.push({ text: `${seller} doesn't ship the parcel before the deadline — then anyone can settle`, fn: "settle_expired", anyone: true, when: deal.deadline });
    toBuyer.push({ text: `${seller} voluntarily refunds the money`, fn: "refund_buyer" });
  } else if (s === State.Shipped || s === State.Delivered) {
    toSeller.push({ text: `${buyer} confirms everything is OK`, fn: "confirm_receipt" });
    toSeller.push({
      text: s === State.Delivered ? "the claim window passes with no claim — then anyone can settle" : "the time for delivery and claims runs out — then anyone can settle",
      fn: "settle_expired",
      anyone: true,
      when: deal.deadline,
    });
    toBuyer.push({ text: `${buyer} files a claim (with a bond) before the deadline, and ${seller} doesn't contest it`, fn: "open_dispute" });
    toBuyer.push({ text: `${seller} voluntarily refunds the money`, fn: "refund_buyer" });
    split.push({ text: "both parties agree on the same settlement amount", fn: "propose / accept_settlement" });
  } else if (s === State.Disputed) {
    toBuyer.push({ text: `${seller} doesn't respond to the claim before the deadline — then anyone can settle`, fn: "settle_expired", anyone: true, when: deal.deadline });
    toBuyer.push({ text: `${seller} accepts the claim`, fn: "refund_buyer" });
    toSeller.push({ text: `only through arbitration: ${seller} posts a bond, and ${aq} of ${an} arbiters drawn from the open pool rule in their favour`, fn: "respond_to_dispute → reveal_vote" });
    split.push({ text: "both parties agree on the same settlement amount", fn: "propose / accept_settlement" });
  } else if (s === State.InArbitration) {
    toSeller.push({ text: `${aq} of ${an} arbiters reveal a vote for the seller`, fn: "reveal_vote" });
    toBuyer.push({ text: `${aq} of ${an} arbiters reveal a vote for the buyer`, fn: "reveal_vote" });
    split.push({ text: "the arbiters don't decide before the deadline — 50/50 split, anyone can settle", fn: "settle_expired", anyone: true, when: deal.deadline });
    split.push({ text: "both parties agree on the same settlement amount", fn: "propose / accept_settlement" });
  }

  const final = isFinal(s);

  return (
    <section className="card wide money-rules">
      <h2>{final ? "Who moved this money?" : "Who can move this money now?"}</h2>
      {final ? (
        <p>
          Nobody had to “approve” anything. The program paid out the funds once the recorded condition was met
          {vaultBalance !== undefined && vaultBalance > 0n
            ? ` — only the arbiters' rewards (${fmtUsdc(vaultBalance)}) remain in the vault; the program sends them out when the arbiters are settled.`
            : deal.archived
              ? " — the vault has already been closed."
              : ` — the vault is now empty${vaultBalance !== undefined ? ` (${fmtUsdc(vaultBalance)})` : ""}.`}
        </p>
      ) : (
        <>
          <p className="muted small">
            {vaultBalance !== undefined && <b>{fmtUsdc(vaultBalance)}</b>} sits in a vault owned by the program —
            not a person. It can only leave in one of these ways:
          </p>
          <div className="paths">
            <PathList title={`→ to: ${seller}`} paths={toSeller} now={w.now} />
            <PathList title={`→ to: ${buyer}`} paths={toBuyer} now={w.now} />
            {split.length > 0 && <PathList title="→ split" paths={split} now={w.now} />}
          </div>
        </>
      )}
      <ul className="nobody">
        <li>✗ {seller} can't pay themselves before the condition is met</li>
        <li>✗ {buyer} can't reverse the payment like a bank transfer</li>
        {deal.bond > 0n && <li>✗ neither party picks the arbiters — the program draws the panel from the open pool</li>}
        <li>
          ✗ neither can the SafeDeal team — the program has no admin instruction, and the rules were set once at deployment{" "}
          {w.deployment && (
            <a className="plink" href={explorerAddr(w.deployment.programId, w.deployment.cluster)} target="_blank" rel="noreferrer">
              (program ↗)
            </a>
          )}
        </li>
      </ul>
    </section>
  );
}

function PathList({ title, paths, now }: { title: string; paths: Path[]; now: bigint }) {
  return (
    <div className="path-col">
      <b>{title}</b>
      <ul>
        {paths.map((p) => (
          <li key={p.fn + p.text}>
            <span>when {p.text}</span>
            {p.when !== undefined && p.when > 0n && (
              <small className="muted"> · {p.when > now ? `in ${fmtDuration(p.when - now)}` : "deadline passed — possible now"}</small>
            )}
            <code className="fn">{p.fn}</code>
            {p.anyone && <span className="anyone">anyone can</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
