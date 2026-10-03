import type { Address } from "./contracts";

/** `signature` = podpis ed25519 treści z `chatPayload` kluczem nadawcy (hex). */
export type ChatMessage = { from: Address; text: string; ts: number; signature: string };

export const CHAT_MAX_LEN = 1000;

/**
 * Dokładnie to podpisuje nadawca. Sieć, program i numer transakcji w treści sprawiają,
 * że podpisanej wiadomości nie da się „przenieść” do innej rozmowy.
 */
export function chatPayload(cluster: string, programId: string, id: string, ts: number, text: string): string {
  return `SafeDeal — wiadomość w rozmowie\nsieć: solana-${cluster}\nprogram: ${programId}\ntransakcja: #${id}\nczas: ${ts}\n\n${text}`;
}
