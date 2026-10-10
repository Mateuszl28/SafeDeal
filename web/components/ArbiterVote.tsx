"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { isZeroHash, type ArbiterAccount, type Deal } from "@/lib/contracts";
import { fmtDuration, sameAddr, short } from "@/lib/format";
import { fetchArbiters, randomHex32, voteCommitment } from "@/lib/solana";
import { nameOf, useWallet } from "@/lib/wallet";

type Saved = { forBuyer: boolean; salt: string };

// Sól i wybór muszą przetrwać do fazy ujawniania — trzymamy je lokalnie, nigdy on-chain.
const storageKey = (programId: string, id: bigint, arbiter: string) => `safedeal:vote:${programId}:${id}:${arbiter}`;

function load(key: string): Saved | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Saved) : null;
  } catch {
    return null;
  }
}

function save(key: string, v: Saved) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* brak dostępu do storage — głos i tak zostanie złożony, ale ujawnienie wymaga tej samej przeglądarki */
  }
}

/** Czy adres jest w wylosowanym składzie tej sprawy. */
export const onPanel = (deal: Deal, addr?: string) => deal.panelDrawn && deal.panel.some((a) => sameAddr(a, addr));

/** Stan głosowania widoczny dla wszystkich: ile głosów złożono i w jakiej fazie jesteśmy. */
export function useVotingStatus(deal: Deal) {
  const w = useWallet();
  const panelSize = w.deployment?.panelSize ?? 3;
  const commitEnd = deal.deadline - BigInt(w.deployment?.windows.reveal ?? 0);
  const revealOpen = deal.commitCount >= panelSize || w.now > commitEnd;
  return { commits: deal.commitCount, revealOpen, commitEnd, panelSize, quorum: w.deployment?.arbiterQuorum ?? 0 };
}

/** Losowanie składu: do slotu `drawSlot` nikt nie zna wyniku; potem pchnąć je może każdy. */
function PanelDraw({ deal }: { deal: Deal }) {
  const w = useWallet();
  const [slot, setSlot] = useState<bigint>();

  useEffect(() => {
    w.connection
      .getSlot("confirmed")
      .then((s) => setSlot(BigInt(s)))
      .catch(() => {});
  }, [w.connection, w.refreshKey]);

  const ready = slot !== undefined && slot > deal.drawSlot;
  return (
    <div className="voting">
      <small className="muted">
        The program will draw a panel of 3 arbiters from the open pool — the randomness comes from the hash of slot <span className="mono">{String(deal.drawSlot)}</span>,
        produced only after the dispute was accepted, so nobody (the parties included) could predict it or pick the arbiters. The parties
        can't be drawn onto the panel. <Link href="/arbitrzy" className="plink">Arbiter pool →</Link>
      </small>
      {w.address ? (
        <button className="btn" disabled={!!w.busy || !ready} onClick={() => w.write("drawPanel", [], { deal, label: "Arbiter panel drawn" })}>
          {ready ? "Draw the arbiter panel" : "Waiting for the draw slot…"}
        </button>
      ) : (
        <small className="muted">Anyone can trigger the draw — including the relayer, which does it automatically.</small>
      )}
    </div>
  );
}

