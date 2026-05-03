export interface SSEEvent {
  data: unknown;
  type?: string;
}

/**
 * Extract accumulated text content from SSE events.
 * Assumes events have a `{ content: string }` data shape (matching
 * the Compendiq LLM streaming format).
 */
export function getSSEContent(events: SSEEvent[]): string {
  return events
    .filter((e) => {
      const data = e.data as Record<string, unknown> | null;
      return data && typeof data === 'object' && 'content' in data;
    })
    .map((e) => (e.data as { content: string }).content)
    .join('');
}

/**
 * Check if the SSE stream contains a "done" event.
 * Matches the `{ done: true }` sentinel used by the backend.
 */
export function hasSSEDoneEvent(events: SSEEvent[]): boolean {
  return events.some((e) => {
    const data = e.data as Record<string, unknown> | null;
    return data && typeof data === 'object' && data.done === true;
  });
}
