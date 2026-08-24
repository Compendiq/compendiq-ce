import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query, getPool } from '../../core/db/postgres.js';
import { encryptPat, isEncryptedSecretFormat, reEncryptPat } from '../../core/utils/crypto.js';
import { getAuditLog, logAuditEvent } from '../../core/services/audit-service.js';
import { listErrors, resolveError, getErrorSummary } from '../../core/services/error-tracker.js';
import { assertNoShadowMigration } from '../../domains/llm/services/embedding-service.js';
import { logger } from '../../core/utils/logger.js';
import {
  UpdateAdminSettingsSchema,
  FtsLanguageEnum,
  FTS_LANGUAGES,
  type RagConfidenceCalibrationWrite,
  type UpdateAdminSettingsResult,
} from '@compendiq/contracts';
import {
  getEmbeddingDimensions,
  getAdminAccessDeniedRetentionDays,
  getLlmConcurrency,
  getLlmMaxQueueDepth,
  getRagFetchWidth,
  getRagRerankCandidates,
  getRagConfidenceThreshold,
  getRagConfidenceThresholdRerank,
  getRagContextCharsPerPage,
  getRagPinIdentifiersEnabled,
  getRagMmrConfig,
  getRagRankingPriorWeight,
  invalidateRagFetchWidthCache,
  invalidateRagRerankCandidatesCache,
  invalidateRagConfidenceThresholdCache,
  invalidateRagContextCharsCache,
  invalidateRagPinIdentifiersCache,
  invalidateRagMmrCache,
  invalidateRagRankingPriorCache,
  getRagImagesPerPageMax,
  getRagImageIndexExternal,
  invalidateRagImageIntakeCache,
  getRagImageLegEnabled,
  invalidateRagImageLegCache,
  getRagAnswerMaxImages,
  invalidateRagAnswerMaxImagesCache,
  resolveRagEfSearch,
  invalidateRagEfSearchCache,
} from '../../core/services/admin-settings-service.js';
import {
  computeCalibrationStatus,
  readConfidenceCalibration,
  recordConfidenceCalibration,
  CONFIDENCE_THRESHOLD_SETTING_KEYS,
  type ConfidenceBasis,
} from '../../core/services/confidence-calibration.js';
import { resolveConfidenceBasisPair } from '../../domains/llm/services/llm-provider-resolver.js';
import { toFixedDecimalString } from '../../core/utils/fixed-decimal.js';
import { getRegistrationMode } from '../../core/services/registration-policy-service.js';
import { getFtsLanguage } from '../../core/services/fts-language.js';
import {
  getImageEmbeddingTargetDimensions,
  IMAGE_EMBEDDING_TARGET_DIMENSIONS_KEY,
} from '../../core/services/image-embedding-target-dimensions.js';
import {
  setLlmConcurrencyClusterWide,
  setLlmMaxQueueDepthClusterWide,
} from '../../domains/llm/services/llm-queue.js';
import { getAiGuardrails, getAiOutputRules, upsertAiGuardrails, upsertAiOutputRules } from '../../core/services/ai-safety-service.js';
import { getRateLimits, upsertRateLimits } from '../../core/services/rate-limit-service.js';
import { getStreamCap, invalidateStreamCapCache } from '../../core/services/sse-stream-limiter.js';
import { sanitizeLlmInput } from '../../core/utils/sanitize-llm-input.js';
import { getSmtpConfig, updateSmtpConfig, sendTestEmail, stripMaskedSmtpPass } from '../../core/services/email-service.js';
import { publish } from '../../core/services/redis-cache-bus.js';
import { isCollabEditingEnabled, refreshCollabFlag } from '../../core/services/collab-flag.js';

const AuditLogQuerySchema = z.object({
  userId: z.string().optional(),
  action: z.string().optional(),
  resourceType: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(50),
});

const ErrorsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(50),
  errorType: z.string().optional(),
  resolved: z.enum(['true', 'false']).optional(),
});

const ErrorIdParamSchema = z.object({ id: z.string().min(1) });

const LabelRenameSchema = z.object({
  oldName: z.string().min(1),
  newName: z.string().min(1),
}).refine((d) => d.oldName !== d.newName, { message: 'oldName and newName must differ' });

const LabelNameParamSchema = z.object({ name: z.string().min(1) });

// Rate limit config for admin endpoints (20 requests per minute)
// Rate limit for admin endpoints (dynamic via admin settings, default 20/min)
const ADMIN_RATE_LIMIT = { config: { rateLimit: { max: async () => (await getRateLimits()).admin.max, timeWindow: '1 minute' } } };

/**
 * How long the keyword-index rebuild waits for the page locks it needs before
 * giving up. See the block comment at the rebuild itself: lifting
 * `statement_timeout` there removes the statement's only cancellation, so this
 * is what keeps a corpus-wide `UPDATE pages` from waiting forever behind an
 * in-flight page write. Exported for the test that pins the pairing.
 */
export const FTS_REBUILD_LOCK_TIMEOUT_MS = 30_000;

