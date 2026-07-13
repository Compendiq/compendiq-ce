import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Content invariants for the nginx edge security-headers snippet (#1053).
 *
 * nginx is the single authoritative source for the browser-facing security
 * headers it owns (the backend is never host-published and disables the same
 * headers in @fastify/helmet). Because nginx `add_header` APPENDS rather than
 * replaces, any header declared twice here — or also emitted by the backend —
 * reaches the client duplicated. These tests pin the snippet so each header is
 * declared exactly once and the deprecated X-XSS-Protection stays gone.
 */

const confPath = resolve(__dirname, '..', 'nginx-security-headers.conf');
const confSource = readFileSync(confPath, 'utf-8');

// Directive lines only — drop `#` comment lines so prose mentioning a header
// name (e.g. "X-XSS-Protection is intentionally NOT set") can't be mistaken
// for a directive.
const directives = confSource
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith('#'));

/** Count of `add_header <name>` directives (case-insensitive header name). */
function addHeaderCount(headerName: string): number {
  const re = new RegExp(`^add_header\\s+${headerName}\\b`, 'i');
  return directives.filter((line) => re.test(line)).length;
}

describe('nginx-security-headers.conf edge header invariants', () => {
  it('does not emit the deprecated X-XSS-Protection header', () => {
    expect(/add_header\s+X-XSS-Protection/i.test(confSource)).toBe(false);
  });

  it('declares exactly one Permissions-Policy directive with a locked-down value', () => {
    expect(addHeaderCount('Permissions-Policy')).toBe(1);

    const match = confSource.match(/add_header\s+Permissions-Policy\s+"([^"]*)"/i);
    expect(match).not.toBeNull();
    const value = match![1];
    expect(value.length).toBeGreaterThan(0);
    // Powerful capabilities denied; fullscreen granted to self so the
    // self-hosted draw.io editor iframe still works.
    expect(value).toContain('camera=()');
    expect(value).toContain('fullscreen=(self)');
  });

  it.each([
    'X-Frame-Options',
    'X-Content-Type-Options',
    'Referrer-Policy',
    'Content-Security-Policy',
    'Permissions-Policy',
  ])('declares %s exactly once (no duplicate that nginx would append)', (headerName) => {
    expect(addHeaderCount(headerName)).toBe(1);
  });
});
