import { PublicKey } from "@solana/web3.js";
import deploymentsJson from "./deployments.json";

/** Adres w base58 (klucz publiczny Solany). */
export type Address = string;

/** Pubkey::default() — w programie oznacza „brak” (np. oferta otwarta dla każdego). */
export const ZERO = PublicKey.default.toBase58();
export const isZero = (a?: string) => !a || a === ZERO;

export type Deployment = {
  cluster: "devnet" | "localnet";
  rpc: string;
  programId: Address;
  mint: Address;
  config: Address;
  oracles: Address[];
  oracleQuorum: number;
  /** Zgodnych głosów potrzebnych do werdyktu (z `panelSize`). */
  arbiterQuorum: number;
  /** Ilu arbitrów program losuje z otwartej puli do jednego sporu. */
  panelSize: number;
  /** Minimalna kaucja arbitra w puli i kara za nieoddany głos (najmniejsze jednostki, jako tekst). */
  arbiterStake: string;
  missSlash: string;
  windows: {
    ship: number;
    transit: number;
    inspection: number;
    response: number;
    arbitration: number;
    reveal: number;
    archive: number;
  };
  bondBps: number;
  deployedAt?: string;
};

const deployments = deploymentsJson as unknown as Partial<Record<string, Deployment>>;

export function getDeployment(cluster = "devnet"): Deployment | undefined {
  return deployments[cluster];
}

export enum State {
  None,
  Created,
  Funded,
  Shipped,
  Delivered,
  Disputed,
  InArbitration,
  Released,
  Refunded,
  Split,
  Cancelled,
  Settled,
}

export const STATE_LABEL: Record<State, string> = {
  [State.None]: "—",
  [State.Created]: "Czeka na kupującego",
  [State.Funded]: "Opłacona — czeka na nadanie",
  [State.Shipped]: "W drodze",
  [State.Delivered]: "Doręczona — okno reklamacji",
  [State.Disputed]: "Reklamacja — czeka na sprzedawcę",
  [State.InArbitration]: "Arbitraż",
  [State.Released]: "Zakończona — wypłacono sprzedawcy",
  [State.Refunded]: "Zakończona — zwrot dla kupującego",
  [State.Split]: "Zakończona — podział 50/50",
  [State.Cancelled]: "Anulowana",
  [State.Settled]: "Zakończona — ugoda stron",
};

/** Co się stanie, jeśli nikt nic nie zrobi do deadline'u. */
export const TIMEOUT_OUTCOME: Partial<Record<State, string>> = {
  [State.Funded]: "pieniądze wrócą do kupującego",
  [State.Shipped]: "pieniądze trafią do sprzedawcy",
  [State.Delivered]: "pieniądze trafią do sprzedawcy",
  [State.Disputed]: "kupujący wygra spór",
  [State.InArbitration]: "kwota zostanie podzielona 50/50",
};

export const isFinal = (s: State) => s >= State.Released;

/** Konto transakcji odczytane z łańcucha (pola jak w `Deal` programu, liczby jako bigint). */
export type Deal = {
  id: bigint;
  /** Adres konta PDA transakcji — po nim szukamy historii w eksploratorze. */
  pda: Address;
  seller: Address;
  buyer: Address;
  amount: bigint;
  bond: bigint;
  state: State;
  deadline: bigint;
  createdAt: bigint;
  title: string;
  description: string;
  photoUri: string;
  photoHash: string; // hex 0x…
  tracking: string;
  disputeReason: string;
  attestations: number;
  attestedMask: number;
  pickupAllowed: boolean;
  pickupHash: string; // hex 0x…
  settlementProposer: Address;
  settlementBuyerAmount: bigint;
  closedAt: bigint;
  /** Slot, którego hash wylosuje skład arbitrów. */
  drawSlot: bigint;
  panelDrawn: boolean;
  /** Wylosowany skład arbitrów (puste adresy, dopóki nie wylosowano). */
  panel: Address[];
  /** Bity: którzy arbitrzy ze składu zostali rozliczeni. */
  panelSettled: number;
  /** 0 brak (ugoda), 1 kupujący, 2 sprzedawca, 3 podział po terminie. */
  verdict: number;
  rewardShare: bigint;
  commits: string[]; // hex 0x… per arbiter (indeksy jak w `panel`)
  votes: number[]; // 0 brak, 1 za kupującym, 2 za sprzedawcą
  commitCount: number;
  votesBuyer: number;
  votesSeller: number;
  reviewedByBuyer: boolean;
  reviewedBySeller: boolean;
  /** Konta transakcji są zamknięte (rent wrócił) — dane odtworzone ze zdarzenia DealArchived w historii. */
  archived?: boolean;
};

/** Konto arbitra w otwartej puli. */
export type ArbiterAccount = {
  owner: Address;
  stake: bigint;
  inPool: boolean;
  activeCases: number;
  cases: number;
  withMajority: number;
  againstMajority: number;
  missed: number;
};

export type Profile = {
  owner: Address;
  soldOk: number;
  boughtOk: number;
  disputesWon: number;
  disputesLost: number;
  ratingCount: number;
  starsSum: number;
  volume: bigint;
};

export const EMPTY_PROFILE = (owner: Address): Profile => ({
  owner,
  soldOk: 0,
  boughtOk: 0,
  disputesWon: 0,
  disputesLost: 0,
  ratingCount: 0,
  starsSum: 0,
  volume: 0n,
});

export type ConfigAccount = {
  mint: Address;
  oracles: Address[];
  oracleQuorum: number;
  arbiterQuorum: number;
  arbiterStake: bigint;
  missSlash: bigint;
  revealWindow: bigint;
  archiveWindow: bigint;
  bondBps: number;
  dealCount: bigint;
};

export const ZERO_HASH = "0x" + "00".repeat(32);
export const isZeroHash = (h?: string) => !h || /^0x0*$/.test(h);
