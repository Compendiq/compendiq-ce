/**
 * Resumable `body_text` backfill (#1965, design r12).
 *
 * Rows written before #1735 hold the twice-decoded text of their own HTML.
 * This job finds copies whose stored text is exactly the frozen pre-#1940
 * derivation of their HTML and differs from the current one, and rewrites
 * them with the current derivation: `pages.body_text`, `pages.draft_body_text`
 * and `page_versions.body_text`, live and trashed pages alike.
 *
 * A page (with its history) is an *owner*, repaired as a whole in one
 * transaction or not at all (D11). Observation (Open, scan, body loads) runs
 * in short read-only transactions; every parse runs in a worker thread
 * (`body-text-backfill-parser.ts`); the closing transaction re-verifies
 * everything it relies on under the page-writer admission locks, the page row
 * `FOR UPDATE` and row locks on the history rows a writer could change, then
 * decides the whole-page refusals (witness, equal-text split, D9 unindexable,
 * D13 identity conflict) and writes all affected copies or none.
 *
 * Progress lives in one `admin_settings` row (`body_text_backfill_1735`)
 * whose owner/seq fence every state write. The job's own statements target
 * the three text columns only; triggers derive `tsv`, `content_revision`,
 * the operation resets and, on rows with a local edit, `local_modified_at`.
 */
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { getPool } from '../db/postgres.js';
import { logger } from '../utils/logger.js';
import {
  PARSER_WORKER_MARKER,
  sha256Hex,
  type PairInput,
  type PairResult,
} from './body-text-backfill-parser.js';
import {
  PageWriteError,
  lockPageLifecycle,
  lockPageWrites,
  withPageWriterOperation,
} from './page-write-admission.js';
import { livePageVersion } from './version-snapshot.js';

export const BODY_TEXT_BACKFILL_STATE_KEY = 'body_text_backfill_1735';
export const BODY_TEXT_BACKFILL_QUEUE = 'body-text-backfill';
export const BODY_TEXT_BACKFILL_INTERVAL_MS = 60 * 60 * 1000;
const LEGACY_FIRST_RUN_DELAY_MS = 30_000;

const MIB = 1024 * 1024;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Every bound of the job. Tests shrink some of them; production uses the defaults. */
export interface BodyTextBackfillLimits {
  /** D10: a column above this is never loaded. */
  ceilingBytes: number;
  /** D4: a column above this is parsed alone. */
  largeColumnBytes: number;
  /** Bodies per ordinary parser request. */
  windowBytes: number;
  /** Body bytes one statement may touch. */
  statementBytes: number;
  /** History rows per keyset read. */
  scanRows: number;
  /** D12: more copies to correct than this refuses the page. */
  maxAffectedCopies: number;
  /** D12: more corrected text than this refuses the page. */
  maxCorrectedBytes: number;
  requestTimeoutMs: number;
  handshakeTimeoutMs: number;
  heartbeatMs: number;
  leaseMs: number;
  transientListMax: number;
  lockTimeoutMs: number;
  statementTimeoutMs: number;
  transactionTimeoutMs: number;
  parserOldGenerationMb: number;
  parserYoungGenerationMb: number;
}

export const BODY_TEXT_BACKFILL_LIMITS: Readonly<BodyTextBackfillLimits> = Object.freeze({
  ceilingBytes: 32 * MIB,
  largeColumnBytes: 4 * MIB,
  windowBytes: 8 * MIB,
  statementBytes: 32 * MIB,
  scanRows: 1000,
  maxAffectedCopies: 200,
  maxCorrectedBytes: 64 * MIB,
  requestTimeoutMs: 240_000,
  handshakeTimeoutMs: 30_000,
  heartbeatMs: 60_000,
  leaseMs: 15 * 60 * 1000,
  transientListMax: 200,
  lockTimeoutMs: 5_000,
  statementTimeoutMs: 10_000,
  transactionTimeoutMs: 30_000,
  parserOldGenerationMb: 256,
  parserYoungGenerationMb: 32,
});

const SAMPLE_SIZE = 20;
const OVERFLOW_BACKOFF_START_MS = HOUR_MS;
const OVERFLOW_BACKOFF_MAX_MS = DAY_MS;
const FIRST_RECHECK_MS = DAY_MS;
const LATER_RECHECK_MS = 30 * DAY_MS;
const SUMMARY_MAX = 500;
const FIRST_UUID = '00000000-0000-0000-0000-000000000000';

/** The built-in pair a fresh parser must classify before any row is sent. */
const CANARY = {
  html: '<p>&amp;lt;br&amp;gt;</p>',
  text: '<br>',
  corrected: '&lt;br&gt;',
};

// ─── Counters ────────────────────────────────────────────────────────────────

const COPY_REASONS = [
  'repaired', 'current', 'diverged', 'no_ampersand', 'no_text', 'oversized', 'unevaluable',
  'frozen', 'baseline_referenced', 'paired_exempt', 'identity_conflict', 'unindexable',
] as const;
const OWNER_COUNTERS = ['owners', 'gone', 'busy', 'changed', 'page_too_large'] as const;
const COUNTERS = [...COPY_REASONS, ...OWNER_COUNTERS] as const;
export type BodyTextBackfillCounter = typeof COUNTERS[number];
type Counts = Partial<Record<BodyTextBackfillCounter, number>>;

function addCounts(target: Counts, delta: Counts): void {
  for (const [key, value] of Object.entries(delta) as [BodyTextBackfillCounter, number][]) {
    if (value) target[key] = (target[key] ?? 0) + value;
  }
}

// ─── State document ──────────────────────────────────────────────────────────

const isoTimestamp = z.string().refine((value) => !Number.isNaN(Date.parse(value)));
const pageId = z.number().int().positive().max(2_147_483_647);
const counterRecord = z.partialRecord(z.enum(COUNTERS), z.number().int().nonnegative());

const StateSchema = z.object({
  v: z.literal(1),
  status: z.enum(['new', 'idle', 'running', 'waiting', 'done']),
  owner: z.uuid().nullable(),
  lastOwner: z.uuid().nullable(),
  seq: z.number().int().nonnegative(),
  pass: z.number().int().nonnegative(),
  passStartedAt: isoTimestamp.nullable(),
  highWater: z.number().int().nonnegative(),
  phase: z.enum(['scan', 'retry']),
  cursor: z.number().int().nonnegative(),
  unresolved: z.object({
    ids: z.array(pageId),
    overflow: z.boolean(),
    count: z.number().int().nonnegative(),
    sample: z.array(pageId).max(SAMPLE_SIZE),
  }).strict(),
  tooLarge: z.number().int().nonnegative(),
  nextFullPassAfter: isoTimestamp.nullable(),
  overflowBackoffMs: z.number().int().positive().nullable(),
  firstCompletedAt: isoTimestamp.nullable(),
  completedAt: isoTimestamp.nullable(),
  passTotals: counterRecord,
  totals: counterRecord,
}).strict();

export type BodyTextBackfillState = z.infer<typeof StateSchema>;

function initialState(): BodyTextBackfillState {
  return {
    v: 1, status: 'new', owner: null, lastOwner: null, seq: 0, pass: 0, passStartedAt: null,
    highWater: 0, phase: 'scan', cursor: 0,
    unresolved: { ids: [], overflow: false, count: 0, sample: [] },
    tooLarge: 0, nextFullPassAfter: null, overflowBackoffMs: null,
    firstCompletedAt: null, completedAt: null, passTotals: {}, totals: {},
  };
}

function parseState(raw: string): BodyTextBackfillState {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new BodyTextBackfillError('state_invalid', 'state', null);
  }
  const parsed = StateSchema.safeParse(json);
  if (!parsed.success) throw new BodyTextBackfillError('state_invalid', 'state', null);
  return parsed.data;
}

// ─── Errors ──────────────────────────────────────────────────────────────────

/** The only error that leaves the job: a fixed code, the phase and the owner id. */
export class BodyTextBackfillError extends Error {
  readonly code: string;
  readonly phase: string;
  readonly ownerId: number | null;

  constructor(code: string, phase: string, ownerId: number | null) {
    super(`body_text backfill ${code} (phase ${phase}, owner ${ownerId ?? '-'})`);
    this.name = 'BodyTextBackfillError';
    this.code = code;
    this.phase = phase;
    this.ownerId = ownerId;
  }
}

/** The stop latch tripped; the run ends `interrupted` without counting anything in flight. */
class StopSignal extends Error {
  override readonly name = 'StopSignal';
}

/** A run failure: the run ends `interrupted` with a fixed code; nothing in flight is counted. */
class RunInterrupted extends Error {
  override readonly name = 'RunInterrupted';

  constructor(readonly code: string) {
    super(code);
  }
}

/** A connection-level failure: the outcome of the open transaction is unknown to the client. */
class ConnectionLost extends Error {
  override readonly name = 'ConnectionLost';
}

/** Outcome of one owner that does not close it. */
class OwnerUnresolved extends Error {
  override readonly name = 'OwnerUnresolved';

  constructor(readonly reason: 'busy' | 'changed' | 'gone' | 'page_too_large') {
    super(reason);
  }
}

function sqlState(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
}

/** A refusal by a deadline or lock wait: transient, the owner is `busy`. */
function isBusyState(state: string | undefined): boolean {
  return state === '55P03' || state === '57014' || state === '40P01' || state === '40001';
}

/**
 * The session is gone (terminated backend, transaction deadline, network):
 * the connection is unusable and the outcome of its open transaction unknown
 * to the client. pg network failures carry no SQLSTATE.
 */
function isConnectionError(error: unknown): boolean {
  const state = sqlState(error);
  if (state) return state.startsWith('08') || state.startsWith('57P') || state === '25P04';
  if (!(error instanceof Error) || error.name !== 'Error') return false;
  const code = (error as NodeJS.ErrnoException).code;
  return /Connection terminated|terminated unexpectedly|Client has encountered a connection error/i.test(error.message)
    || code === 'ECONNRESET' || code === 'EPIPE';
}

// ─── Options, hooks, summary ─────────────────────────────────────────────────

export type BodyTextBackfillStep = 'claim' | 'heartbeat' | 'close' | 'fenced_close' | 'checkpoint' | 'release';

