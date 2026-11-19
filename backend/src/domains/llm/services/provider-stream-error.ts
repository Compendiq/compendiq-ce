/**
 * Failures of a streaming completion that arrive INSIDE a `200` response, so
 * no HTTP status describes them (`LlmHttpError` covers the non-ok ones).
 *
 * Both are thrown by `streamChat` after it has yielded whatever text came
 * before the failure: that text is a prefix, never a result, so no consumer
 * may cache, publish or audit it as a completed answer. Neither counts
 * against the provider breaker (the dispatch itself succeeded).
 *
 * They live in their own module, as `LlmHttpError` does, so a test that mocks
 * `openai-compatible-client.ts` cannot drop them: an `instanceof` against a
 * missing class does not throw, it quietly answers `false`.
 */

/**
 * The provider closed a streaming response WITHOUT its `data: [DONE]`
 * terminator. Whatever text arrived before the EOF is a PREFIX of unknown
 * length, not a completion: a proxy timeout, a crashed worker or a dropped
 * socket all look exactly like this.
 */
export class StreamIncompleteError extends Error {
  constructor(public readonly receivedCharacters: number) {
    super('streamChat: provider ended the stream before [DONE]');
    this.name = 'StreamIncompleteError';
  }
}

/**
 * The provider sent an `error` frame in the stream (#1728). Some hosts follow
 * it with `data: [DONE]`, which must not turn the failure into a completed
 * empty or partial answer.
 */
export class ProviderStreamError extends Error {
  constructor(
    /** Visible characters delivered before the error frame. */
    public readonly receivedCharacters: number,
    /**
     * The provider's own error text, bounded by the caller. Third-party text,
     * so it is never part of `message` (see `LlmHttpError`): it may reach
     * server logs, never the client, an audit entry or stored state.
     */
    public readonly detail: string = '',
  ) {
    super('streamChat: provider reported an error in the stream');
    this.name = 'ProviderStreamError';
  }
}
