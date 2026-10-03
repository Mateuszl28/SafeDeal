// Osobny portfel sponsora opłat (tylko devnet): frontend wysyła z niego odrobinę testowego SOL na opłaty
// nowym portfelom (np. jury z Phantomem), bo publiczne faucety bywają puste. Sponsor płaci wyłącznie
// opłaty sieci — nie ma żadnych uprawnień w programie i nie ma dostępu do sejfów.
//   node scripts/sponsor-setup.mjs devnet 1.5
import fs from "node:fs";
import path from "node:path";
import { Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { KEYS, connection, deployer, transferSol } from "./common.mjs";

const file = path.join(KEYS, "sponsor.json");
if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(Array.from(Keypair.generate().secretKey)));
const sponsor = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8"))));
const amount = Number(process.argv[3] ?? 1.5);
await transferSol(deployer(), sponsor.publicKey, amount);
console.log(`Sponsor ${sponsor.publicKey.toBase58()}: ${(await connection.getBalance(sponsor.publicKey)) / LAMPORTS_PER_SOL} SOL`);
