# Scenariusz filmu (≤ 3:00)

Przygotowanie: devnet, `npm run dev` w `web/`, tryb „Demo (persony)”, świeża karta przeglądarki.
Nagrywaj ekran w 1080p. Mów spokojnie — tekst poniżej to ok. 2:50.

| Czas | Ekran | Co mówisz |
|---|---|---|
| 0:00–0:20 | Strona główna | „Kupujesz rower z ogłoszenia od obcej osoby. Zapłacisz pierwszy — ryzykujesz pustą paczkę. Ona wyśle pierwsza — ryzykuje brak zapłaty. Albo ufasz platformie, która bierze prowizję i sama rozstrzyga spory. SafeDeal usuwa tę potrzebę zaufania.” |
| 0:20–0:40 | Alicja: formularz → „Utwórz ofertę” → toast z Explorerem | „Alicja wystawia rower za 250 USDC. Opis i hash zdjęcia zapisują się na Solanie — po wpłacie nie da się ich zmienić.” |
| 0:40–1:10 | Bartek: „Kup i zablokuj” → pasek sejfu (250 USDC) → klik „zobacz w Solana Explorer” | „Bartek płaci. Pieniądze nie trafiają do Alicji ani do nas — leżą w sejfie, którego właścicielem jest program. Nikt nie ma do niego klucza. Tu transakcja w Explorerze.” |
| 1:10–1:30 | Panel „Kto może teraz ruszyć te pieniądze?” | „Ten panel to moment, w którym pośrednik znika: pieniądze wyjdą tylko pod warunkami z kodu. Alicja nie wypłaci sobie wcześniej, Bartek nie cofnie przelewu, my też nie — program nie ma instrukcji administratora.” |
| 1:30–1:50 | Strona „Dla jury” → „Spróbuj oszukać program” → 2–3 kliknięcia | „Spróbujmy oszukać program: wypłata prosto z sejfu, przekierowanie zwrotu na własne konto, potwierdzenie za kupującego. Każda próba to prawdziwa transakcja w sieci — i każdą odrzuca kod on-chain.” |
| 1:50–2:20 | Wróć do transakcji: Alicja „Nadałem paczkę” (DEMO-123) → panel demo: 1/2 → 2/2 → Bartek „Wszystko OK” → sejf 0 USDC | „Alicja nadaje paczkę. Doręczenie liczy się dopiero, gdy potwierdzą je 2 z 3 niezależnych źródeł — jedno nie wystarcza. Bartek potwierdza odbiór i program od razu wypłaca Alicji.” |
| 2:20–2:40 | Tabela „Co jeśli ktoś zniknie” (README/slajd) albo panel z terminem | „A jeśli ktoś zniknie? Każdy stan ma termin i z góry znany wynik: brak nadania — zwrot, brak reklamacji — wypłata, arbitrzy milczą — 50/50. Rozliczyć po terminie może każdy.” |
| 2:40–2:55 | Przycisk „Kopiuj link Blink” / karta oferty | „Ofertę można wkleić jako Blink w post albo czat — kupujący płaci jednym podpisem, nawet bez SOL, bo opłatę pokrywa sponsor.” |
| 2:55–3:00 | Logo / adres programu | „SafeDeal: pieniądze trzyma kod, nie pośrednik.” |

Uwagi:
- Terminy na devnecie są w minutach — nagrywaj jednym ciągiem albo przygotuj transakcję wcześniej.
- Jeśli coś się wysypie na żywo, powiedz wprost, co i dlaczego — jury to docenia (wytyczne, sekcja 6).
