import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dockerfile = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../../Dockerfile'),
  'utf8',
);

describe('backend Dockerfile (#1420)', () => {
  it('installs postgresql17-client in the runtime stage', () => {
    const runtime = dockerfile.split('AS runtime')[1] ?? '';
    expect(runtime).toMatch(/apk add --no-cache postgresql17-client/);
    expect(runtime.indexOf('apk add --no-cache postgresql17-client')).toBeLessThan(
      runtime.indexOf('USER node'),
    );
  });
});
