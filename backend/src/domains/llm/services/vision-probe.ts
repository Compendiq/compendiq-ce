import { chat, type ProviderConfig } from './openai-compatible-client.js';
import { LlmHttpError } from './llm-http-error.js';
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
 * The one status that means "the provider understood the request and refused
 * the *media*" on its own. 415 is Unsupported Media Type — there is no reading
 * of it that is about anything but the content we sent.
 *
 * Deliberately narrower than the 4xx class: a naive "any 4xx" check also
 * catches 429 (rate limited), 401/403 (auth failure), 404 (model or route not
 * found) and 413 (payload too large) — none of which say anything about image
 * support. Since a `false` verdict is cached for up to
 * `CAPABILITY_MAX_AGE_DAYS` and only `null` is re-probed sooner, misclassifying
 * one of those would brand a rate-limited, misconfigured, or
 * merely-too-large-a-payload but vision-capable model as blind for a month.
 * Resist "simplifying" this to `status >= 400 && status < 500` — that
 * regression is exactly what this narrowing exists to prevent.
 */
const UNCONDITIONAL_REJECTION_STATUSES: ReadonlySet<number> = new Set([415]);

/**
 * Statuses that *can* mean "refused the image part" but need the body to say
 * so, because both are also the generic answer to a malformed request.
 *
 * - **400** is the obvious one: providers answer it for an unsupported
 *   parameter (`max_tokens` vs `max_completion_tokens`), an over-long context,
 *   or a malformed role — all from a fully vision-capable model.
 * - **422** looks more specific than it is. Every FastAPI-based
 *   OpenAI-compatible server (vLLM, LocalAI, llama-cpp-python) returns 422 for
 *   *any* request-body validation failure, because that is pydantic's default.
 *   `chat()` sends `max_tokens` unconditionally and `thinkingExtras` adds
 *   provider-specific fields on top, so a 422 about a field this probe itself
 *   introduced is entirely reachable — and treating it as definitive would
 *   cache `vision=false` on a capable model for a month. That is the same trap
 *   the 400 rule already avoids, so 422 gets the same treatment.
 *
 * Anything whose body does not talk about the image falls through to `null`,
 * so it is re-probed instead of cached as blind.
 */
const BODY_CONDITIONAL_REJECTION_STATUSES: ReadonlySet<number> = new Set([400, 422]);

/**
 * `images?` and `image_url` rather than a bare `\bimage\b`: "this model does not
 * support images" is at least as common a phrasing as the singular, and `\b`
 * after `image` refuses the trailing `s`.
 */
const IMAGE_REJECTION_BODY =
  /\b(images?|image_url|vision|multi-?modal|modalit(?:y|ies)|content[ _-]?part|visual)\b/i;

/**
 * Reads the typed status and body off `LlmHttpError` rather than parsing them
 * back out of `message`. Anything that is not an HTTP failure — a network
 * error, an open breaker, an abort — is not a capability verdict at all.
 */
function isDefinitiveRejection(err: unknown): boolean {
  if (!(err instanceof LlmHttpError)) return false;
  if (UNCONDITIONAL_REJECTION_STATUSES.has(err.status)) return true;
  return BODY_CONDITIONAL_REJECTION_STATUSES.has(err.status)
    && IMAGE_REJECTION_BODY.test(err.detail);
}

/**
 * What lands in `llm_model_capabilities.probe_error`. The provider's body is
 * included here — an admin diagnosing a wrong verdict needs it — but it is
 * assembled at this boundary rather than living in `err.message`, which
 * `pages-tags.ts` surfaces to callers.
 */
function describeProbeFailure(err: unknown): string {
  if (err instanceof LlmHttpError) {
    return err.detail ? `${err.message}: ${err.detail}` : err.message;
  }
  return err instanceof Error ? err.message : String(err);
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
    // 512, not 64: the matcher deliberately tolerates filler ("The three
    // horizontal bands from top to bottom are yellow, purple, and green.").
    // Reasoning models (such as Qwen 3.6, Gemma 4, DeepSeek R1) emit thinking
    // tokens inside a <think> block before producing the final answer. A tight 64
    // token budget cuts off mid-think, turning a capable vision-reasoning model into
    // a cached false negative. 512 tokens gives reasoning models enough room to
    // complete their thinking block and output the answer.
    const reply = await chat(cfg, model, messages, { maxTokens: 512 });
    const vision = replyNamesBandsInOrder(reply);
    logger.debug(
      { providerId: cfg.providerId, model, vision, reply: reply.slice(0, 120) },
      'Vision probe completed',
    );
    return { vision };
  } catch (err) {
    // `describeProbeFailure` folds in a slice of the provider's error body — it
    // is the whole point of the body-conditional branch above, but it is still
    // third-party text, so log a short prefix and keep the fuller version to
    // the `probe_error` column an admin has to go looking for.
    const message = describeProbeFailure(err);
    const logged = message.slice(0, 200);
    if (isDefinitiveRejection(err)) {
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
