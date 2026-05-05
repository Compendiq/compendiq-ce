/**
 * Wire-up helper that registers knowledge-domain edge producers into the
 * embedding-service registry (#359).
 *
 * The `llm` domain owns the `computePageRelationships()` transaction but
 * cannot import from `knowledge` (ESLint domain boundary). This file lives
 * in `knowledge` so it CAN import both sides — `app.ts` calls it once at
 * bootstrap to bridge them.
 */
import { registerRelationshipProducer } from '../../llm/services/embedding-relationship-hooks.js';
import { runExplicitLinkProducer } from './link-extractor.js';

export function registerKnowledgeRelationshipProducers(): void {
  registerRelationshipProducer('explicitLink', runExplicitLinkProducer);
}
