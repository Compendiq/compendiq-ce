/**
 * Query-side instruction prefixing for instruction-aware embedding models
 * (#1114).
 *
 * Qwen3's embedding models are trained asymmetrically: a QUERY is embedded with
 * an instruction preamble, a DOCUMENT is embedded bare. Applying the preamble to
 * both, or to neither, gives up the gain the asymmetry exists to produce.
 *
 * Three properties follow, and all three matter:
 *
 * 1. **This is query-only.** `embedPage`, the shadow dual-write and the shadow
 *    backfill embed documents and must never call it. There is exactly one
 *    query-side embedding call in the app (`rag-service.ts`'s vector leg), which
 *    is what makes that enforceable by reading four call sites.
 *
 * 2. **Turning it on does not invalidate the corpus.** Because documents are
 *    embedded bare under every model, the stored vectors are byte-identical
 *    whether or not this is active. So it may flip on at a model swap with no
 *    re-embed, and flip back on a rollback — which is precisely why it is keyed
 *    off the RESOLVED model rather than a setting someone has to remember to
 *    change in step with the swap.
 *
 * 3. **The failure modes are not symmetric.** Prefixing a model that was not
 *    trained for it corrupts the query vector and degrades every search;
 *    failing to prefix one that was gives up some accuracy and nothing else. The
 *    matcher is therefore deliberately narrow: it demands BOTH `qwen3` and
 *    `embed`, so `qwen3` the chat model and a future `qwen4-embedding` both fall
 *    through to the safe side rather than being guessed at.
 */

/**
 * The task description Qwen3 conditions the query on.
 *
 * Qwen3's own retrieval examples use a one-line task description in this slot.
 * This wording names a knowledge base rather than the web, because that is what
 * the corpus is.
 */
export const RETRIEVAL_TASK =
  'Given a search query, retrieve relevant passages from the knowledge base that answer the query';

/**
 * Whether `model` is an embedding model trained with query-side instructions.
 *
 * Conservative by design — see property 3 in the module header. A false
 * negative costs a little accuracy; a false positive corrupts every query
 * vector.
 */
export function wantsInstructionPrefix(model: string | null | undefined): boolean {
  if (!model) return false;
  const m = model.toLowerCase();
  // Both needles, because `qwen3` alone also names the chat models — which are
  // never resolved here today, but the `embedding` use case is repointable by
  // hand and a chat model in that slot must not additionally get a preamble.
  return m.includes('qwen3') && m.includes('embed');
}

/**
 * The text to embed for `query` under `model`.
 *
 * Returns `query` unchanged for every model that is not instruction-aware, so
 * this is safe to call unconditionally at the one query-side call site.
 *
 * The format is Qwen3's and is exact: `Instruct: {task}\nQuery:{query}`. **There
 * is no space after `Query:`** — the epic body has one, the model's own template
 * does not, and a stray space is a silently different token sequence.
 */
export function formatQueryForEmbedding(
  model: string | null | undefined,
  query: string,
  task: string = RETRIEVAL_TASK,
): string {
  if (!wantsInstructionPrefix(model)) return query;
  return `Instruct: ${task}\nQuery:${query}`;
}
