// Ikona karty Blinka (kwadrat SVG): tytuł oferty, cena i „pieniądze trzyma program”.
import { fmtUsdc } from "@/lib/format";
import { fetchDeal, readProgram } from "@/lib/solana";
import { serverConnection, serverDeployment } from "@/lib/sponsor";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function wrap(text: string, max: number, lines: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const word of text.split(/\s+/)) {
    if ((cur + " " + word).trim().length > max) {
      out.push(cur.trim());
      cur = word;
      if (out.length === lines) break;
    } else cur += " " + word;
  }
  if (out.length < lines && cur.trim()) out.push(cur.trim());
  return out.slice(0, lines);
}

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id") ?? "";
  let title = "SafeDeal";
  let price = "";
  try {
    const d = serverDeployment();
    if (d && /^\d{1,18}$/.test(id)) {
      const deal = await fetchDeal(readProgram(serverConnection(d), d), d, BigInt(id));
      if (deal) {
        title = deal.title;
        price = fmtUsdc(deal.amount);
      }
    }
  } catch {
    /* ikona zastępcza */
  }
  const lines = wrap(title, 18, 3)
    .map((l, i) => `<text x="64" y="${300 + i * 72}" font-size="60" font-weight="700" fill="#F3F1EA">${esc(l)}</text>`)
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800" viewBox="0 0 800 800">
<rect width="800" height="800" fill="#13261F"/>
<text x="64" y="120" font-family="Arial, sans-serif" font-size="40" font-weight="700" fill="#7FD1B4">◆ SafeDeal</text>
<g font-family="Arial, sans-serif">${lines}</g>
<text x="64" y="590" font-family="Arial, sans-serif" font-size="72" font-weight="700" fill="#7FD1B4">${esc(price)}</text>
<rect x="64" y="650" width="672" height="86" rx="18" fill="#1D3A30"/>
<text x="96" y="706" font-family="Arial, sans-serif" font-size="32" fill="#E2F0EB">🔒 Pieniądze trzyma program, nie sprzedawca</text>
</svg>`;
  return new Response(svg, { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=60", "Access-Control-Allow-Origin": "*" } });
}
