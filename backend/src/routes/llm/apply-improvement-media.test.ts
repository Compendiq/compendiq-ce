import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { createClient, type RedisClientType } from 'redis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { JSONContent } from '@tiptap/core';
import { generateJSON } from '@tiptap/html';
import { query } from '../../core/db/postgres.js';
import { collabExtensions } from '../../core/services/collab-schema.js';
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

/** Mirrors the markdown shown to Improve for a page whose structure is retained, with that generation's code nonce. */
function faithfulEcho(bodyHtml: string, codeNonce?: string): string {
  return htmlToMarkdown(protectMedia(bodyHtml, { codeNonce }).html, { layoutTokens: true });
}

/** D28: a generation's code nonce, as the generator stores it on its row. */
const NONCE = '0123456789abcdef';

/** A completed #1958 suggestion (protocol 1) with its code nonce, as the generator stores it. */
async function storeCodeMetaRow(pageId: number, improvedMarkdown: string, codeNonce = NONCE): Promise<string> {
  const inserted = await query<{ id: string }>(
    `INSERT INTO llm_improvements
       (user_id, page_id, improvement_type, model, original_content, improved_content, status, improve_protocol, improve_code_nonce)
     VALUES ($1, $2, 'clarity', 'test-model', 'old', $3, 'completed', 1, $4)
     RETURNING id`,
    [userId, pageId, improvedMarkdown, codeNonce],
  );
  return inserted.rows[0]!.id;
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

      const response = await apply(pageId, improvedMarkdown, { improvementId: improvement.rows[0]!.id });

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

    // #1956 review r3 A3-1 / decision D15: a suggestion generated before #1956 (its Markdown captured at the slice
    // base bda4d1ed) for a page with an aligned editor table before an image. #1956 adds no media token, so the
    // image token keeps its number and Accept puts the image back where it was, next to one table.
    it('applies a pending suggestion from before #1956 to a page with an aligned table and an image exactly as before', async () => {
      const fixture: { cases: Record<string, { html: string; markdown: string; applied: string }> } = JSON.parse(readFileSync(
        path.join(import.meta.dirname, '../../core/services/__fixtures__/table-align-improve-base.json'), 'utf8',
      ));
      const base = fixture.cases.alignedEditorTableBeforeImage!;
      expect(base.markdown).toContain('CQ\\_MEDIA\\_PLACEHOLDER\\_0');
      const pageId = await seedPage(base.html);
      const improvement = await query<{ id: string }>(
        `INSERT INTO llm_improvements
           (user_id, page_id, improvement_type, model, original_content, improved_content, status)
         VALUES ($1, $2, 'clarity', 'test-model', 'old', $3, 'completed')
         RETURNING id`,
        [userId, pageId, base.markdown],
      );

      const response = await apply(pageId, base.markdown, { improvementId: improvement.rows[0]!.id });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ version: 6 });
      const saved = await readPage(pageId);
      expect(saved.body_html).toBe(base.applied);
      const body = new JSDOM(`<body>${saved.body_html}</body>`).window.document.body;
      expect([...body.children].map((el) => el.nodeName)).toEqual(['TABLE', 'P', 'IMG', 'P']);
      expect(body.querySelectorAll('table')).toHaveLength(1);
      expect([...body.querySelectorAll('th, td')].map((cell) => cell.getAttribute('align'))).toEqual(['center', null, 'center', null]);
      expect((await query<{ status: string }>('SELECT status FROM llm_improvements WHERE id = $1', [improvement.rows[0]!.id])).rows[0]?.status)
        .toBe('applied');
    });

    it('keeps a task holding a mention a task and a task holding a diagram plain in the stored body (#1752)', async () => {
      // The route passes its protectMedia map to markdownToHtml as
      // protectedMedia. Only a token whose original HTML holds a div keeps its
      // task item plain: restoreMedia puts that div back inside the item, and
      // TipTap's TaskItem would parse only the div, dropping the task's text and
      // the diagram node itself.
      const drawio = '<div class="confluence-drawio" data-diagram-name="Arch">'
        + '<span class="drawio-preview-unavailable">Draw.io preview unavailable: Arch</span></div>';
      const mention = '<span class="confluence-user-mention" data-userkey="abc123">@alice</span>';
      const original = '<ul data-type="taskList">'
        + `<li data-type="taskItem" data-checked="true">see ${drawio}</li>`
        + `<li data-type="taskItem" data-checked="false">${mention} review the draft</li>`
        + '</ul>';
      const pageId = await seedPage(original);

      const response = await apply(pageId, faithfulEcho(original));

      expect(response.statusCode, response.body).toBe(200);
      const saved = (await readPage(pageId)).body_html;
      expect(saved).toContain(`<li>[x] see ${drawio}</li>`);
      expect(saved).toContain(`<li data-type="taskItem" data-checked="false">${mention} review the draft</li>`);
      // generateJSON is typed Record<string, any>; its output is TipTap document JSON.
      const doc = generateJSON(saved, collabExtensions()) as JSONContent;
      expect((doc.content ?? []).map((node) => [
        node.type,
        (node.content?.[0]?.content ?? []).map((child) => child.type),
      ])).toEqual([
        ['bulletList', ['paragraph', 'drawioDiagram']],
        ['taskList', ['paragraph']],
      ]);
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

    describe('code-block title and options on a standalone page (#1958)', () => {
      const TITLED = '<pre data-title="Startup.cs" data-macro-params="{&quot;linenumbers&quot;:&quot;true&quot;}">'
        + '<code class="language-js">const a = 1;</code></pre>';
      const MERMAID = '<pre data-title="Flow"><code class="language-mermaid">graph TD\n  A --&gt; B</code></pre>';

      it('keeps the stored title and options of an unchanged block and a mermaid block, and strips a raw model pre', async () => {
        const original = `<p>Intro</p>${TITLED}${MERMAID}`;
        const pageId = await seedPage(original);
        const echo = faithfulEcho(original).replace('Intro', 'Introduction')
          + '\n\n<pre data-title="Forged" data-macro-params="{&quot;evil&quot;:&quot;x&quot;}"><code>raw()</code></pre>\n';

        const response = await apply(pageId, echo);

        expect(response.statusCode, response.body).toBe(200);
        const saved = await readPage(pageId);
        expect(saved.body_html).toBe(
          `<p>Introduction</p>\n${TITLED}\n${MERMAID}\n<pre><code>raw()</code></pre>\n`,
        );
        expect(saved.body_text).not.toMatch(/CODE-META|Forged|data-cq-/);
        expect(saved.version).toBe(6);
      });

      it('saves an edited block as written, without its metadata', async () => {
        const pageId = await seedPage(`<p>Intro</p>${TITLED}`);

        const response = await apply(pageId, faithfulEcho(`<p>Intro</p>${TITLED}`).replace('const a = 1;', 'const a = 2;'));

        expect(response.statusCode, response.body).toBe(200);
        expect((await readPage(pageId)).body_html).toBe('<p>Intro</p>\n<pre><code class="language-js">const a = 2;\n</code></pre>\n');
      });

      it('refuses a result whose publication projection is not readable, with no code on the page (R7)', async () => {
        const original = '<p>Old</p>';
        const pageId = await seedPage(original);

        const response = await apply(pageId, 'New\n\n<p title="a<b">t</p>\n');

        expect(response.statusCode, response.body).toBe(422);
        expect(response.json()).toMatchObject({ reason: 'not-well-formed' });
        await expectUnchanged(pageId, original);
      });

      it.each([
        ['a code-named placeholder', '<div class="confluence-macro-unknown" data-macro-name="code" data-macro-params="{&quot;title&quot;:&quot;x&quot;}">x</div>'],
        ['raw macro markup in a raw-text element', '<div><style><ac:structured-macro ac:name="code"><ac:plain-text-body>x</ac:plain-text-body></ac:structured-macro></style></div>'],
      ])('refuses %s before the write and leaves the row unchanged', async (_name, markup) => {
        const original = `<p>Intro</p>${TITLED}`;
        const pageId = await seedPage(original);

        const response = await apply(pageId, `${faithfulEcho(original)}\n\n${markup}\n`);

        expect(response.statusCode, response.body).toBe(422);
        expect(response.json()).toMatchObject({ reason: 'unapproved-code-macro' });
        await expectUnchanged(pageId, original);
      });

      it('refuses a replay plan over budget with 422 and no write', async () => {
        const original = `<p>Intro</p><img src="/api/attachments/1/a.png" alt="${'a'.repeat(40_000)}">`;
        const pageId = await seedPage(original);
        const echo = faithfulEcho(original);

        const response = await apply(pageId, `${echo}\n\n${`${echo}\n\n`.repeat(4)}`);

        expect(response.statusCode, response.body).toBe(422);
        await expectUnchanged(pageId, original);
      });

      describe('review r1', () => {
        // CM-1: suggestions the release before #1958 (a06f304c) generated, pinned as that release wrote them.
        const CM1_PAGE = '<table><tbody><tr><td><pre data-title="Sample"><code class="language-js">const x = 1;</code></pre></td></tr></tbody></table>'
          + '<p>Diagram follows</p><img src="/api/attachments/1/d.png" alt="d"><p>End</p>';
        const CM1_BASE_SUGGESTION = '<table><tbody><tr><td><pre data-title="Sample"><code class="language-js">const x = 1;</code></pre></td></tr></tbody></table>'
          + '\n\nDiagram follows\n\nCQ\\_MEDIA\\_PLACEHOLDER\\_0\n\nEnd';
        const TOKEN_PAGE = `<p>Intro</p>${TITLED}<p>Diagram follows</p><img src="/api/attachments/1/d.png" alt="d"><p>End</p>`;
        const TOKEN_PAGE_BASE_SUGGESTION = 'Intro\n\n```js\nconst a = 1;\n```\n\nDiagram follows\n\nCQ\\_MEDIA\\_PLACEHOLDER\\_0\n\nEnd';

        async function pendingImprovement(pageId: number, improvedMarkdown: string): Promise<string> {
          const inserted = await query<{ id: string }>(
            `INSERT INTO llm_improvements
               (user_id, page_id, improvement_type, model, original_content, improved_content, status)
             VALUES ($1, $2, 'clarity', 'test-model', 'old', $3, 'completed')
             RETURNING id`,
            [userId, pageId, improvedMarkdown],
          );
          return inserted.rows[0]!.id;
        }
        const status = async (id: string): Promise<string | undefined> =>
          (await query<{ status: string }>('SELECT status FROM llm_improvements WHERE id = $1', [id])).rows[0]?.status;

        it('refuses a pending suggestion of the previous release for a page with a frozen code block (CM-1)', async () => {
          const pageId = await seedPage(CM1_PAGE);
          const improvementId = await pendingImprovement(pageId, CM1_BASE_SUGGESTION);

          const response = await apply(pageId, CM1_BASE_SUGGESTION, { improvementId });

          expect(response.statusCode, response.body).toBe(422);
          expect(response.body).toMatch(/run AI Improve again/);
          await expectUnchanged(pageId, CM1_PAGE);
          expect(await status(improvementId)).toBe('completed');
        });

        it('refuses a pending suggestion of the previous release for a page with annotated code that is not frozen (D26 2(b))', async () => {
          const pageId = await seedPage(TOKEN_PAGE);
          const improvementId = await pendingImprovement(pageId, TOKEN_PAGE_BASE_SUGGESTION);

          const response = await apply(pageId, TOKEN_PAGE_BASE_SUGGESTION, { improvementId });

          expect(response.statusCode, response.body).toBe(422);
          await expectUnchanged(pageId, TOKEN_PAGE);
          expect(await status(improvementId)).toBe('completed');
        });

        it('refuses an unchanged echo whose frozen original one HTML parse cannot give back (CM-3)', async () => {
          const original = '<p>a</p><pre data-title="Guide">\n\n<code>x</code></pre>';
          const pageId = await seedPage(original);

          const response = await apply(pageId, faithfulEcho(original));

          expect(response.statusCode, response.body).toBe(422);
          await expectUnchanged(pageId, original);
        });

        it('refuses a result only its relocation projection would publish with a twin, and writes nothing (CM-8)', async () => {
          const original = '<table><tbody><tr><td><pre data-title="Title"><code class="language-js">sample</code></pre></td></tr></tbody></table>';
          const pageId = await seedPage(original);
          const echo = `${faithfulEcho(original, NONCE)}\n\n<pre><code class="language-js"><textarea>\n\nsample</textarea></code></pre>\n`;
          const improvementId = await storeCodeMetaRow(pageId, echo);

          const response = await apply(pageId, echo, { improvementId });

          expect(response.statusCode, response.body).toBe(422);
          expect(response.json()).toMatchObject({ reason: 'unapproved-code-macro' });
          await expectUnchanged(pageId, original);
        });
      });

      describe('review r3 (D26): the matched row decides the path', () => {
        // Pages and suggestions generated on a06f304c (disposable worktree), with that release's Accept result.
        const IMG = (name: string): string => `<img src="/api/attachments/1/${name}.png" alt="${name}">`;
        const LN = ' data-macro-params="{&quot;linenumbers&quot;:&quot;true&quot;}"';
        const SAMPLE_TABLE = '<table><tbody><tr><td><pre data-title="Sample"><code class="language-js">const x = 1;</code></pre></td></tr></tbody></table>';
        const MENTION = '<p>Inspect <code>CQ_CODE_PLACEHOLDER_COUNT</code> in diagnostics.</p>';
        const MENTION_MD = 'Inspect `CQ_CODE_PLACEHOLDER_COUNT` in diagnostics.';
        const IDENTIFIER_TABLE = `<table><tbody><tr><td><pre data-title="Sample"${LN}><code class="language-js">const n = CQ_CODE_PLACEHOLDER_0_COUNT;</code></pre></td></tr></tbody></table>`;
        const BOLD_TABLE = '<table><tbody><tr><td><pre data-title="Sample"><code class="language-js">x()</code></pre></td></tr></tbody></table>';
        const DRAWIO = '<div class="confluence-drawio" data-diagram-name="flow"><img src="/api/attachments/1/flow.png" alt="flow"></div>';
        const ANNOTATED: ReadonlyArray<[string, string, string]> = [
          ['r2 CM2-1 literal mention, frozen code', `${SAMPLE_TABLE}${MENTION}<p>Diagram follows</p>${IMG('d')}<p>End</p>`,
            `${SAMPLE_TABLE}\n\n${MENTION_MD}\n\nDiagram follows\n\nCQ\\_MEDIA\\_PLACEHOLDER\\_0\n\nEnd`],
          ['r2 CM2-2 image inside a titled block', `<pre data-title="Pic"><code class="language-js">a${IMG('x')}b</code></pre><p>Then</p>${IMG('d')}<p>End</p>`,
            '```js\na CQ_MEDIA_PLACEHOLDER_0 b\n```\n\nThen\n\nCQ\\_MEDIA\\_PLACEHOLDER\\_1\n\nEnd'],
          ['r3 CM3-1 titled draw.io block spelling a placeholder', `<p>Flow</p><pre data-title="Flow"><code class="language-drawio">Build CQ_CODE_PLACEHOLDER_0 chart</code></pre>${IMG('d')}`,
            'Flow\n\n```drawio\nBuild CQ_CODE_PLACEHOLDER_0 chart\n```\n\nCQ\\_MEDIA\\_PLACEHOLDER\\_0'],
          ['r3 CM3-1 identifier containing a placeholder', `${IDENTIFIER_TABLE}<p>Notes</p>`,
            `${IDENTIFIER_TABLE}\n\nNotes\n\nUse CQ_CODE_PLACEHOLDER_0_COUNT to size the buffer.`],
          ['r3 CM3-2 bold authored placeholder', `${BOLD_TABLE}<p>See <strong>CQ_CODE_PLACEHOLDER_0</strong> here.</p>`,
            `${BOLD_TABLE}\n\nSee **CQ\\_CODE\\_PLACEHOLDER\\_0** here.`],
          ['r3 CM3-3 raw table cell with an image in a titled block',
            `<table><tbody><tr><td><pre data-title="How to wire"${LN}><code class="language-js">a${IMG('x')}b</code></pre></td></tr></tbody></table><p>End</p>`,
            `<table><tbody><tr><td><pre data-title="How to wire"${LN}><code class="language-js">a CQ_MEDIA_PLACEHOLDER_0 b</code></pre></td></tr></tbody></table>\n\nEnd`],
          ['r3 CM3-4 titled and bare twins in a frozen macro',
            '<div class="confluence-macro-unknown" data-macro-name="foo"><pre data-title="Titled"><code class="language-js">run()</code></pre><pre><code class="language-js">run()</code></pre></div><p>End</p>',
            'CQ\\_MEDIA\\_PLACEHOLDER\\_0\n\nEnd'],
        ];

        async function storedImprovement(pageId: number, improvedMarkdown: string, protocol: number | null): Promise<string> {
          if (protocol === 1) return storeCodeMetaRow(pageId, improvedMarkdown);
          const inserted = await query<{ id: string }>(
            `INSERT INTO llm_improvements
               (user_id, page_id, improvement_type, model, original_content, improved_content, status, improve_protocol)
             VALUES ($1, $2, 'clarity', 'test-model', 'old', $3, 'completed', $4)
             RETURNING id`,
            [userId, pageId, improvedMarkdown, protocol],
          );
          return inserted.rows[0]!.id;
        }
        const status = async (id: string): Promise<string | undefined> =>
          (await query<{ status: string }>('SELECT status FROM llm_improvements WHERE id = $1', [id])).rows[0]?.status;

        it.each(ANNOTATED)('(b) refuses a pending pre-#1958 suggestion on a page with annotated code: %s', async (_name, page, suggestion) => {
          const pageId = await seedPage(page);
          const improvementId = await storedImprovement(pageId, suggestion, null);

          const response = await apply(pageId, suggestion, { improvementId });

          expect(response.statusCode, response.body).toBe(422);
          expect(response.body).toMatch(/made before an update/);
          await expectUnchanged(pageId, page);
          expect(await status(improvementId)).toBe('completed');
        });

        it.each([
          ['an image inside an untitled block', `<pre><code class="language-js">a${IMG('x')}b</code></pre><p>Then</p>${IMG('d')}<p>End</p>`,
            '```js\na CQ_MEDIA_PLACEHOLDER_0 b\n```\n\nThen\n\nCQ\\_MEDIA\\_PLACEHOLDER\\_1\n\nEnd',
            `<pre><code class="language-js">a ${IMG('x')} b\n</code></pre>\n<p>Then</p>\n${IMG('d')}\n<p>End</p>\n`],
          ['a literal placeholder mention', `${MENTION}<pre><code class="language-js">const x = 1;</code></pre><p>Diagram follows</p>${IMG('d')}<p>End</p>`,
            `${MENTION_MD}\n\n\`\`\`js\nconst x = 1;\n\`\`\`\n\nDiagram follows\n\nCQ\\_MEDIA\\_PLACEHOLDER\\_0\n\nEnd`,
            `${MENTION}\n<pre><code class="language-js">const x = 1;\n</code></pre>\n<p>Diagram follows</p>\n${IMG('d')}\n<p>End</p>\n`],
          // Review r8 CM8-1: model outputs a06f304c's generator stored, with that release's Accept bytes.
          ['a token run into its caption', `<p>${IMG('d')}Figure 1.</p><p>End.</p>`,
            'CQ_MEDIA_PLACEHOLDER_0Figure 1.\n\nEnd.',
            `<p>${IMG('d')}Figure 1.</p>\n<p>End.</p>\n`],
          ['a block-media token run into a word in a task item', `<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>Step</p>${DRAWIO}</li></ul><p>End</p>`,
            '- [ ] Step\n\n  CQ\\_MEDIA\\_PLACEHOLDER\\_0see\n\nEnd',
            `<ul>\n<li><p>[ ] Step</p>\n<p>${DRAWIO}see</p>\n</li>\n</ul>\n<p>End</p>\n`],
        ])('(b) applies a pending pre-#1958 suggestion on a page without annotated code as that release did: %s', async (_name, page, suggestion, base) => {
          const pageId = await seedPage(page);
          const improvementId = await storedImprovement(pageId, suggestion, null);

          const response = await apply(pageId, suggestion, { improvementId });

          expect(response.statusCode, response.body).toBe(200);
          expect((await readPage(pageId)).body_html).toBe(base);
          expect(await status(improvementId)).toBe('applied');
        });

        it('(b) keeps the trust boundary: injected code metadata is stripped and a code-named placeholder refused', async () => {
          const page = `<p>Intro</p><pre><code class="language-js">a()</code></pre>${IMG('d')}`;
          const base = 'Intro\n\n```js\na()\n```\n\nCQ\\_MEDIA\\_PLACEHOLDER\\_0';
          const pageId = await seedPage(page);
          const named = `${base}\n\n<div class="confluence-macro-unknown" data-macro-name="code">x</div>\n`;
          const injected = `${base}\n\n<pre data-title="Evil" data-macro-params="{&quot;a&quot;:&quot;b&quot;}"><code>raw()</code></pre>\n`;
          const namedId = await storedImprovement(pageId, named, null);
          const injectedId = await storedImprovement(pageId, injected, null);

          const refused = await apply(pageId, named, { improvementId: namedId });
          expect(refused.statusCode, refused.body).toBe(422);
          expect(refused.json()).toMatchObject({ reason: 'unapproved-code-macro' });
          await expectUnchanged(pageId, page);

          const stripped = await apply(pageId, injected, { improvementId: injectedId });
          expect(stripped.statusCode, stripped.body).toBe(200);
          const saved = (await readPage(pageId)).body_html;
          expect(saved).toContain('<pre><code>raw()</code></pre>');
          expect(saved).not.toMatch(/data-title|data-macro-params/);
        });

        it('(a) applies a #1958 suggestion on a page with frozen code, keeping the block and its title', async () => {
          const page = `${SAMPLE_TABLE}<p>Diagram follows</p>${IMG('d')}<p>End</p>`;
          const suggestion = faithfulEcho(page, NONCE);
          const pageId = await seedPage(page);
          const improvementId = await storedImprovement(pageId, suggestion, 1);

          const response = await apply(pageId, suggestion, { improvementId });

          expect(response.statusCode, response.body).toBe(200);
          const saved = (await readPage(pageId)).body_html;
          expect(saved.match(/data-title="Sample"/g)).toHaveLength(1);
          expect(saved).toContain(IMG('d'));
          expect(await status(improvementId)).toBe('applied');
        });

        it('(a) applies a #1958 suggestion on a page whose own text spells a placeholder: that text stays text (D28)', async () => {
          const page = `${BOLD_TABLE}<p>See <strong>CQ_CODE_PLACEHOLDER_0</strong> here.</p>`;
          const suggestion = faithfulEcho(page, NONCE);
          const pageId = await seedPage(page);
          const improvementId = await storedImprovement(pageId, suggestion, 1);

          const response = await apply(pageId, suggestion, { improvementId });

          expect(response.statusCode, response.body).toBe(200);
          const saved = (await readPage(pageId)).body_html;
          expect(saved.match(/<pre/g)).toHaveLength(1);
          expect(saved).toMatch(/<td><pre data-title="Sample"><code class="language-js">x\(\)<\/code><\/pre><\/td>/);
          expect(saved).toContain('<strong>CQ_CODE_PLACEHOLDER_0</strong>');
          expect(await status(improvementId)).toBe('applied');
        });

        it('(c) refuses Markdown no #1958 row binds on a page with protected code: no nonce can place its block (D28)', async () => {
          const page = `${SAMPLE_TABLE}<p>Diagram follows</p>${IMG('d')}<p>End</p>`;
          const pageId = await seedPage(page);

          for (const markdown of [`${SAMPLE_TABLE}\n\nDiagram follows\n\nCQ\\_MEDIA\\_PLACEHOLDER\\_0\n\nEnd`, faithfulEcho(page), faithfulEcho(page, NONCE)]) {
            const unbound = await apply(pageId, markdown);
            expect(unbound.statusCode, unbound.body).toBe(422);
            expect(unbound.body).toMatch(/not an AI Improve suggestion stored for this page/);
            await expectUnchanged(pageId, page);
          }

          const echo = faithfulEcho(page, NONCE);
          const bound = await apply(pageId, echo, { improvementId: await storeCodeMetaRow(pageId, echo) });
          expect(bound.statusCode, bound.body).toBe(200);
          expect((await readPage(pageId)).body_html.match(/data-title="Sample"/g)).toHaveLength(1);
        });

        describe('review r4 (D27): provenance and status bind to the selected improvement id only', () => {
          const TITLED_PAGE = '<p>Intro</p><pre data-title="T"><code class="language-js">a()</code></pre>';
          const OLD_SUGGESTION = 'Intro\n\n```js\na()\n```';

          it.each(['legacy row newer', 'protocol row newer'] as const)(
            'binds the row the request names when a pre-#1958 and a #1958 row hold the same text (CM4-3, %s)',
            async (ordering) => {
              const pageId = await seedPage(TITLED_PAGE);
              const first = await storedImprovement(pageId, OLD_SUGGESTION, ordering === 'legacy row newer' ? 1 : null);
              const second = await storedImprovement(pageId, OLD_SUGGESTION, ordering === 'legacy row newer' ? null : 1);
              const [legacy, current] = ordering === 'legacy row newer' ? [second, first] : [first, second];

              const old = await apply(pageId, OLD_SUGGESTION, { improvementId: legacy });
              expect(old.statusCode, old.body).toBe(422);
              expect(old.body).toMatch(/made before an update/);
              await expectUnchanged(pageId, TITLED_PAGE);
              expect([await status(legacy), await status(current)]).toEqual(['completed', 'completed']);

              const fresh = await apply(pageId, OLD_SUGGESTION, { improvementId: current });
              expect(fresh.statusCode, fresh.body).toBe(200);
              expect([await status(legacy), await status(current)]).toEqual(['completed', 'applied']);
            },
          );

          it('treats a request without an id, or with a row that fails the checks, as new input and changes no row', async () => {
            const pageId = await seedPage(TITLED_PAGE);
            const otherPageId = await seedPage('<p>Elsewhere</p>');
            const legacy = await storedImprovement(pageId, OLD_SUGGESTION, null);
            const foreign = await storedImprovement(otherPageId, OLD_SUGGESTION, null);
            const applied = await storedImprovement(pageId, OLD_SUGGESTION, null);
            await query("UPDATE llm_improvements SET status = 'applied' WHERE id = $1", [applied]);

            // The text equals a stored pre-#1958 row, but nothing names it: the #1958 path, no row changes.
            const unbound = await apply(pageId, OLD_SUGGESTION);
            expect(unbound.statusCode, unbound.body).toBe(200);
            expect(await status(legacy)).toBe('completed');
            // Another page's row and an already applied row do not bind either.
            for (const improvementId of [foreign, applied]) {
              const response = await apply(pageId, OLD_SUGGESTION, { improvementId, version: (await readPage(pageId)).version });
              expect(response.statusCode, response.body).toBe(200);
            }
            expect([await status(legacy), await status(foreign), await status(applied)]).toEqual(['completed', 'completed', 'applied']);
          });

          it('binds a long suggestion by id, not by a prefix of its text (CM4-1)', async () => {
            const page = `<p>Intro</p>${IMG('d')}<p>End</p>`;
            const long = `Intro\n\n${'Long prose. '.repeat(5000)}\n\nCQ\\_MEDIA\\_PLACEHOLDER\\_0\n\nEnd`;
            expect(long.length).toBeGreaterThan(50_000);
            const pageId = await seedPage(page);
            const row = await storedImprovement(pageId, long.slice(0, 50_000), null);

            // A suffix-only edit with no id: new input, the row stays as it was.
            const edited = await apply(pageId, `${long}\n\nRevised.`);
            expect(edited.statusCode, edited.body).toBe(200);
            expect(await status(row)).toBe('completed');
            // The selected row binds whatever its stored text: the pre-#1958 base path on this plain page, and it is applied.
            const bound = await apply(pageId, long, { improvementId: row, version: 6 });
            expect(bound.statusCode, bound.body).toBe(200);
            expect(await status(row)).toBe('applied');
            expect((await readPage(pageId)).body_html.match(/<img /g)).toHaveLength(1);
          });

          it('refuses an edited old suggestion whose only placement is a placeholder the page writes in its own paragraph (CM4-2)', async () => {
            const page = `${BOLD_TABLE}<p>Syntax</p><p>CQ_CODE_PLACEHOLDER_0</p><p>End</p>`;
            // Generated on a06f304c (disposable worktree).
            const old = `${BOLD_TABLE}\n\nSyntax\n\nCQ\\_CODE\\_PLACEHOLDER\\_0\n\nEnd`;
            const pageId = await seedPage(page);
            const row = await storedImprovement(pageId, old, null);

            const unchanged = await apply(pageId, old, { improvementId: row });
            expect(unchanged.statusCode, unchanged.body).toBe(422);
            await expectUnchanged(pageId, page);

            const edited = await apply(pageId, `${old}\n\nRevised.`);
            expect(edited.statusCode, edited.body).toBe(422);
            expect(edited.body).toMatch(/not an AI Improve suggestion stored for this page/);
            await expectUnchanged(pageId, page);
            expect(await status(row)).toBe('completed');
          });
        });

        describe('review r5/r6: what the page writes never places a protected block (D28 nonce)', () => {
          it.each([
            ['an inline element', '<p>CQ_CODE_<span>PLACEHOLDER_0</span></p>'],
            ['a comment', '<p>CQ_CODE_<!-- c -->PLACEHOLDER_0</p>'],
            ['an inline element and a numeric paragraph (r6 CM6-1)', '<p>CQ_CODE_<span>PLACEHOLDER_0</span></p><p>1 example</p>'],
          ])('refuses every suggestion that could only place the block at the authored spelling split by %s', async (_name, paragraph) => {
            const page = `${BOLD_TABLE}${paragraph}`;
            // Generated on a06f304c (disposable worktree): the paragraph as one escaped spelling.
            const old = `${BOLD_TABLE}\n\nCQ\\_CODE\\_PLACEHOLDER\\_0${paragraph.includes('1 example') ? '\n\n1 example' : ''}`;
            const current = faithfulEcho(page, NONCE);
            expect(current).toContain(`<td>CQ_CODE_PLACEHOLDER_${NONCE}_0</td>`);
            expect(current).toContain('CQ\\_CODE\\_PLACEHOLDER\\_0');
            const dropped = current.replace(`<td>CQ_CODE_PLACEHOLDER_${NONCE}_0</td>`, '<td></td>');
            const pageId = await seedPage(page);
            const legacy = await storedImprovement(pageId, old, null);
            const fresh = await storedImprovement(pageId, current, 1);
            const before = await readPage(pageId);

            const attempts: Array<[string, Record<string, unknown>]> = [
              [old, { improvementId: legacy }],
              [`${old}\n\nRevised.`, {}],
              // The model dropped the structural placeholder from the table; only the authored spelling is left.
              [dropped, { improvementId: fresh }],
              [`${dropped}\n\nRevised.`, {}],
            ];
            for (const [markdown, extra] of attempts) {
              const response = await apply(pageId, markdown, extra);
              expect(response.statusCode, `${markdown}: ${response.body}`).toBe(422);
              // Text, metadata, block count and place, version: all as they were.
              expect(await readPage(pageId)).toEqual(before);
            }
            expect([await status(legacy), await status(fresh)]).toEqual(['completed', 'completed']);

            // The generation's own echo places the block once, in the table, and keeps the authored text.
            const applied = await apply(pageId, current, { improvementId: fresh });
            expect(applied.statusCode, applied.body).toBe(200);
            const saved = (await readPage(pageId)).body_html;
            expect(saved.match(/<pre/g)).toHaveLength(1);
            expect(saved).toMatch(/<td><pre data-title="Sample"/);
            expect(saved).toContain('CQ_CODE_PLACEHOLDER_0');
            expect(await status(fresh)).toBe('applied');
          });
        });

        describe('review r7: no token is read at the start of another; a generation\'s tokens never reach the page', () => {
          // An ordinary image at media ordinal 0, then a macro holding titled code in a table cell (media ordinal 1).
          const PAGE = `${IMG('d')}<table><tbody><tr><td><div class="confluence-macro-unknown" data-macro-name="foo">`
            + '<pre data-title="Sample"><code class="language-js">x()</code></pre></div></td></tr></tbody></table>';
          const OVERLAP = '0abcdef123456789';
          const OTHER = 'fedcba9876543210';

          it.each([OVERLAP, OTHER])('applies the faithful echo whatever the nonce starts with (%s, CM7-1)', async (nonce) => {
            const pageId = await seedPage(PAGE);
            const echo = faithfulEcho(PAGE, nonce);
            const improvementId = await storeCodeMetaRow(pageId, echo, nonce);

            const response = await apply(pageId, echo, { improvementId });

            expect(response.statusCode, response.body).toBe(200);
            const saved = (await readPage(pageId)).body_html;
            expect(saved.match(/<img /g)).toHaveLength(1);
            expect(saved).toMatch(/<td><div class="confluence-macro-unknown" data-macro-name="foo"><pre data-title="Sample">/);
            expect(await status(improvementId)).toBe('applied');
          });

          it('keeps another generation\'s spelling as text and adds no image (CM7-1)', async () => {
            const pageId = await seedPage(PAGE);
            const suggestion = `${faithfulEcho(PAGE, OTHER)}\n\nArchived CQ_MEDIA_PLACEHOLDER_${OVERLAP}_1`;
            const improvementId = await storeCodeMetaRow(pageId, suggestion, OTHER);

            const response = await apply(pageId, suggestion, { improvementId });

            expect(response.statusCode, response.body).toBe(200);
            const saved = await readPage(pageId);
            expect(saved.version).toBe(6);
            expect(saved.body_html.match(/<img /g)).toHaveLength(1);
            expect(saved.body_html).toContain(`<p>Archived CQ_MEDIA_PLACEHOLDER_${OVERLAP}_1</p>`);
            expect(saved.body_html.match(/data-title="Sample"/g)).toHaveLength(1);
          });

          it('refuses a result that quotes this generation\'s placeholder, so its nonce never reaches the page (CM7-2)', async () => {
            const page = `${SAMPLE_TABLE}<p>End</p>`;
            const echo = faithfulEcho(page, NONCE);
            const quoted = `${echo}\n\nUse \`CQ_CODE_PLACEHOLDER_${NONCE}_0\` in scripts.`;
            const pageId = await seedPage(page);
            const improvementId = await storeCodeMetaRow(pageId, quoted);

            const response = await apply(pageId, quoted, { improvementId });

            expect(response.statusCode, response.body).toBe(422);
            await expectUnchanged(pageId, page);
            expect((await readPage(pageId)).body_text).not.toContain(NONCE);
            expect(await status(improvementId)).toBe('completed');
          });

          it('keeps prose that only starts like two tokens as text, with the page\'s one image (r8 CM8-2)', async () => {
            const page = `<p>Intro</p>${IMG('d')}<p>End</p>`;
            const suggestion = `${faithfulEcho(page)}\n\nPrefix example: CQ_MEDIA_PLACEHOLDER_0CQ_MEDIA_PLACEHOLDER_COUNT`;
            const pageId = await seedPage(page);

            const response = await apply(pageId, suggestion);

            expect(response.statusCode, response.body).toBe(200);
            const saved = (await readPage(pageId)).body_html;
            expect(saved.match(/<img /g)).toHaveLength(1);
            expect(saved).toContain('<p>Prefix example: CQ_MEDIA_PLACEHOLDER_0CQ_MEDIA_PLACEHOLDER_COUNT</p>');
          });

          it('refuses a placeholder whose nonce inline markup splits in the HTML but not in the text (r8 CM8-3)', async () => {
            const page = `${SAMPLE_TABLE}<p>End</p>`;
            const split = `${faithfulEcho(page, NONCE)}\n\nSee CQ\\_CODE\\_PLACEHOLDER\\_${NONCE.slice(0, 8)}<span>${NONCE.slice(8)}</span>\\_0 here.`;
            const pageId = await seedPage(page);
            const improvementId = await storeCodeMetaRow(pageId, split);

            const response = await apply(pageId, split, { improvementId });

            expect(response.statusCode, response.body).toBe(422);
            await expectUnchanged(pageId, page);
            expect(await status(improvementId)).toBe('completed');
          });
        });
      });
    });
  },
);
