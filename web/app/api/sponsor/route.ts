import { LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { serverConnection, serverDeployment, sponsorKey } from "@/lib/sponsor";

// Sponsor opłat (tylko devnet): wysyła odrobinę testowego SOL nowemu portfelowi, żeby mógł zapłacić
// opłaty sieci (ułamek grosza za transakcję). Publiczne faucety devnetu bywają puste — bez tego juror
// z Phantomem nie wykonałby żadnej transakcji. Sponsor NIE ma żadnych uprawnień w programie SafeDeal
// i nie ma dostępu do sejfów — reguły transakcji egzekwuje wyłącznie program on-chain.

const GRANT = 0.05 * LAMPORTS_PER_SOL; // ~10 000 transakcji albo kilka ofert (rent)
const ENOUGH = 0.02 * LAMPORTS_PER_SOL;
const granted = new Set<string>();

export async function POST(req: Request) {
  const d = serverDeployment();
  if (!d || d.cluster !== "devnet") return Response.json({ error: "Sponsor działa tylko na devnecie." }, { status: 400 });
  const sponsor = sponsorKey();
  if (!sponsor) return Response.json({ error: "Brak portfela sponsora (solana/scripts/sponsor-setup.mjs)." }, { status: 503 });

  let to: PublicKey;
  try {
    const body = (await req.json()) as { address?: string };
    to = new PublicKey(String(body.address));
  } catch {
    return Response.json({ error: "Nieprawidłowy adres." }, { status: 400 });
  }

  const connection = serverConnection(d);
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
