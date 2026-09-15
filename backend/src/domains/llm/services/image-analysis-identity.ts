import { createHash } from 'node:crypto';
import {
  IMAGE_ANALYSIS_SCHEMA_VERSION,
  ImageAnalysisIdentitySchema,
  type ImageAnalysisIdentity,
} from '@compendiq/contracts';
import { query } from '../../../core/db/postgres.js';
import { logger } from '../../../core/utils/logger.js';
import { loadProviderConfig, resolveImageAnalysisUsecase } from './llm-provider-resolver.js';
import { IMAGE_ANALYSIS_PROMPT_VERSION, type ImageAnalysisIdentityTriple } from './image-analysis-client.js';
import type { ProviderConfig } from './openai-compatible-client.js';

export { IMAGE_ANALYSIS_PROMPT_VERSION, type ImageAnalysisIdentityTriple };

/**
 * #1615 (ADR-027 D5/D7) — the inference identity and where it is retained.
 *
 * Identity = (`provider_id`, resolved `model`, provider `base_url`), hashed
 * in canonical form. The base URL is in it because a provider row's endpoint
 * can move without its id changing — and without an assignment PUT — so the
 * worker never derives a row's hash from the live provider row: rows carry
 * the RETAINED identity, compared here against the identity the assignment
 * resolves to now. `IMAGE_ANALYSIS_PROMPT_VERSION` and
 * `IMAGE_ANALYSIS_SCHEMA_VERSION` are NOT in the hash: they are constants of
 * the running code, stored per row and bound on every query.
 *
 * This module is the one place that hashes, for the PUT, the re-check, the
 * scope preview and the worker (#1616 reads `getRetainedImageAnalysisIdentity`
 * and `resolveImageAnalysisIdentity`; it never writes the retained row).
 */

/** `admin_settings` row holding the retained identity (D7). NOT seeded by migration 115. */
export const IMAGE_ANALYSIS_IDENTITY_KEY = 'image_analysis_identity';

/** The identity an assignment resolves to right now, hashed. */
export interface ResolvedImageAnalysisIdentity extends ImageAnalysisIdentityTriple {
  identityHash: string;
}

/** `sha256(providerId + '\n' + model + '\n' + baseUrl)`, hex — D5's canonical form. */
export function computeIdentityHash(triple: ImageAnalysisIdentityTriple): string {
  return createHash('sha256')
    .update(`${triple.providerId}\n${triple.model}\n${triple.baseUrl}`)
    .digest('hex');
}

/**
 * The identity the LIVE assignment resolves to, or null when `image_analysis`
 * is unassigned, its provider row is gone, or no model resolves. This is
 * D13's third gate term on the resolved side; `getRetainedImageAnalysisIdentity`
 * is the other side of the equality.
 */
export async function resolveImageAnalysisIdentity(): Promise<ResolvedImageAnalysisIdentity | null> {
  const resolved = await resolveImageAnalysisUsecase().catch(() => null);
  if (!resolved) return null;
  const triple = {
    providerId: resolved.config.providerId,
    model: resolved.model,
    baseUrl: resolved.config.baseUrl,
  };
  return { ...triple, identityHash: computeIdentityHash(triple) };
}

/** Why a candidate pair cannot resolve — the PUT's and the scope preview's two 422 reasons. */
export type ImageAnalysisResolutionReason = 'no_provider' | 'no_model';

export class ImageAnalysisResolutionError extends Error {
  constructor(public readonly reason: ImageAnalysisResolutionReason) {
    super(`image analysis pair does not resolve: ${reason}`);
    this.name = 'ImageAnalysisResolutionError';
  }
}

/**
 * The identity a `{ providerId, model? }` assignment WOULD produce, by the
 * PUT's rule: the assignment model, else the provider's `default_model`, else
 * nothing resolves. Shared by the PUT (which then probes it) and the scope
 * preview (which does not), so the two cannot disagree on the pair.
 */
export async function resolveCandidateImageAnalysisIdentity(candidate: {
  providerId: string;
  model?: string | null;
}): Promise<ResolvedImageAnalysisIdentity & { config: ProviderConfig & { defaultModel: string | null } }> {
  let config;
  try {
    config = await loadProviderConfig(candidate.providerId);
  } catch {
    throw new ImageAnalysisResolutionError('no_provider');
  }
  const model = candidate.model || config.defaultModel || '';
  if (!model) throw new ImageAnalysisResolutionError('no_model');
  const triple = { providerId: config.providerId, model, baseUrl: config.baseUrl };
  return { ...triple, identityHash: computeIdentityHash(triple), config };
}

