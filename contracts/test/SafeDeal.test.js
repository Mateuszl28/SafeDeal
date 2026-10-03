const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

const S = {
  None: 0, Created: 1, Funded: 2, Shipped: 3, Delivered: 4, Disputed: 5,
  InArbitration: 6, Released: 7, Refunded: 8, Split: 9, Cancelled: 10, Settled: 11,
};
const DAY = 24 * 60 * 60;
const CFG = {
  shipWindow: 5 * DAY,
  transitWindow: 14 * DAY,
  inspectionWindow: 2 * DAY,
  responseWindow: 3 * DAY,
  arbitrationWindow: 7 * DAY,
  revealWindow: 2 * DAY,
  adminDelay: 2 * DAY,
  arbiterStake: 50_000_000n, // 50 USDC
  missPenaltyBps: 2000, // 20% kaucji za nieoddany głos
  bondBps: 500, // 5%
};
const salt = (n) => ethers.zeroPadValue(ethers.toBeHex(n), 32);

/** Faza 1 dla wszystkich podanych arbitrów: [signer, forBuyer][] */
async function commitAll(safe, votes) {
  for (const [i, [arb, forBuyer]] of votes.entries()) {
    await safe.connect(arb).commitVote(1, await safe.voteCommitment(1, arb.address, forBuyer, salt(i + 1)));
  }
  return (arb, forBuyer) => safe.connect(arb).revealVote(1, forBuyer, salt(votes.findIndex(([a]) => a === arb) + 1));
}
const usdc = (n) => ethers.parseUnits(String(n), 6);
const PRICE = usdc(200);
const BOND = usdc(10);

async function deployWith(oracleQuorum) {
  const [owner, oracle, seller, buyer, a1, a2, a3, stranger, o2, o3, p1, p2, p3, p4] = await ethers.getSigners();
  const token = await (await ethers.getContractFactory("MockUSDC")).deploy();
  const safe = await (await ethers.getContractFactory("SafeDeal")).deploy(
    token, [oracle, o2, o3], oracleQuorum, [a1, a2, a3], 2, CFG,
  );
  for (const who of [seller, buyer, p1, p2, p3, p4]) {
    await token.mint(who, usdc(1000));
    await token.connect(who).approve(safe, ethers.MaxUint256);
  }
  return { safe, token, owner, oracle, o2, o3, seller, buyer, a1, a2, a3, stranger, p1, p2, p3, p4 };
}

const deploy = () => deployWith(1);
const deployTwoOfThree = () => deployWith(2);

async function funded() {
  const f = await loadFixture(deploy);
  await f.safe.connect(f.seller).createDeal(PRICE, "Rower gravel", ethers.ZeroAddress);
  await f.safe.connect(f.buyer).fund(1);
  return f;
}

async function shipped() {
  const f = await funded();
  await f.safe.connect(f.seller).markShipped(1, "DEMO123");
  return f;
}

async function inArbitration() {
  const f = await shipped();
  await f.safe.connect(f.buyer).openDispute(1, "Pusta paczka");
  await f.safe.connect(f.seller).respondToDispute(1);
  return f;
}

