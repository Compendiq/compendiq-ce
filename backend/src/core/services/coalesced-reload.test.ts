/**
 * #1758 — contract of `createCoalescedReloader` (S1–S9 in `coalesced-reload.ts`).
 *
 * Every read is a deferred promise the test settles explicitly, so the order
 * of reads, applies and requester resolutions is deterministic; the read
 * timeout (S5) runs on fake timers.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCoalescedReloader, RELOAD_READ_TIMEOUT_MS, type ReloadOutcome } from './coalesced-reload.js';

type Phase = 'cold-load' | 'bus' | 'poll' | 'writer';

/** A reloader whose every `read` call is a deferred the test settles. */
function harness<V = string>(opts: { readTimeoutMs?: number; apply?: (value: V, phase: Phase) => void } = {}) {
  const reads: Array<PromiseWithResolvers<V>> = [];
  let active = 0;
  let maxActive = 0;
  const read = vi.fn(() => {
    const d = Promise.withResolvers<V>();
    reads.push(d);
    active += 1;
    maxActive = Math.max(maxActive, active);
    const done = () => { active -= 1; };
    d.promise.then(done, done);
    return d.promise;
  });
  const applied: Array<{ value: V; phase: Phase }> = [];
  const apply = vi.fn((value: V, phase: Phase) => {
    applied.push({ value, phase });
    opts.apply?.(value, phase);
  });
  const onFailure = vi.fn<(err: unknown, phase: Phase) => void>();
  const reload = createCoalescedReloader<V, Phase>({ read, apply, onFailure, readTimeoutMs: opts.readTimeoutMs });
  return { reload, read, reads, apply, applied, onFailure, maxActive: () => maxActive };
}

