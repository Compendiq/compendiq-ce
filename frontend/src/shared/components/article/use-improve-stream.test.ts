import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// Mock the SSE transport at the lib boundary — the hook's job is to accumulate
// chunks and manage status, not to do real network I/O.
const streamSSE = vi.fn();
vi.mock('../../lib/sse', () => ({
  streamSSE: (...args: unknown[]) => streamSSE(...args),
}));

const decideRewrite = vi.fn(async () => ({ kind: 'server' as const }));
vi.mock('../../lib/client-inference/client-inference-manager', () => ({
  getClientInferenceManager: () => ({ decideRewrite }),
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
    decideRewrite.mockReset();
    decideRewrite.mockResolvedValue({ kind: 'server' });
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

  it('uses a local rewrite when the worker is ready and never flashes idle (SPEC-026)', async () => {
    decideRewrite.mockResolvedValue({ kind: 'local', text: 'Fixed locally.' });
    const { result } = renderHook(() => useImproveStream());
    await act(async () => {
      await result.current.run('teh passage', 'grammar');
    });
    expect(result.current.status).toBe('done');
    expect(result.current.output).toBe('Fixed locally.');
    expect(streamSSE).not.toHaveBeenCalled();
  });

  it('falls through to /llm/improve on a local miss without returning to idle', async () => {
    streamSSE.mockReturnValue(gen([{ content: 'server' }]));
    const { result } = renderHook(() => useImproveStream());
    await act(async () => {
      await result.current.run('teh passage', 'grammar');
    });
    expect(streamSSE).toHaveBeenCalledTimes(1);
    expect(result.current.output).toBe('server');
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

  it('does not add fast-diff or a QuickRewriteBubbleMenu (SPEC-006/013)', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = readFileSync(resolve(here, '../../../../package.json'), 'utf8');
    expect(pkg).not.toMatch(/fast-diff/);
    expect(() => readFileSync(resolve(here, 'QuickRewriteBubbleMenu.tsx'), 'utf8')).toThrow();
  });
});
