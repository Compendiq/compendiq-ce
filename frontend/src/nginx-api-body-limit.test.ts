import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * The edge body limit in front of the API (#1178).
 *
 * nginx defaults `client_max_body_size` to 1 MB. Left unset, the bundled edge
 * therefore rejected any request body above that with its own HTML 413 —
 * before Fastify saw the request, so none of the app's error contract applied
 * and none of the app's own limits were reachable. A 1.2 MB Markdown import
 * failed with `Request Entity Too Large` from `<center>nginx</center>`, which
 * names nginx's rule and gives the user nothing to act on.
 *
 * These invariants keep the edge above every limit the app declares, so the
 * rejection a user sees always comes from the app, in the app's own words.
 * There is no unit test that can start nginx, so the config is asserted as
 * content — the same approach as `nginx-security-headers.test.ts`.
 */

const confPath = resolve(__dirname, '..', 'nginx.conf');
const confSource = readFileSync(confPath, 'utf-8');

/** Parse an nginx size value (`30m`, `8k`, `1024`) into bytes. */
function toBytes(size: string): number {
  const match = size.trim().match(/^(\d+)([kKmMgG]?)$/);
  if (!match) throw new Error(`Not an nginx size value: ${size}`);
  const scale = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[match[2]!.toLowerCase()]!;
  return Number(match[1]) * scale;
}

/**
 * The largest JSON body a document at the import route's 1,000,000-character
 * schema limit can serialise to. `JSON.stringify` escapes a control character
 * to a six-byte `\uXXXX`, which is the worst case per UTF-16 code unit; three
 * bytes is the worst case for ordinary non-ASCII text (any BMP character from
 * U+0800 up, so all CJK). The edge has to clear this, or a file the schema
 * accepts is still refused before the app can say so.
 */
const WORST_CASE_IMPORT_BODY_BYTES = 6 * 1_000_000;

/** Backend route modules that raise Fastify's 1 MiB default body limit. */
const ROUTE_FILES = [
  'backend/src/routes/confluence/attachments.ts',
  'backend/src/routes/knowledge/local-attachments.ts',
  'backend/src/routes/knowledge/pages-crud.ts',
  'backend/src/routes/knowledge/pages-import.ts',
];

/** Evaluate the literal forms a bodyLimit is written in: `40 * 1024 * 1024`, `35_000_000`. */
function product(expression: string): number {
  return expression
    .split('*')
    .map((factor) => Number(factor.replace(/_/g, '').trim()))
    .reduce((a, b) => a * b, 1);
}

/**
 * Every per-route `bodyLimit` declared behind this location, read out of the
 * backend sources rather than copied here.
 *
 * Import is not the only route under `/api/`, and it is far from the largest —
 * the attachment routes declare 40 MiB and 35 MB for base64-inflated diagram
 * and image payloads. An edge below those makes nginx the binding limit for
 * them: the same unreadable HTML 413 this file exists to prevent, just on a
 * different route. Parsing the real values means raising a route's bodyLimit
 * past the edge fails here rather than in production.
 */
function declaredRouteBodyLimits(): { file: string; bytes: number }[] {
  const repoRoot = resolve(__dirname, '..', '..');

  return ROUTE_FILES.flatMap((file) => {
    const source = readFileSync(resolve(repoRoot, file), 'utf-8');
    return [...source.matchAll(/bodyLimit:\s*([\w\s*]+?)\s*[,}]/g)].map((match) => {
      const raw = match[1]!.trim();
      // A named constant resolves to its initialiser in the same file.
      const expression = /^\d/.test(raw)
        ? raw
        : source.match(new RegExp(`\\b${raw}\\s*=\\s*([\\d_\\s*]+);`))?.[1] ?? '';
      const bytes = product(expression);
      if (!Number.isFinite(bytes) || bytes <= 0) {
        throw new Error(`Could not read bodyLimit "${raw}" in ${file}`);
      }
      return { file, bytes };
    });
  });
}

/** Directive lines only, so prose in a comment can't be read as config. */
const directives = confSource
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith('#'));

describe('nginx.conf API edge body limit', () => {
  it('declares client_max_body_size exactly once', () => {
    const declarations = directives.filter((line) => /^client_max_body_size\s/.test(line));
    expect(declarations).toHaveLength(1);
  });

  it('allows a body larger than the import route can possibly need', () => {
    const match = confSource.match(/^\s*client_max_body_size\s+(\S+?);/m);
    expect(match).not.toBeNull();
    expect(toBytes(match![1]!)).toBeGreaterThan(WORST_CASE_IMPORT_BODY_BYTES);
  });

  it('scopes the raised limit to the API proxy, not the whole server', () => {
    // Only /api/ needs it. Leaving the SPA and static locations on nginx's
    // 1 MB default keeps the enlarged buffer off every other route.
    const apiBlock = confSource.match(/location\s+\^~\s+\/api\/\s*\{([\s\S]*?)\n {8}\}/);
    expect(apiBlock).not.toBeNull();
    expect(apiBlock![1]).toMatch(/^\s*client_max_body_size\s/m);
  });

  it('clears every per-route bodyLimit the backend declares behind /api/', () => {
    // The invariant the whole change rests on: the app is always what rejects.
    // A route whose bodyLimit sits above the edge can never reach its own
    // validation, so the user gets nginx's HTML 413 instead of the app's
    // message — on that route, exactly the #1178 bug.
    const limits = declaredRouteBodyLimits();
    expect(limits.length).toBeGreaterThanOrEqual(4);

    const edge = toBytes(confSource.match(/^\s*client_max_body_size\s+(\S+?);/m)![1]!);
    for (const { file, bytes } of limits) {
      expect(
        edge,
        `client_max_body_size must clear the bodyLimit declared in ${file}`,
      ).toBeGreaterThanOrEqual(bytes);
    }
  });

  it('matches the value the reverse-proxy guide tells operators to allow', () => {
    // Two nginx layers in the documented topology: the operator's, and this
    // one. If the guide recommends less than the bundled edge, the outer proxy
    // silently becomes the binding limit and the raise here buys nothing —
    // which is precisely how the 1 MB default went unnoticed.
    const guide = readFileSync(
      resolve(__dirname, '..', '..', 'docs/integrations/reverse-proxy/nginx.md'),
      'utf-8',
    );
    const edge = toBytes(confSource.match(/^\s*client_max_body_size\s+(\S+?);/m)![1]!);

    const recommended = [...guide.matchAll(/client_max_body_size\s+(\S+?);/g)]
      .map((m) => toBytes(m[1]!));
    expect(recommended.length).toBeGreaterThan(0);
    for (const value of recommended) {
      expect(value).toBeGreaterThanOrEqual(edge);
    }
  });
});
