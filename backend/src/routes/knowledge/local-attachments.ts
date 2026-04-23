/**
 * HTTP routes for local (non-Confluence) page attachments (#302 Gap 4).
 *
 *   GET  /api/local-attachments/:pageId/list          — list filenames + sizes
 *   GET  /api/local-attachments/:pageId/:filename     — serve bytes
 *   PUT  /api/local-attachments/:pageId/:filename     — create/replace
 *
 * Body format for PUT mirrors the Confluence-side route so the frontend's
 * drain helper (#302 Gap 3) can target the local backend by swapping the
 * URL prefix — same JSON body, same semantics.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  putLocalAttachment,
  getLocalAttachment,
  listLocalAttachments,
  LocalAttachmentError,
  MAX_LOCAL_ATTACHMENT_BYTES,
} from '../../core/services/local-attachment-service.js';
import { logger } from '../../core/utils/logger.js';

const PageIdParamSchema = z.object({
  pageId: z.coerce.number().int().positive(),
});

const PageIdAndFilenameParamSchema = z.object({
  pageId: z.coerce.number().int().positive(),
  filename: z.string().min(1).max(255),
});

const PutLocalAttachmentBodySchema = z.object({
  /**
   * Base64 data URI. Accepts any image/* MIME (draw.io PNGs, pasted JPEGs,
   * SVGs) plus `application/*`. Non-data-URI values are rejected.
   */
  dataUri: z.string().min(1, 'dataUri is required'),
  /**
   * Optional draw.io XML sibling — mirrors the Confluence-side route so
   * the drain helper can submit both halves in one request.
   */
  xml: z.string().max(25 * 1024 * 1024, 'XML exceeds 25 MB limit').optional(),
});

/** Parse `data:<mime>;base64,<payload>` → `{ contentType, buffer }`. */
function decodeDataUri(dataUri: string): { contentType: string; buffer: Buffer } | null {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUri);
  if (!match) return null;
  const contentType = match[1]!.trim();
  if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(contentType)) return null;
  try {
    const buffer = Buffer.from(match[2]!, 'base64');
    return { contentType, buffer };
  } catch {
    return null;
  }
}

function mapErrorToStatus(err: LocalAttachmentError): number {
  switch (err.code) {
    case 'NOT_FOUND':
    case 'PAGE_NOT_FOUND':
      return 404;
    case 'FORBIDDEN':
      return 403;
    case 'TOO_LARGE':
      return 413;
    case 'INVALID_FILENAME':
      return 400;
  }
}

