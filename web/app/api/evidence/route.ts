import { createHash } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { NextResponse } from "next/server";
import { EXT_BY_TYPE, STORE } from "@/lib/evidenceStore";

const MAX_BYTES = 5 * 1024 * 1024;

export async function POST(req: Request) {
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "Brak pliku" }, { status: 400 });
  const ext = EXT_BY_TYPE[file.type];
  if (!ext) return NextResponse.json({ error: "Dozwolone: JPG, PNG, WEBP, PDF" }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "Maks. 5 MB" }, { status: 400 });

  const bytes = Buffer.from(await file.arrayBuffer());
  const sha = createHash("sha256").update(bytes).digest("hex");
  await mkdir(STORE, { recursive: true });
  await writeFile(path.join(STORE, `${sha}.${ext}`), bytes);

  return NextResponse.json({ uri: `/api/evidence/${sha}`, hash: `0x${sha}` });
}
