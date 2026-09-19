import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createClient, type RedisClientType } from 'redis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { query } from '../../core/db/postgres.js';
import { htmlToMarkdown, protectMedia } from '../../core/services/content-converter.js';
import { setRedisClient } from '../../core/services/redis-cache.js';
import {
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import {
  buildKnowledgeTestApp,
  insertLocalSpace,
  insertStandalonePage,
  insertUser,
} from '../knowledge/pages.test-helpers.js';
import { llmConversationRoutes } from './llm-conversations.js';

const [dbAvailable, redisAvailable] = await Promise.all([isDbAvailable(), isRedisAvailable()]);
const previousAttachmentsDir = process.env.ATTACHMENTS_DIR;

let app: FastifyInstance;
let redis: RedisClientType;
let attachmentsDir: string;
let userId: string;
let authenticated = true;

/** Mirrors the markdown shown to Improve for a page whose structure is retained. */
function faithfulEcho(bodyHtml: string): string {
  return htmlToMarkdown(protectMedia(bodyHtml).html, { layoutTokens: true });
}

async function seedPage(bodyHtml: string, version = 5): Promise<number> {
  const pageId = await insertStandalonePage('My Article', 'private', userId, 'LOCAL');
  await query(
    `UPDATE pages
        SET body_html = $2, body_text = $3, body_storage = '', version = $4,
            embedding_dirty = FALSE, image_analysis_dirty = FALSE
      WHERE id = $1`,
    [pageId, bodyHtml, bodyHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(), version],
  );
  return pageId;
}

async function readPage(pageId: number) {
  const result = await query<{
    title: string;
    body_html: string;
    body_text: string;
    version: number;
    embedding_dirty: boolean;
    image_analysis_dirty: boolean;
  }>(
    `SELECT title, body_html, body_text, version, embedding_dirty, image_analysis_dirty
       FROM pages WHERE id = $1`,
    [pageId],
  );
  return result.rows[0]!;
}

async function apply(pageId: number, improvedMarkdown: string, extra: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url: '/api/llm/improvements/apply',
    payload: {
      pageId: String(pageId),
      improvedMarkdown,
      version: 5,
      title: 'My Article',
      ...extra,
    },
  });
}

async function expectUnchanged(pageId: number, bodyHtml: string): Promise<void> {
  expect(await readPage(pageId)).toMatchObject({ body_html: bodyHtml, version: 5 });
}

