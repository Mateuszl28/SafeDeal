"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { PublicKey, SYSVAR_SLOT_HASHES_PUBKEY, TransactionMessage, VersionedTransaction, type TransactionInstruction } from "@solana/web3.js";
import { createTransferInstruction, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { State, STATE_LABEL, isFinal, type Deal } from "@/lib/contracts";
import { fmtUsdc, short } from "@/lib/format";
import { ata, explorerAddr, fetchAllDeals, pdas } from "@/lib/solana";
import { PERSONAS, PROGRAM_ERRORS, nameOf, useWallet } from "@/lib/wallet";
import { ProgramRules } from "@/components/Governance";

const BPF_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

type Upgrade = { authority: string | null } | null;
type Attempt = {
  id: string;
  title: string;
  who: string;
  on: Deal;
  /** Dlaczego program to odrzuca — pokazywane pod komunikatem błędu. */
  why?: string;
  build: () => Promise<TransactionInstruction[]>;
};
type Result = { ok: boolean; text: string; logs: string[] };
/** Próby, które mogą przejść bez szkody (rozliczenie po terminie, przesunięcie losowania) — nie oznaczamy ich ostrzeżeniem. */
const SAFE_OK = ["early", "panel"];

/** Program aktualizowalny? Czytamy konto ProgramData: [u32 typ][u64 slot][u8 opcja][32 B autorytet]. */
async function upgradeAuthority(connection: ReturnType<typeof useWallet>["connection"], programId: string): Promise<Upgrade> {
  const [programData] = PublicKey.findProgramAddressSync([new PublicKey(programId).toBuffer()], BPF_UPGRADEABLE);
  const info = await connection.getAccountInfo(programData);
  if (!info) return null;
  const has = info.data[12] === 1;
  return { authority: has ? new PublicKey(info.data.subarray(13, 45)).toBase58() : null };
}

function explain(logs: string[], err: unknown): string {
  const all = logs.join("\n");
  const m = all.match(/Error Code: (\w+)\. Error Number: \d+\. Error Message: ([^\n]+?)\.?(?:\n|$)/);
  if (m?.[1] === "ConstraintHasOne")
    return "rent can only go to the seller recorded in the deal (has_one = seller) — swapping the recipient fails (ConstraintHasOne)";
  if (m) return `${PROGRAM_ERRORS[m[1]] ?? m[2]} (${m[1]})`;
  if (/owner does not match/i.test(all)) return "Token program: the signer is not the vault owner — nobody holds a key to the vault, only the program (PDA) does.";
  if (/custom program error: 0x4\b/.test(all)) return "Token program: the signer is not the vault owner.";
  if (/insufficient/i.test(all)) return "Insufficient funds in the attacker's account.";
  return typeof err === "string" ? err : JSON.stringify(err);
}

export default function JuryPage() {
  const w = useWallet();
  const [deals, setDeals] = useState<Deal[]>([]);
  const [upgrade, setUpgrade] = useState<Upgrade | undefined>();
  const [results, setResults] = useState<Record<string, Result | "running">>({});

  useEffect(() => {
    if (!w.program || !w.deployment) return;
    fetchAllDeals(w.program).then(setDeals).catch(() => {});
    upgradeAuthority(w.connection, w.deployment.programId).then(setUpgrade).catch(() => setUpgrade(null));
  }, [w.program, w.deployment, w.connection, w.refreshKey]);

  // Cel: transakcja z pieniędzmi w sejfie. Atakujący: Celina (obca osoba) albo podłączony portfel.
  const withMoney = deals.filter((d) => [State.Funded, State.Shipped, State.Delivered].includes(d.state));
  // najlepiej transakcja, której termin jeszcze trwa — wtedy widać też blokadę „przed terminem”
  const target = withMoney.find((d) => d.deadline > w.now) ?? withMoney[0];
  const expired = !!target && target.deadline <= w.now;
  // Spór w arbitrażu i zakończona (jeszcze niezamknięta) transakcja — cele prób dla puli arbitrów i zamykania kont.
  const arbTarget = deals.find((d) => d.state === State.InArbitration);
  const closedTarget =
    deals.find((d) => isFinal(d.state) && !d.archived && d.panelDrawn && d.panelSettled !== 0b111) ??
    deals.find((d) => isFinal(d.state) && !d.archived && d.state !== State.Cancelled);
  const celina = PERSONAS.find((p) => p.name === "Celina");
  const attacker = celina?.address ?? w.address;

  const attempts: Attempt[] = useMemo(() => {
    if (!attacker || !w.deployment || !w.program) return [];
    const d = w.deployment;
    const p = pdas(d.programId);
    const me = new PublicKey(attacker);
    const myAta = ata(d.mint, me);
    const m = w.program.methods as unknown as Record<
      string,
      (...a: unknown[]) => {
        accountsPartial: (x: object) => {
          remainingAccounts: (r: object[]) => { instruction: () => Promise<TransactionInstruction> };
          instruction: () => Promise<TransactionInstruction>;
        };
      }
    >;
    const who = nameOf(attacker) ?? short(attacker);
    const out: Attempt[] = [];

    if (arbTarget) {
      const dealPda = new PublicKey(arbTarget.pda);
      out.push(
        {
          id: "panel",
          title: arbTarget.panelDrawn ? "Redraw the arbiter panel — this time with me on it" : "Put myself on the arbiter panel instead of drawing",
          who,
          on: arbTarget,
          why: "The program computes the panel from the slot hash itself and compares it with the given accounts — the caller has no influence on the draw.",
          // Podajemy „swoje” konto arbitra trzy razy — program sam liczy skład z hasha slotu i porównuje adresy.
          build: async () => [
            await m
              .drawPanel()
              .accountsPartial({ actor: me, config: p.config(), pool: p.pool(), deal: dealPda, slotHashes: SYSVAR_SLOT_HASHES_PUBKEY })
              .remainingAccounts([0, 1, 2].map(() => ({ pubkey: p.arbiter(me), isSigner: false, isWritable: true })))
              .instruction(),
          ],
        },
        {
          id: "vote",
          title: "Vote in a dispute even though I wasn't drawn for the panel",
          who,
          on: arbTarget,
          why: "Only the 3 people drawn for this case can vote (deal.panel).",
          build: async () => [
            await m
              .commitVote(Array.from(crypto.getRandomValues(new Uint8Array(32))))
              .accountsPartial({ arbiter: me, config: p.config(), deal: dealPda })
              .instruction(),
          ],
        },
      );
    }

    if (closedTarget) {
      const dealPda = new PublicKey(closedTarget.pda);
      const vault = p.vault(dealPda);
      out.push({
        id: "rent",
        title: "Close the deal accounts, but send the rent to me",
        who,
        on: closedTarget,
        build: async () => [
          await m
            .closeDeal()
            .accountsPartial({ actor: me, config: p.config(), deal: dealPda, vault, seller: me, sellerAta: myAta, tokenProgram: TOKEN_PROGRAM_ID })
            .instruction(),
        ],
      });
      const i = closedTarget.panelDrawn ? closedTarget.panel.findIndex((_, k) => !((closedTarget.panelSettled >> k) & 1)) : -1;
      if (i >= 0) {
        out.push({
          id: "reward",
          title: "Settle an arbiter, but send their reward to my account",
          who,
          on: closedTarget,
          why: "The reward account must belong to an arbiter on the panel (arbiter_ata.owner == deal.panel[i]).",
          build: async () => [
            await m
              .settleArbiter(i)
              .accountsPartial({
                actor: me,
                config: p.config(),
                pool: p.pool(),
                poolVault: p.poolVault(),
                mint: new PublicKey(d.mint),
                deal: dealPda,
                vault,
                arbiter: p.arbiter(closedTarget.panel[i]),
                arbiterAta: myAta,
                tokenProgram: TOKEN_PROGRAM_ID,
              })
              .instruction(),
          ],
        });
      }
    }

    if (!target) return out;
    const dealPda = new PublicKey(target.pda);
    const vault = p.vault(dealPda);
    const payout = (buyerAta: PublicKey, sellerAta: PublicKey) => ({
      actor: me,
      config: p.config(),
      deal: dealPda,
      vault,
      buyerAta,
      sellerAta,
      buyerProfile: p.profile(target.buyer),
      sellerProfile: p.profile(target.seller),
      tokenProgram: TOKEN_PROGRAM_ID,
    });
    return [
      {
        id: "vault",
        on: target,
        title: "Withdraw money straight from the vault, bypassing the program",
        who,
        build: async () => [createTransferInstruction(vault, myAta, me, target.amount)],
      },
      {
        id: "redirect",
        on: target,
        title: "Refund the “buyer”, but to my account",
        who,
        build: async () => [await m.refundBuyer().accountsPartial(payout(myAta, ata(d.mint, target.seller))).instruction()],
      },
      {
        id: "receipt",
        on: target,
        title: "Confirm receipt on behalf of the buyer",
        who,
        build: async () => [await m.confirmReceipt().accountsPartial(payout(ata(d.mint, target.buyer), ata(d.mint, target.seller))).instruction()],
      },
      {
        id: "early",
        on: target,
        title: expired ? "Settle after the deadline (anyone is allowed to do this)" : "Settle the deal before the deadline",
        who,
        build: async () => [await m.settleExpired().accountsPartial(payout(ata(d.mint, target.buyer), ata(d.mint, target.seller))).instruction()],
      },
      ...out,
    ];
  }, [target, arbTarget, closedTarget, attacker, expired, w.deployment, w.program]);

  async function run(a: Attempt) {
    if (!attacker) return;
    setResults((r) => ({ ...r, [a.id]: "running" }));
    try {
      const ixs = await a.build();
      const { blockhash } = await w.connection.getLatestBlockhash("confirmed");
      const msg = new TransactionMessage({ payerKey: new PublicKey(attacker), recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
      // Symulacja w sieci: ta sama walidacja co prawdziwa transakcja, ale bez opłat i bez zmiany stanu.
      const sim = await w.connection.simulateTransaction(new VersionedTransaction(msg), { sigVerify: false, replaceRecentBlockhash: true });
      const logs = sim.value.logs ?? [];
      setResults((r) => ({
        ...r,
        [a.id]: sim.value.err
          ? { ok: false, text: explain(logs, sim.value.err), logs }
          : {
              ok: true,
              text:
                a.id === "early"
                  ? `Allowed: the deadline has passed, so anyone can settle — but the money only goes where the rule says (${target?.state === State.Funded ? "refund to the buyer" : "payout to the seller"}), not to the caller.`
                  : a.id === "panel"
                    ? // Jedyna gałąź draw_panel, która kończy się bez sprawdzania kont: slot losowania wypadł z historii.
                      "Nobody was added: the draw slot has already dropped out of the chain history, so the program just moved the draw to a new, future slot (DrawRescheduled). The given accounts weren't used at all."
                    : "The program would allow this transaction — the condition is met.",
              logs,
            },
      }));
    } catch (e) {
      setResults((r) => ({ ...r, [a.id]: { ok: false, text: e instanceof Error ? e.message : String(e), logs: [] } }));
    }
  }

  const d = w.deployment;
  return (
    <div className="grid">
      <section className="hero wide">
        <h1>For the jury: check it yourself</h1>
        <p>
          Everything on this page comes straight from Solana (devnet) — not from our database. Anything we claim here, you can
          verify in Solana Explorer or in the program code.
        </p>
      </section>

      <section className="card">
        <h2>Program</h2>
        {d ? (
          <>
            <p>
              <span className="muted">Address: </span>
              <a className="plink mono" href={explorerAddr(d.programId, d.cluster)} target="_blank" rel="noreferrer">
                {d.programId} ↗
              </a>
            </p>
            <p>
              <span className="muted">Can the author change the code? </span>
              {upgrade === undefined ? (
                "checking…"
              ) : upgrade === null ? (
                <b>Couldn't read the program account on this network — check in the Explorer.</b>
              ) : upgrade.authority === null ? (
                <b>No — the program is immutable (no upgrade authority).</b>
              ) : (
                <>
                  <b>Yes, for now</b> — upgrade authority:{" "}
                  <a className="plink mono" href={explorerAddr(upgrade.authority, d.cluster)} target="_blank" rel="noreferrer">
                    {short(upgrade.authority)} ↗
                  </a>
                  . We say it plainly: after the final fixes we'll revoke it permanently (<code>set-upgrade-authority --final</code>).
                  Nobody can change the configured rules even now — the program has no admin instruction.
                </>
              )}
            </p>
          </>
        ) : (
          <p className="muted">No deployment.</p>
        )}
      </section>

      <section className="card">
        <h2>Where the middleman disappears in the code</h2>
        <ul className="code-refs">
          <li>
            <code>CreateDeal</code> — the vault is a token account with <code>token::authority = deal</code>: its owner is a program address (PDA), not a person.
          </li>
          <li>
            <code>pay_raw</code> — the only way out of the vault; the transfer is signed by the deal PDA (<code>new_with_signer</code>).
          </li>
          <li>
            <code>Payout</code> — recipient accounts are pinned to the parties' addresses: <code>buyer_ata.owner == deal.buyer</code>.
          </li>
          <li>
            <code>settle_expired</code> — after the deadline the outcome depends only on the state; anyone can call it.
          </li>
          <li>
            <code>draw_panel</code> — the program computes the arbiter panel from a slot hash created after the dispute was accepted; the caller only
            passes the accounts, and the program checks every address.
          </li>
          <li>
            <code>CloseDeal</code> — rent goes back to the seller address recorded in the deal (<code>has_one = seller</code>), no matter who closes it.
          </li>
        </ul>
        <p className="muted small">
          File: <code>solana/programs/safedeal/src/lib.rs</code> (Anchor). Scenario tests: <code>solana/scripts/e2e.mjs</code>.
        </p>
      </section>

      <section className="card wide">
        <h2>Try to cheat the program</h2>
        {attempts.length === 0 && attacker ? (
          <p className="muted">No deals with money in the vault — buy any offer first.</p>
        ) : !attacker ? (
          <p className="muted">Connect a wallet or switch to demo mode.</p>
        ) : (
          <>
            {!target && (
              <p className="muted small">Attempts on a vault with money will appear once someone buys any offer.</p>
            )}
            <p className="muted small">
              Attacker: <b>{nameOf(attacker) ?? short(attacker)}</b> (not a party to any of these deals nor an arbiter in their disputes). Each
              attempt is a real transaction sent to the network in simulation mode: the same validation, no fees and no state change.
            </p>
            <div className="attempts">
              {attempts.map((a) => {
                const r = results[a.id];
                return (
                  <div key={a.id} className="attempt">
                    <div className="attempt-head">
                      <span>
                        <b>{a.title}</b>
                        <br />
                        <small className="muted">
                          target:{" "}
                          <Link className="plink" href={`/deal/${a.on.id}`}>
                            #{String(a.on.id)} {a.on.title}
                          </Link>{" "}
                          · {STATE_LABEL[a.on.state]}
                          {a.on.state >= State.Funded && a.on.state <= State.Delivered && <> · in vault {fmtUsdc(a.on.amount)}</>}
                        </small>
                      </span>
                      <button className="btn ghost sm" disabled={r === "running"} onClick={() => run(a)}>
                        {r === "running" ? "Checking…" : "Try it"}
                      </button>
                    </div>
                    {r && r !== "running" && (
                      <div className={`attempt-result ${r.ok && !SAFE_OK.includes(a.id) ? "passed" : "blocked"}`}>
                        <span>{r.ok ? (SAFE_OK.includes(a.id) ? "✓ " : "⚠ ") : "✗ Rejected: "}{r.text}</span>
                        {!r.ok && a.why && <small className="muted">{a.why}</small>}
                        {r.logs.length > 0 && (
                          <details>
                            <summary>program logs</summary>
                            <pre>{r.logs.slice(-8).join("\n")}</pre>
                          </details>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </section>

      <section className="card wide">
        <ProgramRules />
      </section>
    </div>
  );
}
