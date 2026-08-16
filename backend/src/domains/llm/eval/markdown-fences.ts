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

/**
 * Split a prose run into chunks no larger than `maxChars`, at blank-line
 * (paragraph) boundaries where possible (#1114).
 *
 * Without this the translator sends each prose run as ONE request, and the
 * eval corpus contains 47KB documents. That request exceeds the model's
 * context, and the failure is not an error — the server simply never answers,
 * so the run sits at 0% CPU waiting on a socket while the server is idle. It
 * looks like slowness and is actually a hang.
 *
 * `chunks.join('\n')` reconstructs the input exactly, so chunking cannot
 * alter a document that survives translation unchanged. Splitting prefers
 * blank lines because a paragraph cut mid-sentence gives the translator half
 * a thought and produces visibly worse output; a single paragraph longer than
 * `maxChars` is emitted whole rather than cut, since a too-large request that
 * gets a real error beats silently mangled prose.
 */
export function chunkProse(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];

  const paragraphs: string[][] = [[]];
  for (const line of text.split('\n')) {
    paragraphs[paragraphs.length - 1]!.push(line);
    if (line.trim() === '') paragraphs.push([]);
  }

  const chunks: string[] = [];
  let current: string[] = [];
  let size = 0;

  // A paragraph longer than the budget is normally emitted whole, because
  // cutting hard-wrapped prose mid-sentence gives the translator half a
  // thought. A LIST is the exception and it matters: the eval corpus contains
  // a 47KB plugin catalogue written as one unbroken bulleted block with 14
  // blank lines in 745, so the paragraph rule alone yielded a 22KB chunk —
  // the size that makes a translator summarise instead of translate.
  //
  // The boundary is the ITEM, not the line. Items here are hard-wrapped over
  // several lines, so only 297 of 745 lines carry a marker; splitting on
  // marker density would have missed it, and splitting on every line would
  // cut wrapped descriptions in half.
  const LIST_MARKER = /^\s*(?:[-*+]|\d+[.)])\s/;
  const expanded: string[][] = [];
  for (const para of paragraphs) {
    const text = para.join('\n');
    const markers = para.filter((l) => LIST_MARKER.test(l)).length;
    if (text.length <= maxChars || markers < 3) {
      expanded.push(para);
      continue;
    }
    // Group each marker line with the continuation lines that follow it.
    const items: string[][] = [];
    for (const line of para) {
      if (LIST_MARKER.test(line) || items.length === 0) items.push([line]);
      else items[items.length - 1]!.push(line);
    }
    let group: string[] = [];
    let groupSize = 0;
    for (const item of items) {
      const itemText = item.join('\n');
      if (groupSize > 0 && groupSize + itemText.length + 1 > maxChars) {
        expanded.push(group);
        group = [];
        groupSize = 0;
      }
      if (group.length) groupSize += 1;
      group.push(...item);
      groupSize += itemText.length;
    }
    if (group.length) expanded.push(group);
  }

  for (const para of expanded) {
    if (para.length === 0) continue;
    const paraText = para.join('\n');
    if (size > 0 && size + paraText.length + 1 > maxChars) {
      chunks.push(current.join('\n'));
      current = [];
      size = 0;
    }
    if (current.length) size += 1;
    current.push(paraText);
    size += paraText.length;
  }
  if (current.length) chunks.push(current.join('\n'));
  return chunks.length ? chunks : [text];
}
