import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables } from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';
import * as converter from '../../../core/services/content-converter.js';
import {
  SubPagePolicyError,
  assembleSubPageContext,
  fetchAdmittedSubPages,
  fetchSubPages,
  getMultiPagePromptSuffix,
  hasSubPages,
} from './subpage-context.js';
import { admitPageForProvider } from '../../llm/services/ai-policy-admission.js';
import { declareProviderLocality } from '../../llm/services/llm-provider-service.js';

const dbAvailable = await isDbAvailable();
let seq = 0;

async function user(): Promise<string> {
  seq += 1;
  const r = await query<{ id: string }>(
    `INSERT INTO users (username, email, password_hash, role) VALUES ($1, $2, 'x', 'user') RETURNING id`,
    [`sp${seq}`, `sp${seq}@test.invalid`],
  );
  return r.rows[0]!.id;
}

async function page(input: {
  owner: string; title: string; body?: string; parentId?: string | null; policy?: string; visibility?: 'private' | 'shared';
}): Promise<number> {
  const r = await query<{ id: number }>(
    `INSERT INTO pages
       (title, body_html, body_storage, body_text, version, labels, source, visibility,
        created_by_user_id, parent_id, ai_policy, embedding_dirty, embedding_status)
     VALUES ($1, $2, $2, $3, 1, '{}', 'standalone', $4, $5, $6, $7, FALSE, 'not_embedded')
     RETURNING id`,
    [
      input.title,
      input.body ?? `<p>${input.title} body</p>`,
      `${input.title} body`,
      input.visibility ?? 'private',
      input.owner,
      input.parentId ?? null,
      input.policy ?? 'all',
    ],
  );
  return r.rows[0]!.id;
}

/**
 * A provider row. A `local` one is declared by a REAL administrator row
 * (`locality_declared_by` → users.id, `ON DELETE SET NULL`), exactly as
 * `declareProviderLocality` records it — a declaration nobody is
 * accountable for is not local.
 */
async function provider(local: boolean, declaredBy?: string): Promise<{ id: string; configRevision: number; declaredBy: string | null }> {
  seq += 1;
  const declarer = local ? (declaredBy ?? await user()) : null;
  const r = await query<{ id: string; config_revision: string }>(
    `INSERT INTO llm_providers
       (name, base_url, api_key, auth_type, verify_ssl, locality, locality_declared_at, locality_config_revision, locality_declared_by)
     VALUES ($1, 'http://provider.invalid', 'k', 'bearer', TRUE, $2, $3, $4, $5::uuid)
     RETURNING id::text, config_revision::text`,
    [`p${seq}`, local ? 'local' : 'external', local ? new Date() : null, local ? 1 : null, declarer],
  );
  return { id: r.rows[0]!.id, configRevision: Number(r.rows[0]!.config_revision), declaredBy: declarer };
}

