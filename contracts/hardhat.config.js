require("@nomicfoundation/hardhat-toolbox");

const { PRIVATE_KEY, BASE_SEPOLIA_RPC } = process.env;

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true },
  },
  networks: {
    baseSepolia: {
      url: BASE_SEPOLIA_RPC || "https://sepolia.base.org",
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
    },
  },
};
