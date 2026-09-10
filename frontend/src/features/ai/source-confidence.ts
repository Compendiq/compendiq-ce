import type { Source } from './SourceCitations';

/**
 * Mean cosine similarity across the knowledge-base sources of an answer, or
 * `null` when none of them carries one.
 *
 * `null` is not zero. A keyword-only retrieval measures no similarity at all,
 * and neither do web or external-doc sources, which never went through
 * retrieval. Averaging those in as 0 — or reading the `score` field, which
 * after RRF fusion is a fusion value typically near 0.033 — is what made
 * ConfidenceBadge render "Low confidence" on every knowledge-base answer
 * (#1117). Callers must render no badge when this returns `null`.
 *
 * #1115 P3 — image sources are covered by the SAME rule and needed no new
 * branch: the backend emits `similarity: null` on every `kind: 'image'` entry
 * deliberately, because the image leg's own score is a CROSS-MODAL cosine
 * sitting in a different band from the text cosines beside it (ADR-025 §8), so
 * averaging the two would rate an answer on a mixture of scales. The filter
 * below is what makes that guarantee hold here, and `source-confidence.test.ts`
 * pins it so a future "let's show the image score too" cannot pass silently.
 */
export function averageSourceSimilarity(sources: Source[]): number | null {
  const measured = sources
    .map((s) => s.similarity)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));

  if (measured.length === 0) return null;
  return measured.reduce((a, b) => a + b, 0) / measured.length;
}
