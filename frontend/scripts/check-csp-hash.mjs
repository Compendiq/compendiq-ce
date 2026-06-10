#!/usr/bin/env node
/**
 * Build guard: verify that the CSP script-src hashes in
 * nginx-security-headers.conf match the inline <script> blocks in index.html
 * (currently only the FOUC-prevention theme script).
 *
 * The hashes are hand-maintained in the nginx conf; if an inline script
 * changes without a hash update, browsers silently refuse to run it in
 * production (no FOUC protection, no console hint). This script fails the
 * build instead. It checks both directions: every inline script must have a
 * matching hash in the conf, and the conf must carry no orphan (stale)
 * hashes.
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

// All inline <script> blocks (no src attribute).
const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/g)].map(
  (m) => m[1],
);
if (inlineScripts.length === 0) {
  console.error(`ERROR: no inline <script> found in ${indexHtmlPath}`);
  process.exit(1);
}

const expectedHashes = inlineScripts.map(
  (body) => `sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}`,
);

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

const confHashes = [...scriptSrc[0].matchAll(/'(sha256-[A-Za-z0-9+/=]+)'/g)].map((m) => m[1]);
if (confHashes.length === 0) {
  console.error(`ERROR: no 'sha256-...' token in the script-src directive of ${nginxConfPath}`);
  process.exit(1);
}

let failed = false;

// Every inline script needs a hash in the conf.
expectedHashes.forEach((hash, i) => {
  if (!confHashes.includes(hash)) {
    failed = true;
    const preview = inlineScripts[i].trim().split('\n')[0].slice(0, 70);
    console.error(
      `ERROR: inline script #${i + 1} in index.html (starts: ${JSON.stringify(preview)}) has no matching CSP hash.`,
    );
    console.error(`  expected in script-src: '${hash}'`);
  }
});

// Every conf hash must correspond to an inline script (no stale leftovers).
const orphans = confHashes.filter((hash) => !expectedHashes.includes(hash));
if (orphans.length > 0) {
  failed = true;
  console.error(
    `ERROR: script-src in ${nginxConfPath} contains hash(es) matching no inline script in index.html (stale): ${orphans
      .map((h) => `'${h}'`)
      .join(', ')}`,
  );
}

if (failed) {
  console.error(`Update the 'sha256-...' token(s) in ${nginxConfPath} to match index.html.`);
  process.exit(1);
}

console.log(
  `OK: ${inlineScripts.length} inline script hash(es) in index.html match script-src in nginx-security-headers.conf`,
);
