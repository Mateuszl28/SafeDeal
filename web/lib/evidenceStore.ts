import path from "path";

// Magazyn dowodów na potrzeby demo — content-addressed (nazwa pliku = SHA-256 treści).
// W produkcji ten sam kontrakt przyjmie URI z IPFS; on-chain i tak ląduje tylko hash.
// SAFEDEAL_DATA_DIR pozwala trzymać pliki poza katalogiem aplikacji (np. na hostingu, gdzie jest on tylko do odczytu).
// Na Vercelu zapisywać można tylko w /tmp (pliki są tam tymczasowe — wystarczy na demo).
export const DATA_DIR = process.env.SAFEDEAL_DATA_DIR || (process.env.VERCEL ? "/tmp" : process.cwd());
export const STORE = path.join(DATA_DIR, ".evidence");

export const EXT_BY_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

export const TYPE_BY_EXT = Object.fromEntries(Object.entries(EXT_BY_TYPE).map(([t, e]) => [e, t]));