export interface BodyTextBackfillHooks {
  atOpen?(ownerId: number): Promise<void> | void;
  afterScan?(ownerId: number, info: { affected: number }): Promise<void> | void;
  beforeAdmission?(ownerId: number, client: PoolClient): Promise<void> | void;
  afterAdmission?(ownerId: number, client: PoolClient): Promise<void> | void;
  afterPageLock?(ownerId: number, client: PoolClient): Promise<void> | void;
  afterDrain?(ownerId: number, client: PoolClient): Promise<void> | void;
  afterMembersLocked?(ownerId: number, client: PoolClient): Promise<void> | void;
  afterDecision?(ownerId: number, client: PoolClient, decision: string): Promise<void> | void;
  beforeCommit?(step: BodyTextBackfillStep, ownerId: number | null, client: PoolClient): Promise<void> | void;
  /** Runs after COMMIT returned. Throwing simulates a lost acknowledgment. */
  afterCommit?(step: BodyTextBackfillStep, ownerId: number | null): Promise<void> | void;
  beforeParserRequest?(ownerId: number, keys: string[]): Promise<void> | void;
  /** Every statement that touches body bytes, with the bytes it may touch. */
  onStatement?(info: { kind: string; ownerId: number; bytes: number }): void;
  /** Every pair handed to the parser. */
  onLoad?(info: { ownerId: number; key: string; htmlBytes: number; textBytes: number }): void;
}

export interface BodyTextBackfillOptions {
  /** Start a fresh full pass now (test/scheduler option). */
  restart?: boolean;
  hooks?: BodyTextBackfillHooks;
  limits?: Partial<BodyTextBackfillLimits>;
  /** Test seam: another worker entry (a `data:` URL or a file). */
  parserEntry?: URL;
}

export type BodyTextBackfillOutcome =
  | 'already_running' | 'already_completed' | 'waiting' | 'idle' | 'retry' | 'done' | 'interrupted';

export interface BodyTextBackfillSummary {
  outcome: BodyTextBackfillOutcome;
  runId: string;
  pass: number;
  phase: 'scan' | 'retry';
  /** Counter deltas committed by this run. */
  counts: Counts;
  bytesLoaded: number;
  interruptCode?: string;
}

// ─── Module state (stop latch, in-flight run, legacy timers) ─────────────────

let stopLatched = false;
let activeRun: Promise<BodyTextBackfillSummary> | null = null;
let activeParser: BodyTextBackfillParser | null = null;
let legacyFirstTimer: NodeJS.Timeout | null = null;
let legacyInterval: NodeJS.Timeout | null = null;

// ─── Parser worker client ────────────────────────────────────────────────────

class ParserFailure extends Error {
  override readonly name = 'ParserFailure';
}

/** The compiled job loads the compiled worker; source runs (tsx, vitest) load the TypeScript entry. */
export function bodyTextBackfillParserEntry(): URL {
  const self = import.meta.url;
  return new URL(self.endsWith('.ts') ? './body-text-backfill-parser.ts' : './body-text-backfill-parser.js', self);
}

type Waiter = { resolve: (message: unknown) => void; reject: (error: Error) => void };

/**
 * The job's side of the parser worker (§4): a fresh worker must post
 * `ready` and classify the canary pair before any row is sent; one request
 * at a time; a failed request discards the worker.
 */
export class BodyTextBackfillParser {
  private worker: Worker | null = null;
  private healthy = false;
  private waiter: Waiter | null = null;
  private protocolBroken = false;
  private nextRequestId = 1;

  constructor(
    private readonly limits: BodyTextBackfillLimits,
    private readonly entry: URL = bodyTextBackfillParserEntry(),
  ) {}

  terminate(): void {
    const worker = this.worker;
    this.worker = null;
    this.healthy = false;
    this.waiter?.reject(new ParserFailure('terminated'));
    this.waiter = null;
    if (worker) void worker.terminate().catch(() => undefined);
  }

  private spawn(): Worker {
    const typescript = this.entry.protocol === 'file:' && this.entry.pathname.endsWith('.ts');
    const worker = new Worker(this.entry, {
      workerData: { marker: PARSER_WORKER_MARKER },
      resourceLimits: {
        maxOldGenerationSizeMb: this.limits.parserOldGenerationMb,
        maxYoungGenerationSizeMb: this.limits.parserYoungGenerationMb,
      },
      // Source runs (tsx dev, vitest) load the TypeScript entry through tsx;
      // the compiled entry next to the compiled job needs nothing.
      ...(typescript ? { execArgv: ['--import', 'tsx'] } : {}),
    });
    worker.on('message', (message: unknown) => {
      if (worker !== this.worker) return;
      const waiter = this.waiter;
      if (!waiter) {
        this.protocolBroken = true;
        return;
      }
      this.waiter = null;
      waiter.resolve(message);
    });
    const fail = () => {
      if (worker !== this.worker) return;
      this.healthy = false;
      this.worker = null;
      const waiter = this.waiter;
      this.waiter = null;
      waiter?.reject(new ParserFailure('worker_failed'));
    };
    worker.on('messageerror', () => {
      this.protocolBroken = true;
      fail();
    });
    worker.on('error', fail);
    worker.on('exit', fail);
    return worker;
  }

  private next(timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.waiter === waiter) this.waiter = null;
        reject(new ParserFailure('timeout'));
      }, timeoutMs);
      const waiter: Waiter = {
        resolve: (message) => { clearTimeout(timer); resolve(message); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      };
      this.waiter = waiter;
    });
  }

  private assertUsable(): void {
    if (stopLatched) throw new StopSignal();
    if (this.protocolBroken) throw new RunInterrupted('parser_protocol');
  }

  /** Start a worker, wait for `ready`, then prove it with the canary pair. */
  private async handshake(): Promise<void> {
    this.terminate();
    this.assertUsable();
    try {
      this.worker = this.spawn();
    } catch {
      throw new RunInterrupted('parser_unavailable');
    }
    try {
      const ready = await this.next(this.limits.handshakeTimeoutMs);
      this.assertUsable();
      if ((ready as { type?: unknown } | null)?.type !== 'ready') throw new RunInterrupted('parser_protocol');
      const requestId = this.nextRequestId++;
      this.worker!.postMessage({
        type: 'classify', requestId, pairs: [{ key: 'canary', html: CANARY.html, text: CANARY.text }],
      });
      const answer = await this.next(this.limits.handshakeTimeoutMs);
      this.assertUsable();
      const results = this.readResults(answer, requestId, ['canary']);
      const canary = results[0];
      if (
        canary?.outcome !== 'affected' || canary.corrected !== CANARY.corrected
        || canary.htmlSha256 !== sha256Hex(CANARY.html) || canary.textSha256 !== sha256Hex(CANARY.text)
      ) {
        throw new RunInterrupted('parser_unavailable');
      }
      this.healthy = true;
    } catch (error) {
      this.terminate();
      if (stopLatched) throw new StopSignal();
      if (error instanceof RunInterrupted || error instanceof StopSignal) throw error;
      throw new RunInterrupted('parser_unavailable');
    }
  }

  private readResults(message: unknown, requestId: number, keys: readonly string[]): PairResult[] {
    const answer = message as { type?: unknown; requestId?: unknown; results?: unknown } | null;
    if (
      !answer || answer.type !== 'result' || answer.requestId !== requestId
      || !Array.isArray(answer.results) || answer.results.length !== keys.length
    ) {
      throw new RunInterrupted('parser_protocol');
    }
    const results = answer.results as PairResult[];
    results.forEach((result, index) => {
      const valid = result && result.key === keys[index] && (
        result.outcome === 'current' || result.outcome === 'diverged' || result.outcome === 'unevaluable'
        || (result.outcome === 'affected' && typeof result.corrected === 'string'
          && /^[a-f0-9]{64}$/.test(result.htmlSha256) && /^[a-f0-9]{64}$/.test(result.textSha256))
      );
      if (!valid) throw new RunInterrupted('parser_protocol');
    });
    return results;
  }

  /**
   * One request. `null` = the request failed (time limit, crash, memory
   * limit) on a worker that had passed the canary; the worker is gone and
   * the next request starts and proves a new one.
   */
  async classify(pairs: PairInput[]): Promise<PairResult[] | null> {
    this.assertUsable();
    if (!this.healthy || !this.worker) await this.handshake();
    const requestId = this.nextRequestId++;
    const keys = pairs.map((pair) => pair.key);
    const response = this.next(this.limits.requestTimeoutMs);
    this.worker!.postMessage({ type: 'classify', requestId, pairs });
    let message: unknown;
    try {
      message = await response;
    } catch (error) {
      this.terminate();
      if (stopLatched) throw new StopSignal();
      if (this.protocolBroken) throw new RunInterrupted('parser_protocol');
      if (error instanceof ParserFailure) return null;
      throw error;
    }
    this.assertUsable();
    return this.readResults(message, requestId, keys);
  }
}

// ─── Transactions ────────────────────────────────────────────────────────────

type TxMode = 'read_committed' | 'snapshot_read_only' | 'read_only';

interface RunContext {
  runId: string;
  seq: number;
  doc: BodyTextBackfillState;
  limits: BodyTextBackfillLimits;
  hooks: BodyTextBackfillHooks;
  pgVersion: number;
  lastStateWriteAt: number;
  parser: BodyTextBackfillParser;
  counts: Counts;
  bytesLoaded: number;
}

function assertInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid limit');
  return value;
}

async function beginTx(client: PoolClient, mode: TxMode, limits: BodyTextBackfillLimits, pgVersion: number): Promise<void> {
  const head = mode === 'read_committed'
    ? 'BEGIN ISOLATION LEVEL READ COMMITTED'
    : mode === 'snapshot_read_only'
      ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'
      : 'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY';
  const parts = [
    head,
    `SET LOCAL lock_timeout = '${assertInteger(limits.lockTimeoutMs)}ms'`,
    `SET LOCAL statement_timeout = '${assertInteger(limits.statementTimeoutMs)}ms'`,
  ];
  if (pgVersion >= 170000) {
    parts.push(`SET LOCAL transaction_timeout = '${assertInteger(limits.transactionTimeoutMs)}ms'`);
  }
  await client.query(parts.join('; '));
}

/**
 * A checked-out client whose connection errors are recorded instead of
 * escaping as process events, released with `discard` when broken.
 */
