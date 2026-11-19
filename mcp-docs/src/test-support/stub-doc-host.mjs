/**
 * Test-only preload for a spawned sidecar:
 *   node --import tsx --import ./src/test-support/stub-doc-host.mjs src/index.ts
 *
 * `fetch_url` may only reach public addresses — the SSRF guard refuses loopback
 * and every private range — so a test cannot serve a document to the real
 * sidecar over a local socket. This stub answers GETs for ONE address from
 * TEST-NET-3 (203.0.113.0/24, RFC 5737: reserved for documentation, never
 * routable, and not a private range, so the SSRF guard still runs and passes)
 * and leaves every other request, the SearXNG call included, on the real
 * `fetch`. Everything else in the child — MCP endpoint, tool schema, handler,
 * cache, Redis — is the production code path.
 *
 * Plain .mjs on purpose: tsc does not compile it, so it never reaches `dist/`
 * or the image, and vitest does not collect it.
 */
const DOC_HOST = '203.0.113.10';
// Longer than every budget the backend asks for (2000, 5000, 10 000), so a returned length shows which one applied.
const DOC_BODY_LENGTH = 12_000;
const realFetch = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(href);
  if (url.hostname !== DOC_HOST) return realFetch(input, init);
  return new Response(`Document ${url.pathname}\n${'x'.repeat(DOC_BODY_LENGTH)}`, {
    status: 200,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
};
