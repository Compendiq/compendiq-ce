/**
 * Parse an integer from an untrusted string (env var or admin_settings value),
 * falling back to a default when the value is missing, non-numeric, or out of
 * range. Plain `parseInt(x) ?? fallback` does NOT catch `NaN` (?? only catches
 * null/undefined), and `parseInt(x) || fallback` wrongly rejects a valid `0`.
 * This guards both: a `NaN`/garbage value can't silently flow downstream (e.g.
 * a `NaN` timeout makes `elapsed > NaN` always false → an infinite wait).
 *
 * @param raw      the raw string (e.g. process.env.X or a DB setting_value)
 * @param fallback value to use when `raw` is absent/invalid/below `min`
 * @param min      minimum accepted value (default 1; pass 0 to allow zero)
 */
export function safeIntOr(
  raw: string | undefined | null,
  fallback: number,
  min = 1,
): number {
  const n = parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}
