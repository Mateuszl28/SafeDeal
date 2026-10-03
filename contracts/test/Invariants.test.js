// Test niezmienników księgowych: losowe sekwencje operacji (z ziarnem — każdy błąd da się odtworzyć)
// i po KAŻDYM kroku sprawdzenie, że kontrakt trzyma dokładnie tyle USDC, ile wynika ze stanu transakcji
// i kaucji arbitrów. Na końcu przewijamy czas i rozliczamy wszystko — nic nie może utknąć.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const DAY = 24 * 60 * 60;
const CFG = {
  shipWindow: 5 * DAY,
  transitWindow: 14 * DAY,
  inspectionWindow: 2 * DAY,
  responseWindow: 3 * DAY,
  arbitrationWindow: 7 * DAY,
  revealWindow: 2 * DAY,
  adminDelay: 2 * DAY,
  arbiterStake: 50_000_000n,
  missPenaltyBps: 2000,
  bondBps: 500,
};
const S = { Created: 1, Funded: 2, Shipped: 3, Delivered: 4, Disputed: 5, InArbitration: 6 };
const usdc = (n) => ethers.parseUnits(String(n), 6);

// mulberry32 — mały, deterministyczny generator
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function locked(d) {
  const s = Number(d.state);
  if (s === S.Funded || s === S.Shipped || s === S.Delivered) return d.amount;
  if (s === S.Disputed) return d.amount + d.bond;
  if (s === S.InArbitration) return d.amount + 2n * d.bond;
  return 0n;
}

