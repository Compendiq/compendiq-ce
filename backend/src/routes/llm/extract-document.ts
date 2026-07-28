import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ExtractDocumentResponseSchema } from '@compendiq/contracts';
import { logAuditEvent } from '../../core/services/audit-service.js';
import { logger } from '../../core/utils/logger.js';
import { sanitizeLlmInput } from '../../core/utils/sanitize-llm-input.js';
import { getRateLimits } from '../../core/services/rate-limit-service.js';
import {
  buildPreview,
  extractDocumentText,
  DocumentExtractionError,
} from '../../core/services/document-extractor.js';

/** Maximum file size: 20 MB */
const MAX_FILE_SIZE = 20 * 1024 * 1024;

/** Canonical path (#1131). */
const EXTRACT_DOCUMENT_PATH = '/llm/extract-document';

/**
 * @deprecated PDF-only alias kept alive only so the shipped `useExtractPdf`
 * hook keeps working while the UI half of #1131 is still in flight. It shares
 * the handler below, so it accepts every format too. The follow-up UI PR points
 * the hook at {@link EXTRACT_DOCUMENT_PATH} and deletes this registration.
 */
const EXTRACT_PDF_LEGACY_PATH = '/llm/extract-pdf';

/**
 * Extracts text from an uploaded document for use as LLM reference material.
 *
 * The per-format rules — magic-byte sniffing, zip-bomb bounds, the extraction
 * itself — live in `core/services/document-extractor.ts` so AI-Improve and
 * AI-Generate share one implementation (#1131, #1132). This handler owns only
 * the HTTP concerns: upload limits, status mapping, sanitisation and audit.
 */
export async function extractDocumentRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  const handler = async (request: FastifyRequest, reply: FastifyReply) => {
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

    // The extractor decides the format from the bytes; `data.mimetype` is
    // client-supplied and is deliberately never consulted.
    let extracted;
    try {
      extracted = await extractDocumentText(buffer, data.filename);
    } catch (err) {
      if (err instanceof DocumentExtractionError) {
        if (err.kind === 'mediaType') {
          throw fastify.httpErrors.unsupportedMediaType(err.message);
        }
        logger.warn(
          { filename: data.filename, reason: err.message },
          'Document extraction rejected',
        );
        throw fastify.httpErrors.unprocessableEntity(err.message);
      }
      logger.error({ err }, 'Document extraction failed');
      throw fastify.httpErrors.unprocessableEntity('Failed to extract text from document');
    }

    if (extracted.text.trim().length === 0) {
      throw fastify.httpErrors.unprocessableEntity(
        extracted.format === 'pdf'
          ? 'PDF contains no extractable text (may be scanned/image-based)'
          : `${extracted.format.toUpperCase()} contains no extractable text`,
      );
    }

    // Sanitize extracted text — every format, not just PDF: a prompt-injection
    // payload is as easy to hide in a .docx or an .odt as in a PDF.
    const { sanitized, warnings } = sanitizeLlmInput(extracted.text);
    if (warnings.length > 0) {
      await logAuditEvent(userId, 'PROMPT_INJECTION_DETECTED', 'llm', undefined, {
        warnings,
        route: EXTRACT_DOCUMENT_PATH,
        format: extracted.format,
        filename: data.filename,
      }, request);
    }

    await logAuditEvent(userId, 'DOCUMENT_EXTRACTED', 'llm', undefined, {
      filename: data.filename,
      fileSize: buffer.length,
      format: extracted.format,
      totalPages: extracted.totalPages,
      textLength: sanitized.length,
    }, request);

    return reply.send(ExtractDocumentResponseSchema.parse({
      format: extracted.format,
      text: sanitized,
      fileSize: buffer.length,
      preview: buildPreview(sanitized),
      totalPages: extracted.totalPages,
    }));
  };

  const routeOptions = {
    config: {
      rateLimit: {
        max: async () => (await getRateLimits()).llmEmbedding.max,
        timeWindow: '1 minute',
      },
    },
  };

  fastify.post(EXTRACT_DOCUMENT_PATH, routeOptions, handler);
  fastify.post(EXTRACT_PDF_LEGACY_PATH, routeOptions, handler);
}
