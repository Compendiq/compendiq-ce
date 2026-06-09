import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// Mock the SSE transport at the lib boundary — the hook's job is to accumulate
// chunks and manage status, not to do real network I/O.
const streamSSE = vi.fn();
vi.mock('../../lib/sse', () => ({
  streamSSE: (...args: unknown[]) => streamSSE(...args),
}));

import { useImproveStream } from './use-improve-stream';

/** Build an async generator yielding the given chunks. */
function gen(chunks: Array<Record<string, unknown>>) {
  return (async function* () {
    for (const c of chunks) yield c;
  })();
}

describe('useImproveStream', () => {
  beforeEach(() => {
    streamSSE.mockReset();
  });

  it('accumulates streamed content and ends in done', async () => {
    streamSSE.mockReturnValue(gen([{ content: 'Hello ' }, { content: 'world' }]));

    const { result } = renderHook(() => useImproveStream());
    await act(async () => {
      await result.current.run('hi', 'grammar');
    });

    expect(result.current.output).toBe('Hello world');
    expect(result.current.status).toBe('done');
  });

  it('sends only the selection content with pageId omitted', async () => {
    streamSSE.mockReturnValue(gen([{ content: 'x' }]));

    const { result } = renderHook(() => useImproveStream());
    await act(async () => {
      await result.current.run('the passage', 'clarity', 'be concise');
    });

    expect(streamSSE).toHaveBeenCalledTimes(1);
    const [endpoint, body] = streamSSE.mock.calls[0]!;
    expect(endpoint).toBe('/llm/improve');
    expect(body).toMatchObject({ content: 'the passage', type: 'clarity', instruction: 'be concise' });
    expect(body).not.toHaveProperty('pageId');
    expect(body).not.toHaveProperty('includeSubPages');
    // A non-empty model is required by the schema even though the route ignores it.
    expect((body as { model: string }).model.length).toBeGreaterThan(0);
  });

  it('prefers finalContent (post-processed) over accumulated chunks', async () => {
    streamSSE.mockReturnValue(gen([{ content: 'partial' }, { finalContent: 'clean final' }]));

    const { result } = renderHook(() => useImproveStream());
    await act(async () => {
      await result.current.run('hi', 'grammar');
    });

    expect(result.current.output).toBe('clean final');
  });

  it('surfaces an error chunk as error status', async () => {
    streamSSE.mockReturnValue(gen([{ error: 'model unavailable' }]));

    const { result } = renderHook(() => useImproveStream());
    await act(async () => {
      await result.current.run('hi', 'grammar');
    });

    expect(result.current.status).toBe('error');
    expect(result.current.error).toBe('model unavailable');
  });

  it('reset clears output and returns to idle', async () => {
    streamSSE.mockReturnValue(gen([{ content: 'abc' }]));

    const { result } = renderHook(() => useImproveStream());
    await act(async () => {
      await result.current.run('hi', 'grammar');
    });
    expect(result.current.output).toBe('abc');

    act(() => result.current.reset());
    await waitFor(() => {
      expect(result.current.status).toBe('idle');
      expect(result.current.output).toBe('');
    });
  });
});
