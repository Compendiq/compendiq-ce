// LLM domain barrel export
export {
  getSystemPrompt,
  listModels,
  checkHealth,
  streamChat,
  chat,
  summarizeContent,
  isLlmVerifySslEnabled,
  getLlmAuthType,
  getActiveProviderType,
  setActiveProvider,
  getProvider,
} from './services/ollama-service.js';
export type { ChatMessage, SystemPromptKey } from './services/ollama-service.js';
export { LANGUAGE_PRESERVATION_INSTRUCTION } from './services/ollama-service.js';
export { providerStreamChat, providerGenerateEmbedding } from './services/llm-provider.js';
export type { LlmProviderType, LlmProvider } from './services/llm-provider.js';
export { OpenAIProvider } from './services/openai-service.js';
export { OllamaProvider } from './services/ollama-provider.js';
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
