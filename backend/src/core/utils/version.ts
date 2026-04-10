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

// Build metadata (edition, commit, builtAt). Written by the build pipeline
// to <repo root>/build-info.json. EE builds overwrite the committed CE
// placeholder with real git commit hashes via scripts/build-enterprise.sh.
// The runtime image copies this file so we can read it here.
export interface AppBuildInfo {
  edition: string;
  commit: string;
  builtAt: string;
}

const DEFAULT_BUILD_INFO: AppBuildInfo = {
  edition: 'community',
  commit: 'unknown',
  builtAt: '',
};

function loadBuildInfo(): AppBuildInfo {
  const candidates = [
    resolve(__dirname, '../../../../build-info.json'),  // dev (monorepo root)
    resolve(__dirname, '../../../build-info.json'),     // Docker (/app/build-info.json)
  ];
  for (const p of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf-8')) as Partial<AppBuildInfo>;
      return {
        edition: parsed.edition ?? DEFAULT_BUILD_INFO.edition,
        commit: parsed.commit ?? DEFAULT_BUILD_INFO.commit,
        builtAt: parsed.builtAt ?? DEFAULT_BUILD_INFO.builtAt,
      };
    } catch {
      // try next candidate
    }
  }
  return DEFAULT_BUILD_INFO;
}

export const APP_VERSION: string = loadVersion();
export const APP_BUILD_INFO: AppBuildInfo = loadBuildInfo();
