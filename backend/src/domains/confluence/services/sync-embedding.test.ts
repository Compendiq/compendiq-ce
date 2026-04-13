import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  processDirtyPages: vi.fn().mockResolvedValue({ processed: 3, errors: 0 }),
  getSpaces: vi.fn().mockResolvedValue({ results: [] }),
  getAllPagesInSpace: vi.fn().mockResolvedValue([]),
  getModifiedPages: vi.fn().mockResolvedValue([]),
  getPage: vi.fn().mockResolvedValue(undefined),
  getPageAttachments: vi.fn().mockResolvedValue({ results: [] }),
  getMissingAttachments: vi.fn().mockResolvedValue([]),
  query: vi.fn(),
}));

vi.mock('../../llm/services/embedding-service.js', () => ({
  processDirtyPages: mocks.processDirtyPages,
}));

vi.mock('./confluence-client.js', () => ({
  ConfluenceClient: class MockConfluenceClient {
    getSpaces = mocks.getSpaces;
    getAllSpaces = vi.fn().mockResolvedValue([]);
    getAllPagesInSpace = mocks.getAllPagesInSpace;
    getModifiedPages = mocks.getModifiedPages;
    getPage = mocks.getPage;
    getPageAttachments = mocks.getPageAttachments;
  },
}));

vi.mock('../../../core/services/content-converter.js', () => ({
  confluenceToHtml: vi.fn().mockReturnValue('<p>html</p>'),
  htmlToText: vi.fn().mockReturnValue('plain text'),
}));

vi.mock('./attachment-handler.js', () => ({
  syncDrawioAttachments: vi.fn().mockResolvedValue(undefined),
  syncImageAttachments: vi.fn().mockResolvedValue(undefined),
  cleanPageAttachments: vi.fn().mockResolvedValue(undefined),
  getMissingAttachments: mocks.getMissingAttachments,
}));

vi.mock('../../knowledge/services/version-tracker.js', () => ({
  saveVersionSnapshot: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../core/utils/crypto.js', () => ({
  decryptPat: vi.fn().mockReturnValue('decrypted-pat'),
}));

vi.mock('../../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../core/db/postgres.js', () => ({
  query: (...args: unknown[]) => mocks.query(...args),
}));

const mockGetUserAccessibleSpaces = vi.fn().mockResolvedValue(['DEV']);
vi.mock('../../../core/services/rbac-service.js', () => ({
  getUserAccessibleSpaces: (...args: unknown[]) => mockGetUserAccessibleSpaces(...args),
}));

import { syncUser, getSyncStatus } from './sync-service.js';

describe('syncUser auto-embedding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.processDirtyPages.mockResolvedValue({ processed: 3, errors: 0 });
  });

  function setupSuccessfulSync() {
    mocks.query
      // 1. getClientForUser: user_settings
      .mockResolvedValueOnce({
        rows: [{ confluence_url: 'https://confluence.example.com', confluence_pat: 'encrypted-pat' }],
      })
      // 2. getUserAccessibleSpaces is mocked (returns ['DEV'])
      // 3. last_synced (no previous sync -> full sync)
      .mockResolvedValueOnce({ rows: [{ last_synced: null }] })
      // 4. detectDeletedPages: count of users with this space
      .mockResolvedValueOnce({ rows: [{ count: '1' }] })
      // 5. detectDeletedPages: existing pages
      .mockResolvedValueOnce({ rows: [] })
      // 6. update space sync timestamp
      .mockResolvedValueOnce({ rows: [] });

    mocks.getAllPagesInSpace.mockResolvedValueOnce([]);
  }

  it('should call processDirtyPages after successful sync', async () => {
    setupSuccessfulSync();

    await syncUser('user-1');

    await vi.waitFor(() => {
      expect(mocks.processDirtyPages).toHaveBeenCalledWith('user-1');
    });
  });

  it('should set status to embedding after sync completes', async () => {
    // Use a deferred promise to control when processDirtyPages resolves
    let resolveEmbedding!: (value: { processed: number; errors: number }) => void;
    mocks.processDirtyPages.mockReturnValueOnce(
      new Promise((resolve) => { resolveEmbedding = resolve; }),
    );

    setupSuccessfulSync();

    await syncUser('user-5');

    // Status should be 'embedding' while processDirtyPages is still running
    const statusDuringEmbed = await getSyncStatus('user-5');
    expect(statusDuringEmbed.status).toBe('embedding');

    // Resolve embedding
    resolveEmbedding({ processed: 3, errors: 0 });

    // After embedding completes, status should be 'idle'
    await vi.waitFor(async () => {
      const statusAfter = await getSyncStatus('user-5');
      expect(statusAfter.status).toBe('idle');
    });
  });

  it('should set status to idle even if embedding fails', async () => {
    mocks.processDirtyPages.mockRejectedValueOnce(new Error('Ollama offline'));
    setupSuccessfulSync();

    await syncUser('user-6');

    // Wait for the rejected promise to settle
    await vi.waitFor(async () => {
      const status = await getSyncStatus('user-6');
      expect(status.status).toBe('idle');
    });
  });

  it('should not call processDirtyPages when no credentials configured', async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [{ confluence_url: null, confluence_pat: null }],
    });

    await syncUser('user-2');

    expect(mocks.processDirtyPages).not.toHaveBeenCalled();
  });

  it('should not call processDirtyPages when no spaces selected', async () => {
    mockGetUserAccessibleSpaces.mockResolvedValueOnce([]); // No spaces for this test
    mocks.query
      .mockResolvedValueOnce({
        rows: [{ confluence_url: 'https://confluence.example.com', confluence_pat: 'encrypted-pat' }],
      });

    await syncUser('user-3');

    expect(mocks.processDirtyPages).not.toHaveBeenCalled();
  });

  it('should not block sync completion if embedding fails', async () => {
    mocks.processDirtyPages.mockRejectedValueOnce(new Error('Ollama offline'));
    setupSuccessfulSync();

    await expect(syncUser('user-4')).resolves.toBeUndefined();
  });
});

