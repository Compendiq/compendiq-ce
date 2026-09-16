/**
 * ADR-027 — the one import point the ingestion half (#1616) uses for the
 * inference half (#1615).
 *
 * While the two packages were in flight this file carried local stand-ins with
 * the agreed signatures so the worker, the reconcile, the composition and the
 * validity predicate could be written and tested against the frozen interface.
 * #1615 is merged, so it is now a PURE re-export of the real modules and holds
 * no logic of its own: `image-analysis-identity.ts` (D5/D7 — the resolved and
 * the retained identity), `image-analysis-client.ts` (D8 — the analysis call
 * and its failure classing), `admin-settings-service.ts` (D8's output-token
 * ceiling) and `@compendiq/contracts` (the payload, the identity row and the
 * failure classes).
 *
 * It stays as one module rather than being inlined at the twelve call sites
 * because it names ONE thing — "everything ingestion needs from the vision
 * half" — and #1617–#1619 will import the same set.
 */
export {
  computeIdentityHash,
  getRetainedImageAnalysisIdentity,
  IMAGE_ANALYSIS_IDENTITY_KEY,
  resolveImageAnalysisIdentity,
  type ResolvedImageAnalysisIdentity,
} from './image-analysis-identity.js';

export {
  analyzeImage,
  encodeImageAnalysisError,
  IMAGE_ANALYSIS_PROMPT_VERSION,
  type AnalyzeImageInput,
  type AnalyzeImageResult,
  type ImageAnalysisIdentityTriple,
} from './image-analysis-client.js';

export { getImageAnalysisMaxOutputTokens } from '../../../core/services/admin-settings-service.js';

export {
  IMAGE_ANALYSIS_SCHEMA_VERSION,
  type ImageAnalysisFailureClass,
  type ImageAnalysisIdentity,
  type ImageAnalysisKind,
  type ImageAnalysisPayload,
} from '@compendiq/contracts';
