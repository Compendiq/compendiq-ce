import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';

// Mock prompts module (getSystemPrompt extracted from the legacy ollama-service)
const mockStreamChat = vi.fn();
const mockGetSystemPrompt = vi.fn().mockImplementation((key: string) => `System prompt for: ${key}`);

vi.mock('../../domains/llm/services/prompts.js', () => ({
  getSystemPrompt: (...args: unknown[]) => mockGetSystemPrompt(...args),
  LANGUAGE_PRESERVATION_INSTRUCTION: '',
  // #1154: these tests never attach an image, so content is always a bare
  // string — the real implementation's array-flattening path is unexercised
  // here and covered by generate-with-image.test.ts instead.
  contentToText: (content: unknown) => content as string,
}));

// Mock llm-provider-resolver (resolveUsecase)
const mockResolveUsecase = vi.fn().mockResolvedValue({
  config: {
    providerId: 'p1', baseUrl: 'http://x/v1', apiKey: null,
    authType: 'none', verifySsl: true, name: 'X', defaultModel: 'm',
  },
  model: 'm',
});

vi.mock('../../domains/llm/services/llm-provider-resolver.js', () => ({
  resolveUsecase: (...args: unknown[]) => mockResolveUsecase(...args),
}));

// Mock openai-compatible-client (streamChat — queue + breakers wrapped inside)
vi.mock('../../domains/llm/services/openai-compatible-client.js', () => ({
  streamChat: (...args: unknown[]) => mockStreamChat(...args),
  chat: vi.fn(),
  generateEmbedding: vi.fn(),
  listModels: vi.fn(),
  checkHealth: vi.fn(),
  invalidateDispatcher: vi.fn(),
}));

vi.mock('../../core/db/postgres.js', () => ({
  query: vi.fn().mockResolvedValue({ rows: [] }),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
}));

vi.mock('../../domains/llm/services/rag-service.js', () => ({
  hybridSearch: vi.fn(),
  buildRagContext: vi.fn(),
}));

vi.mock('../../core/services/content-converter.js', () => ({
  htmlToMarkdown: vi.fn((html: string) => html),
}));

vi.mock('../../domains/llm/services/embedding-service.js', () => ({
  getEmbeddingStatus: vi.fn(),
  processDirtyPages: vi.fn(),
  reEmbedAll: vi.fn(),
  embedPage: vi.fn(),
  isProcessingUser: vi.fn().mockReturnValue(false),
  resetFailedEmbeddings: vi.fn().mockResolvedValue(0),
}));

const mockGetCachedResponse = vi.fn().mockResolvedValue(null);
const mockSetCachedResponse = vi.fn();

vi.mock('../../domains/llm/services/llm-cache.js', () => {
  class MockLlmCache {
    getCachedResponse = mockGetCachedResponse;
    setCachedResponse = mockSetCachedResponse;
    acquireLock = vi.fn().mockResolvedValue(true);
    releaseLock = vi.fn().mockResolvedValue(undefined);
    waitForCachedResponse = vi.fn().mockResolvedValue(null);
    clearAll = vi.fn();
  }
  return {
    LlmCache: MockLlmCache,
    buildLlmCacheKey: vi.fn().mockReturnValue('test-cache-key'),
    buildRagCacheKey: vi.fn(),
  };
});

vi.mock('../../core/services/audit-service.js', () => ({
  logAuditEvent: vi.fn(),
}));

// Mock _web-search-helper (fetchWebSources hits the MCP docs sidecar over HTTP)
const mockFetchWebSources = vi.fn().mockResolvedValue({ sources: [], injectionWarnings: [] });
const mockFormatWebContext = vi.fn().mockReturnValue('');

vi.mock('./_web-search-helper.js', () => ({
  fetchWebSources: (...args: unknown[]) => mockFetchWebSources(...args),
  formatWebContext: (...args: unknown[]) => mockFormatWebContext(...args),
}));

const mockEmitLlmAudit = vi.fn();
vi.mock('../../domains/llm/services/llm-audit-hook.js', async (importActual) => {
  const actual = await importActual<typeof import('../../domains/llm/services/llm-audit-hook.js')>();
  return {
    ...actual,
    emitLlmAudit: (...args: unknown[]) => mockEmitLlmAudit(...args),
  };
});

const mockSanitizeLlmInput = vi.fn((input: string) => ({ sanitized: input, warnings: [] }));
vi.mock('../../core/utils/sanitize-llm-input.js', () => ({
  sanitizeLlmInput: (...args: unknown[]) => mockSanitizeLlmInput(...args as [string]),
}));

