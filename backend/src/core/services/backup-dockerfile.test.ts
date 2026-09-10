import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dockerfile = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../../Dockerfile'),
  'utf8',
);
const enterpriseDockerfile = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../../../docker/Dockerfile.enterprise'),
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

  it('provisions a PostgreSQL 17 client in the enterprise runtime stage', () => {
    // Asserted as a property ("a postgresql 17 client is provisioned before the
    // runtime drops privileges"), not as a mechanism ("apk add"). The EE overlay
    // ships its own docker/Dockerfile.enterprise, so in a merged EE tree this
    // reads that file — and it is built on Docker Hardened Images (Debian,
    // distroless final stage), where the package manager is apt and the client
    // package is named postgresql-client-17. Pinning the Alpine spelling failed
    // the whole enterprise build over the base image's package manager rather
    // than over the invariant #1420 protects. Same lesson as issue #930 in
    // docker-compose-invariants.test.ts.
    //
    // The check stays strict about the major version: pg_dump refuses to dump a
    // server newer than itself, and both editions run pgvector/pgvector:pg17.
    const runtime = enterpriseDockerfile.split('AS runtime')[1] ?? '';
    const provisioners = [
      /apk add [^\n]*\bpostgresql17-client\b/, // Alpine
      /apt-get install [^\n]*\bpostgresql-client-17\b/, // Debian / DHI
    ];

    const match = provisioners
      .map((pattern) => runtime.match(pattern))
      .find((result) => result !== null);

    expect(
      match,
      'enterprise runtime stage installs no postgresql 17 client — pg_dump/pg_restore ' +
        'would be missing from the image and backup export + restore would fail at runtime',
    ).not.toBeUndefined();

    // Ordering: the install needs root, so it must precede the drop to `node`.
    const dropsPrivileges = runtime.indexOf('USER node');
    expect(dropsPrivileges, 'enterprise runtime stage never drops to USER node').toBeGreaterThan(
      -1,
    );
    expect(match?.index).toBeLessThan(dropsPrivileges);
  });
});
