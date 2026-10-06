// Relayer bez stale działającego procesu (Vercel Hobby nie ma crona co minutę):
//   GET /api/relayer?deal=12  — jedna transakcja; woła ją strona transakcji, gdy ktoś ją ogląda,
//   GET /api/relayer          — przegląd wszystkich; woła go zadanie GitHub Actions co kilka minut.
// Endpoint jest publiczny, bo nie daje żadnej władzy: losować skład może każdy, a potwierdzenia doręczenia
// wynikają z obiektywnego warunku (status InPost / DEMO-… po 15 s). Limity chronią przed zasypaniem RPC.
import { State } from "@/lib/contracts";
import { fetchDeal, readProgram } from "@/lib/solana";
import { needsRelay, relayAll, relayDeal } from "@/lib/relayer";
import { serverConnection, serverDeployment, sponsorKey } from "@/lib/sponsor";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const PER_DEAL_MS = 8_000;
const FULL_SCAN_MS = 30_000;
const last = new Map<string, number>();

function throttled(key: string, ms: number): boolean {
  const now = Date.now();
  if (now - (last.get(key) ?? 0) < ms) return true;
  last.set(key, now);
  if (last.size > 500) last.clear();
  return false;
}

export async function GET(req: Request) {
  const d = serverDeployment();
  if (!d) return Response.json({ message: "Brak wdrożenia programu." }, { status: 503 });
  const idParam = new URL(req.url).searchParams.get("deal");
  if (idParam !== null && !/^\d{1,18}$/.test(idParam)) return Response.json({ message: "Nieprawidłowy numer." }, { status: 400 });

  const key = idParam ?? "*";
  if (throttled(key, idParam ? PER_DEAL_MS : FULL_SCAN_MS)) return Response.json({ skipped: "throttled" });

  const program = readProgram(serverConnection(d), d);
  const now = Math.floor(Date.now() / 1000);
  try {
    if (idParam === null) return Response.json({ done: await relayAll(program, d, sponsorKey(), now) });
    const deal = await fetchDeal(program, d, BigInt(idParam));
    if (!deal || deal.archived || !needsRelay(deal)) return Response.json({ done: [], state: deal ? State[deal.state] : null });
    return Response.json({ done: await relayDeal(program, d, deal, sponsorKey(), now) });
  } catch (e) {
    return Response.json({ message: e instanceof Error ? e.message.slice(0, 300) : String(e) }, { status: 500 });
  }
}
