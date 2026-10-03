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

const EXPLORER = "Kliknij „↗ Explorer” przy wpisie w historii — ta sama operacja widoczna w publicznym Solana Explorer, bez naszej aplikacji.";

/**
 * Podpowiada prezenterowi następny krok na podstawie stanu transakcji w sieci (devnet)
 * i jednym kliknięciem przełącza na osobę, która ma teraz ruch. Działa tylko w trybie demo.
 * Na devnecie nie da się przewinąć czasu — terminy są krótkie (kilka minut).
 */
export function DemoGuide() {
  const w = useWallet();
  const path = usePathname();
  const [open, setOpen] = useState(true);
  const [step, setStep] = useState<Step | null>(null);
  const dealId = path.startsWith("/deal/") ? path.split("/")[2] : null;

  useEffect(() => {
    if (w.mode !== "demo" || !w.deployment || !w.program) return setStep(null);
    const dep = w.deployment;
    const program = w.program;

    if (!dealId || !/^\d+$/.test(dealId)) {
      if (path === "/")
        setStep({
          title: "Alicja wystawia ofertę",
          hint: "Wpisz tytuł, cenę, opis i dodaj zdjęcie, potem kliknij „Utwórz ofertę i link”. Albo otwórz jedną z transakcji z listy. Brak środków? Użyj kranu testowego USDC i przycisku „+ SOL”.",
          actor: ALICJA,
        });
      else if (path.startsWith("/projekt/"))
        setStep({
          title: "Zlecenie w etapach",
          hint: "Ten sam program, inny przypadek: każdy etap to osobna chroniona transakcja. Klient opłaca etapy z góry, wykonawca oddaje je z linkiem do efektu pracy, a klient akceptuje — albo wypłata następuje po terminie. Otwórz etap, żeby przejść dalej.",
        });
      else if (path === "/stats")
        setStep({
          title: "Przejrzystość na żywo",
          hint: "Pokaż kwotę zablokowaną w sejfach, odsetek sporów i „Reguły gry”: źródła doręczeń, rada arbitrów i terminy są zapisane na stałe — nie ma administratora, który mógłby je zmienić. Kliknij adres programu, żeby pokazać go w Solana Explorer.",
        });
      else setStep({ title: "Wróć do ofert", hint: "Przewodnik prowadzi przez transakcję — otwórz ją z listy na stronie głównej." });
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
      const wait = left > 0 ? "poczekaj kilka minut, aż minie termin" : "termin już minął";

      if (s === State.Created)
        return setStep({
          title: "Kupujący płaci do sejfu transakcji",
          hint: "Kliknij „Kup i zablokuj”. Pokaż, że saldo Alicji się nie zmienia — pieniądze trzyma program, nie sprzedawca ani my. Bonus: przełącz na Celinę, obca osoba nic tu nie zrobi.",
          actor: buyer,
        });
      if (stage && s === State.Funded)
        return setStep({
          title: `Wykonawca oddaje etap ${stage.index}/${stage.total}`,
          hint: "Wpisz link do efektu pracy i kliknij „Oddaję etap”. Klient zobaczy go i zaakceptuje — albo po terminie wypłata nastąpi sama.",
          actor: seller,
        });
      if (stage && s === State.Shipped)
        return setStep({
          title: "Klient akceptuje etap",
          hint: "„Akceptuję etap” wypłaca wykonawcy od razu. Przy niezgodzie: reklamacja, ugoda albo arbitraż — tak samo jak przy zakupach.",
          actor: buyer,
        });
      if (s === State.Funded && !isZeroHash(d.pickupHash))
        return setStep({
          title: "Spotkanie i kod odbioru",
          hint: "Kupujący ogląda przedmiot i dopiero wtedy pokazuje kod. Kliknij „Demo: zeskanuj kod jako…” — sprzedawca zobaczy ✓ i odbierze pieniądze jednym kliknięciem.",
          actor: buyer,
        });
      if (s === State.Funded)
        return setStep({
          title: "Sprzedawca nadaje paczkę",
          hint: `Wpisz numer przesyłki i kliknij „Nadałem paczkę”. Scenariusz alternatywny: sprzedawca nic nie robi — ${wait}, potem „Rozlicz teraz” = automatyczny zwrot dla kupującego.`,
          actor: seller,
        });
      if (s === State.Shipped)
        return setStep({
          title: "Źródła statusu potwierdzają doręczenie",
          hint: "W panelu demo kliknij jedno źródło — licznik 1/2, paczka nadal w drodze. Kliknij drugie — doręczona. Jedno źródło nie wystarczy. Kupujący może też od razu kliknąć „Potwierdzam odbiór”.",
        });
      if (s === State.Delivered)
        return setStep({
          title: "Kupujący sprawdza paczkę",
          hint: `Trzy drogi: „Wszystko OK” (potwierdź odbiór), reklamacja ze zdjęciem albo ugoda (suwak). Albo nic nie rób: ${wait}, potem „Rozlicz teraz” = wypłata dla sprzedawcy. ${EXPLORER}`,
          actor: buyer,
        });
      if (s === State.Disputed)
        return setStep({
          title: "Sprzedawca odpowiada na reklamację",
          hint: "„Nie zgadzam się — arbitraż” (z kaucją) albo „Uznaj reklamację”. Możesz też najpierw zaproponować ugodę.",
          actor: seller,
        });
      if (s === State.InArbitration) {
        const revealOpen = d.commitCount >= dep.arbiters.length || w.now > d.deadline - BigInt(dep.windows.reveal);
        for (const [i, a] of dep.arbiters.entries()) {
          const arb = byAddress(a);
          if (!arb) continue;
          const committed = !isZeroHash(d.commits[i]);
          if (!revealOpen && !committed)
            return setStep({
              title: `${arb.name} głosuje niejawnie`,
              hint: "Wybierz stronę — w sieci zapisuje się tylko odcisk głosu, więc nikt nie wie, jak ktoś zagłosował. Pokaż w historii wpis „oddaje niejawny głos”.",
              actor: arb,
            });
          if (revealOpen && committed && d.votes[i] === 0)
            return setStep({
              title: `${arb.name} ujawnia głos`,
              hint: "Wszyscy zagłosowali — teraz ujawnianie. Po zgodnych głosach większości program sam wypłaca pieniądze.",
              actor: arb,
            });
        }
        return setStep({ title: "Czekamy na werdykt", hint: `Jeśli arbitrzy milczą: ${wait}, potem „Rozlicz teraz” = podział 50/50.` });
      }
      if (isFinal(s))
        return setStep({
          title: "Transakcja zamknięta",
          hint: `Strony mogą teraz wystawić sobie opinie — raz, zapisane na stałe. Pokaż „Historię transakcji”, „Potwierdzenie (PDF)” i stronę „Statystyki”. ${EXPLORER}`,
        });
    })().catch(() => setStep(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w.mode, w.deployment, w.program, w.refreshKey, path, dealId]);

  if (w.mode !== "demo" || !step) return null;
  const needSwitch = step.actor && !sameAddr(step.actor.address, w.address);

  return (
    <aside className={`guide ${open ? "" : "closed"}`} aria-label="Przewodnik demo">
      <button className="guide-head" onClick={() => setOpen((o) => !o)}>
        <span>🧭 Przewodnik demo</span>
        <span className="muted">{open ? "zwiń" : "rozwiń"}</span>
      </button>
      {open && (
        <div className="guide-body">
          <b>{step.title}</b>
          <p>{step.hint}</p>
          {needSwitch && (
            <button className="btn sm" onClick={() => w.setPersona(step.actor!)}>
              Przełącz na: {step.actor!.name}
            </button>
          )}
          {step.actor && !needSwitch && <span className="muted small">Jesteś teraz: {step.actor.name} ✓</span>}
        </div>
      )}
    </aside>
  );
}
