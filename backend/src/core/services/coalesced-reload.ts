/**
 * Serialized, coalesced reloads of one cached value (#1758).
 *
 * A process cache that is refreshed from PostgreSQL by several triggers (cold
 * load, cache-bus event, bus reconnect, poll, the writer that just committed)
 * must not let two reads overlap: SELECTs on different pooled connections can
 * finish in any order, so "whichever read finishes last wins" can leave the
 * cache on an older row with nothing re-reading it. A reloader runs at most
 * one read at a time and folds every request that arrives meanwhile into a
 * single follow-up read, so the last applied read always started after the
 * last request and observes the latest committed write.
 *
 * Contract of the function returned by `createCoalescedReloader` ("run" =
 * `read`, then `apply` on success):
 *
 *   S1. At most one run executes at a time per reloader.
 *   S2. A request made while a run executes joins the single queued
 *       follow-up, which starts when that run has settled. N overlapping
 *       requests cause exactly one follow-up; without a new request nothing
 *       further runs.
 *   S3. The promise returned to a requester settles only after a run that
 *       STARTED AT OR AFTER the request has settled, and carries that run's
 *       outcome. A caller that awaits a reload after its own write therefore
 *       observes that write.
 *   S4. A failed run (`read` rejected or timed out, or `apply` threw) calls
 *       `onFailure(err, phase)` and changes nothing; a queued follow-up still
 *       runs.
 *   S5. A `read` that has not settled after `readTimeoutMs` is abandoned: the
 *       run fails per S4, and if the read settles later its result is
 *       discarded and never applied. The timer is cleared on settle and
 *       unref'd, so it never keeps the process alive.
 *   S6. The returned promise never rejects.
 *   S7. A follow-up runs with the phase of the first request that queued it
 *       (the phase is diagnostic only: it reaches `apply` and `onFailure`).
 *   S8. `apply` is synchronous and performs no I/O; the reloader does not
 *       await anything it returns. Side effects that need I/O run in the
 *       caller after the awaited reload, outside the serialized section, so
 *       nothing unbounded can hold the reloader.
 *   S9. Every requester of one run receives the same outcome object, and for
 *       an applied run `outcome.value` is the very object `read` resolved
 *       with (never copied), so a caller can key a once-per-run side effect
 *       on it. There is deliberately no post-run hook.
 *
 * With S5 the issue's "at most one DB read in flight" becomes "at most one
 * non-abandoned read in flight" (D-1758-2): an abandoned read can never
 * apply, so the ordering argument above still holds, and a hung read stops
 * the value from reloading for at most `readTimeoutMs` instead of
 * indefinitely.
 *
 * Dependency-free on purpose: `cached-setting.ts`, `collab-flag.ts`,
 * `ai-policy-activation.ts` and the SMTP reload share it.
 */

/** Default bound on one `read` (D-1758-2). */
export const RELOAD_READ_TIMEOUT_MS = 30_000;

/** Result of one run: the applied value, or `{ ok: false }` when the run failed. */
export type ReloadOutcome<V> = { ok: true; value: V } | { ok: false };

export function createCoalescedReloader<V, P extends string = string>(opts: {
  /** Read and parse the authoritative value. May reject. Must not change module state. */
  read: () => Promise<V>;
  /** Commit a successful read: assign the cache. Synchronous; must not perform or await I/O (S8). */
  apply: (value: V, phase: P) => void;
  /** Soft-fail hook: the previous value stays; log here. Must not throw. */
  onFailure: (err: unknown, phase: P) => void;
  /** A read that has not settled after this long is abandoned. Default RELOAD_READ_TIMEOUT_MS. */
  readTimeoutMs?: number;
}): (phase: P) => Promise<ReloadOutcome<V>> {
  const readTimeoutMs = opts.readTimeoutMs ?? RELOAD_READ_TIMEOUT_MS;

  /** True from the start of a run until it has settled and handed over to the follow-up. */
  let running = false;
  /** The single queued follow-up (S2): its phase (S7) and how to settle its joined requesters. */
  let followUp: { phase: P; settle: (outcome: ReloadOutcome<V>) => void; outcome: Promise<ReloadOutcome<V>> } | null = null;

  /** `opts.read()` bounded by `readTimeoutMs` (S5). A late settle after the timeout is a no-op. */
  function boundedRead(): Promise<V> {
    return new Promise<V>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`reload read did not settle within ${readTimeoutMs} ms — abandoned`));
      }, readTimeoutMs);
      timer.unref();
      const settle = (fn: () => void) => { clearTimeout(timer); fn(); };
      let pending: Promise<V>;
      try {
        pending = opts.read();
      } catch (err) {
        settle(() => reject(err));
        return;
      }
      pending.then(
        (value) => settle(() => resolve(value)),
        (err: unknown) => settle(() => reject(err)),
      );
    });
  }

  function fail(err: unknown, phase: P): ReloadOutcome<V> {
    try {
      opts.onFailure(err, phase);
    } catch {
      // onFailure must not throw; swallowing keeps S6 and the queue intact.
    }
    return { ok: false };
  }

  async function runOnce(phase: P): Promise<ReloadOutcome<V>> {
    let value: V;
    try {
      value = await boundedRead();
    } catch (err) {
      return fail(err, phase);
    }
    try {
      opts.apply(value, phase); // S8: synchronous, never awaited
    } catch (err) {
      return fail(err, phase);
    }
    return { ok: true, value };
  }

  /** Start a run now. When it settles, start the queued follow-up (if any) before anyone resumes. */
  function startRun(phase: P): Promise<ReloadOutcome<V>> {
    running = true;
    const run = runOnce(phase); // never rejects: every throw is routed through fail()
    void run.then(() => {
      running = false;
      const next = followUp;
      if (next) {
        followUp = null;
        void startRun(next.phase).then(next.settle);
      }
    });
    return run;
  }

  return function requestReload(phase: P): Promise<ReloadOutcome<V>> {
    if (!running) return startRun(phase);
    if (!followUp) {
      let settle!: (outcome: ReloadOutcome<V>) => void;
      const outcome = new Promise<ReloadOutcome<V>>((resolve) => { settle = resolve; });
      followUp = { phase, settle, outcome };
    }
    return followUp.outcome;
  };
}
