// Off-chainowy oracle doręczeń (wariant MVP). Co kilka sekund sprawdza transakcje w stanie
// "Shipped", pyta API przewoźnika o status przesyłki i przy "delivered" woła confirmDelivery().
// Docelowo tę rolę przejmuje Chainlink Functions (patrz ../oracle/chainlink-functions-source.js),
// dzięki czemu nie trzeba ufać jednemu serwerowi.
//
// Numery zaczynające się od "DEMO" są uznawane za doręczone po DEMO_DELAY_S sekundach.
const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");

const POLL_MS = Number(process.env.POLL_MS || 5000);
const DEMO_DELAY_S = Number(process.env.DEMO_DELAY_S || 15);
const SHIPPED = 3;

async function inpostDelivered(tracking) {
  const res = await fetch(`https://api-shipx-pl.easypack24.net/v1/tracking/${encodeURIComponent(tracking)}`);
  if (!res.ok) return false;
  const body = await res.json();
  return body.status === "delivered";
}

async function main() {
  const { chainId } = await ethers.provider.getNetwork();
  const deployments = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "web", "lib", "deployments.json"), "utf8"));
  const d = deployments[Number(chainId)];
  if (!d) throw new Error(`Brak deploymentu dla chainId ${chainId} — uruchom najpierw deploy`);

  // ORACLE_INDEX wybiera konto — uruchom kilka relayerów (np. 0, 7, 8), każdy z innym źródłem danych
  const signer = (await ethers.getSigners())[Number(process.env.ORACLE_INDEX || 0)];
  const safe = await ethers.getContractAt("SafeDeal", d.safeDeal, signer);
  if (!(await safe.isOracle(signer.address))) {
    throw new Error(`Konto ${signer.address} nie jest oracle tego kontraktu`);
  }
  console.log(`Oracle nasłuchuje: ${d.safeDeal} (co ${POLL_MS} ms)`);

  const seenAt = new Map();
  for (;;) {
    try {
      const count = Number(await safe.dealCount());
      for (let id = 1; id <= count; id++) {
        const deal = await safe.getDeal(id);
        if (Number(deal.state) !== SHIPPED || (await safe.attestedBy(id, signer.address))) continue;

        let delivered;
        if (deal.tracking.startsWith("DEMO")) {
          if (!seenAt.has(id)) seenAt.set(id, Date.now());
          delivered = Date.now() - seenAt.get(id) >= DEMO_DELAY_S * 1000;
        } else {
          delivered = await inpostDelivered(deal.tracking).catch(() => false);
        }

        if (delivered) {
          const tx = await safe.confirmDelivery(id);
          await tx.wait();
          console.log(`#${id} "${deal.title}" — przesyłka ${deal.tracking} doręczona (tx ${tx.hash})`);
        }
      }
    } catch (e) {
      console.error("Błąd pętli oracle:", e.shortMessage || e.message);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
