import type { Source } from './SourceCitations';

/**
 * Mean cosine similarity across the knowledge-base sources of an answer, or
 * `null` when none of them carries one.
 *
 * `null` is not zero. A keyword-only retrieval measures no similarity at all,
 * and neither do web or external-doc sources, which never went through
 * retrieval. Averaging those in as 0 — or reading the `score` field, which
 * after RRF fusion is a fusion value capped near 0.033 — is what made
 * ConfidenceBadge render "Low confidence" on every knowledge-base answer
 * (#1117). Callers must render no badge when this returns `null`.
 */
export function averageSourceSimilarity(sources: Source[]): number | null {
  const measured = sources
    .map((s) => s.similarity)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));

  if (measured.length === 0) return null;
  return measured.reduce((a, b) => a + b, 0) / measured.length;
}
