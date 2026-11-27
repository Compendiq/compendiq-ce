import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { isDbAvailable } from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import { query } from '../../core/db/postgres.js';
import { buildLlmCacheKey } from '../../domains/llm/services/llm-cache.js';
import { llmImproveRoutes } from './llm-improve.js';
import { ArticleRouteFixture, sseEvents } from './article-route-test-fixture.js';

const available = await isDbAvailable() && await isRedisAvailable();
import { canAcceptImproveOutput, confluenceToHtml } from '../../core/services/content-converter.js';
const LAYOUT_CONTENT = confluenceToHtml('<ac:layout><ac:layout-section ac:type="two_equal"><ac:layout-cell><p>Left prose</p></ac:layout-cell><ac:layout-cell><p>Right prose</p></ac:layout-cell></ac:layout-section></ac:layout>');
const TOKENS = '[[[LAYOUT]]]\n\n[[[LAYOUT-SECTION two_equal]]]\n\n[[[LAYOUT-CELL]]]\n\nLeft prose\n\n[[[/LAYOUT-CELL]]]\n\n[[[LAYOUT-CELL]]]\n\nRight prose\n\n[[[/LAYOUT-CELL]]]\n\n[[[/LAYOUT-SECTION]]]\n\n[[[/LAYOUT]]]';

describe.skipIf(!available)('POST /api/llm/improve - layout-token cache guard', () => {
  const fixture = new ArticleRouteFixture();
  beforeAll(() => fixture.start(llmImproveRoutes));
  beforeEach(() => fixture.reset());
  afterAll(() => fixture.close());
  const improve = (content: string) => fixture.post('improve', { pageId: fixture.pageId, content, type: 'grammar', model: 'llama3' });
  const keys = () => fixture.redis.keys('kb:llm:*');

  it('does NOT cache a response that lost the layout tokens', async () => {
    fixture.output = 'Left prose improved\n\nRight prose improved';
    expect((await improve(LAYOUT_CONTENT)).statusCode).toBe(200);
    expect(await keys()).toHaveLength(0);
    await improve(LAYOUT_CONTENT);
    expect(fixture.requests).toHaveLength(2);
  });
  it('caches a response that kept the layout tokens', async () => {
    fixture.output = TOKENS.replace('Left prose', 'Left prose improved');
    expect((await improve(LAYOUT_CONTENT)).statusCode).toBe(200);
    expect(await keys()).toHaveLength(1);
  });
  it('caches normally for layout-free pages', async () => {
    expect((await improve('<p>Plain prose.</p>')).statusCode).toBe(200);
    expect(await keys()).toHaveLength(1);
  });
  it('flags layoutTokensLost=true when output lost tokens', async () => {
    const response = await improve(LAYOUT_CONTENT);
    expect(response.statusCode).toBe(200);
    expect(sseEvents(response.body).find((e) => e.final)).toMatchObject({ layoutTokensLost: true });
  });
  it('flags layoutTokensLost=false when output kept tokens', async () => {
    fixture.output = TOKENS;
    const response = await improve(LAYOUT_CONTENT);
    expect(sseEvents(response.body).find((e) => e.final)).toMatchObject({ layoutTokensLost: false });
  });
  it('flags layoutTokensLost=false for layout-free pages', async () => {
    const response = await improve('<p>Plain prose.</p>');
    expect(sseEvents(response.body).find((e) => e.final)).toMatchObject({ layoutTokensLost: false });
  });
  it('re-validates a hit before serving it: a token-less entry is not served, the provider is asked anew (#1958 r6 CM6-2)', async () => {
    fixture.output = TOKENS;
    expect((await improve(LAYOUT_CONTENT)).statusCode).toBe(200);
    const cachedKeys = await keys();
    expect(cachedKeys).toHaveLength(1);
    // A token-less output under the SAME recorded binding and key (an entry the Accept would refuse). The
    // provenance stays — #282 refuses an entry without one, which the test below pins.
    const entry = JSON.parse((await fixture.redis.get(cachedKeys[0]!))!);
    await fixture.redis.set(cachedKeys[0]!, JSON.stringify({ ...entry, content: 'token-less cached output' }));
    const response = await improve(LAYOUT_CONTENT);
    expect(response.statusCode).toBe(200);
    expect(fixture.requests).toHaveLength(2);
    expect(sseEvents(response.body).find((e) => e.final)).toMatchObject({ layoutTokensLost: false });
  });
  it('refuses a pre-#282 entry that carries no provenance rather than replaying it', async () => {
    fixture.output = TOKENS;
    expect((await improve(LAYOUT_CONTENT)).statusCode).toBe(200);
    const cachedKeys = await keys();
    await fixture.redis.set(cachedKeys[0]!, JSON.stringify({ content: 'token-less cached output', cachedAt: Date.now() }));
    const response = await improve(LAYOUT_CONTENT);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'ai_history_not_replayable', stage: 'chat' });
    expect(fixture.requests).toHaveLength(1);
  });
});

