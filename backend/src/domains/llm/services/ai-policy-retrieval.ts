/**
 * Article AI policy at RETRIEVAL time (SPEC-RAG-001, issue #282).
 *
 * Retrieval is the first place an article's text leaves the database on the
 * way to a model, so the policy is applied INSIDE every candidate query —
 * the vector leg, both arms of the lexical leg, the exact-identifier pin and
 * the sibling-window fetch — never over their output. A post-filter would
 * still have shipped the excluded text to the rerank provider, and would
 * have left a `none` page's chunks inside the pool whose ORDER the fused
 * head is computed from.
 *
 * The predicate is a SQL fragment that takes NO parameters: the policy
 * labels are compile-time constants from `@compendiq/contracts`, so nothing
 * caller-supplied is ever interpolated, and the legs' positional bind lists
 * are untouched (a new `$n` in the middle of `lookupIdentifier`'s per-branch
 * numbering would kill the statement — see its note).
 *
 * Decision matrix (`pages.ai_policy` × destination):
 *
 *   purpose 'human' (the `/api/search` surfaces, read by a person, never by
 *   a model):                              no predicate on AUTHORED text;
 *   purpose 'ai', destination 'local':     `ai_policy = 'all' OR 'local_only'`;
 *   purpose 'ai', destination 'external':  `ai_policy = 'all'`.
 *
 * Both AI predicates are spelled as POSITIVE membership tests, never as
 * `<> 'none'`: a row whose policy is outside the closed set (unknown value,
 * a future label this build does not know) is never admitted by accident.
 *
 * `local` is only ever asserted by a caller that decoded it from the
 * provider's CURRENT configuration revision through the shared
 * `loadProviderMetadata` / `decodeProviderMetadata` (`ai-policy-admission.ts`
 * — the ONE effective-locality decoder); an unknown or stale declaration
 * reads as `external`, so the stricter predicate applies. A caller that
 * passes nothing gets `DEFAULT_RETRIEVAL_PURPOSE` — external.
 *
 * The one place the 'human' purpose still filters is DERIVED text: an image
 * analysis is itself AI output over the picture, and a `none` page's
 * derived chunks must not surface anywhere (`derivedArmPredicate`).
 */
import { query } from '../../../core/db/postgres.js';
import { AI_POLICY_LABELS, type AiPolicy, type ProviderLocality } from '@compendiq/contracts';
import { isAiPolicy } from '../../../core/services/ai-policy-service.js';
import { asRevision } from './ai-policy-admission.js';

export type RetrievalPurpose =
  | { purpose: 'human' }
  | { purpose: 'ai'; destinationLocality: ProviderLocality };

/** The default for every caller that declares nothing: an external model. */
export const DEFAULT_RETRIEVAL_PURPOSE: RetrievalPurpose = Object.freeze({
  purpose: 'ai',
  destinationLocality: 'external',
}) as RetrievalPurpose;

/** The policies admissible for a destination of `locality`, as SQL literals. */
function admissiblePolicies(locality: ProviderLocality): readonly AiPolicy[] {
  return locality === 'local' ? ['all', 'local_only'] : ['all'];
}

function inList(alias: string, policies: readonly AiPolicy[]): string {
  // Every member is a member of the closed contracts enum — asserted so a
  // refactor cannot interpolate anything else.
  for (const p of policies) {
    if (!(AI_POLICY_LABELS as readonly string[]).includes(p)) throw new Error(`not an AI policy: ${p}`);
  }
  return ` AND ${alias}.ai_policy IN (${policies.map((p) => `'${p}'`).join(', ')})`;
}

/**
 * Predicate over `<alias>.ai_policy` for AUTHORED text under `purpose`.
 * Returns `''` when no predicate applies, so it composes as `${fragment}`
 * after an existing `WHERE … AND …` chain.
 */
export function aiPolicyPredicate(purpose: RetrievalPurpose = DEFAULT_RETRIEVAL_PURPOSE, alias = 'cp'): string {
  if (purpose.purpose === 'human') return '';
  return inList(alias, admissiblePolicies(purpose.destinationLocality));
}

/**
 * Predicate for DERIVED (image-analysis) chunks: never surfaces a `none`
 * page's derived text, even to a human — see the module note.
 */
export function derivedArmPredicate(purpose: RetrievalPurpose = DEFAULT_RETRIEVAL_PURPOSE, alias = 'cp'): string {
  if (purpose.purpose === 'human') return inList(alias, ['all', 'local_only']);
  return aiPolicyPredicate(purpose, alias);
}

