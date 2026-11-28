/**
 * Carrier recovery on the writers (#1953 PR 2; design/1953.md revision 7 §3.7, §3.8, §7, Z5, Z6).
 *
 * {@link reconcileStoredCarriers} decides whether a page row may recover carriers at all (a lockstep row: a
 * Confluence page with storage, no local modification, no collaborative document and no draw.io wrapper), draws
 * the marker and runs the pure matcher (`confluence-carrier-reconcile.ts`). It logs nothing: whether a prepared
 * recovery is written is known only after the reservation, so the writer writes the one line of §7 itself with
 * {@link logStoredCarriers} once the outcome is known. {@link assertCarrierRecoveryEligible} re-establishes the
 * evidence `content_revision` does not cover under the lifecycle lock of the reserving transaction (Y7, D14.4).
 *
 * Supported writers (maintainer decision D9): PUT, draft publish and AI Improve apply on lockstep rows, and the
 * seed of a new collaborative room from a lockstep row. A collaborative Save, version restore and every existing
 * room lineage recover nothing.
 */
import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { logger } from '../utils/logger.js';
import { JSDOM } from 'jsdom';
import { codeBlockElements, type LegacyCodeMetadataOp, type LexerCodeText } from './content-converter.js';
import {
  CARRIER_KINDS,
  CARRIER_RECONCILE_MAX_UNITS,
  reconcileConfluenceCarriers,
  type CarrierKindId,
  type CarrierReport,
} from './confluence-carrier-reconcile.js';
import { PageWriteError } from './page-write-admission.js';

/** The writers that recover carriers (D9), as they appear in the log line. */
export type CarrierWriter = 'put' | 'draft_publish' | 'ai_apply' | 'collab_seed';

/** Why a Confluence row with storage is not reconciled (D9 R4: counted and disclosed). */
export type CarrierExclusion = 'local_modified' | 'collab_document' | 'drawio';

/** The evidence columns of a writer's own row read. */
export interface CarrierRow {
  readonly source: string;
  readonly body_html: string | null;
  readonly body_storage: string | null;
  readonly local_modified_at: Date | string | null;
  readonly confluence_id: string | null;
  readonly space_key: string | null;
  readonly has_collab_doc: boolean;
}

/** `has_collab_doc` in a writer's row read of `pages p`. */
export const CARRIER_HAS_COLLAB_DOC_SQL = 'EXISTS (SELECT 1 FROM page_collaborative_docs d WHERE d.page_id = p.id)';

export interface StoredCarrierResult {
  /** The HTML to write: the target itself unless a recovery was applied. */
  readonly html: string;
  /** Whether `html` holds recovered carriers (`report.outcome === 'recovered'`). */
  readonly changed: boolean;
  readonly report: CarrierReport;
  /** Not a Confluence row with storage and a stored body: nothing to say, nothing logged. */
  readonly applicable: boolean;
  readonly excluded: CarrierExclusion | null;
  /** For an excluded row: the kinds the storage may carry (names only). */
  readonly kinds: readonly CarrierKindId[];
}

const EMPTY_REPORT: CarrierReport = Object.freeze({
  outcome: 'none',
  recovered: {},
  skipped: {},
  codeOps: [],
  droppedLinkAttributes: 0,
  work: { nodes: 0, passes: 0, projectedUnits: 0, keyUnits: 0, spliceUnits: 0, containment: 0 },
}) as CarrierReport;

/** A writer's lockstep gate on its row (§3.1 condition 1); computed once and passed on, never re-parsed. */
export type CarrierGate = { applicable: false } | { applicable: true; excluded: CarrierExclusion | null };

/** §3.6 stage 0: every given string is within the reconcile bound (a missing one counts as empty). */
export function withinCarrierBound(...values: ReadonlyArray<string | null>): boolean {
  return values.every((value) => (value?.length ?? 0) <= CARRIER_RECONCILE_MAX_UNITS);
}

/**
 * Whether a row may recover (§3.1 condition 1): not applicable without a Confluence source, storage and a stored
 * body; otherwise the first failing condition is the excluded reason. A gate, not a proof. A stored body or storage
 * past the bound is checked first (§3.6 stage 0, which precedes the draw.io probe): nothing is parsed and no reason
 * is given, since the matcher answers `bound` for that row.
 */
export function lockstepStoredBody(row: CarrierRow): CarrierGate {
  if (row.source !== 'confluence' || !row.body_storage || !row.body_html) return { applicable: false };
  if (!withinCarrierBound(row.body_html, row.body_storage)) return { applicable: true, excluded: null };
  if (row.local_modified_at !== null) return { applicable: true, excluded: 'local_modified' };
  if (row.has_collab_doc) return { applicable: true, excluded: 'collab_document' };
  if (holdsDrawioWrapper(row.body_html)) return { applicable: true, excluded: 'drawio' };
  return { applicable: true, excluded: null };
}

