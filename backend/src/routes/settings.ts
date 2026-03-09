import { FastifyInstance } from 'fastify';
import { request as undiciRequest } from 'undici';
import { UpdateSettingsSchema, TestConfluenceSchema } from '@kb-creator/contracts';
import { query } from '../db/postgres.js';
import { encryptPat } from '../utils/crypto.js';
import { validateUrl } from '../utils/ssrf-guard.js';
import { logAuditEvent } from '../services/audit-service.js';
import { logger } from '../utils/logger.js';
import { confluenceDispatcher } from '../utils/tls-config.js';

export async function settingsRoutes(fastify: FastifyInstance) {
  // All settings routes require auth
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.get('/settings', async (request) => {
    const result = await query<{
      confluence_url: string | null;
      confluence_pat: string | null;
      selected_spaces: string[];
      ollama_model: string;
      theme: string;
      sync_interval_min: number;
    }>(
      'SELECT confluence_url, confluence_pat, selected_spaces, ollama_model, theme, sync_interval_min FROM user_settings WHERE user_id = $1',
      [request.userId],
    );

    if (result.rows.length === 0) {
      // Create default settings if missing
      await query('INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [request.userId]);
      return {
        confluenceUrl: null,
        hasConfluencePat: false,
        selectedSpaces: [],
        ollamaModel: 'qwen3.5',
        embeddingModel: process.env.EMBEDDING_MODEL ?? 'nomic-embed-text',
        theme: 'glass-dark',
        syncIntervalMin: 15,
        confluenceConnected: false,
      };
    }

    const row = result.rows[0];
    return {
      confluenceUrl: row.confluence_url,
      hasConfluencePat: !!row.confluence_pat,
      selectedSpaces: row.selected_spaces ?? [],
      ollamaModel: row.ollama_model,
      embeddingModel: process.env.EMBEDDING_MODEL ?? 'nomic-embed-text',
      theme: row.theme,
      syncIntervalMin: row.sync_interval_min,
      confluenceConnected: !!(row.confluence_url && row.confluence_pat),
    };
  });

  fastify.put('/settings', async (request) => {
    const body = UpdateSettingsSchema.parse(request.body);

    const updates: string[] = [];
    const values: unknown[] = [];
    let paramIdx = 1;

    if (body.confluenceUrl !== undefined) {
      updates.push(`confluence_url = $${paramIdx++}`);
      values.push(body.confluenceUrl);
    }

    if (body.confluencePat !== undefined && body.confluencePat !== null) {
      updates.push(`confluence_pat = $${paramIdx++}`);
      values.push(encryptPat(body.confluencePat));
    }

    if (body.selectedSpaces !== undefined) {
      updates.push(`selected_spaces = $${paramIdx++}`);
      values.push(body.selectedSpaces);
    }

    if (body.ollamaModel !== undefined) {
      updates.push(`ollama_model = $${paramIdx++}`);
      values.push(body.ollamaModel);
    }

    if (body.theme !== undefined) {
      updates.push(`theme = $${paramIdx++}`);
      values.push(body.theme);
    }

    if (body.syncIntervalMin !== undefined) {
      updates.push(`sync_interval_min = $${paramIdx++}`);
      values.push(body.syncIntervalMin);
    }

    if (updates.length === 0) {
      return { message: 'No changes' };
    }

    updates.push(`updated_at = NOW()`);
    values.push(request.userId);

    await query(
      `UPDATE user_settings SET ${updates.join(', ')} WHERE user_id = $${paramIdx}`,
      values,
    );

    // If PAT or URL changed, invalidate all user data (ADR-017)
    if (body.confluencePat !== undefined || body.confluenceUrl !== undefined) {
      logger.info({ userId: request.userId }, 'PAT/URL changed, invalidating user cache');
      await invalidateUserData(request.userId, fastify);
    }

    // Audit log
    const changedFields = Object.keys(body).filter((k) => (body as Record<string, unknown>)[k] !== undefined);
    if (body.confluencePat !== undefined) {
      await logAuditEvent(request.userId, 'PAT_UPDATED', 'settings', request.userId, {}, request);
    }
    await logAuditEvent(request.userId, 'SETTINGS_CHANGED', 'settings', request.userId, { changedFields }, request);

    return { message: 'Settings updated' };
  });

  fastify.post('/settings/test-confluence', async (request) => {
    const { url, pat } = TestConfluenceSchema.parse(request.body);

    // SSRF protection: use centralized validator
    try {
      validateUrl(url);
    } catch {
      return { success: false, message: 'URL blocked: cannot connect to internal/private network addresses' };
    }

    try {
      const opts: Record<string, unknown> = {
        method: 'GET',
        headers: { Authorization: `Bearer ${pat}` },
        signal: AbortSignal.timeout(10_000),
      };
      if (confluenceDispatcher) {
        opts.dispatcher = confluenceDispatcher;
      }

      const { statusCode, body: responseBody } = await undiciRequest(
        `${url}/rest/api/space?limit=1`,
        opts as Parameters<typeof undiciRequest>[1],
      );
      // Drain response body to avoid memory leak
      await responseBody.dump();

      if (statusCode >= 200 && statusCode < 300) {
        return { success: true, message: 'Connection successful' };
      }
      return { success: false, message: `HTTP ${statusCode}` };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Connection failed';
      const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : '';
      const detail = cause && cause !== message ? `${message}: ${cause}` : message;
      logger.warn({ err, url }, 'Confluence test connection failed');
      return { success: false, message: detail };
    }
  });
}

async function invalidateUserData(userId: string, fastify: FastifyInstance): Promise<void> {
  // Delete cached data for user (ADR-017)
  await query('DELETE FROM page_embeddings WHERE user_id = $1', [userId]);
  await query('DELETE FROM cached_pages WHERE user_id = $1', [userId]);
  await query('DELETE FROM cached_spaces WHERE user_id = $1', [userId]);

  // Invalidate Redis keys using SCAN (avoids O(N) KEYS command)
  try {
    let cursor = '0';
    do {
      const result = await fastify.redis.scan(cursor, { MATCH: `kb:${userId}:*`, COUNT: 100 });
      cursor = String(result.cursor);
      if (result.keys.length > 0) {
        await fastify.redis.del(result.keys);
      }
    } while (cursor !== '0');
  } catch (err) {
    logger.error({ err, userId }, 'Failed to invalidate Redis cache');
  }
}
