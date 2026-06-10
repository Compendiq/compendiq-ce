#!/usr/bin/env node
/**
 * Build guard: verify that the CSP script-src hash in
 * nginx-security-headers.conf matches the inline FOUC-prevention script in
 * index.html.
 *
 * The hash is hand-maintained in the nginx conf; if the inline script changes
 * without a hash update, browsers silently refuse to run it in production
 * (no FOUC protection, no console hint). This script fails the build instead.
 *
 * CSP hashes cover the EXACT bytes between <script> and </script> — no
 * trimming or normalization. Wired as the `prebuild` npm script.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const frontendDir = dirname(dirname(fileURLToPath(import.meta.url)));
const indexHtmlPath = resolve(frontendDir, 'index.html');
const nginxConfPath = resolve(frontendDir, 'nginx-security-headers.conf');

const html = readFileSync(indexHtmlPath, 'utf8');

// First inline <script> (no src attribute) — the FOUC-prevention theme script.
const inlineScript = /<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/.exec(html);
if (!inlineScript) {
  console.error(`ERROR: no inline <script> found in ${indexHtmlPath}`);
  process.exit(1);
}

const expected = `sha256-${createHash('sha256').update(inlineScript[1], 'utf8').digest('base64')}`;

// Drop nginx comment lines so "script-src" in prose doesn't shadow the directive.
const conf = readFileSync(nginxConfPath, 'utf8')
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('#'))
  .join('\n');
const scriptSrc = /script-src[^;]*/.exec(conf);
if (!scriptSrc) {
  console.error(`ERROR: no script-src directive found in ${nginxConfPath}`);
  process.exit(1);
}

const found = /'(sha256-[A-Za-z0-9+/=]+)'/.exec(scriptSrc[0]);
if (!found) {
  console.error(`ERROR: no 'sha256-...' token in the script-src directive of ${nginxConfPath}`);
  process.exit(1);
}

if (found[1] !== expected) {
  console.error('ERROR: CSP script-src hash is stale — the inline script in index.html changed.');
  console.error(`  expected (computed from index.html): '${expected}'`);
  console.error(`  found (nginx-security-headers.conf): '${found[1]}'`);
  console.error(`Update the hash in ${nginxConfPath} to the expected value.`);
  process.exit(1);
}

console.log(`OK: CSP script-src hash matches index.html inline script ('${expected}')`);