/**
 * D9 R4 / A4: the stored body holds a draw.io wrapper, the element the unmarked preview writer
 * (`drawio-previews.ts`) rewrites and `htmlToConfluence` writes back as a draw.io macro: an element of the parsed
 * body whose class list holds `confluence-drawio`, the selector both use. Structural, never a spelling: an
 * entity-spelled class is the same element, prose or code naming the class is none.
 */
function holdsDrawioWrapper(html: string): boolean {
  return new JSDOM(`<body>${html}</body>`, { contentType: 'text/html' }).window.document.querySelector('.confluence-drawio') !== null;
}

/** The kinds `storage` may carry, behind the length bound; none past it. */
export function carrierKindsStorageMayCarry(storage: string | null): CarrierKindId[] {
  if (!storage || storage.length > CARRIER_RECONCILE_MAX_UNITS) return [];
  return CARRIER_KINDS.filter((kind) => kind.storageMayCarry(storage)).map((kind) => kind.id);
}

/**
 * Prepare the HTML a writer means to write (§3.7). Draws the marker, logs nothing. `codeWitnesses` is passed on
 * the Improve writer only, always (possibly empty), so code text is never compared raw there. `gate` is the
 * writer's own {@link lockstepStoredBody} of this row when it already has one. Every length (stored body, storage
 * and target) is checked before the gate, an exclusion's storage scan or any parse: past the bound the result is
 * the matcher's `bound`, which it answers before any work (§3.6 stage 0).
 */
export function reconcileStoredCarriers(input: {
  row: CarrierRow;
  targetHtml: string;
  codeWitnesses?: ReadonlyArray<LexerCodeText | null>;
  gate?: CarrierGate;
}): StoredCarrierResult {
  const { row, targetHtml } = input;
  const unchanged = (applicable: boolean, excluded: CarrierExclusion | null, kinds: readonly CarrierKindId[]): StoredCarrierResult =>
    ({ html: targetHtml, changed: false, report: EMPTY_REPORT, applicable, excluded, kinds });
  if (row.source !== 'confluence' || !row.body_storage || !row.body_html) return unchanged(false, null, []);
  if (withinCarrierBound(row.body_html, row.body_storage, targetHtml)) {
    const gate = input.gate ?? lockstepStoredBody(row);
    if (!gate.applicable) return unchanged(false, null, []);
    if (gate.excluded) return unchanged(true, gate.excluded, carrierKindsStorageMayCarry(row.body_storage));
  }
  const result = reconcileConfluenceCarriers(row.body_html, row.body_storage, targetHtml, {
    marker: `data-cq-${randomBytes(16).toString('hex')}`,
    confluenceId: row.confluence_id ?? undefined,
    spaceKey: row.space_key ?? undefined,
    codeWitnesses: input.codeWitnesses,
  });
  return {
    html: result.html,
    changed: result.report.outcome === 'recovered',
    report: result.report,
    applicable: true,
    excluded: null,
    kinds: [],
  };
}

/**
 * The value of a seeded room's `confluenceCarriers` key (§3.8, Z6): the kinds the seed evaluated with no skipped
 * record, sorted. Null (no key) for a seed that did not reconcile, or whose reconcile ended on a bound or a failure.
 */
export function seededCarrierKinds(result: StoredCarrierResult): CarrierKindId[] | null {
  if (!result.applicable || result.excluded) return null;
  const { outcome, skipped } = result.report;
  if (outcome !== 'recovered' && outcome !== 'evaluated' && outcome !== 'none') return null;
  return CARRIER_KINDS.map((kind) => kind.id).filter((id) => skipped[id] === undefined).sort();
}

/**
 * The one line of §7, written once per request when its outcome is known (`reserved`), when the reservation
 * declined it (`stale`, 409) or when the Improve application check refused it (`refused`). Names and numbers only:
 * never a title, value, link target, code text, witness, marker or ordinal. A row the recovery does not apply to,
 * an excluded row whose storage carries nothing and a reconcile that found nothing write no line.
 */
export function logStoredCarriers(input: {
  pageId: number;
  writer: CarrierWriter;
  result: StoredCarrierResult;
  final: 'reserved' | 'stale' | 'refused';
}): void {
  const { pageId, writer, result, final } = input;
  if (!result.applicable) return;
  if (result.excluded) {
    if (result.kinds.length === 0) return;
    logger.info({ pageId, writer, excluded: result.excluded, kinds: result.kinds }, 'Confluence carriers reconciled (#1953)');
    return;
  }
  const { report } = result;
  if (final !== 'reserved') {
    if (report.outcome === 'none') return;
    logger.info({ pageId, writer, outcome: final }, 'Confluence carriers reconciled (#1953)');
    return;
  }
  if (report.outcome === 'none') return;
  const counted = report.outcome === 'recovered' || report.outcome === 'evaluated';
  logger.info({
    pageId,
    writer,
    outcome: report.outcome,
    ...(counted ? { recovered: report.recovered, skipped: report.skipped } : {}),
    ...(report.droppedLinkAttributes > 0 ? { droppedLinkAttributes: report.droppedLinkAttributes } : {}),
  }, 'Confluence carriers reconciled (#1953)');
}

