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
        Skład 3 arbitrów wylosuje program z otwartej puli — źródłem losowości jest hash slotu <span className="mono">{String(deal.drawSlot)}</span>,
        który powstał dopiero po przyjęciu sporu, więc nikt (także strony) nie mógł go przewidzieć ani wybrać arbitrów. Strony sporu
        nie mogą trafić do składu. <Link href="/arbitrzy" className="plink">Pula arbitrów →</Link>
      </small>
      {w.address ? (
        <button className="btn" disabled={!!w.busy || !ready} onClick={() => w.write("drawPanel", [], { deal, label: "Wylosowano skład arbitrów" })}>
          {ready ? "Losuj skład arbitrów" : "Czekamy na slot losowania…"}
        </button>
      ) : (
        <small className="muted">Losowanie może uruchomić każdy — także relayer, który robi to automatycznie.</small>
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
        Sprawę rozstrzyga {v.panelSize} arbitrów wylosowanych z otwartej puli. Decyduje {v.quorum} zgodnych głosów.
      </small>
      <div className={`phase ${!v.revealOpen ? "on" : "done"}`}>
        <b>Faza 1 · niejawne głosy</b>
        <span>
          {v.commits}/{v.panelSize} złożonych
          {!v.revealOpen && v.commitEnd > w.now && <> · zostało {fmtDuration(v.commitEnd - w.now)}</>}
        </span>
      </div>
      <div className={`phase ${v.revealOpen ? "on" : ""}`}>
        <b>Faza 2 · ujawnianie</b>
        <span>
          {deal.votesBuyer} za kupującym · {deal.votesSeller} za sprzedawcą (rozstrzyga {v.quorum})
        </span>
      </div>
      <small className="muted">
        Do końca fazy 1 w blockchainie widać tylko odciski (hashe) głosów — żaden arbiter nie wie, jak głosowali inni.
      </small>
      <ul className="arb-stats">
        {deal.panel.map((a, i) => (
          <li key={a}>
            <span>
              <Link href={`/u/${a}`} className="plink">
                {nameOf(a) ?? short(a)}
              </Link>{" "}
              <small className="muted">
                {deal.votes[i] ? "· głos ujawniony" : !isZeroHash(deal.commits[i]) ? "· głos złożony" : "· jeszcze nie głosował"}
              </small>
            </span>
            {stats[i] && (
              <span className="muted" title="zgodnie z werdyktem · przeciw · nieobecny">
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
    await w.write("commitVote", [commitment], { deal, label: "Złożono niejawny głos" });
  }

  async function reveal() {
    if (!saved) return;
    await w.write("revealVote", [saved.forBuyer, saved.salt], { deal, label: "Ujawniono głos" });
  }

  const side = (b: boolean) => (b ? "za kupującym" : "za sprzedawcą");

  if (revealed) return <p className="muted">Twój głos ({side(revealed === 1)}) jest ujawniony i policzony.</p>;

  if (!committed) {
    if (v.revealOpen) return <p className="muted">Faza niejawnych głosów minęła — nie oddałeś głosu (część kaucji zostanie spalona).</p>;
    return (
      <>
        <p className="muted small">
          Zostałeś wylosowany do tej sprawy. Twój wybór trafi do blockchaina jako odcisk (hash) — inni arbitrzy go nie zobaczą. Brak głosu
          kosztuje część kaucji.
        </p>
        <div className="inline">
          <button className="btn" disabled={!!w.busy} onClick={() => commit(true)}>
            Rację ma kupujący
          </button>
          <button className="btn" disabled={!!w.busy} onClick={() => commit(false)}>
            Rację ma sprzedawca
          </button>
        </div>
      </>
    );
  }

  if (!v.revealOpen) {
    return (
      <p className="muted">
        Głos złożony{saved ? ` (${side(saved.forBuyer)})` : ""} — czekamy na pozostałych arbitrów ({v.commits}/{v.panelSize}).
      </p>
    );
  }

  return saved ? (
    <button className="btn" disabled={!!w.busy} onClick={reveal}>
      Ujawnij swój głos ({side(saved.forBuyer)})
    </button>
  ) : (
    <p className="err-text">Brak zapisanej soli w tej przeglądarce — głosu nie da się ujawnić.</p>
  );
}
