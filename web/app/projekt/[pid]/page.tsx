"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { DealList, useAllDeals } from "@/components/DealList";
import { State } from "@/lib/contracts";
import { fmtUsdc, plural, sameAddr, short } from "@/lib/format";
import { Pln } from "@/lib/pln";
import { parseStage } from "@/lib/project";
import { nameOf, useWallet } from "@/lib/wallet";

/** Strona zlecenia: wszystkie etapy razem, postęp i opłacenie całości jednym przyciskiem. */
export default function ProjectPage() {
  const { pid } = useParams<{ pid: string }>();
  const w = useWallet();
  const deals = useAllDeals();

  const stages = deals
    .map((d) => ({ d, st: parseStage(d.description) }))
    .filter((x) => x.st?.project === pid)
    .sort((a, b) => a.st!.index - b.st!.index);

  if (!w.deployment) return null;
  if (stages.length === 0) return <p className="muted">Loading project… (if this takes long, check the link)</p>;

  const rows = stages.map((x) => x.d);
  const first = rows[0];
  const name = first.title.replace(/ — (?:etap|stage|milestone) \d+\/\d+:.*$/, "");
  const total = rows.reduce((s, d) => s + d.amount, 0n);
  const paidOut = rows.filter((d) => d.state === State.Released || d.state === State.Settled).reduce((s, d) => s + d.amount, 0n);
  const unfunded = rows.filter((d) => d.state === State.Created);
  const unfundedSum = unfunded.reduce((s, d) => s + d.amount, 0n);
  const isClient = sameAddr(w.address, first.buyer);
  const doneCount = rows.filter((d) => d.state >= State.Released).length;
  const pct = total > 0n ? Number((paidOut * 100n) / total) : 0;

  async function fundAll() {
    for (const d of unfunded) {
      const ok = await w.write("fund", [], { deal: d, label: `Locking funds: ${d.title.split(": ").pop()}` });
      if (!ok) break;
    }
  }

  return (
    <div className="grid">
      <section className="card wide">
        <span className="mono muted small">Milestone project</span>
        <h1>{name}</h1>
        <p>
          Contractor: <b>{nameOf(first.seller) ?? short(first.seller)}</b> · Client: <b>{nameOf(first.buyer) ?? short(first.buyer)}</b> ·{" "}
          {plural(rows.length, "milestone", "milestones", "milestones")} · total <b>{fmtUsdc(total)}</b> <Pln usdc={total} />
        </p>
        <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Paid out to contractor">
          <span style={{ width: `${pct}%` }} />
        </div>
        <p className="muted small">
          Paid out to contractor: {fmtUsdc(paidOut)} of {fmtUsdc(total)} · completed milestones: {doneCount}/{rows.length}
        </p>
        {isClient && unfunded.length > 0 && (
          <button className="btn" disabled={!!w.busy} onClick={fundAll}>
            Lock {fmtUsdc(unfundedSum)} for {plural(unfunded.length, "unfunded milestone", "unfunded milestones", "unfunded milestones")}
          </button>
        )}
        <p className="muted small">
          Each milestone is a separate protected deal: the contractor delivers the milestone with a link to the work and the client accepts it — or
          the payout happens automatically after the deadline. If they disagree, complaints, settlement and arbitration work just like for purchases.
        </p>
      </section>
      <DealList title="Milestones" rows={rows} empty="No milestones." />
      <p className="muted small">
        <Link href="/" className="plink">
          ← Back to offers
        </Link>
      </p>
    </div>
  );
}
