import { Page } from '@playwright/test';

export interface SSEEvent {
  data: unknown;
  type?: string;
}

/**
 * Collect SSE events from a POST request.
 * Triggers the request via page.evaluate (runs in the browser context),
 * captures the SSE stream, and returns parsed events.
 */
export async function collectSSE(
  page: Page,
  url: string,
  body: unknown,
  options?: { timeout?: number; token?: string },
): Promise<SSEEvent[]> {
  return page.evaluate(
    async ({ url, body, token, timeout }) => {
      const events: { data: unknown; type?: string }[] = [];
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout ?? 30000);

      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!res.body) {
          clearTimeout(timer);
          return events;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                events.push({ data: JSON.parse(line.slice(6)) });
              } catch {
                // Skip malformed JSON lines
              }
            }
          }
        }
      } catch (err) {
        // Abort or network error -- return whatever events we collected
        if (!(err instanceof DOMException && err.name === 'AbortError')) {
          console.error('SSE collection error:', err);
        }
      } finally {
        clearTimeout(timer);
      }

      return events;
    },
    { url, body, token: options?.token, timeout: options?.timeout },
  );
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
