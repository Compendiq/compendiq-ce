/**
 * Dedicated /v1/rerank client (#1104, ADR-021 amendment).
 *
 * Rerank endpoints speak the Cohere/Jina request shape —
 * `{ model, query, documents, top_n }` → `{ results: [{ index,
 * relevance_score }] }` — which is NOT OpenAI-compatible, so this is a
 * distinct client rather than a fourth method on the chat/embeddings
 * contract. llama.cpp's `llama-server --rerank` serves this shape at
 * /v1/rerank (verified live); **TEI does NOT** — its endpoint is a bare
 * `POST /rerank` with `{ query, texts }` returning a bare array, and is not
 * supported by this client. It still inherits everything every outbound provider call
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

export interface RerankOptions {
  /** Defaults to all documents — rag-service wants every candidate scored. */
  topN?: number;
  /**
   * Hard latency budget covering QUEUE WAIT plus the request (#1267 review
   * B3). The signal starts at call time, so a backlogged queue spends the
   * budget waiting and the request aborts on admission instead of running
   * anyway — a raced-and-abandoned promise held its global LLM_CONCURRENCY
   * slot for up to the queue's own 300s timeout while the caller had long
   * bypassed. An abort also counts as a breaker FAILURE, which is the
   * feedback loop that turns a persistently slow reranker off for a while
   * instead of paying full cost for bypassed results on every query.
   */
  timeoutMs?: number;
}

/**
 * Score `documents` against `query`. Returns one entry per requested
 * document index, ordered by descending relevance.
 */
export async function rerank(
  cfg: ProviderConfig,
  model: string,
  query: string,
  documents: string[],
  opts?: RerankOptions,
): Promise<RerankResult[]> {
  const docs = documents.map((d) =>
    d.length > RERANK_DOC_MAX_CHARS ? d.slice(0, RERANK_DOC_MAX_CHARS) : d,
  );
  // Created before enqueue so the budget covers queue wait (see RerankOptions).
  const deadline = opts?.timeoutMs != null ? AbortSignal.timeout(opts.timeoutMs) : undefined;
  return withSpan(
    'llm.rerank',
    () =>
      enqueue((signal) =>
        getProviderBreaker(cfg.providerId).execute(async () => {
          const res = await undiciFetch(`${cfg.baseUrl}/rerank`, {
            method: 'POST',
            headers: providerRequestInfra.headers(cfg),
            body: JSON.stringify({
              model,
              query,
              documents: docs,
              top_n: opts?.topN ?? docs.length,
            }),
            dispatcher: providerRequestInfra.dispatcherFor(cfg),
            signal: deadline ? AbortSignal.any([signal, deadline]) : signal,
          });
          if (!res.ok) {
            // As with embeddings (#867): a deterministic client-side status
            // proves the provider is reachable — it must not open the
            // breaker. For rerank that set includes 404/405: they are what a
            // chat-only provider answers for POST /v1/rerank, i.e. the
            // MISCONFIGURATION case. The breaker is shared per PROVIDER, so
            // counting those as failures would open it for chat/embeddings
            // too and turn a wrong rerank assignment into user-facing 503s
            // (#1267 verification, 2). Timeouts and 5xx still count.
            const deterministic = res.status === 400 || res.status === 404 || res.status === 405;
            throw new LlmHttpError(
              'rerank', res.status, await providerRequestInfra.errorDetail(res), deterministic,
            );
          }
          const body = (await res.json()) as {
            results?: Array<{ index: number; relevance_score: number }>;
          };
          if (!Array.isArray(body.results)) {
            throw new LlmHttpError('rerank', 502, 'rerank response carried no results array');
          }
          const seen = new Set<number>();
          const mapped = body.results
            .filter((r) => {
              // Bounds + finiteness + first-occurrence-wins dedup: a provider
              // echoing an index twice would otherwise put the same chunk
              // into the context and citations twice.
              if (!Number.isInteger(r.index) || r.index < 0 || r.index >= docs.length) return false;
              if (!Number.isFinite(r.relevance_score)) return false;
              if (seen.has(r.index)) return false;
              seen.add(r.index);
              return true;
            })
            .map((r) => ({ index: r.index, relevanceScore: r.relevance_score }));
          return normalizeRerankScores(mapped).sort((a, b) => b.relevanceScore - a.relevanceScore);
        }),
      ),
    { 'llm.provider_id': cfg.providerId, 'llm.model': model, 'llm.document_count': docs.length },
  );
}
