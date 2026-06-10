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
import { getMimeType } from '../../domains/confluence/services/attachment-handler.js';
import { logger } from '../../core/utils/logger.js';

/**
 * Upload-time MIME allowlist (#735). Local attachments exist for editor
 * images, draw.io PNG exports, and document files — never for active
 * content. `text/html`, `text/javascript`, etc. would be stored same-origin
 * under /api/local-attachments and turn into stored XSS, so anything not on
 * this list is rejected with 400. The draw.io XML sibling does not pass
 * through this check — it arrives via the separate `xml` body field and is
 * stored server-side as `application/xml`.
 */
const ALLOWED_UPLOAD_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'application/pdf',
]);

/**
 * MIME types that may render inline in the browser. Restricted to inert
 * raster images: SVG/XML/PDF/unknown are forced to download with CSP
 * `sandbox` because they can carry script (SVG, XHTML-in-XML) or embed
 * active content (PDF). Content-Type is derived server-side from the
 * filename extension (`getMimeType`, unknown → application/octet-stream) —
 * the stored, client-supplied MIME is never echoed back (#735).
 */
const INLINE_SAFE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

const PageIdParamSchema = z.object({
  pageId: z.coerce.number().int().positive(),
});

const PageIdAndFilenameParamSchema = z.object({
  pageId: z.coerce.number().int().positive(),
  filename: z.string().min(1).max(255),
});

const PutLocalAttachmentBodySchema = z.object({
  /**
   * Base64 data URI. The MIME must be on `ALLOWED_UPLOAD_MIME_TYPES`
   * (raster images, SVG, PDF) — active/text types such as `text/html` are
   * rejected with 400 (#735). Non-data-URI values are rejected.
   */
  dataUri: z.string().min(1, 'dataUri is required'),
  /**
   * Optional draw.io XML sibling — mirrors the Confluence-side route so
   * the drain helper can submit both halves in one request.
   */
  xml: z.string().max(25 * 1024 * 1024, 'XML exceeds 25 MB limit').optional(),
});

/**
 * Parse `data:<mime>;base64,<payload>` → `{ contentType, buffer }`.
 * The MIME is lowercased so the allowlist check in the PUT handler cannot
 * be bypassed with `data:TEXT/HTML;…`.
 */
function decodeDataUri(dataUri: string): { contentType: string; buffer: Buffer } | null {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUri);
  if (!match) return null;
  const contentType = match[1]!.trim().toLowerCase();
  if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(contentType)) return null;
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
      // #735: Content-Type is derived server-side from the filename
      // extension (`getMimeType`, unknown → application/octet-stream),
      // mirroring the Confluence attachment route. The stored MIME is
      // client-supplied at upload time and is never echoed back, so a
      // pre-existing `text/html` / `text/javascript` row cannot render or
      // execute same-origin. Only inert raster images render inline;
      // everything else (SVG, XML, PDF, unknown) downloads with CSP
      // `sandbox` as defence in depth.
      const mimeType = getMimeType(record.filename);
      const inline = INLINE_SAFE_MIME_TYPES.has(mimeType);
      reply
        .header('content-type', mimeType)
        .header('x-content-type-options', 'nosniff')
        .header('cache-control', 'private, max-age=3600')
        .header('content-disposition', inline ? 'inline' : 'attachment');
      if (!inline) {
        reply.header('content-security-policy', 'sandbox');
      }
      // `data` is the raw attachment bytes — not HTML. The Content-Type is
      // allowlisted above (inline = raster images only; anything else is a
      // sandboxed download), so this cannot reflect active content.
      // Semgrep's "writing to Response" rule can't distinguish binary
      // downloads from HTML bodies.
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
    // #735: reject active/text MIME types (text/html, text/javascript, …)
    // at the door — anything stored here is served same-origin under
    // /api/local-attachments and must never be script-capable.
    if (!ALLOWED_UPLOAD_MIME_TYPES.has(decoded.contentType)) {
      reply.code(400);
      return {
        error: 'UNSUPPORTED_CONTENT_TYPE',
        message: `Unsupported content type: ${decoded.contentType}. Allowed: ${[...ALLOWED_UPLOAD_MIME_TYPES].join(', ')}`,
      };
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
