import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  INLINE_COMPLETION_STOP,
  normalizeInlineCompletion,
  requestInlineCompletion,
  supportsFim,
} from './inline-completion-client.js';
import type { ProviderConfig } from './openai-compatible-client.js';

let server: Server;
let baseUrl: string;
let lastPath = '';
let lastBody: Record<string, unknown> = {};
let responder: (res: import('node:http').ServerResponse) => void = () => {};

beforeAll(async () => {
  server = createServer((req, res) => {
    lastPath = req.url ?? '';
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      lastBody = JSON.parse(raw) as Record<string, unknown>;
      responder(res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function cfg(): ProviderConfig {
  return {
    providerId: `inline-${Math.random().toString(36).slice(2)}`,
    baseUrl,
    apiKey: null,
    authType: 'none',
    verifySsl: true,
  };
}

function json(value: unknown) {
  responder = (res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(value));
  };
}

describe('inline-completion-client (#1417)', () => {
  it.each([
    'Qwen2.5-Coder-7B',
    'Qwen/Qwen2.5-Coder-7B-Instruct',
    'deepseek-ai/deepseek-coder-v2',
    'starcoder2',
    'Codestral-22B',
  ])('%s uses FIM', (model) => {
    expect(supportsFim(model)).toBe(true);
  });

  it('uses raw FIM for code models with the bounded stop/token contract', async () => {
    json({ choices: [{ text: 'token before expiry.\nSecond line' }], usage: { prompt_tokens: 9, completion_tokens: 4 } });
    const result = await requestInlineCompletion(cfg(), 'qwen2.5-coder:7b', {
      prefix: 'Rotate the ', suffix: ' every 90 days.', maxTokens: 48,
    }, new AbortController().signal);

    expect(lastPath).toBe('/v1/completions');
    expect(lastBody).toMatchObject({
      prompt: '<PRE>Rotate the <SUF> every 90 days.<MID>',
      max_tokens: 48,
      stop: [...INLINE_COMPLETION_STOP],
      stream: false,
    });
    expect(result).toEqual({
      completion: 'token before expiry.',
      strategy: 'fim',
      usage: { promptTokens: 9, completionTokens: 4 },
    });
  });

  it('uses non-thinking instructional chat for standard endpoints and includes metadata', async () => {
    json({ choices: [{ message: { content: ' access token.' } }] });
    const result = await requestInlineCompletion(cfg(), 'gpt-5-mini', {
      pageId: 42,
      spaceKey: 'OPS',
      title: 'PAT rotation',
      language: 'en',
      prefix: 'Rotate the',
      suffix: 'before expiry',
      maxTokens: 32,
    }, new AbortController().signal);

    expect(lastPath).toBe('/v1/chat/completions');
    expect(lastBody).toMatchObject({
      model: 'gpt-5-mini',
      max_tokens: 32,
      stop: [...INLINE_COMPLETION_STOP],
      think: false,
      chat_template_kwargs: { enable_thinking: false },
    });
    expect(JSON.stringify(lastBody)).toContain('Title: PAT rotation');
    expect(JSON.stringify(lastBody)).toContain('<PREFIX>');
    expect(result.completion).toBe(' access token.');
  });

  it('propagates abort directly to the provider request', async () => {
    responder = (res) => {
      setTimeout(() => res.end(JSON.stringify({ choices: [{ text: 'late' }] })), 5_000).unref();
    };
    const controller = new AbortController();
    const pending = requestInlineCompletion(cfg(), 'starcoder2', { prefix: 'x', maxTokens: 48 }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow();
  });

  it('bounds a provider that never responds even if the caller stays connected', async () => {
    responder = () => {};
    const pending = requestInlineCompletion(
      cfg(),
      'starcoder2',
      { prefix: 'x', maxTokens: 48 },
      new AbortController().signal,
      { timeoutMs: 50 },
    );

    await expect(pending).rejects.toThrow();
  });

  it('keeps indentation but strips extra lines, fences, and FIM markers', () => {
    expect(normalizeInlineCompletion('  next();\nmore')).toBe('  next();');
    expect(normalizeInlineCompletion('value```ts')).toBe('value');
    expect(normalizeInlineCompletion('<MID>rest')).toBe('rest');
  });
});
