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
 * `` `chat HTTP ${status}: <body>` `` for any non-ok response, so a naive
 * "any 4xx" check also catches 429 (rate limited), 401/403 (auth failure), 404
 * (model or route not found) and 413 (payload too large) — none of which say
 * anything about image support. Since a `false` verdict is cached for up to
 * `CAPABILITY_MAX_AGE_DAYS` and only `null` is re-probed sooner,
 * misclassifying one of those as definitive would brand a rate-limited,
 * misconfigured, or merely-too-large-a-payload but vision-capable model as
 * blind for a month. Resist "simplifying" this back to `/HTTP 4\d\d/` — that
 * regression is exactly what this set exists to prevent.
 */
const UNCONDITIONAL_REJECTION_STATUSES: ReadonlySet<number> = new Set([415, 422]);

/**
 * 400 is the ambiguous one, and the status alone is not enough. Providers
 * answer 400 for an unsupported parameter (`max_tokens` vs
 * `max_completion_tokens`), an over-long context, or a malformed role — all
 * from a fully vision-capable model. Only a 400 whose body actually talks
 * about the image counts as a verdict; anything else falls through to `null`
 * so it gets re-probed instead of cached as blind.
 */
const IMAGE_REJECTION_BODY =
  /\b(image|image_url|vision|multi-?modal|modalit(?:y|ies)|content[ _-]?part|visual)\b/i;

function isDefinitiveRejection(message: string): boolean {
  const match = /HTTP (\d{3})/.exec(message);
  if (!match) return false;
  const status = Number(match[1]);
  if (UNCONDITIONAL_REJECTION_STATUSES.has(status)) return true;
  return status === 400 && IMAGE_REJECTION_BODY.test(message);
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
    // 64, not 16: the matcher deliberately tolerates filler ("The three
    // horizontal bands from top to bottom are yellow, purple, and green."),
    // and 16 tokens cuts that sentence before `green` — turning a correct
    // answer into a cached `false`. A reasoning model can also spend a tight
    // budget entirely on thinking tokens and return empty content, which maps
    // to the same wrong verdict. Not larger because the system prompt and the
    // "three words and nothing else" instruction are what keep the reply
    // short; this is only a runaway guard.
    const reply = await chat(cfg, model, messages, { maxTokens: 64 });
    const vision = replyNamesBandsInOrder(reply);
    logger.debug(
      { providerId: cfg.providerId, model, vision, reply: reply.slice(0, 120) },
      'Vision probe completed',
    );
    return { vision };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The message now carries a slice of the provider's error body. It is the
    // whole point of the 400 branch above, but it is still third-party text —
    // log a short prefix, and keep the fuller version to the `probe_error`
    // column an admin has to go looking for.
    const logged = message.slice(0, 200);
    if (isDefinitiveRejection(message)) {
      logger.debug({ providerId: cfg.providerId, model, message: logged }, 'Vision probe refused');
      return { vision: false, error: message };
    }
    logger.warn(
      { providerId: cfg.providerId, model, message: logged },
      'Vision probe inconclusive',
    );
    return { vision: null, error: message };
  }
}
