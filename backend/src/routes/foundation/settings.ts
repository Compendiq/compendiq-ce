import { FastifyInstance } from 'fastify';
import { request as undiciRequest } from 'undici';
import { UpdateSettingsSchema, TestConfluenceSchema } from '@compendiq/contracts';
import { query } from '../../core/db/postgres.js';
import { RedisCache } from '../../core/services/redis-cache.js';
import { encryptPat, decryptPat } from '../../core/utils/crypto.js';
import { validateUrlSyntaxAndProtocol, addAllowedBaseUrl, removeAllowedBaseUrl, resolveConfluenceUrl } from '../../core/utils/ssrf-guard.js';
import { logAuditEvent } from '../../core/services/audit-service.js';
import { getSelectedSyncSpaces, invalidateRbacCache } from '../../core/services/rbac-service.js';
import { getSyncOverview } from '../../domains/confluence/services/sync-overview-service.js';
import { getClientForUser } from '../../domains/confluence/services/sync-service.js';
import { logger } from '../../core/utils/logger.js';
import { confluenceDispatcher } from '../../core/utils/tls-config.js';
import { getAiGuardrails, getAiOutputRules } from '../../core/services/ai-safety-service.js';

export async function settingsRoutes(fastify: FastifyInstance) {
  // All settings routes require auth
  fastify.addHook('onRequest', fastify.authenticate);
  const cache = new RedisCache(fastify.redis);

  fastify.get('/settings', async (request) => {
    const result = await query<{
      confluence_url: string | null;
      confluence_pat: string | null;
      theme: string;
      sync_interval_min: number;
      show_space_home_content: boolean;
      custom_prompts: Record<string, string>;
      confluence_pat_prompt_dismissed_at: Date | null;
    }>(
      'SELECT confluence_url, confluence_pat, theme, sync_interval_min, show_space_home_content, custom_prompts, confluence_pat_prompt_dismissed_at FROM user_settings WHERE user_id = $1',
      [request.userId],
    );
    // #721: Use explicit editor assignments rather than getUserAccessibleSpaces
    // so that admins see only the spaces they've chosen to sync — not every
    // space in the DB (which getUserAccessibleSpaces returns for admins).
    const selectedSpaces = await getSelectedSyncSpaces(request.userId);
    selectedSpaces.sort();

    if (result.rows.length === 0) {
      // Create default settings if missing
      await query('INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [request.userId]);
      return {
        confluenceUrl: null,
        hasConfluencePat: false,
        selectedSpaces,
        theme: 'glass-dark',
        syncIntervalMin: 15,
        confluenceConnected: false,
        showSpaceHomeContent: true,
        customPrompts: {},
        confluencePatPromptDismissed: false,
      };
    }

    const row = result.rows[0]!;
    return {
      confluenceUrl: row.confluence_url,
      hasConfluencePat: !!row.confluence_pat,
      selectedSpaces,
      theme: row.theme,
      syncIntervalMin: row.sync_interval_min,
      confluenceConnected: !!(row.confluence_url && row.confluence_pat),
      showSpaceHomeContent: row.show_space_home_content,
      customPrompts: row.custom_prompts ?? {},
      // #771: boolean only — the dismissal timestamp stays server-side.
      confluencePatPromptDismissed: !!row.confluence_pat_prompt_dismissed_at,
    };
  });

  fastify.get('/settings/sync-overview', async (request) => {
    return getSyncOverview(request.userId);
  });

  // GET /api/settings/drawio-url — read the configured draw.io embed URL (any authenticated user)
  // Auth is inherited from the onRequest hook above. No admin gating needed — all users load the editor.
  fastify.get('/settings/drawio-url', async () => {
    const result = await query<{ setting_value: string }>(
      `SELECT setting_value FROM admin_settings WHERE setting_key = 'drawio_embed_url'`,
    );
    return { drawioEmbedUrl: result.rows[0]?.setting_value ?? 'https://embed.diagrams.net' };
  });

  // GET /api/settings/ai-safety — returns active AI safety configuration for info banners.
  // Any authenticated user can see which guardrails/rules are active, but NOT the full instruction text.
  fastify.get('/settings/ai-safety', async () => {
    const [guardrails, outputRules] = await Promise.all([
      getAiGuardrails(),
      getAiOutputRules(),
    ]);
    return {
      guardrails: { noFabricationEnabled: guardrails.noFabricationEnabled },
      outputRules: {
        stripReferences: outputRules.stripReferences,
        referenceAction: outputRules.referenceAction,
      },
    };
  });

  fastify.put('/settings', async (request) => {
    const body = UpdateSettingsSchema.parse(request.body);

    const updates: string[] = [];
    const values: unknown[] = [];
    let paramIdx = 1;

    if (body.confluenceUrl !== undefined) {
      // When the Confluence URL changes, remove the old origin from the SSRF
      // allowlist so stale entries don't accumulate (#481).
      const oldUrlResult = await query<{ confluence_url: string | null }>(
        'SELECT confluence_url FROM user_settings WHERE user_id = $1',
        [request.userId],
      );
      const oldUrl = oldUrlResult.rows[0]?.confluence_url;
      if (oldUrl && oldUrl !== body.confluenceUrl) {
        removeAllowedBaseUrl(oldUrl);
      }

      updates.push(`confluence_url = $${paramIdx++}`);
      values.push(body.confluenceUrl);

      // Register the new Confluence URL so the SSRF guard allows requests
      // to it even when it lives on a private network (#480).
      if (body.confluenceUrl) {
        addAllowedBaseUrl(body.confluenceUrl);
      }
    }

    if (body.confluencePat !== undefined && body.confluencePat !== null) {
      updates.push(`confluence_pat = $${paramIdx++}`);
      values.push(encryptPat(body.confluencePat));
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

    if (body.customPrompts !== undefined) {
      updates.push(`custom_prompts = $${paramIdx++}`);
      values.push(JSON.stringify(body.customPrompts));
    }

    // #771: dismissal of the Confluence-PAT onboarding banner. The client
    // sends a boolean; the server owns the timestamp (NOW() on dismiss,
    // NULL to clear). Static SQL fragments only — no user input involved.
    if (body.confluencePatPromptDismissed !== undefined) {
      updates.push(
        body.confluencePatPromptDismissed
          ? 'confluence_pat_prompt_dismissed_at = NOW()'
          : 'confluence_pat_prompt_dismissed_at = NULL',
      );
    }

    // Handle selectedSpaces via RBAC space_role_assignments
    if (body.selectedSpaces !== undefined) {
      const newSpaces = body.selectedSpaces;

      // #815: Prevent horizontal privilege escalation. A user may only
      // self-assign the editor role on spaces reachable by their OWN Confluence
      // PAT — the same set the picker (GET /spaces/available) offers. Without
      // this guard any authenticated user could insert an editor
      // space_role_assignments row for an arbitrary space key and thereby read
      // every already-synced page in that space, since getUserAccessibleSpaces
      // derives a non-admin's readable spaces solely from these rows. Only the
      // INSERT path needs the check; deselecting (empty set / DELETE below) is
      // always safe and must not require a live PAT lookup.
      if (newSpaces.length > 0) {
        const client = await getClientForUser(request.userId);
        if (!client) {
          throw fastify.httpErrors.badRequest('Confluence not configured');
        }
        const patVisibleSpaces = new Set((await client.getAllSpaces()).map((s) => s.key));
        const unauthorized = newSpaces.filter((key) => !patVisibleSpaces.has(key));
        if (unauthorized.length > 0) {
          throw fastify.httpErrors.forbidden(
            `Not permitted to select space(s) not visible to your Confluence PAT: ${unauthorized.join(', ')}`,
          );
        }
      }

      // Get the editor role ID for default assignment
      const editorRoleResult = await query<{ id: number }>(
        "SELECT id FROM roles WHERE name = 'editor' LIMIT 1",
      );
      const editorRoleId = editorRoleResult.rows[0]?.id;

      if (editorRoleId) {
        // Remove ONLY editor role assignments for deselected spaces.
        // Higher-privilege roles (space_admin, system_admin) are NOT removed
        // when a user deselects a space in settings -- those require explicit
        // admin action via the RBAC admin UI.
        await query(
          `DELETE FROM space_role_assignments
           WHERE principal_type = 'user' AND principal_id = $1
             AND role_id = $3
             AND space_key <> ALL($2::text[])`,
          [request.userId, newSpaces, editorRoleId],
        );

        // Insert new space assignments (idempotent)
        for (const spaceKey of newSpaces) {
          await query(
            `INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
             VALUES ($1, 'user', $2, $3)
             ON CONFLICT (space_key, principal_type, principal_id) DO NOTHING`,
            [spaceKey, request.userId, editorRoleId],
          );
        }

        await invalidateRbacCache(request.userId);
        await cache.invalidate(request.userId, 'spaces');
        await cache.invalidate(request.userId, 'pages');
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

    // SSRF guard (#819): validate URL syntax + protocol WITHOUT mutating the
    // process-global allowlist. A previous revision called addAllowedBaseUrl(url)
    // BEFORE validateUrl(url) — and validateUrl short-circuits for allowlisted
    // origins — so the private-IP check became a no-op and, on a 2xx probe, the
    // origin was left allowlisted in-memory AND broadcast cluster-wide, weakening
    // the SSRF guard for every other fetch path (attachment/image import, webhook
    // delivery) until restart. This route is authenticate-only (per-user
    // Confluence config), so it can't be admin-gated like POST /setup/llm-test;
    // instead the probe validates non-mutatingly. validateUrlSyntaxAndProtocol
    // still permits on-prem private-network Confluence (#480 — it does not block
    // private IPs) while rejecting non-HTTP(S) URLs. The allowlist entry is
    // persisted ONLY when the URL is saved in PUT /settings — a probe never
    // touches or broadcasts it.
    try {
      validateUrlSyntaxAndProtocol(url);
    } catch {
      return { success: false, message: 'URL blocked: only HTTP(S) URLs are allowed' };
    }

    // Rewrite localhost URLs for Docker networking (CONFLUENCE_DOCKER_HOST)
    const effectiveUrl = resolveConfluenceUrl(url);

    try {
      const opts: Record<string, unknown> = {
        method: 'GET',
        headers: { Authorization: `Bearer ${resolvedPat}` },
        signal: AbortSignal.timeout(10_000),
        dispatcher: confluenceDispatcher,
      };

      const { statusCode, body: responseBody } = await undiciRequest(
        `${effectiveUrl}/rest/api/space?limit=1`,
        opts as Parameters<typeof undiciRequest>[1],
      );
      // Drain response body to avoid memory leak
      await responseBody.dump();

      if (statusCode >= 200 && statusCode < 300) {
        return { success: true, message: 'Connection successful' };
      }
      // #819: do NOT reflect the raw HTTP status to the caller — it turns this
      // probe into a semi-blind internal port/host scanner (CWE-918). The detail
      // is logged server-side for operators; the caller gets a generic message.
      logger.warn({ url, statusCode }, 'Confluence test connection returned non-2xx');
      return { success: false, message: 'Connection failed' };
    } catch (err) {
      // #819: never reflect err.message / err.cause (ECONNREFUSED vs cert error
      // vs ENOTFOUND) — that is the SSRF oracle. Log it server-side only.
      logger.warn({ err, url }, 'Confluence test connection failed');
      return { success: false, message: 'Connection failed' };
    }
  });
}

async function invalidateUserData(userId: string, fastify: FastifyInstance): Promise<void> {
  // When a user's PAT/URL changes, their RBAC space assignments are no longer valid.
  // Clear their space role assignments so they re-configure with the new credentials.
  // Shared tables (pages, spaces, page_embeddings) are NOT deleted here
  // because they are shared across users. Pages are only removed via sync when no
  // user selects the space.
  await query(
    `DELETE FROM space_role_assignments WHERE principal_type = 'user' AND principal_id = $1`,
    [userId],
  );
  await invalidateRbacCache(userId);

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
