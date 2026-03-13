import { FastifyInstance } from 'fastify';
import { getDocumentProxy, extractText } from 'unpdf';
import { logAuditEvent } from '../../core/services/audit-service.js';
import { logger } from '../../core/utils/logger.js';
import { sanitizeLlmInput } from '../../core/utils/sanitize-llm-input.js';

/** PDF magic bytes: %PDF- */
const PDF_MAGIC = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]);

/** Maximum file size: 20 MB */
const MAX_FILE_SIZE = 20 * 1024 * 1024;

/** Preview excerpt length */
const PREVIEW_LENGTH = 500;

export async function llmPdfRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // POST /api/llm/extract-pdf — extract text from uploaded PDF
  fastify.post('/llm/extract-pdf', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const userId = request.userId;

    const data = await request.file({
      limits: { fileSize: MAX_FILE_SIZE, files: 1, fields: 0 },
    });

    if (!data) {
      throw fastify.httpErrors.badRequest('No file uploaded');
    }

    // Accumulate to buffer (ephemeral — discarded after extraction)
    let buffer: Buffer;
    try {
      buffer = await data.toBuffer();
    } catch {
      throw fastify.httpErrors.payloadTooLarge('File exceeds 20 MB limit');
    }

    // Check if the file was truncated (size limit reached)
    if (data.file.truncated) {
      throw fastify.httpErrors.payloadTooLarge('File exceeds 20 MB limit');
    }

    // Validate MIME type
    const mimeType = data.mimetype;
    if (mimeType !== 'application/pdf') {
      throw fastify.httpErrors.unsupportedMediaType('Only PDF files are accepted');
    }

    // Validate PDF magic bytes (don't trust client Content-Type alone)
    if (buffer.length < 5 || !buffer.subarray(0, 5).equals(PDF_MAGIC)) {
      throw fastify.httpErrors.unsupportedMediaType('File is not a valid PDF');
    }

    // Extract text using unpdf
    let text: string;
    let totalPages: number;
    try {
      const pdf = await getDocumentProxy(new Uint8Array(buffer));
      const result = await extractText(pdf, { mergePages: true });
      text = result.text as string;
      totalPages = result.totalPages;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Encrypted/password-protected PDFs produce a specific error
      if (message.includes('password') || message.includes('encrypted') || message.includes('PasswordException')) {
        throw fastify.httpErrors.unprocessableEntity('Password-protected PDFs are not supported');
      }
      logger.error({ err }, 'PDF extraction failed');
      throw fastify.httpErrors.unprocessableEntity('Failed to extract text from PDF');
    }

    if (!text || text.trim().length === 0) {
      throw fastify.httpErrors.unprocessableEntity('PDF contains no extractable text (may be scanned/image-based)');
    }

    // Sanitize extracted text
    const { sanitized, warnings } = sanitizeLlmInput(text);
    if (warnings.length > 0) {
      await logAuditEvent(userId, 'PROMPT_INJECTION_DETECTED', 'llm', undefined, {
        warnings,
        route: '/llm/extract-pdf',
        filename: data.filename,
      }, request);
    }

    const preview = sanitized.slice(0, PREVIEW_LENGTH) + (sanitized.length > PREVIEW_LENGTH ? '...' : '');

    await logAuditEvent(userId, 'PDF_EXTRACTED', 'llm', undefined, {
      filename: data.filename,
      fileSize: buffer.length,
      totalPages,
      textLength: sanitized.length,
    }, request);

    return reply.send({
      text: sanitized,
      totalPages,
      fileSize: buffer.length,
      preview,
    });
  });
}
