"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { Program } from "@coral-xyz/anchor";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SendTransactionError, Transaction } from "@solana/web3.js";
import { ConnectionProvider, WalletProvider as AdapterProvider, useWallet as useAdapter } from "@solana/wallet-adapter-react";
import { WalletModalProvider, useWalletModal } from "@solana/wallet-adapter-react-ui";
import "@solana/wallet-adapter-react-ui/styles.css";
import { getDeployment, type Address, type Deal, type Deployment } from "./contracts";
import { buildInstructions, readProgram, type WriteName } from "./solana";

// Klucze person demo — zapisuje je `solana/scripts/setup.mjs` do web/.env.local (poza repozytorium).
// TYLKO devnet/localnet, bez żadnej wartości. Bez nich aplikacja działa w trybie prawdziwego portfela.
type KeyFile = { personas?: { name: string; role: string; secret: number[] }[]; oracles?: { name: string; secret: number[] }[] };
function loadKeys(): KeyFile {
  try {
    return JSON.parse(process.env.NEXT_PUBLIC_DEMO_KEYS || "{}") as KeyFile;
  } catch {
    return {};
  }
}
const keys = loadKeys();

export type Persona = { name: string; role: string; keypair: Keypair; address: Address };

// Klucze w środowisku Vercela zapisano po polsku — nazwy ról i źródeł pokazujemy po angielsku.
const EN_NAMES: Record<string, string> = {
  sprzedawczyni: "seller",
  sprzedawca: "seller",
  kupujący: "buyer",
  "obca osoba": "stranger",
  "API InPost": "InPost API",
  "Skan w paczkomacie": "Parcel locker scan",
  "Niezależny węzeł": "Independent node",
};
const en = (s: string) => EN_NAMES[s] ?? s;

export const PERSONAS: Persona[] = (keys.personas ?? []).map((p) => {
  const keypair = Keypair.fromSecretKey(Uint8Array.from(p.secret));
  return { name: p.name, role: en(p.role), keypair, address: keypair.publicKey.toBase58() };
});

/** Niezależne źródła statusu przesyłki w demo (w produkcji: API przewoźnika, Chainlink/Switchboard). */
export const DEMO_ORACLES = (keys.oracles ?? []).map((o) => {
  const keypair = Keypair.fromSecretKey(Uint8Array.from(o.secret));
  return { name: en(o.name), keypair, address: keypair.publicKey.toBase58() };
});

type Mode = "demo" | "wallet";

export type LastTx = { signature: string; label: string };

type Ctx = {
  mode: Mode;
  setMode: (m: Mode) => void;
  deployment?: Deployment;
  connection: Connection;
  program?: Program;
  address?: Address;
  persona?: Persona;
  setPersona: (p: Persona) => void;
  connect: () => void;
  disconnect: () => void;
  /** Czas łańcucha (sekundy) — z ostatniego bloku, uzupełniany zegarem lokalnym między odczytami. */
  now: bigint;
  refreshKey: number;
  refresh: () => void;
  busy: string | null;
  error: string | null;
  clearError: () => void;
  /** Ostatnia potwierdzona transakcja — do pokazania w eksploratorze. */
  lastTx: LastTx | null;
  clearLastTx: () => void;
  /** Wysyła instrukcję programu; zwraca podpis transakcji albo null, gdy się nie udała. */
  write: (fn: WriteName, args: readonly unknown[], opts?: { asOracle?: number; label?: string; deal?: Deal }) => Promise<string | null>;
  faucet: () => Promise<void>;
  /** Testowy SOL na opłaty (devnet) — od sponsora opłat, awaryjnie z publicznego faucetu. */
  airdrop: () => Promise<boolean>;
  /** Nowy portfel: SOL na opłaty od sponsora + testowe USDC z kranu programu. */
  prepareWallet: () => Promise<void>;
  /** Zakup bez SOL: transakcję składa serwer (Solana Actions), opłatę płaci sponsor, kupujący tylko podpisuje. */
  buySponsored: (deal: Deal, label?: string) => Promise<string | null>;
  solBalance?: number;
  /** Podpis wiadomości kluczem bieżącego konta (bez transakcji i bez opłat), hex. */
  signMessage: (message: string) => Promise<string | null>;
};

const WalletContext = createContext<Ctx | null>(null);

export function useWallet() {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet poza WalletProvider");
  return ctx;
}

