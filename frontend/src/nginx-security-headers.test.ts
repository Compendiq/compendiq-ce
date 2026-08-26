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

function cspValue(): string {
  const match = directives
    .join('\n')
    .match(/add_header\s+Content-Security-Policy\s+"([^"]*)"/i);
  expect(match).not.toBeNull();
  return match![1];
}

function cspDirective(name: string): string | undefined {
  const parts = cspValue().split(';').map((part) => part.trim()).filter(Boolean);
  const found = parts.find((part) => part.startsWith(`${name} `) || part === name);
  return found;
}

describe('CSP grant for client inference (#1418 SPEC-008)', () => {
  it("adds 'wasm-unsafe-eval' to script-src without granting 'unsafe-eval'", () => {
    const scriptSrc = cspDirective('script-src');
    expect(scriptSrc).toBeDefined();
    expect(scriptSrc).toContain("'wasm-unsafe-eval'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
    expect(scriptSrc).not.toMatch(/(?:^|\s)'unsafe-eval'(?:\s|$)/);
  });

  it("declares worker-src 'self' and no blob: or remote worker hosts", () => {
    const workerSrc = cspDirective('worker-src');
    expect(workerSrc).toBe("worker-src 'self'");
  });

  it("keeps connect-src 'self' only — no Hugging Face, jsDelivr, or Unsloth hosts", () => {
    const connectSrc = cspDirective('connect-src');
    expect(connectSrc).toBe("connect-src 'self'");
    expect(cspValue()).not.toMatch(/huggingface|hf\.co|jsdelivr|unsloth/i);
  });

  it("does not add data: or blob: to script-src", () => {
    const scriptSrc = cspDirective('script-src')!;
    expect(scriptSrc).not.toMatch(/\bdata:/);
    expect(scriptSrc).not.toMatch(/\bblob:/);
  });
});

describe('LlmUsecaseSchema stays free of a client_inference use case (#1418 SPEC-010)', () => {
  it('rejects client_inference and does not list it', async () => {
    const { LlmUsecaseSchema } = await import('@compendiq/contracts');
    expect(LlmUsecaseSchema.options).not.toContain('client_inference');
    expect(() => LlmUsecaseSchema.parse('client_inference')).toThrow();
  });
});

describe('Editor preferences shells (#1418 SPEC-041/043)', () => {
  it('names on-device suggestions, the unassigned-server control, Pre-download, and spellcheck in source', () => {
    const editorSource = readFileSync(
      resolve(__dirname, 'features/settings/EditorPreferencesTab.tsx'),
      'utf-8',
    );
    expect(editorSource).toContain('On-device suggestions (WebGPU)');
    expect(editorSource).toContain('Use on-device suggestions when no server model is assigned');
    expect(editorSource).toContain('Pre-download on-device model');
    expect(editorSource).toContain('Spellcheck');
    expect(editorSource).toContain(
      'Falls back to the server model when the on-device model is not ready.',
    );
    expect(editorSource).toContain(
      'English and German. A word is flagged only if every enabled language rejects it.',
    );
    expect(editorSource).not.toMatch(/350 MB/);
    expect(editorSource).not.toMatch(/huggingface/i);
  });
});