describe.skipIf(!dbAvailable)('subpage-context (#281 provenance) — real PostgreSQL', () => {
  beforeAll(async () => {
    await setupTestDb();
    await truncateAllTables();
  });
  afterAll(async () => {
    await teardownTestDb();
  });
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('hasSubPages counts only visible, live children', async () => {
    const owner = await user();
    const other = await user();
    const parent = await page({ owner, title: 'Parent' });
    expect(await hasSubPages(owner, String(parent))).toBe(false);
    const child = await page({ owner: other, title: 'Foreign', parentId: String(parent) });
    expect(await hasSubPages(owner, String(parent))).toBe(false);
    await query(`UPDATE pages SET visibility = 'shared' WHERE id = $1`, [child]);
    expect(await hasSubPages(owner, String(parent))).toBe(true);
    await query(`UPDATE pages SET deleted_at = NOW() WHERE id = $1`, [child]);
    expect(await hasSubPages(owner, String(parent))).toBe(false);
  });

  it('walks breadth-first with depth and reads policy/revision from the body row', async () => {
    const owner = await user();
    const parent = await page({ owner, title: 'Root' });
    const child = await page({ owner, title: 'Child', parentId: String(parent), policy: 'local_only' });
    const grandchild = await page({ owner, title: 'Grandchild', parentId: String(child) });
    await query(`UPDATE pages SET ai_policy = 'none' WHERE id = $1`, [grandchild]);
    const pages = await fetchSubPages(owner, String(parent));
    expect(pages.map((p) => [p.id, p.depth, p.policy, p.policyRevision])).toEqual([
      [child, 1, 'local_only', 0],
      [grandchild, 2, 'none', 1],
    ]);
    expect(pages[0]).toMatchObject({ confluenceId: null, title: 'Child', bodyHtml: '<p>Child body</p>' });
  });

  it('coalesces a NULL body to an empty string', async () => {
    const owner = await user();
    const parent = await page({ owner, title: 'Root' });
    await query(
      `INSERT INTO pages (title, body_html, body_storage, body_text, version, source, visibility, created_by_user_id, parent_id)
       VALUES ('Empty', NULL, NULL, '', 1, 'standalone', 'private', $1, $2)`,
      [owner, String(parent)],
    );
    const pages = await fetchSubPages(owner, String(parent));
    expect(pages).toHaveLength(1);
    expect(pages[0]!.bodyHtml).toBe('');
  });

  it('without a policy context every visible descendant is returned', async () => {
    const owner = await user();
    const parent = await page({ owner, title: 'Root' });
    await page({ owner, title: 'Blocked', parentId: String(parent), policy: 'none' });
    await page({ owner, title: 'Open', parentId: String(parent) });
    const ctx = await assembleSubPageContext(owner, String(parent), '<p>root</p>', 'Root');
    expect(ctx.pageCount).toBe(3);
    expect(ctx.excludedByPolicy).toEqual([]);
    expect(ctx.markdown).toContain('--- Page: "Root" (Main Page) ---');
    expect(ctx.markdown).toContain('--- Page: "Blocked" (Sub-page, depth 1) ---');
    expect(ctx.markdown).toContain('Blocked body');
  });

  it('with a policy context, refused descendants are dropped before formatting and provenance names the rest', async () => {
    const owner = await user();
    const external = await provider(false);
    const parent = await page({ owner, title: 'Root' });
    const open = await page({ owner, title: 'Open', parentId: String(parent) });
    const localOnly = await page({ owner, title: 'Local only', parentId: String(parent), policy: 'local_only' });
    const none = await page({ owner, title: 'No AI', parentId: String(parent), policy: 'none' });
    const underNone = await page({ owner, title: 'Under', parentId: String(none) });

    const toMarkdown = vi.spyOn(converter, 'htmlToMarkdown');
    const ctx = await assembleSubPageContext(owner, String(parent), '<p>root</p>', 'Root', 200_000, {
      policyContext: { providerId: external.id, usecase: 'chat', expectedConfigRevision: external.configRevision, expectedLocality: 'external' },
    });
    expect(ctx.includedPageRefs).toEqual([
      { id: open, confluenceId: null, title: 'Open', policy: 'all', policyRevision: 0, contentRevision: 0, truncated: false },
      { id: underNone, confluenceId: null, title: 'Under', policy: 'all', policyRevision: 0, contentRevision: 0, truncated: false },
    ]);
    expect(ctx.excludedByPolicy).toEqual([
      { id: localOnly, policy: 'local_only', policyRevision: 0, reason: 'provider_not_local' },
      { id: none, policy: 'none', policyRevision: 0, reason: 'policy_none' },
    ]);
    expect(ctx.pageCount).toBe(3);
    expect(ctx.markdown).not.toContain('Local only');
    expect(ctx.markdown).not.toContain('No AI');
    for (const call of toMarkdown.mock.calls) {
      expect(call[0]).not.toContain('Local only body');
      expect(call[0]).not.toContain('No AI body');
    }
  });

  it('a local provider at its admitted revision admits local_only, never none', async () => {
    const owner = await user();
    const local = await provider(true);
    const parent = await page({ owner, title: 'Root' });
    const localOnly = await page({ owner, title: 'Local only', parentId: String(parent), policy: 'local_only' });
    const none = await page({ owner, title: 'No AI', parentId: String(parent), policy: 'none' });
    const ctx = { providerId: local.id, usecase: 'chat', expectedConfigRevision: local.configRevision, expectedLocality: 'local' };
    const { pages, excluded } = await fetchAdmittedSubPages(owner, String(parent), ctx);
    expect(pages.map((p) => p.id)).toEqual([localOnly]);
    expect(excluded).toEqual([{ id: none, policy: 'none', policyRevision: 0, reason: 'policy_none' }]);
  });

  it('a provider reconfigured since the caller was admitted fails the walk closed', async () => {
    const owner = await user();
    const local = await provider(true);
    const parent = await page({ owner, title: 'Root' });
    await page({ owner, title: 'Open', parentId: String(parent) });
    await query(`UPDATE llm_providers SET base_url = 'http://moved.invalid' WHERE id::text = $1`, [local.id]);
    const stale = { providerId: local.id, usecase: 'chat', expectedConfigRevision: local.configRevision, expectedLocality: 'local' };
    await expect(fetchAdmittedSubPages(owner, String(parent), stale)).rejects.toBeInstanceOf(SubPagePolicyError);
    await expect(fetchAdmittedSubPages(owner, String(parent), stale))
      .rejects.toMatchObject({ reason: 'ai_policy_provider_revision_mismatch' });
    await expect(assembleSubPageContext(owner, String(parent), '<p>r</p>', 'Root', 200_000, { policyContext: stale }))
      .rejects.toBeInstanceOf(SubPagePolicyError);
  });

  it('an unknown or deleted provider is ai_policy_unavailable (retryable), never a mismatch and never bound external', async () => {
    const owner = await user();
    const parent = await page({ owner, title: 'Root' });
    await page({ owner, title: 'Open', parentId: String(parent) });
    const unknown = fetchAdmittedSubPages(owner, String(parent), {
      providerId: 'nope', usecase: 'chat', expectedConfigRevision: 1, expectedLocality: 'external',
    });
    await expect(unknown).rejects.toBeInstanceOf(SubPagePolicyError);
    await expect(unknown).rejects.toMatchObject({ reason: 'ai_policy_unavailable', retryable: true });

    // Admitted against a real external provider, then the provider is
    // deleted before the walk: the binding cannot be verified any more.
    const external = await provider(false);
    const admission = await admitPageForProvider(parent, 'chat', external.id, 'm');
    if (!admission.admitted) throw new Error('unreachable');
    await query(`DELETE FROM llm_providers WHERE id::text = $1`, [external.id]);
    await expect(fetchAdmittedSubPages(owner, String(parent), {
      providerId: admission.providerId, usecase: 'chat',
      expectedConfigRevision: admission.configRevision, expectedLocality: admission.locality,
    })).rejects.toMatchObject({ reason: 'ai_policy_unavailable', retryable: true });

    // And a fresh admission against the deleted provider refuses — under
    // `all` too — with the retryable reason and no persistable block.
    const after = await admitPageForProvider(parent, 'chat', external.id, 'm');
    expect(after).toMatchObject({ admitted: false, reason: 'policy_unavailable', retryable: true, policy: 'all' });
  });

  it('a local declaration whose administrator was deleted is external for the parent admission AND the walk', async () => {
    const owner = await user();
    const admin = await user();
    const local = await provider(true, admin);
    const parent = await page({ owner, title: 'Root' });
    const localOnly = await page({ owner, title: 'Local only', parentId: String(parent), policy: 'local_only' });
    const open = await page({ owner, title: 'Open', parentId: String(parent) });

    const before = await admitPageForProvider(localOnly, 'chat', local.id, 'm');
    expect(before).toMatchObject({ admitted: true, locality: 'local' });

    // FK `locality_declared_by … ON DELETE SET NULL`: the row still says
    // `local`, but nobody is accountable for that declaration any more.
    await query(`DELETE FROM users WHERE id = $1`, [admin]);
    const row = await query<{ locality: string; locality_declared_by: string | null }>(
      `SELECT locality, locality_declared_by FROM llm_providers WHERE id::text = $1`, [local.id],
    );
    expect(row.rows[0]).toEqual({ locality: 'local', locality_declared_by: null });

    const parentAdmission = await admitPageForProvider(parent, 'chat', local.id, 'm');
    expect(parentAdmission).toMatchObject({ admitted: true, locality: 'external', configRevision: local.configRevision });
    if (!parentAdmission.admitted) throw new Error('unreachable');
    expect(await admitPageForProvider(localOnly, 'chat', local.id, 'm'))
      .toMatchObject({ admitted: false, reason: 'provider_not_local', retryable: false });

    const { pages, excluded } = await fetchAdmittedSubPages(owner, String(parent), {
      providerId: parentAdmission.providerId, usecase: 'chat',
      expectedConfigRevision: parentAdmission.configRevision, expectedLocality: parentAdmission.locality,
    });
    expect(pages.map((p) => p.id)).toEqual([open]);
    expect(excluded).toEqual([{ id: localOnly, policy: 'local_only', policyRevision: 0, reason: 'provider_not_local' }]);

    // A caller still holding the pre-deletion `local` binding is refused as a
    // locality mismatch (409), not as unavailable.
    await expect(fetchAdmittedSubPages(owner, String(parent), {
      providerId: local.id, usecase: 'chat', expectedConfigRevision: local.configRevision, expectedLocality: 'local',
    })).rejects.toMatchObject({ reason: 'ai_policy_provider_locality_mismatch', retryable: false });
  });

  it('a locality declaration between the caller\'s admission and the walk fails closed (#281 review)', async () => {
    const owner = await user();
    const external = await provider(false);
    const parent = await page({ owner, title: 'Root' });
    const localOnly = await page({ owner, title: 'Local only', parentId: String(parent), policy: 'local_only' });

    // The caller was admitted against an EXTERNAL provider. A declaration
    // does not move config_revision, so the revision check alone cannot see it.
    const admission = await admitPageForProvider(parent, 'chat', external.id, 'm');
    expect(admission).toMatchObject({ admitted: true, locality: 'external', configRevision: external.configRevision });
    if (!admission.admitted) throw new Error('unreachable');
    const ctx = {
      providerId: admission.providerId,
      usecase: 'chat',
      expectedConfigRevision: admission.configRevision,
      expectedLocality: admission.locality,
    };
    const declared = await declareProviderLocality(external.id, 'local', external.configRevision, owner);
    expect(declared).toMatchObject({ ok: true, state: { localConfirmed: true, configRevision: external.configRevision } });

    await expect(fetchAdmittedSubPages(owner, String(parent), ctx))
      .rejects.toMatchObject({ reason: 'ai_policy_provider_locality_mismatch' });
    await expect(assembleSubPageContext(owner, String(parent), '<p>r</p>', 'Root', 200_000, { policyContext: ctx }))
      .rejects.toBeInstanceOf(SubPagePolicyError);

    // Re-admitted against the now-local provider, the walk binds to `local`
    // and a local_only descendant is admitted.
    const fresh = await admitPageForProvider(parent, 'chat', external.id, 'm');
    if (!fresh.admitted) throw new Error('unreachable');
    expect(fresh.locality).toBe('local');
    const { pages } = await fetchAdmittedSubPages(owner, String(parent), {
      providerId: fresh.providerId, usecase: 'chat',
      expectedConfigRevision: fresh.configRevision, expectedLocality: fresh.locality,
    });
    expect(pages.map((p) => p.id)).toEqual([localOnly]);

    // And the reverse flip (local → external) is caught the same way.
    await declareProviderLocality(external.id, 'external', external.configRevision, owner);
    await expect(fetchAdmittedSubPages(owner, String(parent), {
      providerId: fresh.providerId, usecase: 'chat',
      expectedConfigRevision: fresh.configRevision, expectedLocality: 'local',
    })).rejects.toMatchObject({ reason: 'ai_policy_provider_locality_mismatch' });
  });

  it('excluded pages still count toward the walk bound (a padded tree cannot force unbounded scanning)', async () => {
    const owner = await user();
    const external = await provider(false);
    const parent = await page({ owner, title: 'Root' });
    for (let i = 0; i < 60; i += 1) {
      await page({ owner, title: `Blocked ${i}`, parentId: String(parent), policy: 'none' });
    }
    const open = await page({ owner, title: 'Open last', parentId: String(parent) });
    const { pages, excluded } = await fetchAdmittedSubPages(owner, String(parent), {
      providerId: external.id, usecase: 'chat', expectedConfigRevision: external.configRevision, expectedLocality: 'external',
    });
    expect(excluded).toHaveLength(50);
    expect(pages.map((p) => p.id)).not.toContain(open);
  });

  it('ACL still gates the walk under a policy context', async () => {
    const owner = await user();
    const stranger = await user();
    const external = await provider(false);
    const parent = await page({ owner, title: 'Root', visibility: 'shared' });
    await page({ owner, title: 'Private child', parentId: String(parent) });
    const shared = await page({ owner, title: 'Shared child', parentId: String(parent), visibility: 'shared' });
    const { pages } = await fetchAdmittedSubPages(stranger, String(parent), {
      providerId: external.id, usecase: 'chat', expectedConfigRevision: external.configRevision, expectedLocality: 'external',
    });
    expect(pages.map((p) => p.id)).toEqual([shared]);
  });

  it('truncation marks the provenance entry and stops the output', async () => {
    const owner = await user();
    const parent = await page({ owner, title: 'Root' });
    const big = await page({ owner, title: 'Big', parentId: String(parent), body: `<p>${'x'.repeat(2000)}</p>` });
    await page({ owner, title: 'After', parentId: String(parent) });
    const ctx = await assembleSubPageContext(owner, String(parent), '<p>root</p>', 'Root', 900);
    expect(ctx.wasTruncated).toBe(true);
    expect(ctx.includedPageRefs).toEqual([expect.objectContaining({ id: big, truncated: true })]);
    expect(ctx.includedPages).toEqual(['Root', 'Big (truncated)']);
    expect(ctx.markdown).toContain('[Content truncated due to length limits]');
    expect(ctx.markdown).not.toContain('After body');
  });

  it('requests layout boundary tokens for the PARENT conversion only when opted in (#765)', async () => {
    const owner = await user();
    const parent = await page({ owner, title: 'Root' });
    await page({ owner, title: 'Child', parentId: String(parent), body: '<div class="confluence-layout"><p>Sub</p></div>' });
    const toMarkdown = vi.spyOn(converter, 'htmlToMarkdown');
    await assembleSubPageContext(
      owner, String(parent), '<div class="confluence-layout"><p>Parent</p></div>', 'Root', undefined,
      { parentLayoutTokens: true },
    );
    const calls = toMarkdown.mock.calls;
    expect(calls.length).toBe(2);
    expect(calls[0]![1]).toEqual({ layoutTokens: true });
    expect(calls[1]![1]).toBeUndefined();

    toMarkdown.mockClear();
    await assembleSubPageContext(owner, String(parent), '<div class="confluence-layout"><p>Parent</p></div>', 'Root');
    for (const call of toMarkdown.mock.calls) expect(call[1]).toBeUndefined();
  });

  it('prompt suffix only for multi-page context', () => {
    expect(getMultiPagePromptSuffix(1)).toBe('');
    const suffix = getMultiPagePromptSuffix(5);
    expect(suffix).toContain('5 total');
    expect(suffix).toContain('--- Page:');
  });
});
