// Zakłada przykładowe transakcje w różnych stanach — gotowa scena na prezentację.
const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");

const usdc = (n) => ethers.parseUnits(String(n), 6);

async function main() {
  const { chainId } = await ethers.provider.getNetwork();
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "web", "lib", "deployments.json"), "utf8"))[Number(chainId)];
  const signers = await ethers.getSigners();
  const [alicja, bartek] = [signers[1], signers[2]];
  const oracles = [signers[0], signers[7]]; // 2 z 3 źródeł potwierdzają doręczenie
  const safe = await ethers.getContractAt("SafeDeal", d.safeDeal);
  const token = await ethers.getContractAt("MockUSDC", d.token);

  for (const s of [alicja, bartek]) {
    await (await token.mint(s.address, usdc(3000))).wait(); // testowe tokeny bez wartości
    await (await token.connect(s).approve(d.safeDeal, ethers.MaxUint256)).wait();
  }

  // Pula arbitrów: Arbitrzy 1–3 i Celina wpłacają kaucje — skład sprawy losowany jest 3 z 4
  for (const p of [signers[3], signers[4], signers[5], signers[6]]) {
    await (await token.mint(p.address, usdc(1000))).wait();
    await (await token.connect(p).approve(d.safeDeal, ethers.MaxUint256)).wait();
    await (await safe.connect(p).joinPool()).wait();
  }

  const create = async (title, price, description) => {
    await (await safe.connect(alicja).createDeal(usdc(price), title, ethers.ZeroAddress)).wait();
    const id = await safe.dealCount();
    if (description) await (await safe.connect(alicja).describe(id, description, "", ethers.ZeroHash)).wait();
    return id;
  };
  const step = async (p) => (await p).wait();

  // 1. Zakończona sukcesem
  const a = await create("Rower gravel Kross Esker", 250, "Rama 54 cm, przebieg ok. 800 km, napęd GRX. Drobna rysa na widelcu.");
  await step(safe.connect(bartek).fund(a));
  await step(safe.connect(alicja).markShipped(a, "DEMO-520001"));
  for (const o of oracles) await step(safe.connect(o).confirmDelivery(a));
  await step(safe.connect(bartek).confirmReceipt(a));
  await step(safe.connect(bartek).review(a, 5, "Rower dokładnie jak w opisie, szybka wysyłka."));
  await step(safe.connect(alicja).review(a, 5, "Bezproblemowy kupujący."));

  // 2. Doręczona — trwa okno reklamacji
  const b = await create("iPhone 13, 128 GB", 320, "Bateria 87%, bez blokad, w zestawie etui. Ekran bez rys.");
  await step(safe.connect(bartek).fund(b));
  await step(safe.connect(alicja).markShipped(b, "DEMO-520002"));
  for (const o of oracles) await step(safe.connect(o).confirmDelivery(b));

  // 3. Reklamacja czeka na odpowiedź sprzedawczyni
  const c = await create("Konsola PS5 + 2 pady", 400, "Wersja z napędem, dwa sprawne pady DualSense, kabel HDMI i zasilający w zestawie.");
  await step(safe.connect(bartek).fund(c));
  await step(safe.connect(alicja).markShipped(c, "DEMO-520003"));
  for (const o of oracles) await step(safe.connect(o).confirmDelivery(c));
  await step(safe.connect(bartek).openDispute(c, "Jeden pad nie działa, brak kabla HDMI"));

  // 4. Arbitraż — czeka na niejawne głosy arbitrów
  const e = await create("Hulajnoga elektryczna Xiaomi 4", 290, "Zasięg do 35 km według producenta, przebieg 300 km, bateria oryginalna.");
  await step(safe.connect(bartek).fund(e));
  await step(safe.connect(alicja).markShipped(e, "DEMO-520004"));
  for (const o of oracles) await step(safe.connect(o).confirmDelivery(e));
  await step(safe.connect(bartek).openDispute(e, "Bateria trzyma 5 km zamiast 35 km z opisu"));
  await step(safe.connect(alicja).respondToDispute(e));

  // 5. Propozycja ugody — kupujący chce 30% zwrotu za rysy, czeka na sprzedawczynię
  const f = await create("Rower dziecięcy Kellys 20\"", 150, "Dla dziecka 6–9 lat. Używany jeden sezon.");
  await step(safe.connect(bartek).fund(f));
  await step(safe.connect(alicja).markShipped(f, "DEMO-520005"));
  for (const o of oracles) await step(safe.connect(o).confirmDelivery(f));
  await step(safe.connect(bartek).proposeSettlement(f, usdc(45)));

  // Zlecenie w etapach: Alicja (wykonawczyni) robi stronę dla Bartka (klient). Każdy etap = osobna transakcja.
  const project = "piekarnia01";
  const stagesDef = [["Projekt graficzny", 300], ["Wdrożenie", 500], ["Poprawki", 200]];
  const stageIds = [];
  for (const [i, [name, price]] of stagesDef.entries()) {
    await step(safe.connect(alicja).createDeal(usdc(price), `Strona dla piekarni — etap ${i + 1}/3: ${name}`, bartek.address));
    const sid = await safe.dealCount();
    await step(safe.connect(alicja).describe(sid, `[etap:${project}:${i + 1}/3] ${name}`, "", ethers.ZeroHash));
    stageIds.push(sid);
  }
  await step(safe.connect(bartek).fund(stageIds[0]));
  await step(safe.connect(alicja).markShipped(stageIds[0], "https://example.com/piekarnia/projekt-graficzny"));
  await step(safe.connect(bartek).confirmReceipt(stageIds[0]));
  await step(safe.connect(bartek).fund(stageIds[1]));
  await step(safe.connect(alicja).markShipped(stageIds[1], "https://example.com/piekarnia/podglad"));

  // 6. Otwarte oferty (do wyszukiwania i sortowania)
  await create("Gitara akustyczna Yamaha F310", 95, "Nowe struny, bez pęknięć. Pokrowiec gratis.");
  const pick = await create("Rower miejski Romet — odbiór w Krakowie", 130, "Koszyk, błotniki, nowe opony. Tylko odbiór osobisty, Kraków Kazimierz.");
  await step(safe.connect(alicja).setPickup(pick, true));
  await create("Kurtka The North Face, rozmiar M", 70, "Zimowa, puchowa, noszona dwa sezony. Bez przetarć.");
  await create("Aparat Sony A6000 z obiektywem", 180, "Obiektyw 16-50 mm, przebieg migawki ok. 12 tys., dwie baterie, ładowarka.");

  console.log(`Gotowe: #${a} zakończona, #${b} doręczona, #${c} reklamacja, #${e} arbitraż, #${f} propozycja ugody, zlecenie /projekt/piekarnia01, ostatnie 3 to otwarte oferty (łącznie ${await safe.dealCount()}).`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
