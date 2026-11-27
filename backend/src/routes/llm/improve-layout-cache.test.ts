import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { isDbAvailable } from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import { llmImproveRoutes } from './llm-improve.js';
import { ArticleRouteFixture, sseEvents } from './article-route-test-fixture.js';

const available = await isDbAvailable() && await isRedisAvailable();
import { confluenceToHtml } from '../../core/services/content-converter.js';
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
  it('computes the flag for a replayed token-less entry too', async () => {
    fixture.output = TOKENS;
    expect((await improve(LAYOUT_CONTENT)).statusCode).toBe(200);
    const cachedKeys = await keys();
    expect(cachedKeys).toHaveLength(1);
    // A token-less output under the SAME recorded binding (entries written
    // before the guard, inside their TTL). The provenance stays — #282
    // refuses an entry without one, which the test below pins.
    const entry = JSON.parse((await fixture.redis.get(cachedKeys[0]!))!);
    await fixture.redis.set(cachedKeys[0]!, JSON.stringify({ ...entry, content: 'token-less cached output' }));
    const response = await improve(LAYOUT_CONTENT);
    expect(response.statusCode).toBe(200);
    expect(sseEvents(response.body).find((e) => e.final)).toMatchObject({ layoutTokensLost: true });
    expect(fixture.requests).toHaveLength(1);
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

// #1958 (review r4 CM4-4): a titled code block in a table cell is frozen as CQ_CODE_PLACEHOLDER_0. An output that
// does not carry that placeholder exactly once can only be refused on Accept, so it is never cached: running AI
// Improve again reaches the provider until a usable output comes back, which is cached as before.
describe.skipIf(!available)('POST /api/llm/improve - frozen code-block cache guard (#1958)', () => {
  const fixture = new ArticleRouteFixture();
  beforeAll(() => fixture.start(llmImproveRoutes));
  beforeEach(() => fixture.reset());
  afterAll(() => fixture.close());
  const FROZEN_CONTENT = '<table><tbody><tr><td><pre data-title="Sample"><code class="language-js">x()</code></pre></td></tr></tbody></table><p>Prose</p>';
  const improve = () => fixture.post('improve', { pageId: fixture.pageId, content: FROZEN_CONTENT, type: 'grammar', model: 'llama3' });
  const keys = () => fixture.redis.keys('kb:llm:*');

  it('calls the provider anew while the output cannot place the frozen block, then caches a usable one', async () => {
    fixture.output = 'Prose improved, the sample left out.';
    expect((await improve()).statusCode).toBe(200);
    expect((await improve()).statusCode).toBe(200);
    expect(fixture.requests).toHaveLength(2);
    expect(await keys()).toHaveLength(0);

    fixture.output = '<table><tbody><tr><td>CQ_CODE_PLACEHOLDER_0</td></tr></tbody></table>\n\nProse improved.';
    expect((await improve()).statusCode).toBe(200);
    expect(fixture.requests).toHaveLength(3);
    expect(await keys()).toHaveLength(1);
    const replayed = await improve();
    expect(replayed.statusCode).toBe(200);
    expect(fixture.requests).toHaveLength(3);
    expect(sseEvents(replayed.body).map((event) => event.content ?? '').join('')).toContain('CQ_CODE_PLACEHOLDER_0');
  });
});
