/**
 * The one absolute date stamp for status readouts ("Verified Sep 28, 2026",
 * "Indexed Aug 24, 2026", "Analyzed …"). Locale-aware, day precision, and it
 * always carries the year: the inspector used to print three formats side by
 * side ("Sep 28", "8/24/2026", "9/13/2026, 12:07:44 PM"), so a reader could not
 * tell which stamp was the older one. Time-of-day belongs in a `title`.
 */
export function formatDateStamp(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);

  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return formatDateStamp(dateStr);
}
