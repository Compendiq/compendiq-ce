import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../../core/db/postgres.js';
import { reEncryptPat } from '../../core/utils/crypto.js';
import { getAuditLog, logAuditEvent } from '../../core/services/audit-service.js';
import { listErrors, resolveError, getErrorSummary } from '../../core/services/error-tracker.js';
import { logger } from '../../core/utils/logger.js';
import { UpdateAdminSettingsSchema } from '@compendiq/contracts';
import { getEmbeddingDimensions } from '../../core/services/admin-settings-service.js';
import { getAiGuardrails, getAiOutputRules, upsertAiGuardrails, upsertAiOutputRules } from '../../core/services/ai-safety-service.js';
import { getRateLimits, upsertRateLimits } from '../../core/services/rate-limit-service.js';
import { sanitizeLlmInput } from '../../core/utils/sanitize-llm-input.js';
import { ALLOWED_FTS_LANGUAGES } from '../../core/services/fts-language.js';
import { getSmtpConfig, updateSmtpConfig, sendTestEmail } from '../../core/services/email-service.js';

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

export async function adminRoutes(fastify: FastifyInstance) {
  // All admin routes require admin role
  fastify.addHook('onRequest', fastify.requireAdmin);

  // POST /api/admin/rotate-encryption-key - re-encrypt all PATs with the latest key
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

    for (const row of result.rows) {
      try {
        const reEncrypted = reEncryptPat(row.confluence_pat);
        if (reEncrypted) {
          await query(
            'UPDATE user_settings SET confluence_pat = $1 WHERE user_id = $2',
            [reEncrypted, row.user_id],
          );
          rotated++;
        } else {
          skipped++; // Already using latest key
        }
      } catch (err) {
        errors++;
        logger.error({ err, userId: row.user_id }, 'Failed to re-encrypt PAT for user');
      }
    }

    await logAuditEvent(
      userId,
      'ENCRYPTION_KEY_ROTATED',
      'system',
      undefined,
      { rotated, skipped, errors, totalPats: result.rows.length },
      request,
    );

    logger.info({ rotated, skipped, errors }, 'Encryption key rotation completed');

    return {
      message: 'Encryption key rotation completed',
      rotated,
      skipped,
      errors,
      total: result.rows.length,
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
    const [embeddingDimensions, guardrails, outputRules, rateLimits] = await Promise.all([
      getEmbeddingDimensions(),
      getAiGuardrails(),
      getAiOutputRules(),
      getRateLimits(),
    ]);
    const result = await query<{ setting_key: string; setting_value: string }>(
      `SELECT setting_key, setting_value FROM admin_settings
       WHERE setting_key IN ('embedding_chunk_size', 'embedding_chunk_overlap', 'drawio_embed_url', 'fts_language', 'reembed_history_retention')`,
    );

    const map: Record<string, string> = {};
    for (const row of result.rows) {
      map[row.setting_key] = row.setting_value;
    }

    return {
      embeddingDimensions,
      ftsLanguage: map['fts_language'] ?? process.env.FTS_LANGUAGE ?? 'simple',
      embeddingChunkSize: parseInt(map['embedding_chunk_size'] ?? '500', 10),
      embeddingChunkOverlap: parseInt(map['embedding_chunk_overlap'] ?? '50', 10),
      drawioEmbedUrl: map['drawio_embed_url'] ?? null,
      // Issue #257 — re-embed-all job history retention (default 150, [10, 10000]).
      reembedHistoryRetention: parseInt(map['reembed_history_retention'] ?? '150', 10),
      // AI Safety
      aiGuardrailNoFabrication: guardrails.noFabricationInstruction,
      aiGuardrailNoFabricationEnabled: guardrails.noFabricationEnabled,
      aiOutputRuleStripReferences: outputRules.stripReferences,
      aiOutputRuleReferenceAction: outputRules.referenceAction,
      // Rate limits
      rateLimitGlobal: rateLimits.global.max,
      rateLimitAuth: rateLimits.auth.max,
      rateLimitAdmin: rateLimits.admin.max,
      rateLimitLlmStream: rateLimits.llmStream.max,
      rateLimitLlmEmbedding: rateLimits.llmEmbedding.max,
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

    // Validate FTS language before persisting (invalid values would break the tsvector trigger)
    if (body.ftsLanguage !== undefined && !ALLOWED_FTS_LANGUAGES.has(body.ftsLanguage)) {
      throw fastify.httpErrors.badRequest(
        `Invalid FTS language: "${body.ftsLanguage}". Allowed: ${[...ALLOWED_FTS_LANGUAGES].join(', ')}`,
      );
    }

    if (body.ftsLanguage !== undefined) {
      // Persist the new fts_language and rebuild all tsvectors with it.
      await query(
        `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
         VALUES ('fts_language', $1, NOW())
         ON CONFLICT (setting_key) DO UPDATE SET setting_value = $1, updated_at = NOW()`,
        [body.ftsLanguage],
      );
      await query(
        `UPDATE pages SET tsv = to_tsvector(
          $1::regconfig,
          coalesce(title, '') || ' ' || coalesce(body_text, '')
        ) WHERE deleted_at IS NULL`,
        [body.ftsLanguage],
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

    // Issue #257 — reembed-all job history retention. Zod already enforced
    // the [10, 10000] integer range at the boundary.
    if (body.reembedHistoryRetention !== undefined) {
      updates.push({
        key: 'reembed_history_retention',
        value: String(body.reembedHistoryRetention),
      });
    }

    for (const { key, value } of updates) {
      await query(
        `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (setting_key) DO UPDATE SET setting_value = $2, updated_at = NOW()`,
        [key, value],
      );
    }

    // AI Safety settings
    const hasAiGuardrailChanges =
      body.aiGuardrailNoFabrication !== undefined || body.aiGuardrailNoFabricationEnabled !== undefined;
    const hasAiOutputRuleChanges =
      body.aiOutputRuleStripReferences !== undefined || body.aiOutputRuleReferenceAction !== undefined;

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
    if (hasChunkChanges) {
      await query('UPDATE pages SET embedding_dirty = TRUE');
      logger.info({ userId: request.userId, updates }, 'Admin chunk settings changed, all pages marked dirty');
    }

    const auditDetails = { ...body };

    await logAuditEvent(
      request.userId,
      'ADMIN_ACTION',
      'admin_settings',
      undefined,
      { action: 'update_admin_settings', ...auditDetails },
      request,
    );

    if (hasChunkChanges) {
      return { message: 'Admin settings updated, all pages queued for re-embedding' };
    }
    return { message: 'Admin settings updated' };
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
    const body = SmtpUpdateSchema.parse(request.body);
    updateSmtpConfig(body);

    // Persist to admin_settings table
    const entries: Array<{ key: string; value: string }> = [];
    if (body.host !== undefined) entries.push({ key: 'smtp_host', value: body.host });
    if (body.port !== undefined) entries.push({ key: 'smtp_port', value: String(body.port) });
    if (body.secure !== undefined) entries.push({ key: 'smtp_secure', value: String(body.secure) });
    if (body.user !== undefined) entries.push({ key: 'smtp_user', value: body.user });
    if (body.pass !== undefined && body.pass !== '••••••••') entries.push({ key: 'smtp_pass', value: body.pass });
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
