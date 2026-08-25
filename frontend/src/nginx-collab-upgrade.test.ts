import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Ingress for collaborative editing (#1446 / Key Decision G).
 *
 * `GET /api/collab/:pageId` is a WebSocket. The bundled edge's generic
 * `location ^~ /api/` is SSE-shaped (`proxy_buffering off`, 300s read
 * timeout) and does **not** Upgrade, so a sibling `^~ /api/collab/` has to
 * carry HTTP/1.1 Upgrade + a 3600s idle timeout — longer prefix beats
 * `/api/`. Vite's `/api` proxy is the same hole for `npm run dev`: without
 * `ws: true` the editor child never upgrades on the Vite port.
 *
 * There is no unit test that can start nginx or Vite's proxy, so both
 * configs are asserted as content — the same approach as
 * `nginx-api-body-limit.test.ts` and `build-config.test.ts`.
 */

const confPath = resolve(__dirname, '..', 'nginx.conf');
const confSource = readFileSync(confPath, 'utf-8');

const viteConfigPath = resolve(__dirname, '..', 'vite.config.ts');
const viteConfigSource = readFileSync(viteConfigPath, 'utf-8');

/** Directive lines only, so prose in a comment can't be read as config. */
function directiveLines(block: string): string[] {
  return block
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

/**
 * Body of `location ^~ <prefix> { ... }` whose closing brace sits at the
 * same 8-space indent as the `location` directive (the shape of every
 * prefix location in `frontend/nginx.conf`).
 */
function locationBlock(prefix: string): string {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = confSource.match(
    new RegExp(`location\\s+\\^~\\s+${escaped}\\s*\\{([\\s\\S]*?)\\n {8}\\}`),
  );
  expect(match, `missing location ^~ ${prefix}`).not.toBeNull();
  return match![1]!;
}

function directiveValue(lines: string[], name: string): string {
  const match = lines
    .map((line) => line.match(new RegExp(`^${name}\\s+(.+?);$`)))
    .find((m) => m !== null);
  expect(match, `missing ${name}`).not.toBeNull();
  return match![1]!;
}

/** Parse an nginx time value (`3600s`, `60m`, `1h`, bare seconds) to seconds. */
function toSeconds(value: string): number {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/i);
  if (!match) throw new Error(`Not an nginx time value: ${value}`);
  const n = Number(match[1]);
  const unit = (match[2] ?? 's').toLowerCase();
  const scale: Record<string, number> = {
    ms: 0.001,
    s: 1,
    m: 60,
    h: 3600,
    d: 86_400,
  };
  return n * scale[unit]!;
}

describe('nginx.conf collab WebSocket upgrade', () => {
  it('declares a sibling location ^~ /api/collab/ with a longer prefix than /api/', () => {
    const prefixes = [...confSource.matchAll(/location\s+\^~\s+(\S+)\s*\{/g)].map(
      (m) => m[1]!,
    );
    expect(prefixes).toContain('/api/collab/');
    expect(prefixes).toContain('/api/');
    // nginx picks the longest matching `^~` prefix, regardless of source
    // order. `/api/collab/` has to be strictly longer than `/api/` or the
    // SSE location wins and Upgrade never happens.
    expect('/api/collab/'.startsWith('/api/')).toBe(true);
    expect('/api/collab/'.length).toBeGreaterThan('/api/'.length);
  });

  it('upgrades WebSockets on /api/collab/ with HTTP/1.1 and a ≥3600s idle timeout', () => {
    const lines = directiveLines(locationBlock('/api/collab/'));

    expect(directiveValue(lines, 'proxy_http_version')).toBe('1.1');
    expect(directiveValue(lines, 'proxy_set_header Upgrade')).toBe('$http_upgrade');
    expect(directiveValue(lines, 'proxy_set_header Connection')).toBe('"Upgrade"');
    expect(toSeconds(directiveValue(lines, 'proxy_read_timeout'))).toBeGreaterThanOrEqual(
      3600,
    );
    expect(toSeconds(directiveValue(lines, 'proxy_send_timeout'))).toBeGreaterThanOrEqual(
      3600,
    );
  });

  it('leaves the generic /api/ SSE 300s timeout without Upgrade', () => {
    // Changing the generic location to Upgrade (or stretching its timeout
    // to an hour) is out of scope: SSE keep-alive and collab idle are
    // different sockets.
    const lines = directiveLines(locationBlock('/api/'));
    expect(lines.some((line) => /^proxy_set_header\s+Upgrade\b/.test(line))).toBe(
      false,
    );
    expect(toSeconds(directiveValue(lines, 'proxy_read_timeout'))).toBe(300);
  });
});

describe('Vite /api proxy WebSocket upgrade', () => {
  it('sets ws: true on the /api proxy', () => {
    const apiMatch = viteConfigSource.match(/['"]\/api['"]:\s*\{([^}]+)\}/);
    expect(apiMatch, 'missing /api proxy entry').not.toBeNull();

    const lines = directiveLines(
      apiMatch![1]!.split('\n')
        .map((line) => line.replace(/\/\/.*$/, ''))
        .join('\n'),
    );
    expect(
      lines.some((line) => /^ws:\s*true\b/.test(line)),
      '/api proxy must set ws: true so npm run dev upgrades /api/collab/',
    ).toBe(true);
  });
});
