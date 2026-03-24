import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve version from package.json.
// In dev: ../../../../package.json reaches the monorepo root.
// In Docker: the backend's own package.json is at /app/package.json (2 levels up from dist/core/utils/).
// Both carry the same version string, so try the monorepo root first, fall back to the closer one.
function loadVersion(): string {
  const candidates = [
    resolve(__dirname, '../../../../package.json'),  // dev (monorepo root)
    resolve(__dirname, '../../../package.json'),      // Docker (/app/package.json from dist/core/utils/)
  ];
  for (const p of candidates) {
    try {
      return JSON.parse(readFileSync(p, 'utf-8')).version;
    } catch {
      // try next candidate
    }
  }
  return '0.0.0';
}

export const APP_VERSION: string = loadVersion();
