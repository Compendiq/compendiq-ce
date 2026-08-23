import { query } from '../../../core/db/postgres.js';
import { decryptPat } from '../../../core/utils/crypto.js';
import { invalidateDispatcher, invalidateBreaker, type ProviderConfig } from './openai-compatible-client.js';
import { getProviderCacheVersion, onProviderCacheBump, onProviderDeleted } from './cache-bus.js';
import { getEnterprisePlugin } from '../../../core/enterprise/loader.js';
import { logger } from '../../../core/utils/logger.js';
import type {
  CalibrationPair,
  ConfidenceBasis,
} from '../../../core/services/confidence-calibration.js';
import type { LlmUsecase } from '@compendiq/contracts';

interface ResolveRow {
  usecase_provider_id: string | null;
  usecase_model: string | null;
  provider_id: string;
  provider_name: string;
  provider_base_url: string;
  provider_api_key: string | null;
  provider_auth_type: 'bearer' | 'none';
  provider_verify_ssl: boolean;
  provider_default_model: string | null;
  provider_is_default: boolean;
}

interface Resolved {
  config: ProviderConfig & { id: string; name: string; defaultModel: string | null };
  model: string;
}

// In-memory cache of provider configs keyed by id, invalidated by version bump.
const configCache = new Map<string, { version: number; cfg: ProviderConfig & { id: string; name: string; defaultModel: string | null } }>();

onProviderCacheBump(() => {
  // Also close any pooled undici dispatchers for those providers (they'll be
  // re-created on the next resolveUsecase/listProviders call) and drop their
  // per-provider circuit breakers so stale failure state doesn't carry over
  // against the new configuration.
  for (const entry of configCache.values()) {
    invalidateDispatcher(entry.cfg.providerId);
    invalidateBreaker(entry.cfg.providerId);
  }
  configCache.clear();
});

// Issue #267 — Definitive per-id cleanup on provider deletion. Runs even if
// the resolver's configCache doesn't have an entry for `id` (e.g. a provider
// contacted via "Test connection" before it was ever assigned to a use-case,
// whose breaker lives in `providerBreakers` but not in `configCache`). This
// listener is belt-and-braces with the cache-bump listener above: when both
// fire, this one's `configCache.delete(id)` is redundant with the bump
// listener's `configCache.clear()`, but keeping it here makes the listener
// self-sufficient and independent of event ordering.
onProviderDeleted((id) => {
  invalidateDispatcher(id);
  invalidateBreaker(id);
  configCache.delete(id);
});

function decryptSafe(s: string | null): string | null {
  if (!s) return null;
  try { return decryptPat(s); } catch { return null; }
}

function loadProviderFromRow(
  row: ResolveRow,
): ProviderConfig & { id: string; name: string; defaultModel: string | null } {
  const cacheKey = row.provider_id;
  let cached = configCache.get(cacheKey);
  if (!cached || cached.version !== getProviderCacheVersion()) {
    cached = {
      version: getProviderCacheVersion(),
      cfg: {
        providerId: row.provider_id,
        id: row.provider_id,
        name: row.provider_name,
        baseUrl: row.provider_base_url,
        apiKey: decryptSafe(row.provider_api_key),
        authType: row.provider_auth_type,
        verifySsl: row.provider_verify_ssl,
        defaultModel: row.provider_default_model,
      },
    };
    configCache.set(cacheKey, cached);
  }
  return cached.cfg;
}

/**
 * #1154: load a single provider's config by id, for callers that already
 * know the provider (the vision-capability store) rather than resolving a
 * use-case. Same column aliases as the override query below, routed through
 * the same cache so it doesn't duplicate `loadProviderFromRow`'s caching.
 */
