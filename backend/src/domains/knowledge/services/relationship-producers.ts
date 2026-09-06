/**
 * Wire-up helper that registers knowledge-domain edge producers into the
 * relationship registry (#359).
 *
 * The `llm` domain owns the shared deterministic engine but cannot import from
 * `knowledge` (ESLint domain boundary). This file can import both sides, so
 * `app.ts` calls it once at bootstrap to bridge them.
 */
import { registerRelationshipProducer } from '../../llm/services/embedding-relationship-hooks.js';
import { runExplicitLinkProducer } from './link-extractor.js';

export function registerKnowledgeRelationshipProducers(): void {
  registerRelationshipProducer('explicitLink', runExplicitLinkProducer);
}
