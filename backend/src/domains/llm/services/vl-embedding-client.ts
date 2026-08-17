/**
 * Vision-language embedding client — vLLM's chat-embeddings extension
 * (#1115, ADR-025 D4; the `rerank-client.ts` precedent).
 *
 * The path is `/v1/embeddings`, but the body is NOT OpenAI's `{model, input}`.
 * `Qwen3-VL-Embedding` is pooled at the **last token** of a chat prompt, so the
 * request carries a `messages` array — instruction as a `system` message, the
 * instance as a `user` message, and a trailing **empty `assistant` turn** plus
 * `continue_final_message: true`, which is how the online path reproduces
 * `add_generation_prompt=True` and makes the prompt end at
 * `<|im_start|>assistant\n`. vLLM applies the chat template on the `messages`
 * path ONLY: the plain `input` shape tokenises the bare string, pools a
 * different position, and produces off-distribution vectors that must never be
 * mixed into one index. That is why this is its own client rather than a branch
 * inside `openai-compatible-client.ts`'s `generateEmbedding`, and it is why
 * `image_embedding` never inherits the default provider.
 *
 * It still inherits everything every outbound provider call inherits, exactly
 * as `rerank-client.ts` does: the global LLM queue, the per-provider circuit
 * breaker, bearer auth headers and the per-provider TLS dispatcher (via
 * `providerRequestInfra`).
 *
 * ── NON-SUPPORT LIST (recorded so nobody re-derives it) ──────────────────
 *
 *  - **Hugging Face TEI** — no image concept anywhere in its OpenAPI spec
 *    (`/embed`, `/embed_all`, `/embed_sparse`, `/v1/embeddings`, `/rerank`, …);
 *    a substring search of the whole spec for image/multimodal/vision/pixel
 *    returns nothing. The request for this family
 *    (`text-embeddings-inference#822`, opened 2026-02-12) is open with zero
 *    comments, and the generic image-embedding request (#521) has been open
 *    since March 2025.
 *  - **LM Studio `/v1/embeddings`** — documents `input` (text) and `model`
 *    only; image support belongs to its chat surface.
 *  - **llama.cpp `llama-server`** — multimodal embeddings DO exist, but on the
 *    explicitly non-OpenAI `POST /embedding` route, with a hand-built prompt
 *    string and a per-server RANDOM media marker read from `/props`. The PR
 *    that would have added the OpenAI-shaped form (`ggml-org/llama.cpp#18665`)
 *    is closed and unmerged. That route is how the 8B eval is run directly; it
 *    is not reachable through this client.
 *  - **The plain `{model, input}` shape on ANY server** — mechanically accepted
 *    by the same vLLM instance, and wrong for the reason in the second
 *    paragraph. Treat it as unusable.
 *
 * The supported production path is **vLLM ≥ 0.14.0 with `--runner pooling`**.
 *
 * ── PIN THE VERSION; A BUMP IS A RE-INDEX EVENT (ADR-025 D12) ────────────
 *
 * vLLM's image preprocessing diverges from the reference `qwen_vl_utils` path
 * (~0.92 cosine on identical inputs — `vllm#33204`, open; acknowledged in
 * vLLM's own docs), and a quality regression between 0.14.0rc2 and 0.15.2 was
 * reported and closed as `vllm#33954`. A corpus embedded on one version and
 * queried on another is silently degraded, and nothing in this codebase can
 * detect it. Changing the served version is therefore the same event as
 * changing the model: `ensureImageEmbeddingColumn` truncates and re-scans.
 */
import { fetch as undiciFetch } from 'undici';
import { logger } from '../../../core/utils/logger.js';
import { enqueue } from './llm-queue.js';
import { getProviderBreaker } from '../../../core/services/circuit-breaker.js';
import { withSpan } from '../../../telemetry.js';
import {
  providerRequestInfra,
  LlmHttpError,
  type ProviderConfig,
} from './openai-compatible-client.js';
import { MAX_IMAGE_BYTES } from '../../../core/services/image-validator.js';
import type { ImageFormat } from '@compendiq/contracts';

/**
 * The corpus-side instruction — the checkpoint's own default, declared in
 * `config_sentence_transformers.json` and in the shipped `chat_template.jinja`.
 *
 * There is no "no instruction" mode: every input is wrapped in a system
 * message, and leaving it off means the template injects this exact string
 * anyway. Sending it explicitly makes the request self-describing and keeps the
 * corpus side stable if a server ever ships a different template default.
 */
