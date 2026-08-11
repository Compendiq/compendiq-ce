/**
 * Dedicated /v1/rerank client (#1104, ADR-021 amendment).
 *
 * Rerank endpoints speak the Cohere/Jina/TEI request shape —
 * `{ model, query, documents, top_n }` → `{ results: [{ index,
 * relevance_score }] }` — which is NOT OpenAI-compatible, so this is a
 * distinct client rather than a fourth method on the chat/embeddings
 * contract. It still inherits everything every outbound provider call
 * inherits: the global LLM queue, the per-provider circuit breaker, bearer
 * auth headers, and the per-provider TLS dispatcher (via
 * `providerRequestInfra`).
 *
 * Score contract: relevance scores are returned in [0, 1]. Hosted rerankers
 * (Cohere, Jina) already emit that range; a local cross-encoder served raw
 * (TEI without sigmoid) emits logits, so when ANY score falls outside [0, 1]
 * the whole result set is passed through a sigmoid — per-set, never per-item,
 * so one out-of-range score cannot mix two scales in one ranking.
 *
 * Failure contract: the caller decides what a failure means (rag-service
 * bypasses the stage honestly — it never fakes a score). This module's job is
 * only to throw a typed LlmHttpError like its siblings.
 */
import { fetch as undiciFetch } from 'undici';
import { enqueue } from './llm-queue.js';
import { getProviderBreaker } from '../../../core/services/circuit-breaker.js';
import { withSpan } from '../../../telemetry.js';
import {
  providerRequestInfra,
  LlmHttpError,
  type ProviderConfig,
} from './openai-compatible-client.js';

const { headers, dispatcherFor, errorDetail } = providerRequestInfra;

export interface RerankResult {
  /** Index into the `documents` array handed to {@link rerank}. */
  index: number;
  /** Relevance in [0, 1] after the per-set normalisation described above. */
  relevanceScore: number;
}

/**
 * Documents are truncated to this many characters before scoring — a
 * cross-encoder reads query+document pairs token by token, and the guide's
 * measured guidance is that ~2,000 chars carries the relevance signal at a
 * fraction of the latency. Chunks usually sit near 1,500 chars post-#1265;
 * this bounds the stragglers that ride CHUNK_HARD_LIMIT.
 */
export const RERANK_DOC_MAX_CHARS = 2_000;

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/** Exported for the unit tests that pin the per-set normalisation rule. */
export function normalizeRerankScores(results: RerankResult[]): RerankResult[] {
  const outOfRange = results.some((r) => r.relevanceScore < 0 || r.relevanceScore > 1);
  if (!outOfRange) return results;
  return results.map((r) => ({ ...r, relevanceScore: sigmoid(r.relevanceScore) }));
}

/**
 * Score `documents` against `query`. Returns one entry per requested
 * document index, ordered by descending relevance. `topN` defaults to all
 * documents — rag-service wants every candidate scored, and slices itself.
 */
export async function rerank(
  cfg: ProviderConfig,
  model: string,
  query: string,
  documents: string[],
  topN?: number,
): Promise<RerankResult[]> {
  const docs = documents.map((d) =>
    d.length > RERANK_DOC_MAX_CHARS ? d.slice(0, RERANK_DOC_MAX_CHARS) : d,
  );
  return withSpan(
    'llm.rerank',
    () =>
      enqueue((signal) =>
        getProviderBreaker(cfg.providerId).execute(async () => {
          const res = await undiciFetch(`${cfg.baseUrl}/rerank`, {
            method: 'POST',
            headers: headers(cfg),
            body: JSON.stringify({
              model,
              query,
              documents: docs,
              top_n: topN ?? docs.length,
            }),
            dispatcher: dispatcherFor(cfg),
            signal,
          });
          if (!res.ok) {
            // As with embeddings (#867): a deterministic 400 proves the
            // provider is reachable — it must not open the breaker.
            throw new LlmHttpError('rerank', res.status, await errorDetail(res), res.status === 400);
          }
          const body = (await res.json()) as {
            results?: Array<{ index: number; relevance_score: number }>;
          };
          if (!Array.isArray(body.results)) {
            throw new LlmHttpError('rerank', 502, 'rerank response carried no results array');
          }
          const mapped = body.results
            .filter((r) => Number.isInteger(r.index) && r.index >= 0 && r.index < docs.length
              && Number.isFinite(r.relevance_score))
            .map((r) => ({ index: r.index, relevanceScore: r.relevance_score }));
          return normalizeRerankScores(mapped).sort((a, b) => b.relevanceScore - a.relevanceScore);
        }),
      ),
    { 'llm.provider_id': cfg.providerId, 'llm.model': model, 'llm.document_count': docs.length },
  );
}
