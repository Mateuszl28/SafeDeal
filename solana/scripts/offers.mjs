// Dorzuca kilka otwartych ofert Alicji — przed prezentacją, gdy poprzednie zostały kupione.
//   node scripts/offers.mjs devnet
import { PublicKey } from "@solana/web3.js";
import { CLUSTER, client, demoKeys, readDeployments, usdc } from "./common.mjs";

const d = readDeployments()[CLUSTER];
if (!d) throw new Error(`Brak wdrożenia dla ${CLUSTER} — uruchom setup.`);
const c = client(new PublicKey(d.mint));
const { personas: P } = demoKeys();

const OFFERS = [
  ["Rower gravel Kross Esker 2.0", 250, "Rama 54 cm, przebieg ok. 800 km, napęd GRX. Drobna rysa na widelcu."],
  ["iPhone 13, 128 GB", 320, "Bateria 87%, bez blokad, w zestawie etui. Ekran bez rys."],
  ["Konsola PS5 + 2 pady", 400, "Wersja z napędem, dwa pady DualSense, kabel HDMI i zasilający."],
  ["Aparat Sony A6000 z obiektywem", 180, "Obiektyw 16-50 mm, przebieg migawki ok. 12 tys., dwie baterie."],
  ["Rower miejski Romet — odbiór w Warszawie", 130, "Koszyk, błotniki, nowe opony. Odbiór osobisty, Warszawa Mokotów.", true],
];

for (const [title, price, description, pickupAllowed = false] of OFFERS) {
  const id = await c.createDeal(P.Alicja, { amount: usdc(price), title, description, pickupAllowed });
  console.log(`#${id} ${title} — ${price} USDC${pickupAllowed ? " (odbiór osobisty)" : ""}`);
}
