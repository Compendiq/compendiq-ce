// LLM domain barrel export
export {
  getSystemPrompt,
  LANGUAGE_PRESERVATION_INSTRUCTION,
} from './services/prompts.js';
export type { ChatMessage, SystemPromptKey } from './services/prompts.js';
export {
  listModels,
  checkHealth,
  streamChat,
  chat,
  generateEmbedding,
  invalidateDispatcher,
} from './services/openai-compatible-client.js';
export type { ProviderConfig } from './services/openai-compatible-client.js';
export { resolveUsecase } from './services/llm-provider-resolver.js';
export {
  getEmbeddingStatus,
  processDirtyPages,
  reEmbedAll,
  isProcessingUser,
  embedPage,
  resetFailedEmbeddings,
  computePageRelationships,
} from './services/embedding-service.js';
export type { EmbeddingProgressEvent } from './services/embedding-service.js';
export { hybridSearch, buildRagContext } from './services/rag-service.js';
export { LlmCache, buildLlmCacheKey, buildRagCacheKey } from './services/llm-cache.js';
export type { CachedLlmResponse } from './services/llm-cache.js';