export const VL_DEFAULT_INSTRUCTION = "Represent the user's input.";

/**
 * The query-side instruction, from the model card's and the upstream repo's
 * own mixed text+image retrieval quick-start.
 *
 * **English regardless of corpus language**, per the model card: "In
 * multilingual contexts, we also advise users to write their instructions in
 * English, as most instructions utilized during the model training process were
 * originally written in English." Translating this for a German corpus is a
 * plausible-looking change that measurably costs recall.
 */
export const VL_QUERY_INSTRUCTION = "Retrieve images or text relevant to the user's query.";

/** Substituted for an empty instance, matching the reference builder. */
const EMPTY_INSTANCE_SENTINEL = 'NULL';

/**
 * A returned vector is treated as unit norm inside this tolerance. Generous
 * because the wire carries float32 rounded through JSON; the check exists to
 * catch a server that is not normalising AT ALL, not to audit float error.
 */
const UNIT_NORM_TOLERANCE = 1e-3;

export interface VlImageItem {
  bytes: Buffer;
  format: ImageFormat;
}

export interface VlEmbedOptions {
  /**
   * MRL truncation. vLLM refuses this parameter unless the checkpoint declares
   * `is_matryoshka` — neither Qwen3-VL-Embedding config does, so serving must
   * pass `--hf-overrides '{"is_matryoshka": true}'` (see
   * `docs/runbooks/image-index.md`). Omitted from the body entirely when unset,
   * so a server without the override is not refused by default.
   */
  dimensions?: number;
}

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/**
 * The reference embedder appends a period when the instruction does not end in
 * punctuation, so the tokenisation matches what training saw. Both constants
 * above already comply; this is for a caller-supplied one.
 */
function normaliseInstruction(instruction: string): string {
  const trimmed = instruction.trim();
  if (!trimmed) return VL_DEFAULT_INSTRUCTION;
  return /\p{P}$/u.test(trimmed) ? trimmed : `${trimmed}.`;
}

function buildBody(
  model: string,
  instruction: string,
  userParts: ContentPart[],
  opts?: VlEmbedOptions,
): Record<string, unknown> {
  return {
    model,
    messages: [
      { role: 'system', content: [{ type: 'text', text: normaliseInstruction(instruction) }] },
      { role: 'user', content: userParts },
      // Load-bearing, and the single easiest thing to get wrong: the prompt
      // must END at `<|im_start|>assistant\n`, because that final `\n` is the
      // token that gets pooled. Drop this turn (or `continue_final_message`)
      // and the request still succeeds and still returns a well-formed vector
      // — of a different, lower-quality space.
      { role: 'assistant', content: [{ type: 'text', text: '' }] },
    ],
    encoding_format: 'float',
    continue_final_message: true,
    add_special_tokens: true,
    ...(opts?.dimensions !== undefined ? { dimensions: opts.dimensions } : {}),
  };
}

function l2Normalise(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((acc, x) => acc + x * x, 0));
  if (!Number.isFinite(norm) || norm === 0) {
    throw new LlmHttpError(
      'vlEmbedding',
      502,
      'The image-embedding endpoint returned a zero-norm vector — it cannot be normalised or compared by cosine.',
    );
  }
  return v.map((x) => x / norm);
}

/**
 * Post-process one returned vector.
 *
 * Two different jobs, deliberately not merged. With `dimensions`, the server
 * truncated a unit vector, which is no longer unit, and vLLM is not documented
 * to re-normalise on every path — so we do it, unconditionally, because cosine
 * over un-normalised vectors is not cosine. Without `dimensions`, the
 * checkpoint's own `2_Normalize` module has already done it, and a non-unit
 * answer means the server is not running the pooling+normalise path we think
 * it is: that is a MISCONFIGURATION, and silently "fixing" it here would hide
 * a whole index being built against a different formatting. Warn and pass
 * through.
 */
function finaliseVector(
  vector: number[],
  usedDimensions: boolean,
  cfg: ProviderConfig,
  model: string,
): number[] {
  if (usedDimensions) return l2Normalise(vector);
  const norm = Math.sqrt(vector.reduce((acc, x) => acc + x * x, 0));
  if (!Number.isFinite(norm) || Math.abs(norm - 1) > UNIT_NORM_TOLERANCE) {
    logger.warn(
      { providerId: cfg.providerId, model, norm },
      'VL embedding came back without unit norm at full width — the server may not be applying the checkpoint pooling/normalisation; vectors in this index are only comparable to each other',
    );
  }
  return vector;
}

