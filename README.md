# SafeDeal — kupuj od obcych bez pośrednika (Solana)

> Kupujesz rower z ogłoszenia od kogoś, kogo nie znasz. Zapłacisz pierwszy — ryzykujesz, że nic nie przyjdzie.
> On wyśle pierwszy — ryzykuje, że nie zapłacisz. **SafeDeal** usuwa ten problem: pieniądze trzyma program na
> Solanie, a reguły wypłaty wykonują się same — identycznie dla każdego, bez możliwości jednostronnej zmiany.

**Dla kogo:** osoby kupujące i sprzedające używane rzeczy od obcych (OLX, Vinted, grupy na Facebooku) oraz
drobni wykonawcy rozliczający się z klientem w etapach. To ludzie spoza świata krypto — interfejs mówi
„sejf”, „paczka”, „reklamacja”, a nie „PDA” czy „lamporty”. Warstwa techniczna jest pod spodem, ale
na życzenie widoczna: każda akcja ma link do Solana Explorer.

**Na żywo (Solana devnet):** program `B7aMTf719JpBybXggkHyFsAKemfM6eNbAU6mA7rUzJmn` —
[Solana Explorer](https://explorer.solana.com/address/B7aMTf719JpBybXggkHyFsAKemfM6eNbAU6mA7rUzJmn?cluster=devnet).

## Uzasadnienie projektowe

**Jaka relacja finansowa:** zakup z ogłoszenia między obcymi ludźmi (płatność za towar z wysyłką albo z
odbiorem osobistym; także zlecenie w etapach).

**Kto był pośrednikiem:** dziś są dwie opcje i obie są złe.
1. *Brak pośrednika* — ktoś musi zaufać pierwszy. Oszustwa „na kupującego” i „na sprzedającego” to codzienność
   ogłoszeń, a po przelewie BLIK nie ma odwrotu.
2. *Platforma z „bezpieczną płatnością”* (np. Allegro Smart, OLX Przesyłka, PayPal) — trzyma pieniądze, pobiera
   prowizję, sama rozstrzyga spory według własnego regulaminu, może zablokować konto lub wypłatę, działa tylko
   wewnątrz swojego serwisu i swojego kraju. Ufasz firmie, nie regule.

**Co zmienia usunięcie pośrednika:** pieniądze kupującego trafiają do **sejfu, którego właścicielem jest adres
programu (PDA)** — nie człowiek, nie firma, nie my. Żadna osoba nie ma klucza do sejfu. Z sejfu można wypłacić
tylko przez instrukcje programu, a każda ma zapisany warunek: potwierdzenie kupującego, kworum oracle'i
doręczenia, kod odbioru, werdykt arbitrów albo upływ terminu. Każdy stan ma termin i z góry znany wynik, więc
**nikt nie zamrozi pieniędzy, znikając** — a rozliczenie po terminie może „pchnąć” *dowolna* osoba.
Zostaje opłata sieci (ułamek grosza) zamiast kilku procent prowizji, i działa to między dowolnymi dwiema osobami,
w dowolnym serwisie z ogłoszeniami — wystarczy link.

## Jak to działa

```
Created ──fund──▶ Funded ──mark_shipped──▶ Shipped ──2 z 3 oracle'i──▶ Delivered ──(okno reklamacji)──▶ Released ✔
   │                 │                        │                            │
 cancel          (termin)               open_dispute ◀────────────────────┘
   ▼                 ▼                        ▼
Cancelled ✔      Refunded ✔              Disputed ──(sprzedawca ignoruje)──▶ Refunded ✔
                                              │
                                   respond_to_dispute (kaucja)
                                              ▼
                                       InArbitration ──2 z 3 głosów──▶ Refunded / Released ✔
                                              └──(arbitrzy milczą)──▶ Split 50/50 ✔
```

**Moment, w którym pośrednik przestaje być potrzebny (demo):** na stronie każdej transakcji panel
**„Kto może teraz ruszyć te pieniądze?”** wylicza z reguł programu, dokąd i pod jakim warunkiem mogą trafić środki
z sejfu (z nazwą instrukcji i znacznikiem „może każdy” przy rozliczeniach po terminie) — oraz kto *nie może*:
sprzedawca przed spełnieniem warunku, kupujący (nie cofnie wpłaty) i autorzy SafeDeal. Dalej: Bartek klika „Kup” → na stronie transakcji pasek
„Pieniądze trzyma program, nie sprzedawca” pokazuje sejf z kwotą, link prowadzi do konta sejfu w Solana Explorer.
Alicja jeszcze nic nie ma, a Celina (obca osoba) próbuje cokolwiek zrobić i program odmawia. Po potwierdzeniu
doręczenia przez 2 z 3 niezależnych źródeł i upływie okna reklamacji wypłatę może wywołać ktokolwiek — także
osoba spoza transakcji.

## Pytania jury — odpowiedzi z odnośnikami do kodu

W aplikacji jest strona **`/jury` („Dla jury: sprawdź sam”)**: odczytany z łańcucha status upgrade authority programu
(czy autor wciąż może zmienić kod), niezmienne reguły z konta konfiguracji oraz **„Spróbuj oszukać program”** —
przyciski budujące prawdziwe nieuczciwe transakcje (wypłata z sejfu z pominięciem programu, zwrot „kupującemu” na
własne konto, potwierdzenie odbioru za kupującego, rozliczenie przed terminem) i symulujące je w sieci
(`simulateTransaction`: ta sama walidacja, bez opłat). Widać, który program je odrzuca i z jakim błędem.

Program: [`solana/programs/safedeal/src/lib.rs`](solana/programs/safedeal/src/lib.rs) (Anchor 0.32).

**Gdzie dokładnie znika pośrednik?**
- Sejf: konto tokenowe z `token::authority = deal` (PDA transakcji) — `CreateDeal`, ok. linii 790–800.
- Jedyna droga wypłaty z sejfu: `pay_raw` (ok. l. 558) — podpisuje ją PDA, czyli sam program (`new_with_signer`
  z seedami `["deal", id]`). Wywołują ją wyłącznie instrukcje z warunkami: `confirm_receipt`, `confirm_pickup`,
  `refund_buyer`, `accept_settlement`, `settle_expired`, `reveal_vote` (→ `resolve`).
- Konta odbiorców w `Payout` (ok. l. 890) są przypięte do adresów zapisanych w transakcji
  (`buyer_ata.owner == deal.buyer`) — wywołujący nie może podstawić własnego konta.
- `settle_expired` (ok. l. 426): wynik po terminie zależy wyłącznie od stanu — bez niczyjej zgody.

**Co jeśli ktoś zniknie w połowie?** Środki leżą w sejfie danej transakcji (widać go w Explorerze), a po terminie
**każdy** może wywołać `settle_expired`:

| Kto znika | Co się dzieje |
|---|---|
| sprzedawca nie nadaje paczki | zwrot dla kupującego po oknie nadania |
| kupujący nie potwierdza odbioru | wypłata dla sprzedawcy po oknie reklamacji |
| oracle milczą, kupujący nie reklamuje | wypłata dla sprzedawcy po `transit + inspection` |
| sprzedawca ignoruje reklamację | kupujący wygrywa (kwota + jego kaucja) |
| arbitrzy nie głosują | podział 50/50, kaucje wracają, nieobecność odnotowana |
| nikt nie przychodzi na odbiór osobisty | zwrot dla kupującego po terminie |

**Kto ma jakie uprawnienia?**
- Sprzedawca: `create_deal`, `cancel` (tylko przed wpłatą), `mark_shipped`, `respond_to_dispute`, `refund_buyer`,
  `confirm_pickup` (z kodem od kupującego).
- Kupujący: `fund`, `confirm_receipt`, `open_dispute`. Obie strony: `propose/accept_settlement`, `submit_evidence`,
  `review` (raz, po zamknięciu).
- Oracle (lista w konfiguracji): tylko `confirm_delivery`; zmiana stanu dopiero po kworum 2 z 3.
- Arbitrzy (rada 3 osób z konfiguracji): tylko `commit_vote` / `reveal_vote` w sporach w arbitrażu; głos niejawny
  (commit–reveal, sha256), więc nikt nie dopasuje się do większości.
- Ktokolwiek: `settle_expired` po terminie.

**Czy autor może coś zmienić po wdrożeniu?** Reguły (token, oracle, arbitrzy, terminy, kaucja) zapisuje
`initialize` **raz** — w programie **nie ma żadnej instrukcji administratora**, która by je zmieniała albo
wypłacała z sejfów. Uczciwie: dopóki istnieje *upgrade authority* programu, wdrażający może podmienić kod programu.
Na koniec wdrożenia wystarczy `solana program set-upgrade-authority <PROGRAM_ID> --final -u devnet` — wtedy
nie zmieni go już nikt (zostawiamy to na ostatni krok, żeby móc poprawiać błędy przed oceną).

**Dlaczego blockchain, a nie zwykła baza danych?** W bazie pieniądze i reguły należą do właściciela bazy —
może je zmienić, zablokować wypłatę albo zniknąć razem ze środkami; trzeba mu ufać tak jak dziś platformie.
Tutaj (1) środki fizycznie leżą na koncie, do którego nikt nie ma klucza, (2) reguły są publicznym kodem,
którego nikt nie zmieni, (3) rozliczenie po terminie nie wymaga, żeby nasz serwer działał — zrobi to każdy,
(4) historia (opis oferty, hash zdjęcia, reklamacja, głosy) jest niezmienna i weryfikowalna dla arbitrów.
Solana: opłata za transakcję to ułamek grosza, potwierdzenie w <1 s — escrow opłaca się nawet przy rowerze za 250 zł.

**Co dalej (kolejny tydzień)?** Prawdziwe źródła statusu przesyłki (API InPost/DPD przez Switchboard
On-Demand albo kilku niezależnych operatorów relayera), otwarta pula arbitrów z kaucją i losowaniem przez VRF
(wersja EVM w `contracts/` już to miała), USDC zamiast testowego tokenu, zamykanie kont po rozliczeniu (zwrot
rentu), `--final` dla upgrade authority, audyt.

## Co jest w repozytorium

```
solana/
  programs/safedeal/src/lib.rs   program on-chain (Anchor) — cała logika escrow, sporów i terminów
  scripts/setup.mjs              mint testowego USDC (mint authority = PDA programu), persony demo, initialize
  scripts/seed.mjs               przykładowe transakcje w różnych stanach
  scripts/e2e.mjs                test end-to-end (9 scenariuszy, w tym znikanie stron i próby obejścia reguł)
  scripts/oracle-relayer.mjs     relayer oracle: prawdziwe numery InPost (publiczne API śledzenia) + symulacja DEMO-…
web/                             Next.js + @coral-xyz/anchor + Wallet Adapter (Phantom, Solflare…)
  lib/solana.ts                  PDA, odczyt kont, instrukcje, historia ze zdarzeń w logach transakcji
  lib/wallet.tsx                 tryb demo (persony z kluczami devnet) i prawdziwy portfel
contracts/                       wcześniejszy prototyp na EVM (Solidity) — nieużywany w wersji na Solanę
oracle/                          szkic źródła Chainlink Functions (InPost) z wersji EVM
```

## Funkcje

- **Escrow z wysyłką** — wpłata do sejfu, numer przesyłki, kworum 2 z 3 oracle'i, okno reklamacji.
- **Odbiór osobisty z kodem** — kupujący płaci z hashem tajnego 16-znakowego kodu (QR); na spotkaniu pokazuje
  kod po obejrzeniu przedmiotu, `confirm_pickup` sprawdza go z hashem i wypłaca od ręki.
- **Reklamacja z kaucją (5%) i arbitraż** — kaucja przegranego trafia do arbitrów głosujących za zwycięzcą.
- **Ugoda** — częściowy zwrot uzgodniony przez strony; akceptacja wymaga tej samej kwoty (brak podmiany oferty).
- **Zlecenia w etapach** — każdy etap to osobna transakcja; etapy łączy znacznik w opisie zapisanym on-chain.
- **Opis i hash zdjęcia oferty zapisane on-chain** — zamrożone po wpłacie, dowód przy „niezgodne z opisem”.
- **Dowody w sporze** — hash pliku on-chain; podmiana pliku po fakcie od razu widoczna (✗).
- **Reputacja i opinie** — konto profilu PDA: udane transakcje, spory, oceny i wolumen ocenionych transakcji.
- **Historia każdej transakcji** ze zdarzeń w logach — każdy wpis z linkiem do Solana Explorer.
- **Rozmowa** z wiadomościami podpisanymi kluczem (ed25519), weryfikowanymi w przeglądarce.
- **Reguły programu** (`/stats`) — oracle, arbitrzy, terminy i kaucja odczytane z konta konfiguracji.
- **Zakup prosto z posta lub czatu — Solana Actions / Blinks.** Każda otwarta oferta ma endpoint
  `web/app/api/actions/deal/[id]` (+ `actions.json`): link wklejony na X, w czat albo otwarty w portfelu pokazuje kartę
  „Kup i zablokuj 250 USDC” z gwarancjami, a zakup to jeden podpis — bez wchodzenia na stronę. Na stronie oferty
  „Podgląd karty” renderuje ją z tego samego endpointu tak, jak zrobi to klient Blinks (działa też bez publicznego
  adresu), a jej przycisk kupuje tą samą ścieżką.
- **Zakup bez SOL.** Transakcję kupna składa serwer, a sponsor opłat podpisuje ją jako płacący opłatę (i dopłaca rent
  za konto profilu). Kupujący tylko podpisuje; brakujące testowe USDC dokłada kran programu w tej samej transakcji.
  Sprawdzone na devnecie: świeży portfel z 0 SOL i 0 USDC kupił ofertę jednym podpisem. Ten sam mechanizm obsługuje
  przycisk „Kup” w trybie portfela. Tak samo wystawienie oferty (`web/app/api/sponsor/create-deal`): sponsor pokrywa
  opłatę i rent za konto oferty, więc sprzedawca z pustym portfelem też tylko podpisuje (sprawdzone na devnecie). Serwer nie egzekwuje żadnych reguł — tylko składa instrukcje; o tym, dokąd trafią
  pieniądze, decyduje program.
- **Prawdziwy portfel bez szukania SOL** — przycisk „Przygotuj portfel do testu”: sponsor opłat (osobny portfel na
  devnecie, `web/app/api/sponsor`) wysyła 0,05 testowego SOL, a kran programu 1000 testowych USDC. Sponsor płaci
  tylko opłaty sieci — nie ma żadnych uprawnień w programie ani dostępu do sejfów (gdyby zniknął, wystarczy
  dowolny faucet). Z myślą o osobach spoza krypto: nie muszą wiedzieć, czym jest SOL, żeby kupić rower.

## Uruchomienie

Wymagania: Rust, Solana CLI (Agave), Anchor 0.32.1, Node 20+. Na Windows: wszystko on-chain w WSL (Ubuntu).

```bash
# 1. build programu
cd solana && anchor build                 # IDL kopiujemy do web/lib/idl/ i solana/scripts/idl.json
npm install

# 2a. lokalnie (bez internetu i bez faucetu)
solana-test-validator --reset             # osobny terminal
solana program deploy target/deploy/safedeal.so --program-id target/deploy/safedeal-keypair.json -u localhost
npm run setup:local && npm run test:local     # e2e: terminy w sekundach
# do prezentacji lokalnie: świeży walidator + npm run setup:local-demo && npm run seed:local (terminy w minutach)

# 2b. devnet (testowy SOL za darmo: https://faucet.solana.com)
solana program deploy target/deploy/safedeal.so --program-id target/deploy/safedeal-keypair.json -u devnet
npm run setup:devnet && npm run seed:devnet
npm run oracle:devnet                     # relayer: numery InPost potwierdza po statusie „delivered” z API InPost,
                                          # przesyłki DEMO-… po 15 s

# 3. frontend
cd ../web && npm install && npm run dev   # http://localhost:3000  (NEXT_PUBLIC_CLUSTER=localnet dla lokalnego)
npm run demo                              # na prezentację: build produkcyjny + serwer (szybszy, bez przeładowań)
```

`setup` zapisuje adresy do `web/lib/deployments.json`, a klucze person demo (tylko devnet/localnet, bez wartości)
do `solana/keys/` i `web/.env.local` jako `NEXT_PUBLIC_DEMO_KEYS` — oba poza repozytorium; po setupie zrestartuj
`npm run dev`. Opcjonalnie w `web/.env.local`: `NEXT_PUBLIC_RPC=<prywatny endpoint HTTP devnetu>` (publiczny ma
limity), a `node scripts/sponsor-setup.mjs devnet 1.5` zakłada portfel sponsora opłat. Na devnecie terminy są w minutach, lokalnie w sekundach.

### Scenariusz na prezentację (3 min)
1. **Alicja** tworzy ofertę „Rower gravel”, 250 USDC → kopiuje link.
2. **Bartek** otwiera link → „Kup i zablokuj” → toast z linkiem do Explorera; sejf programu pokazuje 250 USDC,
   Alicja jeszcze nic nie ma.
3. **Celina** próbuje coś zrobić → program odmawia („Ta osoba nie może wykonać tej akcji”).
4. **Alicja** podaje numer `DEMO-123` → „Nadałem paczkę”.
5. Panel demo: 📦 „API InPost” potwierdza (1/2 — nadal w drodze), 📦 „Niezależny węzeł” (2/2 → doręczona).
   Bartek klika „Wszystko OK” albo po oknie reklamacji ktokolwiek klika „Rozlicz teraz” → Alicja dostaje pieniądze.
6. Pokaż transakcję w Solana Explorer i historię on-chain. Druga transakcja: reklamacja → arbitraż → niejawne głosy.
7. Można też podłączyć prawdziwy portfel (Phantom/Solflare na devnecie) przełącznikiem „Portfel”.

## Ograniczenia (świadome)

- Oracle: relayer czyta prawdziwy status z publicznego API InPost, ale wszystkie 3 klucze źródeł trzyma jeden
  proces (a w panelu demo — przeglądarka). W produkcji każde źródło to osobny operator; program już dziś wymaga
  kworum 2 z 3.
- Rada arbitrów jest stała (zapisana w `initialize`); brak otwartej puli z kaucją i losowaniem.
- Pierwsze `initialize` może wywołać ktokolwiek — robimy je od razu po wdrożeniu (w produkcji: tylko upgrade authority).
- Konta transakcji nie są zamykane po rozliczeniu (rent ~0,014 SOL na ofertę zostaje zablokowany).
- Pliki (zdjęcia, dowody) leżą w lokalnym magazynie aplikacji — on-chain jest tylko ich hash (docelowo IPFS/Arweave).
