import type { SyncOverviewResponse, SyncOverviewSpace, SyncOverviewIssue, AssetSyncCounts } from '@kb-creator/contracts';
import { query } from '../../../core/db/postgres.js';
import { attachmentExists, extractDrawioDiagramNames } from './attachment-handler.js';
import { extractImageReferences } from '../../../core/services/image-references.js';
import { getSyncStatus } from './sync-service.js';

interface OverviewRow {
  space_key: string;
  space_name: string | null;
  space_last_synced: Date | null;
  page_id: string | null;
  page_title: string | null;
  body_storage: string | null;
}

function emptyCounts(): AssetSyncCounts {
  return { expected: 0, cached: 0, missing: 0 };
}

function toIsoString(value?: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function mergeCounts(target: AssetSyncCounts, source: AssetSyncCounts): void {
  target.expected += source.expected;
  target.cached += source.cached;
  target.missing += source.missing;
}

async function summarizeAssets(
  userId: string,
  pageId: string,
  filenames: string[],
): Promise<{ counts: AssetSyncCounts; missingFiles: string[] }> {
  const unique = [...new Set(filenames)];
  if (unique.length === 0) {
    return { counts: emptyCounts(), missingFiles: [] };
  }

  const exists = await Promise.all(unique.map((filename) => attachmentExists(userId, pageId, filename)));
  const cached = exists.filter(Boolean).length;
  const missingFiles = unique.filter((_, index) => !exists[index]);

  return {
    counts: {
      expected: unique.length,
      cached,
      missing: missingFiles.length,
    },
    missingFiles,
  };
}

export async function getSyncOverview(userId: string): Promise<SyncOverviewResponse> {
  const rowsResult = await query<OverviewRow>(
    `SELECT
       uss.space_key,
       cs.space_name,
       cs.last_synced AS space_last_synced,
       cp.confluence_id AS page_id,
       cp.title AS page_title,
       cp.body_storage
     FROM user_space_selections uss
     LEFT JOIN cached_spaces cs ON cs.space_key = uss.space_key
     LEFT JOIN pages cp ON cp.space_key = uss.space_key
     WHERE uss.user_id = $1
     ORDER BY uss.space_key, cp.title NULLS LAST`,
    [userId],
  );

  const sync = getSyncStatus(userId);
  const spaces = new Map<string, SyncOverviewSpace>();
  const issues: SyncOverviewIssue[] = [];

  for (const row of rowsResult.rows) {
    const existingSpace = spaces.get(row.space_key);
    const space = existingSpace ?? {
      spaceKey: row.space_key,
      spaceName: row.space_name ?? row.space_key,
      status: 'not_synced' as const,
      lastSynced: toIsoString(row.space_last_synced),
      pageCount: 0,
      pagesWithAssets: 0,
      pagesWithIssues: 0,
      images: emptyCounts(),
      drawio: emptyCounts(),
    };

    if (!existingSpace) {
      spaces.set(row.space_key, space);
    }

    if (!row.page_id) {
      continue;
    }

    space.pageCount += 1;

    const bodyStorage = row.body_storage ?? '';
    const imageFiles = extractImageReferences(bodyStorage, row.space_key).map((ref) => ref.localFilename);
    const drawioFiles = extractDrawioDiagramNames(bodyStorage).map((name) => `${name}.png`);

    if (imageFiles.length > 0 || drawioFiles.length > 0) {
      space.pagesWithAssets += 1;
    }

    const [{ counts: imageCounts, missingFiles: missingImages }, { counts: drawioCounts, missingFiles: missingDrawio }] = await Promise.all([
      summarizeAssets(userId, row.page_id, imageFiles),
      summarizeAssets(userId, row.page_id, drawioFiles),
    ]);

    mergeCounts(space.images, imageCounts);
    mergeCounts(space.drawio, drawioCounts);

    if (missingImages.length > 0 || missingDrawio.length > 0) {
      space.pagesWithIssues += 1;
      issues.push({
        pageId: row.page_id,
        pageTitle: row.page_title ?? row.page_id,
        spaceKey: row.space_key,
        missingImages: missingImages.length,
        missingDrawio: missingDrawio.length,
        missingFiles: [...missingImages, ...missingDrawio],
      });
    }
  }

  const spacesList = [...spaces.values()].map((space) => {
    const isSyncingSpace = sync.status === 'syncing' && sync.progress?.space === space.spaceKey;
    const status: SyncOverviewSpace['status'] = isSyncingSpace
      ? 'syncing'
      : !space.lastSynced
        ? 'not_synced'
        : space.pagesWithIssues > 0
          ? 'degraded'
          : 'healthy';

    return {
      ...space,
      status,
    };
  });

  const totals = spacesList.reduce<SyncOverviewResponse['totals']>((acc, space) => {
    acc.selectedSpaces += 1;
    acc.totalPages += space.pageCount;
    acc.pagesWithAssets += space.pagesWithAssets;
    acc.pagesWithIssues += space.pagesWithIssues;
    mergeCounts(acc.images, space.images);
    mergeCounts(acc.drawio, space.drawio);
    return acc;
  }, {
    selectedSpaces: 0,
    totalPages: 0,
    pagesWithAssets: 0,
    pagesWithIssues: 0,
    healthyPages: 0,
    images: emptyCounts(),
    drawio: emptyCounts(),
  });
  totals.healthyPages = Math.max(0, totals.totalPages - totals.pagesWithIssues);

  return {
    sync: {
      userId: sync.userId,
      status: sync.status,
      progress: sync.progress,
      error: sync.error,
      lastSynced: toIsoString(sync.lastSynced) ?? undefined,
    },
    totals,
    spaces: spacesList,
    issues: issues
      .sort((a, b) => (b.missingImages + b.missingDrawio) - (a.missingImages + a.missingDrawio))
      .slice(0, 25),
  };
}
