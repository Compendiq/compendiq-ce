import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import multipart from '@fastify/multipart';

// --- Mock: audit-service ---
vi.mock('../../core/services/audit-service.js', () => ({
  logAuditEvent: vi.fn(),
}));

// --- Mock: logger ---
vi.mock('../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// --- Mock: sanitize-llm-input ---
const mockSanitizeLlmInput = vi.fn((input: string) => ({
  sanitized: input,
  warnings: [],
  wasModified: false,
}));
vi.mock('../../core/utils/sanitize-llm-input.js', () => ({
  sanitizeLlmInput: (...args: unknown[]) => mockSanitizeLlmInput(...args as [string]),
}));

// --- Mock: unpdf ---
const mockGetDocumentProxy = vi.fn();
const mockExtractText = vi.fn();
vi.mock('unpdf', () => ({
  getDocumentProxy: (...args: unknown[]) => mockGetDocumentProxy(...args),
  extractText: (...args: unknown[]) => mockExtractText(...args),
}));

import { llmPdfRoutes } from './llm-pdf.js';

/** Create a buffer with valid PDF magic bytes */
function createPdfBuffer(size = 100): Buffer {
  const buf = Buffer.alloc(size);
  buf.write('%PDF-1.4', 0, 'ascii');
  return buf;
}

/** Create a multipart form body with a file */
function createMultipartPayload(
  filename: string,
  content: Buffer,
  contentType = 'application/pdf',
): { body: Buffer; boundary: string } {
  const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
  const parts: Buffer[] = [];
  parts.push(Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: ${contentType}\r\n\r\n`,
  ));
  parts.push(content);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), boundary };
}

// =============================================================================
// Test Suite 1: Auth required
// =============================================================================

describe('llm-pdf routes - auth required', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);
    await app.register(multipart, {
      limits: { fileSize: 20 * 1024 * 1024, files: 1, fields: 0 },
    });

    app.decorate('authenticate', async () => {
      throw app.httpErrors.unauthorized('Missing or invalid token');
    });
    app.decorate('requireAdmin', async () => {});
    app.decorate('redis', {});

    await app.register(llmPdfRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('should return 401 for POST /api/llm/extract-pdf without auth', async () => {
    const pdfContent = createPdfBuffer();
    const { body, boundary } = createMultipartPayload('doc.pdf', pdfContent);

    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/extract-pdf',
      payload: body,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    });

    expect(response.statusCode).toBe(401);
  });
});

// =============================================================================
// Test Suite 2: PDF extraction happy path and validation
// =============================================================================

describe('POST /api/llm/extract-pdf - processing', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);
    await app.register(multipart, {
      limits: { fileSize: 20 * 1024 * 1024, files: 1, fields: 0 },
    });

    app.decorate('authenticate', async () => {});
    app.decorate('requireAdmin', async () => {});
    app.decorate('redis', {});
    app.decorateRequest('userId', '');
    app.addHook('onRequest', async (request) => {
      request.userId = 'test-user-123';
    });

    await app.register(llmPdfRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockSanitizeLlmInput.mockImplementation((input: string) => ({
      sanitized: input,
      warnings: [],
      wasModified: false,
    }));
  });

  it('should extract text from a valid PDF and return metadata', async () => {
    const pdfContent = createPdfBuffer();
    const extractedText = 'This is the extracted PDF content.';

    mockGetDocumentProxy.mockResolvedValue({ _proxy: true });
    mockExtractText.mockResolvedValue({ text: extractedText, totalPages: 2 });

    const { body, boundary } = createMultipartPayload('report.pdf', pdfContent);

    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/extract-pdf',
      payload: body,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    });

    expect(response.statusCode).toBe(200);
    const result = response.json();
    expect(result.text).toBe(extractedText);
    expect(result.totalPages).toBe(2);
    expect(result.fileSize).toBe(pdfContent.length);
    expect(result.preview).toBe(extractedText);
  });

  it('should return 415 for non-PDF MIME type', async () => {
    const content = Buffer.from('not a pdf');
    const { body, boundary } = createMultipartPayload('image.png', content, 'image/png');

    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/extract-pdf',
      payload: body,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    });

    expect(response.statusCode).toBe(415);
  });

  it('should return 415 when PDF magic bytes are missing', async () => {
    const content = Buffer.from('Not actually a PDF file content');
    const { body, boundary } = createMultipartPayload('fake.pdf', content, 'application/pdf');

    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/extract-pdf',
      payload: body,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    });

    expect(response.statusCode).toBe(415);
    const result = response.json();
    expect(result.message).toContain('valid PDF');
  });

  it('should return 422 for password-protected PDFs', async () => {
    const pdfContent = createPdfBuffer();
    mockGetDocumentProxy.mockRejectedValue(new Error('PasswordException: password required'));

    const { body, boundary } = createMultipartPayload('locked.pdf', pdfContent);

    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/extract-pdf',
      payload: body,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    });

    expect(response.statusCode).toBe(422);
    const result = response.json();
    expect(result.message).toContain('Password-protected');
  });

  it('should return 400 when no file is uploaded', async () => {
    const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
    const emptyBody = Buffer.from(`--${boundary}--\r\n`);

    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/extract-pdf',
      payload: emptyBody,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    });

    expect(response.statusCode).toBe(400);
  });
});