/** Whether ONE page at `policy` may be sent to a destination of `locality`. */
export function pageAdmittedFor(policy: AiPolicy, locality: ProviderLocality): boolean {
  return admissiblePolicies(locality).includes(policy);
}

/**
 * Whether a retrieved row's policy reading admits the rerank provider at
 * `locality`. An ABSENT reading (a row produced without its policy columns)
 * is never admitted: unknown is not `all`.
 */
export function rowAdmittedFor(
  row: { aiPolicy?: AiPolicy | undefined },
  locality: ProviderLocality,
): boolean {
  return row.aiPolicy !== undefined && pageAdmittedFor(row.aiPolicy, locality);
}

/** One page's current policy row, as read back for revalidation. */
export interface PagePolicyRow {
  pageId: number;
  policy: AiPolicy;
  policyRevision: number;
  /** `pages.content_revision` — moves on every body write. */
  contentRevision: number;
}

/**
 * Current policy AND content revision of each page in `pageIds` that still
 * exists AND decodes. Deleted pages, and rows whose policy or a revision
 * does not decode, are ABSENT from the result — a continuation or a cache
 * hit treats absence as "cannot prove admissible". Throws on a DB failure;
 * never guesses.
 */
export async function readPagePolicies(pageIds: readonly number[], runQuery: typeof query = query): Promise<Map<number, PagePolicyRow>> {
  if (pageIds.length === 0) return new Map();
  const { rows } = await runQuery<{
    id: number; ai_policy: unknown; ai_policy_revision: unknown; content_revision: unknown;
  }>(
    `SELECT id, ai_policy, ai_policy_revision, content_revision
       FROM pages WHERE id = ANY($1::int[]) AND deleted_at IS NULL`,
    [[...pageIds]],
  );
  const out = new Map<number, PagePolicyRow>();
  for (const r of rows) {
    const policyRevision = asRevision(r.ai_policy_revision);
    const contentRevision = asRevision(r.content_revision);
    if (!isAiPolicy(r.ai_policy) || policyRevision === null || contentRevision === null) continue;
    out.set(r.id, { pageId: r.id, policy: r.ai_policy, policyRevision, contentRevision });
  }
  return out;
}

/** The recorded reading of one grounded page, as re-proved by {@link provenancePagesStillAdmitted}. */
export interface RecordedPageReading {
  pageId: number;
  policyRevision: number;
  policy?: AiPolicy;
  /** Optional on the type so a pre-content-revision record still TYPES; absence FAILS revalidation. */
  contentRevision?: number | undefined;
}

/**
 * Re-check a recorded grounding set against the CURRENT rows: every page
 * must still exist, be at the SAME policy revision AND the SAME content
 * revision it was recorded under, and be admitted for `locality`. Used by
 * the continuation guard and by the answer-cache revalidation — a cached
 * answer or a replayed turn is page text exactly as fresh retrieval is, so
 * a body edit inside the TTL is as disqualifying as a policy change. A
 * record without a content revision cannot be proved and is refused.
 */
export async function provenancePagesStillAdmitted(
  pages: ReadonlyArray<RecordedPageReading>,
  locality: ProviderLocality,
  runQuery: typeof query = query,
): Promise<boolean> {
  if (pages.length === 0) return true;
  const expected = new Map<number, RecordedPageReading>();
  for (const p of pages) {
    if (p.contentRevision === undefined || !Number.isSafeInteger(p.contentRevision) || p.contentRevision < 0) return false;
    if (!Number.isSafeInteger(p.pageId) || p.pageId <= 0
      || !Number.isSafeInteger(p.policyRevision) || p.policyRevision < 0) return false;
    if (!isAiPolicy(p.policy)) return false;
    const prior = expected.get(p.pageId);
    if (prior && (prior.policy !== p.policy || prior.policyRevision !== p.policyRevision || prior.contentRevision !== p.contentRevision)) return false;
    expected.set(p.pageId, p);
  }
  const current = await readPagePolicies([...expected.keys()], runQuery);
  for (const [pageId, recorded] of expected) {
    const row = current.get(pageId);
    if (!row || row.policy !== recorded.policy) return false;
    if (row.policyRevision !== recorded.policyRevision) return false;
    if (row.contentRevision !== recorded.contentRevision) return false;
    if (!pageAdmittedFor(row.policy, locality)) return false;
  }
  return true;
}
