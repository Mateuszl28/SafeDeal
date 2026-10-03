"use client";

import { State, isFinal, isZeroHash, type Deal } from "@/lib/contracts";
import { fmtDuration, fmtUsdc } from "@/lib/format";
import { nameOf, useWallet } from "@/lib/wallet";
import { explorerAddr } from "@/lib/solana";

type Path = { text: string; fn: string; anyone?: boolean; when?: bigint };

/**
 * „Kto może teraz ruszyć te pieniądze?” — wprost z reguł programu dla bieżącego stanu.
 * To jest moment, w którym pośrednik przestaje być potrzebny: nie ma osoby, która decyduje —
 * są tylko warunki, a każdy z nich sprawdza program.
 */
export function MoneyRules({ deal, vaultBalance }: { deal: Deal; vaultBalance?: bigint }) {
  const w = useWallet();
  const s = deal.state as State;
  if (s === State.Created || s === State.Cancelled || s === State.None) return null;

  const seller = nameOf(deal.seller) ?? "sprzedawca";
  const buyer = nameOf(deal.buyer) ?? "kupujący";
  const pickup = !isZeroHash(deal.pickupHash);
  const q = w.deployment?.oracleQuorum ?? 2;
  const n = w.deployment?.oracles.length ?? 3;
  const aq = w.deployment?.arbiterQuorum ?? 2;
  const an = w.deployment?.arbiters.length ?? 3;

  const toSeller: Path[] = [];
  const toBuyer: Path[] = [];
  const split: Path[] = [];

  if (s === State.Funded && pickup) {
    toSeller.push({ text: `${buyer} pokaże na spotkaniu tajny kod, a program sprawdzi go z hashem zapisanym przy wpłacie`, fn: "confirm_pickup" });
    toBuyer.push({ text: "do spotkania nie dojdzie przed terminem — rozliczyć może wtedy każdy", fn: "settle_expired", anyone: true, when: deal.deadline });
    toBuyer.push({ text: `${seller} dobrowolnie zwróci pieniądze`, fn: "refund_buyer" });
  } else if (s === State.Funded) {
    toSeller.push({ text: `${seller} nada paczkę, a potem ${q} z ${n} niezależnych źródeł potwierdzi doręczenie albo ${buyer} ją przyjmie`, fn: "mark_shipped → …" });
    toBuyer.push({ text: `${seller} nie nada paczki przed terminem — rozliczyć może wtedy każdy`, fn: "settle_expired", anyone: true, when: deal.deadline });
    toBuyer.push({ text: `${seller} dobrowolnie zwróci pieniądze`, fn: "refund_buyer" });
  } else if (s === State.Shipped || s === State.Delivered) {
    toSeller.push({ text: `${buyer} potwierdzi, że wszystko jest OK`, fn: "confirm_receipt" });
    toSeller.push({
      text: s === State.Delivered ? "minie okno reklamacji bez reklamacji — rozliczyć może wtedy każdy" : "minie czas na doręczenie i reklamację — rozliczyć może wtedy każdy",
      fn: "settle_expired",
      anyone: true,
      when: deal.deadline,
    });
    toBuyer.push({ text: `${buyer} zgłosi reklamację (z kaucją) przed terminem, a ${seller} jej nie odeprze`, fn: "open_dispute" });
    toBuyer.push({ text: `${seller} dobrowolnie zwróci pieniądze`, fn: "refund_buyer" });
    split.push({ text: "obie strony zgodzą się na tę samą kwotę ugody", fn: "propose / accept_settlement" });
  } else if (s === State.Disputed) {
    toBuyer.push({ text: `${seller} nie odpowie na reklamację przed terminem — rozliczyć może wtedy każdy`, fn: "settle_expired", anyone: true, when: deal.deadline });
    toBuyer.push({ text: `${seller} uzna reklamację`, fn: "refund_buyer" });
    toSeller.push({ text: `tylko przez arbitraż: ${seller} wpłaca kaucję, a ${aq} z ${an} arbitrów przyzna mu rację`, fn: "respond_to_dispute → reveal_vote" });
    split.push({ text: "obie strony zgodzą się na tę samą kwotę ugody", fn: "propose / accept_settlement" });
  } else if (s === State.InArbitration) {
    toSeller.push({ text: `${aq} z ${an} arbitrów ujawni głos za sprzedawcą`, fn: "reveal_vote" });
    toBuyer.push({ text: `${aq} z ${an} arbitrów ujawni głos za kupującym`, fn: "reveal_vote" });
    split.push({ text: "arbitrzy nie rozstrzygną przed terminem — podział 50/50, rozliczyć może każdy", fn: "settle_expired", anyone: true, when: deal.deadline });
    split.push({ text: "obie strony zgodzą się na tę samą kwotę ugody", fn: "propose / accept_settlement" });
  }

  const final = isFinal(s);

  return (
    <section className="card wide money-rules">
      <h2>{final ? "Kto ruszył te pieniądze?" : "Kto może teraz ruszyć te pieniądze?"}</h2>
      {final ? (
        <p>
          Nikt nie musiał niczego „zatwierdzać”. Program wypłacił środki, gdy spełnił się zapisany warunek — sejf jest
          teraz pusty{vaultBalance !== undefined ? ` (${fmtUsdc(vaultBalance)})` : ""}.
        </p>
      ) : (
        <>
          <p className="muted small">
            {vaultBalance !== undefined && <b>{fmtUsdc(vaultBalance)}</b>} leży w sejfie, którego właścicielem jest program —
            nie człowiek. Wyjdą z niego tylko w jeden z tych sposobów:
          </p>
          <div className="paths">
            <PathList title={`→ do: ${seller}`} paths={toSeller} now={w.now} />
            <PathList title={`→ do: ${buyer}`} paths={toBuyer} now={w.now} />
            {split.length > 0 && <PathList title="→ podział" paths={split} now={w.now} />}
          </div>
        </>
      )}
      <ul className="nobody">
        <li>✗ {seller} nie wypłaci sobie pieniędzy przed spełnieniem warunku</li>
        <li>✗ {buyer} nie cofnie wpłaty jak przelewu</li>
        <li>
          ✗ autorzy SafeDeal też nie — program nie ma instrukcji administratora, a reguły zapisano raz przy wdrożeniu{" "}
          {w.deployment && (
            <a className="plink" href={explorerAddr(w.deployment.programId, w.deployment.cluster)} target="_blank" rel="noreferrer">
              (program ↗)
            </a>
          )}
        </li>
      </ul>
    </section>
  );
}

function PathList({ title, paths, now }: { title: string; paths: Path[]; now: bigint }) {
  return (
    <div className="path-col">
      <b>{title}</b>
      <ul>
        {paths.map((p) => (
          <li key={p.fn + p.text}>
            <span>gdy {p.text}</span>
            {p.when !== undefined && p.when > 0n && (
              <small className="muted"> · {p.when > now ? `za ${fmtDuration(p.when - now)}` : "termin minął — można teraz"}</small>
            )}
            <code className="fn">{p.fn}</code>
            {p.anyone && <span className="anyone">może każdy</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