export const PROGRAM_ERRORS: Record<string, string> = {
  NotAllowed: "This person cannot perform this action.",
  DeadlinePassed: "The deadline for this action has passed.",
  DeadlineNotReached: "The deadline has not passed yet.",
  WrongState: "The deal is in a different state.",
  InvalidParams: "Invalid data.",
  RevealNotOpen: "Vote reveal has not started yet.",
  BadReveal: "The revealed vote does not match the earlier hash.",
  OfferMismatch: "The settlement offer just changed — check the new amount.",
  DrawNotReady: "The arbiter draw will be possible in a moment (waiting for a future slot).",
  PoolTooSmall: "Not enough arbiters in the pool to draw a panel.",
  PoolFull: "The arbiter pool is full.",
  ArbiterBusy: "The arbiter has unsettled cases.",
  ArbitersNotSettled: "The arbiters of this case must be settled first.",
};

/** Komunikat błędu programu (`#[msg]` z Anchora) zamiast surowego zrzutu logów. */
function readableError(e: unknown, logs?: string[] | null): string {
  const all = [...(logs ?? []), e instanceof Error ? e.message : String(e)].join("\n");
  const m = all.match(/Error Code: (\w+)\. Error Number: \d+\. Error Message: ([^\n]+?)\.?(?:\n|$)/);
  if (m) return `${PROGRAM_ERRORS[m[1]] ?? m[2]} (${m[1]})`;
  if (/insufficient lamports|insufficient funds for fee|Attempt to debit an account but found no record of a prior credit/i.test(all))
    return "No test SOL for fees — use the “+ SOL” button or faucet.solana.com.";
  if (/insufficient funds/i.test(all)) return "Not enough test USDC — use the faucet.";
  if (/User rejected/i.test(all)) return "Transaction rejected in the wallet.";
  return all.split("\n").slice(-1)[0].slice(0, 300);
}

const deployment = getDeployment(process.env.NEXT_PUBLIC_CLUSTER || "devnet");
// Prywatny endpoint z NEXT_PUBLIC_RPC dotyczy tylko devnetu — lokalny walidator ma własny adres.
const PRIVATE_RPC = deployment?.cluster === "devnet" ? process.env.NEXT_PUBLIC_RPC : undefined;
const RPC = PRIVATE_RPC || deployment?.rpc || "https://api.devnet.solana.com";
/** Część dostawców RPC (np. Alchemy) nie obsługuje subskrypcji — potwierdzenia idą wtedy przez publiczny WebSocket. */
const WS = process.env.NEXT_PUBLIC_WS || (PRIVATE_RPC ? "wss://api.devnet.solana.com" : undefined);

export function WalletProvider({ children }: { children: ReactNode }) {
  return (
    <ConnectionProvider endpoint={RPC} config={{ commitment: "confirmed", wsEndpoint: WS }}>
      <AdapterProvider wallets={[]} autoConnect>
        <WalletModalProvider>
          <Inner>{children}</Inner>
        </WalletModalProvider>
      </AdapterProvider>
    </ConnectionProvider>
  );
}

