import { ZERO, type Address } from "./contracts";

export const USDC_DECIMALS = 6;
const UNIT = 10n ** BigInt(USDC_DECIMALS);

/** bigint (najmniejsze jednostki) → liczba w USDC. */
export const toUsdc = (v: bigint) => Number(v) / Number(UNIT);

export const fmtUsdc = (v: bigint) =>
  `${toUsdc(v).toLocaleString("pl-PL", { maximumFractionDigits: 2 })} USDC`;

export function parseUsdc(s: string): bigint {
  const t = s.replace(",", ".").trim() || "0";
  if (!/^\d*(\.\d*)?$/.test(t)) throw new Error("Nieprawidłowa kwota");
  const [whole, frac = ""] = t.split(".");
  return BigInt(whole || "0") * UNIT + BigInt((frac + "000000").slice(0, USDC_DECIMALS) || "0");
}

export const short = (a?: Address) => (!a || a === ZERO ? "—" : `${a.slice(0, 4)}…${a.slice(-4)}`);

/** Adresy Solany (base58) są wrażliwe na wielkość liter — porównujemy dokładnie. */
export const sameAddr = (a?: string, b?: string) => !!a && !!b && a === b;

export function isAddress(s: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s.trim());
}

export function fmtDuration(seconds: bigint | number): string {
  let s = Math.max(0, Number(seconds));
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  if (d) return `${d} d ${h} h`;
  if (h) return `${h} h ${m} min`;
  if (m) return `${m} min ${s} s`;
  return `${s} s`;
}

/** Polska odmiana: plural(1, "udana transakcja", "udane transakcje", "udanych transakcji"). */
export function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  const form = n === 1 ? one : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? few : many;
  return `${n} ${form}`;
}

export const dealsDone = (n: number) => plural(n, "udana transakcja", "udane transakcje", "udanych transakcji");
