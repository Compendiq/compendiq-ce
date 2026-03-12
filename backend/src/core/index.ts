// Core barrel export — shared infrastructure used by all domains
export { getPool, closePool, query, runMigrations } from './db/postgres.js';
export { logger } from './utils/logger.js';
export { encrypt, decrypt } from './utils/crypto.js';
export { sanitizeLlmInput } from './utils/sanitize-llm-input.js';
export { isAllowedUrl } from './utils/ssrf-guard.js';
export { getTlsOptions } from './utils/tls-config.js';
export { getLlmConfig } from './utils/llm-config.js';
export { RedisCache } from './services/redis-cache.js';
export { logAuditEvent, getAuditLog } from './services/audit-service.js';
export { trackError, listErrors, resolveError, getErrorSummary } from './services/error-tracker.js';
export {
  createCircuitBreaker,
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
