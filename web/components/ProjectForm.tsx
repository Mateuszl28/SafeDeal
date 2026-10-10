"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Address } from "@/lib/contracts";
import { fmtUsdc, isAddress, parseUsdc, plural, sameAddr } from "@/lib/format";
import { fetchConfig } from "@/lib/solana";
import { Pln } from "@/lib/pln";
import { newProjectId, stageDescription } from "@/lib/project";
import { PERSONAS, useWallet } from "@/lib/wallet";

type StageInput = { name: string; amount: string };

/**
 * Zlecenie w etapach (usługi, freelance): każdy etap to osobna transakcja escrow dla konkretnego klienta.
 * Klient blokuje pieniądze z góry, wykonawca oddaje etap, klient akceptuje — albo wypłata po terminie.
 */
export function ProjectForm() {
  const w = useWallet();
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [client, setClient] = useState("");
  const [stages, setStages] = useState<StageInput[]>([
    { name: "Graphic design", amount: "300" },
    { name: "Implementation", amount: "500" },
  ]);
  const [progress, setProgress] = useState<string>();
  const [err, setErr] = useState<string>();

  const amounts = stages.map((s) => {
    try {
      return parseUsdc(s.amount);
    } catch {
      return 0n;
    }
  });
  const total = amounts.reduce((a, b) => a + b, 0n);
  const clientOk = isAddress(client.trim()) && !sameAddr(client.trim(), w.address);
  const valid = title.trim() && clientOk && stages.length > 0 && stages.every((s, i) => s.name.trim() && amounts[i] > 0n);
  const demoClients = w.mode === "demo" ? PERSONAS.filter((p) => !sameAddr(p.address, w.address)).slice(0, 3) : [];

  async function createStage(index: number, project: string): Promise<bigint | null> {
    const s = stages[index];
    const label = `${title.trim()} — milestone ${index + 1}/${stages.length}: ${s.name.trim()}`.slice(0, 120);
    // Opis ze znacznikiem etapu jest częścią oferty — zapisuje się w tej samej operacji.
    const description = stageDescription(project, index + 1, stages.length, s.name.trim());
    const sig = await w.write(
      "createDeal",
      [{ amount: amounts[index], title: label, buyer: client.trim() as Address, description }],
      { label: `Creating milestone ${index + 1}/${stages.length}` },
    );
    if (!sig || !w.program || !w.deployment) return null;
    return (await fetchConfig(w.program, w.deployment)).dealCount;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || !w.deployment) return;
    setErr(undefined);
    const project = newProjectId();
    for (let i = 0; i < stages.length; i++) {
      setProgress(`Milestone ${i + 1} of ${stages.length}…`);
      const id = await createStage(i, project);
      if (id === null) {
        setErr(`Couldn't create milestone ${i + 1}. Milestones already created are visible on the project page.`);
        break;
      }
    }
    setProgress(undefined);
    router.push(`/projekt/${project}`);
  }

  return (
    <form onSubmit={submit} className="form">
      <label>
        Project name
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Website for a bakery" maxLength={60} />
      </label>
      <label>
        Client <small className="muted">(client's account address — only they can fund the milestones)</small>
        <input value={client} onChange={(e) => setClient(e.target.value)} placeholder="client's account address" />
      </label>
      {demoClients.length > 0 && (
        <div className="templates">
          {demoClients.map((p) => (
            <button type="button" key={p.address} className="chip" onClick={() => setClient(p.address)}>
              Client: {p.name}
            </button>
          ))}
        </div>
      )}

      <fieldset className="stages">
        <legend>Milestones and amounts</legend>
        {stages.map((s, i) => (
          <div key={i} className="stage-row">
            <span className="mono muted">{i + 1}.</span>
            <input
              value={s.name}
              onChange={(e) => setStages(stages.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
              placeholder="Milestone name"
              aria-label={`Milestone ${i + 1} name`}
              maxLength={40}
            />
            <input
              value={s.amount}
              onChange={(e) => setStages(stages.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))}
              placeholder="USDC"
              inputMode="decimal"
              aria-label={`Milestone ${i + 1} amount`}
              className="amount"
            />
            <button
              type="button"
              className="btn ghost sm"
              aria-label={`Remove milestone ${i + 1}`}
              disabled={stages.length === 1}
              onClick={() => setStages(stages.filter((_, j) => j !== i))}
            >
              ✕
            </button>
          </div>
        ))}
        {stages.length < 6 && (
          <button type="button" className="btn ghost sm" onClick={() => setStages([...stages, { name: "", amount: "" }])}>
            + Add milestone
          </button>
        )}
      </fieldset>

      <p className="muted small">
        Total: <b>{fmtUsdc(total)}</b> {total > 0n && <Pln usdc={total} />} · each milestone is a separate protected deal — the client pays
        upfront, and the payout follows milestone approval or happens automatically after the deadline.
      </p>
      <button className="btn" disabled={!valid || !!w.busy || !!progress}>
        {progress ?? `Create project (${plural(stages.length, "milestone", "milestones", "milestones")})`}
      </button>
      {client && !clientOk && <p className="err-text">Enter a client address other than your own.</p>}
      {err && <p className="err-text">{err}</p>}
    </form>
  );
}
