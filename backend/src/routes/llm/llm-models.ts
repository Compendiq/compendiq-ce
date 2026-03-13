import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  isLlmVerifySslEnabled, getLlmAuthType,
  getActiveProviderType, getProvider,
} from '../../domains/llm/services/ollama-service.js';
import { getOllamaCircuitBreakerStatus, getOpenaiCircuitBreakerStatus } from '../../core/services/circuit-breaker.js';
import { logger } from '../../core/utils/logger.js';
import type { LlmProviderType } from '../../domains/llm/services/llm-provider.js';

export async function llmModelRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // GET /api/ollama/models - list available models (supports ?provider=ollama|openai)
  fastify.get('/ollama/models', async (request) => {
    const { provider: providerParam } = z.object({ provider: z.enum(['ollama', 'openai']).optional() }).parse(request.query);
    const providerType: LlmProviderType = providerParam ?? getActiveProviderType();
    const provider = getProvider(providerType);

    try {
      return await provider.listModels();
    } catch (err) {
      logger.warn({ err, provider: providerType }, 'Failed to list models — returning empty list');
      // Return empty list instead of 503 so the UI stays functional
      // and the circuit breaker isn't tripped by repeated polling
      return [];
    }
  });

  // GET /api/ollama/status - (supports ?provider=ollama|openai)
  fastify.get('/ollama/status', async (request) => {
    const { provider: providerParam } = z.object({ provider: z.enum(['ollama', 'openai']).optional() }).parse(request.query);
    const providerType: LlmProviderType = providerParam ?? getActiveProviderType();
    const provider = getProvider(providerType);

    const health = await provider.checkHealth();
    return {
      connected: health.connected,
      error: health.error,
      provider: providerType,
      ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434',
      openaiBaseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
      embeddingModel: process.env.EMBEDDING_MODEL ?? 'nomic-embed-text',
      authConfigured: providerType === 'ollama'
        ? !!process.env.LLM_BEARER_TOKEN
        : !!(process.env.LLM_BEARER_TOKEN || process.env.OPENAI_API_KEY),
      authType: getLlmAuthType(),
      verifySsl: isLlmVerifySslEnabled(),
    };
  });

  // GET /api/ollama/circuit-breaker-status
  fastify.get('/ollama/circuit-breaker-status', async () => {
    return {
      ollama: getOllamaCircuitBreakerStatus(),
      openai: getOpenaiCircuitBreakerStatus(),
    };
  });
}
