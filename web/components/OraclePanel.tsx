"use client";

import type { Deal } from "@/lib/contracts";
import { DEMO_ORACLES, useWallet } from "@/lib/wallet";

/** Demo: każde źródło osobno potwierdza doręczenie; program zmienia stan dopiero po kworum. */
export function OraclePanel({ deal }: { id?: bigint; deal: Deal }) {
  const w = useWallet();
  const attested = DEMO_ORACLES.map((_, i) => ((deal.attestedMask >> i) & 1) === 1);
  const quorum = w.deployment?.oracleQuorum ?? 1;

  if (DEMO_ORACLES.length === 0) return <p className="muted small">No demo oracle keys — run the devnet setup script.</p>;

  return (
    <div className="oracles">
      <div className="oracle-head">
        Delivery confirmations: <b>{deal.attestations}/{quorum}</b>
        <small className="muted"> — one source isn't enough to release the money</small>
      </div>
      <div className="inline">
        {DEMO_ORACLES.map((o, i) => (
          <button
            key={o.name}
            className={`btn ghost ${attested[i] ? "attested" : ""}`}
            disabled={!!w.busy || attested[i]}
            onClick={() => w.write("confirmDelivery", [], { asOracle: i, deal, label: `${o.name}: delivered` })}
          >
            {attested[i] ? "✓" : "📦"} {o.name}
          </button>
        ))}
      </div>
    </div>
  );
}
