// Test end-to-end programu na lokalnym walidatorze (okna czasowe w sekundach).
//   node scripts/setup.mjs localnet && node scripts/e2e.mjs localnet
// Sprawdza pełne scenariusze i to, że reguł nie da się obejść.
import crypto from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { CLUSTER, client, connection, demoKeys, idl, pda, pickupHash, readDeployments, sleep, usdc, voteCommitment } from "./common.mjs";

const ERR = Object.fromEntries(idl.errors.map((e) => [e.name, e.code]));

const d = readDeployments()[CLUSTER];
if (!d) throw new Error(`Brak wdrożenia dla ${CLUSTER} — uruchom setup.`);
const mint = new PublicKey(d.mint);
const c = client(mint);
const { personas: P, oracles: O } = demoKeys();
const [alicja, bartek, celina] = [P.Alicja, P.Bartek, P.Celina];
const arbs = [1, 2, 3, 4, 5].map((i) => P[`Arbiter ${i}`]);
const byKey = (k) => arbs.find((a) => a.publicKey.equals(k));
const lamports = (k) => connection.getBalance(k, "confirmed");
const W = d.windows;

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n    ${e.message?.split("\n").slice(0, 3).join("\n    ")}`);
  }
}
function eq(a, b, msg) {
  if (String(a) !== String(b)) throw new Error(`${msg}: oczekiwano ${b}, jest ${a}`);
}
/** Akcja ma zostać odrzucona przez program z danym kodem błędu. */
async function rejects(p, code) {
  try {
    await p;
  } catch (e) {
    const logs = (e.logs ?? e.transactionLogs ?? []).join("\n") + String(e.message);
    if (code && !logs.includes(code) && !logs.includes(`"Custom":${ERR[code]}`)) throw new Error(`odrzucone, ale nie z ${code}: ${logs.slice(-300)}`);
    return;
  }
  throw new Error(`akcja powinna zostać odrzucona (${code})`);
}
const state = async (id) => (await c.fetchDeal(id)).state;
const S = { Created: 1, Funded: 2, Shipped: 3, Delivered: 4, Disputed: 5, InArbitration: 6, Released: 7, Refunded: 8, Split: 9, Cancelled: 10, Settled: 11 };

async function main() {
  console.log(`E2E na ${CLUSTER}, program ${d.programId}`);
  for (const p of [alicja, bartek, celina, ...arbs]) await c.faucet(p);

  await test("zakup → nadanie → 2 z 3 oracle'i → odbiór → wypłata sprzedawcy", async () => {
    const id = await c.createDeal(alicja, { amount: usdc(250), title: "Rower gravel", description: "Rama 54" });
    eq(await state(id), S.Created, "stan");
    const a0 = await c.balance(alicja.publicKey);
    await c.fund(bartek, id);
    eq(await state(id), S.Funded, "po wpłacie");
    await rejects(c.fund(celina, id), "WrongState");
    await rejects(c.markShipped(celina, id, "X"), "NotAllowed");
    await c.markShipped(alicja, id, "DEMO-1");
    await c.confirmDelivery(O[0], id);
    eq(await state(id), S.Shipped, "jedno źródło nie wystarcza");
    await rejects(c.confirmDelivery(O[0], id), "NotAllowed");
    await rejects(c.confirmDelivery(celina, id), "NotAllowed");
    await c.confirmDelivery(O[1], id);
    eq(await state(id), S.Delivered, "kworum oracle'i");
    await rejects(c.confirmReceipt(celina, id), "NotAllowed");
    await rejects(c.settleExpired(celina, id), "DeadlineNotReached");
    await c.confirmReceipt(bartek, id);
    eq(await state(id), S.Released, "zakończona");
    eq((await c.balance(alicja.publicKey)) - a0, usdc(250), "sprzedawczyni dostała kwotę");
    await c.review(bartek, id, 5, "Super");
    await rejects(c.review(bartek, id, 4, "drugi raz"), "NotAllowed");
    await rejects(c.review(celina, id, 1, "obca"), "NotAllowed");
    await rejects(c.closeDeal(celina, id), "DeadlineNotReached"); // sprzedawczyni jeszcze nie oceniła
    await c.review(alicja, id, 5, "OK");
    // porządki może zrobić każdy, ale rent wraca do sprzedawczyni
    const l0 = await lamports(alicja.publicKey);
    await c.closeDeal(celina, id);
    eq(await connection.getAccountInfo(pda.deal(id)), null, "konto transakcji zamknięte");
    eq(await connection.getAccountInfo(pda.vault(pda.deal(id))), null, "sejf zamknięty");
    if ((await lamports(alicja.publicKey)) - l0 < 10_000_000) throw new Error("rent nie wrócił do sprzedawczyni");
  });

  await test("sprzedawca znika → po terminie KAŻDY może zwrócić pieniądze kupującemu", async () => {
    const id = await c.createDeal(alicja, { amount: usdc(40), title: "Nienadana" });
    const b0 = await c.balance(bartek.publicKey);
    await c.fund(bartek, id);
    await rejects(c.settleExpired(celina, id), "DeadlineNotReached");
    await sleep((W.ship + 2) * 1000);
    await rejects(c.markShipped(alicja, id, "za późno"), "DeadlinePassed");
    await c.settleExpired(celina, id);
    eq(await state(id), S.Refunded, "zwrot");
    eq(await c.balance(bartek.publicKey), b0, "kupujący odzyskał całość");
  });

  await test("kupujący milczy po nadaniu → po terminie wypłata sprzedawcy", async () => {
    const id = await c.createDeal(alicja, { amount: usdc(30), title: "Bez potwierdzenia" });
    await c.fund(bartek, id);
    await c.markShipped(alicja, id, "DEMO-3");
    await sleep((W.transit + W.inspection + 2) * 1000);
    const a0 = await c.balance(alicja.publicKey);
    await c.settleExpired(celina, id);
    eq(await state(id), S.Released, "wypłata");
    eq((await c.balance(alicja.publicKey)) - a0, usdc(30), "kwota");
    await rejects(c.closeDeal(celina, id), "DeadlineNotReached"); // okno na opinie
    await sleep((W.archive + 2) * 1000);
    await c.closeDeal(celina, id);
    eq(await connection.getAccountInfo(pda.deal(id)), null, "zamknięta po oknie na opinie");
  });

  await test("pula arbitrów: kaucja poniżej minimum odrzucona", async () => {
    await rejects(c.joinPool(celina, usdc(50)), "InvalidParams");
    eq((await c.fetchPool()).members.length, 5, "5 arbitrów w puli");
  });

  await test("reklamacja → losowanie składu → niejawne głosy → wygrywa kupujący, kaucja dla arbitrów", async () => {
    const id = await c.createDeal(alicja, { amount: usdc(200), title: "Spór" });
    await c.fund(bartek, id);
    await c.markShipped(alicja, id, "DEMO-4");
    const b0 = await c.balance(bartek.publicKey);
    await c.openDispute(bartek, id, "Nie działa");
    eq(await state(id), S.Disputed, "spór");
    const bond = usdc(10); // 5% z 200
    eq(b0 - (await c.balance(bartek.publicKey)), bond, "kaucja kupującego");
    await c.respondToDispute(alicja, id);
    eq(await state(id), S.InArbitration, "arbitraż");
    await rejects(c.commitVote(arbs[0], id, crypto.randomBytes(32)), "NotAllowed"); // skład jeszcze nie wylosowany
    const panelKeys = await c.drawPanel(celina, id); // losowanie może pchnąć każdy
    const panel = panelKeys.map(byKey);
    eq(new Set(panelKeys.map(String)).size, 3, "trzy różne osoby");
    if (panel.some((a) => !a)) throw new Error("w składzie ktoś spoza puli");
    const outsider = arbs.find((a) => !panelKeys.some((k) => k.equals(a.publicKey)));
    await rejects(c.commitVote(outsider, id, crypto.randomBytes(32)), "NotAllowed");
    await rejects(c.leavePool(panel[0]), "ArbiterBusy");
    const votes = [true, true, false];
    const salts = votes.map(() => crypto.randomBytes(32));
    const commit = (i) => c.commitVote(panel[i], id, voteCommitment(BigInt(id), panelKeys[i], votes[i], salts[i]));
    // ujawnianie przed złożeniem wszystkich głosów jest zamknięte
    await commit(0);
    await rejects(c.revealVote(panel[0], id, votes[0], salts[0]), "RevealNotOpen");
    await commit(1);
    await commit(2);
    await rejects(c.revealVote(panel[2], id, true, salts[2]), "BadReveal"); // nie da się zmienić głosu
    await c.revealVote(panel[2], id, false, salts[2]);
    await c.revealVote(panel[0], id, true, salts[0]);
    eq(await state(id), S.InArbitration, "1:1 — jeszcze bez werdyktu");
    await c.revealVote(panel[1], id, true, salts[1]);
    eq(await state(id), S.Refunded, "kupujący wygrał");
    eq((await c.balance(bartek.publicKey)) - b0, usdc(200), "kupujący: kwota + własna kaucja");
    await rejects(c.closeDeal(celina, id), "ArbitersNotSettled");
    const before = await Promise.all(panelKeys.map((k) => c.balance(k)));
    for (let i = 0; i < 3; i++) await c.settleArbiter(celina, id, i);
    await rejects(c.settleArbiter(celina, id, 0), "NotAllowed");
    const after = await Promise.all(panelKeys.map((k) => c.balance(k)));
    eq(after[0] - before[0], bond / 2n, "arbiter większości: połowa kaucji przegranego");
    eq(after[2] - before[2], 0n, "arbiter mniejszości: nic");
    const st = await Promise.all(panelKeys.map((k) => c.fetchArbiter(k)));
    eq(st[0].activeCases, 0, "sprawa zwolniona");
    eq(st[2].againstMajority >= 1, true, "głos przeciw odnotowany");
    eq((await connection.getTokenAccountBalance(pda.vault(pda.deal(id)))).value.amount, "0", "sejf pusty");
  });

  await test("arbitrzy milczą → po terminie podział 50/50, nieobecnym spalona część kaucji", async () => {
    const id = await c.createDeal(alicja, { amount: usdc(100), title: "Cisza arbitrów" });
    await c.fund(bartek, id);
    await c.markShipped(alicja, id, "DEMO-5");
    await c.openDispute(bartek, id, "?");
    await c.respondToDispute(alicja, id);
    const panelKeys = await c.drawPanel(celina, id);
    const [a0, b0] = [await c.balance(alicja.publicKey), await c.balance(bartek.publicKey)];
    await sleep((W.arbitration + W.reveal + 2) * 1000);
    await c.settleExpired(celina, id);
    eq(await state(id), S.Split, "podział");
    eq((await c.balance(alicja.publicKey)) - a0, usdc(55), "sprzedawczyni: 50 + kaucja 5");
    eq((await c.balance(bartek.publicKey)) - b0, usdc(55), "kupujący: 50 + kaucja 5");
    const stake0 = BigInt((await c.fetchArbiter(panelKeys[0])).stake.toString());
    const supply0 = BigInt((await connection.getTokenSupply(mint)).value.amount);
    for (let i = 0; i < 3; i++) await c.settleArbiter(celina, id, i);
    const a = await c.fetchArbiter(panelKeys[0]);
    const stake1 = BigInt(a.stake.toString());
    eq(stake0 - stake1, BigInt(d.missSlash), "kara z kaucji");
    eq(supply0 - BigInt((await connection.getTokenSupply(mint)).value.amount), 3n * BigInt(d.missSlash), "kary spalone");
    // po rozliczeniu arbiter może wyjść z puli i odebrać resztę kaucji
    const p = byKey(panelKeys[0]);
    const t0 = await c.balance(p.publicKey);
    await c.leavePool(p);
    eq((await c.balance(p.publicKey)) - t0, stake1, "zwrot kaucji");
    await c.joinPool(p, usdc(200));
    eq((await c.fetchPool()).members.length, 5, "wrócił do puli");
  });

  await test("sprzedawca ignoruje reklamację → kupujący wygrywa po terminie", async () => {
    const id = await c.createDeal(alicja, { amount: usdc(60), title: "Zignorowana reklamacja" });
    const b0 = await c.balance(bartek.publicKey);
    await c.fund(bartek, id);
    await c.markShipped(alicja, id, "DEMO-6");
    await c.openDispute(bartek, id, "Pusta paczka");
    await sleep((W.response + 2) * 1000);
    await rejects(c.respondToDispute(alicja, id), "DeadlinePassed");
    await c.settleExpired(celina, id);
    eq(await state(id), S.Refunded, "zwrot");
    eq(await c.balance(bartek.publicKey), b0, "kupujący odzyskał kwotę i kaucję");
  });

  await test("odbiór osobisty: zły kod odrzucony, dobry kod wypłaca od ręki", async () => {
    const id = await c.createDeal(alicja, { amount: usdc(130), title: "Odbiór", pickupAllowed: true });
    const code = "ABCD-EFGH-JKMN-PQRS";
    await c.fund(bartek, id, pickupHash(BigInt(id), code));
    await rejects(c.markShipped(alicja, id, "X"), "NotAllowed");
    await rejects(c.confirmPickup(alicja, id, "ABCD-EFGH-JKMN-PQRT"), "BadReveal");
    await rejects(c.confirmPickup(celina, id, code), "NotAllowed");
    await c.confirmPickup(alicja, id, code);
    eq(await state(id), S.Released, "wypłata po kodzie");
  });

  await test("ugoda: akceptacja zmienionej kwoty odrzucona, zgodna — podział", async () => {
    const id = await c.createDeal(alicja, { amount: usdc(150), title: "Ugoda" });
    await c.fund(bartek, id);
    await c.markShipped(alicja, id, "DEMO-8");
    const [a0, b0] = [await c.balance(alicja.publicKey), await c.balance(bartek.publicKey)];
    await c.proposeSettlement(bartek, id, usdc(45));
    await rejects(c.acceptSettlement(bartek, id, usdc(45)), "NotAllowed"); // nie można przyjąć własnej
    await rejects(c.acceptSettlement(alicja, id, usdc(40)), "OfferMismatch");
    await c.acceptSettlement(alicja, id, usdc(45));
    eq(await state(id), S.Settled, "ugoda");
    eq((await c.balance(bartek.publicKey)) - b0, usdc(45), "kupujący");
    eq((await c.balance(alicja.publicKey)) - a0, usdc(105), "sprzedawczyni");
  });

  await test("oferta dla konkretnego kupującego; anulowanie przed wpłatą", async () => {
    const id = await c.createDeal(alicja, { amount: usdc(10), title: "Dla Bartka", buyer: bartek.publicKey });
    await rejects(c.fund(celina, id), "NotAllowed");
    await rejects(c.cancel(bartek, id), "NotAllowed");
    await c.cancel(alicja, id);
    eq(await state(id), S.Cancelled, "anulowana");
    await rejects(c.fund(bartek, id), "WrongState");
    await c.closeDeal(celina, id); // anulowana — od razu
    eq(await connection.getAccountInfo(pda.deal(id)), null, "zamknięta");
  });

  console.log(`\n${passed} OK, ${failed} błędów`);
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
