import type { PoolClient } from 'pg';
import type {
  PageGovernanceProposalStatus,
  PageLifecycleDenialReason,
} from '@compendiq/contracts';
import { PAGE_GOVERNANCE_POLICY_LOCK_KEY } from '../db/advisory-locks.js';
import { isConfluenceEnabled } from './confluence-integration.js';

/** Increment only with a reviewed, migration-backed protected-writer cutover. */
export const PAGE_WRITER_ENFORCEMENT_VERSION = 1;

export interface PageBaselineGovernancePage {
  id: number;
  spaceKey: string | null;
  source: string;
  createdByUserId: string | null;
  contentRevision: string;
  lifecycleRevision: string;
}

export interface PageBaselineGovernanceActor {
  id: string;
  displayName: string;
}

export interface PageBaselineGovernanceManifest {
  baselineId: string;
  manifest: unknown[];
  manifestBytes: Buffer;
  manifestDigest: string;
  contentRevision: string;
}

export interface PageBaselineGovernanceCapabilities {
  proposalStatus: PageGovernanceProposalStatus;
  proposalId: string | null;
  canApprove: boolean;
  approveDeniedReason: PageLifecycleDenialReason | null;
}

/**
 * Shared CE admission policy for baseline creation and governed approval.
 * Page provenance is authoritative: historical Confluence identifiers, space
 * keys and credentials never make a non-standalone row eligible.
 *
 * Admission callers lock an existing explicit-off settings row through commit.
 * Capability reads explicitly opt out, including read-only transactions.
 * Read failures propagate; only a persisted `false` is standalone mode.
 */
export async function pageBaselineEligibilityDenialReason(
  client: PoolClient,
  input: { actorId: string; pageSource: string; lockSettings: boolean },
): Promise<Extract<
  PageLifecycleDenialReason,
  'standalone_article_required' | 'confluence_integration_enabled'
> | null> {
  if (input.pageSource !== 'standalone') return 'standalone_article_required';
  return await isConfluenceEnabled(input.actorId, client, input.lockSettings)
    ? 'confluence_integration_enabled'
    : null;
}

export interface PreparedGovernanceEvidence {
  /** Internal reference only. It is never accepted from an HTTP request. */
  evidenceId: string;
  signingRequired: boolean;
  archiveRequired: boolean;
}

export interface FinalizedGovernanceEvidence {
  provenance: 'authenticated_approval';
  signingSatisfied: boolean;
  archiveSatisfied: boolean;
  evidenceReference: string;
}

export interface PageBaselineGovernanceHook {
  /** Re-read proposal/policy/principal state using the supplied transaction. */
  capabilities(input: {
    client: PoolClient;
    page: PageBaselineGovernancePage;
    actor: PageBaselineGovernanceActor;
  }): Promise<PageBaselineGovernanceCapabilities>;

  /**
   * Prepare EE signing/archive evidence for a governed proposal. Implementations
   * may create transaction-local records, but must not publish them here.
   */
  prepareEvidence(input: {
    client: PoolClient;
    page: PageBaselineGovernancePage;
    actor: PageBaselineGovernanceActor;
    proposalId: string;
    manifest: PageBaselineGovernanceManifest;
  }): Promise<PreparedGovernanceEvidence>;

  /**
   * Revalidate all current principals, requirements and policy, then atomically
   * promote signed/archive evidence using the same locked PoolClient as the CE
   * baseline publication. A false required-adapter result is rejected by core.
   */
  authorizeAndFinalize(input: {
    client: PoolClient;
    page: PageBaselineGovernancePage;
    actor: PageBaselineGovernanceActor;
    proposalId: string;
    manifest: PageBaselineGovernanceManifest;
    prepared: PreparedGovernanceEvidence;
  }): Promise<FinalizedGovernanceEvidence>;

  /** Protected mutations call this inside their admission transaction. */
  invalidateProposalForMutation?(input: {
    client: PoolClient;
    pageId: number;
    contentRevision: string;
  }): Promise<void>;

