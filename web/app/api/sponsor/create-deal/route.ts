// Wystawienie oferty bez SOL: serwer składa transakcję create_deal, sponsor opłat płaci opłatę sieci
// i dokłada rent za konto oferty i sejfu (jeśli portfel sprzedawcy jest pusty), a sprzedawca tylko podpisuje.
// Sponsor nie ma żadnych uprawnień w programie — o ofercie i pieniądzach decyduje wyłącznie program.
import { LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { buildInstructions, fetchConfig, readProgram } from "@/lib/solana";
import { serverConnection, serverDeployment, sponsorKey, toppedUp } from "@/lib/sponsor";

/** Rent konta oferty (~0,0123 SOL) + sejfu (~0,002) + profilu (~0,0015) z zapasem. */
const RENT_TOPUP = 0.02 * LAMPORTS_PER_SOL;

type Body = {
  account?: string;
  args?: { amount: string; title: string; buyer?: string | null; description?: string; photoUri?: string; photoHash?: string; pickupAllowed?: boolean };
};

export async function POST(req: Request) {
  const d = serverDeployment();
  const sponsor = sponsorKey();
  if (!d || d.cluster !== "devnet" || !sponsor) return Response.json({ message: "Sponsor opłat niedostępny." }, { status: 503 });

  let seller: PublicKey;
  let args: NonNullable<Body["args"]>;
  try {
    const body = (await req.json()) as Body;
    seller = new PublicKey(String(body.account));
    if (!body.args || !/^\d{1,20}$/.test(body.args.amount) || !body.args.title) throw new Error();
    args = body.args;
  } catch {
    return Response.json({ message: "Nieprawidłowe dane oferty." }, { status: 400 });
  }

  try {
    const connection = serverConnection(d);
    const program = readProgram(connection, d);
    const ixs = [];
    const key = `create:${seller.toBase58()}`;
    if ((await connection.getBalance(seller)) < RENT_TOPUP && !toppedUp.has(key)) {
      ixs.push(SystemProgram.transfer({ fromPubkey: sponsor.publicKey, toPubkey: seller, lamports: RENT_TOPUP }));
      toppedUp.add(key);
    }
    const nextId = (await fetchConfig(program, d)).dealCount + 1n;
    ixs.push(...(await buildInstructions(program, d, seller, "createDeal", [{ ...args, amount: BigInt(args.amount) }, nextId])));

    const tx = new Transaction().add(...ixs);
    tx.feePayer = sponsor.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
    tx.partialSign(sponsor);
    return Response.json({
      transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
      id: String(nextId),
    });
  } catch (e) {
    return Response.json({ message: e instanceof Error ? e.message.slice(0, 300) : String(e) }, { status: 400 });
  }
}
