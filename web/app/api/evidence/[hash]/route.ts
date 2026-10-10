import { readdir, readFile } from "fs/promises";
import path from "path";
import { STORE, TYPE_BY_EXT } from "@/lib/evidenceStore";

export async function GET(_req: Request, { params }: { params: Promise<{ hash: string }> }) {
  const { hash } = await params;
  if (!/^[0-9a-f]{64}$/.test(hash)) return new Response("Bad hash", { status: 400 });

  const files = await readdir(STORE).catch(() => [] as string[]);
  const name = files.find((f) => f.startsWith(`${hash}.`));
  if (!name) return new Response("Not found", { status: 404 });

  const ext = name.split(".").pop()!;
  const body = await readFile(path.join(STORE, name));
  return new Response(body, {
    headers: { "Content-Type": TYPE_BY_EXT[ext] ?? "application/octet-stream", "Cache-Control": "no-cache" },
  });
}
