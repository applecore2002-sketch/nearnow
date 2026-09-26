// Route: /healthz — parity with the local Node server's health endpoint.
export default async function onRequest() {
  return new Response(
    JSON.stringify({ ok: true, service: 'nearnow', version: '0.1.0' }),
    { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }
  );
}
