import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  AI_POLICY_CLIENT_PROTOCOL_HEADER,
  AI_POLICY_CLIENT_PROTOCOL_VERSION,
  CLIENT_RELOAD_REQUIRED,
} from '@compendiq/contracts';
import { isClientReloadRequired, withClientProtocol } from './client-protocol';

/**
 * The legacy-client marker (#1881, design §2.3).
 *
 * The first half pins the helper. The second half is the enumeration guard
 * the design requires: every `fetch(` under `frontend/src` whose URL is a
 * session-issuing route (`/api/auth/*`, `/api/setup/admin`) must build its
 * headers through `withClientProtocol`. A raw fetch that misses the marker
 * is a bundle the backend will refuse once enforcement is on — the SSO
 * lockout the round-1 review found — so this walks the source and fails on
 * the file and line that introduced it.
 */

describe('withClientProtocol', () => {
  it('adds the protocol header with the current version', () => {
    const headers = withClientProtocol();
    expect(headers.get(AI_POLICY_CLIENT_PROTOCOL_HEADER)).toBe(String(AI_POLICY_CLIENT_PROTOCOL_VERSION));
  });

  it('keeps the headers it was given, whatever their shape', () => {
    const fromObject = withClientProtocol({ 'Content-Type': 'application/json' });
    expect(fromObject.get('Content-Type')).toBe('application/json');
    expect(fromObject.get(AI_POLICY_CLIENT_PROTOCOL_HEADER)).toBe('1');

    const fromHeaders = withClientProtocol(new Headers({ Authorization: 'Bearer t' }));
    expect(fromHeaders.get('Authorization')).toBe('Bearer t');
    expect(fromHeaders.get(AI_POLICY_CLIENT_PROTOCOL_HEADER)).toBe('1');

    const fromEntries = withClientProtocol([['Accept', 'text/event-stream']]);
    expect(fromEntries.get('Accept')).toBe('text/event-stream');
    expect(fromEntries.get(AI_POLICY_CLIENT_PROTOCOL_HEADER)).toBe('1');
  });

  it('returns a Headers instance the caller can keep writing to', () => {
    const headers = withClientProtocol();
    headers.set('Authorization', 'Bearer t');
    expect(headers.get('Authorization')).toBe('Bearer t');
    expect(headers.get(AI_POLICY_CLIENT_PROTOCOL_HEADER)).toBe('1');
  });
});

describe('isClientReloadRequired', () => {
  it('recognises the backend refusal body, with or without a message', () => {
    expect(isClientReloadRequired({ error: CLIENT_RELOAD_REQUIRED })).toBe(true);
    expect(isClientReloadRequired({ error: CLIENT_RELOAD_REQUIRED, message: 'Reload' })).toBe(true);
  });

  it('rejects every other body', () => {
    expect(isClientReloadRequired(null)).toBe(false);
    expect(isClientReloadRequired(undefined)).toBe(false);
    expect(isClientReloadRequired('client_reload_required')).toBe(false);
    expect(isClientReloadRequired({ error: 'ai_policy_activation_refused' })).toBe(false);
    expect(isClientReloadRequired({ code: CLIENT_RELOAD_REQUIRED })).toBe(false);
  });
});

// ── Enumeration guard ──────────────────────────────────────────────────────

const SRC = join(import.meta.dirname, '..', '..');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * The text of one call expression starting at the `(` after `fetch`,
 * balanced on parentheses while skipping string and template (including
 * `${…}`) contents. Good enough for this codebase's call sites; a call it
 * cannot balance is reported rather than skipped.
 */
