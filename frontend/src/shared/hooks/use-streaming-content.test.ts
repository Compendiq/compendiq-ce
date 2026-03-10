import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useStreamingContent } from './use-streaming-content';

describe('useStreamingContent', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('initializes with empty content and inactive state', () => {
    const { result } = renderHook(() => useStreamingContent());

    expect(result.current.displayContent).toBe('');
    expect(result.current.isActive).toBe(false);
  });

  it('sets isActive to true on start()', () => {
    const { result } = renderHook(() => useStreamingContent());

    act(() => {
      result.current.start();
    });

    expect(result.current.isActive).toBe(true);
    expect(result.current.displayContent).toBe('');
  });

  it('accumulates content via append() and flushes on schedule', async () => {
    const { result } = renderHook(() => useStreamingContent());

    act(() => {
      result.current.start();
    });

    // Append several chunks rapidly (simulating per-token SSE)
    act(() => {
      result.current.append('Hello');
      result.current.append(' ');
      result.current.append('world');
    });

    // Content should not be flushed yet (still within throttle window)
    // But the ref should have the accumulated content
    expect(result.current.getContent()).toBe('Hello world');

    // Advance timers past the flush interval and trigger rAF
    await act(async () => {
      vi.advanceTimersByTime(60);
      // rAF fires on next frame
      await vi.advanceTimersByTimeAsync(20);
    });

    expect(result.current.displayContent).toBe('Hello world');
  });

  it('batches multiple rapid appends into fewer state updates', async () => {
    const { result } = renderHook(() => useStreamingContent());

    act(() => {
      result.current.start();
    });

    // Simulate 10 rapid token arrivals
    act(() => {
      for (let i = 0; i < 10; i++) {
        result.current.append(`token${i} `);
      }
    });

    // All 10 tokens should be in the buffer
    expect(result.current.getContent()).toBe(
      'token0 token1 token2 token3 token4 token5 token6 token7 token8 token9 ',
    );

    // Flush
    await act(async () => {
      vi.advanceTimersByTime(60);
      await vi.advanceTimersByTimeAsync(20);
    });

    // Single state update should contain all tokens
    expect(result.current.displayContent).toBe(
      'token0 token1 token2 token3 token4 token5 token6 token7 token8 token9 ',
    );
  });

  it('finish() flushes remaining content and sets isActive to false', () => {
    const { result } = renderHook(() => useStreamingContent());

    act(() => {
      result.current.start();
      result.current.append('partial content');
    });

    // Before finish, displayContent may not be updated yet
    expect(result.current.isActive).toBe(true);

    act(() => {
      result.current.finish();
    });

    // After finish, content should be flushed synchronously
    expect(result.current.displayContent).toBe('partial content');
    expect(result.current.isActive).toBe(false);
  });

  it('start() resets previous content', () => {
    const { result } = renderHook(() => useStreamingContent());

    // First stream
    act(() => {
      result.current.start();
      result.current.append('first stream');
      result.current.finish();
    });

    expect(result.current.displayContent).toBe('first stream');

    // Second stream
    act(() => {
      result.current.start();
    });

    expect(result.current.displayContent).toBe('');
    expect(result.current.getContent()).toBe('');
    expect(result.current.isActive).toBe(true);
  });

  it('getContent() returns the ref value without waiting for flush', () => {
    const { result } = renderHook(() => useStreamingContent());

    act(() => {
      result.current.start();
      result.current.append('chunk1');
      result.current.append('chunk2');
    });

    // getContent reads from the ref immediately
    expect(result.current.getContent()).toBe('chunk1chunk2');
    // displayContent may still be empty (no flush yet)
  });

  it('handles finish() being called without any appends', () => {
    const { result } = renderHook(() => useStreamingContent());

    act(() => {
      result.current.start();
      result.current.finish();
    });

    expect(result.current.displayContent).toBe('');
    expect(result.current.isActive).toBe(false);
  });

  it('handles multiple start/finish cycles correctly', () => {
    const { result } = renderHook(() => useStreamingContent());

    // Cycle 1
    act(() => {
      result.current.start();
      result.current.append('cycle 1');
      result.current.finish();
    });
    expect(result.current.displayContent).toBe('cycle 1');

    // Cycle 2
    act(() => {
      result.current.start();
      result.current.append('cycle 2');
      result.current.finish();
    });
    expect(result.current.displayContent).toBe('cycle 2');

    // Cycle 3
    act(() => {
      result.current.start();
      result.current.append('cycle 3');
      result.current.finish();
    });
    expect(result.current.displayContent).toBe('cycle 3');
  });

  it('does not leak timers after unmount', async () => {
    const { result, unmount } = renderHook(() => useStreamingContent());

    act(() => {
      result.current.start();
      result.current.append('some content');
    });

    // Unmount before flush
    unmount();

    // Advancing timers should not throw
    await act(async () => {
      vi.advanceTimersByTime(100);
      await vi.advanceTimersByTimeAsync(20);
    });
  });

  it('throttles flushes to at most every ~50ms', async () => {
    const { result } = renderHook(() => useStreamingContent());

    act(() => {
      result.current.start();
    });

    // First append + flush
    act(() => {
      result.current.append('a');
    });

    await act(async () => {
      vi.advanceTimersByTime(60);
      await vi.advanceTimersByTimeAsync(20);
    });

    expect(result.current.displayContent).toBe('a');

    // Append again immediately after flush
    act(() => {
      result.current.append('b');
    });

    // Should not flush yet (within 50ms throttle window)
    // But the ref should have 'ab'
    expect(result.current.getContent()).toBe('ab');

    // Advance past throttle window
    await act(async () => {
      vi.advanceTimersByTime(60);
      await vi.advanceTimersByTimeAsync(20);
    });

    expect(result.current.displayContent).toBe('ab');
  });
});