export async function adminRoutes(fastify: FastifyInstance) {
  // All admin routes require admin role
  fastify.addHook('onRequest', fastify.requireAdmin);

  // POST /api/admin/rotate-encryption-key - re-encrypt all PATs and
  // admin_settings secrets (smtp_pass) with the latest key
  fastify.post('/admin/rotate-encryption-key', ADMIN_RATE_LIMIT, async (request) => {
    const userId = request.userId;

    logger.info({ userId }, 'Starting encryption key rotation');

    // Fetch all encrypted PATs
    const result = await query<{ user_id: string; confluence_pat: string }>(
      'SELECT user_id, confluence_pat FROM user_settings WHERE confluence_pat IS NOT NULL',
    );

    let rotated = 0;
    let skipped = 0;
    let errors = 0;
    let total = result.rows.length;

    for (const row of result.rows) {
      try {
        const reEncrypted = reEncryptPat(row.confluence_pat);
        if (reEncrypted) {
          // Conditional on the exact ciphertext read at snapshot time so a
          // concurrent PUT /settings that saved a NEW PAT is never clobbered
          // with a re-encryption of the OLD value (lost-update guard, #889).
          const updated = await query(
            'UPDATE user_settings SET confluence_pat = $1 WHERE user_id = $2 AND confluence_pat = $3',
            [reEncrypted, row.user_id, row.confluence_pat],
          );
          if ((updated.rowCount ?? 0) > 0) {
            rotated++;
          } else {
            // Concurrently replaced by PUT /settings — the new PAT is already
            // encrypted under the latest key, so it must not be reverted.
            skipped++;
          }
        } else {
          skipped++; // Already using latest key
        }
      } catch (err) {
        errors++;
        logger.error({ err, userId: row.user_id }, 'Failed to re-encrypt PAT for user');
      }
    }

    // #1462: the Notion integration token is the same encryptPat ciphertext
    // as confluence_pat. Sweeping only the PAT would strand it after the
    // operator removes the old key.
    const notionRows = await query<{ user_id: string; notion_integration_token: string }>(
      'SELECT user_id, notion_integration_token FROM user_settings WHERE notion_integration_token IS NOT NULL',
    );
    total += notionRows.rows.length;
    for (const row of notionRows.rows) {
      try {
        const reEncrypted = reEncryptPat(row.notion_integration_token);
        if (reEncrypted) {
          const updated = await query(
            'UPDATE user_settings SET notion_integration_token = $1 WHERE user_id = $2 AND notion_integration_token = $3',
            [reEncrypted, row.user_id, row.notion_integration_token],
          );
          if ((updated.rowCount ?? 0) > 0) {
            rotated++;
          } else {
            skipped++;
          }
        } else {
          skipped++;
        }
      } catch (err) {
        errors++;
        logger.error({ err, userId: row.user_id }, 'Failed to re-encrypt Notion token for user');
      }
    }

    // issue #738 / #762 review follow-up — admin_settings.smtp_pass is a
    // versioned ciphertext too. Sweeping only user_settings would strand it
    // on the old key once the operator follows the documented procedure
    // (rotate, then remove the old key) → silent SMTP auth failures.
    // NOTE: llm_providers.api_key and webhook secret_enc have the same
    // pre-existing gap — tracked as a follow-up, deliberately not widened
    // into this sweep here.
    const smtpRow = await query<{ setting_value: string }>(
      `SELECT setting_value FROM admin_settings WHERE setting_key = 'smtp_pass'`,
    );
    const storedSmtpPass = smtpRow.rows[0]?.setting_value;
    if (storedSmtpPass) {
      total++;
      try {
        // Legacy plaintext rows (pre-#738) are encrypted outright; ciphertexts
        // are upgraded only when their key version / derivation is stale.
        const reEncrypted = isEncryptedSecretFormat(storedSmtpPass)
          ? reEncryptPat(storedSmtpPass)
          : encryptPat(storedSmtpPass);
        if (reEncrypted) {
          // Conditional on the exact value read so a concurrent
          // PUT /admin/smtp is never clobbered with a re-encryption of the
          // OLD password (lost-update guard).
          const updated = await query(
            `UPDATE admin_settings SET setting_value = $1, updated_at = NOW()
             WHERE setting_key = 'smtp_pass' AND setting_value = $2`,
            [reEncrypted, storedSmtpPass],
          );
          if ((updated.rowCount ?? 0) > 0) {
            rotated++;
          } else {
            // Concurrently replaced — PUT /admin/smtp already wrote the new
            // value encrypted with the latest key.
            skipped++;
          }
        } else {
          skipped++; // Already using latest key + derivation
        }
      } catch (err) {
        errors++;
        logger.error({ err }, 'Failed to re-encrypt smtp_pass in admin_settings');
      }
    }

    await logAuditEvent(
      userId,
      'ENCRYPTION_KEY_ROTATED',
      'system',
      undefined,
      { rotated, skipped, errors, totalPats: result.rows.length, total },
      request,
    );

    logger.info({ rotated, skipped, errors }, 'Encryption key rotation completed');

    return {
      message: 'Encryption key rotation completed',
      rotated,
      skipped,
      errors,
      total,
    };
  });

  // GET /api/admin/audit-log - query audit log with pagination/filtering
  fastify.get('/admin/audit-log', ADMIN_RATE_LIMIT, async (request) => {
    const { userId: filterUserId, action, resourceType, startDate, endDate, page, limit } =
      AuditLogQuerySchema.parse(request.query);

    return getAuditLog({
      userId: filterUserId,
      action,
      resourceType,
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
      page,
      limit,
    });
  });

  // ========================
  // Error monitoring routes
  // ========================

  // GET /api/admin/errors - list errors with pagination and filtering
  fastify.get('/admin/errors', ADMIN_RATE_LIMIT, async (request) => {
    const { page, limit, errorType, resolved } = ErrorsQuerySchema.parse(request.query);

    return listErrors({
      page,
      limit,
      errorType,
      resolved: resolved !== undefined ? resolved === 'true' : undefined,
    });
  });

  // PUT /api/admin/errors/:id/resolve - mark an error as resolved
  fastify.put('/admin/errors/:id/resolve', ADMIN_RATE_LIMIT, async (request) => {
    const { id } = ErrorIdParamSchema.parse(request.params);
    const resolved = await resolveError(id);
    if (!resolved) {
      throw fastify.httpErrors.notFound('Error not found');
    }
    return { message: 'Error marked as resolved' };
  });

  // GET /api/admin/errors/summary - error counts grouped by type and time window
  fastify.get('/admin/errors/summary', ADMIN_RATE_LIMIT, async () => {
    return getErrorSummary();
  });

  // ========================
  // Label management routes
  // ========================

  // GET /api/admin/labels - list all unique labels with usage count
  fastify.get('/admin/labels', ADMIN_RATE_LIMIT, async () => {
    const result = await query<{ label: string; page_count: number }>(
      `SELECT unnest(labels) as label, COUNT(*) as page_count
       FROM pages
       WHERE labels IS NOT NULL AND array_length(labels, 1) > 0
       GROUP BY label
       ORDER BY label ASC`,
    );

    return result.rows.map((r) => ({
      name: r.label,
      pageCount: Number(r.page_count),
    }));
  });

  // PUT /api/admin/labels/rename - rename a label across all pages
  fastify.put('/admin/labels/rename', ADMIN_RATE_LIMIT, async (request) => {
    const { oldName, newName } = LabelRenameSchema.parse(request.body);

    // Replace oldName with newName in the labels array for all pages that have the old label
    const result = await query(
      `UPDATE pages
       SET labels = array_replace(labels, $1, $2)
       WHERE $1 = ANY(labels)`,
      [oldName, newName],
    );

    await logAuditEvent(
      request.userId,
      'ADMIN_ACTION',
      'label',
      undefined,
      { action: 'rename', oldName, newName, affectedPages: result.rowCount },
      request,
    );

    return {
      message: `Label renamed from "${oldName}" to "${newName}"`,
      affectedPages: result.rowCount ?? 0,
    };
  });

  // DELETE /api/admin/labels/:name - remove a label from all pages
  fastify.delete('/admin/labels/:name', ADMIN_RATE_LIMIT, async (request) => {
    const { name } = LabelNameParamSchema.parse(request.params);

    const result = await query(
      `UPDATE pages
       SET labels = array_remove(labels, $1)
       WHERE $1 = ANY(labels)`,
      [name],
    );

    await logAuditEvent(
      request.userId,
      'ADMIN_ACTION',
      'label',
      undefined,
      { action: 'delete', name, affectedPages: result.rowCount },
      request,
    );

    return {
      message: `Label "${name}" removed from all pages`,
      affectedPages: result.rowCount ?? 0,
    };
  });

  // ========================
  // Admin settings routes
  // ========================

  // GET /api/admin/settings - retrieve shared admin settings
  fastify.get('/admin/settings', ADMIN_RATE_LIMIT, async () => {
    const [
      embeddingDimensions,
      guardrails,
      outputRules,
      rateLimits,
      llmMaxConcurrentStreamsPerUser,
      adminAccessDeniedRetentionDays,
      registrationMode,
      ftsLanguage,
      ragFetchWidth,
      ragRerankCandidates,
      ragConfidenceThreshold,
      ragConfidenceThresholdRerank,
      ragContextCharsPerPage,
      ragPinIdentifiers,
      ragMmr,
      ragRankingPriorWeight,
      ragImagesPerPageMax,
      ragImageIndexExternal,
      ragImageLegEnabled,
      ragAnswerMaxImages,
      imageEmbeddingTargetDimensions,
      efSearch,
    ] = await Promise.all([
      getEmbeddingDimensions(),
      getAiGuardrails(),
      getAiOutputRules(),
      getRateLimits(),
      getStreamCap(),
      getAdminAccessDeniedRetentionDays(),
      getRegistrationMode(),
      // #1114 — read the keyword-index language through its own reader for
      // the same reason as the nine below: `getFtsLanguage` DISCARDS a value
      // outside the closed allow-list (a row from psql, a restored dump or a
      // future migration never passes through Zod), so the raw row can name a
      // configuration the search legs are not using — and one this route's own
      // `AdminSettingsSchema` rejects, leaving the panel's select with no
      // matching option. It is uncached, so this is one extra SELECT per
      // settings page view.
      getFtsLanguage(),
      // #1118 — read the retrieval knobs through their own getters rather
      // than adding nine keys to the SELECT below. Each getter owns a
      // 60-second cache and a soft-fail path (the assembly budget's is a
      // last-good fallback, not a default), so a hand-rolled read here would
      // report a value the pipeline is not using the moment one of them
      // degraded. They are cached, so the cost is one SELECT per key per
      // minute, not per settings page view.
      getRagFetchWidth(),
      getRagRerankCandidates(),
      getRagConfidenceThreshold(),
      getRagConfidenceThresholdRerank(),
      getRagContextCharsPerPage(),
      getRagPinIdentifiersEnabled(),
      getRagMmrConfig(),
      getRagRankingPriorWeight(),
      // #1115 P2 — the image-index intake knobs, through their own reader for
      // the same reason as the nine above. The Retrieval tab gains the
      // controls in P3; this makes the values readable (and settable, below)
      // from the release the worker ships in.
      getRagImagesPerPageMax(),
      getRagImageIndexExternal(),
      // #1115 P3 — the retrieval half. Its own reader and its own cache: it is
      // read once per hybrid search, where the intake pair is read once per
      // page scanned, so sharing a cache entry would tie a hot-path read to an
      // invalidation the worker triggers.
      getRagImageLegEnabled(),
      // #1115 P4 — the ANSWER half: how many of the matched images the chat
      // model is shown. A third reader rather than a widened one for the same
      // reason again — it is read once per ask that reaches a completion, and
      // it is the only one of the three whose 0 is meaningful.
      getRagAnswerMaxImages(),
      // #1115 — uncached, like `getFtsLanguage`: it is read a handful of times
      // per admin action, and a stale one would let a probe fired seconds after
      // the width was saved measure the OLD width and type the column to it.
      getImageEmbeddingTargetDimensions(),
      // #1285 — the `ef_search` floor, through its own cached reader for the
      // #1118 reason plus one of its own: this is the only knob on the panel
      // with a deprecated env var behind it, and the reader owns the
      // row → `RAG_EF_SEARCH` → 100 cascade. Reading the row here would report
      // 100 on every instance still running on the variable, i.e. a panel that
      // contradicts what the kNN probes are doing. It answers the SOURCE too
      // (review r1): the panel's Save is a pure value diff, so on an instance
      // still running on the variable the field already holds what the server
      // resolved and nothing can be saved — the panel needs to know that to
      // offer the one-key write that retires it.
      resolveRagEfSearch(),
    ]);
    const result = await query<{ setting_key: string; setting_value: string }>(
      `SELECT setting_key, setting_value FROM admin_settings
       WHERE setting_key IN ('embedding_chunk_size', 'embedding_chunk_overlap', 'drawio_embed_url', 'reembed_history_retention')`,
    );

    const map: Record<string, string> = {};
    for (const row of result.rows) {
      map[row.setting_key] = row.setting_value;
    }

    // #1114 — the staleness verdict is computed HERE, not in the panel. The
    // recorded pair is a server fact and so is the live assignment (the
    // resolvers carry inheritance and the EE override), so shipping both and
    // letting the client diff them would put a rule with two special cases in
    // the place least able to keep it. The live pairs are resolved only when
    // there is something to compare against: on a default instance (both
    // thresholds 0, no record) this costs nothing.
    const [similarityRecord, rerankRecord] = await Promise.all([
      readConfidenceCalibration('similarity'),
      readConfidenceCalibration('rerank'),
    ]);
    const [liveEmbedding, liveRerank] = await Promise.all([
      similarityRecord ? resolveConfidenceBasisPair('similarity') : Promise.resolve(null),
      rerankRecord ? resolveConfidenceBasisPair('rerank') : Promise.resolve(null),
    ]);
    // A resolver failure reads as "no live model" for the STALENESS verdict
    // HERE and nowhere else (review r2): whatever stopped the resolver naming
    // the model stops `generateEmbedding` using it too, so "the threshold is
    // not gating against anything it was tuned on" is true either way — and
    // this verdict is recomputed on every GET, so it corrects itself. The PUT
    // below must not make the same substitution, because that one is written
    // down.
    //
    // The failure still travels, on `liveResolved` (review r3). Folding it
    // into the pair made the panel state "no {basis} model is assigned now" —
    // a claim about `llm_usecase_assignments` that is false, and persistently
    // so, when the row is present and merely unreadable (a rotated
    // `PAT_ENCRYPTION_KEY`, an EE policy naming a deleted provider). The
    // operator was then sent to the assignment grid instead of the provider
    // row.
    const ragConfidenceCalibration = {
      similarity: computeCalibrationStatus(similarityRecord, liveEmbedding),
      rerank: computeCalibrationStatus(rerankRecord, liveRerank),
    };

    return {
      embeddingDimensions,
      // #1114 — resolved above by `getFtsLanguage`, not read out of `map`.
      // No `process.env.FTS_LANGUAGE` arm either: migration 049 seeds the row
      // on every instance, so the env var was unreachable here and only ever
      // contradicted what the panel showed.
      ftsLanguage,
      embeddingChunkSize: parseInt(map['embedding_chunk_size'] ?? '500', 10),
      embeddingChunkOverlap: parseInt(map['embedding_chunk_overlap'] ?? '50', 10),
      drawioEmbedUrl: map['drawio_embed_url'] ?? null,
      // #1115 — the MRL truncation width the image leg requests, or null for
      // the model's native width. Read through its own reader (which discards
      // an out-of-range row) rather than off `map`, so the panel is shown the
      // number the probe and P2's embedder will actually send.
      imageEmbeddingTargetDimensions,
      // Issue #257 — re-embed-all job history retention (default 150, [10, 10000]).
      reembedHistoryRetention: parseInt(map['reembed_history_retention'] ?? '150', 10),
      // Issue #264 — retention for ADMIN_ACCESS_DENIED audit rows
      // (default 90, [7, 3650]). Resolved via getter so the env fallback
      // + hard default cascade stay in one place.
      adminAccessDeniedRetentionDays,
      // AI Safety
      aiGuardrailNoFabrication: guardrails.noFabricationInstruction,
      aiGuardrailNoFabricationEnabled: guardrails.noFabricationEnabled,
      aiOutputRuleStripReferences: outputRules.stripReferences,
      aiOutputRuleReferenceAction: outputRules.referenceAction,
      aiOutputRuleSwissSpelling: outputRules.swissSpelling,
      // Rate limits
      rateLimitGlobal: rateLimits.global.max,
      rateLimitAuth: rateLimits.auth.max,
      rateLimitAdmin: rateLimits.admin.max,
      rateLimitLlmStream: rateLimits.llmStream.max,
      rateLimitLlmEmbedding: rateLimits.llmEmbedding.max,
      // Per-user concurrent SSE-stream cap (#268)
      llmMaxConcurrentStreamsPerUser,
      // Compendiq/compendiq-ee#113 Phase B-3 — cluster-wide LLM queue settings.
      // Read via the cached getters so the response reflects the same value
      // every pod's `_limiter` is using (or will be using within ~1s of any
      // PUT). Both fall back to env / hardcoded defaults when the
      // admin_settings row is absent.
      llmConcurrency: getLlmConcurrency(),
      llmMaxQueueDepth: getLlmMaxQueueDepth(),
      // Issue #1051 — deployment-level self-registration policy.
      registrationMode,
      // #1118 — epic #1100's retrieval knobs, written by the Retrieval sub-tab
      // of Settings → AI Models. Values are what the pipeline resolves right
      // now, so an absent row answers with the reader's own default and the
      // panel never has to restate one.
      ragFetchWidth,
      ragRerankCandidates,
      ragConfidenceThreshold,
      ragConfidenceThresholdRerank,
      ragContextCharsPerPage,
      ragPinIdentifiers,
      ragMmrEnabled: ragMmr.enabled,
      ragMmrLambda: ragMmr.lambda,
      ragRankingPriorWeight,
      // #1115 P2 — the image-index intake knobs.
      ragImagesPerPageMax,
      ragImageIndexExternal,
      // #1115 P3 — the retrieval half.
      ragImageLegEnabled,
      // #1115 P4 — the answer half.
      ragAnswerMaxImages,
      // #1114 — which model each threshold was tuned against, and whether it
      // is still the live one. Provider id + model name only: this payload is
      // the settings document, not the provider document.
      ragConfidenceCalibration,
      // #1285 — the HNSW `ef_search` floor, beside Fetch width on the panel,
      // and whether the deprecated environment variable is what produced it.
      // A failed read reports `false`: the panel must not offer to pin a
      // number the server did not resolve from the variable.
      ragEfSearch: efSearch.value,
      ragEfSearchFromEnv: efSearch.source === 'env',
      collabEditingEnabled: isCollabEditingEnabled(),
    };
  });

  // PUT /api/admin/settings - update shared admin settings (admin only)
  fastify.put('/admin/settings', ADMIN_RATE_LIMIT, async (request) => {
    const body = UpdateAdminSettingsSchema.parse(request.body);

    if (Object.keys(body).length === 0) {
      return { message: 'No changes' };
    }

    const hasChunkChanges =
      body.embeddingChunkSize !== undefined || body.embeddingChunkOverlap !== undefined;

    // Refused BEFORE anything is written (review r9): a chunk change dirties
    // the whole corpus, which a shadow migration forbids — and throwing after
    // the settings upsert would leave the new chunk size persisted with the
    // corpus never re-chunked, i.e. a silently mixed index.
    if (hasChunkChanges) {
      await assertNoShadowMigration();
    }

    // Validate chunk overlap does not exceed 25% of chunk size (only when chunk settings change)
    if (hasChunkChanges) {
      let effectiveChunkSize = body.embeddingChunkSize;
      let effectiveChunkOverlap = body.embeddingChunkOverlap;

      if (effectiveChunkSize === undefined || effectiveChunkOverlap === undefined) {
        const current = await query<{ setting_key: string; setting_value: string }>(
          `SELECT setting_key, setting_value FROM admin_settings
           WHERE setting_key IN ('embedding_chunk_size', 'embedding_chunk_overlap')`,
        );
        const currentMap: Record<string, number> = {};
        for (const row of current.rows) {
          currentMap[row.setting_key] = parseInt(row.setting_value, 10);
        }
        effectiveChunkSize ??= currentMap['embedding_chunk_size'] ?? 500;
        effectiveChunkOverlap ??= currentMap['embedding_chunk_overlap'] ?? 50;
      }

      if (effectiveChunkOverlap > effectiveChunkSize * 0.25) {
        throw fastify.httpErrors.badRequest(
          `Chunk overlap (${effectiveChunkOverlap}) must not exceed 25% of chunk size (${effectiveChunkSize}). Maximum allowed: ${Math.floor(effectiveChunkSize * 0.25)}.`,
        );
      }
    }

    // #1114 — re-validate the FTS language against the SAME contracts enum
    // `UpdateAdminSettingsSchema` used, rather than a second hand-rolled list.
    //
    // This check is redundant on the parse path above and stays deliberately:
    // the stored value is later INTERPOLATED into SQL as a `regconfig` (there
    // is no bind-parameter form for one), so the allow-list is a security
    // boundary and gets a belt-and-braces check on the way in as well as in
    // `getFtsLanguage` on the way out. An invalid value would also break the
    // tsvector rebuild below.
    if (body.ftsLanguage !== undefined && !FtsLanguageEnum.safeParse(body.ftsLanguage).success) {
      throw fastify.httpErrors.badRequest(
        `Invalid FTS language: "${body.ftsLanguage}". Allowed: ${FTS_LANGUAGES.join(', ')}`,
      );
    }

    // Upsert changed settings
    const updates: Array<{ key: string; value: string }> = [];
    if (body.embeddingChunkSize !== undefined) {
      updates.push({ key: 'embedding_chunk_size', value: String(body.embeddingChunkSize) });
    }
    if (body.embeddingChunkOverlap !== undefined) {
      updates.push({ key: 'embedding_chunk_overlap', value: String(body.embeddingChunkOverlap) });
    }
    if (body.drawioEmbedUrl !== undefined) {
      if (body.drawioEmbedUrl === null) {
        // Explicit null clears the setting (falls back to default)
        await query(`DELETE FROM admin_settings WHERE setting_key = 'drawio_embed_url'`);
      } else {
        updates.push({ key: 'drawio_embed_url', value: body.drawioEmbedUrl });
      }
    }
    // #1115 — the image leg's MRL truncation width, with the same three-state
    // semantics: absent leaves it, null clears it back to the model's native
    // width, a number pins what every image-side call requests. Zod already
    // bounded it to [64, 16000]; `columnTypeFor` decides the tier from what the
    // model ANSWERS, so nothing here is interpolated into DDL.
    //
    // Writing it does not re-probe on its own. The panel's Save re-sends the
    // image assignment when this changes, and Re-check is the other entry
    // point — those are the only two moments the column is brought in line.
    if (body.imageEmbeddingTargetDimensions !== undefined) {
      if (body.imageEmbeddingTargetDimensions === null) {
        await query(
          `DELETE FROM admin_settings WHERE setting_key = $1`,
          [IMAGE_EMBEDDING_TARGET_DIMENSIONS_KEY],
        );
      } else {
        updates.push({
          key: IMAGE_EMBEDDING_TARGET_DIMENSIONS_KEY,
          value: String(body.imageEmbeddingTargetDimensions),
        });
      }
    }
    // Per-user concurrent SSE-stream cap (#268). Zod already validated the
    // range [1, 20], so we trust the value here.
    if (body.llmMaxConcurrentStreamsPerUser !== undefined) {
      updates.push({
        key: 'llm_max_concurrent_streams_per_user',
        value: String(body.llmMaxConcurrentStreamsPerUser),
      });
    }

    // Issue #257 — reembed-all job history retention. Zod already enforced
    // the [10, 10000] integer range at the boundary.
    if (body.reembedHistoryRetention !== undefined) {
      updates.push({
        key: 'reembed_history_retention',
        value: String(body.reembedHistoryRetention),
      });
    }

    // Issue #264 — retention (days) for ADMIN_ACCESS_DENIED audit rows.
    // Zod already enforced the [7, 3650] integer range at the boundary.
    if (body.adminAccessDeniedRetentionDays !== undefined) {
      updates.push({
        key: 'admin_access_denied_retention_days',
        value: String(body.adminAccessDeniedRetentionDays),
      });
    }

    // Issue #1051 — deployment-level self-registration policy. Zod already
    // constrained the value to 'open' | 'closed', so it flows through the
    // shared admin_settings UPSERT loop below (and the audit trail).
    if (body.registrationMode !== undefined) {
      updates.push({ key: 'registration_mode', value: body.registrationMode });
    }
    if (body.collabEditingEnabled !== undefined) {
      updates.push({
        key: 'collab_editing_enabled',
        value: body.collabEditingEnabled ? '1' : '0',
      });
    }

    // ─── #1118 — epic #1100's retrieval knobs ─────────────────────────────
    //
    // Zod already mirrored every reader's range, so the values are in-range
    // here. What is NOT free is the SERIALISATION, and two shapes are traps:
    //
    //  - **Exponent notation.** `String(5e-7)` is `'5e-7'`, and every strict
    //    regex guarding a decimal knob rejects it — the write succeeds and the
    //    reader keeps the default. `toFixedDecimalString` is the whole fix.
    //  - **Booleans.** `'true'` / `'false'` is the one pair that satisfies
    //    both parsers: `rag_mmr_enabled` is an ON-list (`1|true|on`) and
    //    `rag_pin_identifiers` an OFF-list (`0|false|off`), so anything else
    //    (`'yes'`, `''`) reads as "leave the default" on one of them.
    const retrievalKnobs: Array<[key: string, invalidate: () => void, value: string | undefined]> = [
      [
        'rag_fetch_width',
        invalidateRagFetchWidthCache,
        body.ragFetchWidth !== undefined ? String(body.ragFetchWidth) : undefined,
      ],
      [
        'rag_rerank_candidates',
        invalidateRagRerankCandidatesCache,
        body.ragRerankCandidates !== undefined ? String(body.ragRerankCandidates) : undefined,
      ],
      [
        'rag_confidence_threshold',
        invalidateRagConfidenceThresholdCache,
        body.ragConfidenceThreshold !== undefined
          ? toFixedDecimalString(body.ragConfidenceThreshold)
          : undefined,
      ],
      [
        'rag_confidence_threshold_rerank',
        invalidateRagConfidenceThresholdCache,
        body.ragConfidenceThresholdRerank !== undefined
          ? toFixedDecimalString(body.ragConfidenceThresholdRerank)
          : undefined,
      ],
      [
        'rag_context_chars_per_page',
        invalidateRagContextCharsCache,
        body.ragContextCharsPerPage !== undefined ? String(body.ragContextCharsPerPage) : undefined,
      ],
      [
        'rag_pin_identifiers',
        invalidateRagPinIdentifiersCache,
        body.ragPinIdentifiers !== undefined ? String(body.ragPinIdentifiers) : undefined,
      ],
      [
        'rag_mmr_enabled',
        invalidateRagMmrCache,
        body.ragMmrEnabled !== undefined ? String(body.ragMmrEnabled) : undefined,
      ],
      [
        'rag_mmr_lambda',
        invalidateRagMmrCache,
        body.ragMmrLambda !== undefined ? toFixedDecimalString(body.ragMmrLambda) : undefined,
      ],
      [
        'rag_ranking_prior_weight',
        invalidateRagRankingPriorCache,
        body.ragRankingPriorWeight !== undefined
          ? toFixedDecimalString(body.ragRankingPriorWeight)
          : undefined,
      ],
      // #1115 P2 — the image-index intake knobs. Both readers share one cache,
      // so both entries invalidate the same one; the boolean is serialised as
      // `'true'`/`'false'`, the one pair that satisfies the OFF-list parser
      // above it (`'yes'` and `''` would read as "leave the default").
      [
        'rag_images_per_page_max',
        invalidateRagImageIntakeCache,
        body.ragImagesPerPageMax !== undefined ? String(body.ragImagesPerPageMax) : undefined,
      ],
      [
        'rag_image_index_external',
        invalidateRagImageIntakeCache,
        body.ragImageIndexExternal !== undefined ? String(body.ragImageIndexExternal) : undefined,
      ],
      // #1115 P3 — the retrieval half, through the same cached path so the
      // next hybrid search reads the new value rather than the old one for up
      // to a minute (#1118's lesson).
      [
        'rag_image_leg_enabled',
        invalidateRagImageLegCache,
        body.ragImageLegEnabled !== undefined ? String(body.ragImageLegEnabled) : undefined,
      ],
      // #1115 P4 — the answer half. `!== undefined`, never a truthiness test:
      // 0 is this knob's off switch (the only one of the three image knobs
      // for which zero is a legal value), and a falsy guard would silently
      // drop the one write an operator turning the feature off can make.
      [
        'rag_answer_max_images',
        invalidateRagAnswerMaxImagesCache,
        body.ragAnswerMaxImages !== undefined ? String(body.ragAnswerMaxImages) : undefined,
      ],
      // #1285 — the `ef_search` floor. The moment this row lands, the
      // deprecated `RAG_EF_SEARCH` variable stops being consulted: the reader
      // falls back to it only for an ABSENT row, so the first save on an
      // instance is also what retires the environment.
      [
        'rag_ef_search',
        invalidateRagEfSearchCache,
        body.ragEfSearch !== undefined ? String(body.ragEfSearch) : undefined,
      ],
    ];
    const invalidateFor = new Map<string, () => void>();
    for (const [key, invalidate, value] of retrievalKnobs) {
      if (value === undefined) continue;
      updates.push({ key, value });
      invalidateFor.set(key, invalidate);
    }

    for (const { key, value } of updates) {
      await query(
        `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (setting_key) DO UPDATE SET setting_value = $2, updated_at = NOW()`,
        [key, value],
      );
      // #1118 — drop the knob's in-process cache as soon as ITS row lands,
      // not in a sweep at the end of the handler. Every `invalidate*` function
      // in `admin-settings-service.ts` shipped EXPORTED WITH NO PRODUCTION
      // CALLSITE — each knob's JSDoc named this handler as the caller that did
      // not exist yet — so a saved value took the full 60-second TTL even on
      // the pod that wrote it, and the settings page refetching straight after
      // the PUT rendered the OLD value back at the admin who had just changed
      // it. Invalidating here rather than after the loop means a write that
      // throws halfway leaves exactly the caches whose rows landed cleared,
      // and no others. Other pods still converge on the TTL, as with the
      // stream cap.
      invalidateFor.get(key)?.();
    }

    if (body.collabEditingEnabled !== undefined) {
      await publish('collab:enabled:changed', { enabled: body.collabEditingEnabled });
      await refreshCollabFlag();
    }

    // ─── #1114 — record which model each written threshold was tuned on ───
    //
    // AFTER the rows land, and only for a threshold THIS body carried. The
    // gating rule is the important half: a PUT that changed the fetch width
    // must not re-date a calibration, because that would certify the rerank
    // threshold against a model nobody tuned it on — the exact false
    // reassurance this record exists to prevent.
    //
    // A re-save of the SAME value re-records deliberately: "save it again to
    // keep it" is the panel's remedy for a stale calibration, and a
    // value-diffed write would make that remedy a no-op.
    //
    // Setting a threshold to 0 clears its record (gate off = nothing
    // calibrated), which `recordConfidenceCalibration` owns.
    // And the outcome is REPORTED (review r3). The route answers 200 whether
    // or not the record landed — the threshold row itself always does — so a
    // panel inferring success from the status code tells the operator
    // "recorded", refetches, and re-renders the very notice whose button they
    // just pressed, with nothing on screen saying why. Neither declining path
    // is reliably transient: an undecryptable `api_key` after a key rotation
    // and an EE policy naming a deleted provider both throw on every attempt.
    const ragConfidenceCalibrationWrite: RagConfidenceCalibrationWrite = {
      similarity: null,
      rerank: null,
    };
    const writtenThresholds: Array<[ConfidenceBasis, number | undefined]> = [
      ['similarity', body.ragConfidenceThreshold],
      ['rerank', body.ragConfidenceThresholdRerank],
    ];
    for (const [basis, threshold] of writtenThresholds) {
      if (threshold === undefined) continue;
      // The resolver is consulted only for a threshold being switched ON;
      // clearing needs no pair, and a provider round-trip on the way to a
      // DELETE would be a failure mode bought for nothing.
      if (!(threshold > 0)) {
        const cleared = await recordConfidenceCalibration(basis, threshold, null);
        ragConfidenceCalibrationWrite[basis] = { outcome: cleared ? 'cleared' : 'failed', model: null };
        continue;
      }
      const live = await resolveConfidenceBasisPair(basis);
      if (!live.resolved) {
        // Review r2 — a resolver FAILURE is not the finding "tuned against
        // nothing". Recording it as one turns a transient DB hiccup or a
        // decrypt error into a permanent, false claim about a threshold saved
        // seconds ago, and the panel then states it as fact ("was set while
        // no embedding model was assigned"). Leave the previous record
        // standing: unknown or unchanged are both honest, and the read path
        // recomputes its verdict on every GET.
        logger.warn(
          { basis, settingKey: CONFIDENCE_THRESHOLD_SETTING_KEYS[basis] },
          'Could not resolve the model behind a confidence threshold — calibration left as it was',
        );
        ragConfidenceCalibrationWrite[basis] = { outcome: 'unresolved', model: null };
        continue;
      }
      const recorded = await recordConfidenceCalibration(basis, threshold, live.pair);
      ragConfidenceCalibrationWrite[basis] = recorded
        ? { outcome: 'recorded', model: live.pair?.model ?? null }
        : { outcome: 'failed', model: null };
    }

    // ─── #113 Phase B-3 — cluster-wide LLM queue settings ─────────────────
    // These do NOT go through the `updates` UPSERT loop above — the
    // dedicated setters in `llm-queue.ts` UPSERT the row AND publish on
    // the `admin:llm:settings` cache-bus channel so every other pod
    // re-reads and updates its `pLimit` limiter's `concurrency` in place
    // (see #404). The local pod's limiter is also updated via the same
    // subscriber path; the route handler does NOT call `setConcurrency()`
    // directly.
    //
    // Zod has already validated the ranges ([1, 100] and [1, 1000]); the
    // setters defensively clamp again to keep the queue safe even if a
    // future caller bypasses Zod.
    if (body.llmConcurrency !== undefined) {
      await setLlmConcurrencyClusterWide(body.llmConcurrency);
    }
    if (body.llmMaxQueueDepth !== undefined) {
      await setLlmMaxQueueDepthClusterWide(body.llmMaxQueueDepth);
    }

    // Invalidate the SSE-stream cap cache in-process so the new value takes
    // effect immediately in this worker. Other workers pick it up within the
    // 60-second TTL (same contract as `rate-limit-service`).
    if (body.llmMaxConcurrentStreamsPerUser !== undefined) {
      invalidateStreamCapCache();
    }

    // AI Safety settings
    const hasAiGuardrailChanges =
      body.aiGuardrailNoFabrication !== undefined || body.aiGuardrailNoFabricationEnabled !== undefined;
    const hasAiOutputRuleChanges =
      body.aiOutputRuleStripReferences !== undefined ||
      body.aiOutputRuleReferenceAction !== undefined ||
      body.aiOutputRuleSwissSpelling !== undefined;

    if (hasAiGuardrailChanges) {
      // Sanitize admin-supplied guardrail text to prevent prompt injection (critic fix #6)
      let sanitizedInstruction = body.aiGuardrailNoFabrication;
      if (sanitizedInstruction !== undefined) {
        const { sanitized } = sanitizeLlmInput(sanitizedInstruction);
        sanitizedInstruction = sanitized;
      }
      await upsertAiGuardrails(
        {
          noFabricationInstruction: sanitizedInstruction,
          noFabricationEnabled: body.aiGuardrailNoFabricationEnabled,
        },
        request.userId,
      );
    }

    if (hasAiOutputRuleChanges) {
      await upsertAiOutputRules(
        {
          stripReferences: body.aiOutputRuleStripReferences,
          referenceAction: body.aiOutputRuleReferenceAction,
          swissSpelling: body.aiOutputRuleSwissSpelling,
        },
        request.userId,
      );
    }

    // Rate limit updates
    const rateLimitUpdates: Record<string, number> = {};
    if (body.rateLimitGlobal !== undefined) rateLimitUpdates.global = body.rateLimitGlobal;
    if (body.rateLimitAuth !== undefined) rateLimitUpdates.auth = body.rateLimitAuth;
    if (body.rateLimitAdmin !== undefined) rateLimitUpdates.admin = body.rateLimitAdmin;
    if (body.rateLimitLlmStream !== undefined) rateLimitUpdates.llmStream = body.rateLimitLlmStream;
    if (body.rateLimitLlmEmbedding !== undefined) rateLimitUpdates.llmEmbedding = body.rateLimitLlmEmbedding;

    if (Object.keys(rateLimitUpdates).length > 0) {
      await upsertRateLimits(rateLimitUpdates, request.userId);
      logger.info({ userId: request.userId, rateLimitUpdates }, 'Admin rate limits updated (takes effect within 60s)');
    }

    // Only mark pages dirty for re-embedding when chunk settings changed — NOT for drawioEmbedUrl
    //
    // Knowingly left unbounded (review r4): this is the same no-WHERE,
    // corpus-wide `UPDATE pages` on a pooled connection that the keyword-index
    // rebuild below now bounds with `lock_timeout`, and it carries no
    // cancellation of its own on a deployment that does not set
    // `PG_STATEMENT_TIMEOUT`. Pre-existing and out of scope here; wrapping it
    // in the same bounded transaction is a follow-up.
    if (hasChunkChanges) {
      await query('UPDATE pages SET embedding_dirty = TRUE');
      logger.info({ userId: request.userId, updates }, 'Admin chunk settings changed, all pages marked dirty');
    }

    // ─── #1114 — the keyword-index language ───────────────────────────────
    //
    // LAST of the writes, and in ONE transaction. Two separate `query()` calls
    // autocommit on pooled connections (possibly different ones), so the row
    // landed before the rebuild started: a rebuild that failed left
    // `fts_language = german` with every `tsv` still built as `simple`, the
    // panel reporting a language search was not using, and Save disabled on
    // reload because the stored value already matched — the exact silent
    // keyword-leg collapse this control exists to end, under copy promising
    // the rebuild.
    //
    // `SET LOCAL statement_timeout = 0` for the same reason
    // `shadow-migration-service.ts` sets it: a deployment that sets
    // `PG_STATEMENT_TIMEOUT` applies it to every pooled connection, and a
    // corpus-wide UPDATE is precisely the statement that outlives it — so on
    // those instances the save would fail deterministically, every time.
    // `SET LOCAL`, so it lasts exactly this transaction.
    //
    // And `SET LOCAL lock_timeout` beside it, for the reason the same
    // precedent pairs the two (review r3). Lifting `statement_timeout`
    // removes the ONLY cancellation this statement had, and `UPDATE pages`
    // with no WHERE is the widest lock the app takes: a row held by an
    // in-flight page save would otherwise make this wait forever, holding one
    // of `PG_POOL_MAX` connections and blocking every page write queued
    // behind it, with no way out for the admin (closing the browser tab does
    // not cancel a PostgreSQL statement). The rebuild's own *work* stays
    // unbounded, which is the point; what is bounded is that **no single lock
    // wait exceeds 30s** — `lock_timeout` applies to every lock this statement
    // waits on, not merely the first, so the scan may run arbitrarily long
    // while making progress and still aborts the moment it blocks anywhere for
    // 30 seconds. Unbounded work, never an indefinite block.
    // 30s rather than the swap's 5s because there is no retry loop here and
    // the admin is already waiting on a corpus-wide rebuild — but a timeout
    // lands in the catch below, so it rolls back to the honest, retryable
    // "the language was not changed" 503 instead of hanging.
    //
    // It runs after every other write — the knob loop, the queue setters, the
    // rate limits and `embedding_dirty` — because it is the only statement in
    // this handler that can throw at this point, and the r9 invariant above
    // covers more than the settings row: throwing between the chunk-size
    // upsert and `UPDATE pages SET embedding_dirty` would leave the new chunk
    // size persisted with the corpus never re-chunked, which is the same
    // silently mixed index, reached from the other side (review r2). The audit
    // event is written below for what actually landed, whichever way this goes.
    let ftsRebuildError: unknown;
    if (body.ftsLanguage !== undefined) {
      const client = await getPool().connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL statement_timeout = 0');
        await client.query(`SET LOCAL lock_timeout = '${FTS_REBUILD_LOCK_TIMEOUT_MS}ms'`);
        await client.query(
          `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
           VALUES ('fts_language', $1, NOW())
           ON CONFLICT (setting_key) DO UPDATE SET setting_value = $1, updated_at = NOW()`,
          [body.ftsLanguage],
        );
        // No `deleted_at IS NULL` filter (review r2). The maintenance trigger
        // is `BEFORE INSERT OR UPDATE OF title, body_text`, and the restore
        // path (`pages-crud.ts`) only clears `deleted_at` — so a page skipped
        // here comes back out of the trash carrying a `tsv` built with the
        // PREVIOUS configuration, permanently out of step with the rest of
        // the corpus and with nothing that ever rebuilds it. Trash is small,
        // the write is idempotent, and it is what makes "every page" true.
        await client.query(
          `UPDATE pages SET tsv = to_tsvector(
            $1::regconfig,
            coalesce(title, '') || ' ' || coalesce(body_text, '')
          )`,
          [body.ftsLanguage],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        logger.error(
          { err, ftsLanguage: body.ftsLanguage },
          'Keyword-index rebuild failed — the language was not changed',
        );
        ftsRebuildError = err;
      } finally {
        client.release();
      }
    }

    // What actually landed. A rolled-back rebuild leaves no language change,
    // so recording one would put a change in the audit trail that the database
    // does not have.
    const auditDetails = { ...body };
    if (ftsRebuildError !== undefined) delete auditDetails.ftsLanguage;

    await logAuditEvent(
      request.userId,
      'ADMIN_ACTION',
      'admin_settings',
      undefined,
      { action: 'update_admin_settings', ...auditDetails },
      request,
    );

    if (ftsRebuildError !== undefined) {
      // 503, not 500. `app.ts`'s error handler replaces the body message of
      // every 500 with a flat 'Internal Server Error' (pinned by
      // `app.test.ts`), so a 500 delivers none of this to the panel — the
      // admin waits out a corpus-wide rebuild and is told nothing but the
      // status. Any non-500 status keeps `error.message`, and 503 is the
      // honest one: the rebuild could not be completed now, and retrying is
      // safe. The raw driver message stays in the log, not on the wire.
      const alsoSaved = Object.keys(body).length > 1;
      throw fastify.httpErrors.serviceUnavailable(
        alsoSaved
          ? 'Rebuilding the keyword index failed. The keyword index language was not changed; the other settings in this request were saved.'
          : 'Rebuilding the keyword index failed. The keyword index language was not changed.',
      );
    }

    if (hasChunkChanges) {
      return {
        message: 'Admin settings updated, all pages queued for re-embedding',
        ragConfidenceCalibrationWrite,
      } satisfies UpdateAdminSettingsResult;
    }
    return {
      message: 'Admin settings updated',
      ragConfidenceCalibrationWrite,
    } satisfies UpdateAdminSettingsResult;
  });

  // ── SMTP / Email settings ───────────────────────────────────────────────

  // GET /api/admin/smtp - Get current SMTP configuration
  fastify.get('/admin/smtp', async () => {
    return getSmtpConfig();
  });

  // PUT /api/admin/smtp - Update SMTP configuration
  const SmtpUpdateSchema = z.object({
    host: z.string().optional(),
    port: z.number().int().min(1).max(65535).optional(),
    secure: z.boolean().optional(),
    user: z.string().optional(),
    pass: z.string().optional(),
    from: z.string().optional(),
    enabled: z.boolean().optional(),
  });

  fastify.put('/admin/smtp', async (request) => {
    // #743 — one shared guard: strip the masked-password sentinel round-tripped
    // by the UI before BOTH the live-transport update and the DB persist below.
    const body = stripMaskedSmtpPass(SmtpUpdateSchema.parse(request.body));
    updateSmtpConfig(body);

    // Persist to admin_settings table
    const entries: Array<{ key: string; value: string }> = [];
    if (body.host !== undefined) entries.push({ key: 'smtp_host', value: body.host });
    if (body.port !== undefined) entries.push({ key: 'smtp_port', value: String(body.port) });
    if (body.secure !== undefined) entries.push({ key: 'smtp_secure', value: String(body.secure) });
    if (body.user !== undefined) entries.push({ key: 'smtp_user', value: body.user });
    // issue #738 — encrypt at rest with the versioned PAT helpers. The masked
    // sentinel was already stripped from `body` above (#743), so any defined
    // value here is a real update. An empty string clears the password and is
    // stored as-is (it is not a secret).
    if (body.pass !== undefined) {
      entries.push({ key: 'smtp_pass', value: body.pass ? encryptPat(body.pass) : '' });
    }
    if (body.from !== undefined) entries.push({ key: 'smtp_from', value: body.from });
    if (body.enabled !== undefined) entries.push({ key: 'smtp_enabled', value: String(body.enabled) });

    if (entries.length > 0) {
      const keys = entries.map((e) => e.key);
      const values = entries.map((e) => e.value);
      await query(
        `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
         SELECT key, value, NOW()
         FROM unnest($1::text[], $2::text[]) AS t(key, value)
         ON CONFLICT (setting_key) DO UPDATE
         SET setting_value = EXCLUDED.setting_value, updated_at = NOW()`,
        [keys, values],
      );
    }

    await logAuditEvent(request.userId, 'ADMIN_ACTION', 'admin_settings', undefined, { action: 'update_smtp_settings' }, request);
    return { message: 'SMTP settings updated' };
  });

  // POST /api/admin/smtp/test - Send test email
  const SmtpTestSchema = z.object({ to: z.string().email() });

  fastify.post('/admin/smtp/test', async (request) => {
    const { to } = SmtpTestSchema.parse(request.body);
    return sendTestEmail(to);
  });
}
