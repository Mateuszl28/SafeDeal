import fs from "node:fs";
import path from "node:path";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { getDeployment } from "@/lib/contracts";

// Sponsor opłat (tylko devnet): wysyła odrobinę testowego SOL nowemu portfelowi, żeby mógł zapłacić
// opłaty sieci (ułamek grosza za transakcję). Publiczne faucety devnetu bywają puste — bez tego juror
// z Phantomem nie wykonałby żadnej transakcji. Sponsor NIE ma żadnych uprawnień w programie SafeDeal
// i nie ma dostępu do sejfów — reguły transakcji egzekwuje wyłącznie program on-chain.

const GRANT = 0.05 * LAMPORTS_PER_SOL; // ~10 000 transakcji albo kilka ofert (rent)
const ENOUGH = 0.02 * LAMPORTS_PER_SOL;
const granted = new Set<string>();

function sponsorKey(): Keypair | null {
  const file = process.env.SPONSOR_KEYPAIR || path.join(process.cwd(), "..", "solana", "keys", "sponsor.json");
  try {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8"))));
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  const cluster = process.env.NEXT_PUBLIC_CLUSTER || "devnet";
  const d = getDeployment(cluster);
  if (!d || cluster !== "devnet") return Response.json({ error: "Sponsor działa tylko na devnecie." }, { status: 400 });
  const sponsor = sponsorKey();
  if (!sponsor) return Response.json({ error: "Brak portfela sponsora (solana/scripts/sponsor-setup.mjs)." }, { status: 503 });

  let to: PublicKey;
  try {
    const body = (await req.json()) as { address?: string };
    to = new PublicKey(String(body.address));
  } catch {
    return Response.json({ error: "Nieprawidłowy adres." }, { status: 400 });
  }

  const connection = new Connection(process.env.NEXT_PUBLIC_RPC || d.rpc, {
    commitment: "confirmed",
    wsEndpoint: process.env.NEXT_PUBLIC_RPC ? "wss://api.devnet.solana.com" : undefined,
  });
  const balance = await connection.getBalance(to);
  if (balance >= ENOUGH) return Response.json({ ok: true, skipped: true, balance: balance / LAMPORTS_PER_SOL });
  if (granted.has(to.toBase58())) return Response.json({ error: "Ten portfel już dostał SOL od sponsora." }, { status: 429 });

  try {
    const signature = await sendAndConfirmTransaction(
      connection,
      new Transaction().add(SystemProgram.transfer({ fromPubkey: sponsor.publicKey, toPubkey: to, lamports: GRANT })),
      [sponsor],
      { commitment: "confirmed" },
    );
    granted.add(to.toBase58());
    return Response.json({ ok: true, signature, amount: GRANT / LAMPORTS_PER_SOL });
  } catch (e) {
    return Response.json({ error: `Sponsor nie mógł wysłać SOL: ${e instanceof Error ? e.message.slice(0, 200) : e}` }, { status: 502 });
  }
}
