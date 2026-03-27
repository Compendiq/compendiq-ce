import { FastifyInstance } from 'fastify';
import { getSystemPrompt, SystemPromptKey } from '../../domains/llm/services/ollama-service.js';
import { providerStreamChat } from '../../domains/llm/services/llm-provider.js';
import { htmlToMarkdown } from '../../core/services/content-converter.js';
import { LlmCache, buildLlmCacheKey } from '../../domains/llm/services/llm-cache.js';
import { GenerateDiagramRequestSchema } from '@atlasmind/contracts';
import { logAuditEvent } from '../../core/services/audit-service.js';
import {
  checkCacheWithLock,
  sendCachedSSE,
  streamSSE,
  sanitizeLlmInput,
  LLM_STREAM_RATE_LIMIT,
  MAX_INPUT_LENGTH,
} from './_helpers.js';

export async function llmDiagramRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  const llmCache = new LlmCache(fastify.redis);

  // POST /api/llm/generate-diagram - stream Mermaid diagram from article content
  fastify.post('/llm/generate-diagram', LLM_STREAM_RATE_LIMIT, async (request, reply) => {
    const body = GenerateDiagramRequestSchema.parse(request.body);
    const { content, model, diagramType = 'flowchart' } = body;

    if (content.length > MAX_INPUT_LENGTH) {
      throw fastify.httpErrors.badRequest(`Content too large (max ${MAX_INPUT_LENGTH} characters)`);
    }

    const markdown = htmlToMarkdown(content);

    // Sanitize before sending to LLM
    const { sanitized, warnings } = sanitizeLlmInput(markdown);
    if (warnings.length > 0) {
      await logAuditEvent(request.userId, 'PROMPT_INJECTION_DETECTED', 'llm', undefined, { warnings, route: '/llm/generate-diagram' }, request);
    }

    const systemPrompt = getSystemPrompt(`generate_diagram_${diagramType}` as SystemPromptKey);

    // Check LLM cache with stampede protection
    const cacheKey = buildLlmCacheKey(model, systemPrompt, sanitized);
    const { cached, lockAcquired } = await checkCacheWithLock(llmCache, cacheKey);
    if (cached) {
      sendCachedSSE(reply, cached.content);
      return;
    }

    try {
      const generator = providerStreamChat(request.userId, model, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: sanitized },
      ]);

      await streamSSE(request, reply, generator, undefined, { llmCache, cacheKey });
    } finally {
      if (lockAcquired) await llmCache.releaseLock(cacheKey);
    }
  });
}
