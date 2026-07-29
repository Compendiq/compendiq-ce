import { chat, type ProviderConfig } from './openai-compatible-client.js';
import type { ChatMessage } from './prompts.js';
import { logger } from '../../../core/utils/logger.js';

/**
 * #1154: establish whether a model accepts image input by asking it something
 * only a model that read the pixels can answer.
 *
 * A blank 1x1 pixel cannot distinguish "read the image" from "accepted the
 * part and ignored it" — the second case would probe as capable and then fail
 * at real use. Known visual content converts that into a correct negative.
 *
 * The image is three colour bands. Three bands from a six-colour vocabulary
 * puts a blind guesser at 1 in 216, so the residual false-positive rate is
 * ~0.5%, confined to models that both ignore the image and answer in the
 * required format. No probe reaches zero; this is the accepted trade for
 * needing no admin configuration.
 */

/** 64x96 PNG: yellow, purple, then green horizontal bands. 163 bytes. */
export const PROBE_IMAGE_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABgCAIAAAAip+O/AAAAaklEQVR42u3PQQkAAAgEsItuc81wT2Gw' +
  'AstuXouAgICAgICAgICAgICAgICAgICAgICAQB2YzGsCAgICAgICAgICAgICAgICAgICAgICAn3gPQEB' +
  'AQEBAQEBAQEBAQEBAQEBAQEBAQGB1gFiAfGWnsvsZAAAAABJRU5ErkJggg==';

/**
 * Deliberately not red/green/blue — that is the sequence a text-only model is
 * most likely to emit when guessing, which would be a free false positive.
 */
export const PROBE_BANDS = ['yellow', 'purple', 'green'] as const;

const PROBE_VOCABULARY = ['red', 'green', 'blue', 'yellow', 'orange', 'purple'];

export const PROBE_PROMPT =
  'This image has three horizontal colour bands. Name them from top to bottom, ' +
  `using only these words: ${PROBE_VOCABULARY.join(', ')}. ` +
  'Reply with the three words and nothing else.';

/**
 * Match by ordered appearance rather than exact equality: models answer
 * "Sure! The bands are yellow, purple, and green." at least as often as
 * "yellow purple green", and rejecting that would be a false negative.
 */
function replyNamesBandsInOrder(reply: string): boolean {
  const lower = reply.toLowerCase();
  let cursor = 0;
  for (const band of PROBE_BANDS) {
    const at = lower.indexOf(band, cursor);
    if (at === -1) return false;
    cursor = at + band.length;
  }
  return true;
}

/**
 * HTTP statuses that mean "the provider understood the request and refused
 * the *image part* specifically" — i.e. the response is informative about
 * capability, not just about the request failing.
 *
 * Deliberately narrower than the 4xx class. `chat()` throws
 * `` `chat HTTP ${status}` `` for any non-ok response, so a naive "any 4xx"
 * check also catches 429 (rate limited), 401/403 (auth failure), 404 (model
 * or route not found) and 413 (payload too large) — none of which say
 * anything about image support. Since Task 6 caches a `false` verdict
 * permanently and only re-probes `null`, misclassifying one of those as
 * definitive would permanently brand a rate-limited, misconfigured, or
 * merely-too-large-a-payload but vision-capable model as blind. Resist
 * "simplifying" this back to `/HTTP 4\d\d/` — that regression is exactly
 * what this set exists to prevent.
 */
const IMAGE_REJECTION_STATUSES: ReadonlySet<number> = new Set([400, 415, 422]);

function isDefinitiveRejection(message: string): boolean {
  const match = /HTTP (\d{3})/.exec(message);
  if (!match) return false;
  return IMAGE_REJECTION_STATUSES.has(Number(match[1]));
}

export async function probeVision(
  cfg: ProviderConfig,
  model: string,
): Promise<{ vision: boolean | null; error?: string }> {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'Answer with three words only.' },
    {
      role: 'user',
      content: [
        { type: 'text', text: PROBE_PROMPT },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${PROBE_IMAGE_BASE64}` } },
      ],
    },
  ];

  try {
    // Routed through chat(), so the probe inherits the queue and the
    // per-provider breaker rather than bypassing backpressure.
    const reply = await chat(cfg, model, messages, { maxTokens: 16 });
    const vision = replyNamesBandsInOrder(reply);
    logger.debug(
      { providerId: cfg.providerId, model, vision, reply: reply.slice(0, 120) },
      'Vision probe completed',
    );
    return { vision };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isDefinitiveRejection(message)) {
      logger.debug({ providerId: cfg.providerId, model, message }, 'Vision probe refused');
      return { vision: false, error: message };
    }
    logger.warn({ providerId: cfg.providerId, model, message }, 'Vision probe inconclusive');
    return { vision: null, error: message };
  }
}