export async function loadProviderConfig(
  providerId: string,
): Promise<ProviderConfig & { id: string; name: string; defaultModel: string | null }> {
  const { rows } = await query<ResolveRow>(
    `SELECT
       NULL::uuid AS usecase_provider_id,
       NULL::text AS usecase_model,
       id            AS provider_id,
       name          AS provider_name,
       base_url      AS provider_base_url,
       api_key       AS provider_api_key,
       auth_type     AS provider_auth_type,
       verify_ssl    AS provider_verify_ssl,
       default_model AS provider_default_model,
       is_default    AS provider_is_default
     FROM llm_providers WHERE id = $1`,
    [providerId],
  );
  const row = rows[0];
  if (!row) throw new Error(`Provider ${providerId} not found.`);
  return loadProviderFromRow(row);
}

/**
 * Rerank resolves differently from every other use case (#1104, ADR-021
 * amendment): an unassigned `rerank` row means the rerank stage is
 * **disabled** — this returns null — never "inherit the default provider".
 * The default provider speaks /chat/completions and /embeddings; handing it
 * /v1/rerank traffic would break retrieval the moment an admin configured a
 * default provider. Enterprise usecase overrides deliberately do not apply
 * either — the org-policy override routes chat-shaped calls.
 *
 * A model must resolve too: an assignment without a model falls back to the
 * provider's default_model, and if neither exists the stage stays disabled
 * rather than sending an empty model name to a rerank endpoint.
 */
export async function resolveRerankUsecase(): Promise<Resolved | null> {
  return resolveExplicitOnlyUsecase('rerank');
}

/**
 * The same non-inheriting resolution for `image_embedding` (#1115, ADR-025 D3)
 * — the rerank rule, one rung stronger.
 *
 * Rerank's argument for refusing inheritance was that the default provider
 * handed `/v1/rerank` traffic ERRORS, which is loud and immediate. Here the
 * failure would be silent: the default text embedder answers the plain
 * `{model, input}` shape with a perfectly well-formed vector — bypassing the
 * chat template, pooling a different position — and an index built from those
 * is indistinguishable from bad retrieval. So an unassigned row means the image
 * leg is OFF, and there is no fallback anywhere in this function.
 *
 * The Enterprise usecase override does not apply, for the same reason it does
 * not apply to rerank: the org-policy override routes chat-shaped calls.
 */
export async function resolveImageEmbeddingUsecase(): Promise<Resolved | null> {
  return resolveExplicitOnlyUsecase('image_embedding');
}

/**
 * #1417: inline completion is opt-in. Its high request frequency and strict
 * latency/token budget make silently inheriting the default chat provider an
 * unsafe operational surprise, so an unassigned row means ghost text is off.
 */
export async function resolveInlineCompletionUsecase(): Promise<Resolved | null> {
  return resolveExplicitOnlyUsecase('inline_completion');
}

/**
 * Shared body of the three ADR-021 use cases that NEVER inherit. One function
 * rather than three, so a future fourth cannot quietly gain a fallback that the
 * others refuse — the `usecase` is the only difference between them.
 *
 * A model must resolve too: an assignment without a model falls back to the
 * provider's `default_model`, and if neither exists the stage stays disabled
 * rather than posting an empty model name at a non-OpenAI-shaped endpoint.
 */
async function resolveExplicitOnlyUsecase(
  usecase: 'rerank' | 'image_embedding' | 'inline_completion',
): Promise<Resolved | null> {
  const rows = await query<ResolveRow>(
    `SELECT
       a.provider_id  AS usecase_provider_id,
       a.model        AS usecase_model,
       p.id           AS provider_id,
       p.name         AS provider_name,
       p.base_url     AS provider_base_url,
       p.api_key      AS provider_api_key,
       p.auth_type    AS provider_auth_type,
       p.verify_ssl   AS provider_verify_ssl,
       p.default_model AS provider_default_model,
       p.is_default   AS provider_is_default
     FROM llm_usecase_assignments a
     JOIN llm_providers p ON p.id = a.provider_id
     WHERE a.usecase = $1`,
    [usecase],
  );
  const row = rows.rows[0];
  if (!row) return null;
  const cfg = loadProviderFromRow(row);
  const model = row.usecase_model || cfg.defaultModel || '';
  if (!model) return null;
  return { config: cfg, model };
}

