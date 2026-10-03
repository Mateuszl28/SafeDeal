// Test end-to-end programu na lokalnym walidatorze (okna czasowe w sekundach).
//   node scripts/setup.mjs localnet && node scripts/e2e.mjs localnet
// Sprawdza pełne scenariusze i to, że reguł nie da się obejść.
import crypto from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { CLUSTER, client, connection, demoKeys, idl, readDeployments, sleep, usdc, voteCommitment } from "./common.mjs";

const ERR = Object.fromEntries(idl.errors.map((e) => [e.name, e.code]));

const d = readDeployments()[CLUSTER];
if (!d) throw new Error(`Brak wdrożenia dla ${CLUSTER} — uruchom setup.`);
const mint = new PublicKey(d.mint);
const c = client(mint);
const { personas: P, oracles: O } = demoKeys();
const [alicja, bartek, celina] = [P.Alicja, P.Bartek, P.Celina];
const arbs = [P["Arbiter 1"], P["Arbiter 2"], P["Arbiter 3"]];
const arbKeys = arbs.map((a) => a.publicKey);
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
  });

  await test("reklamacja → arbitraż → niejawne głosy → wygrywa kupujący, kaucja dla arbitrów", async () => {
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
    await rejects(c.commitVote(celina, id, crypto.randomBytes(32)), "NotAllowed");
    const votes = [true, true, false];
    const salts = votes.map(() => crypto.randomBytes(32));
    // ujawnianie przed złożeniem wszystkich głosów jest zamknięte
    await c.commitVote(arbs[0], id, voteCommitment(BigInt(id), arbKeys[0], votes[0], salts[0]));
    await rejects(c.revealVote(arbs[0], id, votes[0], salts[0], arbKeys), "RevealNotOpen");
    for (let i = 1; i < 3; i++) await c.commitVote(arbs[i], id, voteCommitment(BigInt(id), arbKeys[i], votes[i], salts[i]));
    await rejects(c.revealVote(arbs[2], id, true, salts[2], arbKeys), "BadReveal"); // nie da się zmienić głosu
    const arb0 = await c.balance(arbKeys[0]);
    await c.revealVote(arbs[2], id, false, salts[2], arbKeys);
    await c.revealVote(arbs[0], id, true, salts[0], arbKeys);
    eq(await state(id), S.InArbitration, "1:1 — jeszcze bez werdyktu");
    await c.revealVote(arbs[1], id, true, salts[1], arbKeys);
    eq(await state(id), S.Refunded, "kupujący wygrał");
    eq((await c.balance(bartek.publicKey)) - b0, usdc(200), "kupujący: kwota + własna kaucja");
    eq((await c.balance(arbKeys[0])) - arb0, bond / 2n, "arbiter większości: połowa kaucji przegranego");
  });

  await test("arbitrzy milczą → po terminie podział 50/50, kaucje wracają", async () => {
    const id = await c.createDeal(alicja, { amount: usdc(100), title: "Cisza arbitrów" });
    await c.fund(bartek, id);
    await c.markShipped(alicja, id, "DEMO-5");
    await c.openDispute(bartek, id, "?");
    await c.respondToDispute(alicja, id);
    const [a0, b0] = [await c.balance(alicja.publicKey), await c.balance(bartek.publicKey)];
    await sleep((W.arbitration + W.reveal + 2) * 1000);
    await c.settleExpired(celina, id);
    eq(await state(id), S.Split, "podział");
    eq((await c.balance(alicja.publicKey)) - a0, usdc(55), "sprzedawczyni: 50 + kaucja 5");
    eq((await c.balance(bartek.publicKey)) - b0, usdc(55), "kupujący: 50 + kaucja 5");
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
    const { pickupHash } = await import("./common.mjs");
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
  });

  const vault = await connection.getTokenAccountBalance(
    (await import("./common.mjs")).pda.vault((await import("./common.mjs")).pda.deal(1n)),
  );
  console.log(`\nSejf transakcji #1 po zakończeniu: ${vault.value.uiAmountString} USDC`);
  console.log(`\n${passed} OK, ${failed} błędów`);
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