/**
 * The retained identity (D7), or null when none was ever adopted. A row that
 * does not parse reads as null and is logged: the worker's gate then shuts
 * (`identity_drift`) rather than composing under a hash nobody can verify.
 */
export async function getRetainedImageAnalysisIdentity(): Promise<ImageAnalysisIdentity | null> {
  const r = await query<{ setting_value: string }>(
    `SELECT setting_value FROM admin_settings WHERE setting_key = $1`,
    [IMAGE_ANALYSIS_IDENTITY_KEY],
  );
  const raw = r.rows[0]?.setting_value;
  if (!raw) return null;
  try {
    const parsed = ImageAnalysisIdentitySchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
    logger.warn({ issues: parsed.error.issues.length }, 'image_analysis_identity row does not match its schema — treating as unset');
  } catch {
    logger.warn('image_analysis_identity row is not JSON — treating as unset');
  }
  return null;
}

/**
 * How many `analyzed` rows fail D5's validity predicate under `identityHash`
 * with the running constants — the rows the next sweep re-pends if that
 * identity is adopted. Both constants bound from code, never from settings.
 */
export async function countRowsInvalidatedBy(identityHash: string): Promise<number> {
  const r = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM page_image_analyses
      WHERE status = 'analyzed'
        AND NOT (identity_hash = $1 AND prompt_version = $2 AND schema_version = $3)`,
    [identityHash, IMAGE_ANALYSIS_PROMPT_VERSION, IMAGE_ANALYSIS_SCHEMA_VERSION],
  );
  return Number(r.rows[0]?.n ?? 0);
}

export interface ReanalysisScope {
  /** Whether `identityHash` differs from the retained identity (true when none is retained). */
  changed: boolean;
  /** Analyzed rows the adoption would invalidate; 0 when unchanged (a resume invalidates nothing). */
  reanalyzeRows: number;
}

/**
 * The scope preview's answer for a candidate hash, and the PUT's after the
 * fact: the same count from the same query, so the two can be compared. An
 * unchanged identity is a resume — nothing is invalidated, whatever rows
 * an older constant may have left behind for the sweep.
 */
export async function reanalysisScopeFor(identityHash: string): Promise<ReanalysisScope> {
  const retained = await getRetainedImageAnalysisIdentity();
  const changed = retained?.identityHash !== identityHash;
  if (!changed) return { changed: false, reanalyzeRows: 0 };
  return { changed: true, reanalyzeRows: await countRowsInvalidatedBy(identityHash) };
}

export interface RetainResult extends ReanalysisScope {
  identity: ImageAnalysisIdentity;
}

/**
 * D7's one writer, called by exactly two routes after a `true` probe of the
 * resolved pair. Equal to the retained identity → resume, nothing written
 * (`assignedAt` stays); different → replaced, and the count of analyzed rows
 * the replacement invalidated is returned. The rows themselves are touched by
 * the next batch's sweep (D13), never here.
 */
export async function retainImageAnalysisIdentity(
  resolved: ResolvedImageAnalysisIdentity,
): Promise<RetainResult> {
  const retained = await getRetainedImageAnalysisIdentity();
  if (retained && retained.identityHash === resolved.identityHash) {
    return { changed: false, reanalyzeRows: 0, identity: retained };
  }
  const reanalyzeRows = await countRowsInvalidatedBy(resolved.identityHash);
  const identity: ImageAnalysisIdentity = {
    providerId: resolved.providerId,
    model: resolved.model,
    baseUrl: resolved.baseUrl,
    identityHash: resolved.identityHash,
    assignedAt: new Date().toISOString(),
  };
  await query(
    `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (setting_key) DO UPDATE
       SET setting_value = EXCLUDED.setting_value, updated_at = NOW()`,
    [IMAGE_ANALYSIS_IDENTITY_KEY, JSON.stringify(identity)],
  );
  logger.info(
    { providerId: identity.providerId, model: identity.model, reanalyzeRows, previous: retained?.identityHash ?? null },
    'Image analysis identity retained',
  );
  return { changed: true, reanalyzeRows, identity };
}
