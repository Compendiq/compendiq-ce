/**
 * Chat-instruct continuation formatter (#1418 SPEC-020).
 * Copy of backend `normalizeInlineCompletion` rules — do not import backend.
 */

export function normalizeInlineCompletion(value: string): string {
  return value
    .replace(/\r/g, '')
    .split(/\n|```/, 1)[0]!
    .replace(/<\/?(?:PRE|SUF|MID)>/gi, '');
}

export function buildContinuationPrompt(prefix: string, suffix?: string): string {
  const head = prefix.slice(-2_000);
  const tail = suffix ? suffix.slice(0, 400) : '';
  return [
    'Continue the document at the cursor. Output only the continuation, one line, no quotes, no fences, no HTML.',
    tail ? `Text after the cursor:\n${tail}` : '',
    `Text before the cursor:\n${head}`,
    'Continuation:',
  ].filter(Boolean).join('\n\n');
}

export function capMaxTokens(requested: number, modeWord: boolean): number {
  const modeCap = modeWord ? 8 : 48;
  return Math.min(64, Math.max(1, Math.min(requested, modeCap)));
}

export function rewriteMaxNewTokens(inputChars: number): number {
  const estimate = Math.max(1, Math.ceil(inputChars / 4));
  return Math.min(512, Math.max(64, 2 * estimate));
}