export async function localAttachmentsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('onRequest', fastify.authenticate);

  // GET list
  fastify.get('/local-attachments/:pageId/list', async (request, reply) => {
    const { pageId } = PageIdParamSchema.parse(request.params);
    try {
      const rows = await listLocalAttachments(pageId, request.userId);
      return {
        attachments: rows.map((r) => ({
          filename: r.filename,
          size: r.sizeBytes,
          contentType: r.contentType,
          sha256: r.sha256,
          updatedAt: r.updatedAt.toISOString(),
          url: `/api/local-attachments/${pageId}/${encodeURIComponent(r.filename)}`,
        })),
      };
    } catch (err) {
      if (err instanceof LocalAttachmentError) {
        reply.code(mapErrorToStatus(err));
        return { error: err.code, message: err.message };
      }
      throw err;
    }
  });

  // GET one
  fastify.get('/local-attachments/:pageId/:filename', async (request, reply) => {
    const { pageId, filename } = PageIdAndFilenameParamSchema.parse(request.params);
    try {
      const { data, record } = await getLocalAttachment(pageId, filename, request.userId);
      reply
        .header('content-type', record.contentType)
        .header('cache-control', 'private, max-age=3600')
        // SVG comes with the same sandbox+attachment hardening as the
        // Confluence route to keep the attack surface identical.
        .header(
          'content-disposition',
          record.contentType.includes('svg') ? 'attachment' : 'inline',
        );
      if (record.contentType.includes('svg')) {
        reply.header('content-security-policy', 'sandbox');
      }
      // `data` is the raw attachment bytes — not HTML. Content-Type is the
      // stored MIME (png/jpeg/xml/svg); SVGs additionally carry CSP
      // `sandbox` + `content-disposition: attachment` to block inline
      // script execution. Semgrep's "writing to Response" rule can't
      // distinguish binary downloads from HTML bodies.
      // nosemgrep
      return reply.send(data);
    } catch (err) {
      if (err instanceof LocalAttachmentError) {
        reply.code(mapErrorToStatus(err));
        return { error: err.code, message: err.message };
      }
      throw err;
    }
  });

  // PUT create/replace
  //
  // `bodyLimit` MUST be set per-route: Fastify's default JSON body limit is
  // 1 MB, so without this the 25 MB Zod cap and the in-handler 413 branch
  // are unreachable — any payload between ~1 MB and 25 MB would be rejected
  // by Fastify with a generic `FST_ERR_CTP_BODY_TOO_LARGE` 413 before the
  // handler runs. Base64 inflates binary by ~33 %, plus small JSON overhead,
  // so 35 MB comfortably covers the 25 MB binary cap.
  fastify.put('/local-attachments/:pageId/:filename', { bodyLimit: 35_000_000 }, async (request, reply) => {
    const { pageId, filename } = PageIdAndFilenameParamSchema.parse(request.params);
    const body = PutLocalAttachmentBodySchema.parse(request.body);

    const decoded = decodeDataUri(body.dataUri);
    if (!decoded) {
      reply.code(400);
      return { error: 'BAD_DATA_URI', message: 'dataUri must be a base64-encoded data URI' };
    }
    if (decoded.buffer.length > MAX_LOCAL_ATTACHMENT_BYTES) {
      reply.code(413);
      return {
        error: 'TOO_LARGE',
        message: `Attachment exceeds maximum size of ${MAX_LOCAL_ATTACHMENT_BYTES / (1024 * 1024)} MB`,
      };
    }

    try {
      const record = await putLocalAttachment({
        pageId,
        filename,
        contentType: decoded.contentType,
        data: decoded.buffer,
        userId: request.userId,
      });

      // When an XML sibling is supplied, persist it under the matching
      // .drawio filename so the Confluence native-viewer parity shape
      // (#302 Gap 2) works for local pages too.
      let xmlRecord: Awaited<ReturnType<typeof putLocalAttachment>> | null = null;
      let xmlWriteFailed = false;
      let xmlWriteError: string | undefined;
      if (body.xml) {
        const xmlFilename = filename.toLowerCase().endsWith('.png')
          ? filename.slice(0, -4) + '.drawio'
          : `${filename}.drawio`;
        try {
          xmlRecord = await putLocalAttachment({
            pageId,
            filename: xmlFilename,
            contentType: 'application/xml',
            data: Buffer.from(body.xml, 'utf8'),
            userId: request.userId,
          });
        } catch (xmlErr) {
          logger.warn(
            { err: xmlErr, pageId, filename: xmlFilename },
            'local-attachments: XML sibling write failed (PNG still stored)',
          );
          // Surface the failure to the caller so the drain helper can
          // retry. Previously this was silently swallowed, breaking
          // Confluence parity without any signal to the client.
          xmlWriteFailed = true;
          xmlWriteError =
            xmlErr instanceof LocalAttachmentError
              ? xmlErr.code
              : xmlErr instanceof Error
                ? xmlErr.message
                : 'unknown error';
        }
      }

      // `success` narrows to whether the PNG write completed. When
      // `xmlWriteFailed` is true the caller knows the on-disk state
      // diverged from Confluence parity and can re-send the XML half.
      return {
        success: !xmlWriteFailed,
        filename: record.filename,
        size: record.sizeBytes,
        sha256: record.sha256,
        xmlFilename: xmlRecord?.filename,
        xmlSize: xmlRecord?.sizeBytes,
        ...(xmlWriteFailed ? { xmlWriteFailed: true, xmlWriteError } : {}),
      };
    } catch (err) {
      if (err instanceof LocalAttachmentError) {
        reply.code(mapErrorToStatus(err));
        return { error: err.code, message: err.message };
      }
      throw err;
    }
  });
}
