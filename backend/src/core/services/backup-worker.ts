import { logger } from '../utils/logger.js';
import { isBackupDue, runS3Backup } from './backup-service.js';

const LEGACY_POLL_MS = 15 * 60 * 1000;

let legacyTimer: ReturnType<typeof setInterval> | null = null;

export async function processBackupJob(): Promise<string> {
  if (!(await isBackupDue())) {
    return 'Backup not due';
  }
  const filename = await runS3Backup(null);
  return `Uploaded ${filename}`;
}

export async function runForcedBackup(triggeredBy: string | null): Promise<string> {
  const filename = await runS3Backup(triggeredBy);
  return `Uploaded ${filename}`;
}

export function startBackupLegacyWorker(): void {
  if (legacyTimer) return;
  legacyTimer = setInterval(() => {
    processBackupJob().catch((err: unknown) => {
      logger.error({ err }, 'Legacy scheduled backup failed');
    });
  }, LEGACY_POLL_MS);
  legacyTimer.unref();
}

export function stopBackupLegacyWorker(): void {
  if (!legacyTimer) return;
  clearInterval(legacyTimer);
  legacyTimer = null;
}
