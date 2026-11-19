import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  INLINE_COMPLETION_STOP,
  normalizeInlineCompletion,
  requestInlineCompletion as sendInlineCompletion,
  supportsFim,
} from './inline-completion-client.js';
import type { ProviderConfig } from './openai-compatible-client.js';
import { getProviderBreaker } from '../../../core/services/circuit-breaker.js';

import { setupTestDb, teardownTestDb, truncateAllTables } from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';
import { newAiOperation } from '../../../core/enterprise/ai-policy-hooks.js';
import type { InlineCompletionRequest } from '@compendiq/contracts';

async function requestInlineCompletion(config: ProviderConfig, model: string, input: InlineCompletionRequest,
  signal: AbortSignal, options: { timeoutMs?: number } = {}) {
  const user = (await query("INSERT INTO users (username, password_hash, role) VALUES ('inline', 'x', 'user') RETURNING id")).rows[0];
  const page = (await query("INSERT INTO pages (title, source, visibility, owner_id, created_by_user_id) VALUES ('Inline', 'standalone', 'private', $1, $1) RETURNING id", [user.id])).rows[0];
  const provider = (await query("INSERT INTO llm_providers (name, base_url, auth_type) VALUES ('Inline', $1, 'none') RETURNING id, config_revision", [config.baseUrl])).rows[0];
  config.providerId = provider.id;
  config.configRevision = Number(provider.config_revision);
  await query("INSERT INTO llm_usecase_assignments (usecase, provider_id, model) VALUES ('inline_completion', $1, $2)", [provider.id, model]);
  const current = (await query('SELECT ai_policy_revision, content_revision FROM pages WHERE id = $1', [page.id])).rows[0];
  return sendInlineCompletion(config, model, { ...input, pageId: page.id }, signal, { ...options, stage: {
    userId: user.id, usecase: 'inline_completion',
    provenance: { version: 1, providerId: provider.id, configRevision: config.configRevision!, locality: 'external',
      pages: [{ pageId: page.id, policy: 'all', policyRevision: Number(current.ai_policy_revision), contentRevision: Number(current.content_revision) }] },
    context: { operation: newAiOperation('inline', { kind: 'user', id: user.id }), stage: 'inline_completion', attempt: 1 },
  } });
}

let server: Server;
let baseUrl: string;
let lastPath = '';
let lastBody: Record<string, unknown> = {};
let requestBodies: Array<Record<string, unknown>> = [];
let responder: (res: import('node:http').ServerResponse) => void = () => {};

beforeAll(async () => {
  await setupTestDb();
  server = createServer((req, res) => {
    lastPath = req.url ?? '';
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      lastBody = JSON.parse(raw) as Record<string, unknown>;
      requestBodies.push(lastBody);
      responder(res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await teardownTestDb();
});

beforeEach(async () => {
  await truncateAllTables();
  requestBodies = [];
});

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
    // A validated field, not an ignored one — vLLM <= 0.12 400s on "none".
    // It is a retry-only hint (next tests), never on the first request.
    expect(lastBody).not.toHaveProperty('reasoning_effort');
    expect(requestBodies).toHaveLength(1);
    expect(JSON.stringify(lastBody)).toContain('Title: PAT rotation');
    expect(JSON.stringify(lastBody)).toContain('<PREFIX>');
    expect(result.completion).toBe(' access token.');
  });

  it('retries once with reasoning_effort when the first reply carries no visible text', async () => {
    responder = (res) => {
      const thinkingDisabled = lastBody.reasoning_effort === 'none';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // LM Studio can ignore the template hints. Its reasoning then hits the
      // newline stop before any text reaches message.content.
      res.end(JSON.stringify({
        choices: [{
          message: {
            content: thinkingDisabled ? 'access the configuration file.' : '',
            reasoning_content: thinkingDisabled ? '' : 'The user wants',
          },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 20, completion_tokens: thinkingDisabled ? 6 : 48 },
      }));
    };
    const result = await requestInlineCompletion(cfg(), 'gemma-4-26b-a4b-it', {
      prefix: 'To configure the server, first ',
      maxTokens: 48,
    }, new AbortController().signal);

    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[0]).not.toHaveProperty('reasoning_effort');
    expect(requestBodies[1]).toMatchObject({
      reasoning_effort: 'none',
      think: false,
      chat_template_kwargs: { enable_thinking: false },
    });
    expect(result).toEqual({
      completion: 'access the configuration file.',
      strategy: 'chat',
      usage: { promptTokens: 20, completionTokens: 6 },
    });
  });

  it('returns the empty first reply when the retry is rejected, without counting a breaker failure', async () => {
    // Newer vLLM forwards reasoning_effort into the chat template; a template
    // that lists other values raises, which surfaces as a 500. That must not
    // become an error for the author, and must not open the provider's
    // shared breaker for chat.
    responder = (res) => {
      if (lastBody.reasoning_effort === 'none') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Unexpected reasoning effort none. Supported types are xhigh, medium, and low.' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '' } }] }));
    };
    const config = cfg();
    const result = await requestInlineCompletion(config, 'Qwen3-32B', {
      prefix: 'Done.',
      maxTokens: 48,
    }, new AbortController().signal);

    expect(requestBodies).toHaveLength(2);
    expect(result.completion).toBe('');
    expect(getProviderBreaker(config.providerId).getStatus()).toMatchObject({ state: 'CLOSED', failureCount: 0 });
  });

  it.each(['policy', 'assignment', 'content', 'visibility', 'endpoint'])('refuses stale %s before retry without sending a second body', async (change) => {
    responder = (res) => {
      void (async () => {
        if (change === 'policy') await query("UPDATE pages SET ai_policy = 'none'");
        if (change === 'assignment') await query("UPDATE llm_usecase_assignments SET model = 'successor'");
        if (change === 'content') await query('UPDATE pages SET content_revision = content_revision + 1');
        if (change === 'visibility') await query('UPDATE pages SET deleted_at = NOW()');
        if (change === 'endpoint') await query("UPDATE llm_providers SET base_url = base_url || '/changed'");
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: '' } }] }));
      })();
    };
    await expect(requestInlineCompletion(cfg(), 'm', { prefix: 'private draft', maxTokens: 48 },
      new AbortController().signal)).rejects.toThrow('changed or unavailable');
    expect(requestBodies).toHaveLength(1);
  });

  it('discards text if policy tightens during the response', async () => {
    responder = (res) => {
      void query("UPDATE pages SET ai_policy = 'none'").then(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'stale suggestion' } }] }));
      });
    };
    await expect(requestInlineCompletion(cfg(), 'm', { prefix: 'private draft', maxTokens: 48 },
      new AbortController().signal)).rejects.toThrow('changed or unavailable');
    expect(requestBodies).toHaveLength(1);
  });

  it('does not retry on the FIM path', async () => {
    json({ choices: [{ text: '' }] });
    const result = await requestInlineCompletion(cfg(), 'starcoder2', {
      prefix: 'x', maxTokens: 48,
    }, new AbortController().signal);

    expect(result.completion).toBe('');
    expect(requestBodies).toHaveLength(1);
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
