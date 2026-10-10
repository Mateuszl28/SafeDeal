// Solana Actions (Blinks): każda oferta jako „przycisk zakupu” do wklejenia w post na X, w czat albo w QR.
// GET  → karta oferty (tytuł, cena, opis, gwarancje); POST {account} → gotowa transakcja do podpisania.
// Transakcję częściowo podpisuje sponsor opłat (płaci opłatę sieci i rent), więc kupujący nie potrzebuje SOL.
// Zasady wypłaty egzekwuje wyłącznie program on-chain — serwer tylko składa instrukcje.
import { LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { State, isZero } from "@/lib/contracts";
import { fmtUsdc } from "@/lib/format";
import { buildInstructions, fetchDeal, readProgram, tokenBalance } from "@/lib/solana";
import { serverConnection, serverDeployment, sponsorKey, toppedUp } from "@/lib/sponsor";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Content-Encoding, Accept-Encoding, X-Accept-Action-Version, X-Accept-Blockchain-Ids",
  "Access-Control-Expose-Headers": "X-Action-Version, X-Blockchain-Ids",
  "X-Action-Version": "2.4",
  "X-Blockchain-Ids": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", // devnet
  "Content-Type": "application/json",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: CORS });

/** Rent konta profilu kupującego (~0,0015 SOL) + zapas — dopłaca sponsor, jeśli portfel jest pusty. */
const RENT_TOPUP = 0.003 * LAMPORTS_PER_SOL;

export async function OPTIONS() {
  return new Response(null, { headers: CORS });
}

async function load(idParam: string) {
  const d = serverDeployment();
  if (!d) throw new Error("Program is not deployed.");
  if (!/^\d{1,18}$/.test(idParam)) throw new Error("Invalid offer number.");
  const connection = serverConnection(d);
  const program = readProgram(connection, d);
  const deal = await fetchDeal(program, d, BigInt(idParam));
  if (!deal) throw new Error(`Offer #${idParam} doesn't exist.`);
  return { d, connection, program, deal };
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const origin = new URL(req.url).origin;
  try {
    const { d, deal } = await load(id);
    const open = deal.state === State.Created && !deal.pickupAllowed;
    const w = d.windows;
    const minutes = (s: number) => (s >= 3600 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 60)} min`);
    return json({
      type: "action",
      icon: deal.photoUri && /^https:\/\//.test(deal.photoUri) ? deal.photoUri : `${origin}/api/actions/icon?id=${id}`,
      title: `${deal.title} — ${fmtUsdc(deal.amount)}`,
      description: [
        deal.description,
        `The money goes to the SafeDeal program's vault on Solana, not to the seller. If the parcel isn't shipped within ${minutes(w.ship)}, it comes back to you automatically. Paid out only after delivery is confirmed (${d.oracleQuorum} of ${d.oracles.length} sources) and the claim window has passed.`,
        "Network fees are paid by a sponsor — you don't need SOL.",
      ]
        .filter(Boolean)
        .join("\n\n"),
      label: `Buy and lock ${fmtUsdc(deal.amount)}`,
      disabled: !open,
      ...(open
        ? {}
        : { error: { message: deal.pickupAllowed ? "This offer requires in-person pickup — buy it on the SafeDeal site." : "This offer is no longer waiting for a buyer." } }),
      links: {
        actions: [{ type: "transaction", label: `Buy and lock ${fmtUsdc(deal.amount)}`, href: `${origin}/api/actions/deal/${id}` }],
      },
    });
  } catch (e) {
    return json({ message: e instanceof Error ? e.message : String(e) }, 400);
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const { d, connection, program, deal } = await load(id);
    if (deal.state !== State.Created) return json({ message: "This offer is no longer waiting for a buyer." }, 400);
    if (deal.pickupAllowed) return json({ message: "Buy in-person pickup offers on the SafeDeal site (a secret code is needed)." }, 400);

    let buyer: PublicKey;
    try {
      buyer = new PublicKey(((await req.json()) as { account?: string }).account ?? "");
    } catch {
      return json({ message: "Invalid wallet address." }, 400);
    }
    const b58 = buyer.toBase58();
    if (b58 === deal.seller) return json({ message: "You can't buy your own offer." }, 400);
    if (!isZero(deal.buyer) && deal.buyer !== b58) return json({ message: "This offer is reserved for another buyer." }, 400);

    const sponsor = sponsorKey();
    const ixs = [];
    if (sponsor) {
      const lamports = await connection.getBalance(buyer);
      if (lamports < RENT_TOPUP && !toppedUp.has(b58)) {
        ixs.push(SystemProgram.transfer({ fromPubkey: sponsor.publicKey, toPubkey: buyer, lamports: RENT_TOPUP }));
        toppedUp.add(b58);
      }
    }
    // Konto testowego USDC kupującego (płaci sponsor albo kupujący) i brakujące testowe USDC z kranu programu (devnet/localnet).
    const payer = sponsor?.publicKey ?? buyer;
    const { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } = await import("@solana/spl-token");
    const mint = new PublicKey(d.mint);
    ixs.push(createAssociatedTokenAccountIdempotentInstruction(payer, getAssociatedTokenAddressSync(mint, buyer, true), buyer, mint));
    if ((await tokenBalance(connection, d, b58)) < deal.amount) {
      ixs.push(...(await buildInstructions(program, d, buyer, "faucet", [])));
    }
    ixs.push(...(await buildInstructions(program, d, buyer, "fund", [], deal)));

    const tx = new Transaction().add(...ixs);
    tx.feePayer = payer;
    tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
    if (sponsor) tx.partialSign(sponsor);

    return json({
      type: "transaction",
      transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
      message: `You're paying ${fmtUsdc(deal.amount)} into the program's vault. The seller gets it only after delivery or your confirmation.`,
    });
  } catch (e) {
    return json({ message: e instanceof Error ? e.message.slice(0, 300) : String(e) }, 400);
  }
}
