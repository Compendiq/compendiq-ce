import { FastifyInstance } from 'fastify';
import { request as undiciRequest } from 'undici';
import { UpdateSettingsSchema, TestConfluenceSchema } from '@kb-creator/contracts';
import { query } from '../db/postgres.js';
import { encryptPat, decryptPat } from '../utils/crypto.js';
import { validateUrl } from '../utils/ssrf-guard.js';
import { logAuditEvent } from '../services/audit-service.js';
import { setActiveProvider } from '../services/ollama-service.js';
import { getSyncOverview } from '../services/sync-overview-service.js';
import { logger } from '../utils/logger.js';
import { confluenceDispatcher } from '../utils/tls-config.js';

export async function settingsRoutes(fastify: FastifyInstance) {
  // All settings routes require auth
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.get('/settings', async (request) => {
    const result = await query<{
      confluence_url: string | null;
      confluence_pat: string | null;
      ollama_model: string;
      llm_provider: string;
      openai_base_url: string | null;
      openai_api_key: string | null;
      openai_model: string | null;
      theme: string;
      sync_interval_min: number;
      show_space_home_content: boolean;
      custom_prompts: Record<string, string>;
    }>(
      'SELECT confluence_url, confluence_pat, ollama_model, llm_provider, openai_base_url, openai_api_key, openai_model, theme, sync_interval_min, show_space_home_content, custom_prompts FROM user_settings WHERE user_id = $1',
      [request.userId],
    );

    // Fetch selected spaces from user_space_selections
    const spacesResult = await query<{ space_key: string }>(
      'SELECT space_key FROM user_space_selections WHERE user_id = $1 ORDER BY space_key',
      [request.userId],
    );
    const selectedSpaces = spacesResult.rows.map((r) => r.space_key);

    if (result.rows.length === 0) {
      // Create default settings if missing
      await query('INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [request.userId]);
      return {
        confluenceUrl: null,
        hasConfluencePat: false,
        selectedSpaces,
        ollamaModel: 'qwen3.5',
        llmProvider: 'ollama' as const,
        openaiBaseUrl: null,
        hasOpenaiApiKey: false,
        openaiModel: null,
        embeddingModel: process.env.EMBEDDING_MODEL ?? 'nomic-embed-text',
        theme: 'glass-dark',
        syncIntervalMin: 15,
        confluenceConnected: false,
        showSpaceHomeContent: true,
        customPrompts: {},
      };
    }

    const row = result.rows[0];
    return {
      confluenceUrl: row.confluence_url,
      hasConfluencePat: !!row.confluence_pat,
      selectedSpaces,
      ollamaModel: row.ollama_model,
      llmProvider: (row.llm_provider ?? 'ollama') as 'ollama' | 'openai',
      openaiBaseUrl: row.openai_base_url,
      hasOpenaiApiKey: !!row.openai_api_key,
      openaiModel: row.openai_model,
      embeddingModel: process.env.EMBEDDING_MODEL ?? 'nomic-embed-text',
      theme: row.theme,
      syncIntervalMin: row.sync_interval_min,
      confluenceConnected: !!(row.confluence_url && row.confluence_pat),
      showSpaceHomeContent: row.show_space_home_content,
      customPrompts: row.custom_prompts ?? {},
    };
  });

  fastify.get('/settings/sync-overview', async (request) => {
    return getSyncOverview(request.userId);
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

    if (body.showSpaceHomeContent !== undefined) {
      updates.push(`show_space_home_content = $${paramIdx++}`);
      values.push(body.showSpaceHomeContent);
    }

    if (body.llmProvider !== undefined) {
      updates.push(`llm_provider = $${paramIdx++}`);
      values.push(body.llmProvider);
    }

    if (body.openaiBaseUrl !== undefined) {
      updates.push(`openai_base_url = $${paramIdx++}`);
      values.push(body.openaiBaseUrl);
    }

    if (body.openaiApiKey !== undefined && body.openaiApiKey !== null) {
      updates.push(`openai_api_key = $${paramIdx++}`);
      values.push(encryptPat(body.openaiApiKey));
    }

    if (body.openaiModel !== undefined) {
      updates.push(`openai_model = $${paramIdx++}`);
      values.push(body.openaiModel);
    }

    if (body.customPrompts !== undefined) {
      updates.push(`custom_prompts = $${paramIdx++}`);
      values.push(JSON.stringify(body.customPrompts));
    }

    // Handle selectedSpaces via user_space_selections table
    if (body.selectedSpaces !== undefined) {
      const newSpaces = body.selectedSpaces;

      // Delete spaces no longer selected by this user
      await query(
        'DELETE FROM user_space_selections WHERE user_id = $1 AND space_key <> ALL($2::text[])',
        [request.userId, newSpaces],
      );

      // Insert newly selected spaces (idempotent)
      for (const spaceKey of newSpaces) {
        await query(
          'INSERT INTO user_space_selections (user_id, space_key) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [request.userId, spaceKey],
        );
      }
    }

    if (updates.length > 0) {
      updates.push(`updated_at = NOW()`);
      values.push(request.userId);

      await query(
        `UPDATE user_settings SET ${updates.join(', ')} WHERE user_id = $${paramIdx}`,
        values,
      );
    }

    // If LLM provider changed, update the active in-memory provider
    if (body.llmProvider !== undefined) {
      setActiveProvider(body.llmProvider as 'ollama' | 'openai');
    }

    // If PAT or URL changed, invalidate user-specific cached data (ADR-017)
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
    const { url, pat: patFromBody } = TestConfluenceSchema.parse(request.body);

    // Resolve PAT: use body value if provided, otherwise fall back to stored encrypted PAT
    let resolvedPat: string;
    if (patFromBody) {
      resolvedPat = patFromBody;
    } else {
      const stored = await query<{ confluence_pat: string | null }>(
        'SELECT confluence_pat FROM user_settings WHERE user_id = $1',
        [request.userId],
      );
      const encryptedPat = stored.rows[0]?.confluence_pat ?? null;
      if (!encryptedPat) {
        return { success: false, message: 'No PAT saved — save settings first' };
      }
      try {
        resolvedPat = decryptPat(encryptedPat);
      } catch {
        return { success: false, message: 'Stored PAT could not be decrypted' };
      }
    }

    // SSRF protection: use centralized validator
    try {
      validateUrl(url);
    } catch {
      return { success: false, message: 'URL blocked: cannot connect to internal/private network addresses' };
    }

    try {
      const opts: Record<string, unknown> = {
        method: 'GET',
        headers: { Authorization: `Bearer ${resolvedPat}` },
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
  // When a user's PAT/URL changes, their space selections are no longer valid.
  // Clear their space selections so they re-configure with the new credentials.
  // Shared tables (cached_pages, cached_spaces, page_embeddings) are NOT deleted here
  // because they are shared across users. Pages are only removed via sync when no
  // user selects the space.
  await query('DELETE FROM user_space_selections WHERE user_id = $1', [userId]);

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