vi.mock('../../domains/confluence/services/subpage-context.js', () => ({
  assembleSubPageContext: vi.fn(),
  getMultiPagePromptSuffix: vi.fn().mockReturnValue(''),
}));

import { llmGenerateRoutes } from './llm-generate.js';

/**
 * `documentText` is format-blind by design (#1132). By the time a request
 * reaches this route the extractor has already sniffed the bytes and decoded
 * them to prose, so the route cannot — and must not — tell a PDF from an ODT.
 *
 * Per-format coverage therefore lives where the format is still observable:
 * `extract-document.test.ts` (sniffing, mislabelled-file rejection, per-format
 * audit) and the Generate-mode component tests (accept list, copy, preview
 * card). What is worth asserting *here* is the other half of that claim — that
 * all six formats' text really does take one identical path — which the
 * parametrized case below does, rather than six copies of the same assertion.
 */
describe('POST /api/llm/generate with documentText', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);

    app.decorate('authenticate', async () => {});
    app.decorate('requireAdmin', async () => {});
    app.decorate('redis', {});
    app.decorateRequest('userId', '');
    app.addHook('onRequest', async (request) => {
      request.userId = 'test-user-123';
      request.userCan = async () => true;
    });

    await app.register(llmGenerateRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCachedResponse.mockResolvedValue(null);
    mockSanitizeLlmInput.mockImplementation((input: string) => ({ sanitized: input, warnings: [] }));
    mockFetchWebSources.mockResolvedValue({ sources: [], injectionWarnings: [] });
    mockFormatWebContext.mockReturnValue('');
    mockResolveUsecase.mockResolvedValue({
      config: {
        providerId: 'p1', baseUrl: 'http://x/v1', apiKey: null,
        authType: 'none', verifySsl: true, name: 'X', defaultModel: 'm',
      },
      model: 'm',
    });
  });

  it('should use generate_from_document system prompt when documentText is provided', async () => {
    async function* mockGenerator() {
      yield { content: '# Article\n\nGenerated content.', done: true };
    }
    mockStreamChat.mockReturnValue(mockGenerator());

    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/generate',
      payload: {
        prompt: 'Create a runbook from this document',
        model: 'llama3',
        documentText: 'Extracted document text content here',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/event-stream');
    expect(mockGetSystemPrompt).toHaveBeenCalledWith('generate_from_document');
  });

  it('should include document text in user message with proper formatting', async () => {
    async function* mockGenerator() {
      yield { content: '# Result', done: true };
    }
    mockStreamChat.mockReturnValue(mockGenerator());

    await app.inject({
      method: 'POST',
      url: '/api/llm/generate',
      payload: {
        prompt: 'Summarize this',
        model: 'llama3',
        documentText: 'Extracted document prose',
      },
    });

    // Check the messages passed to streamChat
    const callArgs = mockStreamChat.mock.calls[0];
    const messages = callArgs[2]; // userId, model, messages
    const userMessage = messages.find((m: { role: string }) => m.role === 'user');

    expect(userMessage.content).toContain('## Source Document');
    expect(userMessage.content).toContain('Extracted document prose');
    expect(userMessage.content).toContain('## Instructions');
    expect(userMessage.content).toContain('Summarize this');
  });

  it('should sanitize documentText before sending to LLM', async () => {
    async function* mockGenerator() {
      yield { content: 'Result', done: true };
    }
    mockStreamChat.mockReturnValue(mockGenerator());

    await app.inject({
      method: 'POST',
      url: '/api/llm/generate',
      payload: {
        prompt: 'Create article',
        model: 'llama3',
        documentText: 'Some document text',
      },
    });

    // sanitizeLlmInput should be called for both prompt and documentText
    expect(mockSanitizeLlmInput).toHaveBeenCalledWith('Create article');
    expect(mockSanitizeLlmInput).toHaveBeenCalledWith('Some document text');
  });

  it('should use template-specific prompt even with documentText', async () => {
    async function* mockGenerator() {
      yield { content: '# Runbook', done: true };
    }
    mockStreamChat.mockReturnValue(mockGenerator());

    await app.inject({
      method: 'POST',
      url: '/api/llm/generate',
      payload: {
        prompt: 'Create runbook',
        model: 'llama3',
        template: 'runbook',
        documentText: 'Some document text',
      },
    });

    expect(mockGetSystemPrompt).toHaveBeenCalledWith('generate_runbook');
  });

  it('should use default generate prompt when no documentText and no template', async () => {
    async function* mockGenerator() {
      yield { content: '# Article', done: true };
    }
    mockStreamChat.mockReturnValue(mockGenerator());

    await app.inject({
      method: 'POST',
      url: '/api/llm/generate',
      payload: {
        prompt: 'Write about Docker',
        model: 'llama3',
      },
    });

    expect(mockGetSystemPrompt).toHaveBeenCalledWith('generate');
  });

  it('audits the resolved provider id and model, not the request model', async () => {
    async function* mockGenerator() {
      yield { content: '# Article', done: true };
    }
    mockStreamChat.mockReturnValue(mockGenerator());
    mockResolveUsecase.mockResolvedValue({
      config: {
        providerId: 'custom-provider',
        baseUrl: 'http://custom/v1',
        apiKey: null,
        authType: 'none',
        verifySsl: true,
        name: 'Custom Provider',
        defaultModel: 'resolved-model',
      },
      model: 'resolved-model',
    });

    await app.inject({
      method: 'POST',
      url: '/api/llm/generate',
      payload: {
        prompt: 'Write about Docker',
        model: 'ignored-body-model',
      },
    });

    expect(mockEmitLlmAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'generate',
        model: 'resolved-model',
        provider: 'custom-provider',
      }),
    );
  });

  it('should log audit event when documentText contains injection patterns', async () => {
    async function* mockGenerator() {
      yield { content: 'Result', done: true };
    }
    mockStreamChat.mockReturnValue(mockGenerator());

    mockSanitizeLlmInput.mockImplementation((input: string) => {
      if (input === 'Malicious document content') {
        return { sanitized: 'Cleaned content', warnings: ['Injection detected'] };
      }
      return { sanitized: input, warnings: [] };
    });

    const { logAuditEvent } = await import('../../core/services/audit-service.js');

    await app.inject({
      method: 'POST',
      url: '/api/llm/generate',
      payload: {
        prompt: 'Create article',
        model: 'llama3',
        documentText: 'Malicious document content',
      },
    });

    expect(logAuditEvent).toHaveBeenCalledWith(
      'test-user-123',
      'PROMPT_INJECTION_DETECTED',
      'llm',
      undefined,
      expect.objectContaining({ field: 'documentText' }),
      expect.anything(),
    );
  });

  it('emits ONE aggregated PROMPT_INJECTION_DETECTED event when web sources contain injections (#835)', async () => {
    async function* mockGenerator() {
      yield { content: '# Article', done: true };
    }
    mockStreamChat.mockReturnValue(mockGenerator());
    mockFetchWebSources.mockResolvedValue({
      sources: [{ title: '[FILTERED] docs', url: 'https://evil.example.com/doc', snippet: 'neutralized' }],
      injectionWarnings: [
        { url: 'https://evil.example.com/doc', warnings: ['Detected prompt injection pattern: [SYSTEM] tag'] },
      ],
    });

    const { logAuditEvent } = await import('../../core/services/audit-service.js');

    await app.inject({
      method: 'POST',
      url: '/api/llm/generate',
      payload: { prompt: 'Write about Docker', model: 'llama3', searchWeb: true, searchQuery: 'q' },
    });

    expect(mockFetchWebSources).toHaveBeenCalledWith('q', 'test-user-123');
    expect(logAuditEvent).toHaveBeenCalledTimes(1);
    expect(logAuditEvent).toHaveBeenCalledWith(
      'test-user-123',
      'PROMPT_INJECTION_DETECTED',
      'llm',
      undefined,
      {
        warnings: ['Detected prompt injection pattern: [SYSTEM] tag'],
        route: '/llm/generate',
        field: 'webSearch',
        urls: ['https://evil.example.com/doc'],
      },
      expect.anything(), // request object
    );
  });

  it('rolls web-search detections into the per-call attestation flags (#835)', async () => {
    async function* mockGenerator() {
      yield { content: '# Article', done: true };
    }
    mockStreamChat.mockReturnValue(mockGenerator());
    mockFetchWebSources.mockResolvedValue({
      sources: [{ title: '[FILTERED] docs', url: 'https://evil.example.com/doc', snippet: 'neutralized' }],
      injectionWarnings: [
        { url: 'https://evil.example.com/doc', warnings: ['Detected prompt injection pattern: [SYSTEM] tag'] },
      ],
    });

    await app.inject({
      method: 'POST',
      url: '/api/llm/generate',
      payload: { prompt: 'Write about Docker', model: 'llama3', searchWeb: true, searchQuery: 'q' },
    });

    // llm_audit_log.prompt_injection_detected must not read FALSE while
    // audit_log carries a PROMPT_INJECTION_DETECTED row for the same request
    // — Report 5 (LLM Usage attestation) counts by the per-call flags.
    expect(mockEmitLlmAudit).toHaveBeenCalledWith(
      expect.objectContaining({ promptInjectionDetected: true, sanitized: true }),
    );
  });

  it('does not emit an audit event when web sources are clean (#835)', async () => {
    async function* mockGenerator() {
      yield { content: '# Article', done: true };
    }
    mockStreamChat.mockReturnValue(mockGenerator());
    mockFetchWebSources.mockResolvedValue({
      sources: [{ title: 'Clean', url: 'https://clean.example.com/doc', snippet: 'safe' }],
      injectionWarnings: [],
    });

    const { logAuditEvent } = await import('../../core/services/audit-service.js');

    await app.inject({
      method: 'POST',
      url: '/api/llm/generate',
      payload: { prompt: 'Write about Docker', model: 'llama3', searchWeb: true, searchQuery: 'q' },
    });

    expect(mockFetchWebSources).toHaveBeenCalledOnce();
    expect(logAuditEvent).not.toHaveBeenCalled();
    // Clean web sources must not flip the attestation flags.
    expect(mockEmitLlmAudit).toHaveBeenCalledWith(
      expect.objectContaining({ promptInjectionDetected: false, sanitized: false }),
    );
  });

  it('emits web sources with `url` and pageId 0 so they open as links, not pages (#1125)', async () => {
    async function* mockGenerator() {
      yield { content: '# Article', done: true };
    }
    mockStreamChat.mockReturnValue(mockGenerator());
    mockFetchWebSources.mockResolvedValue({
      sources: [{ title: 'Linux', url: 'https://en.wikipedia.org/wiki/Linux', snippet: 'kernel' }],
      injectionWarnings: [],
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/generate',
      payload: { prompt: 'Write about Linux', model: 'llama3', searchWeb: true, searchQuery: 'linux' },
    });

    const finalEvent = response.body
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.replace('data: ', '')) as Record<string, unknown>)
      .find((e) => e.final === true);

    expect(finalEvent).toBeDefined();
    const sources = finalEvent!.sources as Array<Record<string, unknown>>;
    expect(sources).toHaveLength(1);
    expect(sources[0].url).toBe('https://en.wikipedia.org/wiki/Linux');
    expect(sources[0].pageId).toBe(0);
  });

  it('should truncate documentText when it exceeds MAX_DOCUMENT_TEXT_FOR_LLM', async () => {
    async function* mockGenerator() {
      yield { content: '# Result', done: true };
    }
    mockStreamChat.mockReturnValue(mockGenerator());

    const longDocument = 'A'.repeat(90_000);

    await app.inject({
      method: 'POST',
      url: '/api/llm/generate',
      payload: { prompt: 'Summarize this', model: 'llama3', documentText: longDocument },
    });

    const callArgs = mockStreamChat.mock.calls[0];
    const messages = callArgs[2];
    const userMessage = messages.find((m: { role: string }) => m.role === 'user');

    expect(userMessage.content).toContain('[Document truncated');
    expect(userMessage.content.length).toBeLessThan(longDocument.length);
  });

  // One extraction per supported format, standing in for the text the extractor
  // hands back. The point is that none of them takes a different branch: same
  // system prompt, same `## Source Document` framing, same sanitizer call. A
  // format-specific branch reappearing here would fail on whichever format it
  // singled out.
  const PER_FORMAT_TEXT = [
    ['pdf', 'Page 1 of the quarterly report.'],
    ['docx', '# Heading\n\nProse converted out of a Word document.'],
    ['md', '## Notes\n\nAlready markdown when it arrived.'],
    ['txt', 'Plain text, no markup at all.'],
    ['rtf', 'Rich text with its control words stripped.'],
    ['odt', 'OpenDocument prose from the zip container.'],
  ] as const;

  it.each(PER_FORMAT_TEXT)(
    'treats %s-derived text exactly like every other format (#1132)',
    async (_format, documentText) => {
      async function* mockGenerator() {
        yield { content: '# Article', done: true };
      }
      mockStreamChat.mockReturnValue(mockGenerator());

      const response = await app.inject({
        method: 'POST',
        url: '/api/llm/generate',
        payload: { prompt: 'Turn this into a runbook', model: 'llama3', documentText },
      });

      expect(response.statusCode).toBe(200);
      expect(mockGetSystemPrompt).toHaveBeenCalledWith('generate_from_document');
      expect(mockSanitizeLlmInput).toHaveBeenCalledWith(documentText);

      const messages = mockStreamChat.mock.calls[0][2];
      const userMessage = messages.find((m: { role: string }) => m.role === 'user');
      expect(userMessage.content).toBe(
        `## Source Document\n${documentText}\n\n## Instructions\nTurn this into a runbook`,
      );
    },
  );
});