describe.skipIf(!dbAvailable || !redisAvailable)(
  'POST /api/llm/improvements/apply — real persistence, admission, media, and layout conversion',
  () => {
    beforeAll(async () => {
      await setupTestDb();
      attachmentsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'compendiq-apply-media-'));
      process.env.ATTACHMENTS_DIR = attachmentsDir;
      redis = createClient({
        url: process.env.REDIS_URL,
        socket: { reconnectStrategy: false, connectTimeout: 1_000 },
      });
      await redis.connect();
      setRedisClient(redis);
      app = await buildKnowledgeTestApp(() => userId, async (instance) => {
        instance.redis = redis;
        vi.spyOn(instance, 'authenticate').mockImplementation(async (request) => {
          if (!authenticated) throw instance.httpErrors.unauthorized('Missing or invalid token');
          request.userId = userId;
          request.userCan = async () => true;
        });
        await instance.register(llmConversationRoutes, { prefix: '/api' });
      });
    }, 30_000);

    afterAll(async () => {
      await app.close();
      if (redis.isOpen) await redis.quit();
      await fs.rm(attachmentsDir, { recursive: true, force: true });
      if (previousAttachmentsDir === undefined) delete process.env.ATTACHMENTS_DIR;
      else process.env.ATTACHMENTS_DIR = previousAttachmentsDir;
      await teardownTestDb();
      vi.restoreAllMocks();
    });

    beforeEach(async () => {
      await truncateAllTables();
      await redis.flushDb();
      await fs.rm(attachmentsDir, { recursive: true, force: true });
      await fs.mkdir(attachmentsDir, { recursive: true });
      authenticated = true;
      userId = await insertUser(`apply-media-${randomUUID()}`);
      await insertLocalSpace('LOCAL', userId);
    });

    it('requires authentication before applying protected content', async () => {
      const original = '<p>Private body</p><img src="/api/attachments/1/private.png">';
      const pageId = await seedPage(original);
      authenticated = false;

      const response = await apply(pageId, 'Stolen rewrite');

      expect(response.statusCode).toBe(401);
      await expectUnchanged(pageId, original);
    });

    it('runs the real collaboration admission guard before publication', async () => {
      const original = '<p>Original body</p><img src="/api/attachments/1/guarded.png">';
      const pageId = await seedPage(original);
      await redis.sAdd(`collab:active:${pageId}`, 'live-session');

      const response = await apply(pageId, 'Blocked rewrite');

      expect(response.statusCode).toBe(409);
      expect(response.json<{ error: string }>().error).toMatch(/collaborative editing session/i);
      await expectUnchanged(pageId, original);
    });

    it('re-appends dropped image and draw.io markup, commits the accepted improvement, and invalidates real cached state', async () => {
      const pageId = await seedPage('<p>temporary</p>');
      const imageName = 'p$1$&x.png';
      const pageDir = path.join(attachmentsDir, String(pageId));
      await fs.mkdir(pageDir, { recursive: true });
      await fs.writeFile(path.join(pageDir, imageName), Buffer.from('image-bytes'));
      await fs.writeFile(path.join(pageDir, 'Arch.png'), Buffer.from('drawio-bytes'));
      const image = `<img src="/api/attachments/${pageId}/${imageName}" data-confluence-filename="p.png" data-confluence-image-source="attachment" alt="Photo">`;
      const drawio = `<div class="confluence-drawio" data-diagram-name="Arch"><img src="/api/attachments/${pageId}/Arch.png"></div>`;
      const original = `<p>Old intro</p>${image}${drawio}`;
      await query('UPDATE pages SET body_html = $2, body_text = $3 WHERE id = $1', [pageId, original, 'Old intro']);
      const improvedMarkdown = '## Rewritten\n\nFresh prose, no media tokens.';
      const improvement = await query<{ id: string }>(
        `INSERT INTO llm_improvements
           (user_id, page_id, improvement_type, model, original_content, improved_content, status)
         VALUES ($1, $2, 'clarity', 'test-model', 'old', $3, 'completed')
         RETURNING id`,
        [userId, pageId, improvedMarkdown],
      );
      const cacheKey = `kb:${userId}:pages:fixture`;
      await redis.set(cacheKey, 'stale');

      const response = await apply(pageId, improvedMarkdown);

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({ id: pageId, title: 'My Article', version: 6 });
      const saved = await readPage(pageId);
      expect(saved).toMatchObject({
        version: 6,
        embedding_dirty: true,
        image_analysis_dirty: true,
      });
      expect(saved.body_html).toContain('Fresh prose, no media tokens.');
      expect(saved.body_html).toContain(`/api/attachments/${pageId}/p$1$&amp;x.png`);
      expect(saved.body_html).toContain('data-confluence-filename="p.png"');
      expect(saved.body_html).toContain('class="confluence-drawio"');
      expect(saved.body_html).toContain('data-diagram-name="Arch"');
      expect(await fs.readFile(path.join(pageDir, imageName), 'utf8')).toBe('image-bytes');
      expect(await fs.readFile(path.join(pageDir, 'Arch.png'), 'utf8')).toBe('drawio-bytes');
      expect(await redis.get(cacheKey)).toBeNull();
      expect((await query<{ status: string }>('SELECT status FROM llm_improvements WHERE id = $1', [improvement.rows[0]!.id])).rows[0]?.status)
        .toBe('applied');
      const audit = await query<{ metadata: { source?: string } }>(
        `SELECT metadata FROM audit_log
          WHERE user_id = $1 AND action = 'PAGE_UPDATED' AND resource_id = $2`,
        [userId, String(pageId)],
      );
      expect(audit.rows[0]?.metadata.source).toBe('ai_improvement');
    });

    it('restores a retained media token in place without appending a duplicate', async () => {
      const pageId = await seedPage('<p>temporary</p>');
      const original = `<p>Old</p><img src="/api/attachments/${pageId}/q.png" alt="Q">`;
      await query('UPDATE pages SET body_html = $2 WHERE id = $1', [pageId, original]);

      const response = await apply(pageId, 'Improved intro\n\nCQ\\_MEDIA\\_PLACEHOLDER\\_0\n');

      expect(response.statusCode, response.body).toBe(200);
      const saved = await readPage(pageId);
      expect(saved.body_html.split(`/api/attachments/${pageId}/q.png`).length - 1).toBe(1);
    });

    it('keeps a constrained expand section in a table cell through the frozen-media path', async () => {
      const expand = '<details data-macro-name="expand"><summary>Runbook</summary><p>step one</p></details>';
      const original = `<p>Old intro</p><table><tbody><tr><td>${expand}</td></tr></tbody></table>`;
      const pageId = await seedPage(original);

      const response = await apply(pageId, '## Rewritten\n\nFresh prose, no tokens at all.');

      expect(response.statusCode, response.body).toBe(200);
      const saved = await readPage(pageId);
      expect(saved.body_html).toContain(expand);
      expect(saved.body_html.split('data-macro-name="expand"').length - 1).toBe(1);
    });

    it('rewrites an unconstrained expand body while retaining the macro boundary', async () => {
      const pageId = await seedPage(
        '<p>Old intro</p><details data-macro-name="expand"><summary>Runbook</summary><p>step one</p></details>',
      );
      const response = await apply(pageId, [
        '[[[EXPAND name=expand open=0 title=Runbook params=]]]', '',
        'Step one, rewritten far more clearly.', '',
        '[[[/EXPAND]]]',
      ].join('\n'));

      expect(response.statusCode, response.body).toBe(200);
      const saved = await readPage(pageId);
      expect(saved.body_html).toContain('<details data-macro-name="expand">');
      expect(saved.body_html).toContain('<summary>Runbook</summary>');
      expect(saved.body_html).toContain('Step one, rewritten far more clearly.');
      expect(saved.body_html).not.toContain('step one');
      expect(saved.body_html).not.toContain('[[[');
      expect(saved.body_html.split('<details').length - 1).toBe(1);
    });

    it('preserves ui-expand identity, open state, and parameters through publication', async () => {
      const pageId = await seedPage(
        '<details data-macro-name="ui-expand" open data-macro-params="{&quot;class&quot;:&quot;team&quot;}">' +
        '<summary>Dev Team</summary><p>owns platform services</p></details>',
      );
      const response = await apply(pageId, [
        '[[[EXPAND name=ui-expand open=1 title=Dev%20Team params=%7B%22class%22%3A%22team%22%7D]]]', '',
        'Owns the platform services end to end.', '',
        '[[[/EXPAND]]]',
      ].join('\n'));

      expect(response.statusCode, response.body).toBe(200);
      const html = (await readPage(pageId)).body_html;
      expect(html).toContain('data-macro-name="ui-expand"');
      expect(html).not.toContain('data-macro-name="expand"');
      expect(html).toContain('<summary>Dev Team</summary>');
      expect(html).toMatch(/<details[^>]*\bopen\b/);
      expect(html).toContain('data-macro-params="{&quot;class&quot;:&quot;team&quot;}"');
      expect(html).not.toContain('owns platform services');
      expect(html.split('<details').length - 1).toBe(1);
      expect(html.indexOf('Owns the platform services end to end.')).toBeGreaterThan(html.indexOf('</summary>'));
      expect(html.indexOf('Owns the platform services end to end.')).toBeLessThan(html.indexOf('</details>'));
    });

    it('rejects unrecoverable multi-expand token loss without publishing partial content', async () => {
      const original =
        '<details data-macro-name="expand"><summary>One</summary><p>alpha body</p></details>' +
        '<details data-macro-name="expand"><summary>Two</summary><p>beta body</p></details>';
      const pageId = await seedPage(original);

      const response = await apply(pageId, 'Abschnitt eins: voellig neu formuliert.\n\nAbschnitt zwei: ebenfalls neu formuliert.');

      expect(response.statusCode).toBe(422);
      expect(response.json<{ error: string }>().error).toContain('could not be recovered');
      await expectUnchanged(pageId, original);
    });

    it('recovers a case-mangled EXPAND close token against the persisted skeleton', async () => {
      const pageId = await seedPage(
        '<details data-macro-name="expand"><summary>Runbook</summary><p>step one</p></details>',
      );
      const response = await apply(pageId, [
        '[[[EXPAND name=expand open=0 title=Runbook params=]]]', '',
        'Step one, clarified.', '',
        '[[[/expand]]]',
      ].join('\n'));

      expect(response.statusCode, response.body).toBe(200);
      const html = (await readPage(pageId)).body_html;
      expect(html).toContain('<details data-macro-name="expand">');
      expect(html).toContain('<summary>Runbook</summary>');
      expect(html).toContain('Step one, clarified.');
      expect(html).not.toContain('[[[');
    });

    it('keeps a real expand and literal token-looking prose as separate content', async () => {
      const pageId = await seedPage(
        '<p>We use [[[EXPAND name=expand open=0 title=Runbook params=]]] markers.</p>' +
        '<details data-macro-name="expand"><summary>Runbook</summary><p>real body</p></details>',
      );
      const response = await apply(pageId, [
        'We use \\[\\[\\[EXPAND name=expand open=0 title=Runbook params=\\]\\]\\] markers.', '',
        '[[[EXPAND name=expand open=0 title=Runbook params=]]]', '',
        'real body, clarified', '',
        '[[[/EXPAND]]]',
      ].join('\n'));

      expect(response.statusCode, response.body).toBe(200);
      const html = (await readPage(pageId)).body_html;
      expect(html).toContain('<details data-macro-name="expand">');
      expect(html).toContain('real body, clarified');
      expect(html).toContain('[[[EXPAND name=expand open=0 title=Runbook params=]]]');
      expect(html.split('<details').length - 1).toBe(1);
    });

    it('never fabricates a macro from a balanced token pair that was ordinary prose', async () => {
      const pageId = await seedPage('<p>Use [[[EXPAND name=expand]]] then [[[/EXPAND]]].</p>');

      const response = await apply(
        pageId,
        'Use \\[\\[\\[EXPAND name=expand\\]\\]\\] then \\[\\[\\[/EXPAND\\]\\]\\].',
      );

      expect(response.statusCode, response.body).toBe(200);
      const html = (await readPage(pageId)).body_html;
      expect(html).not.toContain('<details');
      expect(html).toContain('[[[EXPAND name=expand]]]');
      expect(html).toContain('[[[/EXPAND]]]');
    });

    it('preserves an expand containing a bare column on a faithful round trip', async () => {
      const original =
        '<details data-macro-name="expand"><summary>Runbook steps</summary>' +
        '<div class="confluence-column"><p>col body</p></div></details>';
      const pageId = await seedPage(original);

      const response = await apply(pageId, faithfulEcho(original));

      expect(response.statusCode, response.body).toBe(200);
      const html = (await readPage(pageId)).body_html;
      expect(html).toContain('data-macro-name="expand"');
      expect(html).toContain('<summary>Runbook steps</summary>');
      expect(html).toContain('confluence-column');
      expect(html).toContain('col body');
    });

    it('preserves an expand directly inside a layout wrapper on a faithful round trip', async () => {
      const original =
        '<div class="confluence-layout">' +
        '<details data-macro-name="expand"><summary>Runbook</summary><p>step one</p></details>' +
        '</div>';
      const pageId = await seedPage(original);

      const response = await apply(pageId, faithfulEcho(original));

      expect(response.statusCode, response.body).toBe(200);
      const html = (await readPage(pageId)).body_html;
      expect(html).toContain('data-macro-name="expand"');
      expect(html).toContain('<summary>Runbook</summary>');
      expect(html).toContain('step one');
    });

    it('refuses rather than swallowing surrounding prose when an EXPAND pair is dropped', async () => {
      const original =
        '<h2>Deployment guide</h2><p>Intro paragraph outside the section.</p>' +
        '<details data-macro-name="expand"><summary>Rollback runbook</summary><p>step one</p></details>' +
        '<p>Closing paragraph outside the section.</p>';
      const pageId = await seedPage(original);
      const response = await apply(pageId, [
        '## Deployment guide', '',
        'Intro paragraph outside the section.', '',
        'Step one, rewritten.', '',
        'Closing paragraph outside the section.',
      ].join('\n'));

      expect(response.statusCode).toBe(422);
      await expectUnchanged(pageId, original);
    });

    it('refuses rather than relocating prose between sections when all tokens disappear', async () => {
      const original =
        '<p>Intro outside.</p>' +
        '<details data-macro-name="expand"><summary>Q one</summary><p>Answer one body.</p></details>' +
        '<p>Middle prose outside.</p>' +
        '<details data-macro-name="expand"><summary>Q two</summary><p>Answer two body.</p></details>' +
        '<p>Outro outside.</p>';
      const pageId = await seedPage(original);
      const response = await apply(pageId, [
        'Intro outside.', '',
        'Answer one body.', '',
        'Middle prose outside.', '',
        'Answer two body.', '',
        'Outro outside.',
      ].join('\n'));

      expect(response.statusCode).toBe(422);
      await expectUnchanged(pageId, original);
    });

    it('keeps each expand title with its own body when the model reorders sections', async () => {
      const pageId = await seedPage(
        '<details data-macro-name="expand"><summary>Deployment steps</summary><p>deploy body</p></details>' +
        '<details data-macro-name="expand"><summary>Rollback runbook</summary><p>rollback body</p></details>',
      );
      const response = await apply(pageId, [
        '[[[EXPAND name=expand open=0 title=Rollback%20runbook params=]]]', '',
        'rollback body', '',
        '[[[/EXPAND]]]', '',
        '[[[EXPAND name=expand open=0 title=Deployment%20steps params=]]]', '',
        'deploy body', '',
        '[[[/EXPAND]]]',
      ].join('\n'));

      expect(response.statusCode, response.body).toBe(200);
      const html = (await readPage(pageId)).body_html;
      expect(html).toMatch(/<summary>Rollback runbook<\/summary>\s*<p>rollback body<\/p>/);
      expect(html).toMatch(/<summary>Deployment steps<\/summary>\s*<p>deploy body<\/p>/);
    });

    it('refuses when escape-stripped prose would falsely anchor an expand boundary', async () => {
      const original =
        '<p>Use [[[EXPAND name=expand open=0 title=Runbook params=]]] to open.</p>' +
        '<details data-macro-name="expand"><summary>Runbook</summary><p>real body</p></details>';
      const pageId = await seedPage(original);
      const response = await apply(pageId, [
        'Use [[[EXPAND name=expand open=0 title=Runbook params=]]] to open.', '',
        '[[[EXPAND name=expand open=0 title=Runbook params=]]]', '',
        'real body, clarified', '',
        '[[[/EXPAND]]]',
      ].join('\n'));

      expect(response.statusCode).toBe(422);
      await expectUnchanged(pageId, original);
    });

    it('refuses surplus tokens that could redistribute bodies across sections', async () => {
      const original =
        '<p>Syntax: [[[EXPAND name=expand open=0 title=One params=]]]</p>' +
        '<details data-macro-name="expand"><summary>One</summary><p>alpha body</p></details>' +
        '<details data-macro-name="expand"><summary>Two</summary><p>beta body</p></details>';
      const pageId = await seedPage(original);
      const response = await apply(pageId, [
        'Syntax: [[[EXPAND name=expand open=0 title=One params=]]]', '',
        '[[[EXPAND name=expand open=0 title=One params=]]]', '',
        'alpha body', '',
        '[[[/EXPAND]]]', '',
        '[[[EXPAND name=expand open=0 title=Two params=]]]', '',
        'beta body', '',
        '[[[/EXPAND]]]',
      ].join('\n'));

      expect(response.statusCode).toBe(422);
      await expectUnchanged(pageId, original);
    });

    it('refuses a model-invented wrapper instead of relocating real top-level prose', async () => {
      const original =
        '<p>Intro outside.</p>' +
        '<details data-macro-name="expand"><summary>Real</summary><p>real body</p></details>';
      const pageId = await seedPage(original);
      const response = await apply(pageId, [
        '[[[EXPAND name=expand open=0 title=Invented params=]]]', '',
        'Intro outside.', '',
        '[[[/EXPAND]]]', '',
        '[[[EXPAND name=expand open=0 title=Real params=]]]', '',
        'real body', '',
        '[[[/EXPAND]]]',
      ].join('\n'));

      expect(response.statusCode).toBe(422);
      await expectUnchanged(pageId, original);
    });

    it('derives the skeleton from protected HTML so a frozen subtree is not rebuilt twice', async () => {
      const original =
        '<table><tbody><tr><td>' +
        '<details data-macro-name="expand"><summary>In cell</summary>' +
        '<div class="confluence-section"><div class="confluence-column"><p>col</p></div></div>' +
        '</details></td></tr></tbody></table>';
      const pageId = await seedPage(original);

      const response = await apply(pageId, faithfulEcho(original));

      expect(response.statusCode, response.body).toBe(200);
      const html = (await readPage(pageId)).body_html;
      expect(html.split('data-macro-name="expand"').length - 1).toBe(1);
      expect(html.split('confluence-section').length - 1).toBe(1);
      expect(html).toContain('<td>');
    });

    const layoutBodyHtml =
      '<div class="confluence-layout"><div class="confluence-layout-section" data-layout-type="two_equal">' +
      '<div class="confluence-layout-cell"><p>Left column content</p></div>' +
      '<div class="confluence-layout-cell"><p>Right column content</p></div>' +
      '</div></div>';

    it('rebuilds a two-column layout when boundary tokens are retained', async () => {
      const pageId = await seedPage(layoutBodyHtml);
      const response = await apply(pageId, [
        '[[[LAYOUT]]]', '',
        '[[[LAYOUT-SECTION two_equal]]]', '',
        '[[[LAYOUT-CELL]]]', '',
        'Left column content, improved by the model.', '',
        '[[[/LAYOUT-CELL]]]', '',
        '[[[LAYOUT-CELL]]]', '',
        'Right column content stays.', '',
        '[[[/LAYOUT-CELL]]]', '',
        '[[[/LAYOUT-SECTION]]]', '',
        '[[[/LAYOUT]]]',
      ].join('\n'));

      expect(response.statusCode, response.body).toBe(200);
      const html = (await readPage(pageId)).body_html;
      expect(html).toContain('class="confluence-layout"');
      expect(html).toContain('data-layout-type="two_equal"');
      expect((html.match(/class="confluence-layout-cell"/g) ?? []).length).toBe(2);
      expect(html).toContain('Left column content, improved by the model.');
      expect(html).not.toContain('[[[');
    });

    it('recovers a dropped and case-mangled layout boundary against the persisted skeleton', async () => {
      const pageId = await seedPage(layoutBodyHtml);
      const response = await apply(pageId, [
        '[[[LAYOUT]]]', '',
        '[[[LAYOUT-SECTION two_equal]]]', '',
        '[[[LAYOUT-CELL]]]', '',
        'Left prose survives.', '',
        '[[[/layout-cell]]]', '',
        '[[[LAYOUT-CELL]]]', '',
        'Right prose survives.', '',
        '[[[/LAYOUT-SECTION]]]', '',
        '[[[/LAYOUT]]]',
      ].join('\n'));

      expect(response.statusCode, response.body).toBe(200);
      const html = (await readPage(pageId)).body_html;
      expect(html).not.toContain('[[[');
      expect(html).toContain('class="confluence-layout"');
      expect(html).toContain('data-layout-type="two_equal"');
      expect((html.match(/class="confluence-layout-cell"/g) ?? []).length).toBe(2);
      expect(html).toContain('Left prose survives.');
      expect(html).toContain('Right prose survives.');
      expect((html.match(/<div/g) ?? []).length).toBe((html.match(/<\/div>/g) ?? []).length);
    });

    it('rejects unrecoverable column loss and leaves the persisted page unchanged', async () => {
      const pageId = await seedPage(layoutBodyHtml);
      const response = await apply(pageId, [
        'Beginn des Seitenlayouts.', '',
        'Linke Spalte: Left prose.', '',
        'Rechte Spalte: Right prose.', '',
        'Ende des Seitenlayouts.',
      ].join('\n'));

      expect(response.statusCode).toBe(422);
      expect(response.json<{ error: string }>().error).toContain('columns or collapsible sections');
      await expectUnchanged(pageId, layoutBodyHtml);
    });

    it('wraps token-free prose in an unambiguous single-cell layout', async () => {
      const original =
        '<div class="confluence-layout"><div class="confluence-layout-section" data-layout-type="single">' +
        '<div class="confluence-layout-cell"><p>Full width content</p></div>' +
        '</div></div>';
      const pageId = await seedPage(original);

      const response = await apply(pageId, '## Improved heading\n\nFresh single-column prose, no tokens at all.');

      expect(response.statusCode, response.body).toBe(200);
      const html = (await readPage(pageId)).body_html;
      expect(html).not.toContain('[[[');
      expect(html).toContain('data-layout-type="single"');
      expect((html.match(/class="confluence-layout-cell"/g) ?? []).length).toBe(1);
      const proseIndex = html.indexOf('Fresh single-column prose');
      expect(proseIndex).toBeGreaterThan(html.indexOf('confluence-layout-cell'));
      expect(html.lastIndexOf('</div>')).toBeGreaterThan(proseIndex);
    });

    it('strips hallucinated layout tokens from a layout-free page instead of building structure', async () => {
      const pageId = await seedPage('<h1>Plain page</h1><p>No layout here.</p>');
      const response = await apply(pageId, [
        '[[[LAYOUT]]]', '',
        '[[[LAYOUT-SECTION two_equal]]]', '',
        '[[[LAYOUT-CELL]]]', '',
        'Hallucinated structure around real prose.', '',
        '[[[/LAYOUT-CELL]]]', '',
        '[[[/LAYOUT-SECTION]]]', '',
        '[[[/LAYOUT]]]',
      ].join('\n'));

      expect(response.statusCode, response.body).toBe(200);
      const html = (await readPage(pageId)).body_html;
      expect(html).not.toContain('[[[');
      expect(html).not.toContain('confluence-layout');
      expect(html).toContain('Hallucinated structure around real prose.');
    });
  },
);