function Inner({ children }: { children: ReactNode }) {
  const adapter = useAdapter();
  const modal = useWalletModal();
  const [mode, setModeState] = useState<Mode>(PERSONAS.length ? "demo" : "wallet");
  const [persona, setPersonaState] = useState<Persona | undefined>(PERSONAS[0]);
  const [now, setNow] = useState<bigint>(BigInt(Math.floor(Date.now() / 1000)));
  const [refreshKey, setRefreshKey] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<LastTx | null>(null);
  const [solBalance, setSolBalance] = useState<number>();

  const connection = useMemo(() => new Connection(RPC, { commitment: "confirmed", wsEndpoint: WS }), []);
  const program = useMemo(() => (deployment ? readProgram(connection, deployment) : undefined), [connection]);

  const address = mode === "demo" ? persona?.address : adapter.publicKey?.toBase58();

  // Zapamiętujemy wybór trybu i persony między odświeżeniami strony.
  useEffect(() => {
    try {
      const m = localStorage.getItem("safedeal:mode") as Mode | null;
      if (m === "wallet" || (m === "demo" && PERSONAS.length)) setModeState(m);
      const p = PERSONAS.find((x) => x.name === localStorage.getItem("safedeal:persona"));
      if (p) setPersonaState(p);
    } catch {
      /* brak storage */
    }
  }, []);

  const setMode = (m: Mode) => {
    setModeState(m);
    setError(null);
    try {
      localStorage.setItem("safedeal:mode", m);
    } catch {}
  };
  const setPersona = (p: Persona) => {
    setPersonaState(p);
    try {
      localStorage.setItem("safedeal:persona", p.name);
    } catch {}
  };

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  // Zegar łańcucha + okresowe odświeżanie widoków.
  useEffect(() => {
    let alive = true;
    let offset = 0;
    const sync = async () => {
      try {
        const slot = await connection.getSlot("confirmed");
        const t = await connection.getBlockTime(slot);
        if (t) offset = t - Date.now() / 1000;
      } catch {
        /* RPC niedostępne — zostaje zegar lokalny */
      }
    };
    sync();
    const clock = setInterval(() => alive && setNow(BigInt(Math.floor(Date.now() / 1000 + offset))), 1000);
    const resync = setInterval(sync, 30_000);
    const views = setInterval(() => alive && setRefreshKey((k) => k + 1), 8000);
    return () => {
      alive = false;
      clearInterval(clock);
      clearInterval(resync);
      clearInterval(views);
    };
  }, [connection]);

  useEffect(() => {
    if (!address) return setSolBalance(undefined);
    connection
      .getBalance(new PublicKey(address))
      .then((l) => setSolBalance(l / LAMPORTS_PER_SOL))
      .catch(() => setSolBalance(undefined));
  }, [address, connection, refreshKey]);

  const send = useCallback(
    async (label: string, build: (signer: PublicKey) => Promise<Transaction>, signerKp?: Keypair): Promise<string | null> => {
      setBusy(label);
      setError(null);
      try {
        let signature: string;
        if (signerKp) {
          const tx = await build(signerKp.publicKey);
          const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
          tx.recentBlockhash = blockhash;
          tx.feePayer = signerKp.publicKey;
          tx.sign(signerKp);
          signature = await connection.sendRawTransaction(tx.serialize());
          const res = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
          if (res.value.err) throw new Error(`Transaction rejected: ${JSON.stringify(res.value.err)}`);
        } else {
          if (!adapter.publicKey) throw new Error("Connect your wallet first.");
          const tx = await build(adapter.publicKey);
          const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
          tx.recentBlockhash = blockhash;
          tx.feePayer = adapter.publicKey;
          signature = await adapter.sendTransaction(tx, connection);
          const res = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
          if (res.value.err) throw new Error(`Transaction rejected: ${JSON.stringify(res.value.err)}`);
        }
        setLastTx({ signature, label });
        refresh();
        return signature;
      } catch (e) {
        let logs: string[] | null = null;
        if (e instanceof SendTransactionError) {
          try {
            logs = await e.getLogs(connection);
          } catch {
            logs = e.logs ?? null;
          }
        }
        console.error("[SafeDeal]", label, e, logs);
        setError(readableError(e, logs));
        return null;
      } finally {
        setBusy(null);
      }
    },
    [connection, adapter, refresh],
  );

  const signerFor = useCallback(
    (asOracle?: number): Keypair | undefined => {
      if (asOracle !== undefined) return DEMO_ORACLES[asOracle]?.keypair;
      return mode === "demo" ? persona?.keypair : undefined;
    },
    [mode, persona],
  );

  /**
   * Transakcja złożona przez serwer i częściowo podpisana przez sponsora opłat (Solana Actions / zakup bez SOL).
   * Użytkownik tylko podpisuje — portfelem albo kluczem persony demo.
   */
  const sendServerTx = useCallback(
    async (url: string, body: object, label: string): Promise<string | null> => {
      setBusy(label);
      setError(null);
      try {
        const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        const j = (await r.json()) as { transaction?: string; message?: string };
        if (!r.ok || !j.transaction) throw new Error(j.message ?? "The server did not prepare the transaction.");
        const tx = Transaction.from(Buffer.from(j.transaction, "base64"));
        let signed: Transaction;
        if (mode === "demo") {
          if (!persona) throw new Error("No persona.");
          tx.partialSign(persona.keypair);
          signed = tx;
        } else {
          if (!adapter.signTransaction) throw new Error("This wallet does not support signing transactions.");
          signed = await adapter.signTransaction(tx);
        }
        const signature = await connection.sendRawTransaction(signed.serialize());
        const res = await connection.confirmTransaction(signature, "confirmed");
        if (res.value.err) throw new Error(`Transaction rejected: ${JSON.stringify(res.value.err)}`);
        setLastTx({ signature, label });
        refresh();
        return signature;
      } catch (e) {
        let logs: string[] | null = null;
        if (e instanceof SendTransactionError) {
          try {
            logs = await e.getLogs(connection);
          } catch {
            logs = e.logs ?? null;
          }
        }
        setError(readableError(e, logs));
        return null;
      } finally {
        setBusy(null);
      }
    },
    [mode, persona, adapter, connection, refresh],
  );

  const write: Ctx["write"] = useCallback(
    async (fn, args, opts) => {
      if (!deployment || !program) return null;
      const kp = signerFor(opts?.asOracle);
      if (!kp && mode === "demo") {
        setError("No demo personas — run the devnet setup script.");
        return null;
      }
      if (fn === "createDeal" && mode === "wallet" && deployment.cluster === "devnet" && adapter.publicKey) {
        // Sprzedawca bez SOL: rent za konto oferty i opłatę pokrywa sponsor, sprzedawca tylko podpisuje.
        const a = args[0] as { amount: bigint } & Record<string, unknown>;
        return sendServerTx(
          "/api/sponsor/create-deal",
          { account: adapter.publicKey.toBase58(), args: { ...a, amount: a.amount.toString() } },
          opts?.label ?? "Listing created",
        );
      }
      return send(
        opts?.label ?? fn,
        async (signer) => {
          let a = args;
          if (fn === "createDeal") {
            // Id nowej transakcji = licznik w konfiguracji + 1 (PDA zależy od id).
            const cfg = await (program.account as unknown as { config: { fetch: (k: PublicKey) => Promise<{ dealCount: { toString(): string } }> } }).config.fetch(
              new PublicKey(deployment.config),
            );
            a = [args[0], BigInt(cfg.dealCount.toString()) + 1n];
          }
          const ixs = await buildInstructions(program, deployment, signer, fn, a, opts?.deal);
          return new Transaction().add(...ixs);
        },
        kp,
      );
    },
    [program, signerFor, send, mode, adapter.publicKey, sendServerTx],
  );

  const faucet = useCallback(async () => {
    await write("faucet", [], { label: "Test USDC faucet" });
  }, [write]);

  const airdrop = useCallback(async (): Promise<boolean> => {
    if (!address) return false;
    setBusy("Getting test SOL for fees");
    setError(null);
    try {
      // 1) sponsor opłat (nasz portfel na devnecie) — publiczne faucety bywają puste
      const r = await fetch("/api/sponsor", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address }) });
      const j = (await r.json()) as { ok?: boolean; signature?: string; skipped?: boolean; error?: string };
      if (r.ok && j.ok) {
        if (j.signature) setLastTx({ signature: j.signature, label: "Sponsor: SOL for fees" });
        refresh();
        return true;
      }
      // 2) publiczny faucet devnetu
      const sig = await connection.requestAirdrop(new PublicKey(address), LAMPORTS_PER_SOL / 2);
      await connection.confirmTransaction(sig, "confirmed");
      setLastTx({ signature: sig, label: "Airdrop 0.5 SOL" });
      refresh();
      return true;
    } catch {
      setError("Could not get test SOL (both the sponsor and the public faucet refused). Try https://faucet.solana.com");
      return false;
    } finally {
      setBusy(null);
    }
  }, [address, connection, refresh]);

  const prepareWallet = useCallback(async () => {
    if (!(await airdrop())) return;
    await new Promise((r) => setTimeout(r, 1500));
    await write("faucet", [], { label: "Faucet: 1000 test USDC" });
  }, [airdrop, write]);

  const buySponsored = useCallback(
    async (deal: Deal, label = "Deposited into escrow"): Promise<string | null> => {
      if (!address) {
        setError("Connect your wallet first.");
        return null;
      }
      return sendServerTx(`/api/actions/deal/${deal.id}`, { account: address }, label);
    },
    [address, sendServerTx],
  );

  const signMessage = useCallback(
    async (message: string): Promise<string | null> => {
      const bytes = new TextEncoder().encode(message);
      try {
        if (mode === "demo") {
          if (!persona) return null;
          const nacl = await import("tweetnacl");
          return Buffer.from(nacl.sign.detached(bytes, persona.keypair.secretKey)).toString("hex");
        }
        if (!adapter.signMessage) throw new Error("This wallet does not support signing messages.");
        return Buffer.from(await adapter.signMessage(bytes)).toString("hex");
      } catch (e) {
        setError(readableError(e));
        return null;
      }
    },
    [mode, persona, adapter],
  );

  const value: Ctx = {
    mode,
    setMode,
    deployment,
    connection,
    program,
    address,
    persona: mode === "demo" ? persona : undefined,
    setPersona,
    connect: () => modal.setVisible(true),
    disconnect: () => adapter.disconnect(),
    now,
    refreshKey,
    refresh,
    busy,
    error,
    clearError: () => setError(null),
    lastTx,
    clearLastTx: () => setLastTx(null),
    write,
    faucet,
    airdrop,
    prepareWallet,
    buySponsored,
    solBalance,
    signMessage,
  };

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function nameOf(addr?: Address): string | undefined {
  if (!addr) return undefined;
  return PERSONAS.find((p) => p.address === addr)?.name ?? DEMO_ORACLES.find((o) => o.address === addr)?.name;
}
