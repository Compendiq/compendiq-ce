import { describe, it, expect } from 'vitest';
import {
  SUPPORTED_IMAGE_FORMATS,
  ImageHandleSchema,
  PrepareImageResponseSchema,
  GenerateRequestSchema,
  ImproveRequestSchema,
  TITLE_SOURCES,
  SourceSchema,
  StoredChatMessageSchema,
  ConversationSummarySchema,
  ConversationDetailSchema,
  ConversationListQuerySchema,
  ConversationListResponseSchema,
  UpdateConversationSchema,
  ConversationIdParamSchema,
} from './llm.js';

const VALID_HANDLE = 'a'.repeat(64);

describe('SUPPORTED_IMAGE_FORMATS', () => {
  it('excludes svg so the sniffing table and UI accept list cannot drift', () => {
    expect(SUPPORTED_IMAGE_FORMATS).not.toContain('svg');
  });

  it('is exactly the four raster formats', () => {
    expect([...SUPPORTED_IMAGE_FORMATS]).toEqual(['png', 'jpeg', 'webp', 'gif']);
  });
});

describe('ImageHandleSchema', () => {
  it('accepts 64 lowercase hex chars', () => {
    expect(() => ImageHandleSchema.parse(VALID_HANDLE)).not.toThrow();
  });

  it('rejects a wrong-length hex string', () => {
    expect(() => ImageHandleSchema.parse('a'.repeat(63))).toThrow();
  });

  it('rejects uppercase hex', () => {
    expect(() => ImageHandleSchema.parse('A'.repeat(64))).toThrow();
  });

  // The handle is interpolated into `llm:img:<userId>:<sha256>`. These are the
  // key-injection cases, not stylistic ones.
  it.each([':', '*', '/', '\n', ' '])('rejects a handle containing %j', (ch) => {
    expect(() => ImageHandleSchema.parse('a'.repeat(63) + ch)).toThrow();
  });
});

describe('PrepareImageResponseSchema', () => {
  it('accepts a well-formed response', () => {
    expect(() => PrepareImageResponseSchema.parse({
      format: 'png', handle: VALID_HANDLE, width: 800, height: 600, fileSize: 1234,
    })).not.toThrow();
  });

  it('rejects svg as a format', () => {
    expect(() => PrepareImageResponseSchema.parse({
      format: 'svg', handle: VALID_HANDLE, width: 8, height: 8, fileSize: 1,
    })).toThrow();
  });

  it('rejects zero or negative dimensions', () => {
    expect(() => PrepareImageResponseSchema.parse({
      format: 'png', handle: VALID_HANDLE, width: 0, height: 600, fileSize: 1,
    })).toThrow();
  });
});

describe('imageHandle on request schemas', () => {
  it('is optional on GenerateRequestSchema', () => {
    expect(() => GenerateRequestSchema.parse({ prompt: 'hi' })).not.toThrow();
  });

  it('is accepted on GenerateRequestSchema', () => {
    const parsed = GenerateRequestSchema.parse({ prompt: 'hi', imageHandle: VALID_HANDLE });
    expect(parsed.imageHandle).toBe(VALID_HANDLE);
  });

  it('rejects a malformed handle on ImproveRequestSchema', () => {
    expect(() => ImproveRequestSchema.parse({
      content: 'x', type: 'clarity', imageHandle: 'nope',
    })).toThrow();
  });
});

