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
  const a = await create("Kross Esker gravel bike", 250, "54 cm frame, about 800 km ridden, GRX groupset. Small scratch on the fork.");
  await step("#1 zakup, doręczenie, odbiór, opinie", async () => {
    await shipAndDeliver(a, "DEMO-520001");
    await c.confirmReceipt(bartek, a);
    await c.review(bartek, a, 5, "Bike exactly as described, fast shipping.");
    await c.review(alicja, a, 5, "Hassle-free buyer.");
  });

  // 2. Doręczona — trwa okno reklamacji
  const b = await create("iPhone 13, 128 GB", 320, "Battery 87%, unlocked, case included. No scratches on the screen.");
  await step("#2 doręczona", () => shipAndDeliver(b, "DEMO-520002"));

  // 3. Reklamacja czeka na sprzedawczynię
  const e = await create("PS5 console + 2 controllers", 400, "Disc edition, two DualSense controllers, HDMI and power cables.");
  await step("#3 reklamacja", async () => {
    await shipAndDeliver(e, "DEMO-520003");
    await c.openDispute(bartek, e, "One controller doesn't work, HDMI cable missing");
  });

  // 4. Arbitraż — skład wylosowany z puli, jeden arbiter już złożył niejawny głos
  const f = await create("Xiaomi 4 electric scooter", 290, "Up to 35 km range per the manufacturer, 300 km ridden.");
  await step("#4 arbitraż", async () => {
    await shipAndDeliver(f, "DEMO-520004");
    await c.openDispute(bartek, f, "Battery lasts 5 km instead of the 35 km in the listing");
    await c.respondToDispute(alicja, f);
    const [first] = await c.drawPanel(P.Celina, f);
    const arb = Object.values(P).find((k) => k.publicKey.equals(first));
    // sól tego głosu nie jest nigdzie zapisana — ten arbiter nie ujawni go z przeglądarki; to tylko tło sceny
    await c.commitVote(arb, f, voteCommitment(BigInt(f), arb.publicKey, true, crypto.randomBytes(32)));
  });

  // 5. Propozycja ugody
  const g = await create('Kellys 20" kids bike', 150, "For kids aged 6–9. Used for one season.");
  await step("#5 propozycja ugody", async () => {
    await shipAndDeliver(g, "DEMO-520005");
    await c.proposeSettlement(bartek, g, usdc(45));
  });

  // Zlecenie w etapach: Alicja (wykonawczyni) robi stronę dla Bartka. Każdy etap = osobna transakcja escrow.
  // Unikalny znacznik przy każdym seedzie — inaczej etapy z kolejnych uruchomień trafiłyby do jednego zlecenia.
  const project = `piekarnia${Date.now().toString(36).slice(-6)}`;
  const stages = [["Visual design", 300], ["Implementation", 500], ["Revisions", 200]];
  const ids = [];
  for (const [i, [name, price]] of stages.entries()) {
    ids.push(
      await create(`Bakery website — milestone ${i + 1}/3: ${name}`, price, `[etap:${project}:${i + 1}/3] ${name}`, {
        buyer: bartek.publicKey,
      }),
    );
  }
  await step("zlecenie: etap 1 zaakceptowany, etap 2 oddany", async () => {
    await c.fund(bartek, ids[0]);
    await c.markShipped(alicja, ids[0], "https://example.com/bakery/visual-design");
    await c.confirmReceipt(bartek, ids[0]);
    await c.fund(bartek, ids[1]);
    await c.markShipped(alicja, ids[1], "https://example.com/bakery/preview");
  });

  // Otwarte oferty
  await create("Yamaha F310 acoustic guitar", 95, "New strings, no cracks. Gig bag included.");
  await create("Romet city bike — pickup in Kraków", 130, "Basket, mudguards, new tyres. Pickup in person, Kraków Kazimierz.", {
    pickupAllowed: true,
  });
  await create("The North Face jacket, size M", 70, "Winter down jacket, worn for two seasons.");
  await create("Sony A6000 camera with lens", 180, "16-50 mm lens, about 12k shutter count, two batteries.");

  console.log(`Gotowe: #${a} zakończona, #${b} doręczona, #${e} reklamacja, #${f} arbitraż, #${g} ugoda, zlecenie /projekt/${project}, łącznie ${await c.dealCount()}.`);
  console.log("Uwaga: okna czasowe na devnecie to minuty — stany #2–#5 po kilku minutach można rozliczyć „Rozlicz teraz”.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