function callText(source: string, start: number): string | null {
  let depth = 0;
  let i = start;
  const quoteStack: string[] = [];
  while (i < source.length) {
    const ch = source[i]!;
    const quote = quoteStack[quoteStack.length - 1];
    if (quote === undefined) {
      if (ch === '\'' || ch === '"' || ch === '`') {
        quoteStack.push(ch);
      } else if (ch === '(') {
        depth += 1;
      } else if (ch === ')') {
        depth -= 1;
        if (depth === 0) return source.slice(start, i + 1);
      }
    } else if (quote === '${') {
      if (ch === '}') quoteStack.pop();
      else if (ch === '\'' || ch === '"' || ch === '`') quoteStack.push(ch);
    } else {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === quote) quoteStack.pop();
      else if (quote === '`' && ch === '$' && source[i + 1] === '{') {
        quoteStack.push('${');
        i += 1;
      }
    }
    i += 1;
  }
  return null;
}

interface FetchSite {
  file: string;
  line: number;
  call: string;
}

/**
 * Every `fetch(` call (not `apiFetch(`, `refetch(` …) under the source tree.
 * A match on a comment line (`// …` before it, or a `*`-led JSDoc line) is
 * prose about a fetch, not one, and is skipped.
 */
function fetchSites(): FetchSite[] {
  const sites: FetchSite[] = [];
  for (const file of walk(SRC)) {
    const source = readFileSync(file, 'utf-8');
    const pattern = /(?<![\w.$])fetch\(/g;
    for (const match of source.matchAll(pattern)) {
      const lineStart = source.lastIndexOf('\n', match.index) + 1;
      const linePrefix = source.slice(lineStart, match.index);
      if (/^\s*\*|\/\//.test(linePrefix)) continue;
      const call = callText(source, match.index + 'fetch'.length);
      sites.push({
        file: relative(SRC, file),
        line: source.slice(0, match.index).split('\n').length,
        call: call ?? '<unbalanced call>',
      });
    }
  }
  return sites;
}

/** A URL argument that reaches a session-issuing route the backend inspects. */
const SESSION_ROUTE = /\/auth\/|\/setup\/admin/;

describe('legacy-client marker coverage (#1881)', () => {
  const sites = fetchSites();
  const covered = sites.filter((site) => SESSION_ROUTE.test(site.call));

  it('finds the session-issuing fetch sites this design names', () => {
    const files = new Set(covered.map((site) => site.file));
    expect(files).toEqual(new Set([
      'shared/lib/api.ts',
      'features/auth/OidcCallbackPage.tsx',
      'features/setup/steps/AdminStep.tsx',
    ]));
    // refresh and logout in api.ts, the OIDC exchange, setup-admin. The
    // GET /api/auth/oidc/callback is a browser navigation that sets the
    // cookie and cannot carry a header; it is deliberately not covered (the
    // exchange that follows it is). Do not "fix" it by adding the marker.
    expect(covered).toHaveLength(4);
  });

  it('builds every one of their header sets through withClientProtocol', () => {
    const offences = covered.filter((site) => !site.call.includes('withClientProtocol('));
    expect(
      offences.map((site) => `  ${site.file}:${site.line}  ${site.call.replace(/\s+/g, ' ').slice(0, 120)}`).join('\n'),
    ).toBe('');
  });

  it('marks the generic apiFetch request, which carries /auth/login and /auth/register', () => {
    const api = readFileSync(join(SRC, 'shared', 'lib', 'api.ts'), 'utf-8');
    expect(api).toMatch(/const headers = withClientProtocol\(options\.headers\);/);
    // And nothing posts credentials around apiFetch: the login page and the
    // registration policy probe go through it.
    const loginPage = readFileSync(join(SRC, 'features', 'settings', 'LoginPage.tsx'), 'utf-8');
    expect(loginPage).toMatch(/apiFetch<[^>]*>\(endpoint/);
    expect(loginPage).not.toMatch(/(?<![\w.$])fetch\(/);
  });

  it('balances every fetch call it scanned, so no site escapes the guard', () => {
    const unbalanced = sites.filter((site) => site.call === '<unbalanced call>');
    expect(unbalanced.map((site) => `${site.file}:${site.line}`)).toEqual([]);
    expect(sites.length).toBeGreaterThan(covered.length);
  });
});
