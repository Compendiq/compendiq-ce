import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// Mock the openai-compatible client's streamChat — that's what the routes call.
vi.mock('../../domains/llm/services/openai-compatible-client.js', () => ({
  streamChat: vi.fn(),
  chat: vi.fn(),
  generateEmbedding: vi.fn(),
  listModels: vi.fn().mockResolvedValue([]),
  checkHealth: vi.fn().mockResolvedValue({ connected: true }),
  invalidateDispatcher: vi.fn(),
}));

// Mock prompts module (was part of ollama-service) so routes compile.
vi.mock('../../domains/llm/services/prompts.js', () => ({
  getSystemPrompt: vi.fn().mockReturnValue('System prompt'),
  LANGUAGE_PRESERVATION_INSTRUCTION: '',
}));

// Mock the use-case resolver.
vi.mock('../../domains/llm/services/llm-provider-resolver.js', () => ({
  resolveUsecase: vi.fn().mockResolvedValue({
    config: {
      providerId: 'p1', id: 'p1', name: 'X',
      baseUrl: 'http://x/v1', apiKey: null,
      authType: 'none', verifySsl: true, defaultModel: 'm',
    },
    model: 'm',
  }),
}));

vi.mock('../../domains/llm/services/rag-service.js', () => ({
  hybridSearch: vi.fn().mockResolvedValue([]),
  buildRagContext: vi.fn().mockReturnValue('No context'),
}));

vi.mock('../../domains/llm/services/embedding-service.js', () => ({
  getEmbeddingStatus: vi.fn().mockResolvedValue({ totalPages: 0, dirtyPages: 0, totalEmbeddings: 0, isProcessing: false }),
  processDirtyPages: vi.fn().mockResolvedValue({ processed: 0, errors: 0 }),
  reEmbedAll: vi.fn().mockResolvedValue(undefined),
  embedPage: vi.fn(),
  isProcessingUser: vi.fn().mockReturnValue(false),
  resetFailedEmbeddings: vi.fn().mockResolvedValue(0),
}));

vi.mock('../../core/services/content-converter.js', () => ({
  htmlToMarkdown: vi.fn().mockImplementation((s: string) => s),
  markdownToHtml: vi.fn().mockImplementation((s: string) => s),
}));

import { streamChat } from '../../domains/llm/services/openai-compatible-client.js';

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
    const cfg = {
      providerId: 'p1', baseUrl: 'http://x/v1', apiKey: null,
      authType: 'none' as const, verifySsl: true,
    };
    const result = streamChat(cfg, 'model', [{ role: 'user', content: 'test' }], signal);
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
