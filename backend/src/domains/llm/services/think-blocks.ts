/**
 * Provider reasoning (`<think>…</think>`) left in a reply's `content`.
 *
 * Never add a local `<think>` expression elsewhere: call these helpers.
 */

/** Remove every closed <think>…</think> block; nothing else. */
export function stripClosedThinkBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '');
}

export interface VisibleReply {
  text: string;
  /** The reply ended inside a reasoning block, so `text` is what preceded it. */
  unclosed: boolean;
}

/** The reply without provider reasoning, and whether it ended inside a reasoning block. */
export function stripThinkBlocks(reply: string): VisibleReply {
  let text = stripClosedThinkBlocks(reply);

  // Hosts whose chat template supplies the opening tag emit only the closer:
  // everything before the last orphan closer is reasoning.
  const closers = [...text.matchAll(/<\/think>/gi)];
  const lastCloser = closers[closers.length - 1];
  if (lastCloser) text = text.slice(lastCloser.index + lastCloser[0].length);

  const opener = text.search(/<think>/i);
  if (opener === -1) return { text, unclosed: false };
  return { text: text.slice(0, opener), unclosed: true };
}
