# Zgłoszenie — Superteam Poland: Finanse bez pośrednika

## Tytuł

**SafeDeal — kupuj od obcych bez pośrednika**

## Krótki opis (1 zdanie)

Escrow na Solanie dla zakupów z ogłoszeń: pieniądze kupującego leżą w sejfie, którego właścicielem jest program —
nie platforma, nie sprzedawca, nie autorzy — a reguły wypłaty, terminy i spory wykonują się same.

## Szczegółowy opis

**Dla kogo.** Osoby kupujące i sprzedające używane rzeczy od obcych (OLX, Vinted, grupy na Facebooku) oraz drobni
wykonawcy rozliczający się z klientem w etapach. To ludzie spoza świata krypto, więc interfejs mówi „sejf”,
„paczka”, „reklamacja”, a kupujący nie musi nawet mieć SOL — opłatę sieci płaci sponsor. Warstwa techniczna
jest pod spodem, ale każda akcja ma link do Solana Explorer.

**Jaka relacja finansowa i kto był pośrednikiem.** Zakup z ogłoszenia między obcymi ludźmi. Dziś albo ktoś musi
zaufać pierwszy (a przelewu czy BLIK-a nie da się cofnąć), albo pieniądze trzyma platforma z „bezpieczną
płatnością”: pobiera prowizję, rozstrzyga spory według własnego regulaminu, może zablokować konto i działa
tylko w swoim serwisie. W obu przypadkach transakcja opiera się na zaufaniu — do obcej osoby albo do firmy.

**Co zmienia usunięcie pośrednika.** Kupujący wpłaca USDC do sejfu — konta tokenowego, którego właścicielem jest
adres programu (PDA). Nikt nie ma do niego klucza. Wypłacić może tylko program i tylko gdy spełni się zapisany
warunek: kupujący potwierdzi odbiór, 2 z 3 niezależnych źródeł potwierdzą doręczenie i minie okno reklamacji,
kupujący pokaże kod przy odbiorze osobistym albo 2 z 3 arbitrów wylosowanych z otwartej puli rozstrzygnie spór. Każdy stan ma termin i z góry
znany wynik, więc nikt nie zamrozi pieniędzy, znikając — a rozliczenie po terminie może wywołać każdy, bez
naszego serwera. Program nie ma żadnej instrukcji administratora: reguły (token, oracle, kaucje arbitrów, terminy,
kaucja) zapisano raz przy wdrożeniu.

**Moment, w którym pośrednik znika (w aplikacji).** Na stronie każdej transakcji panel „Kto może teraz ruszyć te
pieniądze?” wylicza z reguł programu, dokąd i pod jakim warunkiem mogą trafić środki — i kto nie może: sprzedawca
przed spełnieniem warunku, kupujący (nie cofnie wpłaty) i autorzy. Strona „Dla jury” pozwala samemu spróbować
oszukać program: wypłata z sejfu z pominięciem programu, zwrot „kupującemu” na własne konto, potwierdzenie
odbioru za kupującego, rozliczenie przed terminem — każda próba to prawdziwa transakcja symulowana w sieci,
odrzucona przez kod on-chain.

**Spory i teoria gier.** Reklamacja wymaga kaucji 5%; żeby ją odeprzeć, sprzedawca wpłaca tyle samo. Przegrany
traci kaucję na rzecz arbitrów, którzy głosowali za zwycięzcą. Arbitrów nie wybiera nikt: każdy może dołączyć do otwartej
puli z kaucją, a do sporu program losuje 3 osoby spoza stron z hasha slotu, który powstał dopiero po przyjęciu sporu.
Arbiter, który nie zagłosuje, traci część kaucji (spalana — nikt na tym nie zarabia). Głosy są niejawne (commit–reveal), więc nikt nie
dopasuje się do większości. Strony mogą też zawrzeć ugodę (częściowy zwrot), a akceptacja wymaga tej samej kwoty,
więc oferty nie da się podmienić. Opis i hash zdjęcia oferty są zamrożone on-chain po wpłacie — to dowód przy
reklamacji „niezgodne z opisem”.

**Co dalej.** Prawdziwe oracle doręczeń jako niezależni operatorzy (relayer już czyta status z publicznego API
InPost), losowanie składu arbitrów przez VRF zamiast hasha slotu, prawdziwe USDC, audyt i odebranie upgrade
authority (`--final`).

**Poza naszą stroną i bez śmieci w sieci.** Wtyczka „Kup przez SafeDeal” (`/wtyczka`): serwis z ogłoszeniami dodaje
jedną linijkę `<script>` i w ogłoszeniu pojawia się karta oferty z gwarancjami i przyciskiem zakupu, a przycisk
„Sprzedaj przez SafeDeal” wystawia ofertę z danymi ogłoszenia. Po rozliczeniu każdy może zamknąć konta transakcji —
rent wraca do sprzedawcy, a opis zostaje w historii łańcucha.

## Technologia

- Program on-chain: Rust + Anchor 0.32 (`solana/programs/safedeal/src/lib.rs`), SPL Token, wdrożony na devnecie:
  `Eo9CXiAbBVBE5megSiY8H67c91qP3BZ8NjWgQvu9EzRZ`.
- Frontend: Next.js, @coral-xyz/anchor, @solana/web3.js, Wallet Adapter (Phantom, Solflare), tryb demo z personami.
- Solana Actions / Blinks: każda oferta jako karta zakupu do wklejenia w post lub czat; transakcję częściowo
  podpisuje sponsor opłat, więc kupujący bez SOL płaci jednym podpisem.
- Testy: `solana/scripts/e2e.mjs` — 10 scenariuszy end-to-end (znikanie każdej ze stron, losowanie składu arbitrów, kary za nieobecność, zamykanie kont, próby obejścia reguł).

## Ograniczenia (świadome)

- Trzy klucze oracle trzyma w MVP jeden relayer (a w panelu demo przeglądarka) — symulacja niezależnych źródeł;
  program już dziś wymaga zgody 2 z 3.
- Skład arbitrów losuje hash przyszłego slotu, nie VRF (lider slotu teoretycznie mógłby wpłynąć na wynik).
- Pliki (zdjęcia, dowody) leżą poza łańcuchem; on-chain jest ich hash.
- Do czasu `--final` wdrażający może podmienić kod programu (strona „Dla jury” pokazuje to na żywo).

## Linki

- Aplikacja (devnet): https://safe-deal-one.vercel.app
- Repozytorium: https://github.com/Mateuszl28/SafeDeal
- Film (≤ 3 min): [uzupełnij]
- Prezentacja PDF: [uzupełnij]
- Program w Solana Explorer: https://explorer.solana.com/address/Eo9CXiAbBVBE5megSiY8H67c91qP3BZ8NjWgQvu9EzRZ?cluster=devnet
