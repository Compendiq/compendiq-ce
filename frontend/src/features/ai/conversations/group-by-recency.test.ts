import { describe, it, expect } from 'vitest';
import { groupByRecency } from './group-by-recency';

/**
 * `groupByRecency` buckets against the VIEWER'S LOCAL calendar, so every
 * timestamp here is built with the local-time `Date(y, m, d, h, min)`
 * constructor and serialised with `toISOString()` — the round trip preserves
 * the instant, and the expectations are stated in local calendar terms, which
 * is what the function is specified in. A fixture built with `Date.UTC` would
 * pass on CI (UTC) and fail in `Europe/Berlin`; `vi.stubEnv('TZ', …)` cannot
 * rescue it either, because Node reads TZ once at process start and `Date`'s
 * zone is fixed for the whole run.
 *
 * `now` is midday so no boundary this file asserts on can land on a DST
 * transition (those happen at or near midnight), and the day arithmetic in
 * both the test and the implementation goes through the constructor's own
 * normalisation rather than subtracting 86_400_000 ms per day.
 *
 * Fixed now: Tue 18 Aug 2026, 12:00 local.
 *   start of today      = Tue 18 Aug 2026 00:00
 *   start of yesterday  = Mon 17 Aug 2026 00:00
 *   start of today - 7d = Tue 11 Aug 2026 00:00
 *   start of today -30d = Sun 19 Jul 2026 00:00
 */
const NOW = new Date(2026, 7, 18, 12, 0, 0);

/** A local-calendar instant as the wire carries it. */
function at(year: number, monthIndex: number, day: number, hour = 12, minute = 0): string {
  return new Date(year, monthIndex, day, hour, minute, 0, 0).toISOString();
}

function row(id: string, updatedAt: string): { id: string; updatedAt: string } {
  return { id, updatedAt };
}

const monthLabel = (d: Date): string =>
  new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(d);

describe('groupByRecency', () => {
  it('buckets one item per label and returns the buckets in fixed order', () => {
    const items = [
      row('today-midday', at(2026, 7, 18, 11, 0)),
      row('today-midnight', at(2026, 7, 18, 0, 0)),
      row('yesterday-late', at(2026, 7, 17, 23, 59)),
      row('yesterday-early', at(2026, 7, 17, 0, 1)),
      row('seven-boundary', at(2026, 7, 11, 0, 0)),
      row('just-past-seven', at(2026, 7, 10, 23, 59)),
      row('thirty-boundary', at(2026, 6, 19, 0, 0)),
      row('july', at(2026, 6, 18, 23, 59)),
      row('june', at(2026, 5, 2, 9, 0)),
    ];

    const groups = groupByRecency(items, NOW);

    expect(groups.map((g) => g.label)).toEqual([
      'Today',
      'Yesterday',
      'Previous 7 days',
      'Previous 30 days',
      monthLabel(new Date(2026, 6, 18)),
      monthLabel(new Date(2026, 5, 2)),
    ]);
    expect(groups.map((g) => g.items.map((i) => i.id))).toEqual([
      ['today-midday', 'today-midnight'],
      ['yesterday-late', 'yesterday-early'],
      ['seven-boundary'],
      ['just-past-seven', 'thirty-boundary'],
      ['july'],
      ['june'],
    ]);
  });

  it('puts an item at 00:00 today in Today and 23:59 yesterday in Yesterday', () => {
    const groups = groupByRecency(
      [row('midnight-today', at(2026, 7, 18, 0, 0)), row('last-minute-yesterday', at(2026, 7, 17, 23, 59))],
      NOW,
    );
    expect(groups).toEqual([
      { label: 'Today', items: [row('midnight-today', at(2026, 7, 18, 0, 0))] },
      { label: 'Yesterday', items: [row('last-minute-yesterday', at(2026, 7, 17, 23, 59))] },
    ]);
  });

  it('treats start-of-today minus seven days as inclusive and the minute before it as older', () => {
    const groups = groupByRecency(
      [row('on-the-boundary', at(2026, 7, 11, 0, 0)), row('one-minute-older', at(2026, 7, 10, 23, 59))],
      NOW,
    );
    expect(groups.map((g) => g.label)).toEqual(['Previous 7 days', 'Previous 30 days']);
    expect(groups[0]?.items.map((i) => i.id)).toEqual(['on-the-boundary']);
    expect(groups[1]?.items.map((i) => i.id)).toEqual(['one-minute-older']);
  });

  it('treats start-of-today minus thirty days as inclusive and the minute before it as a month bucket', () => {
    const groups = groupByRecency(
      [row('on-the-boundary', at(2026, 6, 19, 0, 0)), row('one-minute-older', at(2026, 6, 18, 23, 59))],
      NOW,
    );
    expect(groups.map((g) => g.label)).toEqual(['Previous 30 days', monthLabel(new Date(2026, 6, 18))]);
  });

  it('labels month buckets with month + numeric year and keeps them newest first', () => {
    const groups = groupByRecency(
      [
        row('july-late', at(2026, 6, 18, 10, 0)),
        row('july-early', at(2026, 6, 2, 10, 0)),
        row('june', at(2026, 5, 20, 10, 0)),
        row('december', at(2025, 11, 24, 10, 0)),
      ],
      NOW,
    );
    expect(groups.map((g) => g.label)).toEqual([
      monthLabel(new Date(2026, 6, 18)),
      monthLabel(new Date(2026, 5, 20)),
      monthLabel(new Date(2025, 11, 24)),
    ]);
    expect(groups[0]?.items.map((i) => i.id)).toEqual(['july-late', 'july-early']);
    // The label carries a four-digit year, so December 2025 can never read the
    // same as December 2026 in a pane that has both.
    expect(groups[2]?.label).toContain('2025');
    expect(groups[0]?.label).toContain('2026');
  });

  it('omits empty buckets', () => {
    const groups = groupByRecency([row('june', at(2026, 5, 2, 9, 0))], NOW);
    expect(groups.map((g) => g.label)).toEqual([monthLabel(new Date(2026, 5, 2))]);
  });

  it('returns nothing for an empty list', () => {
    expect(groupByRecency([], NOW)).toEqual([]);
  });

  it('puts a future updatedAt (clock skew) in Today', () => {
    const groups = groupByRecency([row('skewed', at(2026, 7, 19, 9, 0))], NOW);
    expect(groups.map((g) => g.label)).toEqual(['Today']);
    expect(groups[0]?.items.map((i) => i.id)).toEqual(['skewed']);
  });

  it('puts an unparseable updatedAt in Today rather than throwing out of Intl', () => {
    const groups = groupByRecency([row('broken', 'not-a-date')], NOW);
    expect(groups.map((g) => g.label)).toEqual(['Today']);
    expect(groups[0]?.items.map((i) => i.id)).toEqual(['broken']);
  });

  it('preserves the server order inside a bucket', () => {
    const groups = groupByRecency(
      [
        row('first', at(2026, 7, 18, 11, 0)),
        row('second', at(2026, 7, 18, 10, 0)),
        row('third', at(2026, 7, 18, 9, 0)),
      ],
      NOW,
    );
    expect(groups[0]?.items.map((i) => i.id)).toEqual(['first', 'second', 'third']);
  });
});
