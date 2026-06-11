import { describe, it, expect } from 'vitest';
import { TrashItemSchema, TrashListResponseSchema } from './pages.js';

// Mirrors the exact wire shape of GET /api/pages/trash (backend serializes
// dates to ISO strings and stringifies the integer page id).
const validTrashItem = {
  id: '42',
  title: 'Trashed note',
  source: 'standalone',
  visibility: 'private',
  deletedAt: '2026-06-01T12:00:00.000Z',
  createdAt: '2026-05-20T08:30:00.000Z',
  deletedBy: 'trash_owner_a',
  autoPurgeAt: '2026-07-01T12:00:00.000Z',
} as const;

describe('TrashItemSchema', () => {
  it('round-trips a valid wire item unchanged', () => {
    const parsed = TrashItemSchema.parse(validTrashItem);
    expect(parsed).toEqual(validTrashItem);
  });

  it('rejects an unknown source', () => {
    expect(() => TrashItemSchema.parse({ ...validTrashItem, source: 'wiki' })).toThrow();
  });

  it('rejects an unknown visibility', () => {
    expect(() => TrashItemSchema.parse({ ...validTrashItem, visibility: 'public' })).toThrow();
  });

  it('rejects a numeric id — the route stringifies the integer PK', () => {
    expect(() => TrashItemSchema.parse({ ...validTrashItem, id: 42 })).toThrow();
  });

  it.each(['deletedAt', 'createdAt', 'deletedBy', 'autoPurgeAt'] as const)(
    'rejects a missing %s — the Trash UI renders every field',
    (field) => {
      const { [field]: _omitted, ...rest } = validTrashItem;
      expect(() => TrashItemSchema.parse(rest)).toThrow();
    },
  );
});

describe('TrashListResponseSchema', () => {
  it('round-trips items + total unchanged', () => {
    const payload = { items: [validTrashItem], total: 1 };
    expect(TrashListResponseSchema.parse(payload)).toEqual(payload);
  });

  it('accepts an empty trash', () => {
    const parsed = TrashListResponseSchema.parse({ items: [], total: 0 });
    expect(parsed.items).toEqual([]);
    expect(parsed.total).toBe(0);
  });

  it('rejects a negative total', () => {
    expect(() => TrashListResponseSchema.parse({ items: [], total: -1 })).toThrow();
  });
});