async function run(seed, steps) {
  const rand = rng(seed);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const signers = await ethers.getSigners();
  const [owner, oracle] = signers;
  const traders = signers.slice(2, 6);
  const poolCandidates = signers.slice(6, 13);
  const council = signers.slice(13, 16);

  const token = await (await ethers.getContractFactory("MockUSDC")).deploy();
  const safe = await (await ethers.getContractFactory("SafeDeal")).deploy(token, [oracle], 1, council, 2, CFG);
  for (const who of [...traders, ...poolCandidates]) {
    await token.mint(who, usdc(100_000));
    await token.connect(who).approve(safe, ethers.MaxUint256);
  }

  const everyone = [...traders, ...poolCandidates, ...council];
  const bySigner = new Map(everyone.map((s) => [s.address, s]));
  const codes = new Map(); // id → kod odbioru
  const salts = new Map(); // `${id}:${arbiter}` → { forBuyer, salt }
  const stats = { ok: 0, reverted: 0 };

  async function check(label) {
    const count = Number(await safe.dealCount());
    let expected = 0n;
    for (let id = 1; id <= count; id++) expected += locked(await safe.getDeal(id));
    for (const s of everyone) expected += await safe.stakeOf(s.address);
    expect(await token.balanceOf(safe), `seed ${seed}, po: ${label}`).to.equal(expected);
  }

  const tryTx = async (p) => {
    try {
      await (await p).wait();
      stats.ok++;
      return true;
    } catch {
      stats.reverted++;
      return false;
    }
  };

  // Losujemy spośród transakcji we właściwym stanie (czasem dowolną — próby nielegalnych ruchów też są cenne).
  const randomDeal = async (...states) => {
    const count = Number(await safe.dealCount());
    if (count === 0) return null;
    const all = [];
    for (let id = 1; id <= count; id++) all.push({ id, d: await safe.getDeal(id) });
    const fit = states.length && rand() < 0.85 ? all.filter((x) => states.includes(Number(x.d.state))) : all;
    return fit.length ? pick(fit) : null;
  };

  const actions = [
    async () => {
      const seller = pick(traders);
      await tryTx(safe.connect(seller).createDeal(usdc(1 + Math.floor(rand() * 500)), "x", ethers.ZeroAddress));
      if (rand() < 0.4) await tryTx(safe.connect(seller).setPickup(await safe.dealCount(), true));
      return "createDeal";
    },
    async () => {
      const x = await randomDeal(S.Created);
      if (!x) return "fund (brak)";
      const buyer = pick(traders);
      if (rand() < 0.5 && (await safe.pickupAllowed(x.id))) {
        const code = ethers.id(`kod-${seed}-${x.id}`);
        if (await tryTx(safe.connect(buyer).fundPickup(x.id, await safe.pickupCodeHash(x.id, code)))) codes.set(x.id, code);
        return "fundPickup";
      }
      await tryTx(safe.connect(buyer).fund(x.id));
      return "fund";
    },
    async () => {
      const x = await randomDeal(S.Funded);
      if (!x) return "ship (brak)";
      await tryTx(safe.connect(bySigner.get(x.d.seller) ?? traders[0]).markShipped(x.id, "DEMO"));
      return "markShipped";
    },
    async () => {
      const x = await randomDeal(S.Shipped);
      if (!x) return "deliver (brak)";
      await tryTx(safe.connect(oracle).confirmDelivery(x.id));
      return "confirmDelivery";
    },
    async () => {
      const x = await randomDeal(S.Shipped, S.Delivered);
      if (!x || !bySigner.get(x.d.buyer)) return "receipt (brak)";
      await tryTx(safe.connect(bySigner.get(x.d.buyer)).confirmReceipt(x.id));
      return "confirmReceipt";
    },
    async () => {
      const x = await randomDeal(S.Shipped, S.Delivered);
      if (!x || !bySigner.get(x.d.buyer)) return "dispute (brak)";
      await tryTx(safe.connect(bySigner.get(x.d.buyer)).openDispute(x.id, "x"));
      return "openDispute";
    },
    async () => {
      const x = await randomDeal(S.Disputed);
      if (!x || !bySigner.get(x.d.seller)) return "respond (brak)";
      await tryTx(safe.connect(bySigner.get(x.d.seller)).respondToDispute(x.id));
      return "respondToDispute";
    },
    async () => {
      const x = await randomDeal(S.InArbitration);
      if (!x || Number(x.d.state) !== S.InArbitration) return "vote (brak)";
      for (const a of await safe.getPanel(x.id)) {
        const arb = bySigner.get(a);
        const key = `${x.id}:${a}`;
        if (!arb) continue;
        if (!salts.has(key) && rand() < 0.7) {
          const v = { forBuyer: rand() < 0.5, salt: ethers.id(`${seed}:${key}`) };
          if (await tryTx(safe.connect(arb).commitVote(x.id, await safe.voteCommitment(x.id, a, v.forBuyer, v.salt)))) salts.set(key, v);
        } else if (salts.has(key) && rand() < 0.7) {
          const v = salts.get(key);
          await tryTx(safe.connect(arb).revealVote(x.id, v.forBuyer, v.salt));
        }
      }
      return "commit/reveal";
    },
    async () => {
      const x = await randomDeal(S.Shipped, S.Delivered, S.Disputed, S.InArbitration);
      if (!x || !bySigner.get(x.d.buyer)) return "settle (brak)";
      const amount = (x.d.amount * BigInt(Math.floor(rand() * 101))) / 100n;
      const [proposer, accepter] = rand() < 0.5 ? [x.d.buyer, x.d.seller] : [x.d.seller, x.d.buyer];
      await tryTx(safe.connect(bySigner.get(proposer)).proposeSettlement(x.id, amount));
      if (rand() < 0.7) await tryTx(safe.connect(bySigner.get(accepter)).acceptSettlement(x.id, amount));
      return "ugoda";
    },
    async () => {
      const x = await randomDeal(S.Funded, S.Shipped, S.Delivered, S.Disputed);
      if (!x || !bySigner.get(x.d.seller)) return "refund (brak)";
      await tryTx(safe.connect(bySigner.get(x.d.seller)).refundBuyer(x.id));
      return "refundBuyer";
    },
    async () => {
      const x = await randomDeal(S.Funded);
      if (!x || !codes.has(x.id) || !bySigner.get(x.d.seller)) return "pickup (brak)";
      await tryTx(safe.connect(bySigner.get(x.d.seller)).confirmPickup(x.id, codes.get(x.id)));
      return "confirmPickup";
    },
    async () => {
      const x = await randomDeal(S.Funded, S.Shipped, S.Delivered, S.Disputed, S.InArbitration);
      if (!x) return "expire (brak)";
      await tryTx(safe.settleExpired(x.id));
      return "settleExpired";
    },
    async () => {
      await time.increase(Math.floor(rand() * 10 * DAY));
      return "upływ czasu";
    },
    async () => {
      const who = pick(poolCandidates);
      if (rand() < 0.6) await tryTx(safe.connect(who).joinPool());
      else await tryTx(safe.connect(who).leavePool());
      return "pula";
    },
  ];

  // tworzenie i opłacanie losujemy częściej, żeby zawsze było co przeprowadzać przez kolejne stany
  const weighted = [actions[0], actions[0], actions[1], actions[1], ...actions];
  for (let i = 0; i < steps; i++) {
    const label = await pick(weighted)();
    await check(`krok ${i}: ${label}`);
  }

  // Domknięcie: po długim czasie każdą otwartą transakcję da się rozliczyć — nic nie utyka.
  await time.increase(60 * DAY);
  const count = Number(await safe.dealCount());
  for (let id = 1; id <= count; id++) {
    const st = Number((await safe.getDeal(id)).state);
    if (st >= S.Funded && st <= S.InArbitration) await (await safe.settleExpired(id)).wait();
  }
  await check("rozliczenie wszystkiego");
  for (let id = 1; id <= count; id++) expect(locked(await safe.getDeal(id))).to.equal(0n);
  return { ...stats, deals: count };
}

describe("niezmienniki księgowe (losowe sekwencje)", function () {
  this.timeout(600_000);
  for (const seed of [7, 2026, 31337]) {
    it(`ziarno ${seed}: saldo kontraktu = blokady transakcji + kaucje arbitrów po każdym kroku`, async () => {
      const r = await run(seed, 400);
      expect(r.ok).to.be.greaterThan(150); // sekwencja musi faktycznie coś robić, nie tylko odbijać się od reverta
      console.log(`      ziarno ${seed}: ${r.deals} transakcji, ${r.ok} udanych operacji, ${r.reverted} odrzuconych`);
    });
  }
});
