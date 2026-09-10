import { describe, it, expect, beforeEach } from 'vitest';
import { setDraftNote, getDraftNote, deleteDraftNote } from './draft-notes-store';

describe('draft-notes-store', () => {
  beforeEach(() => {
    deleteDraftNote('local-1');
    deleteDraftNote('local-2');
  });

  it('stores and retrieves draft note', () => {
    setDraftNote('local-1', {
      id: 'local-1',
      body: 'Review this section',
      createdAt: '2026-08-22T08:00:00.000Z',
      anchorData: { quote: 'Test quote' },
    });

    const retrieved = getDraftNote('local-1');
    expect(retrieved).toBeDefined();
    expect(retrieved?.body).toBe('Review this section');
    expect(retrieved?.anchorData?.quote).toBe('Test quote');
  });

  it('deletes draft note', () => {
    setDraftNote('local-2', {
      id: 'local-2',
      body: 'Temporary note',
      createdAt: '2026-08-22T08:00:00.000Z',
    });

    deleteDraftNote('local-2');
    expect(getDraftNote('local-2')).toBeUndefined();
  });
});
