/** Decode database revisions without rounding PostgreSQL bigint values.
 * Numeric wire contracts cannot represent revisions above MAX_SAFE_INTEGER;
 * refuse them rather than aliasing two different CAS tokens or evidence rows.
 */
export function exactAiPolicyRevision(value: unknown): bigint | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  }
  if (typeof value === 'bigint') return value >= 0n ? value : null;
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
  return BigInt(value);
}

export function safeAiPolicyRevision(value: unknown): number | null {
  const exact = exactAiPolicyRevision(value);
  return exact !== null && exact <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(exact) : null;
}
