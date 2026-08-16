/**
 * Markdown fence splitting for the eval-corpus translator (#1114).
 *
 * Lives here rather than beside the script because vitest only collects test
 * files under the src tree — a splitter tested next to the script is a
 * splitter tested nowhere, and this is the piece whose failure is silent.
 * Everything it marks as prose gets rewritten by a language model, so a
 * missed fence returns German where `fastify.register(...)` used to be:
 * still valid-looking text, indistinguishable from real content in any
 * downstream metric.
 */

/**
 * Split markdown into alternating prose and fenced-code segments.
 *
 * Only the prose segments are sent to the model. Fenced blocks come back
 * byte-identical, which is the whole point — `await fastify.register(...)`
 * translated into German is not a document, it is noise that still parses as
 * text and would be indistinguishable from real content in the metrics.
 */
export function splitFences(md: string): Array<{ code: boolean; text: string }> {
  const out: Array<{ code: boolean; text: string }> = [];
  const lines = md.split('\n');
  let buf: string[] = [];
  let inFence = false;
  let fenceMarker = '';

  const flush = (code: boolean) => {
    if (buf.length) out.push({ code, text: buf.join('\n') });
    buf = [];
  };

  for (const line of lines) {
    const fence = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence && !inFence) {
      flush(false);
      inFence = true;
      fenceMarker = fence[1]!;
      buf.push(line);
    } else if (inFence && fence && line.trim().startsWith(fenceMarker)) {
      buf.push(line);
      flush(true);
      inFence = false;
      fenceMarker = '';
    } else {
      buf.push(line);
    }
  }
  flush(inFence);
  return out;
}

/**
 * Reject a translation that came back empty for non-empty input (#1114).
 *
 * This is the corpus translator's most dangerous failure and the reason it is
 * a named, tested function rather than an inline `if`. A REASONING model
 * (qwen3.5, for one) spends its token budget in `reasoning_content` and
 * returns `content: ""`. An empty string is still a string, so it satisfies
 * every type check downstream: the run completes, reports success, and writes
 * a corpus of blank documents. Every retrieval number measured against it
 * would then be real arithmetic over nothing.
 *
 * Whitespace-only counts as empty for the same reason. Empty input is
 * legitimately empty output — a document can contain consecutive fences with
 * nothing between them.
 */
export function assertUsableTranslation(input: string, output: string): void {
  if (!input.trim()) return;
  if (!output.trim()) {
    throw new Error(
      'translate: model returned EMPTY content for non-empty input — if this model emits ' +
      '`reasoning_content`, it is a reasoning model; use an instruct model (TRANSLATE_MODEL) ' +
      'or raise max_tokens',
    );
  }
}
