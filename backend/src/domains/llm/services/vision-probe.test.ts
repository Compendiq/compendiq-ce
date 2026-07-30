import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockChat = vi.fn();
vi.mock('./openai-compatible-client.js', () => ({
  chat: (...args: unknown[]) => mockChat(...args),
}));

vi.mock('../../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { probeVision, PROBE_IMAGE_BASE64, PROBE_BANDS } from './vision-probe.js';

const CFG = {
  providerId: 'p1', baseUrl: 'http://x/v1', apiKey: null,
  authType: 'none' as const, verifySsl: true,
};

beforeEach(() => { mockChat.mockReset(); });

describe('probe image', () => {
  it('is a valid PNG under 1 KB', () => {
    const bytes = Buffer.from(PROBE_IMAGE_BASE64, 'base64');
    expect(bytes.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(bytes.length).toBeLessThan(1024);
  });

  it('declares 64x96 in its IHDR', () => {
    const bytes = Buffer.from(PROBE_IMAGE_BASE64, 'base64');
    expect(bytes.readUInt32BE(16)).toBe(64);
    expect(bytes.readUInt32BE(20)).toBe(96);
  });

  /**
   * "red green blue" is the sequence a text-only model is most likely to guess,
   * which would hand us a false positive for free.
   */
  it('does not use the canonical red/green/blue order', () => {
    expect([...PROBE_BANDS]).not.toEqual(['red', 'green', 'blue']);
  });
});

describe('probeVision', () => {
  it('sends the image as a content part on a user message', async () => {
    mockChat.mockResolvedValue('yellow purple green');
    await probeVision(CFG, 'qwen2.5vl');

    const messages = mockChat.mock.calls[0]![2];
    const user = messages.find((m: { role: string }) => m.role === 'user');
    expect(Array.isArray(user.content)).toBe(true);
    const imagePart = user.content.find(
      (p: { type: string }) => p.type === 'image_url',
    );
    expect(imagePart.image_url.url).toBe(`data:image/png;base64,${PROBE_IMAGE_BASE64}`);
  });

  /**
   * The matcher accepts filler, so the cap must leave room for a full sentence
   * naming all three bands — 16 tokens truncates before the last one.
   */
  it('allows enough tokens for a full-sentence answer', async () => {
    mockChat.mockResolvedValue('yellow purple green');
    await probeVision(CFG, 'm');
    expect(mockChat.mock.calls[0]![3]).toEqual({ maxTokens: 64 });
  });

  it('returns vision:true when the reply names all three bands in order', async () => {
    mockChat.mockResolvedValue('yellow purple green');
    expect(await probeVision(CFG, 'm')).toEqual({ vision: true });
  });

  it('tolerates punctuation and filler around the answer', async () => {
    mockChat.mockResolvedValue('Sure! The bands are yellow, purple, and green.');
    expect(await probeVision(CFG, 'm')).toEqual({ vision: true });
  });

  it('is case-insensitive', async () => {
    mockChat.mockResolvedValue('YELLOW PURPLE GREEN');
    expect(await probeVision(CFG, 'm')).toEqual({ vision: true });
  });

  it('returns vision:false when the bands are named out of order', async () => {
    mockChat.mockResolvedValue('green purple yellow');
    expect((await probeVision(CFG, 'm')).vision).toBe(false);
  });

  /**
   * The failure mode a blank 1x1 pixel cannot detect: the model accepted the
   * part, ignored it, and answered anyway. Known content turns that into a
   * correct negative instead of a false positive.
   */
  it('returns vision:false when the model answers without reading the image', async () => {
    mockChat.mockResolvedValue('I cannot see any image.');
    expect((await probeVision(CFG, 'm')).vision).toBe(false);
  });

  it('returns vision:false when the provider rejects the image part', async () => {
    mockChat.mockRejectedValue(new Error(
      'chat HTTP 400: {"error":{"message":"Invalid content type image_url for this model"}}',
    ));
    const result = await probeVision(CFG, 'm');
    expect(result.vision).toBe(false);
    expect(result.error).toMatch(/400/);
  });

  it.each([415, 422])('treats HTTP %i as a definitive text-only verdict', async (status) => {
    mockChat.mockRejectedValue(new Error(`chat HTTP ${status}`));
    expect((await probeVision(CFG, 'm')).vision).toBe(false);
  });

  /**
   * 415 and 422 are unambiguous enough on their own — the provider understood
   * the request and refused the media. No body required.
   */
  it.each([415, 422])(
    'treats HTTP %i as definitive even with an unrelated body',
    async (status) => {
      mockChat.mockRejectedValue(new Error(`chat HTTP ${status}: something else entirely`));
      expect((await probeVision(CFG, 'm')).vision).toBe(false);
    },
  );

  it.each([
    ['image content is not supported by this model'],
    ['This model does not support vision inputs'],
    ['multimodal input is disabled'],
    ['Invalid value for content part: image_url'],
  ])('treats a 400 whose body indicates image rejection as false: %s', async (body) => {
    mockChat.mockRejectedValue(new Error(`chat HTTP 400: ${body}`));
    expect((await probeVision(CFG, 'm')).vision).toBe(false);
  });

  /**
   * The regression this guards: `chat()` sends `max_tokens`, providers that
   * want `max_completion_tokens` answer 400, and treating that as definitive
   * would cache `vision=false` on a fully capable model for a month.
   */
  it.each([
    ["Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead."],
    ['This model\'s maximum context length is 8192 tokens'],
    ['Invalid value for role: developer'],
    [''],
  ])('returns vision:null for a 400 that is not about the image: %s', async (body) => {
    mockChat.mockRejectedValue(new Error(body ? `chat HTTP 400: ${body}` : 'chat HTTP 400'));
    expect((await probeVision(CFG, 'm')).vision).toBeNull();
  });

  /** A transient outage must not permanently mark a capable model blind. */
  it('returns vision:null on a network error', async () => {
    mockChat.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:11434'));
    const result = await probeVision(CFG, 'm');
    expect(result.vision).toBeNull();
    expect(result.error).toMatch(/ECONNREFUSED/);
  });

  it('returns vision:null when the breaker is open', async () => {
    mockChat.mockRejectedValue(new Error('Circuit breaker is OPEN for provider p1'));
    expect((await probeVision(CFG, 'm')).vision).toBeNull();
  });

  it('returns vision:null on HTTP 500', async () => {
    mockChat.mockRejectedValue(new Error('chat HTTP 500'));
    expect((await probeVision(CFG, 'm')).vision).toBeNull();
  });

  /**
   * These 4xx statuses carry no information about image support: 429 is a
   * rate limit, 401/403 are auth failures, 404 is a missing model or route.
   * None of them mean "the provider understood the request and refused the
   * image part" — only 400/415/422 do. Misclassifying these as a definitive
   * `false` would permanently brand a rate-limited or misconfigured but
   * vision-capable model as blind, since only `null` verdicts get re-probed.
   */
  it.each([429, 401, 403, 404])(
    'returns vision:null (not false) on HTTP %i — not a content rejection',
    async (status) => {
      mockChat.mockRejectedValue(new Error(`chat HTTP ${status}`));
      expect((await probeVision(CFG, 'm')).vision).toBeNull();
    },
  );
});