/** One prompt, one request, one embedding — the `messages` path has no batch form. */
async function embedOne(
  cfg: ProviderConfig,
  model: string,
  instruction: string,
  userParts: ContentPart[],
  opts?: VlEmbedOptions,
): Promise<number[]> {
  const body = buildBody(model, instruction, userParts, opts);
  return withSpan(
    'llm.vl_embeddings',
    () =>
      enqueue((signal) =>
        getProviderBreaker(cfg.providerId).execute(async () => {
          const res = await undiciFetch(`${cfg.baseUrl}/embeddings`, {
            method: 'POST',
            headers: providerRequestInfra.headers(cfg),
            body: JSON.stringify(body),
            dispatcher: providerRequestInfra.dispatcherFor(cfg),
            signal,
          });
          if (!res.ok) {
            // Same rule as `generateEmbedding` (#867): a deterministic
            // client-input 400 proves the provider is REACHABLE, so it must not
            // count against a breaker shared with chat and text embeddings.
            // 404/405/422 deliberately do count here, unlike rerank's
            // misconfiguration set: this client posts to `/v1/embeddings`,
            // which every provider in the grid serves, so those statuses are
            // far likelier to be a sick server than a wrong assignment — and
            // the probe (`image-embedding-probe.ts`) is what catches a wrong
            // assignment, before any of this runs.
            throw new LlmHttpError(
              'vlEmbedding', res.status, await providerRequestInfra.errorDetail(res),
              res.status === 400,
            );
          }
          const parsed = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
          const vector = parsed.data?.[0]?.embedding;
          if (!Array.isArray(vector) || vector.length === 0) {
            throw new LlmHttpError(
              'vlEmbedding', 502, 'The image-embedding response carried no embedding',
            );
          }
          return finaliseVector(vector, opts?.dimensions !== undefined, cfg, model);
        }),
      ),
    { 'llm.provider_id': cfg.providerId, 'llm.model': model },
  );
}

/**
 * Embed images, one request each, in input order.
 *
 * The corpus side takes the DEFAULT instruction: the official retrieval
 * examples put a task instruction on the query only and leave documents on the
 * checkpoint default, and mixing the two across one index is the asymmetry the
 * model was trained with.
 *
 * Images are refused above `MAX_IMAGE_BYTES` BEFORE encoding — base64 inflates
 * them ~1.37x into a JSON body, so the point of refusing early is not to
 * materialise the string at all. Nothing here decodes pixels; format is the
 * caller's sniffed verdict (`sniffImageFormat`), never a filename.
 */
export async function embedImagesVl(
  cfg: ProviderConfig,
  model: string,
  items: VlImageItem[],
  opts?: VlEmbedOptions,
): Promise<number[][]> {
  for (const item of items) {
    if (item.bytes.length > MAX_IMAGE_BYTES) {
      throw new Error(
        `Refusing to embed a ${item.bytes.length}-byte image: the maximum is MAX_IMAGE_BYTES (${MAX_IMAGE_BYTES}).`,
      );
    }
  }
  const out: number[][] = [];
  for (const item of items) {
    // Image part first, then an (empty) text part — the order the reference
    // builder emits, and the order vLLM's own Qwen3-VL example sends.
    out.push(
      await embedOne(cfg, model, VL_DEFAULT_INSTRUCTION, [
        {
          type: 'image_url',
          image_url: { url: `data:image/${item.format};base64,${item.bytes.toString('base64')}` },
        },
        { type: 'text', text: '' },
      ], opts),
    );
  }
  return out;
}

/**
 * Embed texts under an explicit instruction, one request each, in input order.
 *
 * `instruction` is required rather than defaulted, because the whole point of
 * the text side is the asymmetry: a query takes `VL_QUERY_INSTRUCTION`, and
 * anything corpus-shaped takes `VL_DEFAULT_INSTRUCTION`. A default here would
 * make the wrong one the quiet option.
 */
export async function embedTextsVl(
  cfg: ProviderConfig,
  model: string,
  texts: string[],
  instruction: string,
  opts?: VlEmbedOptions,
): Promise<number[][]> {
  const out: number[][] = [];
  for (const text of texts) {
    const trimmed = text.trim();
    out.push(
      await embedOne(cfg, model, instruction, [
        { type: 'text', text: trimmed || EMPTY_INSTANCE_SENTINEL },
      ], opts),
    );
  }
  return out;
}
