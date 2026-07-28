import { describe, it, expect } from 'vitest';
import { bulkWireId } from './use-bulk-page-actions';

/**
 * The bulk routes resolve ids in 'mixed' mode: they match on
 * `pages.id OR pages.confluence_id`, then map each found row back to
 * `confluence_id` unless it is standalone. `GET /pages` hands the frontend the
 * PK as `id` for *every* row, so posting that verbatim acted on synced pages
 * but had the server report each one as not-found in `failed`/`errors`.
 */
describe('bulkWireId', () => {
  it('addresses a synced page by its confluence id, not its PK', () => {
    expect(
      bulkWireId({ id: '42', confluenceId: 'page-1', source: 'confluence' }),
    ).toBe('page-1');
  });

  it('addresses a standalone page by its PK', () => {
    expect(bulkWireId({ id: '42', confluenceId: null, source: 'standalone' })).toBe('42');
  });

  it('keeps the PK for a standalone page even if it carries a confluence id', () => {
    // Mirrors the server's own branch, which checks source before falling back
    // to confluence_id — a plain `confluenceId ?? id` would diverge here.
    expect(
      bulkWireId({ id: '42', confluenceId: 'stale-import', source: 'standalone' }),
    ).toBe('42');
  });

  it('falls back to the PK when a non-standalone row has no confluence id', () => {
    expect(bulkWireId({ id: '42', confluenceId: null, source: 'confluence' })).toBe('42');
  });

  it('falls back to the PK when source and confluence id are absent', () => {
    expect(bulkWireId({ id: '42' })).toBe('42');
  });
});
