import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getSyncOverview } from './sync-overview-service.js';

const mockQuery = vi.fn();
const mockAttachmentExists = vi.fn();
const mockGetSyncStatus = vi.fn();

vi.mock('../../../core/db/postgres.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

vi.mock('./attachment-handler.js', async () => {
  const actual = await vi.importActual<typeof import('./attachment-handler.js')>('./attachment-handler.js');
  return {
    ...actual,
    attachmentExists: (...args: unknown[]) => mockAttachmentExists(...args),
  };
});

vi.mock('./sync-service.js', () => ({
  getSyncStatus: (...args: unknown[]) => mockGetSyncStatus(...args),
}));

vi.mock('../../../core/services/rbac-service.js', () => ({
  getUserAccessibleSpaces: vi.fn().mockResolvedValue(['DEV']),
}));

describe('getSyncOverview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSyncStatus.mockReturnValue({ userId: 'user-1', status: 'idle' });
  });

  it('summarizes image and draw.io cache status per selected space', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          space_key: 'OPS',
          space_name: 'Operations',
          space_last_synced: new Date('2026-03-11T09:00:00.000Z'),
          page_id: 'page-1',
          page_title: 'Runbook',
          body_storage: `
            <ac:image><ri:attachment ri:filename="diagram.png" /></ac:image>
            <ac:structured-macro ac:name="drawio"><ac:parameter ac:name="diagramName">topology</ac:parameter></ac:structured-macro>
          `,
        },
        {
          space_key: 'OPS',
          space_name: 'Operations',
          space_last_synced: new Date('2026-03-11T09:00:00.000Z'),
          page_id: 'page-2',
          page_title: 'Overview',
          body_storage: '<p>No binary assets</p>',
        },
      ],
    });

    mockAttachmentExists.mockImplementation(async (_userId: string, pageId: string, filename: string) => {
      return pageId === 'page-1' && filename === 'topology.png';
    });

    const overview = await getSyncOverview('user-1');

    expect(overview.sync.status).toBe('idle');
    expect(overview.totals.selectedSpaces).toBe(1);
    expect(overview.totals.totalPages).toBe(2);
    expect(overview.totals.pagesWithAssets).toBe(1);
    expect(overview.totals.pagesWithIssues).toBe(1);
    expect(overview.totals.healthyPages).toBe(1);
    expect(overview.totals.images).toEqual({ expected: 1, cached: 0, missing: 1 });
    expect(overview.totals.drawio).toEqual({ expected: 1, cached: 1, missing: 0 });
    expect(overview.spaces[0]).toMatchObject({
      spaceKey: 'OPS',
      status: 'degraded',
      pageCount: 2,
      pagesWithAssets: 1,
      pagesWithIssues: 1,
    });
    expect(overview.issues).toEqual([{
      pageId: 'page-1',
      pageTitle: 'Runbook',
      spaceKey: 'OPS',
      missingImages: 1,
      missingDrawio: 0,
      missingFiles: ['diagram.png'],
    }]);
  });

  it('marks a selected space as not synced when it has no cached metadata yet', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        space_key: 'ENG',
        space_name: null,
        space_last_synced: null,
        page_id: null,
        page_title: null,
        body_storage: null,
      }],
    });

    const overview = await getSyncOverview('user-2');

    expect(overview.totals.selectedSpaces).toBe(1);
    expect(overview.totals.totalPages).toBe(0);
    expect(overview.spaces).toEqual([{
      spaceKey: 'ENG',
      spaceName: 'ENG',
      status: 'not_synced',
      lastSynced: null,
      pageCount: 0,
      pagesWithAssets: 0,
      pagesWithIssues: 0,
      images: { expected: 0, cached: 0, missing: 0 },
      drawio: { expected: 0, cached: 0, missing: 0 },
    }]);
    expect(overview.issues).toEqual([]);
  });

  it('shows a space as syncing when background sync is currently on that space', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        space_key: 'ENG',
        space_name: 'Engineering',
        space_last_synced: new Date('2026-03-11T09:00:00.000Z'),
        page_id: 'page-7',
        page_title: 'Architecture',
        body_storage: '<p>Text only</p>',
      }],
    });
    mockGetSyncStatus.mockReturnValue({
      userId: 'user-3',
      status: 'syncing',
      progress: { current: 4, total: 10, space: 'ENG' },
    });

    const overview = await getSyncOverview('user-3');

    expect(overview.sync.status).toBe('syncing');
    expect(overview.spaces[0]?.status).toBe('syncing');
  });
});
