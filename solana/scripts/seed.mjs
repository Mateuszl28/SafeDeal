// Przykładowe transakcje w różnych stanach — gotowa scena na prezentację.
//   node scripts/seed.mjs devnet
import crypto from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { CLUSTER, client, demoKeys, readDeployments, usdc, voteCommitment } from "./common.mjs";

const d = readDeployments()[CLUSTER];
if (!d) throw new Error(`Brak wdrożenia dla ${CLUSTER} — uruchom setup.`);
const c = client(new PublicKey(d.mint));
const { personas: P, oracles: O } = demoKeys();
const [alicja, bartek] = [P.Alicja, P.Bartek];
const quorum = O.slice(0, d.oracleQuorum);

async function step(label, fn) {
  process.stdout.write(`  ${label}… `);
  const r = await fn();
  console.log("✓");
  return r;
}

async function main() {
  console.log(`Seed na ${CLUSTER}`);
  // Kran wydaje po 1000 testowych USDC; Bartek płaci za wszystkie zakupy w scenie (~2300 + kaucje).
  const want = new Map([[bartek, usdc(3500)], [alicja, usdc(1500)]]);
  for (const p of [alicja, bartek, P.Celina]) {
    while ((await c.balance(p.publicKey)) < (want.get(p) ?? usdc(1000))) await c.faucet(p);
  }

  const create = (title, price, description, extra = {}) =>
    step(`oferta „${title}”`, () => c.createDeal(alicja, { amount: usdc(price), title, description, ...extra }));
  const shipAndDeliver = async (id, tracking) => {
    await c.fund(bartek, id);
    await c.markShipped(alicja, id, tracking);
    for (const o of quorum) await c.confirmDelivery(o, id);
  };

  // 1. Zakończona sukcesem, z opiniami
  const a = await create("Rower gravel Kross Esker", 250, "Rama 54 cm, przebieg ok. 800 km, napęd GRX. Drobna rysa na widelcu.");
  await step("#1 zakup, doręczenie, odbiór, opinie", async () => {
    await shipAndDeliver(a, "DEMO-520001");
    await c.confirmReceipt(bartek, a);
    await c.review(bartek, a, 5, "Rower dokładnie jak w opisie, szybka wysyłka.");
    await c.review(alicja, a, 5, "Bezproblemowy kupujący.");
  });

  // 2. Doręczona — trwa okno reklamacji
  const b = await create("iPhone 13, 128 GB", 320, "Bateria 87%, bez blokad, w zestawie etui. Ekran bez rys.");
  await step("#2 doręczona", () => shipAndDeliver(b, "DEMO-520002"));

  // 3. Reklamacja czeka na sprzedawczynię
  const e = await create("Konsola PS5 + 2 pady", 400, "Wersja z napędem, dwa pady DualSense, kabel HDMI i zasilający.");
  await step("#3 reklamacja", async () => {
    await shipAndDeliver(e, "DEMO-520003");
    await c.openDispute(bartek, e, "Jeden pad nie działa, brak kabla HDMI");
  });

  // 4. Arbitraż — skład wylosowany z puli, jeden arbiter już złożył niejawny głos
  const f = await create("Hulajnoga elektryczna Xiaomi 4", 290, "Zasięg do 35 km według producenta, przebieg 300 km.");
  await step("#4 arbitraż", async () => {
    await shipAndDeliver(f, "DEMO-520004");
    await c.openDispute(bartek, f, "Bateria trzyma 5 km zamiast 35 km z opisu");
    await c.respondToDispute(alicja, f);
    const [first] = await c.drawPanel(P.Celina, f);
    const arb = Object.values(P).find((k) => k.publicKey.equals(first));
    // sól tego głosu nie jest nigdzie zapisana — ten arbiter nie ujawni go z przeglądarki; to tylko tło sceny
    await c.commitVote(arb, f, voteCommitment(BigInt(f), arb.publicKey, true, crypto.randomBytes(32)));
  });

  // 5. Propozycja ugody
  const g = await create('Rower dziecięcy Kellys 20"', 150, "Dla dziecka 6–9 lat. Używany jeden sezon.");
  await step("#5 propozycja ugody", async () => {
    await shipAndDeliver(g, "DEMO-520005");
    await c.proposeSettlement(bartek, g, usdc(45));
  });

  // Zlecenie w etapach: Alicja (wykonawczyni) robi stronę dla Bartka. Każdy etap = osobna transakcja escrow.
  const project = "piekarnia01";
  const stages = [["Projekt graficzny", 300], ["Wdrożenie", 500], ["Poprawki", 200]];
  const ids = [];
  for (const [i, [name, price]] of stages.entries()) {
    ids.push(
      await create(`Strona dla piekarni — etap ${i + 1}/3: ${name}`, price, `[etap:${project}:${i + 1}/3] ${name}`, {
        buyer: bartek.publicKey,
      }),
    );
  }
  await step("zlecenie: etap 1 zaakceptowany, etap 2 oddany", async () => {
    await c.fund(bartek, ids[0]);
    await c.markShipped(alicja, ids[0], "https://example.com/piekarnia/projekt-graficzny");
    await c.confirmReceipt(bartek, ids[0]);
    await c.fund(bartek, ids[1]);
    await c.markShipped(alicja, ids[1], "https://example.com/piekarnia/podglad");
  });

  // Otwarte oferty
  await create("Gitara akustyczna Yamaha F310", 95, "Nowe struny, bez pęknięć. Pokrowiec gratis.");
  await create("Rower miejski Romet — odbiór w Krakowie", 130, "Koszyk, błotniki, nowe opony. Odbiór osobisty, Kraków Kazimierz.", {
    pickupAllowed: true,
  });
  await create("Kurtka The North Face, rozmiar M", 70, "Zimowa, puchowa, noszona dwa sezony.");
  await create("Aparat Sony A6000 z obiektywem", 180, "Obiektyw 16-50 mm, przebieg migawki ok. 12 tys., dwie baterie.");

  console.log(`Gotowe: #${a} zakończona, #${b} doręczona, #${e} reklamacja, #${f} arbitraż, #${g} ugoda, zlecenie /projekt/${project}, łącznie ${await c.dealCount()}.`);
  console.log("Uwaga: okna czasowe na devnecie to minuty — stany #2–#5 po kilku minutach można rozliczyć „Rozlicz teraz”.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
