// Confluence domain barrel export
export { ConfluenceClient, ConfluenceError, isTransientError } from './services/confluence-client.js';
export type { ConfluencePage, ConfluenceSpace, ConfluenceAttachment } from './services/confluence-client.js';
export {
  syncDrawioAttachments,
  syncImageAttachments,
  cleanPageAttachments,
  readAttachment,
  fetchAndCachePageImage,
  getMimeType,
  writeAttachmentCache,
  attachmentExists,
  extractDrawioDiagramNames,
} from './services/attachment-handler.js';
export {
  syncUser,
  getClientForUser,
  getSyncStatus,
  setSyncStatus,
  startSyncWorker,
  stopSyncWorker,
} from './services/sync-service.js';
export { getSyncOverview } from './services/sync-overview-service.js';
export { extractImageReferences, getLocalFilenameForImageSource } from './services/image-references.js';
export { assembleSubPageContext, getMultiPagePromptSuffix } from './services/subpage-context.js';