describe('conversation schemas (#1361)', () => {
  const KB_SOURCE = {
    pageTitle: 'Runbook',
    spaceKey: 'ENG',
    pageId: 42,
    confluenceId: '123456789012',
    sectionTitle: 'Rotation',
    similarity: 0.71,
  };
  // The live wire shape for an external doc: no pageId at all (the route's
  // `pageId: 0` sentinel is OMITTED by the persister, Task 7).
  const EXTERNAL_SOURCE = {
    pageTitle: 'Fastify docs',
    spaceKey: 'External',
    confluenceId: 'https://fastify.dev/docs',
    url: 'https://fastify.dev/docs',
    sectionTitle: 'Fastify docs',
    similarity: null,
  };

  it('TITLE_SOURCES is exactly question | generated | user', () => {
    expect([...TITLE_SOURCES]).toEqual(['question', 'generated', 'user']);
  });

  it('SourceSchema round-trips a KB source and an external-doc source', () => {
    expect(SourceSchema.parse(KB_SOURCE)).toEqual(KB_SOURCE);
    expect(SourceSchema.parse(EXTERNAL_SOURCE)).toEqual(EXTERNAL_SOURCE);
    expect(SourceSchema.parse({ ...KB_SOURCE, unavailable: true }).unavailable).toBe(true);
  });

  it('SourceSchema rejects the wire sentinel pageId: 0 — the persister must omit it', () => {
    expect(SourceSchema.safeParse({ ...EXTERNAL_SOURCE, pageId: 0 }).success).toBe(false);
  });

  // #1115 P3 + #1361: an image source persists with its identity so a
  // reopened answer renders the same thumbnails as the live one.
  const IMAGE_SOURCE = {
    pageTitle: 'Turbine diagram',
    spaceKey: 'OPS',
    pageId: 42,
    kind: 'image' as const,
    attachmentUrl: '/api/attachments/42/turbine.png',
    similarity: null,
  };

  it('SourceSchema parses an image source and RETAINS kind and attachmentUrl (Zod strips undeclared keys)', () => {
    const parsed = SourceSchema.parse(IMAGE_SOURCE);
    expect(parsed.kind).toBe('image');
    expect(parsed.attachmentUrl).toBe('/api/attachments/42/turbine.png');
    expect(parsed).toEqual(IMAGE_SOURCE);
  });

  it('SourceSchema rejects a kind other than "image"', () => {
    expect(SourceSchema.safeParse({ ...KB_SOURCE, kind: 'page' }).success).toBe(false);
  });

  it('SourceSchema still parses a legacy page source with no kind at all', () => {
    expect(SourceSchema.parse(KB_SOURCE).kind).toBeUndefined();
  });

  it('StoredChatMessageSchema accepts refused turns and turns carrying sources', () => {
    expect(() => StoredChatMessageSchema.parse({ role: 'assistant', content: 'no', refused: true })).not.toThrow();
    expect(() => StoredChatMessageSchema.parse({ role: 'assistant', content: 'yes', sources: [KB_SOURCE, EXTERNAL_SOURCE] })).not.toThrow();
    expect(StoredChatMessageSchema.safeParse({ role: 'tool', content: 'x' }).success).toBe(false);
  });

  it('ConversationListQuerySchema defaults limit to 50, coerces, and caps at 100', () => {
    expect(ConversationListQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(ConversationListQuerySchema.parse({ limit: '25', cursor: 'abc' })).toEqual({ limit: 25, cursor: 'abc' });
    expect(ConversationListQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(ConversationListQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
  });

  it('UpdateConversationSchema trims, and rejects blank or over-long titles', () => {
    expect(UpdateConversationSchema.parse({ title: '  PAT rotation  ' })).toEqual({ title: 'PAT rotation' });
    expect(UpdateConversationSchema.safeParse({ title: '   ' }).success).toBe(false);
    expect(UpdateConversationSchema.safeParse({ title: 'x'.repeat(201) }).success).toBe(false);
  });

  it('ConversationIdParamSchema requires a uuid', () => {
    expect(ConversationIdParamSchema.safeParse({ id: 'conv-1' }).success).toBe(false);
    expect(ConversationIdParamSchema.safeParse({ id: '5f0e8f9a-1b2c-4d3e-8f4a-5b6c7d8e9f0a' }).success).toBe(true);
  });

  it('summary / detail / list response round-trip the wire shape', () => {
    const summary = {
      id: '5f0e8f9a-1b2c-4d3e-8f4a-5b6c7d8e9f0a',
      title: 'PAT rotation',
      titleSource: 'question',
      model: 'qwen3:8b',
      pageId: 42,
      pageTitle: 'Runbook',
      createdAt: '2026-08-17T10:00:00.000Z',
      updatedAt: '2026-08-17T11:00:00.000Z',
    };
    expect(ConversationSummarySchema.parse(summary)).toEqual(summary);
    expect(ConversationSummarySchema.parse({ ...summary, pageId: null, pageTitle: null }).pageId).toBeNull();
    const detail = {
      ...summary,
      messages: [
        { role: 'user', content: 'how do we rotate the PAT?' },
        { role: 'assistant', content: 'Under Settings → Confluence.', sources: [KB_SOURCE] },
        { role: 'assistant', content: 'I am not answering.', refused: true },
      ],
      historyTruncated: false,
    };
    expect(ConversationDetailSchema.parse(detail)).toEqual(detail);
    expect(ConversationDetailSchema.safeParse({ ...detail, historyTruncated: undefined }).success).toBe(false);
    expect(ConversationListResponseSchema.parse({ items: [summary], nextCursor: null }).nextCursor).toBeNull();
  });
});
