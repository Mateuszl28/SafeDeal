"use client";

import type { Deal } from "@/lib/contracts";
import { DEMO_ORACLES, useWallet } from "@/lib/wallet";

/** Demo: każde źródło osobno potwierdza doręczenie; program zmienia stan dopiero po kworum. */
export function OraclePanel({ deal }: { id?: bigint; deal: Deal }) {
  const w = useWallet();
  const attested = DEMO_ORACLES.map((_, i) => ((deal.attestedMask >> i) & 1) === 1);
  const quorum = w.deployment?.oracleQuorum ?? 1;

  if (DEMO_ORACLES.length === 0) return <p className="muted small">Brak kluczy oracle&apos;i demo — uruchom skrypt konfiguracji devnetu.</p>;

  return (
    <div className="oracles">
      <div className="oracle-head">
        Potwierdzenia doręczenia: <b>{deal.attestations}/{quorum}</b>
        <small className="muted"> — jedno źródło nie wystarczy, żeby uwolnić pieniądze</small>
      </div>
      <div className="inline">
        {DEMO_ORACLES.map((o, i) => (
          <button
            key={o.name}
            className={`btn ghost ${attested[i] ? "attested" : ""}`}
            disabled={!!w.busy || attested[i]}
            onClick={() => w.write("confirmDelivery", [], { asOracle: i, deal, label: `${o.name}: doręczono` })}
          >
            {attested[i] ? "✓" : "📦"} {o.name}
          </button>
        ))}
      </div>
    </div>
  );
}
