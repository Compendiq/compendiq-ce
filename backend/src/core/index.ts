// Core barrel export — shared infrastructure used by all domains
export { getPool, closePool, query, runMigrations } from './db/postgres.js';
export { logger } from './utils/logger.js';
export { encryptPat, decryptPat } from './utils/crypto.js';
export { sanitizeLlmInput } from './utils/sanitize-llm-input.js';
export { validateUrl, validateUrlWithDns, SsrfError } from './utils/ssrf-guard.js';
export { buildConnectOptions, confluenceDispatcher, createTlsDispatcher, isVerifySslEnabled } from './utils/tls-config.js';
export { buildLlmConnectOptions, llmDispatcher, getLlmAuthHeaders, getOllamaBaseUrl } from './utils/llm-config.js';
export { RedisCache } from './services/redis-cache.js';
export { logAuditEvent, getAuditLog } from './services/audit-service.js';
export { trackError, listErrors, resolveError, getErrorSummary } from './services/error-tracker.js';
export {
  CircuitBreaker,
  CircuitBreakerOpenError,
  ollamaBreakers,
  openaiBreakers,
  getOllamaCircuitBreakerStatus,
  getOpenaiCircuitBreakerStatus,
} from './services/circuit-breaker.js';
export {
  confluenceToHtml,
  htmlToConfluence,
  htmlToMarkdown,
  markdownToHtml,
  htmlToText,
} from './services/content-converter.js';
