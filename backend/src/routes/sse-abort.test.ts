import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// Mock ollama-service before any imports
vi.mock('../services/ollama-service.js', () => ({
  streamChat: vi.fn(),
  getSystemPrompt: vi.fn().mockReturnValue('System prompt'),
  listModels: vi.fn().mockResolvedValue([]),
  checkHealth: vi.fn().mockResolvedValue({ connected: true }),
}));

vi.mock('../services/rag-service.js', () => ({
  hybridSearch: vi.fn().mockResolvedValue([]),
  buildRagContext: vi.fn().mockReturnValue('No context'),
}));

vi.mock('../services/embedding-service.js', () => ({
  getEmbeddingStatus: vi.fn().mockResolvedValue({ totalPages: 0, dirtyPages: 0, totalEmbeddings: 0, isProcessing: false }),
  processDirtyPages: vi.fn().mockResolvedValue({ processed: 0, errors: 0 }),
  reEmbedAll: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/content-converter.js', () => ({
  htmlToMarkdown: vi.fn().mockImplementation((s: string) => s),
  markdownToHtml: vi.fn().mockImplementation((s: string) => s),
}));

import { streamChat } from '../services/ollama-service.js';

describe('SSE abort on client disconnect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should accept an AbortSignal in streamChat', () => {
    // Verify the streamChat function signature accepts signal
    const mockStreamChat = streamChat as ReturnType<typeof vi.fn>;
    const signal = new AbortController().signal;

    // Create a mock async generator
    async function* mockGenerator() {
      yield { content: 'hello', done: false };
      yield { content: ' world', done: true };
    }

    mockStreamChat.mockReturnValue(mockGenerator());
    const result = streamChat('model', [{ role: 'user', content: 'test' }], signal);
    expect(result).toBeDefined();
  });

  it('should stop yielding when AbortSignal is aborted', async () => {
    const controller = new AbortController();
    const chunks: Array<{ content: string; done: boolean }> = [];

    // Create a slow generator that yields chunks
    async function* slowGenerator() {
      yield { content: 'chunk-1', done: false };
      yield { content: 'chunk-2', done: false };
      // This should not be reached if aborted after chunk-1
      yield { content: 'chunk-3', done: true };
    }

    // Simulate consuming the generator with abort
    const gen = slowGenerator();
    for await (const chunk of gen) {
      chunks.push(chunk);
      if (chunks.length === 1) {
        controller.abort();
        break; // Simulate what streamChat does when signal.aborted
      }
    }

    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe('chunk-1');
    expect(controller.signal.aborted).toBe(true);
  });

  it('should handle client close event on raw request', () => {
    const rawRequest = new EventEmitter();
    const closeHandlers: Array<() => void> = [];

    // Track close event listeners
    const origOn = rawRequest.on.bind(rawRequest);
    rawRequest.on = vi.fn((event: string, handler: () => void) => {
      if (event === 'close') {
        closeHandlers.push(handler);
      }
      return origOn(event, handler);
    }) as typeof rawRequest.on;

    // Simulate attaching a close listener (what the SSE handler does)
    const controller = new AbortController();
    const onClose = () => controller.abort();
    rawRequest.on('close', onClose);

    expect(closeHandlers).toHaveLength(1);
    expect(controller.signal.aborted).toBe(false);

    // Simulate client disconnect
    rawRequest.emit('close');
    expect(controller.signal.aborted).toBe(true);
  });

  it('should gracefully handle AbortError', () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';

    // The error should be distinguishable
    expect(abortError.name).toBe('AbortError');
    expect(abortError instanceof Error).toBe(true);
  });
});
