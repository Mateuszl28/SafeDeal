// Karta oferty do osadzenia w serwisie z ogłoszeniami (iframe albo widget.js). Czysty HTML z serwera —
// działa bez JavaScriptu, nie wymaga portfela. Przycisk prowadzi na stronę oferty w SafeDeal, gdzie
// zakup to jeden podpis (a opłatę sieci płaci sponsor). Dane czytamy wprost z łańcucha.
import { State, STATE_LABEL, isZero } from "@/lib/contracts";
import { dealsDone, fmtDuration, fmtUsdc } from "@/lib/format";
import { fetchDeal, fetchProfile, readProgram } from "@/lib/solana";
import { serverConnection, serverDeployment } from "@/lib/sponsor";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const DARK = `:root { --bg:#0f141c; --text:#eef1f6; --muted:#9aa4b5; --border:rgba(255,255,255,.12); --accent:#14f195; --accent-bg:rgba(20,241,149,.1); --btn:#14f195; --btn-text:#04140c; }`;

/** theme=light|dark wymusza motyw (np. pod wygląd serwisu), domyślnie według ustawień systemu. */
function page(body: string, theme: string | null, id: string) {
  const darkCss = theme === "dark" ? DARK : theme === "light" ? "" : `@media (prefers-color-scheme: dark) { ${DARK} }`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>SafeDeal — safe purchase</title>
<style>
:root { --bg:#ffffff; --text:#111827; --muted:#5b6474; --border:#e3e6ec; --accent:#0a7d55; --accent-bg:#e8f7f0; --btn:#111827; --btn-text:#ffffff; }
${darkCss}
* { box-sizing:border-box; }
html,body { margin:0; background:transparent; }
body { font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; color:var(--text); }
.card { background:var(--bg); border:1px solid var(--border); border-radius:14px; padding:14px 16px; display:grid; gap:8px; }
.top { display:flex; justify-content:space-between; gap:12px; align-items:baseline; }
.brand { font-size:12px; color:var(--muted); font-weight:600; letter-spacing:.02em; }
h1 { font-size:15px; margin:0; overflow-wrap:anywhere; }
.price { font-size:18px; font-weight:700; white-space:nowrap; }
.shield { background:var(--accent-bg); color:var(--text); border-radius:10px; padding:8px 10px; font-size:13px; }
.shield b { color:var(--accent); }
ul { margin:0; padding-left:18px; color:var(--muted); font-size:12.5px; display:grid; gap:2px; }
.btn { display:block; text-align:center; background:var(--btn); color:var(--btn-text); text-decoration:none; font-weight:600; border-radius:10px; padding:10px 12px; min-height:44px; }
.btn:focus-visible { outline:3px solid var(--accent); outline-offset:2px; }
.muted { color:var(--muted); font-size:12.5px; }
</style></head>
<body>${body}
<script>
  // Wysokość karty dla widget.js (iframe dopasowuje się do treści). Bez JS karta i tak działa.
  (function(){ function send(){ parent.postMessage({ type: "safedeal:height", id: ${JSON.stringify(id)}, height: document.body.scrollHeight }, "*"); }
  window.addEventListener("load", send); new ResizeObserver(send).observe(document.body); })();
</script>
</body></html>`;
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const theme = url.searchParams.get("theme");
  const headers = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=15" };
  const d = serverDeployment();
  if (!d || !/^\d{1,18}$/.test(id)) {
    return new Response(page(`<div class="card"><span class="muted">No such SafeDeal offer.</span></div>`, theme, id), { status: 404, headers });
  }
  try {
    const program = readProgram(serverConnection(d), d);
    const deal = await fetchDeal(program, d, BigInt(id));
    if (!deal) throw new Error("not found");
    const rep = await fetchProfile(program, d, deal.seller);
    const open = deal.state === State.Created && isZero(deal.buyer);
    const link = `${url.origin}/deal/${id}`;
    const w = d.windows;
    const body = `<div class="card">
  <div class="top"><span class="brand">🔒 SafeDeal · safe purchase</span><span class="muted">#${esc(id)}</span></div>
  <div class="top"><h1>${esc(deal.title)}</h1><span class="price">${esc(fmtUsdc(deal.amount))}</span></div>
  ${
    open
      ? `<div class="shield"><b>The money is held by the program, not the seller.</b> Paid out only after delivery and the claim window.</div>
  <ul>
    <li>${deal.pickupAllowed ? "In-person pickup: you pay upfront, and the seller gets the money only after you show your code at the meetup" : `Parcel not shipped within ${esc(fmtDuration(w.ship))} → the money comes back automatically`}</li>
    <li>Disputes are decided by arbiters drawn from an open pool — not the platform</li>
    <li>Seller: ${esc(dealsDone(rep.soldOk + rep.boughtOk))}${rep.disputesLost ? `, disputes lost: ${rep.disputesLost}` : ""}</li>
  </ul>
  <a class="btn" href="${esc(link)}" target="_blank" rel="noopener">Buy safely with SafeDeal</a>
  <span class="muted">Network fees are paid by a sponsor — you don't need crypto for fees.</span>`
      : `<div class="shield">Status: <b>${esc(STATE_LABEL[deal.state as State] ?? "—")}</b></div>
  <a class="btn" href="${esc(link)}" target="_blank" rel="noopener">View the deal on SafeDeal</a>`
  }
</div>`;
    return new Response(page(body, theme, id), { headers });
  } catch {
    return new Response(page(`<div class="card"><span class="muted">Couldn't load offer #${esc(id)}.</span></div>`, theme, id), {
      status: 404,
      headers,
    });
  }
}