describe("SafeDeal", () => {
  describe("ścieżka szczęśliwa", () => {
    it("oracle potwierdza doręczenie, po oknie reklamacji ktokolwiek wypłaca sprzedawcy", async () => {
      const { safe, token, oracle, seller, buyer, stranger } = await shipped();
      expect(await token.balanceOf(safe)).to.equal(PRICE);

      await safe.connect(oracle).confirmDelivery(1);
      expect((await safe.getDeal(1)).state).to.equal(S.Delivered);
      await expect(safe.connect(stranger).settleExpired(1)).to.be.revertedWithCustomError(safe, "DeadlineNotReached");

      await time.increase(CFG.inspectionWindow + 1);
      await expect(safe.connect(stranger).settleExpired(1)).to.changeTokenBalances(token, [seller, safe], [PRICE, -PRICE]);
      expect((await safe.getDeal(1)).state).to.equal(S.Released);

      const rep = await safe.reputation(seller);
      expect(rep.soldOk).to.equal(1);
      expect((await safe.reputation(buyer)).boughtOk).to.equal(1);
    });

    it("kupujący może potwierdzić odbiór od razu", async () => {
      const { safe, token, seller, buyer } = await shipped();
      await expect(safe.connect(buyer).confirmReceipt(1)).to.changeTokenBalance(token, seller, PRICE);
    });

    it("oferta skierowana do konkretnego kupującego odrzuca innych", async () => {
      const { safe, seller, buyer, stranger } = await loadFixture(deploy);
      await safe.connect(seller).createDeal(PRICE, "Laptop", buyer);
      await expect(safe.connect(stranger).fund(1)).to.be.revertedWithCustomError(safe, "NotAllowed");
      await safe.connect(buyer).fund(1);
    });

    it("sprzedawca może anulować niezapłaconą ofertę", async () => {
      const { safe, seller } = await loadFixture(deploy);
      await safe.connect(seller).createDeal(PRICE, "Laptop", ethers.ZeroAddress);
      await safe.connect(seller).cancel(1);
      expect((await safe.getDeal(1)).state).to.equal(S.Cancelled);
    });
  });

  describe("sprzedawca znika", () => {
    it("nienadana paczka → zwrot kupującemu po deadline", async () => {
      const { safe, token, seller, buyer, stranger } = await funded();
      await time.increase(CFG.shipWindow + 1);
      await expect(safe.connect(seller).markShipped(1, "X")).to.be.revertedWithCustomError(safe, "DeadlinePassed");
      await expect(safe.connect(stranger).settleExpired(1)).to.changeTokenBalance(token, buyer, PRICE);
      expect((await safe.getDeal(1)).state).to.equal(S.Refunded);
    });

    it("sprzedawca ignoruje spór → kupujący dostaje kwotę i kaucję", async () => {
      const { safe, token, buyer } = await shipped();
      await safe.connect(buyer).openDispute(1, "Nie to co w opisie");
      await time.increase(CFG.responseWindow + 1);
      await expect(safe.settleExpired(1)).to.changeTokenBalance(token, buyer, PRICE + BOND);
    });
  });

  describe("kupujący znika", () => {
    it("brak potwierdzenia oracle i brak reklamacji → wypłata sprzedawcy po transit+inspection", async () => {
      const { safe, token, seller } = await shipped();
      await time.increase(CFG.transitWindow + CFG.inspectionWindow + 1);
      await expect(safe.settleExpired(1)).to.changeTokenBalance(token, seller, PRICE);
    });
  });

  describe("spór i arbitraż", () => {
    it("arbitrzy przyznają rację kupującemu; kaucja sprzedawcy idzie do głosujących za kupującym", async () => {
      const { safe, token, buyer, seller, a1, a2, a3 } = await inArbitration();
      const reveal = await commitAll(safe, [[a1, true], [a2, true], [a3, false]]);
      await reveal(a3, false);
      await reveal(a1, true);
      await expect(reveal(a2, true)).to.changeTokenBalances(
        token,
        [buyer, seller, a1, a2, a3],
        [PRICE + BOND, 0, BOND / 2n, BOND / 2n, 0],
      );
      expect((await safe.getDeal(1)).state).to.equal(S.Refunded);
      expect((await safe.reputation(seller)).disputesLost).to.equal(1);
      expect(await token.balanceOf(safe)).to.equal(0);
    });

    it("arbitrzy przyznają rację sprzedawcy", async () => {
      const { safe, token, seller, a1, a2, a3 } = await inArbitration();
      const reveal = await commitAll(safe, [[a1, false], [a2, false], [a3, true]]);
      await reveal(a1, false);
      await expect(reveal(a2, false)).to.changeTokenBalance(token, seller, PRICE + BOND);
      expect((await safe.getDeal(1)).state).to.equal(S.Released);
    });

    it("arbitrzy milczą → podział 50/50 i zwrot kaucji", async () => {
      const { safe, token, buyer, seller } = await inArbitration();
      await time.increase(CFG.arbitrationWindow + 1);
      await expect(safe.settleExpired(1)).to.be.revertedWithCustomError(safe, "DeadlineNotReached");
      await time.increase(CFG.revealWindow);
      await expect(safe.settleExpired(1)).to.changeTokenBalances(
        token, [buyer, seller], [PRICE / 2n + BOND, PRICE / 2n + BOND],
      );
      expect((await safe.getDeal(1)).state).to.equal(S.Split);
    });

    it("sprzedawca może uznać reklamację zamiast iść do arbitrażu", async () => {
      const { safe, token, buyer, seller } = await shipped();
      await safe.connect(buyer).openDispute(1, "Uszkodzony");
      await expect(safe.connect(seller).refundBuyer(1)).to.changeTokenBalance(token, buyer, PRICE + BOND);
    });

    it("arbiter nie głosuje dwa razy, obcy nie głosuje wcale", async () => {
      const { safe, a1, a2, a3, stranger } = await inArbitration();
      const reveal = await commitAll(safe, [[a1, true], [a2, false], [a3, false]]);
      await expect(safe.connect(a1).commitVote(1, ethers.id("drugi raz"))).to.be.revertedWithCustomError(safe, "NotAllowed");
      await expect(safe.connect(stranger).commitVote(1, ethers.id("x"))).to.be.revertedWithCustomError(safe, "NotAllowed");
      await reveal(a1, true);
      await expect(reveal(a1, true)).to.be.revertedWithCustomError(safe, "NotAllowed");
      await expect(safe.connect(stranger).revealVote(1, true, salt(1))).to.be.revertedWithCustomError(safe, "NotAllowed");
    });
  });

  describe("niejawne głosowanie (commit-reveal)", () => {
    it("głosy są ukryte, dopóki wszyscy nie zagłosują — nie da się podejrzeć ani skopiować", async () => {
      const { safe, a1, a2 } = await inArbitration();
      await safe.connect(a1).commitVote(1, await safe.voteCommitment(1, a1.address, true, salt(1)));
      expect(await safe.revealOpen(1)).to.equal(false);
      await expect(safe.connect(a1).revealVote(1, true, salt(1))).to.be.revertedWithCustomError(safe, "RevealNotOpen");
      expect(await safe.voteOf(1, a1.address)).to.equal(0); // on-chain widać tylko hash
      await safe.connect(a2).commitVote(1, await safe.voteCommitment(1, a2.address, true, salt(2)));
      expect(await safe.revealOpen(1)).to.equal(false);
    });

    it("nie można ujawnić innego głosu niż zadeklarowany", async () => {
      const { safe, a1, a2, a3 } = await inArbitration();
      await commitAll(safe, [[a1, true], [a2, true], [a3, true]]);
      await expect(safe.connect(a1).revealVote(1, false, salt(1))).to.be.revertedWithCustomError(safe, "BadReveal");
      await expect(safe.connect(a1).revealVote(1, true, salt(99))).to.be.revertedWithCustomError(safe, "BadReveal");
    });

    it("po czasie fazy 1 ujawnianie rusza nawet bez kompletu głosów; spóźniony commit odrzucony", async () => {
      const { safe, token, buyer, a1, a2, a3 } = await inArbitration();
      await safe.connect(a1).commitVote(1, await safe.voteCommitment(1, a1.address, true, salt(1)));
      await safe.connect(a2).commitVote(1, await safe.voteCommitment(1, a2.address, true, salt(2)));
      await time.increase(CFG.arbitrationWindow + 1);
      await expect(safe.connect(a3).commitVote(1, ethers.id("za późno"))).to.be.revertedWithCustomError(safe, "DeadlinePassed");
      await safe.connect(a1).revealVote(1, true, salt(1));
      await expect(safe.connect(a2).revealVote(1, true, salt(2))).to.changeTokenBalance(token, buyer, PRICE + BOND);
    });
  });

  describe("wiele oracle'i (2 z 3)", () => {
    async function shippedTwoOfThree() {
      const f = await loadFixture(deployTwoOfThree);
      await f.safe.connect(f.seller).createDeal(PRICE, "Rower", ethers.ZeroAddress);
      await f.safe.connect(f.buyer).fund(1);
      await f.safe.connect(f.seller).markShipped(1, "DEMO1");
      return f;
    }

    it("jedno potwierdzenie nie wystarcza; dwa niezależne zmieniają stan", async () => {
      const { safe, oracle, o3 } = await shippedTwoOfThree();
      await expect(safe.connect(oracle).confirmDelivery(1)).to.emit(safe, "DeliveryAttested").withArgs(1, oracle.address, 1);
      expect((await safe.getDeal(1)).state).to.equal(S.Shipped);
      await expect(safe.connect(o3).confirmDelivery(1)).to.emit(safe, "DealDelivered");
      expect((await safe.getDeal(1)).state).to.equal(S.Delivered);
    });

    it("ten sam oracle nie może potwierdzić dwa razy, obcy wcale", async () => {
      const { safe, oracle, stranger } = await shippedTwoOfThree();
      await safe.connect(oracle).confirmDelivery(1);
      await expect(safe.connect(oracle).confirmDelivery(1)).to.be.revertedWithCustomError(safe, "NotAllowed");
      await expect(safe.connect(stranger).confirmDelivery(1)).to.be.revertedWithCustomError(safe, "NotAllowed");
    });
  });

  describe("reputacja arbitrów", () => {
    it("liczy głosy zgodne i niezgodne z werdyktem; brak głosu = nieobecność", async () => {
      const { safe, a1, a2, a3 } = await inArbitration();
      await safe.connect(a1).commitVote(1, await safe.voteCommitment(1, a1.address, true, salt(1)));
      await safe.connect(a2).commitVote(1, await safe.voteCommitment(1, a2.address, false, salt(2)));
      await time.increase(CFG.arbitrationWindow + 1); // a3 przespał fazę 1
      await safe.connect(a2).revealVote(1, false, salt(2));
      await safe.connect(a1).revealVote(1, true, salt(1));
      await time.increase(CFG.revealWindow);
      await safe.settleExpired(1); // 1:1 → brak większości → 50/50
      expect((await safe.arbiterStats(a3)).missed).to.equal(1);
      expect((await safe.arbiterStats(a1)).missed).to.equal(0);
    });

    it("po werdykcie: większość +1 zgodny, mniejszość +1 przeciw", async () => {
      const { safe, a1, a2, a3 } = await inArbitration();
      const reveal = await commitAll(safe, [[a1, true], [a2, true], [a3, false]]);
      await reveal(a3, false);
      await reveal(a1, true);
      await reveal(a2, true);
      expect((await safe.arbiterStats(a1)).withMajority).to.equal(1);
      expect((await safe.arbiterStats(a3)).againstMajority).to.equal(1);
    });
  });

  describe("opis oferty", () => {
    const HASH = ethers.keccak256(ethers.toUtf8Bytes("rower.jpg"));

    it("sprzedawca opisuje ofertę przed wpłatą; po wpłacie opis jest zamrożony", async () => {
      const { safe, seller, buyer } = await loadFixture(deploy);
      await safe.connect(seller).createDeal(PRICE, "Rower", ethers.ZeroAddress);
      await expect(safe.connect(seller).describe(1, "Rama 54, przebieg 800 km", "/api/evidence/abc", HASH))
        .to.emit(safe, "Listing").withArgs(1, "Rama 54, przebieg 800 km", "/api/evidence/abc", HASH);
      await expect(safe.connect(buyer).describe(1, "inny opis", "", ethers.ZeroHash)).to.be.revertedWithCustomError(safe, "NotAllowed");
      await safe.connect(buyer).fund(1);
      await expect(safe.connect(seller).describe(1, "podmiana", "", ethers.ZeroHash)).to.be.revertedWithCustomError(safe, "WrongState");
    });
  });

  describe("odbiór osobisty z kodem", () => {
    const CODE = ethers.id("ABCD-EFGH-JKLM-NPQR");

    async function pickupFunded() {
      const f = await loadFixture(deploy);
      await f.safe.connect(f.seller).createDeal(PRICE, "Rower miejski", ethers.ZeroAddress);
      await f.safe.connect(f.seller).setPickup(1, true);
      await f.safe.connect(f.buyer).fundPickup(1, await f.safe.pickupCodeHash(1, CODE));
      return f;
    }

    it("prawidłowy kod od kupującego → natychmiastowa wypłata dla sprzedawcy", async () => {
      const { safe, token, seller, buyer } = await pickupFunded();
      const tx = safe.connect(seller).confirmPickup(1, CODE);
      await expect(tx).to.changeTokenBalance(token, seller, PRICE);
      await expect(tx).to.emit(safe, "PickupConfirmed").withArgs(1);
      expect((await safe.getDeal(1)).state).to.equal(S.Released);
      expect((await safe.reputation(buyer)).boughtOk).to.equal(1);
    });

    it("zły kod, obcy lub wysyłka zamiast odbioru — odrzucone", async () => {
      const { safe, seller, stranger } = await pickupFunded();
      await expect(safe.connect(seller).confirmPickup(1, ethers.id("zgaduję"))).to.be.revertedWithCustomError(safe, "BadReveal");
      await expect(safe.connect(stranger).confirmPickup(1, CODE)).to.be.revertedWithCustomError(safe, "NotAllowed");
      await expect(safe.connect(seller).markShipped(1, "DEMO")).to.be.revertedWithCustomError(safe, "NotAllowed");
    });

    it("bez zgody sprzedawcy nie ma odbioru osobistego; po terminie pieniądze wracają", async () => {
      const f = await loadFixture(deploy);
      await f.safe.connect(f.seller).createDeal(PRICE, "X", ethers.ZeroAddress);
      await expect(f.safe.connect(f.buyer).fundPickup(1, ethers.id("h"))).to.be.revertedWithCustomError(f.safe, "NotAllowed");
      const { safe, token, buyer, seller } = await pickupFunded();
      await time.increase(CFG.shipWindow + 1);
      await expect(safe.connect(seller).confirmPickup(1, CODE)).to.be.revertedWithCustomError(safe, "DeadlinePassed");
      await expect(safe.settleExpired(1)).to.changeTokenBalance(token, buyer, PRICE);
    });
  });

  describe("opinie", () => {
    it("obie strony oceniają się po zamknięciu — raz, z kwotą transakcji w wadze", async () => {
      const { safe, seller, buyer } = await shipped();
      await expect(safe.connect(buyer).review(1, 5, "Szybko i zgodnie z opisem")).to.be.revertedWithCustomError(safe, "WrongState");
      await safe.connect(buyer).confirmReceipt(1);
      await expect(safe.connect(buyer).review(1, 5, "Szybko i zgodnie z opisem"))
        .to.emit(safe, "Reviewed").withArgs(1, buyer.address, seller.address, 5, "Szybko i zgodnie z opisem");
      await safe.connect(seller).review(1, 4, "Sprawna płatność");
      const r = await safe.ratings(seller);
      expect(r.count).to.equal(1);
      expect(r.starsSum).to.equal(5);
      expect(r.volume).to.equal(PRICE);
      await expect(safe.connect(buyer).review(1, 1, "zmiana zdania")).to.be.revertedWithCustomError(safe, "NotAllowed");
    });

    it("obcy nie ocenia, gwiazdki 1–5, anulowana oferta bez opinii", async () => {
      const { safe, seller, buyer, stranger } = await shipped();
      await safe.connect(buyer).confirmReceipt(1);
      await expect(safe.connect(stranger).review(1, 5, "")).to.be.revertedWithCustomError(safe, "NotAllowed");
      await expect(safe.connect(buyer).review(1, 0, "")).to.be.revertedWithCustomError(safe, "InvalidParams");
      await expect(safe.connect(buyer).review(1, 6, "")).to.be.revertedWithCustomError(safe, "InvalidParams");
      await safe.connect(seller).createDeal(PRICE, "X", ethers.ZeroAddress);
      await safe.connect(seller).cancel(2);
      await expect(safe.connect(seller).review(2, 5, "")).to.be.revertedWithCustomError(safe, "WrongState");
    });
  });

  describe("ugoda", () => {
    it("sprzedawca proponuje 30% zwrotu, kupujący akceptuje — podział bez arbitrów", async () => {
      const { safe, token, seller, buyer } = await shipped();
      const back = PRICE * 30n / 100n;
      await expect(safe.connect(seller).proposeSettlement(1, back))
        .to.emit(safe, "SettlementProposed").withArgs(1, seller.address, back);
      await expect(safe.connect(buyer).acceptSettlement(1, back)).to.changeTokenBalances(
        token, [buyer, seller, safe], [back, PRICE - back, -PRICE],
      );
      expect((await safe.getDeal(1)).state).to.equal(S.Settled);
    });

    it("ugoda w trakcie arbitrażu zwraca obie kaucje", async () => {
      const { safe, token, seller, buyer } = await inArbitration();
      await safe.connect(buyer).proposeSettlement(1, PRICE / 2n);
      await expect(safe.connect(seller).acceptSettlement(1, PRICE / 2n)).to.changeTokenBalances(
        token, [buyer, seller, safe], [PRICE / 2n + BOND, PRICE / 2n + BOND, -(PRICE + 2n * BOND)],
      );
    });

    it("nie można przyjąć własnej oferty, oferty podmienionej ani oferty ponad kwotę", async () => {
      const { safe, seller, buyer, stranger } = await shipped();
      await expect(safe.connect(buyer).proposeSettlement(1, PRICE + 1n)).to.be.revertedWithCustomError(safe, "InvalidParams");
      await expect(safe.connect(stranger).proposeSettlement(1, 1n)).to.be.revertedWithCustomError(safe, "NotAllowed");
      await safe.connect(seller).proposeSettlement(1, usdc(20));
      await expect(safe.connect(seller).acceptSettlement(1, usdc(20))).to.be.revertedWithCustomError(safe, "NotAllowed");
      await safe.connect(seller).proposeSettlement(1, usdc(5)); // sprzedawca obniża ofertę tuż przed akceptacją
      await expect(safe.connect(buyer).acceptSettlement(1, usdc(20))).to.be.revertedWithCustomError(safe, "OfferMismatch");
    });

    it("po zamknięciu transakcji ugoda jest niemożliwa", async () => {
      const { safe, seller, buyer } = await shipped();
      await safe.connect(seller).proposeSettlement(1, usdc(20));
      await safe.connect(buyer).confirmReceipt(1);
      await expect(safe.connect(buyer).acceptSettlement(1, usdc(20))).to.be.revertedWithCustomError(safe, "WrongState");
    });
  });

  describe("dowody", () => {
    const HASH = ethers.keccak256(ethers.toUtf8Bytes("zdjecie"));

    it("obie strony mogą dodać dowód w trakcie sporu — hash trafia do zdarzenia", async () => {
      const { safe, buyer, seller } = await shipped();
      await safe.connect(buyer).openDispute(1, "Pęknięta rama");
      await expect(safe.connect(buyer).submitEvidence(1, "/api/evidence/abc", HASH, "Zdjęcie ramy"))
        .to.emit(safe, "Evidence")
        .withArgs(1, buyer.address, "/api/evidence/abc", HASH, "Zdjęcie ramy");
      await expect(safe.connect(seller).submitEvidence(1, "/api/evidence/def", HASH, "Zdjęcie przed nadaniem"))
        .to.emit(safe, "Evidence");
    });

    it("obcy nie doda dowodu, a po zamknięciu transakcji nikt", async () => {
      const { safe, buyer, stranger } = await shipped();
      await expect(safe.connect(stranger).submitEvidence(1, "x", HASH, "")).to.be.revertedWithCustomError(safe, "NotAllowed");
      await safe.connect(buyer).confirmReceipt(1);
      await expect(safe.connect(buyer).submitEvidence(1, "x", HASH, "")).to.be.revertedWithCustomError(safe, "WrongState");
    });
  });

  describe("timelock zmian administracyjnych", () => {
    it("zmiana oracle'i wchodzi dopiero po opóźnieniu i może ją wprowadzić każdy", async () => {
      const { safe, owner, stranger } = await loadFixture(deploy);
      await expect(safe.connect(owner).setOracles([owner.address], 1)).to.emit(safe, "OraclesChangeScheduled");
      expect(await safe.isOracle(owner.address)).to.equal(false);
      await expect(safe.applyOracles()).to.be.revertedWithCustomError(safe, "DeadlineNotReached");
      await time.increase(CFG.adminDelay);
      await safe.connect(stranger).applyOracles();
      expect(await safe.isOracle(owner.address)).to.equal(true);
      await expect(safe.applyOracles()).to.be.revertedWithCustomError(safe, "NotAllowed");
    });

    it("tylko właściciel planuje zmiany; wycofana zmiana nie wchodzi", async () => {
      const { safe, owner, stranger } = await loadFixture(deploy);
      await expect(safe.connect(stranger).setArbiters([stranger.address], 1)).to.be.revertedWithCustomError(safe, "OwnableUnauthorizedAccount");
      await safe.connect(owner).setArbiters([owner.address], 1);
      await safe.connect(owner).cancelPending();
      await time.increase(CFG.adminDelay);
      await expect(safe.applyArbiters()).to.be.revertedWithCustomError(safe, "NotAllowed");
      expect(await safe.isArbiter(owner.address)).to.equal(false);
    });

    it("arbiter usunięty w trakcie sporu i tak dostaje udział — nic nie zostaje w kontrakcie", async () => {
      const { safe, token, owner, buyer, a1, a2, a3, stranger } = await inArbitration();
      const reveal = await commitAll(safe, [[a1, true], [a2, true], [a3, false]]);
      await safe.connect(owner).setArbiters([a1.address, a3.address, stranger.address], 2);
      await time.increase(CFG.adminDelay);
      await safe.applyArbiters();
      await reveal(a2, true); // a2 nie jest już w puli, ale głos złożył, gdy był
      await expect(reveal(a1, true)).to.changeTokenBalances(token, [buyer, a1, a2], [PRICE + BOND, BOND / 2n, BOND / 2n]);
      expect(await token.balanceOf(safe)).to.equal(0);
    });
  });

  describe("pula arbitrów z kaucją", () => {
    const STAKE = 50_000_000n;

    async function disputeWithPool(members) {
      const f = await loadFixture(deploy);
      for (const m of members(f)) await f.safe.connect(m).joinPool();
      await f.safe.connect(f.seller).createDeal(PRICE, "Konsola", ethers.ZeroAddress);
      await f.safe.connect(f.buyer).fund(1);
      await f.safe.connect(f.seller).markShipped(1, "DEMO");
      await f.safe.connect(f.buyer).openDispute(1, "Nie działa");
      await f.safe.connect(f.seller).respondToDispute(1);
      return f;
    }

    it("skład 3 osób jest losowany z puli i tylko on głosuje; rada nie ma tu głosu", async () => {
      const { safe, token, p1, p2, p3, p4, a1 } = await disputeWithPool((f) => [f.p1, f.p2, f.p3, f.p4]);
      expect(await token.balanceOf(safe)).to.equal(PRICE + 2n * BOND + 4n * STAKE);
      const panel = await safe.getPanel(1);
      expect(panel.length).to.equal(3);
      expect(new Set(panel).size).to.equal(3);
      for (const a of panel) expect([p1, p2, p3, p4].map((p) => p.address)).to.include(a);
      expect(await safe.panelFromPool(1)).to.equal(true);
      await expect(safe.connect(a1).commitVote(1, ethers.id("x"))).to.be.revertedWithCustomError(safe, "NotAllowed");
      const outsider = [p1, p2, p3, p4].find((p) => !panel.includes(p.address));
      await expect(safe.connect(outsider).commitVote(1, ethers.id("x"))).to.be.revertedWithCustomError(safe, "NotAllowed");
    });

    it("strona sporu nie trafia do składu własnej sprawy", async () => {
      const { safe, seller } = await disputeWithPool((f) => [f.seller, f.p1, f.p2, f.p3]);
      expect(await safe.getPanel(1)).to.not.include(seller.address);
    });

    it("nieobecny w składzie traci 20% kaucji na rzecz zwycięzcy; po sprawie można wyjść z puli", async () => {
      const f = await disputeWithPool((x) => [x.p1, x.p2, x.p3]);
      const { safe, token, buyer } = f;
      const signers = await ethers.getSigners();
      const panel = (await safe.getPanel(1)).map((a) => signers.find((s) => s.address === a));
      const [x, y, absent] = panel;
      for (const [i, m] of [x, y].entries()) {
        await safe.connect(m).commitVote(1, await safe.voteCommitment(1, m.address, true, salt(i + 1)));
      }
      await expect(safe.connect(x).leavePool()).to.be.revertedWithCustomError(safe, "NotAllowed"); // ma otwartą sprawę
      await time.increase(CFG.arbitrationWindow + 1);
      await safe.connect(x).revealVote(1, true, salt(1));
      const penalty = STAKE / 5n;
      await expect(safe.connect(y).revealVote(1, true, salt(2))).to.changeTokenBalance(token, buyer, PRICE + BOND + penalty);
      expect(await safe.stakeOf(absent)).to.equal(STAKE - penalty);
      expect((await safe.arbiterStats(absent)).missed).to.equal(1);
      await expect(safe.connect(absent).leavePool()).to.changeTokenBalance(token, absent, STAKE - penalty);
      expect(await safe.inPool(absent.address)).to.equal(false);
    });

    it("za mała pula → sprawę dostaje rada arbitrów", async () => {
      const { safe, a1, a2, a3 } = await disputeWithPool((f) => [f.p1, f.p2]);
      expect(await safe.panelFromPool(1)).to.equal(false);
      expect(await safe.getPanel(1)).to.deep.equal([a1.address, a2.address, a3.address]);
    });

    it("nie można dołączyć dwa razy ani wyjść, nie będąc w puli", async () => {
      const { safe, p1, p2 } = await loadFixture(deploy);
      await safe.connect(p1).joinPool();
      await expect(safe.connect(p1).joinPool()).to.be.revertedWithCustomError(safe, "NotAllowed");
      await expect(safe.connect(p2).leavePool()).to.be.revertedWithCustomError(safe, "NotAllowed");
    });
  });

  describe("kontrola dostępu", () => {
    it("tylko oracle potwierdza doręczenie", async () => {
      const { safe, seller } = await shipped();
      await expect(safe.connect(seller).confirmDelivery(1)).to.be.revertedWithCustomError(safe, "NotAllowed");
    });

    it("sprzedawca nie może kupić własnej oferty ani wypłacić środków", async () => {
      const { safe, seller } = await loadFixture(deploy);
      await safe.connect(seller).createDeal(PRICE, "X", ethers.ZeroAddress);
      await expect(safe.connect(seller).fund(1)).to.be.revertedWithCustomError(safe, "NotAllowed");
    });

    it("nikt nie przyspieszy wypłaty przed czasem", async () => {
      const { safe, seller } = await shipped();
      await expect(safe.connect(seller).settleExpired(1)).to.be.revertedWithCustomError(safe, "DeadlineNotReached");
      await expect(safe.connect(seller).confirmReceipt(1)).to.be.revertedWithCustomError(safe, "NotAllowed");
    });
  });
});
