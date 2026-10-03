// Zlecenia w etapach to zwykłe transakcje SafeDeal (jedna na etap) — kontrakt nic o nich nie wie.
// Etapy łączy znacznik na początku opisu oferty: [etap:<id projektu>:<numer>/<liczba>]. Opis jest
// zapisany on-chain i zamraża się przy wpłacie, więc przypisania etapu do projektu nie da się później zmienić.

const MARKER = /^\[etap:([a-z0-9]{6,16}):(\d+)\/(\d+)\]\s*/;

export type Stage = { project: string; index: number; total: number; text: string };

export function newProjectId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((b) => (b % 36).toString(36)).join("") + Date.now().toString(36).slice(-4);
}

export const stageDescription = (project: string, index: number, total: number, text: string) =>
  `[etap:${project}:${index}/${total}] ${text}`.trim();

export function parseStage(description?: string): Stage | null {
  const m = description?.match(MARKER);
  if (!m) return null;
  return { project: m[1], index: Number(m[2]), total: Number(m[3]), text: description!.slice(m[0].length) };
}

/** Opis bez technicznego znacznika — do wyświetlania. */
export const visibleDescription = (description?: string) => (description ?? "").replace(MARKER, "");
