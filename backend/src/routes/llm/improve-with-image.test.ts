import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { isDbAvailable } from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import { query } from '../../core/db/postgres.js';
import { stageImage } from '../../core/services/image-staging.js';
import { ArticleRouteFixture } from './article-route-test-fixture.js';
import { llmImproveRoutes } from './llm-improve.js';

const available = await isDbAvailable() && await isRedisAvailable();
describe.skipIf(!available)('POST /llm/improve with a staged image', () => {
  const fixture = new ArticleRouteFixture();
  let handle: string;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
  beforeAll(() => fixture.start(llmImproveRoutes));
  afterAll(() => fixture.close());
  beforeEach(async () => {
    await fixture.reset();
    await query("INSERT INTO llm_model_capabilities (provider_id, model, vision, probed_at) VALUES ($1, 'm', TRUE, NOW())", [fixture.providerId]);
    handle = await stageImage(fixture.userId, png, 'png');
  });
  const post = (imageHandle?: string) => fixture.post('improve', {
    pageId: fixture.pageId, content: 'x', type: 'clarity', imageHandle,
  });
  it('sends the image as a user-message content part', async () => {
    expect((await post(handle)).statusCode).toBe(200);
    expect(fixture.requests).toHaveLength(1);
    const content = fixture.requests[0]!.messages.find((m) => m.role === 'user')!.content as unknown;
    expect(content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } }),
    ]));
  });
  it('sends a bare string without an image', async () => {
    expect((await post()).statusCode).toBe(200);
    expect(fixture.requests).toHaveLength(1);
    expect(typeof fixture.requests[0]!.messages.find((m) => m.role === 'user')!.content).toBe('string');
  });
  it('propagates text-only capability refusal as 422 without outbound bytes', async () => {
    await query('UPDATE llm_model_capabilities SET vision = FALSE WHERE provider_id = $1', [fixture.providerId]);
    expect((await post(handle)).statusCode).toBe(422);
    expect(fixture.requests).toHaveLength(0);
  });
});
