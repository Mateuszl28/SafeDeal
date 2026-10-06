// Relayer oracle doręczeń. Co kilka sekund przegląda przesyłki „w drodze” i potwierdza doręczenie on-chain:
//  • numer InPost (np. 520113017830399002575123) — pyta publiczne API śledzenia InPost (ShipX) i potwierdza,
//    gdy przewoźnik zwróci status „delivered”,
//  • numer DEMO-… — symulacja na prezentację: potwierdza po 15 s.
// Program liczy doręczenie dopiero po `oracle_quorum` zgodnych potwierdzeniach różnych kluczy. W tym MVP
// wszystkie klucze trzyma jeden relayer; w produkcji każde źródło to osobny, niezależny operator
// (API przewoźnika, skan w paczkomacie, Switchboard / Chainlink Functions).
//
// Przy okazji relayer „pcha” losowanie składu arbitrów (draw_panel) od razu, gdy slot losowania minie.
// Może to zrobić każdy — robimy to szybko, żeby żadna strona nie mogła przeczekać niewygodnego wyniku,
// aż slot wypadnie z historii i losowanie zostanie przesunięte.
//   node scripts/oracle-relayer.mjs devnet
import { PublicKey } from "@solana/web3.js";
import { CLUSTER, client, demoKeys, pda, programFor, readDeployments, sleep } from "./common.mjs";

const d = readDeployments()[CLUSTER];
if (!d) throw new Error(`Brak wdrożenia dla ${CLUSTER} — uruchom setup.`);
const c = client(new PublicKey(d.mint));
const { oracles } = demoKeys();
const DEMO_DELAY = 15_000;
const firstSeen = new Map();
const lastStatus = new Map();

/** Status przesyłki z publicznego API InPost (bez klucza). null = nieznany numer albo błąd. */
async function inpostStatus(tracking) {
  try {
    const r = await fetch(`https://api-shipx-pl.easypack24.net/v1/tracking/${encodeURIComponent(tracking)}`, {
      headers: { accept: "application/json" },
    });
    if (!r.ok) return null;
    const j = await r.json();
    const details = Array.isArray(j.tracking_details) ? j.tracking_details.map((t) => t.status) : [];
    return { status: j.status ?? details[0] ?? "unknown", delivered: j.status === "delivered" || details.includes("delivered") };
  } catch {
    return null;
  }
}

async function attestAll(id, deal, why) {
  for (const [i, o] of oracles.entries()) {
    if ((deal.attestedMask >> i) & 1) continue;
    const fresh = await c.fetchDeal(id);
    if (fresh.state !== 3) break; // kworum osiągnięte — stan już „doręczona”
    try {
      const sig = await c.confirmDelivery(o, id);
      console.log(`#${id}: źródło ${i + 1} potwierdziło doręczenie (${why}) — ${sig.slice(0, 12)}…`);
    } catch (e) {
      console.log(`#${id}: źródło ${i + 1} — ${e.message.split("\n")[0]}`);
    }
  }
}

async function tick() {
  // bez getProgramAccounts (darmowe RPC go nie mają): licznik z konfiguracji + konta po adresach PDA
  const program = programFor(oracles[0]);
  const count = Number((await program.account.config.fetch(pda.config())).dealCount);
  const ids = Array.from({ length: count }, (_, i) => BigInt(i + 1));
  const all = (await program.account.deal.fetchMultiple(ids.map((i) => pda.deal(i)))).filter(Boolean);
  for (const deal of all) {
    const id = BigInt(deal.id.toString());
    if (deal.state === 6 && !deal.panelDrawn) {
      try {
        const panel = await c.drawPanel(oracles[0], id);
        console.log(`#${id}: wylosowany skład arbitrów: ${panel.map((k) => k.toBase58().slice(0, 6)).join(", ")}`);
      } catch (e) {
        console.log(`#${id}: losowanie — ${e.message.split("\n")[0]}`);
      }
      continue;
    }
    if (deal.state !== 3) continue;
    const tracking = deal.tracking.trim();

    if (tracking.startsWith("DEMO-")) {
      if (!firstSeen.has(id)) {
        firstSeen.set(id, Date.now());
        console.log(`#${id} ${tracking}: w drodze (demo) — potwierdzę za ${DEMO_DELAY / 1000} s`);
      } else if (Date.now() - firstSeen.get(id) >= DEMO_DELAY) {
        await attestAll(id, deal, "demo");
      }
      continue;
    }

    if (/^\d{20,26}$/.test(tracking)) {
      const s = await inpostStatus(tracking);
      if (!s) continue;
      if (lastStatus.get(id) !== s.status) {
        lastStatus.set(id, s.status);
        console.log(`#${id} InPost ${tracking}: status „${s.status}”`);
      }
      if (s.delivered) await attestAll(id, deal, "InPost: delivered");
    }
  }
}

console.log(`Relayer oracle na ${CLUSTER}: ${oracles.length} klucze źródeł, kworum ${d.oracleQuorum}. Śledzę InPost i DEMO-…`);
for (;;) {
  await tick().catch((e) => console.error("błąd:", e.message));
  await sleep(CLUSTER === "devnet" ? 10_000 : 5000);
}
