import { NextResponse } from "next/server";

// Kurs średni USD z tabeli A NBP (publiczne API, bez klucza). USDC jest powiązany 1:1 z dolarem,
// więc to przybliżona wartość w złotówkach — tylko informacyjnie, kontrakt operuje wyłącznie na USDC.
export async function GET() {
  try {
    const res = await fetch("https://api.nbp.pl/api/exchangerates/rates/a/usd/?format=json", {
      next: { revalidate: 3600 },
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`NBP ${res.status}`);
    const json = (await res.json()) as { rates: { mid: number; effectiveDate: string }[] };
    const rate = json.rates?.[0];
    if (!rate?.mid) throw new Error("brak kursu");
    return NextResponse.json({ mid: rate.mid, date: rate.effectiveDate });
  } catch {
    return NextResponse.json({ error: "Kurs NBP niedostępny" }, { status: 503 });
  }
}
