// Kod źródłowy dla Chainlink Functions — wykonywany przez zdecentralizowaną sieć węzłów (DON).
// Każdy węzeł niezależnie pyta API InPost; wynik trafia on-chain dopiero po konsensusie,
// więc żaden pojedynczy serwer nie może sfałszować statusu "doręczono".
//
// args[0] — numer przesyłki
// Zwraca uint256: 1 = doręczono, 0 = jeszcze nie.
//
// Konsument on-chain (FunctionsClient) w fulfillRequest() przy wyniku 1 woła
// SafeDeal.confirmDelivery(id) — adres konsumenta ustawiamy jako `oracle` przez setOracle().

const tracking = args[0];

const res = await Functions.makeHttpRequest({
  url: `https://api-shipx-pl.easypack24.net/v1/tracking/${encodeURIComponent(tracking)}`,
  timeout: 9000,
});

if (res.error) {
  throw Error(`InPost API error: ${res.message}`);
}

return Functions.encodeUint256(res.data.status === "delivered" ? 1 : 0);
