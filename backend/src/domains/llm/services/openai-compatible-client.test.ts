import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { checkHealth, listModels, chat, streamChat, type ProviderConfig } from './openai-compatible-client.js';

let srv: Server;
let baseUrl: string;

beforeAll(async () => {
  srv = createServer((req, res) => {
    if (req.url === '/v1/models' && req.headers.authorization === 'Bearer sekret') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'm1' }, { id: 'm2' }] }));
      return;
    }
    if (req.url === '/v1/models') { res.writeHead(401); res.end(); return; }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => srv.listen(0, r));
  const { port } = srv.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/v1`;
});

afterAll(() => new Promise<void>((r) => srv.close(() => r())));

const cfg: ProviderConfig = {
  providerId: 'id1', baseUrl: '', apiKey: 'sekret', authType: 'bearer', verifySsl: true,
};

describe('openai-compatible-client', () => {
  it('listModels returns models from /v1/models', async () => {
    const r = await listModels({ ...cfg, baseUrl });
    expect(r.map(m => m.name)).toEqual(['m1', 'm2']);
  });
  it('checkHealth returns connected:true when endpoint is reachable', async () => {
    const r = await checkHealth({ ...cfg, baseUrl });
    expect(r.connected).toBe(true);
  });
  it('checkHealth returns connected:false on 401', async () => {
    const r = await checkHealth({ ...cfg, baseUrl, apiKey: null });
    expect(r.connected).toBe(false);
  });
});

describe('openai-compatible-client — chat', () => {
  let chatSrv: Server;
  let chatBase: string;
  beforeAll(async () => {
    chatSrv = createServer((req, res) => {
      if (req.url === '/v1/chat/completions') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          const parsed = JSON.parse(body);
          if (parsed.stream) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'hel' } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'lo' } }] }) + '\n\n');
            res.write('data: [DONE]\n\n');
            res.end();
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { content: 'hello' } }] }));
          }
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    await new Promise<void>((r) => chatSrv.listen(0, r));
    const { port } = chatSrv.address() as AddressInfo;
    chatBase = `http://127.0.0.1:${port}/v1`;
  });
  afterAll(() => new Promise<void>((r) => chatSrv.close(() => r())));

  it('chat returns assistant content', async () => {
    const r = await chat({ ...cfg, baseUrl: chatBase }, 'm1', [{ role: 'user', content: 'hi' }]);
    expect(r).toBe('hello');
  });

  it('streamChat yields chunks then done', async () => {
    const out: string[] = [];
    let done = false;
    for await (const c of streamChat({ ...cfg, baseUrl: chatBase }, 'm1', [{ role: 'user', content: 'hi' }])) {
      out.push(c.content); if (c.done) done = true;
    }
    expect(out.filter(Boolean).join('')).toBe('hello');
    expect(done).toBe(true);
  });
});
