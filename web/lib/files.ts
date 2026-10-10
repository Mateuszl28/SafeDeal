"use client";

import { useEffect, useState } from "react";
type Hex = `0x${string}`;

export type Check = "checking" | "ok" | "mismatch" | "missing";

async function sha256Hex(buf: ArrayBuffer): Promise<Hex> {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return `0x${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Pobiera plik i porównuje jego SHA-256 z hashem zapisanym on-chain. */
export function useHashCheck(uri: string, hash: string) {
  const [check, setCheck] = useState<Check>("checking");
  const [isImage, setIsImage] = useState(false);

  useEffect(() => {
    if (!uri) return setCheck("missing");
    setCheck("checking");
    // no-store: weryfikujemy to, co serwer zwraca TERAZ, a nie kopię z cache przeglądarki
    fetch(uri, { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) return setCheck("missing");
        setIsImage((r.headers.get("content-type") ?? "").startsWith("image/"));
        setCheck((await sha256Hex(await r.arrayBuffer())) === hash.toLowerCase() ? "ok" : "mismatch");
      })
      .catch(() => setCheck("missing"));
  }, [uri, hash]);

  return { check, isImage };
}

export const CHECK_LABEL: Record<Check, string> = {
  checking: "Checking hash…",
  ok: "✓ File matches the hash stored on-chain",
  mismatch: "✗ File was changed afterwards — the hash does not match!",
  missing: "File unavailable",
};

/** Wysyła plik do magazynu (w demo: lokalny, docelowo IPFS) i zwraca adres oraz hash do zapisania on-chain. */
export async function uploadFile(file: File): Promise<{ uri: string; hash: Hex }> {
  const body = new FormData();
  body.append("file", file);
  const res = await fetch("/api/evidence", { method: "POST", body });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error);
  return json;
}
