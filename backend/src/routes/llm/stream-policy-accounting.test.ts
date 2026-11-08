import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { streamSSE } from './_helpers.js';
import { ArticleStageRefusedError } from '../../domains/llm/services/article-stage-admission.js';
import { emitLlmAudit } from '../../domains/llm/services/llm-audit-hook.js';

vi.mock('../../domains/llm/services/llm-audit-hook.js', () => ({ emitLlmAudit: vi.fn() }));

describe('stream admission accounting', () => {
  it('does not emit inference usage when final admission refuses before transport', async () => {
    vi.mocked(emitLlmAudit).mockClear();
    const app = Fastify();
    app.get('/stream', async (request, reply) => {
      await streamSSE(request, reply, async function* () {
        // A generator is advanced, but no provider has received any bytes.
        await Promise.reject(new ArticleStageRefusedError());
        yield { content: '', done: true };
      }, undefined, { audit: {
        userId: 'reader', action: 'summarize', model: 'model', provider: 'provider',
        inputTokens: 100, inputMessages: [], retrievedChunkIds: [],
      } });
    });
    try {
      const response = await app.inject('/stream');
      expect(response.body).toContain('Stream error');
      expect(emitLlmAudit).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
