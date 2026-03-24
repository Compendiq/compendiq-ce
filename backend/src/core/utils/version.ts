import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Read version from root package.json (single source of truth)
const rootPkg = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../package.json'), 'utf-8'),
);

export const APP_VERSION: string = rootPkg.version;
