// Dorzuca kilka otwartych ofert Alicji — przed prezentacją, gdy poprzednie zostały kupione.
//   node scripts/offers.mjs devnet
import { PublicKey } from "@solana/web3.js";
import { CLUSTER, client, demoKeys, readDeployments, usdc } from "./common.mjs";

const d = readDeployments()[CLUSTER];
if (!d) throw new Error(`Brak wdrożenia dla ${CLUSTER} — uruchom setup.`);
const c = client(new PublicKey(d.mint));
const { personas: P } = demoKeys();

const OFFERS = [
  ["Kross Esker 2.0 gravel bike", 250, "54 cm frame, about 800 km ridden, GRX groupset. Small scratch on the fork."],
  ["iPhone 13, 128 GB", 320, "Battery 87%, unlocked, case included. No scratches on the screen."],
  ["PS5 console + 2 controllers", 400, "Disc edition, two DualSense controllers, HDMI and power cables."],
  ["Sony A6000 camera with lens", 180, "16-50 mm lens, about 12k shutter count, two batteries."],
  ["Romet city bike — pickup in Warsaw", 130, "Basket, mudguards, new tyres. Pickup in person, Warsaw Mokotów.", true],
];

for (const [title, price, description, pickupAllowed = false] of OFFERS) {
  const id = await c.createDeal(P.Alicja, { amount: usdc(price), title, description, pickupAllowed });
  console.log(`#${id} ${title} — ${price} USDC${pickupAllowed ? " (odbiór osobisty)" : ""}`);
}