/** Lets every queued microtask (and the chains they start) run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

/** Tracks whether a promise has settled, without awaiting it. */
function track<T>(promise: Promise<T>) {
  const state = { settled: false, value: undefined as T | undefined };
  void promise.then((value) => { state.settled = true; state.value = value; });
  return state;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('createCoalescedReloader (#1758)', () => {
  it('S1/S2: overlapping requests never overlap reads and fold into exactly one follow-up', async () => {
    const h = harness();
    const first = h.reload('bus');
    await flush();
    const joined = [h.reload('bus'), h.reload('poll'), h.reload('writer'), h.reload('bus')];
    await flush();
    expect(h.read).toHaveBeenCalledTimes(1); // the follow-up waits for the in-flight run

    h.reads[0]!.resolve('old');
    await flush();
    expect(h.read).toHaveBeenCalledTimes(2); // exactly one follow-up for four requests
    h.reads[1]!.resolve('new');
    await Promise.all([first, ...joined]);
    await flush();

    expect(h.read).toHaveBeenCalledTimes(2); // nothing further without a new request
    expect(h.maxActive()).toBe(1);
    expect(h.applied.map((a) => a.value)).toEqual(['old', 'new']);
  });

  it('S3: a request made during a run resolves only after a run that started after it, with that run\'s outcome', async () => {
    const h = harness();
    const first = track(h.reload('bus'));
    await flush();
    const second = track(h.reload('writer'));

    h.reads[0]!.resolve('before-write');
    await flush();
    expect(first.settled).toBe(true);
    expect(first.value).toEqual({ ok: true, value: 'before-write' });
    expect(second.settled).toBe(false); // the run it would have joined started before it

    h.reads[1]!.resolve('after-write');
    await flush();
    expect(second.value).toEqual({ ok: true, value: 'after-write' });
  });

  it('S3: a request after a run settled starts a fresh read instead of reusing the old result', async () => {
    const h = harness();
    const first = h.reload('bus');
    h.reads[0]!.resolve('a');
    expect(await first).toEqual({ ok: true, value: 'a' });

    const second = h.reload('writer');
    expect(h.read).toHaveBeenCalledTimes(2);
    h.reads[1]!.resolve('b');
    expect(await second).toEqual({ ok: true, value: 'b' });
  });

  it('S4: a rejected read reports onFailure, applies nothing, and the queued follow-up still runs', async () => {
    const h = harness();
    const first = h.reload('bus');
    await flush();
    const second = h.reload('poll');
    const boom = new Error('connection reset');
    h.reads[0]!.reject(boom);
    expect(await first).toEqual({ ok: false });
    expect(h.onFailure).toHaveBeenCalledWith(boom, 'bus');
    expect(h.apply).not.toHaveBeenCalled();

    await flush();
    expect(h.read).toHaveBeenCalledTimes(2);
    h.reads[1]!.resolve('recovered');
    expect(await second).toEqual({ ok: true, value: 'recovered' });
    expect(h.applied).toEqual([{ value: 'recovered', phase: 'poll' }]);
  });

  it('S4: an apply that throws is a failed run; the follow-up still runs', async () => {
    const thrown = new Error('apply rejected the value');
    const h = harness({ apply: (value) => { if (value === 'bad') throw thrown; } });
    const first = h.reload('bus');
    await flush();
    const second = h.reload('poll');
    h.reads[0]!.resolve('bad');
    expect(await first).toEqual({ ok: false });
    expect(h.onFailure).toHaveBeenCalledWith(thrown, 'bus');

    await flush();
    h.reads[1]!.resolve('good');
    expect(await second).toEqual({ ok: true, value: 'good' });
  });

  it('S5: a read that hangs is abandoned after the timeout, the follow-up runs, and the late result is never applied', async () => {
    vi.useFakeTimers();
    const h = harness({ readTimeoutMs: 1_000 });
    const first = track(h.reload('bus'));
    await flush();
    const second = track(h.reload('writer'));

    await vi.advanceTimersByTimeAsync(999);
    expect(first.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(first.value).toEqual({ ok: false });
    expect(h.onFailure).toHaveBeenCalledWith(expect.any(Error), 'bus');

    await flush();
    expect(h.read).toHaveBeenCalledTimes(2); // the follow-up is not held by the hung read
    h.reads[1]!.resolve('fresh');
    await flush();
    expect(second.value).toEqual({ ok: true, value: 'fresh' });

    h.reads[0]!.resolve('stale'); // the abandoned read finally answers
    await flush();
    expect(h.applied.map((a) => a.value)).toEqual(['fresh']);
    expect(h.onFailure).toHaveBeenCalledTimes(1);
  });

  it('S5: a late rejection of an abandoned read is swallowed (no second onFailure, no unhandled rejection)', async () => {
    vi.useFakeTimers();
    const h = harness({ readTimeoutMs: 50 });
    const first = h.reload('bus');
    await vi.advanceTimersByTimeAsync(50);
    expect(await first).toEqual({ ok: false });
    h.reads[0]!.reject(new Error('late'));
    await flush();
    expect(h.onFailure).toHaveBeenCalledTimes(1);
  });

  it('S5: defaults to RELOAD_READ_TIMEOUT_MS and clears the timer when the read settles', async () => {
    vi.useFakeTimers();
    const h = harness();
    const first = track(h.reload('bus'));
    await vi.advanceTimersByTimeAsync(RELOAD_READ_TIMEOUT_MS - 1);
    expect(first.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(first.value).toEqual({ ok: false });

    const second = h.reload('poll');
    expect(vi.getTimerCount()).toBe(1);
    h.reads[1]!.resolve('quick');
    expect(await second).toEqual({ ok: true, value: 'quick' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('S5: the read timer does not keep the process alive', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const h = harness();
    const pending = h.reload('bus');
    const timer = setTimeoutSpy.mock.results[0]!.value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
    h.reads[0]!.resolve('done');
    await pending;
  });

  it('S6: the returned promise never rejects, even when read throws synchronously and onFailure throws', async () => {
    const reload = createCoalescedReloader<string, Phase>({
      read: () => { throw new Error('sync throw'); },
      apply: () => undefined,
      onFailure: () => { throw new Error('logger exploded'); },
    });
    await expect(reload('bus')).resolves.toEqual({ ok: false });
    // The reloader is still usable afterwards.
    await expect(reload('poll')).resolves.toEqual({ ok: false });
  });

  it('S7: the follow-up runs with the phase of the first request that queued it', async () => {
    const h = harness();
    const first = h.reload('cold-load');
    await flush();
    const joined = [h.reload('poll'), h.reload('writer'), h.reload('bus')];
    h.reads[0]!.resolve('a');
    await flush();
    h.reads[1]!.reject(new Error('down'));
    await Promise.all([first, ...joined]);
    expect(h.applied).toEqual([{ value: 'a', phase: 'cold-load' }]);
    expect(h.onFailure).toHaveBeenCalledWith(expect.any(Error), 'poll');
  });

  it('S8: apply is not awaited — an apply that returns a never-settling promise does not hold the reloader', async () => {
    const reads: string[] = ['one', 'two'];
    const reload = createCoalescedReloader<string, Phase>({
      read: async () => reads.shift()!,
      // Violates S8 on purpose: the reloader must still not wait on it.
      apply: (() => new Promise<void>(() => undefined)) as unknown as (value: string) => void,
      onFailure: () => undefined,
    });
    await expect(reload('bus')).resolves.toEqual({ ok: true, value: 'one' });
    await expect(reload('bus')).resolves.toEqual({ ok: true, value: 'two' });
  });

  it('S9: every requester of one run gets the same outcome object, whose value is the object read resolved with', async () => {
    const h = harness<{ config: string }>();
    const first = h.reload('bus');
    await flush();
    const joined = [h.reload('poll'), h.reload('writer'), h.reload('bus')];
    const firstValue = { config: 'first' };
    const followUpValue = { config: 'follow-up' };
    h.reads[0]!.resolve(firstValue);
    await flush();
    h.reads[1]!.resolve(followUpValue);

    const firstOutcome = await first;
    const outcomes = await Promise.all(joined);
    expect(firstOutcome).toEqual({ ok: true, value: firstValue });
    expect((firstOutcome as Extract<ReloadOutcome<unknown>, { ok: true }>).value).toBe(firstValue);
    expect(outcomes[1]).toBe(outcomes[0]);
    expect(outcomes[2]).toBe(outcomes[0]);
    expect((outcomes[0] as Extract<ReloadOutcome<unknown>, { ok: true }>).value).toBe(followUpValue);
    expect(h.applied[1]!.value).toBe(followUpValue);
  });
});
