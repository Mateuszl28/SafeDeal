// Jedna linijka dla serwisu z ogłoszeniami:
//   <script src="https://<safedeal>/widget.js" async></script>
// a w treści ogłoszenia:
//   <div data-safedeal-deal="12"></div>            → karta „Kup bezpiecznie przez SafeDeal” (iframe z /widget/deal/12)
//   <a data-safedeal-sell data-title="Rower" data-price="250" data-description="…" data-url="https://…"></a>
//                                                   → przycisk „Sprzedaj przez SafeDeal” z wypełnionym formularzem oferty
// Skrypt nie ma dostępu do portfela ani pieniędzy — tylko osadza kartę i buduje link.
const SCRIPT = String.raw`(function () {
  var me = document.currentScript;
  var base = me ? new URL(me.src).origin : "";
  if (!base) return;

  function card(el) {
    if (el.getAttribute("data-safedeal-mounted")) return;
    var id = el.getAttribute("data-safedeal-deal") || "";
    if (!/^\d{1,18}$/.test(id)) return;
    el.setAttribute("data-safedeal-mounted", "1");
    var theme = el.getAttribute("data-theme");
    var f = document.createElement("iframe");
    f.src = base + "/widget/deal/" + id + (theme === "dark" || theme === "light" ? "?theme=" + theme : "");
    f.title = "SafeDeal — bezpieczny zakup tej oferty";
    f.loading = "lazy";
    f.setAttribute("data-safedeal-id", id);
    f.style.cssText = "border:0;width:100%;max-width:420px;height:280px;display:block;background:transparent";
    el.appendChild(f);
  }

  function sellButton(el) {
    if (el.getAttribute("data-safedeal-mounted")) return;
    el.setAttribute("data-safedeal-mounted", "1");
    var q = new URLSearchParams();
    var map = { title: "tytul", price: "cena", description: "opis", url: "zrodlo" };
    Object.keys(map).forEach(function (k) {
      var v = el.getAttribute("data-" + k);
      if (v) q.set(map[k], v.slice(0, 600));
    });
    var a = el.tagName === "A" ? el : document.createElement("a");
    a.href = base + "/?" + q.toString() + "#nowa-oferta";
    a.target = "_blank";
    a.rel = "noopener";
    if (!a.textContent.trim()) a.textContent = "🔒 Sprzedaj bezpiecznie przez SafeDeal";
    if (!a.className) a.style.cssText = "display:inline-block;padding:10px 14px;border-radius:10px;background:#111827;color:#fff;font:600 14px system-ui,sans-serif;text-decoration:none";
    if (a !== el) el.appendChild(a);
  }

  function scan(root) {
    root.querySelectorAll("[data-safedeal-deal]").forEach(card);
    root.querySelectorAll("[data-safedeal-sell]").forEach(sellButton);
  }

  // Karta zgłasza swoją wysokość — iframe dopasowuje się do treści.
  window.addEventListener("message", function (e) {
    if (e.origin !== base || !e.data || e.data.type !== "safedeal:height") return;
    document.querySelectorAll('iframe[data-safedeal-id="' + String(e.data.id).replace(/\D/g, "") + '"]').forEach(function (f) {
      f.style.height = Math.min(Number(e.data.height) || 280, 800) + 2 + "px";
    });
  });

  scan(document);
  // Serwisy z ogłoszeniami często doładowują treść dynamicznie.
  new MutationObserver(function () { scan(document); }).observe(document.documentElement, { childList: true, subtree: true });
})();`;

export function GET() {
  return new Response(SCRIPT, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
