/**
 * Ceiling on a free-text prompt, in characters.
 *
 * Mirrors the one bound the LLM domain already sets — `improveSchema.instruction`
 * is `z.string().max(10000)` in `@compendiq/contracts`, which is what
 * ImproveMode's own textarea caps at. `/llm/ask` and `/llm/generate` set no
 * server-side max, so this is a client-side guard against pasting a whole
 * document into a composer that has no upload affordance for one.
 */
export const PROMPT_MAX_LENGTH = 10_000;
