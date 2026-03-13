// Knowledge domain barrel export
export {
  autoTagPage,
  applyTags,
  autoTagAllPages,
  ALLOWED_TAGS,
} from './services/auto-tagger.js';
export type { AllowedTag } from './services/auto-tagger.js';
export { startQualityWorker, stopQualityWorker, getQualityStatus, forceQualityRescan } from './services/quality-worker.js';
export { startSummaryWorker, stopSummaryWorker, getSummaryStatus, rescanAllSummaries, regenerateSummary, runSummaryBatch } from './services/summary-worker.js';
export { getVersionHistory, getVersion, getSemanticDiff, saveVersionSnapshot } from './services/version-tracker.js';
export { findDuplicates, scanAllDuplicates } from './services/duplicate-detector.js';
