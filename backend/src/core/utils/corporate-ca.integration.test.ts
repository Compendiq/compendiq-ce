import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { request, type Dispatcher } from 'undici';

const execFileAsync = promisify(execFile);

describe('private CA trust', () => {
  let dir: string;
  let server: Server;
  let port: number;
  const dispatchers: Dispatcher[] = [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'compendiq-ca-'));
    const openssl = (...args: string[]) => execFileSync('openssl', args, { stdio: 'ignore' });
    openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'ca.key'), '-out', join(dir, 'ca.pem'), '-days', '1', '-subj', '/CN=Disposable Test CA');
    openssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'server.key'), '-out', join(dir, 'server.csr'), '-subj', '/CN=localhost');
    writeFileSync(join(dir, 'ext.cnf'), 'subjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\n');
    openssl('x509', '-req', '-in', join(dir, 'server.csr'), '-CA', join(dir, 'ca.pem'), '-CAkey', join(dir, 'ca.key'), '-CAcreateserial', '-out', join(dir, 'server.pem'), '-days', '1', '-extfile', join(dir, 'ext.cnf'));
    server = createServer({ key: readFileSync(join(dir, 'server.key')), cert: readFileSync(join(dir, 'server.pem')) }, (req, res) => {
      if (req.url?.includes('/models')) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: [{ id: 'fixture-model' }] }));
      } else {
        res.end('trusted');
      }
    });
    const listening = Promise.withResolvers<void>();
    server.listen(0, listening.resolve);
    await listening.promise;
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    port = address.port;
  });

  afterAll(async () => {
    await Promise.all(dispatchers.map((dispatcher) => dispatcher.close()));
    const closed = Promise.withResolvers<void>();
    server.close((error) => error ? closed.reject(error) : closed.resolve());
    await closed.promise;
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('rejects an unknown CA, trusts it only when opted in, and rejects a hostname mismatch', async () => {
    vi.stubEnv('CONFLUENCE_VERIFY_SSL', 'true');
    vi.stubEnv('LLM_VERIFY_SSL', 'true');
    vi.stubEnv('NODE_EXTRA_CA_CERTS', '');
    vi.resetModules();
    const before = await import('./tls-config.js');
    // Each dynamic import captures the environment at module initialization.
    dispatchers.push(before.confluenceDispatcher);
    await expect(request(`https://localhost:${port}`, { dispatcher: before.confluenceDispatcher })).rejects.toThrow();

    vi.stubEnv('NODE_EXTRA_CA_CERTS', join(dir, 'ca.pem'));
    vi.resetModules();
    const tls = await import('./tls-config.js');
    const llm = await import('./llm-config.js');
    const general = tls.createTlsDispatcher();
    if (!llm.llmDispatcher) throw new Error('Expected LLM dispatcher');
    dispatchers.push(tls.confluenceDispatcher, general, llm.llmDispatcher);
    for (const dispatcher of [tls.confluenceDispatcher, general, llm.llmDispatcher]) {
      const response = await request(`https://localhost:${port}`, { dispatcher });
      expect(await response.body.text()).toBe('trusted');
      await expect(request(`https://127.0.0.1:${port}`, { dispatcher })).rejects.toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
    }
  });

  it('uses Node startup trust for verified OpenAI-compatible providers', async () => {
    // Node reads NODE_EXTRA_CA_CERTS at process startup, so each case needs a
    // fresh process rather than a dynamically imported module in this runner.
    const providerModule = new URL('../../domains/llm/services/openai-compatible-client.ts', import.meta.url).href;
    const script = `
      const { listModels } = await import(process.argv[1]);
      try {
        const models = await listModels({ providerId: 'fixture', baseUrl: process.argv[2], apiKey: null, authType: 'none', verifySsl: true });
        console.log(JSON.stringify({ models }));
      } catch (error) {
        console.log(JSON.stringify({ code: error.cause?.code ?? error.code }));
      }
      process.exit(0);
    `;
    const run = async (host: string, ca?: string) => {
      const env: NodeJS.ProcessEnv = { ...process.env, LOG_LEVEL: 'silent' };
      delete env.NODE_EXTRA_CA_CERTS;
      delete env.NODE_TLS_REJECT_UNAUTHORIZED;
      delete env.NODE_OPTIONS;
      if (ca) env.NODE_EXTRA_CA_CERTS = ca;
      const { stdout } = await execFileAsync(process.execPath, [
        '--import', 'tsx', '--input-type=module', '-e', script,
        providerModule, `https://${host}:${port}/v1`,
      ], { env, timeout: 15_000 });
      return JSON.parse(stdout.trim()) as { code?: string; models?: Array<{ name: string }> };
    };
    expect(await run('localhost')).toEqual({ code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' });
    expect(await run('localhost', join(dir, 'ca.pem'))).toEqual({ models: [{ name: 'fixture-model' }] });
    expect(await run('127.0.0.1', join(dir, 'ca.pem'))).toEqual({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
  });
});
