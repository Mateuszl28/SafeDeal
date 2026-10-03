// Mapa dla klientów Blinks: link do strony oferty (/deal/12) → jej endpoint Solana Actions.
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,OPTIONS", "Content-Type": "application/json" };

export async function GET() {
  return new Response(JSON.stringify({ rules: [{ pathPattern: "/deal/*", apiPath: "/api/actions/deal/*" }] }), { headers: CORS });
}

export async function OPTIONS() {
  return new Response(null, { headers: CORS });
}