async function withClient<T>(operation: (client: PoolClient, broken: () => boolean) => Promise<T>): Promise<T> {
  let client: PoolClient;
  try {
    client = await getPool().connect();
  } catch {
    throw new OwnerUnresolved('busy');
  }
  let discard: Error | undefined;
  const onError = (error: Error) => { discard = error; };
  client.on('error', onError);
  try {
    return await operation(client, () => discard !== undefined);
  } catch (error) {
    if (!discard && isConnectionError(error)) {
      discard = error instanceof Error ? error : new Error('connection');
    }
    throw error;
  } finally {
    client.off('error', onError);
    client.release(discard);
  }
}

/** One read-only observation statement in its own short transaction. */
async function observe<T extends Record<string, unknown>>(
  ctx: RunContext, mode: 'snapshot_read_only' | 'read_only', sql: string, params: unknown[],
): Promise<T[]> {
  await tick(ctx);
  try {
    return await withClient(async (client) => {
      await beginTx(client, mode, ctx.limits, ctx.pgVersion);
      try {
        const result = await client.query<T>(sql, params);
        await client.query('COMMIT');
        return result.rows;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    });
  } catch (error) {
    if (error instanceof OwnerUnresolved || error instanceof StopSignal || error instanceof RunInterrupted) throw error;
    // Observation commits nothing: a deadline, lock wait or lost connection
    // leaves the owner for a later attempt from Open.
    if (isBusyState(sqlState(error)) || isConnectionError(error)) throw new OwnerUnresolved('busy');
    throw error;
  }
}

interface LockedState {
  doc: BodyTextBackfillState;
  now: Date;
  updatedAt: Date;
}

async function readStateForUpdate(client: PoolClient): Promise<LockedState | null> {
  const result = await client.query<{ setting_value: string; updated_at: Date; now: Date }>(
    `SELECT setting_value, updated_at, NOW() AS now FROM admin_settings WHERE setting_key = $1 FOR UPDATE`,
    [BODY_TEXT_BACKFILL_STATE_KEY],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { doc: parseState(row.setting_value), now: row.now, updatedAt: row.updated_at };
}

async function writeState(client: PoolClient, doc: BodyTextBackfillState): Promise<void> {
  await client.query(
    `UPDATE admin_settings SET setting_value = $2, updated_at = NOW() WHERE setting_key = $1`,
    [BODY_TEXT_BACKFILL_STATE_KEY, JSON.stringify(StateSchema.parse(doc))],
  );
}

/** Read the state row `FOR UPDATE` and prove this run still owns it at `ctx.seq`. */
async function lockOwnState(ctx: RunContext, client: PoolClient): Promise<LockedState> {
  let state: LockedState | null;
  try {
    state = await readStateForUpdate(client);
  } catch (error) {
    if (error instanceof BodyTextBackfillError) throw error;
    if (isBusyState(sqlState(error))) throw new RunInterrupted('state_timeout');
    throw error;
  }
  if (!state || state.doc.owner !== ctx.runId || state.doc.seq !== ctx.seq) throw new RunInterrupted('ownership_lost');
  return state;
}

/** Reconciliation read: writes nothing. 'committed' | 'not_committed'; anything else stops the run. */
async function reconcile(ctx: RunContext, expected: { owner: string | null; seq: number }): Promise<'committed' | 'not_committed'> {
  try {
    return await withClient(async (client) => {
      await beginTx(client, 'read_committed', ctx.limits, ctx.pgVersion);
      try {
        const state = await readStateForUpdate(client);
        await client.query('ROLLBACK');
        if (!state) throw new RunInterrupted('ownership_lost');
        const { doc } = state;
        if (doc.seq === expected.seq && doc.owner === expected.owner
          && (expected.owner !== null || doc.lastOwner === ctx.runId)) return 'committed';
        if (doc.owner === ctx.runId && doc.seq === ctx.seq) return 'not_committed';
        throw new RunInterrupted('ownership_lost');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    });
  } catch (error) {
    if (error instanceof RunInterrupted || error instanceof BodyTextBackfillError) throw error;
    throw new RunInterrupted('reconciliation_failed');
  }
}

interface FencedResult {
  doc: BodyTextBackfillState;
  /** Counter deltas the step commits (reported only once it is known committed). */
  delta: Counts;
}

/**
 * A fenced transaction (§7): `admit` (the close's page-writer admission)
 * runs first, then the state row `FOR UPDATE` with ownership at `ctx.seq`,
 * then `body`, then `seq + 1` is written with its data and committed.
 * A connection-level failure anywhere (a transaction deadline ends the
 * session) is settled by the reconciliation read first: a step found
 * committed is applied, never redone; one found not committed is `busy`.
 */
async function fencedTransaction(
  ctx: RunContext, step: BodyTextBackfillStep, ownerId: number | null,
  body: (client: PoolClient, state: LockedState) => Promise<FencedResult>,
  admit?: (client: PoolClient) => Promise<void>,
): Promise<FencedResult> {
  const pending: { result?: FencedResult } = {};
  const apply = (result: FencedResult): FencedResult => {
    ctx.seq = result.doc.seq;
    ctx.doc = result.doc;
    ctx.lastStateWriteAt = Date.now();
    return result;
  };
  try {
    return apply(await withClient(async (client, broken) => {
      try {
        await beginTx(client, 'read_committed', ctx.limits, ctx.pgVersion);
        await admit?.(client);
        const state = await lockOwnState(ctx, client);
        const { doc, delta } = await body(client, state);
        const next = { ...doc, seq: ctx.seq + 1 };
        try {
          await writeState(client, next);
        } catch (error) {
          if (isBusyState(sqlState(error))) throw new RunInterrupted('state_timeout');
          throw error;
        }
        pending.result = { doc: next, delta };
        if (broken()) throw new ConnectionLost('broken');
        await ctx.hooks.beforeCommit?.(step, ownerId, client);
        try {
          await client.query('COMMIT');
        } catch (error) {
          if (!isConnectionError(error)) throw error;
          throw new ConnectionLost('commit');
        }
        try {
          await ctx.hooks.afterCommit?.(step, ownerId);
        } catch {
          throw new ConnectionLost('acknowledgment');
        }
        return pending.result;
      } catch (error) {
        if (error instanceof ConnectionLost || broken() || isConnectionError(error)) {
          throw error instanceof ConnectionLost ? error : new ConnectionLost('statement');
        }
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    }));
  } catch (error) {
    if (!(error instanceof ConnectionLost)) throw error;
    const outcome = await reconcile(ctx, { owner: step === 'release' ? null : ctx.runId, seq: ctx.seq + 1 });
    if (outcome === 'committed' && pending.result) return apply(pending.result);
    if (outcome === 'committed') throw new RunInterrupted('reconciliation_failed');
    throw new OwnerUnresolved('busy');
  }
}

/** Between statements and parser requests: stop latch, then the lease heartbeat. */
async function tick(ctx: RunContext): Promise<void> {
  if (stopLatched) throw new StopSignal();
  if (Date.now() - ctx.lastStateWriteAt < ctx.limits.heartbeatMs) return;
  try {
    await fencedTransaction(ctx, 'heartbeat', null, async (_client, { doc }) => ({ doc, delta: {} }));
  } catch (error) {
    if (error instanceof OwnerUnresolved) throw new RunInterrupted('state_timeout');
    throw error;
  }
}

// ─── Owner observation ───────────────────────────────────────────────────────

type Column = 'published' | 'draft';
type CopyRef = { kind: 'page'; column: Column } | { kind: 'version'; id: string };

interface Affected {
  key: string;
  ref: CopyRef;
  htmlBytes: number;
  textBytes: number;
  htmlSha256: string;
  textSha256: string;
  corrected: string;
  correctedBytes: number;
}

interface Opened {
  pageId: number;
  c0: string;
  l0: string;
  version: number;
  frozen: boolean;
  cols: Record<Column, { htmlBytes: number | null; textBytes: number | null }>;
}

interface Observation {
  opened: Opened;
  affected: Affected[];
  correctedBytes: number;
  counts: Counts;
}

interface PendingPair {
  key: string;
  ref: CopyRef;
  htmlBytes: number;
  textBytes: number;
}

const PAGE_COLUMNS: Record<Column, { html: string; text: string }> = {
  published: { html: 'body_html', text: 'body_text' },
  draft: { html: 'draft_body_html', text: 'draft_body_text' },
};

function keyFor(ref: CopyRef): string {
  return ref.kind === 'page' ? `${ref.column === 'published' ? 'p' : 'd'}:` : `v:${ref.id}`;
}

function versionId(ref: CopyRef): string {
  if (ref.kind !== 'version') throw new Error('not a history copy');
  return ref.id;
}

function pageColumn(ref: CopyRef): Column {
  if (ref.kind !== 'page') throw new Error('not a page copy');
  return ref.column;
}

function count(counts: Counts, reason: BodyTextBackfillCounter, by = 1): void {
  counts[reason] = (counts[reason] ?? 0) + by;
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function logResidual(ctx: RunContext, ownerId: number, reason: string, detail: Record<string, unknown>): void {
  logger.warn(
    { job: 'body_text_backfill', pass: ctx.doc.pass, pageId: ownerId, reason, ...detail },
    'body_text backfill residual',
  );
}

async function open(ctx: RunContext, ownerId: number): Promise<Opened | null> {
  await ctx.hooks.atOpen?.(ownerId);
  const rows = await observe<{
    c: string; l: string; version: number; frozen: boolean;
    phl: string | null; ptl: string | null; dhl: string | null; dtl: string | null;
  }>(ctx, 'snapshot_read_only',
    `SELECT content_revision::text AS c, lifecycle_revision::text AS l, version, baseline_id IS NOT NULL AS frozen,
            octet_length(body_html) AS phl, octet_length(body_text) AS ptl,
            octet_length(draft_body_html) AS dhl, octet_length(draft_body_text) AS dtl
       FROM pages WHERE id = $1`,
    [ownerId]);
  const row = rows[0];
  if (!row) return null;
  return {
    pageId: ownerId, c0: row.c, l0: row.l, version: row.version, frozen: row.frozen,
    cols: {
      published: { htmlBytes: toNumber(row.phl), textBytes: toNumber(row.ptl) },
      draft: { htmlBytes: toNumber(row.dhl), textBytes: toNumber(row.dtl) },
    },
  };
}

/** Group items into consecutive budgets; an item larger than the budget stands alone. */
function budgeted<T>(items: readonly T[], size: (item: T) => number, budget: number): T[][] {
  const groups: T[][] = [];
  let current: T[] = [];
  let used = 0;
  for (const item of items) {
    const bytes = size(item);
    if (current.length > 0 && used + bytes > budget) {
      groups.push(current);
      current = [];
      used = 0;
    }
    current.push(item);
    used += bytes;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

class OwnerScan {
  readonly affected: Affected[] = [];
  correctedBytes = 0;
  readonly counts: Counts = {};
  private readonly queue: PendingPair[] = [];
  private queuedBytes = 0;

  constructor(private readonly ctx: RunContext, readonly opened: Opened) {}

  private get ownerId(): number {
    return this.opened.pageId;
  }

  /** D12 is checked as A grows; exceeding it ends the scan. */
  private admit(affected: Affected): void {
    this.affected.push(affected);
    this.correctedBytes += affected.correctedBytes;
    if (
      this.affected.length > this.ctx.limits.maxAffectedCopies
      || this.correctedBytes > this.ctx.limits.maxCorrectedBytes
    ) {
      throw new OwnerUnresolved('page_too_large');
    }
  }

  private isLarge(pair: PendingPair): boolean {
    return pair.htmlBytes > this.ctx.limits.largeColumnBytes || pair.textBytes > this.ctx.limits.largeColumnBytes;
  }

  async enqueue(pair: PendingPair): Promise<void> {
    if (this.isLarge(pair)) {
      await this.classifyWindow([pair], true);
      return;
    }
    const bytes = pair.htmlBytes + pair.textBytes;
    if (this.queue.length > 0 && this.queuedBytes + bytes > this.ctx.limits.windowBytes) await this.flush();
    this.queue.push(pair);
    this.queuedBytes += bytes;
  }

  async flush(): Promise<void> {
    if (this.queue.length === 0) return;
    const window = this.queue.splice(0, this.queue.length);
    this.queuedBytes = 0;
    await this.classifyWindow(window, false);
  }

  private statement(kind: string, bytes: number): void {
    this.ctx.hooks.onStatement?.({ kind, ownerId: this.ownerId, bytes });
  }

  /** Load the bodies of `pairs` under their SQL contract; a pair that no longer matches makes the owner `changed`. */
  private async load(pairs: PendingPair[]): Promise<PairInput[]> {
    const loaded = new Map<string, PairInput>();
    const pagePairs = pairs.filter((pair) => pair.ref.kind === 'page');
    const versionPairs = pairs.filter((pair) => pair.ref.kind === 'version');
    for (const pair of pagePairs) {
      const column = PAGE_COLUMNS[pageColumn(pair.ref)];
      const parts: ('html' | 'text')[][] = pair.htmlBytes + pair.textBytes <= this.ctx.limits.statementBytes
        ? [['html', 'text']]
        : [['html'], ['text']];
      const input: PairInput = { key: pair.key, html: '', text: '' };
      for (const part of parts) {
        this.statement('load_page', part.reduce((sum, p) => sum + (p === 'html' ? pair.htmlBytes : pair.textBytes), 0));
        const rows = await observe<{ html: string | null; text: string | null }>(this.ctx, 'read_only',
          `SELECT ${part.includes('html') ? column.html : 'NULL::text'} AS html,
                  ${part.includes('text') ? column.text : 'NULL::text'} AS text
             FROM pages
            WHERE id = $1 AND baseline_id IS NULL
              AND octet_length(${column.html}) = $2 AND octet_length(${column.text}) = $3
              AND $2 <= $4 AND $3 <= $4`,
          [this.ownerId, pair.htmlBytes, pair.textBytes, this.ctx.limits.ceilingBytes]);
        const row = rows[0];
        if (!row) throw new OwnerUnresolved('changed');
        if (part.includes('html')) input.html = row.html ?? '';
        if (part.includes('text')) input.text = row.text ?? '';
      }
      loaded.set(pair.key, input);
    }
    const singles = versionPairs.filter((pair) => pair.htmlBytes + pair.textBytes > this.ctx.limits.statementBytes);
    const batched = versionPairs.filter((pair) => pair.htmlBytes + pair.textBytes <= this.ctx.limits.statementBytes);
    for (const group of budgeted(batched, (pair) => pair.htmlBytes + pair.textBytes, this.ctx.limits.statementBytes)) {
      await this.loadVersions(group, ['html', 'text'], loaded);
    }
    for (const pair of singles) {
      await this.loadVersions([pair], ['html'], loaded);
      await this.loadVersions([pair], ['text'], loaded);
    }
    return pairs.map((pair) => {
      const input = loaded.get(pair.key);
      if (!input) throw new OwnerUnresolved('changed');
      return input;
    });
  }

  private async loadVersions(group: PendingPair[], parts: ('html' | 'text')[], loaded: Map<string, PairInput>): Promise<void> {
    this.statement('load_versions', group.reduce((sum, pair) => sum
      + (parts.includes('html') ? pair.htmlBytes : 0) + (parts.includes('text') ? pair.textBytes : 0), 0));
    const ids = group.map((pair) => versionId(pair.ref));
    const rows = await observe<{ id: string; html: string | null; text: string | null }>(this.ctx, 'read_only',
      `SELECT pv.id::text AS id,
              ${parts.includes('html') ? 'pv.body_html' : 'NULL::text'} AS html,
              ${parts.includes('text') ? 'pv.body_text' : 'NULL::text'} AS text
         FROM unnest($1::uuid[], $2::bigint[], $3::bigint[]) AS e(id, hl, tl)
         JOIN page_versions pv ON pv.id = e.id
        WHERE pv.page_id = $4
          AND octet_length(pv.body_html) = e.hl AND octet_length(pv.body_text) = e.tl
          AND e.hl <= $5 AND e.tl <= $5
          AND NOT EXISTS (SELECT 1 FROM page_baselines b WHERE b.version_snapshot_id = pv.id)`,
      [ids, group.map((pair) => pair.htmlBytes), group.map((pair) => pair.textBytes), this.ownerId,
        this.ctx.limits.ceilingBytes]);
    if (rows.length !== group.length) throw new OwnerUnresolved('changed');
    for (const row of rows) {
      const key = `v:${row.id}`;
      const input = loaded.get(key) ?? { key, html: '', text: '' };
      if (parts.includes('html')) input.html = row.html ?? '';
      if (parts.includes('text')) input.text = row.text ?? '';
      loaded.set(key, input);
    }
  }

  private async classifyWindow(window: PendingPair[], large: boolean): Promise<void> {
    const inputs = await this.load(window);
    for (const pair of window) {
      this.ctx.bytesLoaded += pair.htmlBytes + pair.textBytes;
      this.ctx.hooks.onLoad?.({ ownerId: this.ownerId, key: pair.key, htmlBytes: pair.htmlBytes, textBytes: pair.textBytes });
    }
    await tick(this.ctx);
    await this.ctx.hooks.beforeParserRequest?.(this.ownerId, window.map((pair) => pair.key));
    const results = await this.ctx.parser.classify(inputs);
    if (results) {
      this.record(window, results);
      return;
    }
    if (large || window.length === 1) {
      this.unevaluable(window[0]!);
      return;
    }
    // Retry the same pairs one per request; a pair that fails alone on a
    // healthy worker is unevaluable.
    for (let index = 0; index < window.length; index += 1) {
      const pair = window[index]!;
      await tick(this.ctx);
      await this.ctx.hooks.beforeParserRequest?.(this.ownerId, [pair.key]);
      const single = await this.ctx.parser.classify([inputs[index]!]);
      if (single) this.record([pair], single);
      else this.unevaluable(pair);
    }
  }

  private unevaluable(pair: PendingPair): void {
    count(this.counts, 'unevaluable');
    logResidual(this.ctx, this.ownerId, 'unevaluable', describeCopy(pair));
  }

  private record(window: PendingPair[], results: PairResult[]): void {
    results.forEach((result, index) => {
      const pair = window[index]!;
      if (result.outcome === 'affected') {
        this.admit({
          key: pair.key, ref: pair.ref, htmlBytes: pair.htmlBytes, textBytes: pair.textBytes,
          htmlSha256: result.htmlSha256, textSha256: result.textSha256,
          corrected: result.corrected, correctedBytes: Buffer.byteLength(result.corrected, 'utf8'),
        });
      } else if (result.outcome === 'unevaluable') {
        this.unevaluable(pair);
      } else {
        count(this.counts, result.outcome);
      }
    });
  }

  /** Page columns: no_text → frozen → oversized → `&` flag → parser. */
  async scanPage(): Promise<void> {
    const candidates: PendingPair[] = [];
    for (const column of ['published', 'draft'] as const) {
      const { htmlBytes, textBytes } = this.opened.cols[column];
      if (htmlBytes === null || textBytes === null) {
        count(this.counts, 'no_text');
      } else if (this.opened.frozen) {
        count(this.counts, 'frozen');
      } else if (htmlBytes > this.ctx.limits.ceilingBytes || textBytes > this.ctx.limits.ceilingBytes) {
        count(this.counts, 'oversized');
        logResidual(this.ctx, this.ownerId, 'oversized', { column, htmlBytes, textBytes });
      } else {
        candidates.push({ key: keyFor({ kind: 'page', column }), ref: { kind: 'page', column }, htmlBytes, textBytes });
      }
    }
    if (candidates.length === 0) return;
    const flags = new Map<string, boolean>();
    for (const group of budgeted(candidates, (pair) => pair.htmlBytes, this.ctx.limits.statementBytes)) {
      const want = (column: Column) => group.find((pair) => pageColumn(pair.ref) === column);
      const published = want('published');
      const draft = want('draft');
      this.statement('ampersand_page', group.reduce((sum, pair) => sum + pair.htmlBytes, 0));
      const rows = await observe<{ p: boolean | null; d: boolean | null }>(this.ctx, 'read_only',
        `SELECT CASE WHEN $2::bigint IS NOT NULL AND octet_length(body_html) = $2 THEN strpos(body_html, '&') > 0 END AS p,
                CASE WHEN $3::bigint IS NOT NULL AND octet_length(draft_body_html) = $3
                     THEN strpos(draft_body_html, '&') > 0 END AS d
           FROM pages WHERE id = $1`,
        [this.ownerId, published?.htmlBytes ?? null, draft?.htmlBytes ?? null]);
      const row = rows[0];
      if (!row) throw new OwnerUnresolved('changed');
      if (published) {
        if (row.p === null) throw new OwnerUnresolved('changed');
        flags.set(published.key, row.p);
      }
      if (draft) {
        if (row.d === null) throw new OwnerUnresolved('changed');
        flags.set(draft.key, row.d);
      }
    }
    for (const pair of candidates) {
      if (flags.get(pair.key)) await this.enqueue(pair);
      else count(this.counts, 'no_ampersand');
    }
  }

  /** History: keyset reads of ids, lengths and the link flag; no body access. */
  async scanHistory(): Promise<void> {
    let after = FIRST_UUID;
    for (;;) {
      const rows = await observe<{ id: string; hl: string | null; tl: string | null; linked: boolean }>(this.ctx, 'read_only',
        `SELECT pv.id::text AS id, octet_length(pv.body_html) AS hl, octet_length(pv.body_text) AS tl,
                EXISTS (SELECT 1 FROM page_baselines b WHERE b.version_snapshot_id = pv.id) AS linked
           FROM page_versions pv
          WHERE pv.page_id = $1 AND pv.id > $2::uuid
          ORDER BY pv.id
          LIMIT $3`,
        [this.ownerId, after, this.ctx.limits.scanRows]);
      if (rows.length === 0) break;
      after = rows[rows.length - 1]!.id;
      const candidates: PendingPair[] = [];
      for (const row of rows) {
        const htmlBytes = toNumber(row.hl);
        const textBytes = toNumber(row.tl);
        // NULL html or NULL text: outside the job's rows, not counted.
        if (htmlBytes === null || textBytes === null) continue;
        if (row.linked) {
          count(this.counts, 'baseline_referenced');
        } else if (htmlBytes > this.ctx.limits.ceilingBytes || textBytes > this.ctx.limits.ceilingBytes) {
          count(this.counts, 'oversized');
          logResidual(this.ctx, this.ownerId, 'oversized', { versionId: row.id, htmlBytes, textBytes });
        } else {
          const ref: CopyRef = { kind: 'version', id: row.id };
          candidates.push({ key: keyFor(ref), ref, htmlBytes, textBytes });
        }
      }
      for (const group of budgeted(candidates, (pair) => pair.htmlBytes, this.ctx.limits.statementBytes)) {
        this.statement('ampersand_versions', group.reduce((sum, pair) => sum + pair.htmlBytes, 0));
        const flags = await observe<{ id: string; amp: boolean | null }>(this.ctx, 'read_only',
          `SELECT e.id::text AS id,
                  CASE WHEN octet_length(pv.body_html) = e.hl THEN strpos(pv.body_html, '&') > 0 END AS amp
             FROM unnest($1::uuid[], $2::bigint[]) AS e(id, hl)
             JOIN page_versions pv ON pv.id = e.id AND pv.page_id = $3`,
          [group.map((pair) => versionId(pair.ref)), group.map((pair) => pair.htmlBytes), this.ownerId]);
        if (flags.length !== group.length) throw new OwnerUnresolved('changed');
        const byId = new Map(flags.map((flag) => [flag.id, flag.amp]));
        for (const pair of group) {
          const amp = byId.get(versionId(pair.ref));
          if (amp === null || amp === undefined) throw new OwnerUnresolved('changed');
          if (amp) await this.enqueue(pair);
          else count(this.counts, 'no_ampersand');
        }
      }
      await this.flush();
      if (rows.length < this.ctx.limits.scanRows) break;
    }
    await this.flush();
  }
}

function describeCopy(pair: PendingPair): Record<string, unknown> {
  return pair.ref.kind === 'page'
    ? { column: pair.ref.column, htmlBytes: pair.htmlBytes, textBytes: pair.textBytes }
    : { versionId: pair.ref.id, htmlBytes: pair.htmlBytes, textBytes: pair.textBytes };
}

async function observeOwner(ctx: RunContext, ownerId: number): Promise<Observation | null> {
  const opened = await open(ctx, ownerId);
  if (!opened) return null;
  const scan = new OwnerScan(ctx, opened);
  try {
    await scan.scanPage();
    await scan.scanHistory();
  } catch (error) {
    if (error instanceof OwnerUnresolved && error.reason === 'page_too_large') {
      logResidual(ctx, ownerId, 'page_too_large', {
        affectedCopies: scan.affected.length, correctedBytes: scan.correctedBytes,
      });
    }
    throw error;
  }
  await ctx.hooks.afterScan?.(ownerId, { affected: scan.affected.length });
  return { opened, affected: scan.affected, correctedBytes: scan.correctedBytes, counts: scan.counts };
}

// ─── The closing transaction (§6) ────────────────────────────────────────────

interface LockedPage {
  c: string;
  l: string;
  version: number;
  frozen: boolean;
  title: string;
  source: string;
  remote_version: number | null;
  has_modified_by: boolean;
  modified_at_null: boolean;
  phl: string | null;
  ptl: string | null;
  dhl: string | null;
  dtl: string | null;
}

type Decision = 'write' | 'paired_exempt' | 'identity_conflict' | 'unindexable';

const DIGEST = (column: string) => `encode(sha256(convert_to(${column}, 'UTF8')), 'hex')`;

class CloseTransaction {
  private readonly pageMembers: Map<Column, Affected>;
  private readonly versionMembers: Affected[];
  private witness: string | null = null;

  constructor(
    private readonly ctx: RunContext,
    private readonly client: PoolClient,
    private readonly observation: Observation,
  ) {
    this.pageMembers = new Map(observation.affected
      .filter((member) => member.ref.kind === 'page')
      .map((member) => [pageColumn(member.ref), member]));
    this.versionMembers = observation.affected.filter((member) => member.ref.kind === 'version');
  }

  private get ownerId(): number {
    return this.observation.opened.pageId;
  }

  private statement(kind: string, bytes: number): void {
    this.ctx.hooks.onStatement?.({ kind, ownerId: this.ownerId, bytes });
  }

  private changed(): never {
    throw new OwnerUnresolved('changed');
  }

  /** Step 1: admission on this client. */
  async admit(): Promise<void> {
    if (!this.observation.opened.frozen) {
      await lockPageWrites(this.client, [this.ownerId]);
      return;
    }
    await lockPageWrites(this.client, []);
    await lockPageLifecycle(this.client, [this.ownerId]);
    const pending = await this.client.query(
      `SELECT 1 FROM page_write_intents WHERE status = 'pending' AND page_ids && ARRAY[$1]::integer[] LIMIT 1`,
      [this.ownerId],
    );
    if (pending.rows.length > 0) throw new PageWriteError(409, 'page_write_busy', 'Another external page write is unresolved');
  }

  /** Step 3: the page row FOR UPDATE, revisions and the page members' digests. */
  async lockPage(): Promise<LockedPage> {
    const result = await this.client.query<LockedPage>(
      `SELECT content_revision::text AS c, lifecycle_revision::text AS l, version, baseline_id IS NOT NULL AS frozen,
              title, source, remote_version, local_modified_by IS NOT NULL AS has_modified_by,
              local_modified_at IS NULL AS modified_at_null,
              octet_length(body_html) AS phl, octet_length(body_text) AS ptl,
              octet_length(draft_body_html) AS dhl, octet_length(draft_body_text) AS dtl
         FROM pages WHERE id = $1 FOR UPDATE`,
      [this.ownerId],
    );
    const page = result.rows[0];
    if (!page) throw new PageWriteError(404, 'page_not_found', 'One or more pages no longer exist');
    const opened = this.observation.opened;
    if (page.c !== opened.c0 || page.l !== opened.l0 || page.version !== opened.version || page.frozen !== opened.frozen) {
      this.changed();
    }
    for (const [column, member] of this.pageMembers) {
      const lengths = column === 'published' ? [page.phl, page.ptl] : [page.dhl, page.dtl];
      if (toNumber(lengths[0]) !== member.htmlBytes || toNumber(lengths[1]) !== member.textBytes) this.changed();
      const names = PAGE_COLUMNS[column];
      const parts = member.htmlBytes + member.textBytes <= this.ctx.limits.statementBytes
        ? [[names.html, names.text]] : [[names.html], [names.text]];
      const digests: Record<string, string> = {};
      for (const part of parts) {
        this.statement('digest_page', part.reduce((sum, name) => sum
          + (name === names.html ? member.htmlBytes : member.textBytes), 0));
        const row = (await this.client.query<Record<string, string>>(
          `SELECT ${part.map((name) => `${DIGEST(name)} AS ${name}`).join(', ')} FROM pages WHERE id = $1`,
          [this.ownerId],
        )).rows[0];
        Object.assign(digests, row);
      }
      if (digests[names.html] !== member.htmlSha256 || digests[names.text] !== member.textSha256) this.changed();
    }
    return page;
  }

  /** Step 4: lock every row a lazy fill could change; constant-size result. */
  async drain(): Promise<void> {
    await this.client.query(
      `SELECT count(*) FROM (
         SELECT 1 FROM page_versions WHERE page_id = $1 AND body_html IS NULL FOR UPDATE NOWAIT
       ) AS l`,
      [this.ownerId],
    );
  }

  /** Step 5: the history members of A, FOR UPDATE NOWAIT, verified by id, digests and link. */
  async lockMembers(): Promise<void> {
    const singles = this.versionMembers.filter((m) => m.htmlBytes + m.textBytes > this.ctx.limits.statementBytes);
    const batched = this.versionMembers.filter((m) => m.htmlBytes + m.textBytes <= this.ctx.limits.statementBytes);
    const verify = async (group: Affected[], parts: ('html' | 'text')[]) => {
      this.statement('lock_members', group.reduce((sum, m) => sum
        + (parts.includes('html') ? m.htmlBytes : 0) + (parts.includes('text') ? m.textBytes : 0), 0));
      const rows = (await this.client.query<{ id: string; h: string | null; t: string | null; linked: boolean }>(
        `SELECT pv.id::text AS id,
                ${parts.includes('html') ? DIGEST('pv.body_html') : 'NULL::text'} AS h,
                ${parts.includes('text') ? DIGEST('pv.body_text') : 'NULL::text'} AS t,
                EXISTS (SELECT 1 FROM page_baselines b WHERE b.version_snapshot_id = pv.id) AS linked
           FROM unnest($1::uuid[], $2::bigint[], $3::bigint[]) AS e(id, hl, tl)
           JOIN page_versions pv ON pv.id = e.id
          WHERE pv.page_id = $4 AND octet_length(pv.body_html) = e.hl AND octet_length(pv.body_text) = e.tl
          FOR UPDATE OF pv NOWAIT`,
        [group.map((m) => versionId(m.ref)), group.map((m) => m.htmlBytes), group.map((m) => m.textBytes),
          this.ownerId],
      )).rows;
      if (rows.length !== group.length) this.changed();
      const byId = new Map(rows.map((row) => [row.id, row]));
      for (const member of group) {
        const row = byId.get(versionId(member.ref));
        if (!row || row.linked) this.changed();
        if (parts.includes('html') && row.h !== member.htmlSha256) this.changed();
        if (parts.includes('text') && row.t !== member.textSha256) this.changed();
      }
    };
    for (const group of budgeted(batched, (m) => m.htmlBytes + m.textBytes, this.ctx.limits.statementBytes)) {
      await verify(group, ['html', 'text']);
    }
    for (const member of singles) {
      await verify([member], ['html']);
      await verify([member], ['text']);
    }
  }

  /** Rule (b): equal stored text, different corrected text. */
  splitByEqualText(): boolean {
    const corrected = new Map<string, string>();
    for (const member of this.observation.affected) {
      const id = `${member.textBytes}:${member.textSha256}`;
      const seen = corrected.get(id);
      if (seen !== undefined && seen !== member.corrected) return true;
      corrected.set(id, member.corrected);
    }
    return false;
  }

  /** Rule (a): a copy outside A with stored text byte-equal to a member's. */
  async findWitness(page: LockedPage): Promise<boolean> {
    const memberTexts = new Set(this.observation.affected.map((m) => `${m.textBytes}:${m.textSha256}`));
    const lengths = [...new Set(this.observation.affected.map((m) => m.textBytes))];
    for (const column of ['published', 'draft'] as const) {
      if (this.pageMembers.has(column)) continue;
      const textBytes = toNumber(column === 'published' ? page.ptl : page.dtl);
      if (textBytes === null || !lengths.includes(textBytes)) continue;
      this.statement('witness_page', textBytes);
      const row = (await this.client.query<{ t: string }>(
        `SELECT ${DIGEST(PAGE_COLUMNS[column].text)} AS t FROM pages WHERE id = $1`, [this.ownerId],
      )).rows[0];
      if (row && memberTexts.has(`${textBytes}:${row.t}`)) {
        this.witness = column;
        return true;
      }
    }
    const memberIds = this.versionMembers.map((m) => versionId(m.ref));
    let after = FIRST_UUID;
    for (;;) {
      const window = (await this.client.query<{ id: string; tl: string }>(
        `SELECT id::text AS id, octet_length(body_text) AS tl
           FROM page_versions
          WHERE page_id = $1 AND id > $2::uuid AND body_text IS NOT NULL
            AND octet_length(body_text) = ANY($3::bigint[]) AND NOT (id = ANY($4::uuid[]))
          ORDER BY id
          LIMIT $5`,
        [this.ownerId, after, lengths, memberIds, this.ctx.limits.scanRows],
      )).rows;
      if (window.length === 0) return false;
      after = window[window.length - 1]!.id;
      const candidates = window.map((row) => ({ id: row.id, tl: Number(row.tl) }));
      for (const group of budgeted(candidates, (row) => row.tl, this.ctx.limits.statementBytes)) {
        this.statement('witness_versions', group.reduce((sum, row) => sum + row.tl, 0));
        const digests = (await this.client.query<{ id: string; tl: string; t: string | null }>(
          `SELECT e.id::text AS id, e.tl::text AS tl,
                  CASE WHEN octet_length(pv.body_text) = e.tl THEN ${DIGEST('pv.body_text')} END AS t
             FROM unnest($1::uuid[], $2::bigint[]) AS e(id, tl)
             JOIN page_versions pv ON pv.id = e.id AND pv.page_id = $3
            ORDER BY e.id`,
          [group.map((row) => row.id), group.map((row) => row.tl), this.ownerId],
        )).rows;
        for (const digest of digests) {
          if (digest.t === null || !memberTexts.has(`${digest.tl}:${digest.t}`)) continue;
          const locked = await this.client.query(
            `SELECT 1 FROM page_versions
              WHERE id = $1::uuid AND octet_length(body_text) = $2 AND ${DIGEST('body_text')} = $3
              FOR UPDATE NOWAIT`,
            [digest.id, Number(digest.tl), digest.t],
          );
          if (locked.rows.length === 1) {
            this.witness = digest.id;
            return true;
          }
        }
      }
      if (window.length < this.ctx.limits.scanRows) return false;
    }
  }

  /** Rule (e), D13: the published write would move the snapshot identity onto an occupied key. */
  async identityConflict(page: LockedPage): Promise<boolean> {
    const published = this.pageMembers.get('published');
    if (!published) return false;
    const before = livePageVersion({
      source: page.source, version: page.version, remote_version: page.remote_version,
      local_modified_at: page.modified_at_null ? null : new Date(0),
    });
    // Rule A of migration 060 is the only way this write moves an input of
    // livePageVersion: the marker's NULL → non-NULL transition.
    const ruleA = page.has_modified_by && page.modified_at_null;
    const after = livePageVersion({
      source: page.source, version: page.version, remote_version: page.remote_version,
      local_modified_at: ruleA || !page.modified_at_null ? new Date(0) : null,
    });
    if (after.source === before.source && after.versionNumber === before.versionNumber) return false;
    const slot = (await this.client.query<{
      id: string; title: string; hl: string | null; tl: string | null; linked: boolean;
    }>(
      `SELECT pv.id::text AS id, pv.title, octet_length(pv.body_html) AS hl, octet_length(pv.body_text) AS tl,
              EXISTS (SELECT 1 FROM page_baselines b WHERE b.version_snapshot_id = pv.id) AS linked
         FROM page_versions pv
        WHERE pv.page_id = $1 AND pv.source = $2 AND pv.version_number = $3
        FOR UPDATE OF pv NOWAIT`,
      [this.ownerId, after.source, after.versionNumber],
    )).rows[0];
    if (!slot) return false;
    const hl = toNumber(slot.hl);
    const tl = toNumber(slot.tl);
    if (hl === null && tl === null) return !(slot.title === page.title && !slot.linked);
    if (slot.title !== page.title || hl !== published.htmlBytes) return true;
    this.statement('identity_html', hl);
    const html = (await this.client.query<{ h: string }>(
      `SELECT ${DIGEST('body_html')} AS h FROM page_versions WHERE id = $1::uuid`, [slot.id],
    )).rows[0];
    if (html?.h !== published.htmlSha256) return true;
    const member = this.versionMembers.find((m) => versionId(m.ref) === slot.id);
    if (member) return member.corrected !== published.corrected;
    if (tl !== published.correctedBytes) return true;
    this.statement('identity_text', tl);
    const text = (await this.client.query<{ t: string }>(
      `SELECT ${DIGEST('body_text')} AS t FROM page_versions WHERE id = $1::uuid`, [slot.id],
    )).rows[0];
    return text?.t !== sha256Hex(published.corrected);
  }

  /** Step 7: at most one page update, then the history members set-based. */
  async write(): Promise<'written' | 'unindexable'> {
    const published = this.pageMembers.get('published');
    const draft = this.pageMembers.get('draft');
    await this.client.query('SAVEPOINT body_text_backfill_page');
    if (published || draft) {
      const sql = published && draft
        ? 'UPDATE pages SET body_text = $2, draft_body_text = $3 WHERE id = $1'
        : published
          ? 'UPDATE pages SET body_text = $2 WHERE id = $1'
          : 'UPDATE pages SET draft_body_text = $2 WHERE id = $1';
      const params = published && draft
        ? [this.ownerId, published.corrected, draft.corrected]
        : [this.ownerId, (published ?? draft)!.corrected];
      this.statement('write_page', (published?.correctedBytes ?? 0) + (draft?.correctedBytes ?? 0));
      try {
        const updated = await this.client.query(sql, params);
        if (updated.rowCount !== 1) this.changed();
      } catch (error) {
        // D9: identified by SQLSTATE and routine only (neither is translated).
        const routine = (error as { routine?: unknown }).routine;
        if (sqlState(error) === '54000' && routine === 'make_tsvector') {
          await this.client.query('ROLLBACK TO SAVEPOINT body_text_backfill_page');
          return 'unindexable';
        }
        throw error;
      }
    }
    const returned = new Set<string>();
    for (const group of budgeted(this.versionMembers, (m) => m.correctedBytes, this.ctx.limits.statementBytes)) {
      this.statement('write_versions', group.reduce((sum, m) => sum + m.correctedBytes, 0));
      const rows = (await this.client.query<{ id: string }>(
        `UPDATE page_versions pv SET body_text = v.t
           FROM unnest($1::uuid[], $2::text[]) AS v(id, t)
          WHERE pv.id = v.id AND pv.page_id = $3
          RETURNING pv.id::text AS id`,
        [group.map((m) => versionId(m.ref)), group.map((m) => m.corrected), this.ownerId],
      )).rows;
      for (const row of rows) returned.add(row.id);
    }
    if (returned.size !== this.versionMembers.length
      || this.versionMembers.some((m) => !returned.has(versionId(m.ref)))) {
      this.changed();
    }
    return 'written';
  }

  /** Steps 3–7. */
  async run(): Promise<Decision> {
    const hooks = this.ctx.hooks;
    const page = await this.lockPage();
    await hooks.afterPageLock?.(this.ownerId, this.client);
    await this.drain();
    await hooks.afterDrain?.(this.ownerId, this.client);
    await this.lockMembers();
    await hooks.afterMembersLocked?.(this.ownerId, this.client);
    let decision: Decision = 'write';
    if (this.splitByEqualText() || await this.findWitness(page)) decision = 'paired_exempt';
    else if (await this.identityConflict(page)) decision = 'identity_conflict';
    await hooks.afterDecision?.(this.ownerId, this.client, decision);
    if (decision === 'write' && await this.write() === 'unindexable') decision = 'unindexable';
    if (decision !== 'write') {
      logResidual(this.ctx, this.ownerId, decision, {
        copies: this.observation.affected.length,
        ...(this.witness ? { witness: this.witness } : {}),
        ...(decision === 'identity_conflict' ? { column: 'published' } : {}),
        ...(decision === 'unindexable' ? { column: 'published' } : {}),
      });
    }
    return decision;
  }
}

// ─── Owner outcomes, recorded by fenced transactions ─────────────────────────

/** Move the cursor past `ownerId` (scan) or advance the retry position. */
function pastOwner(doc: BodyTextBackfillState, ownerId: number): BodyTextBackfillState {
  return { ...doc, cursor: ownerId };
}

function withoutTransient(doc: BodyTextBackfillState, ownerId: number): BodyTextBackfillState {
  if (doc.unresolved.overflow || !doc.unresolved.ids.includes(ownerId)) return doc;
  const ids = doc.unresolved.ids.filter((id) => id !== ownerId);
  return { ...doc, unresolved: { ...doc.unresolved, ids, count: ids.length, sample: ids.slice(0, SAMPLE_SIZE) } };
}

function withTransient(doc: BodyTextBackfillState, ownerId: number, max: number): BodyTextBackfillState {
  const current = doc.unresolved;
  if (current.overflow) {
    return {
      ...doc,
      unresolved: {
        ...current,
        count: current.count + 1,
        sample: current.sample.length < SAMPLE_SIZE ? [...current.sample, ownerId] : current.sample,
      },
    };
  }
  if (current.ids.includes(ownerId)) return doc;
  const ids = [...current.ids, ownerId].sort((a, b) => a - b);
  if (ids.length > max) {
    return { ...doc, unresolved: { ids: [], overflow: true, count: ids.length, sample: ids.slice(0, SAMPLE_SIZE) } };
  }
  return { ...doc, unresolved: { ids, overflow: false, count: ids.length, sample: ids.slice(0, SAMPLE_SIZE) } };
}

function withCounts(doc: BodyTextBackfillState, delta: Counts): BodyTextBackfillState {
  const passTotals = { ...doc.passTotals };
  const totals = { ...doc.totals };
  addCounts(passTotals, delta);
  addCounts(totals, delta);
  return { ...doc, passTotals, totals };
}

function progress(ctx: RunContext, ownerId: number | null, step: string, delta: Counts): void {
  addCounts(ctx.counts, delta);
  logger.info({
    job: 'body_text_backfill', pass: ctx.doc.pass, phase: ctx.doc.phase, pageId: ownerId, step,
    bytesLoaded: ctx.bytesLoaded, delta,
  }, 'body_text backfill progress');
}

async function checkpointUnresolved(ctx: RunContext, ownerId: number, reason: OwnerUnresolved['reason']): Promise<void> {
  const { delta } = await fencedTransaction(ctx, 'checkpoint', ownerId, async (client, { doc, now }) => {
    const next = pastOwner(doc, ownerId);
    if (reason === 'gone') {
      // A trashed page still exists; only an absent row is gone.
      const exists = await client.query('SELECT 1 FROM pages WHERE id = $1', [ownerId]);
      if (exists.rows.length > 0) {
        return { doc: withCounts(withTransient(next, ownerId, ctx.limits.transientListMax), { changed: 1 }), delta: { changed: 1 } };
      }
      return { doc: withCounts(withoutTransient(next, ownerId), { gone: 1 }), delta: { gone: 1 } };
    }
    if (reason === 'page_too_large') {
      // A refusal, not an exemption: counted once, never in the transient
      // list, and it schedules the daily full pass from this pass's start.
      const passStart = Date.parse(doc.passStartedAt ?? now.toISOString());
      const refused = withoutTransient(next, ownerId);
      return {
        doc: withCounts({
          ...refused,
          tooLarge: refused.tooLarge + 1,
          nextFullPassAfter: new Date(passStart + DAY_MS).toISOString(),
        }, { page_too_large: 1 }),
        delta: { page_too_large: 1 },
      };
    }
    return {
      doc: withCounts(withTransient(next, ownerId, ctx.limits.transientListMax), { [reason]: 1 }),
      delta: { [reason]: 1 },
    };
  });
  progress(ctx, ownerId, Object.keys(delta)[0] ?? reason, delta);
}

/** A empty: lock the page row FOR SHARE and close only if nothing moved since Open. */
async function fencedCloseEmpty(ctx: RunContext, observation: Observation): Promise<void> {
  const { opened } = observation;
  const delta: Counts = { ...observation.counts, owners: 1 };
  await fencedTransaction(ctx, 'fenced_close', opened.pageId, async (client, { doc }) => {
    const row = (await client.query<{ c: string; l: string; version: number }>(
      `SELECT content_revision::text AS c, lifecycle_revision::text AS l, version FROM pages WHERE id = $1 FOR SHARE`,
      [opened.pageId],
    )).rows[0];
    if (!row) throw new OwnerUnresolved('gone');
    if (row.c !== opened.c0 || row.l !== opened.l0 || row.version !== opened.version) throw new OwnerUnresolved('changed');
    return { doc: withCounts(withoutTransient(pastOwner(doc, opened.pageId), opened.pageId), delta), delta };
  });
  progress(ctx, opened.pageId, 'closed', delta);
}

function mapAdmissionRefusal(error: PageWriteError): OwnerUnresolved | RunInterrupted {
  switch (error.reason) {
    case 'page_is_frozen':
      return new OwnerUnresolved('changed');
    case 'page_not_found':
      return new OwnerUnresolved('gone');
    case 'runtime_quiescing':
    case 'runtime_quiesced':
    case 'runtime_fenced':
    case 'runtime_unknown':
    case 'runtime_mismatch':
      return new RunInterrupted(error.reason);
    default:
      return new OwnerUnresolved('busy');
  }
}

/**
 * The closing transaction (§6) inside `withPageWriterOperation`, whose
 * `runtime_quiescing` refusal is thrown before a client is opened. Lock
 * order: epoch → hierarchy → lifecycle (admission) → state row → page row →
 * version rows.
 */
async function closeOwner(ctx: RunContext, observation: Observation): Promise<void> {
  const ownerId = observation.opened.pageId;
  await tick(ctx);
  let result: FencedResult;
  try {
    result = await withPageWriterOperation(() => {
      let close: CloseTransaction | null = null;
      return fencedTransaction(ctx, 'close', ownerId, async (_client, { doc }) => {
        const decision = await close!.run();
        const delta: Counts = { ...observation.counts, owners: 1 };
        count(delta, decision === 'write' ? 'repaired' : decision, observation.affected.length);
        return { doc: withCounts(withoutTransient(pastOwner(doc, ownerId), ownerId), delta), delta };
      }, async (client) => {
        await ctx.hooks.beforeAdmission?.(ownerId, client);
        close = new CloseTransaction(ctx, client, observation);
        await close.admit();
        await ctx.hooks.afterAdmission?.(ownerId, client);
      });
    });
  } catch (error) {
    if (error instanceof PageWriteError) throw mapAdmissionRefusal(error);
    if (isBusyState(sqlState(error))) throw new OwnerUnresolved('busy');
    throw error;
  }
  progress(ctx, ownerId, 'closed', result.delta);
}

async function processOwner(ctx: RunContext, ownerId: number): Promise<void> {
  try {
    const observation = await observeOwner(ctx, ownerId);
    if (!observation) throw new OwnerUnresolved('gone');
    if (observation.affected.length === 0) await fencedCloseEmpty(ctx, observation);
    else await closeOwner(ctx, observation);
  } catch (error) {
    if (!(error instanceof OwnerUnresolved)) throw error;
    await checkpointUnresolved(ctx, ownerId, error.reason);
  }
}

// ─── Claim, pass bookkeeping, release ───────────────────────────────────────

type Claim =
  | { kind: 'claimed'; doc: BodyTextBackfillState; fresh: boolean }
  | { kind: 'already_running' | 'already_completed' | 'waiting'; doc: BodyTextBackfillState };

async function ensureStateRow(): Promise<void> {
  await getPool().query(
    `INSERT INTO admin_settings (setting_key, setting_value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (setting_key) DO NOTHING`,
    [BODY_TEXT_BACKFILL_STATE_KEY, JSON.stringify(initialState())],
  );
}

function due(doc: BodyTextBackfillState, now: Date): boolean {
  return doc.nextFullPassAfter !== null && Date.parse(doc.nextFullPassAfter) <= now.getTime();
}

async function claim(
  runId: string, restart: boolean, limits: BodyTextBackfillLimits, pgVersion: number, hooks: BodyTextBackfillHooks,
): Promise<Claim> {
  return withClient(async (client) => {
    await beginTx(client, 'read_committed', limits, pgVersion);
    try {
      const state = await readStateForUpdate(client);
      if (!state) throw new BodyTextBackfillError('state_invalid', 'claim', null);
      const { doc, now, updatedAt } = state;
      const live = doc.owner !== null && now.getTime() - updatedAt.getTime() < limits.leaseMs;
      const stale = doc.owner !== null && !live;
      const scanUnfinished = !(doc.status === 'done' || doc.status === 'waiting'
        || (doc.phase === 'retry' && (doc.status === 'idle' || (doc.status === 'running' && stale))));
      let next: BodyTextBackfillState;
      let fresh = false;
      if (live) {
        await client.query('ROLLBACK');
        return { kind: 'already_running', doc };
      }
      if (restart || (due(doc, now) && !scanUnfinished) || doc.status === 'new') {
        const highWater = (await client.query<{ max: number | null }>('SELECT max(id) AS max FROM pages')).rows[0]?.max ?? 0;
        fresh = true;
        next = {
          ...doc, status: 'running', owner: runId, seq: doc.seq + 1, pass: doc.pass + 1,
          passStartedAt: now.toISOString(), highWater, phase: 'scan', cursor: 0,
          unresolved: { ids: [], overflow: false, count: 0, sample: [] }, tooLarge: 0,
          nextFullPassAfter: null, passTotals: {},
        };
      } else if (doc.status === 'done' || doc.status === 'waiting') {
        await client.query('ROLLBACK');
        return { kind: doc.status === 'done' ? 'already_completed' : 'waiting', doc };
      } else {
        next = { ...doc, status: 'running', owner: runId, seq: doc.seq + 1 };
      }
      await writeState(client, next);
      await hooks.beforeCommit?.('claim', null, client);
      await client.query('COMMIT');
      return { kind: 'claimed', doc: next, fresh };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  });
}

/** The end-of-pass table of §8. */
function endOfPass(doc: BodyTextBackfillState, now: Date): BodyTextBackfillState {
  const daily = new Date(Date.parse(doc.passStartedAt ?? now.toISOString()) + DAY_MS).toISOString();
  const transient = doc.unresolved;
  if (!transient.overflow && transient.ids.length === 0) {
    if (doc.tooLarge > 0) return { ...doc, status: 'waiting', phase: 'scan', cursor: 0, nextFullPassAfter: daily };
    return {
      ...doc, status: 'done', phase: 'scan', cursor: 0, overflowBackoffMs: null,
      completedAt: now.toISOString(),
      firstCompletedAt: doc.firstCompletedAt ?? now.toISOString(),
      nextFullPassAfter: new Date(now.getTime() + (doc.firstCompletedAt === null ? FIRST_RECHECK_MS : LATER_RECHECK_MS))
        .toISOString(),
    };
  }
  if (!transient.overflow) {
    return { ...doc, status: 'idle', phase: 'retry', cursor: 0, nextFullPassAfter: doc.tooLarge > 0 ? daily : null };
  }
  if (doc.tooLarge > 0) return { ...doc, status: 'waiting', phase: 'scan', cursor: 0, nextFullPassAfter: daily };
  const backoff = Math.min((doc.overflowBackoffMs ?? OVERFLOW_BACKOFF_START_MS / 2) * 2, OVERFLOW_BACKOFF_MAX_MS);
  return {
    ...doc, status: 'waiting', phase: 'scan', cursor: 0, overflowBackoffMs: backoff,
    nextFullPassAfter: new Date(now.getTime() + backoff).toISOString(),
  };
}

async function release(ctx: RunContext, finished: boolean): Promise<BodyTextBackfillState> {
  const { doc } = await fencedTransaction(ctx, 'release', null, async (_client, { doc: current, now }) => {
    const settled = finished ? endOfPass(current, now) : { ...current, status: 'idle' as const };
    return { doc: { ...settled, owner: null, lastOwner: ctx.runId }, delta: {} };
  });
  return doc;
}

async function nextOwnerId(ctx: RunContext): Promise<number | null> {
  const { doc } = ctx;
  if (doc.phase === 'retry') return doc.unresolved.ids.find((id) => id > doc.cursor) ?? null;
  const rows = await observe<{ id: number }>(ctx, 'read_only',
    'SELECT id FROM pages WHERE id > $1 AND id <= $2 ORDER BY id LIMIT 1', [doc.cursor, doc.highWater]);
  return rows[0]?.id ?? null;
}

function outcomeOf(doc: BodyTextBackfillState): BodyTextBackfillOutcome {
  if (doc.status === 'done') return 'done';
  if (doc.status === 'waiting') return 'waiting';
  return doc.phase === 'retry' ? 'retry' : 'idle';
}

function logSummary(summary: BodyTextBackfillSummary): void {
  logger.info({ job: 'body_text_backfill', ...summary }, 'body_text backfill run finished');
}

/** The ≤ 500-character result BullMQ stores in `job_history`. */
export function formatBodyTextBackfillSummary(summary: BodyTextBackfillSummary): string {
  const counts = COUNTERS.filter((key) => summary.counts[key]).map((key) => `${key}=${summary.counts[key]}`).join(' ');
  const text = `body_text backfill ${summary.outcome}${summary.interruptCode ? ` (${summary.interruptCode})` : ''}`
    + `; pass ${summary.pass} ${summary.phase}; ${counts || 'no changes'}; bytes ${summary.bytesLoaded}`;
  return text.length <= SUMMARY_MAX ? text : `${text.slice(0, SUMMARY_MAX - 1)}…`;
}

async function readPgVersion(): Promise<number> {
  const result = await getPool().query<{ v: string }>("SELECT current_setting('server_version_num') AS v");
  return Number(result.rows[0]?.v ?? 0);
}

/** The unlocked fast path: a tick on `done`/`waiting` with nothing due is one settings read. */
async function nothingDue(): Promise<{ doc: BodyTextBackfillState; kind: 'already_completed' | 'waiting' } | null> {
  const row = (await getPool().query<{ setting_value: string; now: Date }>(
    'SELECT setting_value, NOW() AS now FROM admin_settings WHERE setting_key = $1',
    [BODY_TEXT_BACKFILL_STATE_KEY],
  )).rows[0];
  if (!row) return null;
  const doc = parseState(row.setting_value);
  if ((doc.status === 'done' || doc.status === 'waiting') && !due(doc, row.now)) {
    return { doc, kind: doc.status === 'done' ? 'already_completed' : 'waiting' };
  }
  return null;
}

async function execute(options: BodyTextBackfillOptions): Promise<BodyTextBackfillSummary> {
  const limits: BodyTextBackfillLimits = { ...BODY_TEXT_BACKFILL_LIMITS, ...options.limits };
  const hooks = options.hooks ?? {};
  const runId = randomUUID();
  const restart = options.restart === true;
  const empty = (outcome: BodyTextBackfillOutcome, doc: BodyTextBackfillState): BodyTextBackfillSummary => ({
    outcome, runId, pass: doc.pass, phase: doc.phase, counts: {}, bytesLoaded: 0,
  });
  if (stopLatched) return { ...empty('interrupted', initialState()), interruptCode: 'stopped' };
  if (!restart) {
    const fast = await nothingDue();
    if (fast) return empty(fast.kind, fast.doc);
  }
  await ensureStateRow();
  const pgVersion = await readPgVersion();
  let claimed: Claim;
  try {
    claimed = await claim(runId, restart, limits, pgVersion, hooks);
  } catch (error) {
    if (error instanceof BodyTextBackfillError) throw error;
    if (isBusyState(sqlState(error))) return { ...empty('interrupted', initialState()), interruptCode: 'state_timeout' };
    throw new BodyTextBackfillError('claim_failed', 'claim', null);
  }
  if (claimed.kind !== 'claimed') return empty(claimed.kind, claimed.doc);

  const parser = new BodyTextBackfillParser(limits, options.parserEntry);
  activeParser = parser;
  const ctx: RunContext = {
    runId, seq: claimed.doc.seq, doc: claimed.doc, limits, hooks, pgVersion, lastStateWriteAt: Date.now(),
    parser, counts: {}, bytesLoaded: 0,
  };
  let finished = false;
  let interruptCode: string | undefined;
  let failure: BodyTextBackfillError | undefined;
  let ownerId: number | null = null;
  try {
    for (;;) {
      ownerId = await nextOwnerId(ctx);
      if (ownerId === null) break;
      await processOwner(ctx, ownerId);
    }
    finished = true;
  } catch (error) {
    if (error instanceof StopSignal) {
      interruptCode = 'stopped';
    } else if (error instanceof RunInterrupted) {
      interruptCode = error.code;
      failure = new BodyTextBackfillError(error.code, ctx.doc.phase, ownerId);
    } else if (error instanceof OwnerUnresolved) {
      // Only the next-owner read can surface here (its deadline expired).
      interruptCode = 'busy';
    } else if (error instanceof BodyTextBackfillError) {
      interruptCode = error.code;
      failure = error;
    } else {
      interruptCode = sqlState(error) ? `sql_${sqlState(error)}` : 'internal';
      failure = new BodyTextBackfillError(interruptCode, ctx.doc.phase, ownerId);
    }
  } finally {
    parser.terminate();
    if (activeParser === parser) activeParser = null;
  }

  let releasedDoc = ctx.doc;
  if (interruptCode !== 'ownership_lost') {
    try {
      releasedDoc = await release(ctx, finished);
    } catch {
      // The lease expires; a later claim takes the pass over.
      interruptCode ??= 'release_failed';
    }
  }
  const summary: BodyTextBackfillSummary = {
    outcome: interruptCode ? 'interrupted' : outcomeOf(releasedDoc),
    runId, pass: releasedDoc.pass, phase: releasedDoc.phase, counts: ctx.counts, bytesLoaded: ctx.bytesLoaded,
    ...(interruptCode ? { interruptCode } : {}),
  };
  logSummary(summary);
  if (failure) throw failure;
  return summary;
}

/**
 * Run the job once: claim (or resume) a pass, process owners until the pass
 * or the retry tick ends, release. One run per process at a time.
 */
export async function runBodyTextBackfill(options: BodyTextBackfillOptions = {}): Promise<BodyTextBackfillSummary> {
  if (activeRun) {
    return { outcome: 'already_running', runId: '', pass: 0, phase: 'scan', counts: {}, bytesLoaded: 0 };
  }
  const run = execute(options);
  activeRun = run;
  try {
    return await run;
  } catch (error) {
    if (error instanceof BodyTextBackfillError) throw error;
    // Never let raw PostgreSQL or parser text leave the job.
    throw new BodyTextBackfillError(sqlState(error) ? `sql_${sqlState(error)}` : 'internal', 'run', null);
  } finally {
    if (activeRun === run) activeRun = null;
  }
}

/** BullMQ / legacy processor: returns the ≤ 500-character summary. */
export async function processBodyTextBackfillJob(data: unknown): Promise<string> {
  const restart = (data as { restart?: unknown } | null)?.restart === true;
  return formatBodyTextBackfillSummary(await runBodyTextBackfill({ restart }));
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

/** Re-arm after a stop (start paths call this). */
export function armBodyTextBackfill(): void {
  stopLatched = false;
}

/**
 * Latch, clear legacy timers, terminate the parser worker (not restarted) and
 * await the in-flight run. Called by `stopQueueWorkers()` in both modes
 * before workers or the pool close.
 */
export async function stopBodyTextBackfill(): Promise<void> {
  stopLatched = true;
  stopBodyTextBackfillWorker();
  activeParser?.terminate();
  const run = activeRun;
  if (run) await run.catch(() => undefined);
}

function legacyTick(): void {
  void processBodyTextBackfillJob({}).catch((error: unknown) => {
    logger.error(
      { job: 'body_text_backfill', code: error instanceof BodyTextBackfillError ? error.code : 'internal' },
      'body_text backfill run failed',
    );
  });
}

/** Legacy (USE_BULLMQ=false): first run after 30 s, then hourly. */
export function startBodyTextBackfillWorker(
  intervalMs = BODY_TEXT_BACKFILL_INTERVAL_MS, firstDelayMs = LEGACY_FIRST_RUN_DELAY_MS,
): void {
  stopBodyTextBackfillWorker();
  armBodyTextBackfill();
  legacyFirstTimer = setTimeout(() => {
    legacyFirstTimer = null;
    legacyTick();
    legacyInterval = setInterval(legacyTick, intervalMs);
  }, firstDelayMs);
}

export function stopBodyTextBackfillWorker(): void {
  if (legacyFirstTimer) clearTimeout(legacyFirstTimer);
  if (legacyInterval) clearInterval(legacyInterval);
  legacyFirstTimer = null;
  legacyInterval = null;
}