describe('syncPage attachment cache invalidation', () => {
  const mockPage = {
    id: 'page-1',
    title: 'Test Page',
    version: { number: 2, when: '2024-01-02T00:00:00Z', by: { displayName: 'Alice' } },
    space: { key: 'DEV' },
    ancestors: [],
    metadata: { labels: { results: [] } },
    body: { storage: { value: '<p>content</p>' } },
  };

  function setupSyncWithPage(existingVersion: number | null, existingBodyHtml = '<p>old</p>', existingBodyText = 'old') {
    mocks.query
      // 1. getClientForUser: user_settings
      .mockResolvedValueOnce({ rows: [{ confluence_url: 'https://conf.example.com', confluence_pat: 'enc' }] })
      // 2. getUserAccessibleSpaces is mocked (returns ['DEV'])
      // 3. last_synced (no previous sync -> full sync; space=undefined so no upsert)
      .mockResolvedValueOnce({ rows: [] })
      // 4. syncPage: existing page version check
      .mockResolvedValueOnce(
        existingVersion !== null
          ? { rows: [{ version: existingVersion, title: 'Old', body_html: existingBodyHtml, body_text: existingBodyText }] }
          : { rows: [] },
      )
      // 5. syncPage: upsert page
      .mockResolvedValueOnce({ rows: [] })
      // 6. detectDeletedPages: count of users with this space
      .mockResolvedValueOnce({ rows: [{ count: '1' }] })
      // 7. detectDeletedPages: existing page ids
      .mockResolvedValueOnce({ rows: [] })
      // 8. update space last_synced
      .mockResolvedValueOnce({ rows: [] });

    mocks.getAllPagesInSpace.mockResolvedValueOnce([mockPage]);
    mocks.getPage.mockResolvedValueOnce(mockPage);
    mocks.getPageAttachments.mockResolvedValueOnce({ results: [] });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.processDirtyPages.mockResolvedValue({ processed: 0, errors: 0 });
  });

  it('clears attachment cache when an existing page has a new version', async () => {
    setupSyncWithPage(1); // existing version 1, new version 2

    await syncUser('user-cache-clear');

    const { cleanPageAttachments } = await import('./attachment-handler.js');
    expect(cleanPageAttachments).toHaveBeenCalledWith('user-cache-clear', 'page-1');
  });

  it('does not clear attachment cache for brand-new pages', async () => {
    setupSyncWithPage(null); // no existing row

    await syncUser('user-cache-new');

    const { cleanPageAttachments } = await import('./attachment-handler.js');
    expect(cleanPageAttachments).not.toHaveBeenCalled();
  });

  it('refreshes cached HTML for unchanged pages when the rendered output changes', async () => {
    setupSyncWithPage(2);

    await syncUser('user-html-refresh');

    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE pages'),
      expect.arrayContaining(['page-1', 'Test Page', '<p>content</p>', '<p>html</p>', 'plain text']),
    );
  });
});

