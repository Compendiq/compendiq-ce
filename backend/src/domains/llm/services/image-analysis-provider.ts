/**
 * ADR-027 — the seam between #1616 (ingestion, this package) and #1615 (the
 * vision assignment, the retained identity and the inference client).
 *
 * The two packages were built in parallel against one frozen contract. Every
 * module on the ingestion side — the worker, the reconcile, `embedPage`'s
 * composition, coverage, readiness — imports the identity, the client and the
 * ceiling reader from HERE and nowhere else, so that once #1615 merges this
 * file becomes a re-export of `image-analysis-identity.ts`,
 * `image-analysis-client.ts`, `@compendiq/contracts` and
 * `core/services/admin-settings-service.ts`, and nothing on this side moves.
 *
 * Until then the file is a local module with the same signatures and the
 * behaviour a never-assigned instance has:
 *
 *  - `resolveImageAnalysisIdentity()` answers `null` — the D13 gate is shut,
 *    every batch returns `reason: 'unassigned'` after its sweep and reconcile.
 *  - `getRetainedImageAnalysisIdentity()` reads the D7 settings row for real:
 *    composition, coverage and readiness need the retained hash whether or
 *    not anything can currently be analyzed (pause, not purge).
 *  - `analyzeImage()` throws. It is unreachable while the gate is shut, and
 *    the worker's tests inject a deterministic double through
 *    `ImageAnalysisWorkerDeps` rather than reaching it.
 *
 * Constants, types and hashing are the ADR's own definitions and cannot
 * differ from #1615's — the hash is `sha256(providerId + '\n' + model + '\n'
 * + baseUrl)` (D5), the failure classes are D8's six, the payload type is the
 * D8 schema's shape.
 */
import { createHash } from 'crypto';
import { query } from '../../../core/db/postgres.js';
import { logger } from '../../../core/utils/logger.js';

// ─── Constants (ADR-027 D5 / D8) ─────────────────────────────────────────────

/** Schema v1 of `page_image_analyses.payload`; owned by `@compendiq/contracts` in #1615. */
export const IMAGE_ANALYSIS_SCHEMA_VERSION = 1;
/** The fixed instruction's version; bumping it forces a corpus-wide re-analysis (D5). */
export const IMAGE_ANALYSIS_PROMPT_VERSION = 1;
/** `admin_settings` row carrying the retained identity JSON (D7). Never seeded. */
export const IMAGE_ANALYSIS_IDENTITY_KEY = 'image_analysis_identity';

export const IMAGE_ANALYSIS_MAX_OUTPUT_TOKENS_DEFAULT = 8192;
export const IMAGE_ANALYSIS_MAX_OUTPUT_TOKENS_MIN = 4096;
export const IMAGE_ANALYSIS_MAX_OUTPUT_TOKENS_MAX = 16384;

// ─── Types ───────────────────────────────────────────────────────────────────

export type ImageAnalysisKind = 'screenshot' | 'diagram' | 'chart' | 'table' | 'photo' | 'other';

/** The validated D8 payload as stored in `page_image_analyses.payload`. */
export interface ImageAnalysisPayload {
  schemaVersion: 1;
  kind: ImageAnalysisKind;
  language: string;
  description: string;
  visibleText: string;
  structured?: {
    tableRows?: string[];
    chart?: { xAxis?: string; yAxis?: string; trend?: string; series?: string[] };
    diagram?: { nodes?: string[]; edges?: string[] };
  };
  limitations: string[];
}

/** D8's six failure classes. The first five are deterministic; `unavailable` is transient. */
export type ImageAnalysisFailureClass =
  | 'malformed'
  | 'empty'
  | 'refused'
  | 'truncated'
  | 'rejected'
  | 'unavailable';

export interface ImageAnalysisIdentityTriple {
  providerId: string;
  model: string;
  baseUrl: string;
}

/** The D7 retained identity: the last explicit vision identity, kept across a pause. */
export interface ImageAnalysisIdentity extends ImageAnalysisIdentityTriple {
  identityHash: string;
  /** ISO-8601; when the assignment PUT or re-check retained this identity. */
  assignedAt: string;
}

export interface ResolvedImageAnalysisIdentity extends ImageAnalysisIdentityTriple {
  identityHash: string;
}

export interface AnalyzeImageInput {
  bytes: Buffer;
  mimeType: string;
  /** The RETAINED triple the batch read (D13) — never the live provider row. */
  identity: ImageAnalysisIdentityTriple;
  maxOutputTokens: number;
  timeoutMs?: number;
}

