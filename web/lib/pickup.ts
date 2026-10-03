// Bez znaków łatwych do pomylenia (0/O, 1/I/L) — kod czyta się na głos albo przepisuje z ekranu.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const LENGTH = 16; // ~79 bitów — hasha zapisanego on-chain nie da się „zgadnąć” bez wydania przedmiotu

export function generateCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(LENGTH));
  const chars = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
  return chars.match(/.{4}/g)!.join("-");
}

/** Ujednolica wpisany kod: wielkie litery, bez spacji, myślniki co 4 znaki. */
export function normalizeCode(input: string): string {
  const raw = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return (raw.match(/.{1,4}/g) ?? []).join("-");
}

// Hashe liczy lib/solana.ts (codeBytes, pickupHash) — tak samo jak program on-chain (sha256).

export const pickupStorageKey = (programId: string, id: bigint) => `safedeal:pickup:${programId}:${id}`;
