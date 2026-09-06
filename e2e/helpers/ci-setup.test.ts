import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FullConfig } from '@playwright/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ciSetup from './ci-setup';

let server: Server | undefined;

beforeEach(() => {
  vi.stubEnv('E2E_CI', '1');
  vi.stubEnv('POSTGRES_URL', 'postgresql://ci:ci@127.0.0.1:5433/kb_e2e');
  vi.stubEnv('COLLAB_E2E_ADMIN', 'ci_admin');
  vi.stubEnv('COLLAB_E2E_PASSWORD', 'TestPassword123!');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    server = undefined;
  }
});

async function statusServer(status: unknown, creationStatus = 409) {
  const mutations: string[] = [];
  server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && req.url === '/api/health/setup-status') {
      res.end(JSON.stringify(status));
      return;
    }
    mutations.push(`${req.method} ${req.url}`);
    res.statusCode = creationStatus;
    res.end(JSON.stringify({ message: 'Instance cannot be provisioned' }));
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vi.stubEnv('E2E_BASE_URL', baseURL);
  const config = { projects: [{ use: { baseURL } }] } as FullConfig;
  return { config, mutations };
}

describe('CI setup mutation boundary', () => {
  it.each([
    { setupComplete: true, steps: { admin: true } },
    { setupComplete: false },
  ])('refuses existing or unrecognized instances before any write (%j)', async status => {
    const { config, mutations } = await statusServer(status);
    await expect(ciSetup(config)).rejects.toThrow(/already provisioned|invalid setup status/);
    expect(mutations).toEqual([]);
  });

  it('does not log in or update settings if another admin wins the creation race', async () => {
    const { config, mutations } = await statusServer({ setupComplete: false, steps: { admin: false } });
    await expect(ciSetup(config)).rejects.toThrow(/HTTP 409/);
    expect(mutations).toEqual(['POST /api/setup/admin']);
  });

  it('refuses to modify a non-disposable database even on loopback', async () => {
    const { config, mutations } = await statusServer({ setupComplete: false, steps: { admin: false } });
    vi.stubEnv('POSTGRES_URL', 'postgresql://ci:ci@127.0.0.1:5433/compendiq');
    await expect(ciSetup(config)).rejects.toThrow(/disposable/);
    expect(mutations).toEqual([]);
  });

  it('refuses a remote application origin before making requests', async () => {
    const baseURL = 'https://compendiq.example.com';
    vi.stubEnv('E2E_BASE_URL', baseURL);
    const config = { projects: [{ use: { baseURL } }] } as FullConfig;
    await expect(ciSetup(config)).rejects.toThrow(/loopback/);
  });
});
