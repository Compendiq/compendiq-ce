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

  it('stays at or below what the reverse-proxy guide tells operators to allow', () => {
    // docs/integrations/reverse-proxy/nginx.md tells operators to set 30m on
    // the proxy in front of this one. An edge above that would be unreachable
    // in exactly the deployments the guide describes.
    const match = confSource.match(/^\s*client_max_body_size\s+(\S+?);/m);
    expect(toBytes(match![1]!)).toBeLessThanOrEqual(toBytes('30m'));
  });
});