export async function resolveUsecase(usecase: LlmUsecase): Promise<Resolved> {
  // The one enforcement point for #1104's resolution invariant: rerank NEVER
  // inherits the default provider (it speaks /v1/rerank, the default speaks
  // /chat/completions). Every current caller routes rerank through
  // resolveRerankUsecase already; this throw is what keeps the next dynamic
  // caller from silently re-enabling the fallback.
  if (usecase === 'rerank') {
    throw new Error(
      "resolveUsecase must not resolve 'rerank' — use resolveRerankUsecase (unassigned = stage disabled)",
    );
  }
  // #1115: the same invariant for the image leg, and the failure it prevents is
  // quieter — the default provider would ANSWER an image-embedding request, in
  // the wrong shape, with a plausible vector.
  if (usecase === 'image_embedding') {
    throw new Error(
      "resolveUsecase must not resolve 'image_embedding' — use resolveImageEmbeddingUsecase (unassigned = image leg disabled)",
    );
  }
  if (usecase === 'inline_completion') {
    throw new Error(
      "resolveUsecase must not resolve 'inline_completion' — use resolveInlineCompletionUsecase (unassigned = ghost text disabled)",
    );
  }
  // Enterprise override: when org LLM policy is enabled, EE returns the
  // policy's (providerId, model). CE noop always returns null.
  const override = await getEnterprisePlugin().resolveUsecaseOverride?.(usecase);
  if (override) {
    const overrideRows = await query<ResolveRow>(
      `SELECT
         NULL::uuid AS usecase_provider_id,
         NULL::text AS usecase_model,
         id            AS provider_id,
         name          AS provider_name,
         base_url      AS provider_base_url,
         api_key       AS provider_api_key,
         auth_type     AS provider_auth_type,
         verify_ssl    AS provider_verify_ssl,
         default_model AS provider_default_model,
         is_default    AS provider_is_default
       FROM llm_providers WHERE id = $1`,
      [override.providerId],
    );
    const orow = overrideRows.rows[0];
    if (!orow) {
      throw new Error(
        `Org LLM policy refers to provider ${override.providerId} which no longer exists. Update the policy in Settings → AI Safety → LLM Policy.`,
      );
    }
    const cfg = loadProviderFromRow(orow);
    // Mirror the CTE path's empty-string defense: if the policy's `model` is
    // empty (UI shouldn't allow this, but defend anyway), fall back to the
    // provider's `default_model`, then to `''`.
    const model = override.model || cfg.defaultModel || '';
    return { config: cfg, model };
  }

  // One round-trip: pull the use-case row + the default provider + the chosen
  // provider (if any) in a single query using a CTE.
  const sql = `
    WITH assignment AS (
      SELECT provider_id, model FROM llm_usecase_assignments WHERE usecase=$1
    ),
    target AS (
      SELECT p.*
      FROM llm_providers p
      WHERE p.id = (SELECT provider_id FROM assignment)
      UNION ALL
      SELECT p.*
      FROM llm_providers p
      WHERE p.is_default
        AND NOT EXISTS (SELECT 1 FROM assignment WHERE provider_id IS NOT NULL)
      LIMIT 1
    )
    SELECT
      a.provider_id AS usecase_provider_id,
      a.model       AS usecase_model,
      t.id          AS provider_id,
      t.name        AS provider_name,
      t.base_url    AS provider_base_url,
      t.api_key     AS provider_api_key,
      t.auth_type   AS provider_auth_type,
      t.verify_ssl  AS provider_verify_ssl,
      t.default_model AS provider_default_model,
      t.is_default  AS provider_is_default
    FROM target t
    LEFT JOIN assignment a ON TRUE
  `;
  const r = await query<ResolveRow>(sql, [usecase]);
  const row = r.rows[0];
  if (!row) throw new NoProviderConfiguredError('No default provider configured — set one in Settings → AI Models.');

  const cfg = loadProviderFromRow(row);
  const model = row.usecase_model ?? cfg.defaultModel ?? '';
  return { config: cfg, model };
}

