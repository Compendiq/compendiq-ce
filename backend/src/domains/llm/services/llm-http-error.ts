/**
 * A non-ok HTTP response from an OpenAI-compatible provider.
 *
 * The status and the provider's error body are carried as **properties**, not
 * folded into `message`. Two reasons, both load-bearing:
 *
 *  1. `message` is client-visible. `routes/knowledge/pages-tags.ts` answers
 *     `502 "Auto-tagging failed: <message>"` (#151, deliberately), so anything
 *     in `message` reaches an authenticated user. A provider's raw error body
 *     is third-party text that can echo request fragments and internal
 *     topology, so it stays off that path and goes only to logs and the
 *     `llm_model_capabilities.probe_error` column an admin has to go looking
 *     for.
 *  2. #1154's vision probe has to distinguish "this model refused the image"
 *     from "this request was malformed for an unrelated reason", which means
 *     branching on the status *and* the body. Reading typed fields beats
 *     re-parsing them back out of a string that was only ever formatted for
 *     humans.
 *
 * Lives in its own module rather than in `openai-compatible-client.ts` so a
 * test that mocks the client cannot accidentally drop the export: an
 * `instanceof` against a missing class does not throw, it just quietly answers
 * `false`, which for the probe means a silent `null` verdict.
 */
export class LlmHttpError extends Error {
  constructor(
    /** The operation that failed, e.g. `chat` — prefixes the message. */
    operation: string,
    public readonly status: number,
    /**
     * Truncated slice of the provider's own error body, or `''` when it sent
     * none. Never part of `message` — see the note above.
     */
    public readonly detail: string = '',
    /**
     * #867: a deterministic client-input error (a context-length 400 from
     * `generateEmbedding`) proves the provider is reachable — it is NOT an
     * outage, so it must not count as a circuit-breaker failure. Otherwise one
     * oversized page's repeated 400s open the breaker and abort a whole
     * embedding run.
     *
     * A typed field rather than a duck-typed property bolted onto a re-thrown
     * plain `Error` — the earlier shape (`Error & { bypassCircuitBreaker? }`)
     * worked but had nothing tying the property to the class that always sets
     * it. `circuit-breaker.ts` still reads it via a duck-typed cast rather
     * than `instanceof LlmHttpError`, and that stays: it lives in `core`,
     * which cannot import a domain type, so the property still has to be
     * readable off an untyped `unknown`. This field is what makes that duck
     * typing sound instead of hopeful.
     */
    public readonly bypassCircuitBreaker: boolean = false,
  ) {
    super(`${operation} HTTP ${status}`);
    this.name = 'LlmHttpError';
  }
}

/** Cap on how much of a provider's error body we retain. */
export const ERROR_BODY_MAX_CHARS = 500;
