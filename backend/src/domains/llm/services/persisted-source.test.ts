import { describe, it, expect, vi } from 'vitest';
import { SourceSchema } from '@compendiq/contracts';
import { toPersistedSources } from './persisted-source.js';
import { logger } from '../../../core/utils/logger.js';

describe('toPersistedSources', () => {
  it('keeps the chip fields of a KB source and drops the sort/rerank scores', () => {
    const [s] = toPersistedSources([{
      pageId: 42, pageTitle: 'Runbook', spaceKey: 'ENG', confluenceId: '123', sectionTitle: 'Rotation',
      score: 0.9, similarity: 0.71, rerankScore: 0.3,
    }]);
    expect(s).toEqual({ pageTitle: 'Runbook', spaceKey: 'ENG', pageId: 42, confluenceId: '123', sectionTitle: 'Rotation', similarity: 0.71 });
    expect(s).not.toHaveProperty('score');
    expect(s).not.toHaveProperty('rerankScore');
  });

  it('omits the pageId: 0 sentinel of external/web sources and keeps their url', () => {
    const [s] = toPersistedSources([{
      pageId: 0, pageTitle: 'Fastify docs', spaceKey: 'External', confluenceId: 'https://fastify.dev', url: 'https://fastify.dev',
      sectionTitle: 'Fastify docs', score: 1, similarity: null,
    }]);
    expect(s).toEqual({ pageTitle: 'Fastify docs', spaceKey: 'External', confluenceId: 'https://fastify.dev', url: 'https://fastify.dev', sectionTitle: 'Fastify docs', similarity: null });
    expect(s).not.toHaveProperty('pageId');
  });

  it('preserves order (order is the ranking)', () => {
    const out = toPersistedSources([{ pageId: 2, pageTitle: 'B' }, { pageId: 1, pageTitle: 'A' }]);
    expect(out.map((s) => s.pageId)).toEqual([2, 1]);
  });

  // #1115 P3 + #1361: image sources persist with their identity so a
  // reopened answer renders the same thumbnails as the live one.
  it('keeps kind and attachmentUrl on an image source, and drops score; similarity stays null', () => {
    const [s] = toPersistedSources([{
      kind: 'image', pageId: 42, pageTitle: 'Page 42', spaceKey: 'OPS',
      attachmentUrl: '/api/attachments/42/a.png', similarity: null, score: 0.0328,
    }]);
    expect(s).toEqual({
      pageTitle: 'Page 42', spaceKey: 'OPS', pageId: 42,
      kind: 'image', attachmentUrl: '/api/attachments/42/a.png', similarity: null,
    });
    expect(s).not.toHaveProperty('score');
  });

  // The `toEqual` literals above pin the shape as of today, but TypeScript
  // alone does not: the return type's field is optional and the object is
  // built through a spread, so excess-property checking never sees a
  // producer-side rename (verified empirically — `attachmentUrl` renamed to
  // `imageUrl` inside `toPersistedSources` still compiles clean against
  // `PersistedSource[]`). Parsing the producer's own output against the
  // contract `isImageSource` is written against closes that gap on either
  // side of the handoff.
  it('produces output that validates against SourceSchema as an image source', () => {
    const [s] = toPersistedSources([{
      kind: 'image', pageId: 42, pageTitle: 'Page 42', spaceKey: 'OPS',
      attachmentUrl: '/api/attachments/42/a.png', similarity: null, score: 0.0328,
    }]);
    const parsed = SourceSchema.parse(s);
    expect(parsed.kind).toBe('image');
    expect(typeof parsed.attachmentUrl).toBe('string');
  });

  it('copies neither field when kind is present without attachmentUrl', () => {
    const [s] = toPersistedSources([{ kind: 'image', pageId: 42, pageTitle: 'Page 42' }]);
    expect(s).not.toHaveProperty('kind');
    expect(s).not.toHaveProperty('attachmentUrl');
  });

  it('copies neither field when attachmentUrl is present without kind', () => {
    const [s] = toPersistedSources([{ pageId: 42, pageTitle: 'Page 42', attachmentUrl: '/api/attachments/42/a.png' }]);
    expect(s).not.toHaveProperty('kind');
    expect(s).not.toHaveProperty('attachmentUrl');
  });

  // review r1 #5 — an empty string passes `typeof s.attachmentUrl ===
  // 'string'` on both sides of the wire/frontend predicate, which would take
  // the image branch (and its image `aria-label`) with no picture in it: the
  // exact duplicate-page-chip failure this fix exists to remove, just
  // reached through an unusable URL instead of a missing one. Unreachable
  // today (`buildPageImageUrl` never returns ''), so this pins the guard
  // rather than a live bug.
  it('copies neither field when attachmentUrl is the empty string, and warns', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    const [s] = toPersistedSources([{ kind: 'image', pageId: 42, pageTitle: 'Page 42', attachmentUrl: '' }]);
    expect(s).not.toHaveProperty('kind');
    expect(s).not.toHaveProperty('attachmentUrl');
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ pageId: 42, pageTitle: 'Page 42' }),
      expect.stringContaining('image source'),
    );
    warn.mockRestore();
  });
});