export function VotingStatus({ deal }: { id?: bigint; deal: Deal }) {
  const w = useWallet();
  const v = useVotingStatus(deal);
  const [stats, setStats] = useState<(ArbiterAccount | null)[]>([]);

  useEffect(() => {
    if (!w.program || !deal.panelDrawn) return;
    fetchArbiters(w.program, deal.panel)
      .then(setStats)
      .catch(() => {});
  }, [w.program, w.refreshKey, deal.panelDrawn, deal.panel]);

  if (!deal.panelDrawn) return <PanelDraw deal={deal} />;

  return (
    <div className="voting">
      <small className="muted">
        The case is decided by {v.panelSize} arbiters drawn from the open pool. {v.quorum} matching votes decide.
      </small>
      <div className={`phase ${!v.revealOpen ? "on" : "done"}`}>
        <b>Phase 1 · secret votes</b>
        <span>
          {v.commits}/{v.panelSize} cast
          {!v.revealOpen && v.commitEnd > w.now && <> · {fmtDuration(v.commitEnd - w.now)} left</>}
        </span>
      </div>
      <div className={`phase ${v.revealOpen ? "on" : ""}`}>
        <b>Phase 2 · reveal</b>
        <span>
          {deal.votesBuyer} for the buyer · {deal.votesSeller} for the seller ({v.quorum} decide)
        </span>
      </div>
      <small className="muted">
        Until phase 1 ends, only vote hashes are visible on the blockchain — no arbiter knows how the others voted.
      </small>
      <ul className="arb-stats">
        {deal.panel.map((a, i) => (
          <li key={a}>
            <span>
              <Link href={`/u/${a}`} className="plink">
                {nameOf(a) ?? short(a)}
              </Link>{" "}
              <small className="muted">
                {deal.votes[i] ? "· vote revealed" : !isZeroHash(deal.commits[i]) ? "· vote cast" : "· hasn't voted yet"}
              </small>
            </span>
            {stats[i] && (
              <span className="muted" title="with the verdict · against · missed">
                ✓ {stats[i]!.withMajority} · ✗ {stats[i]!.againstMajority} · ∅ {stats[i]!.missed}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ArbiterVote({ id, deal }: { id: bigint; deal: Deal }) {
  const w = useWallet();
  const v = useVotingStatus(deal);
  const [saved, setSaved] = useState<Saved | null>(null);

  const idx = deal.panelDrawn ? deal.panel.findIndex((a) => sameAddr(a, w.address)) : -1;
  const key = w.deployment && w.address ? storageKey(w.deployment.programId, id, w.address) : "";

  useEffect(() => {
    setSaved(key ? load(key) : null);
  }, [key, w.refreshKey]);

  if (idx < 0) return null;
  const committed = !isZeroHash(deal.commits[idx]);
  const revealed = deal.votes[idx] ?? 0;

  async function commit(forBuyer: boolean) {
    if (!w.address) return;
    const salt = randomHex32();
    const commitment = await voteCommitment(id, w.address, forBuyer, salt);
    save(key, { forBuyer, salt });
    setSaved({ forBuyer, salt });
    await w.write("commitVote", [commitment], { deal, label: "Secret vote cast" });
  }

  async function reveal() {
    if (!saved) return;
    await w.write("revealVote", [saved.forBuyer, saved.salt], { deal, label: "Vote revealed" });
  }

  const side = (b: boolean) => (b ? "for the buyer" : "for the seller");

  if (revealed) return <p className="muted">Your vote ({side(revealed === 1)}) is revealed and counted.</p>;

  if (!committed) {
    if (v.revealOpen) return <p className="muted">The secret voting phase is over — you didn't vote (part of your bond will be burned).</p>;
    return (
      <>
        <p className="muted small">
          You've been drawn for this case. Your choice goes on-chain as a hash — the other arbiters won't see it. Not voting
          costs part of your bond.
        </p>
        <div className="inline">
          <button className="btn" disabled={!!w.busy} onClick={() => commit(true)}>
            The buyer is right
          </button>
          <button className="btn" disabled={!!w.busy} onClick={() => commit(false)}>
            The seller is right
          </button>
        </div>
      </>
    );
  }

  if (!v.revealOpen) {
    return (
      <p className="muted">
        Vote cast{saved ? ` (${side(saved.forBuyer)})` : ""} — waiting for the other arbiters ({v.commits}/{v.panelSize}).
      </p>
    );
  }

  return saved ? (
    <button className="btn" disabled={!!w.busy} onClick={reveal}>
      Reveal your vote ({side(saved.forBuyer)})
    </button>
  ) : (
    <p className="err-text">No saved salt in this browser — the vote can't be revealed.</p>
  );
}
