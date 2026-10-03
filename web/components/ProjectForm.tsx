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
    { name: "Projekt graficzny", amount: "300" },
    { name: "Wdrożenie", amount: "500" },
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
    const label = `${title.trim()} — etap ${index + 1}/${stages.length}: ${s.name.trim()}`.slice(0, 120);
    // Opis ze znacznikiem etapu jest częścią oferty — zapisuje się w tej samej operacji.
    const description = stageDescription(project, index + 1, stages.length, s.name.trim());
    const sig = await w.write(
      "createDeal",
      [{ amount: amounts[index], title: label, buyer: client.trim() as Address, description }],
      { label: `Tworzę etap ${index + 1}/${stages.length}` },
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
      setProgress(`Etap ${i + 1} z ${stages.length}…`);
      const id = await createStage(i, project);
      if (id === null) {
        setErr(`Nie udało się utworzyć etapu ${i + 1}. Utworzone etapy są widoczne na stronie projektu.`);
        break;
      }
    }
    setProgress(undefined);
    router.push(`/projekt/${project}`);
  }

  return (
    <form onSubmit={submit} className="form">
      <label>
        Nazwa zlecenia
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="np. Strona internetowa dla piekarni" maxLength={60} />
      </label>
      <label>
        Klient <small className="muted">(adres konta klienta — tylko on może opłacić etapy)</small>
        <input value={client} onChange={(e) => setClient(e.target.value)} placeholder="adres konta klienta" />
      </label>
      {demoClients.length > 0 && (
        <div className="templates">
          {demoClients.map((p) => (
            <button type="button" key={p.address} className="chip" onClick={() => setClient(p.address)}>
              Klient: {p.name}
            </button>
          ))}
        </div>
      )}

      <fieldset className="stages">
        <legend>Etapy i kwoty</legend>
        {stages.map((s, i) => (
          <div key={i} className="stage-row">
            <span className="mono muted">{i + 1}.</span>
            <input
              value={s.name}
              onChange={(e) => setStages(stages.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
              placeholder="Nazwa etapu"
              aria-label={`Nazwa etapu ${i + 1}`}
              maxLength={40}
            />
            <input
              value={s.amount}
              onChange={(e) => setStages(stages.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))}
              placeholder="USDC"
              inputMode="decimal"
              aria-label={`Kwota etapu ${i + 1}`}
              className="amount"
            />
            <button
              type="button"
              className="btn ghost sm"
              aria-label={`Usuń etap ${i + 1}`}
              disabled={stages.length === 1}
              onClick={() => setStages(stages.filter((_, j) => j !== i))}
            >
              ✕
            </button>
          </div>
        ))}
        {stages.length < 6 && (
          <button type="button" className="btn ghost sm" onClick={() => setStages([...stages, { name: "", amount: "" }])}>
            + Dodaj etap
          </button>
        )}
      </fieldset>

      <p className="muted small">
        Razem: <b>{fmtUsdc(total)}</b> {total > 0n && <Pln usdc={total} />} · każdy etap to osobna chroniona transakcja — klient płaci z
        góry, wypłata po akceptacji etapu albo automatycznie po terminie.
      </p>
      <button className="btn" disabled={!valid || !!w.busy || !!progress}>
        {progress ?? `Utwórz zlecenie (${plural(stages.length, "etap", "etapy", "etapów")})`}
      </button>
      {client && !clientOk && <p className="err-text">Podaj adres klienta innego niż Twój.</p>}
      {err && <p className="err-text">{err}</p>}
    </form>
  );
}
