import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import { NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import { CHAT_MAX_LEN, chatPayload, type ChatMessage } from "@/lib/chat";
import { getDeployment } from "@/lib/contracts";
import { DATA_DIR } from "@/lib/evidenceStore";
import { coder, pdas } from "@/lib/solana";

// Demo: rozmowy leżą w plikach na serwerze aplikacji. Autentyczność gwarantują podpisy,
// nie serwer — docelowo treść byłaby dodatkowo szyfrowana end-to-end między stronami.
const STORE = path.join(DATA_DIR, ".chat");

function context(req: Request, id: string) {
  const cluster = new URL(req.url).searchParams.get("cluster") || "devnet";
  const deployment = getDeployment(cluster);
  if (!deployment || !/^\d+$/.test(id)) return null;
  const file = path.join(STORE, `solana-${cluster}-${deployment.programId}-${id}.json`);
  return { cluster, deployment, file };
}

async function load(file: string): Promise<ChatMessage[]> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return [];
  }
}

function verify(payload: string, signatureHex: string, from: string): boolean {
  try {
    const sig = Buffer.from(signatureHex.replace(/^0x/, ""), "hex");
    if (sig.length !== 64) return false;
    return nacl.sign.detached.verify(new TextEncoder().encode(payload), new Uint8Array(sig), new PublicKey(from).toBytes());
  } catch {
    return false;
  }
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = context(req, id);
  if (!ctx) return NextResponse.json({ error: "Nieznana sieć lub transakcja" }, { status: 400 });
  return NextResponse.json(await load(ctx.file));
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = context(req, id);
  if (!ctx) return NextResponse.json({ error: "Nieznana sieć lub transakcja" }, { status: 400 });

  const msg = (await req.json()) as ChatMessage;
  const text = typeof msg.text === "string" ? msg.text.trim() : "";
  if (typeof msg.from !== "string" || typeof msg.signature !== "string" || !text || text.length > CHAT_MAX_LEN || typeof msg.ts !== "number") {
    return NextResponse.json({ error: "Nieprawidłowa wiadomość" }, { status: 400 });
  }
  if (Math.abs(Date.now() - msg.ts) > 5 * 60_000) {
    return NextResponse.json({ error: "Wiadomość jest przeterminowana" }, { status: 400 });
  }

  const payload = chatPayload(ctx.cluster, ctx.deployment.programId, id, msg.ts, text);
  if (!verify(payload, msg.signature, msg.from)) return NextResponse.json({ error: "Podpis nie pasuje do nadawcy" }, { status: 401 });

  // Pisać mogą tylko strony transakcji — sprawdzamy to w koncie transakcji w sieci, nie w bazie aplikacji.
  let parties: string[];
  try {
    const connection = new Connection(process.env.NEXT_PUBLIC_RPC || ctx.deployment.rpc, "confirmed");
    const info = await connection.getAccountInfo(pdas(ctx.deployment.programId).deal(BigInt(id)));
    if (!info) return NextResponse.json({ error: "Nie ma takiej transakcji" }, { status: 404 });
    const deal = coder.accounts.decode("Deal", info.data) as { seller: PublicKey; buyer: PublicKey };
    parties = [deal.seller.toBase58(), deal.buyer.toBase58()];
  } catch {
    return NextResponse.json({ error: "Nie udało się odczytać transakcji z sieci — spróbuj za chwilę" }, { status: 502 });
  }
  if (!parties.includes(msg.from)) {
    return NextResponse.json({ error: "Tylko strony transakcji mogą pisać w tej rozmowie" }, { status: 403 });
  }

  const messages = await load(ctx.file);
  messages.push({ from: msg.from, text, ts: msg.ts, signature: msg.signature });
  await mkdir(STORE, { recursive: true });
  await writeFile(ctx.file, JSON.stringify(messages, null, 2));
  return NextResponse.json(messages);
}