describe('incremental sync with missing attachments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.processDirtyPages.mockResolvedValue({ processed: 0, errors: 0 });
    mocks.getMissingAttachments.mockResolvedValue([]);
  });

  function setupIncrementalSync(opts: {
    modifiedPages?: Array<{ id: string; title: string }>;
    cachedPages?: Array<{ confluence_id: string; body_storage: string }>;
    missingAttachments?: string[];
  } = {}) {
    const recentDate = new Date(Date.now() - 1000 * 60 * 5); // 5 minutes ago

    mocks.query
      // 1. getClientForUser
      .mockResolvedValueOnce({ rows: [{ confluence_url: 'https://conf.example.com', confluence_pat: 'enc' }] })
      // 2. getUserAccessibleSpaces is mocked (returns ['DEV'])
      // 3. spaces.last_synced -> recent -> incremental sync
      .mockResolvedValueOnce({ rows: [{ last_synced: recentDate }] });

    // syncPage calls for each modified page
    for (let i = 0; i < (opts.modifiedPages ?? []).length; i++) {
      mocks.query
        // existing page version check
        .mockResolvedValueOnce({ rows: [] })
        // upsert page
        .mockResolvedValueOnce({ rows: [] });
    }

    // syncMissingAttachments: SELECT pages WHERE space_key
    mocks.query.mockResolvedValueOnce({
      rows: opts.cachedPages ?? [],
    });

    // update space last_synced
    mocks.query.mockResolvedValueOnce({ rows: [] });

    mocks.getModifiedPages.mockResolvedValueOnce(
      (opts.modifiedPages ?? []).map((p) => ({
        id: p.id,
        title: p.title,
        version: { number: 1 },
        space: { key: 'DEV' },
      })),
    );

    // Mock getPage + getPageAttachments for each modified page
    for (const page of opts.modifiedPages ?? []) {
      mocks.getPage.mockResolvedValueOnce({
        id: page.id,
        title: page.title,
        version: { number: 1, when: new Date().toISOString(), by: { displayName: 'Test' } },
        ancestors: [],
        metadata: { labels: { results: [] } },
        body: { storage: { value: '<p>content</p>' } },
      });
      mocks.getPageAttachments.mockResolvedValueOnce({ results: [] });
    }

    if (opts.missingAttachments && opts.missingAttachments.length > 0) {
      mocks.getMissingAttachments.mockResolvedValue(opts.missingAttachments);
      // getPageAttachments for missing attachment retry
      mocks.getPageAttachments.mockResolvedValueOnce({ results: [] });
    }
  }

  it('retries missing attachments for cached pages during incremental sync', async () => {
    setupIncrementalSync({
      cachedPages: [
        { confluence_id: 'page-old', body_storage: '<ac:image><ri:attachment ri:filename="lost.png" /></ac:image>' },
      ],
      missingAttachments: ['lost.png'],
    });

    await syncUser('user-inc');

    const { syncImageAttachments, syncDrawioAttachments } = await import('./attachment-handler.js');
    // syncImageAttachments should be called for the page with missing attachments
    expect(syncImageAttachments).toHaveBeenCalled();
    expect(syncDrawioAttachments).toHaveBeenCalled();
  });

  it('skips attachment retry when all pages have complete attachments', async () => {
    setupIncrementalSync({
      cachedPages: [
        { confluence_id: 'page-ok', body_storage: '<p>no images</p>' },
      ],
    });

    await syncUser('user-inc-ok');

    // getMissingAttachments returns [] (default), so no attachment retry calls
    // getPageAttachments should not be called for cached pages during retry
    // (it may be called 0 times or only for modified pages)
    const { syncImageAttachments } = await import('./attachment-handler.js');
    expect(syncImageAttachments).not.toHaveBeenCalled();
  });

  it('does not run syncMissingAttachments during full sync', async () => {
    mocks.query
      // 1. getClientForUser
      .mockResolvedValueOnce({ rows: [{ confluence_url: 'https://conf.example.com', confluence_pat: 'enc' }] })
      // 2. getUserAccessibleSpaces is mocked (returns ['DEV'])
      // 3. spaces.last_synced -> null -> full sync
      .mockResolvedValueOnce({ rows: [{ last_synced: null }] })
      // 4. detectDeletedPages: count of users with this space
      .mockResolvedValueOnce({ rows: [{ count: '1' }] })
      // 5. detectDeletedPages: existing page ids
      .mockResolvedValueOnce({ rows: [] })
      // 6. update space last_synced
      .mockResolvedValueOnce({ rows: [] });

    mocks.getAllPagesInSpace.mockResolvedValueOnce([]);

    await syncUser('user-full');

    // getMissingAttachments should NOT be called — full sync doesn't trigger syncMissingAttachments
    expect(mocks.getMissingAttachments).not.toHaveBeenCalled();
  });
});