/**
 * Y7 / D14.4: the evidence `content_revision` does not pin, read again in the reserving transaction after the
 * page lifecycle lock and before the intent is inserted or the page changed. A local modification or a
 * collaborative document that appeared since the row read answers the 409 a writer already gives when the row
 * moved under it (`stale_content_revision`, coordinator ruling A9); the transaction rolls back.
 */
export async function assertCarrierRecoveryEligible(client: PoolClient, pageId: number): Promise<void> {
  const result = await client.query<{ eligible: boolean }>(
    `SELECT p.local_modified_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM page_collaborative_docs d WHERE d.page_id = p.id) AS eligible
       FROM pages p
      WHERE p.id = $1`,
    [pageId],
  );
  if (result.rows[0]?.eligible !== true) {
    throw new PageWriteError(409, 'stale_content_revision', 'Page has been modified since you loaded it. Please refresh and try again.');
  }
}

/** Whether a reservation error is the 409 a recovered write logs as `stale`. */
export function isStaleCarrierReservation(error: unknown): boolean {
  return error instanceof PageWriteError && error.statusCode === 409;
}

/**
 * D9 R2: a collaborative Save over a room without the key for a kind the storage may carry proceeds as today; the
 * carriers the room does not hold are not written. Logged with kind names only.
 */
export function logCollabCarriersUnproven(pageId: number, storage: string | null, seeded: ReadonlySet<string>): void {
  const kinds = carrierKindsStorageMayCarry(storage).filter((kind) => !seeded.has(kind));
  if (kinds.length > 0) logger.info({ pageId, kinds }, 'collab.commit_carriers_unproven');
}

const CODE_META_ATTRIBUTES = ['data-title', 'data-macro-params'];

/**
 * §3.7 step 3 (Improve): the reconcile applied exactly `ops` and nothing else to the code blocks. `before` is the
 * HTML handed to the reconcile, `after` the HTML it returned. Every `codeBlockElements` index keeps its class, text
 * and structure; `data-title` / `data-macro-params` change only at an operation's ordinal, where `before` had
 * neither and `after` holds exactly the operation's values; every ordinal is a safe integer in range, none twice,
 * values `string | null` and not both null; no other `pre` changed. False is a refusal before any effect (§3.7
 * step 5); it is the guard against a defect, not an expected outcome.
 */
export function legacyCodeApplicationHolds(beforeHtml: string, afterHtml: string, ops: ReadonlyArray<LegacyCodeMetadataOp>): boolean {
  // Byte-identical HTML with no operation is the check's own answer: nothing applied, nothing to compare.
  if (ops.length === 0 && beforeHtml === afterHtml) return true;
  const parse = (html: string): HTMLElement => new JSDOM(`<body>${html}</body>`).window.document.body;
  const before = parse(beforeHtml);
  const after = parse(afterHtml);
  const beforeBlocks = codeBlockElements(before);
  const afterBlocks = codeBlockElements(after);
  if (beforeBlocks.length !== afterBlocks.length) return false;
  const byOrdinal = new Map<number, LegacyCodeMetadataOp>();
  const isValue = (value: unknown): boolean => value === null || typeof value === 'string';
  for (const op of ops) {
    if (!Number.isSafeInteger(op.ordinal) || op.ordinal < 0 || op.ordinal >= afterBlocks.length || byOrdinal.has(op.ordinal)) return false;
    if (!isValue(op.title) || !isValue(op.macroParams) || (op.title === null && op.macroParams === null)) return false;
    byOrdinal.set(op.ordinal, op);
  }
  const otherAttributes = (pre: Element): string => JSON.stringify([...pre.attributes]
    .filter((attr) => !CODE_META_ATTRIBUTES.includes(attr.name))
    .map((attr) => [attr.name, attr.value]));
  for (let index = 0; index < afterBlocks.length; index += 1) {
    const was = beforeBlocks[index]!;
    const now = afterBlocks[index]!;
    if (now.innerHTML !== was.innerHTML || otherAttributes(now) !== otherAttributes(was)) return false;
    const op = byOrdinal.get(index);
    if (op) {
      if (CODE_META_ATTRIBUTES.some((name) => was.hasAttribute(name))) return false;
      if (now.getAttribute('data-title') !== op.title || now.getAttribute('data-macro-params') !== op.macroParams) return false;
    } else if (CODE_META_ATTRIBUTES.some((name) => now.getAttribute(name) !== was.getAttribute(name))) {
      return false;
    }
  }
  const blocks = new Set<Element>(afterBlocks);
  const allBefore = [...before.querySelectorAll('pre')];
  const allAfter = [...after.querySelectorAll('pre')];
  if (allBefore.length !== allAfter.length) return false;
  return allAfter.every((pre, index) => blocks.has(pre) || pre.outerHTML === allBefore[index]!.outerHTML);
}
