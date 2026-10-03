// Tylko serwer. Sponsor opłat (devnet): płaci opłaty sieci i drobny rent za kupującego, żeby osoba bez SOL
// mogła kupić jednym podpisem. Sponsor NIE ma żadnych uprawnień w programie SafeDeal i nie ma dostępu
// do sejfów — transakcję buduje serwer, a pieniądze kupującego i tak trafiają wyłącznie do sejfu programu.
import fs from "node:fs";
import path from "node:path";
import { Connection, Keypair } from "@solana/web3.js";
import { getDeployment, type Deployment } from "./contracts";

export function serverDeployment(): Deployment | undefined {
  return getDeployment(process.env.NEXT_PUBLIC_CLUSTER || "devnet");
}

export function serverConnection(d: Deployment): Connection {
  const http = process.env.NEXT_PUBLIC_RPC || d.rpc;
  return new Connection(http, {
    commitment: "confirmed",
    // prywatne RPC (np. Alchemy) bywa bez subskrypcji — potwierdzenia przez publiczny WebSocket
    wsEndpoint: process.env.NEXT_PUBLIC_RPC && d.cluster === "devnet" ? "wss://api.devnet.solana.com" : undefined,
  });
}

let cached: Keypair | null | undefined;
export function sponsorKey(): Keypair | null {
  if (cached !== undefined) return cached;
  // Hosting (np. Vercel): klucz w zmiennej środowiskowej SPONSOR_SECRET jako tablica JSON z pliku keypair.
  if (process.env.SPONSOR_SECRET) {
    try {
      cached = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.SPONSOR_SECRET)));
      return cached;
    } catch {
      /* zły format — spróbuj pliku */
    }
  }
  const file = process.env.SPONSOR_KEYPAIR || path.join(process.cwd(), "..", "solana", "keys", "sponsor.json");
  try {
    cached = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8"))));
  } catch {
    cached = null;
  }
  return cached;
}

/** Każdy portfel dostaje dopłatę na rent tylko raz (w pamięci procesu — wystarczy na demo). */
export const toppedUp = new Set<string>();
