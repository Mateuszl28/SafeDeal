"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { State, isFinal, isZeroHash } from "@/lib/contracts";
import { parseStage } from "@/lib/project";
import { sameAddr } from "@/lib/format";
import { fetchDeal } from "@/lib/solana";
import { PERSONAS, useWallet, type Persona } from "@/lib/wallet";

type Step = { title: string; hint: string; actor?: Persona };

const byAddress = (addr: string) => PERSONAS.find((p) => sameAddr(p.address, addr));
const ALICJA = PERSONAS[0];
const BARTEK = PERSONAS[1];

const EXPLORER = "Click “↗ Explorer” next to a history entry — the same operation is visible in the public Solana Explorer, without our app.";

/**
 * Podpowiada prezenterowi następny krok na podstawie stanu transakcji w sieci (devnet)
 * i jednym kliknięciem przełącza na osobę, która ma teraz ruch. Działa tylko w trybie demo.
 * Na devnecie nie da się przewinąć czasu — terminy są krótkie (kilka minut).
 */
export function DemoGuide() {
  const w = useWallet();
  const path = usePathname();
  const [open, setOpen] = useState(true);
  // Na telefonie przewodnik zasłaniałby pół ekranu — startuje zwinięty.
  useEffect(() => {
    if (window.matchMedia("(max-width: 760px)").matches) setOpen(false);
  }, []);
  const [step, setStep] = useState<Step | null>(null);
  const dealId = path.startsWith("/deal/") ? path.split("/")[2] : null;

  useEffect(() => {
    if (w.mode !== "demo" || !w.deployment || !w.program) return setStep(null);
    const dep = w.deployment;
    const program = w.program;

    if (!dealId || !/^\d+$/.test(dealId)) {
      if (path === "/")
        setStep({
          title: "Alicja lists an offer",
          hint: "Enter a title, price and description, add a photo, then click “Create offer and link”. Or open one of the deals from the list. No funds? Use the test USDC faucet and the “+ SOL” button.",
          actor: ALICJA,
        });
      else if (path.startsWith("/projekt/"))
        setStep({
          title: "Milestone project",
          hint: "Same program, different use case: each milestone is a separate protected deal. The client funds the milestones upfront, the contractor delivers them with a link to the work, and the client accepts — or the payout happens after the deadline. Open a milestone to continue.",
        });
      else if (path === "/stats")
        setStep({
          title: "Live transparency",
          hint: "Show the amount locked in vaults, the dispute rate and the “Rules of the game”: delivery sources, the arbiter council and deadlines are fixed — there is no admin who could change them. Click the program address to show it in Solana Explorer.",
        });
      else setStep({ title: "Back to offers", hint: "The guide walks you through a deal — open one from the list on the home page." });
      return;
    }

    (async () => {
      const d = await fetchDeal(program, dep, BigInt(dealId));
      if (!d) return setStep(null);
      const seller = byAddress(d.seller) ?? ALICJA;
      const buyer = byAddress(d.buyer) ?? BARTEK;
      const s = d.state as State;
      const stage = parseStage(d.description);
      const left = Number(d.deadline - w.now);
      const wait = left > 0 ? "wait a few minutes for the deadline to pass" : "the deadline has passed";

      if (s === State.Created)
        return setStep({
          title: "The buyer pays into the deal vault",
          hint: "Click “Buy and lock”. Show that Alicja's balance doesn't change — the money is held by the program, not the seller or us. Bonus: switch to Celina — a stranger can't do anything here.",
          actor: buyer,
        });
      if (stage && s === State.Funded)
        return setStep({
          title: `The contractor delivers milestone ${stage.index}/${stage.total}`,
          hint: "Enter a link to the work and click “Deliver milestone”. The client will see it and accept — or after the deadline the payout happens on its own.",
          actor: seller,
        });
      if (stage && s === State.Shipped)
        return setStep({
          title: "The client approves the milestone",
          hint: "“Approve milestone — pay the contractor” pays the contractor immediately. If they disagree: complaint, settlement or arbitration — just like for purchases.",
          actor: buyer,
        });
      if (s === State.Funded && !isZeroHash(d.pickupHash))
        return setStep({
          title: "Meeting and pickup code",
          hint: "The buyer inspects the item and only then shows the code. Click “Demo: scan the code as…” — the seller sees ✓ and collects the money with one click.",
          actor: buyer,
        });
      if (s === State.Funded)
        return setStep({
          title: "The seller ships the parcel",
          hint: `Enter the tracking number and click “Parcel shipped”. Alternative scenario: the seller does nothing — ${wait}, then “Settle now” = automatic refund to the buyer.`,
          actor: seller,
        });
      if (s === State.Shipped)
        return setStep({
          title: "Status sources confirm delivery",
          hint: "In the demo panel click one source — counter 1/2, the parcel is still in transit. Click a second one — delivered. One source isn't enough. The buyer can also click “Confirm receipt” right away.",
        });
      if (s === State.Delivered)
        return setStep({
          title: "The buyer checks the parcel",
          hint: `Three paths: “All good” (confirm receipt), a complaint with a photo, or a settlement (slider). Or do nothing: ${wait}, then “Settle now” = payout to the seller. ${EXPLORER}`,
          actor: buyer,
        });
      if (s === State.Disputed)
        return setStep({
          title: "The seller responds to the complaint",
          hint: "“I disagree — go to arbitration” (with a bond) or “Accept the complaint and refund”. You can also propose a settlement first.",
          actor: seller,
        });
      if (s === State.InArbitration) {
        if (!d.panelDrawn)
          return setStep({
            title: "The program draws the arbiter panel",
            hint: "Click “Draw the arbiter panel” (anyone can do it, including the relayer). The result depends on a slot hash created only after the dispute was accepted — the parties don't pick the arbiters. A history entry with the drawn panel will appear.",
          });
        const revealOpen = d.commitCount >= dep.panelSize || w.now > d.deadline - BigInt(dep.windows.reveal);
        for (const [i, a] of d.panel.entries()) {
          const arb = byAddress(a);
          if (!arb) continue;
          const committed = !isZeroHash(d.commits[i]);
          if (!revealOpen && !committed)
            return setStep({
              title: `${arb.name} casts a secret vote`,
              hint: "Pick a side — only a fingerprint of the vote is stored on-chain, so nobody knows how anyone voted. Show the “casts a sealed vote” entry in the history.",
              actor: arb,
            });
          if (revealOpen && committed && d.votes[i] === 0)
            return setStep({
              title: `${arb.name} reveals the vote`,
              hint: "Everyone has voted — now the reveal. Once a majority agrees, the program pays out on its own.",
              actor: arb,
            });
        }
        return setStep({ title: "Waiting for the verdict", hint: `If the arbiters stay silent: ${wait}, then “Settle now” = 50/50 split.` });
      }
      if (isFinal(s))
        return setStep({
          title: "Deal closed",
          hint: d.archived
            ? `Accounts closed, rent returned to the seller — the page still works because the description is in the chain history. ${EXPLORER}`
            : `The parties can now review each other — once, stored permanently. Finally, “Close accounts and return rent to the seller” (anyone can). Show the “Deal history” and the “Receipt (PDF)”. ${EXPLORER}`,
        });
    })().catch(() => setStep(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w.mode, w.deployment, w.program, w.refreshKey, path, dealId]);

  if (w.mode !== "demo" || !step) return null;
  const needSwitch = step.actor && !sameAddr(step.actor.address, w.address);

  return (
    <aside className={`guide ${open ? "" : "closed"}`} aria-label="Demo guide">
      <button className="guide-head" onClick={() => setOpen((o) => !o)}>
        <span>🧭 Demo guide</span>
        <span className="muted">{open ? "collapse" : "expand"}</span>
      </button>
      {open && (
        <div className="guide-body">
          <b>{step.title}</b>
          <p>{step.hint}</p>
          {needSwitch && (
            <button className="btn sm" onClick={() => w.setPersona(step.actor!)}>
              Switch to: {step.actor!.name}
            </button>
          )}
          {step.actor && !needSwitch && <span className="muted small">You are now: {step.actor.name} ✓</span>}
        </div>
      )}
    </aside>
  );
}
