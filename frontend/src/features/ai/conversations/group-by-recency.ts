/**
 * Recency buckets for the conversations pane (#1361 PR 2).
 *
 * The group heading IS the timestamp — rows carry no date of their own — so the
 * buckets are read against the viewer's LOCAL calendar rather than against a
 * rolling 24-hour window: a conversation from 23:50 last night belongs under
 * "Yesterday" at 00:10 this morning, not under "Today".
 *
 * Items arrive `updated_at DESC` from the keyset list, so this is a single pass
 * that appends and never sorts: order inside a bucket is the server's, and the
 * month buckets come out newest-first because that is the order they are first
 * encountered in.
 */

export interface RecencyGroup<T> {
  label: string;
  items: T[];
}

const TODAY_LABEL = 'Today';
const YESTERDAY_LABEL = 'Yesterday';
const PREVIOUS_7_LABEL = 'Previous 7 days';
const PREVIOUS_30_LABEL = 'Previous 30 days';

/**
 * Local midnight `days` calendar days before `d`'s day. The constructor
 * normalises out-of-range day numbers (`new Date(2026, 7, -12)` is 19 Jul 2026)
 * and re-resolves the zone offset for the resulting day, which subtracting
 * `days * 86_400_000` ms does not — that form is an hour out across every DST
 * change and would mis-bucket one week a year.
 */
function startOfDayBefore(d: Date, days: number): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - days).getTime();
}

export function groupByRecency<T extends { updatedAt: string }>(
  items: readonly T[],
  now: Date,
): RecencyGroup<T>[] {
  const startToday = startOfDayBefore(now, 0);
  const startYesterday = startOfDayBefore(now, 1);
  const startPrevious7 = startOfDayBefore(now, 7);
  const startPrevious30 = startOfDayBefore(now, 30);

  const today: T[] = [];
  const yesterday: T[] = [];
  const previous7: T[] = [];
  const previous30: T[] = [];
  const months = new Map<string, T[]>();

  // One formatter for the whole pass, built only if a month bucket is reached —
  // constructing an Intl object is the expensive part, and most panes never
  // hold anything older than thirty days.
  let monthFormat: Intl.DateTimeFormat | undefined;

  for (const item of items) {
    const at = new Date(item.updatedAt);
    const time = at.getTime();

    // A row whose timestamp does not parse must not take the pane down:
    // `Intl.DateTimeFormat.format(new Date(NaN))` throws RangeError. Today is
    // where an undatable row is least surprising in a newest-first list, and it
    // is the same bucket clock skew lands in.
    if (Number.isNaN(time) || time >= startToday) {
      today.push(item);
      continue;
    }
    if (time >= startYesterday) {
      yesterday.push(item);
      continue;
    }
    if (time >= startPrevious7) {
      previous7.push(item);
      continue;
    }
    if (time >= startPrevious30) {
      previous30.push(item);
      continue;
    }

    monthFormat ??= new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });
    const label = monthFormat.format(at);
    const bucket = months.get(label);
    if (bucket) bucket.push(item);
    else months.set(label, [item]);
  }

  const groups: RecencyGroup<T>[] = [];
  if (today.length > 0) groups.push({ label: TODAY_LABEL, items: today });
  if (yesterday.length > 0) groups.push({ label: YESTERDAY_LABEL, items: yesterday });
  if (previous7.length > 0) groups.push({ label: PREVIOUS_7_LABEL, items: previous7 });
  if (previous30.length > 0) groups.push({ label: PREVIOUS_30_LABEL, items: previous30 });
  // Map preserves insertion order, and insertion order is encounter order,
  // which is newest-first for a `updated_at DESC` list.
  for (const [label, bucket] of months) groups.push({ label, items: bucket });
  return groups;
}
