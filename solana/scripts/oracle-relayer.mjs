// Relayer oracle doręczeń (demo): co kilka sekund sprawdza przesyłki „w drodze” z numerem DEMO-…
// i po 15 s potwierdza doręczenie z kluczy kolejnych źródeł (aż do kworum).
// W produkcji każde źródło to osobny, niezależny operator (API przewoźnika, skan w paczkomacie,
// Switchboard/Chainlink Functions) — program liczy dopiero zgodne potwierdzenia `oracle_quorum` z nich.
//   node scripts/oracle-relayer.mjs devnet
import { PublicKey } from "@solana/web3.js";
import { CLUSTER, client, demoKeys, programFor, readDeployments, sleep } from "./common.mjs";

const d = readDeployments()[CLUSTER];
if (!d) throw new Error(`Brak wdrożenia dla ${CLUSTER} — uruchom setup.`);
const c = client(new PublicKey(d.mint));
const { oracles } = demoKeys();
const DELAY = 15_000;
const firstSeen = new Map();

async function tick() {
  const all = await programFor(oracles[0]).account.deal.all();
  for (const { account: deal } of all) {
    const id = BigInt(deal.id.toString());
    if (deal.state !== 3 || !deal.tracking.startsWith("DEMO-")) continue;
    if (!firstSeen.has(id)) {
      firstSeen.set(id, Date.now());
      console.log(`#${id} ${deal.tracking}: w drodze — potwierdzę za ${DELAY / 1000} s`);
      continue;
    }
    if (Date.now() - firstSeen.get(id) < DELAY) continue;
    for (const [i, o] of oracles.entries()) {
      if ((deal.attestedMask >> i) & 1) continue;
      const fresh = await c.fetchDeal(id);
      if (fresh.state !== 3) break;
      try {
        const sig = await c.confirmDelivery(o, id);
        console.log(`#${id}: źródło ${i + 1} potwierdziło doręczenie (${sig.slice(0, 12)}…)`);
      } catch (e) {
        console.log(`#${id}: źródło ${i + 1} — ${e.message.split("\n")[0]}`);
      }
    }
  }
}

console.log(`Relayer oracle na ${CLUSTER}, ${oracles.length} źródła, kworum ${d.oracleQuorum}`);
for (;;) {
  await tick().catch((e) => console.error("błąd:", e.message));
  await sleep(5000);
}