/**
 * #1114 — the provider+model behind a confidence basis, right now.
 *
 * The refuse gate's two thresholds sit on scales their models decide, so
 * "which model is this threshold gating against?" is a question with exactly
 * one correct source: the resolvers above. Not `llm_usecase_assignments` —
 * that row does not carry inheritance from the default provider, the EE
 * org-policy override, or ADR-021's "unassigned rerank means the stage is
 * disabled" (which is why rerank answers null here rather than falling back
 * to the default provider, whose `/v1/rerank` does not exist). A raw row read
 * would name a pair the pipeline is not using, which is the exact class of
 * mismatch the calibration record exists to report.
 *
 * Never throws — but it never collapses a FAILURE into an answer either
 * (review r2). "Nothing is assigned" and "the resolver could not tell us" are
 * different facts, and only the first is a fact about the deployment: a DB
 * hiccup inside the CTE, a decrypt failure on the provider row or an EE
 * override that throws all produce the same `null` as a genuinely empty
 * assignment. Read back, that null is the claim "this threshold was tuned
 * against no model at all" — false on an instance with an embedder assigned
 * the whole time, and permanent once the write path has persisted it. So the
 * two are reported separately and each caller decides:
 *
 *  - the WRITE path (`PUT /admin/settings`) skips the record entirely when
 *    `resolved` is false, leaving the previous one — unknown, not asserted —
 *    and reports that it did, because the route still answers 200 and a panel
 *    inferring success from the status code would tell the operator a record
 *    was written that was not;
 *  - the READ path treats an unresolved pair as "no live model" for the
 *    STALENESS VERDICT, because whatever stops this resolver from naming the
 *    model stops `generateEmbedding` from using it too, and that verdict is
 *    recomputed on every GET rather than stored — but it ships `resolved`
 *    alongside it (review r3), because "no model is assigned" is a claim about
 *    `llm_usecase_assignments` and it is false when the row is present and
 *    merely unreadable. Two of the failures here are persistent, not
 *    transient: a `PAT_ENCRYPTION_KEY` rotation that leaves `api_key`
 *    undecryptable, and an EE org policy naming a provider that has been
 *    deleted (which throws a plain `Error` from the override branch below).
 *    Reporting either as "nothing is assigned" points the operator at the
 *    assignment grid instead of the provider row, for good.
 */
export interface ConfidenceBasisResolution {
  /** False only when the resolver itself failed. Not "nothing is assigned". */
  resolved: boolean;
  /** The live pair, or null when nothing is assigned / nothing resolved. */
  pair: CalibrationPair | null;
}

/**
 * "Nothing is configured on this deployment" — a knowable STATE, which is why
 * it keeps its exact message and is only subclassed. A fresh install with no
 * provider genuinely has no model behind either basis, and recording that is
 * true; an unexpected throw from the same call is not.
 */
export class NoProviderConfiguredError extends Error {}

export async function resolveConfidenceBasisPair(
  basis: ConfidenceBasis,
): Promise<ConfidenceBasisResolution> {
  try {
    if (basis === 'rerank') {
      const resolved = await resolveRerankUsecase();
      return {
        resolved: true,
        pair: resolved ? { providerId: resolved.config.providerId, model: resolved.model } : null,
      };
    }
    const resolved = await resolveUsecase('embedding');
    return {
      resolved: true,
      pair: resolved.model ? { providerId: resolved.config.providerId, model: resolved.model } : null,
    };
  } catch (err) {
    if (err instanceof NoProviderConfiguredError) {
      // Configured-with-nothing, not unknown. Recording "tuned against no
      // model" is TRUE here, and the transition out of it — an admin
      // assigning the first embedder behind a live threshold — is exactly a
      // scale change the operator should hear about.
      return { resolved: true, pair: null };
    }
    logger.warn({ err, basis }, 'Could not resolve the model behind a confidence threshold');
    return { resolved: false, pair: null };
  }
}
