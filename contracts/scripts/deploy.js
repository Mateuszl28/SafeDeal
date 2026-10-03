const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const DAY = 24 * 60 * 60;
const MIN = 60;

// Lokalnie: realistyczne okna (demo przewija czas). Na testnecie: minuty, żeby demo na żywo się domknęło.
const CONFIGS = {
  local: { shipWindow: 5 * DAY, transitWindow: 14 * DAY, inspectionWindow: 2 * DAY, responseWindow: 3 * DAY, arbitrationWindow: 7 * DAY, revealWindow: 2 * DAY, adminDelay: 2 * DAY, arbiterStake: 50_000_000n, missPenaltyBps: 2000, bondBps: 500 },
  testnet: { shipWindow: 10 * MIN, transitWindow: 10 * MIN, inspectionWindow: 3 * MIN, responseWindow: 5 * MIN, arbitrationWindow: 10 * MIN, revealWindow: 5 * MIN, adminDelay: 10 * MIN, arbiterStake: 50_000_000n, missPenaltyBps: 2000, bondBps: 500 },
};

async function main() {
  const signers = await ethers.getSigners();
  const deployer = signers[0];
  const { chainId } = await ethers.provider.getNetwork();
  const isLocal = network.name === "localhost" || network.name === "hardhat";
  const cfg = isLocal ? CONFIGS.local : CONFIGS.testnet;

  let oracles, oracleQuorum, arbiters, quorum;
  if (isLocal) {
    // 3 niezależne źródła statusu przesyłki, potrzebne 2 zgodne potwierdzenia
    oracles = [signers[0], signers[7], signers[8]].map((s) => s.address);
    oracleQuorum = 2;
    arbiters = signers.slice(3, 6).map((s) => s.address);
    quorum = 2;
  } else {
    oracles = (process.env.ORACLES || deployer.address).split(",").map((a) => a.trim());
    oracleQuorum = Number(process.env.ORACLE_QUORUM || Math.floor(oracles.length / 2) + 1);
    arbiters = (process.env.ARBITERS || deployer.address).split(",").map((a) => a.trim());
    quorum = Number(process.env.QUORUM || Math.floor(arbiters.length / 2) + 1);
  }

  const token = process.env.TOKEN
    ? await ethers.getContractAt("MockUSDC", process.env.TOKEN)
    : await (await ethers.getContractFactory("MockUSDC")).deploy();
  await token.waitForDeployment();

  const safe = await (await ethers.getContractFactory("SafeDeal")).deploy(token, oracles, oracleQuorum, arbiters, quorum, cfg);
  await safe.waitForDeployment();
  const deployBlock = (await safe.deploymentTransaction().wait()).blockNumber;

  if (isLocal) {
    // Alicja (sprzedawca) i Bartek (kupujący) dostają po 1000 USDC na start
    for (const s of signers.slice(1, 3)) await (await token.mint(s.address, ethers.parseUnits("1000", 6))).wait();
  }

  const out = {
    chainId: Number(chainId),
    network: network.name,
    safeDeal: await safe.getAddress(),
    token: await token.getAddress(),
    oracles,
    oracleQuorum,
    arbiters,
    quorum,
    config: { ...cfg, arbiterStake: Number(cfg.arbiterStake) },
    deployBlock,
    deployedAt: new Date().toISOString(),
  };

  const file = path.join(__dirname, "..", "..", "web", "lib", "deployments.json");
  const all = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  all[out.chainId] = out;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(all, null, 2) + "\n");

  console.log(JSON.stringify(out, null, 2));
  console.log(`\nZapisano adresy do ${path.relative(process.cwd(), file)}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
