/**
 * Serialise a number to `admin_settings` **without exponent notation**.
 *
 * `String(n)` switches to exponent notation below 1e-6 — `String(5e-7)` is
 * `'5e-7'` — and every strict-shape parser guarding a retrieval knob rejects
 * that string:
 *
 *   - `readConfidenceThreshold`   `/^\d*\.?\d+$/`
 *   - `getRagRankingPriorWeight`  `/^\d+(\.\d+)?$/`
 *   - `getRagMmrConfig`'s lambda  `/^-?\d+(\.\d+)?$/`
 *
 * Those rejections are deliberate (`'0,35'` parseFloats to an in-range `0`
 * that silently disables a gate), and they are also silent from the panel's
 * side: the write succeeds, the reader logs a warning nobody is watching and
 * keeps the DEFAULT. An operator would set a very small prior weight, see it
 * accepted, and get the stage back at 0 — a value they could not distinguish
 * from "I typed it wrong".
 *
 * The exponent is expanded from `String(n)`'s digits rather than via
 * `toFixed()`, so the result round-trips back to exactly the same double.
 * `toFixed(20)` would silently round anything below 1e-20 to `'0'`, which is
 * the same class of bug one order of magnitude further down.
 */
export function toFixedDecimalString(n: number): string {
  const s = String(n);
  const m = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/i.exec(s);
  if (!m) return s;

  const sign = m[1] ?? '';
  const intPart = m[2] ?? '0';
  const fracPart = m[3] ?? '';
  const exponent = Number(m[4]);

  const digits = intPart + fracPart;
  // Where the decimal point lands once the exponent is applied.
  const pointPos = intPart.length + exponent;

  if (pointPos <= 0) return `${sign}0.${'0'.repeat(-pointPos)}${digits}`;
  if (pointPos >= digits.length) return `${sign}${digits}${'0'.repeat(pointPos - digits.length)}`;
  return `${sign}${digits.slice(0, pointPos)}.${digits.slice(pointPos)}`;
}
