import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import multipart from '@fastify/multipart';

// Mock audit service
vi.mock('../../core/services/audit-service.js', () => ({
  logAuditEvent: vi.fn(),
}));

// Mock sanitize-llm-input
const mockSanitizeLlmInput = vi.fn((input: string) => ({ sanitized: input, warnings: [], wasModified: false }));
vi.mock('../../core/utils/sanitize-llm-input.js', () => ({
  sanitizeLlmInput: (...args: unknown[]) => mockSanitizeLlmInput(...args as [string]),
}));

// Mock unpdf
const mockGetDocumentProxy = vi.fn();
const mockExtractText = vi.fn();
vi.mock('unpdf', () => ({
  getDocumentProxy: (...args: unknown[]) => mockGetDocumentProxy(...args),
  extractText: (...args: unknown[]) => mockExtractText(...args),
}));

import { llmPdfRoutes } from './llm-pdf.js';

// Helper to create a simple valid PDF buffer (with %PDF- magic bytes)
function createPdfBuffer(size = 100): Buffer {
  const buf = Buffer.alloc(size);
  buf.write('%PDF-1.4', 0, 'ascii');
  return buf;
}

// Helper to create a multipart form body with a file
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

describe('POST /api/llm/extract-pdf', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);
    await app.register(multipart, {
      limits: { fileSize: 20 * 1024 * 1024, files: 1, fields: 0 },
    });

    // Decorate with mock auth and redis
    app.decorate('authenticate', async () => {});
    app.decorate('requireAdmin', async () => {});
    app.decorate('redis', {});
    app.decorateRequest('userId', '');
    app.addHook('onRequest', async (request) => {
      request.userId = 'test-user-123';
      request.userCan = async () => true;
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
    const extractedText = 'Hello World. This is extracted text from the PDF document.';

    mockGetDocumentProxy.mockResolvedValue({ _proxy: true });
    mockExtractText.mockResolvedValue({
      text: extractedText,
      totalPages: 3,
    });

    const { body, boundary } = createMultipartPayload('report.pdf', pdfContent);

    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/extract-pdf',
      payload: body,
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
    });

    expect(response.statusCode).toBe(200);
    const result = JSON.parse(response.body);
    expect(result.text).toBe(extractedText);
    expect(result.totalPages).toBe(3);
    expect(result.fileSize).toBe(pdfContent.length);
    expect(result.preview).toBe(extractedText);
  });

  it('should return 415 when file is not a PDF MIME type', async () => {
    const content = Buffer.from('not a pdf');
    const { body, boundary } = createMultipartPayload('image.png', content, 'image/png');

    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/extract-pdf',
      payload: body,
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
    });

    expect(response.statusCode).toBe(415);
    const result = JSON.parse(response.body);
    expect(result.message).toContain('PDF');
  });

  it('should return 415 when PDF magic bytes are missing', async () => {
    const content = Buffer.from('This is not actually a PDF despite the MIME type');
    const { body, boundary } = createMultipartPayload('fake.pdf', content, 'application/pdf');

    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/extract-pdf',
      payload: body,
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
    });

    expect(response.statusCode).toBe(415);
    const result = JSON.parse(response.body);
    expect(result.message).toContain('valid PDF');
  });

  it('should return 422 for encrypted/password-protected PDFs', async () => {
    const pdfContent = createPdfBuffer();
    mockGetDocumentProxy.mockRejectedValue(new Error('PasswordException: Incorrect password'));

    const { body, boundary } = createMultipartPayload('encrypted.pdf', pdfContent);

    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/extract-pdf',
      payload: body,
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
    });

    expect(response.statusCode).toBe(422);
    const result = JSON.parse(response.body);
    expect(result.message).toContain('Password-protected');
  });

  it('should return 422 when PDF has no extractable text', async () => {
    const pdfContent = createPdfBuffer();
    mockGetDocumentProxy.mockResolvedValue({ _proxy: true });
    mockExtractText.mockResolvedValue({ text: '', totalPages: 1 });

    const { body, boundary } = createMultipartPayload('scanned.pdf', pdfContent);

    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/extract-pdf',
      payload: body,
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
    });

    expect(response.statusCode).toBe(422);
    const result = JSON.parse(response.body);
    expect(result.message).toContain('no extractable text');
  });

  it('should truncate preview to 500 characters', async () => {
    const pdfContent = createPdfBuffer();
    const longText = 'A'.repeat(1000);

    mockGetDocumentProxy.mockResolvedValue({ _proxy: true });
    mockExtractText.mockResolvedValue({ text: longText, totalPages: 5 });

    const { body, boundary } = createMultipartPayload('long.pdf', pdfContent);

    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/extract-pdf',
      payload: body,
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
    });

    expect(response.statusCode).toBe(200);
    const result = JSON.parse(response.body);
    expect(result.preview.length).toBe(503); // 500 + '...'
    expect(result.preview.endsWith('...')).toBe(true);
    expect(result.text).toBe(longText);
  });

  it('should sanitize extracted text and log audit event on injection detection', async () => {
    const pdfContent = createPdfBuffer();
    const maliciousText = 'Normal text with injection attempt';

    mockGetDocumentProxy.mockResolvedValue({ _proxy: true });
    mockExtractText.mockResolvedValue({ text: maliciousText, totalPages: 1 });
    mockSanitizeLlmInput.mockReturnValue({
      sanitized: 'Normal text cleaned',
      warnings: ['Potential prompt injection detected'],
      wasModified: true,
    });

    const { body, boundary } = createMultipartPayload('malicious.pdf', pdfContent);

    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/extract-pdf',
      payload: body,
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
    });

    expect(response.statusCode).toBe(200);
    const result = JSON.parse(response.body);
    expect(result.text).toBe('Normal text cleaned');
    expect(mockSanitizeLlmInput).toHaveBeenCalledWith(maliciousText);
  });

  it('should return 400 when no file is uploaded', async () => {
    const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
    const emptyBody = Buffer.from(`--${boundary}--\r\n`);

    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/extract-pdf',
      payload: emptyBody,
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it('should return 422 when unpdf fails with generic error', async () => {
    const pdfContent = createPdfBuffer();
    mockGetDocumentProxy.mockRejectedValue(new Error('Corrupted PDF structure'));

    const { body, boundary } = createMultipartPayload('corrupt.pdf', pdfContent);

    const response = await app.inject({
      method: 'POST',
      url: '/api/llm/extract-pdf',
      payload: body,
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
    });

    expect(response.statusCode).toBe(422);
    const result = JSON.parse(response.body);
    expect(result.message).toContain('Failed to extract');
  });
});
