/**
 * Normalise an all-digits page identifier for comparison against `id::text`.
 *
 * The dual-arm page lookups (`confluence_id = $1 OR id::text = $2`) compare the
 * *column* as text so a Confluence content id above 2^31 cannot overflow the
 * int4 cast (#1167). But text comparison is literal where the old `$1::int`
 * cast was numeric: Postgres parsed `'007'::int` as `7` and matched page 7,
 * whereas `(7)::text = '007'` is false. Without normalising, the overflow fix
 * would silently stop resolving zero-padded ids — a 404 (or, on page create, a
 * bogus parent id forwarded upstream to Confluence) instead of the right row.
 *
 * `BigInt` reproduces the old cast's normalisation exactly and, unlike
 * `parseInt`/`Number`, has no precision ceiling — which is the whole point
 * here, since the ids that motivated #1167 are the ones int4 can't hold.
 *
 * @param id an identifier already known to match `/^\d+$/`
 * @returns the same value with leading zeros stripped (`'007'` → `'7'`)
 */
export function toPageIdText(id: string): string {
  return String(BigInt(id));
}