export type AnalyzeImageResult =
  | {
      ok: true;
      payload: ImageAnalysisPayload;
      finishReason: string;
      usage: { promptTokens: number; completionTokens: number };
    }
  | {
      ok: false;
      class: ImageAnalysisFailureClass;
      /** The HTTP status when one was received (`rejected`, `unavailable`). */
      httpStatus?: number;
      /**
       * D8's default arm: a 4xx outside the `rejected` list and outside
       * 408/429. The row is `unavailable`; the batch ends before its next call
       * and re-probes the pair (D13).
       */
      providerLevel: boolean;
      /** The ceiling a `truncated` reply overran (`max_tokens` of the request). */
      ceiling?: number;
      message: string;
    };

// ─── Hashing and error encoding (pure) ───────────────────────────────────────

/** D5: `sha256(providerId + '\n' + model + '\n' + baseUrl)`, hex. */
export function computeIdentityHash(triple: ImageAnalysisIdentityTriple): string {
  return createHash('sha256')
    .update(`${triple.providerId}\n${triple.model}\n${triple.baseUrl}`)
    .digest('hex');
}

/**
 * The `page_image_analyses.error` encoding (D13): the class with the number
 * it needs read back — `truncated:8192`, `rejected:413`, `unavailable:405` —
 * bare otherwise (`malformed`). Never the provider body. The worker writes
 * one value this encoder never produces, `unavailable:bytes`, for a work row
 * whose file was there but could not be read (no call was made).
 */
export function encodeImageAnalysisError(failure: Extract<AnalyzeImageResult, { ok: false }>): string {
  if (failure.class === 'truncated' && failure.ceiling !== undefined) {
    return `truncated:${failure.ceiling}`;
  }
  if ((failure.class === 'rejected' || failure.class === 'unavailable') && failure.httpStatus !== undefined) {
    return `${failure.class}:${failure.httpStatus}`;
  }
  return failure.class;
}

// ─── Settings readers ────────────────────────────────────────────────────────

function parseIdentity(raw: string): ImageAnalysisIdentity | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  const str = (k: string): string | null => (typeof o[k] === 'string' && (o[k] as string).length > 0 ? (o[k] as string) : null);
  const providerId = str('providerId');
  const model = str('model');
  const baseUrl = str('baseUrl');
  const identityHash = str('identityHash');
  const assignedAt = str('assignedAt');
  if (!providerId || !model || !baseUrl || !identityHash || !assignedAt) return null;
  return { providerId, model, baseUrl, identityHash, assignedAt };
}

/**
 * The retained identity (D7), or `null` when no vision assignment has ever
 * been probed `true`. Read on every call: it is one indexed row, and a cached
 * value would compose stale chunks for a TTL after a re-assign.
 */
export async function getRetainedImageAnalysisIdentity(): Promise<ImageAnalysisIdentity | null> {
  const r = await query<{ setting_value: string }>(
    `SELECT setting_value FROM admin_settings WHERE setting_key = $1`,
    [IMAGE_ANALYSIS_IDENTITY_KEY],
  );
  const raw = r.rows[0]?.setting_value;
  if (!raw) return null;
  const identity = parseIdentity(raw);
  if (!identity) logger.warn('Ignoring an unreadable image_analysis_identity row');
  return identity;
}

/**
 * The identity the `image_analysis` assignment resolves to NOW, hashed as D5
 * hashes it, or `null` when unassigned. Until #1615 lands there is no
 * assignment to resolve, so this is the never-assigned answer.
 */
export async function resolveImageAnalysisIdentity(): Promise<ResolvedImageAnalysisIdentity | null> {
  return null;
}

/**
 * `admin_settings.image_analysis_max_output_tokens` (D8): default 8192,
 * [4096, 16384]; an unparseable or out-of-range row reads as the default.
 * Seeded by migration 115; absent until it lands, which is the default too.
 */
export async function getImageAnalysisMaxOutputTokens(): Promise<number> {
  try {
    const r = await query<{ setting_value: string }>(
      `SELECT setting_value FROM admin_settings WHERE setting_key = 'image_analysis_max_output_tokens'`,
    );
    const raw = r.rows[0]?.setting_value;
    if (raw && /^\d+$/.test(raw)) {
      const n = Number(raw);
      if (n >= IMAGE_ANALYSIS_MAX_OUTPUT_TOKENS_MIN && n <= IMAGE_ANALYSIS_MAX_OUTPUT_TOKENS_MAX) return n;
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to read image_analysis_max_output_tokens — using default');
  }
  return IMAGE_ANALYSIS_MAX_OUTPUT_TOKENS_DEFAULT;
}

// ─── The client ──────────────────────────────────────────────────────────────

/**
 * One analysis call (D8). Unreachable on this branch: the gate above never
 * opens, so no batch reaches step 3. #1615's client replaces this export.
 */
export async function analyzeImage(_input: AnalyzeImageInput): Promise<AnalyzeImageResult> {
  throw new Error('Image analysis client unavailable: the image_analysis use case (#1615) is not installed');
}