  /** An admin policy change must evict any EE-side derived policy cache. */
  invalidatePolicyCache?(spaceKey: string): Promise<void>;
}

let governanceHook: PageBaselineGovernanceHook | null = null;

export function setPageBaselineGovernanceHook(hook: PageBaselineGovernanceHook | null): void {
  governanceHook = hook;
}

export function getPageBaselineGovernanceHook(): PageBaselineGovernanceHook | null {
  return governanceHook;
}

export interface PageGovernanceMarker {
  enabled: boolean;
  policyRevision: string | null;
}

/**
 * Read the persisted CE marker on the caller's transaction. Plugin or license
 * state is intentionally irrelevant: an enabled marker can never fall through
 * to manual CE finalization. Authorized audited thaw remains available.
 *
 * Final freeze decisions pass `lock: 'shared'`. That transaction-scoped
 * space fence is deliberately taken before this SELECT: unlike a row lock it
 * also serializes an absent marker with a concurrent policy INSERT. Advisory
 * capability/preview reads omit it because only the final write boundary must
 * be linearized with policy changes.
 */
export async function readPageGovernanceMarker(
  client: PoolClient,
  spaceKey: string | null,
  options: { lock?: 'shared' } = {},
): Promise<PageGovernanceMarker> {
  if (!spaceKey) return { enabled: false, policyRevision: null };
  if (options.lock === 'shared') {
    await client.query(
      'SELECT pg_advisory_xact_lock_shared($1, hashtext($2))',
      [PAGE_GOVERNANCE_POLICY_LOCK_KEY, spaceKey],
    );
  }
  const result = await client.query<{ governance_enabled: boolean; policy_revision: string }>(
    `SELECT governance_enabled, policy_revision::text
       FROM page_governance_policies
      WHERE space_key = $1`,
    [spaceKey],
  );
  const row = result.rows[0];
  return row
    ? { enabled: row.governance_enabled, policyRevision: row.policy_revision }
    : { enabled: false, policyRevision: null };
}

export interface DeploymentReadiness {
  ready: boolean;
  blockers: string[];
}

export type PageBaselineReadinessProvider = (client: PoolClient) => Promise<DeploymentReadiness>;

let readinessProvider: PageBaselineReadinessProvider | null = null;

/** #276 registers this only after every protected writer is enforced. */
export function setPageBaselineReadinessProvider(
  provider: PageBaselineReadinessProvider | null,
): void {
  readinessProvider = provider;
}

/** Install only after the collaboration, sync and cascade writers are registered. */
export function registerPageBaselineEnforcementReadiness(): void {
  setPageBaselineReadinessProvider(async (client) => {
    const incompatible = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM page_writer_runtimes
          WHERE fenced_at IS NULL AND quiesced_at IS NULL
            AND enforcement_version <> $1
       ) AS exists`,
      [PAGE_WRITER_ENFORCEMENT_VERSION],
    );
    return incompatible.rows[0]?.exists === false
      ? { ready: true, blockers: [] }
      : { ready: false, blockers: ['incompatible_page_writer_runtime'] };
  });
}

/** Default is deliberately disabled; no startup path activates creation. */
export async function getPageBaselineDeploymentReadiness(client: PoolClient): Promise<DeploymentReadiness> {
  if (!readinessProvider) {
    return {
      ready: false,
      blockers: ['protected_writer_enforcement_not_registered'],
    };
  }
  try {
    const result = await readinessProvider(client);
    const blockers = Array.from(new Set(result.blockers.filter((item) => item.length > 0))).slice(0, 100);
    return {
      ready: result.ready && blockers.length === 0,
      blockers,
    };
  } catch {
    return {
      ready: false,
      blockers: ['deployment_readiness_unavailable'],
    };
  }
}

export function _resetPageBaselineGovernanceForTests(): void {
  governanceHook = null;
  readinessProvider = null;
}
