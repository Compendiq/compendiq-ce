import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { PrepareImageResponseSchema } from '@compendiq/contracts';
import { logAuditEvent } from '../../core/services/audit-service.js';
import { logger } from '../../core/utils/logger.js';
import { getRateLimits } from '../../core/services/rate-limit-service.js';
import {
  validateImage,
  ImageValidationError,
  MAX_IMAGE_BYTES,
} from '../../core/services/image-validator.js';
import {
  stageImage,
  ImageStagingUnavailableError,
} from '../../core/services/image-staging.js';

const PREPARE_IMAGE_PATH = '/llm/prepare-image';

/** Derived from the constant so the message cannot drift from the limit. */
const TOO_LARGE_MESSAGE =
  `Image exceeds the ${Math.round(MAX_IMAGE_BYTES / (1024 * 1024))} MB limit`;

/**
 * Stages an uploaded image for use as LLM source material (#1154).
 *
 * Structured exactly like extract-document.ts: this handler owns only the HTTP
 * concerns — upload limits, status mapping, audit, rate limiting — while the
 * byte rules live in core/services/image-validator.ts. Unlike the document
 * path there is no text to sanitise: prompt injection rendered as pixels
 * bypasses sanitizeLlmInput entirely, which is a documented accepted risk in
 * the design of record, not something this route can mitigate.
 */
export async function prepareImageRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  const handler = async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.userId;

    const data = await request.file({
      limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 0 },
    });
    if (!data) throw fastify.httpErrors.badRequest('No file uploaded');

    let buffer: Buffer;
    try {
      buffer = await data.toBuffer();
    } catch {
      throw fastify.httpErrors.payloadTooLarge(TOO_LARGE_MESSAGE);
    }
    if (data.file.truncated) {
      throw fastify.httpErrors.payloadTooLarge(TOO_LARGE_MESSAGE);
    }

    // The validator decides the format from the bytes; `data.mimetype` is
    // client-supplied and deliberately never consulted.
    let validated;
    try {
      validated = validateImage(buffer, data.filename);
    } catch (err) {
      if (err instanceof ImageValidationError) {
        if (err.kind === 'mediaType') {
          throw fastify.httpErrors.unsupportedMediaType(err.message);
        }
        logger.warn({ filename: data.filename, reason: err.message }, 'Image rejected');
        throw fastify.httpErrors.unprocessableEntity(err.message);
      }
      logger.error({ err }, 'Image validation failed');
      throw fastify.httpErrors.unprocessableEntity('Failed to validate image');
    }

    let handle: string;
    try {
      handle = await stageImage(userId, buffer, validated.format);
    } catch (err) {
      if (err instanceof ImageStagingUnavailableError) {
        throw fastify.httpErrors.serviceUnavailable(err.message);
      }
      throw err;
    }

    await logAuditEvent(userId, 'IMAGE_PREPARED', 'llm', undefined, {
      filename: data.filename,
      format: validated.format,
      width: validated.width,
      height: validated.height,
      fileSize: buffer.length,
    }, request);

    return reply.send(PrepareImageResponseSchema.parse({
      handle,
      format: validated.format,
      width: validated.width,
      height: validated.height,
      fileSize: buffer.length,
    }));
  };

  fastify.post(PREPARE_IMAGE_PATH, {
    config: {
      rateLimit: {
        max: async () => (await getRateLimits()).llmEmbedding.max,
        timeWindow: '1 minute',
      },
    },
  }, handler);
}
