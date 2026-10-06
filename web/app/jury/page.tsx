"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { PublicKey, SYSVAR_SLOT_HASHES_PUBKEY, TransactionMessage, VersionedTransaction, type TransactionInstruction } from "@solana/web3.js";
import { createTransferInstruction, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { State, STATE_LABEL, isFinal, type Deal } from "@/lib/contracts";
import { fmtUsdc, short } from "@/lib/format";
import { ata, explorerAddr, fetchAllDeals, pdas } from "@/lib/solana";
import { PERSONAS, nameOf, useWallet } from "@/lib/wallet";
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
    return "rent może trafić tylko do sprzedawcy zapisanego w transakcji (has_one = seller) — podmiana odbiorcy nie przechodzi (ConstraintHasOne)";
  if (m) return `${m[2]} (${m[1]})`;
  if (/owner does not match/i.test(all)) return "Program tokenów: podpisujący nie jest właścicielem sejfu — klucza do sejfu nie ma nikt, ma go tylko program (PDA).";
  if (/custom program error: 0x4\b/.test(all)) return "Program tokenów: podpisujący nie jest właścicielem sejfu.";
  if (/insufficient/i.test(all)) return "Brak środków na koncie atakującego.";
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
          title: arbTarget.panelDrawn ? "Wylosuj skład arbitrów jeszcze raz — tym razem ze mną" : "Wpisz siebie do składu arbitrów zamiast losowania",
          who,
          on: arbTarget,
          why: "Program sam liczy skład z hasha slotu i porównuje go z podanymi kontami — wywołujący nie ma wpływu na wynik losowania.",
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
          title: "Zagłosuj w sporze, choć nie wylosowano mnie do składu",
          who,
          on: arbTarget,
          why: "Głosować mogą tylko 3 osoby wylosowane do tej sprawy (deal.panel).",
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
        title: "Zamknij konta transakcji, ale rent wyślij do mnie",
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
          title: "Rozlicz arbitra, ale jego nagrodę wyślij na moje konto",
          who,
          on: closedTarget,
          why: "Konto na nagrodę musi należeć do arbitra ze składu (arbiter_ata.owner == deal.panel[i]).",
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
        title: "Wypłać pieniądze prosto z sejfu, z pominięciem programu",
        who,
        build: async () => [createTransferInstruction(vault, myAta, me, target.amount)],
      },
      {
        id: "redirect",
        on: target,
        title: "Zwróć pieniądze „kupującemu”, ale na moje konto",
        who,
        build: async () => [await m.refundBuyer().accountsPartial(payout(myAta, ata(d.mint, target.seller))).instruction()],
      },
      {
        id: "receipt",
        on: target,
        title: "Potwierdź odbiór zamiast kupującego",
        who,
        build: async () => [await m.confirmReceipt().accountsPartial(payout(ata(d.mint, target.buyer), ata(d.mint, target.seller))).instruction()],
      },
      {
        id: "early",
        on: target,
        title: expired ? "Rozlicz po terminie (to akurat wolno każdemu)" : "Rozlicz transakcję przed terminem",
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
                  ? `Dozwolone: termin minął, więc rozliczyć może każdy — ale pieniądze trafią tylko tam, gdzie każe reguła (${target?.state === State.Funded ? "zwrot do kupującego" : "wypłata do sprzedawcy"}), nie do wywołującego.`
                  : a.id === "panel"
                    ? // Jedyna gałąź draw_panel, która kończy się bez sprawdzania kont: slot losowania wypadł z historii.
                      "Nikogo nie wpisano: slot losowania wypadł już z historii łańcucha, więc program tylko przesunął losowanie na nowy, przyszły slot (DrawRescheduled). Podane konta w ogóle nie zostały użyte."
                    : "Program przepuściłby tę transakcję — warunek jest spełniony.",
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
        <h1>Dla jury: sprawdź sam</h1>
        <p>
          Wszystko na tej stronie pochodzi prosto z Solany (devnet) — nie z naszej bazy. Jeśli coś tu twierdzimy, możesz to
          zweryfikować w Solana Explorer albo w kodzie programu.
        </p>
      </section>

      <section className="card">
        <h2>Program</h2>
        {d ? (
          <>
            <p>
              <span className="muted">Adres: </span>
              <a className="plink mono" href={explorerAddr(d.programId, d.cluster)} target="_blank" rel="noreferrer">
                {d.programId} ↗
              </a>
            </p>
            <p>
              <span className="muted">Czy autor może zmienić kod? </span>
              {upgrade === undefined ? (
                "sprawdzam…"
              ) : upgrade === null ? (
                <b>Nie udało się odczytać konta programu w tej sieci — sprawdź w Explorerze.</b>
              ) : upgrade.authority === null ? (
                <b>Nie — program jest niezmienny (brak upgrade authority).</b>
              ) : (
                <>
                  <b>Jeszcze tak</b> — upgrade authority:{" "}
                  <a className="plink mono" href={explorerAddr(upgrade.authority, d.cluster)} target="_blank" rel="noreferrer">
                    {short(upgrade.authority)} ↗
                  </a>
                  . Mówimy to wprost: po ostatnich poprawkach odbierzemy je na stałe (<code>set-upgrade-authority --final</code>).
                  Reguł w konfiguracji nie zmieni nikt już teraz — program nie ma instrukcji administratora.
                </>
              )}
            </p>
          </>
        ) : (
          <p className="muted">Brak wdrożenia.</p>
        )}
      </section>

      <section className="card">
        <h2>Gdzie w kodzie znika pośrednik</h2>
        <ul className="code-refs">
          <li>
            <code>CreateDeal</code> — sejf to konto tokenowe z <code>token::authority = deal</code>: właścicielem jest adres programu (PDA), nie człowiek.
          </li>
          <li>
            <code>pay_raw</code> — jedyna droga wyjścia z sejfu; przelew podpisuje PDA transakcji (<code>new_with_signer</code>).
          </li>
          <li>
            <code>Payout</code> — konta odbiorców przypięte do adresów stron: <code>buyer_ata.owner == deal.buyer</code>.
          </li>
          <li>
            <code>settle_expired</code> — po terminie wynik zależy tylko od stanu; wywołać może każdy.
          </li>
          <li>
            <code>draw_panel</code> — skład arbitrów liczy program z hasha slotu, który powstał po przyjęciu sporu; wywołujący tylko
            podaje konta, a program sprawdza każdy adres.
          </li>
          <li>
            <code>CloseDeal</code> — rent wraca na adres sprzedawcy zapisany w transakcji (<code>has_one = seller</code>), kto by nie zamykał.
          </li>
        </ul>
        <p className="muted small">
          Plik: <code>solana/programs/safedeal/src/lib.rs</code> (Anchor). Testy scenariuszy: <code>solana/scripts/e2e.mjs</code>.
        </p>
      </section>

      <section className="card wide">
        <h2>Spróbuj oszukać program</h2>
        {attempts.length === 0 && attacker ? (
          <p className="muted">Brak transakcji z pieniędzmi w sejfie — kup najpierw dowolną ofertę.</p>
        ) : !attacker ? (
          <p className="muted">Połącz portfel albo przełącz się na tryb demo.</p>
        ) : (
          <>
            {!target && (
              <p className="muted small">Próby na sejfie z pieniędzmi pojawią się, gdy ktoś kupi dowolną ofertę.</p>
            )}
            <p className="muted small">
              Atakuje: <b>{nameOf(attacker) ?? short(attacker)}</b> (nie jest stroną żadnej z tych transakcji ani arbitrem w ich sporach). Każda
              próba to prawdziwa transakcja wysłana do sieci w trybie symulacji: ta sama walidacja, bez opłat i bez zmiany stanu.
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
                          cel:{" "}
                          <Link className="plink" href={`/deal/${a.on.id}`}>
                            #{String(a.on.id)} {a.on.title}
                          </Link>{" "}
                          · {STATE_LABEL[a.on.state]}
                          {a.on.state >= State.Funded && a.on.state <= State.Delivered && <> · w sejfie {fmtUsdc(a.on.amount)}</>}
                        </small>
                      </span>
                      <button className="btn ghost sm" disabled={r === "running"} onClick={() => run(a)}>
                        {r === "running" ? "Sprawdzam…" : "Spróbuj"}
                      </button>
                    </div>
                    {r && r !== "running" && (
                      <div className={`attempt-result ${r.ok && !SAFE_OK.includes(a.id) ? "passed" : "blocked"}`}>
                        <span>{r.ok ? (SAFE_OK.includes(a.id) ? "✓ " : "⚠ ") : "✗ Odrzucone: "}{r.text}</span>
                        {!r.ok && a.why && <small className="muted">{a.why}</small>}
                        {r.logs.length > 0 && (
                          <details>
                            <summary>logi programu</summary>
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