// #1958 (reviews r4 CM4-4, r5 CM5-2, r6 CM6-2; D28): the generator caches only an output the Accept's own
// conversion takes (canAcceptImproveOutput), under a key that also names the source HTML and the converter version,
// and re-checks a hit against the requesting page before serving it. A page with protected code gets a fresh code
// nonce per generation, so its prompt never repeats and nothing is served from the cache for it.
describe.skipIf(!available)('POST /api/llm/improve - Accept-bound cache (#1958)', () => {
  const fixture = new ArticleRouteFixture();
  beforeAll(() => fixture.start(llmImproveRoutes));
  beforeEach(() => fixture.reset());
  afterAll(() => fixture.close());
  const FROZEN_CONTENT = '<table><tbody><tr><td><pre data-title="Sample"><code class="language-js">x()</code></pre></td></tr></tbody></table><p>Prose</p>';
  const WRAPPER_CONTENT = '<div class="confluence-macro-unknown" data-macro-name="foo"><pre data-title="Sample"><code class="language-js">w()</code></pre></div><p>Prose</p>';
  const improve = (content: string) => fixture.post('improve', { pageId: fixture.pageId, content, type: 'grammar', model: 'llama3' });
  const keys = () => fixture.redis.keys('kb:llm:*');
  const lastNonce = async (): Promise<string> =>
    (await query<{ improve_code_nonce: string }>('SELECT improve_code_nonce FROM llm_improvements ORDER BY created_at DESC LIMIT 1')).rows[0]!.improve_code_nonce;

  it.each([
    ['a frozen code block', FROZEN_CONTENT, (nonce: string) => `<table><tbody><tr><td>CQ_CODE_PLACEHOLDER_${nonce}_0</td></tr></tbody></table>\n\nProse improved.`],
    ['a code-carrying macro', WRAPPER_CONTENT, (nonce: string) => `CQ\\_MEDIA\\_PLACEHOLDER\\_${nonce}\\_0\n\nProse improved.`],
  ])('asks the provider on every request for a page with %s; a usable output names that generation\'s nonce', async (_name, content, usable) => {
    fixture.output = 'Prose improved, the protected block left out.';
    expect((await improve(content)).statusCode).toBe(200);
    expect((await improve(content)).statusCode).toBe(200);
    expect(fixture.requests).toHaveLength(2);
    expect(await keys()).toHaveLength(0);

    const nonce = await lastNonce();
    expect(fixture.requests[1]!.messages.map((m) => m.content).join('\n')).toContain(nonce);
    fixture.output = usable(nonce);
    expect((await improve(content)).statusCode).toBe(200);
    expect(fixture.requests).toHaveLength(3);
    // Its own generation's output is accepted; the earlier nonce's is not (only that row's nonce places the block).
    const third = await lastNonce();
    expect(await canAcceptImproveOutput(content, usable(third), third)).toBe(true);
    expect(await canAcceptImproveOutput(content, usable(nonce), third)).toBe(false);
    expect(await keys()).toHaveLength(0);
  });

  it('never serves an entry another release\'s key holds, nor one cached for another source with the same prompt', async () => {
    // Two sources whose Markdown is the same (the comment does not reach the model).
    const source = '<p>Prose to improve.</p>';
    const sameMarkdown = '<p>Prose to improve.</p><!-- note -->';
    fixture.output = 'Prose improved.';
    expect((await improve(source)).statusCode).toBe(200);
    expect(await keys()).toHaveLength(1);
    expect((await improve(sameMarkdown)).statusCode).toBe(200);
    expect(fixture.requests).toHaveLength(2);
    expect(fixture.requests[0]!.messages).toEqual(fixture.requests[1]!.messages);
    expect(await keys()).toHaveLength(2);

    // An entry written under the key the release before #1958 used (prompt only, no source or converter variant).
    const [system, user] = fixture.requests[0]!.messages;
    const oldKey = buildLlmCacheKey(fixture.requests[0]!.model, system!.content, user!.content, fixture.providerId, {});
    const [entryKey] = await keys();
    const entry = JSON.parse((await fixture.redis.get(entryKey!))!);
    await fixture.redis.del(await keys());
    await fixture.redis.set(oldKey, JSON.stringify({ ...entry, content: 'Old release output.' }));
    const response = await improve(source);
    expect(response.statusCode).toBe(200);
    expect(fixture.requests).toHaveLength(3);
    expect(sseEvents(response.body).map((event) => event.content ?? '').join('')).toBe('Prose improved.');
  });

  it('re-validates a hit against the requesting page: an output its Accept refuses is regenerated', async () => {
    const source = '<p>Prose to improve.</p>';
    fixture.output = 'Prose improved.';
    expect((await improve(source)).statusCode).toBe(200);
    const [entryKey] = await keys();
    const entry = JSON.parse((await fixture.redis.get(entryKey!))!);
    // Same key, same recorded provenance, an output the Accept refuses (model-written code-named markup).
    const refused = 'Prose improved.\n\n<div class="confluence-macro-unknown" data-macro-name="code">x</div>\n';
    expect(await canAcceptImproveOutput(source, refused)).toBe(false);
    await fixture.redis.set(entryKey!, JSON.stringify({ ...entry, content: refused }));
    const response = await improve(source);
    expect(response.statusCode).toBe(200);
    expect(fixture.requests).toHaveLength(2);
    expect(sseEvents(response.body).map((event) => event.content ?? '').join('')).toBe('Prose improved.');
  });
});
