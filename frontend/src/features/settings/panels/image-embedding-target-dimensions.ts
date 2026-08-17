import {
  IMAGE_EMBEDDING_TARGET_DIMENSIONS_MIN,
  IMAGE_EMBEDDING_TARGET_DIMENSIONS_MAX,
} from '@compendiq/contracts';

/**
 * #1115 — clamp the MRL truncation width to the contract's own bounds.
 *
 * One definition, two callers, deliberately not copied. The field
 * (`ImageEmbeddingCapability`) clamps on **blur**, so the number on screen is
 * the number that will be sent; `LlmTab` clamps again before it diffs and PUTs,
 * because a save can be reached without a blur (a click straight from the field
 * under jsdom, a keyboard path, a browser that skipped the event) and
 * `min`/`max` on a bare `type="number"` input constrain nothing about the value
 * read back off `e.target.value` — an out-of-range entry otherwise reached
 * `ImageEmbeddingTargetDimensionsSchema` and came back as a raw Zod issue path
 * ("imageEmbeddingTargetDimensions: Too small: expected number to be >=64")
 * instead of the panel's own sentence. The clamp is idempotent, so running it
 * twice costs nothing.
 *
 * Clamping on blur rather than per keystroke is what keeps the field typeable:
 * rewriting `4` to `64` mid-entry makes `4000` — the largest indexable width,
 * and the one the unindexed note tells the operator to enter — unreachable from
 * an empty field.
 *
 * Its own module rather than an export beside the component: `react-refresh`
 * refuses a file that exports both components and functions.
 */
export function clampImageEmbeddingTargetDimensions(value: number | null): number | null {
  if (value === null) return null;
  return Math.max(
    IMAGE_EMBEDDING_TARGET_DIMENSIONS_MIN,
    Math.min(IMAGE_EMBEDDING_TARGET_DIMENSIONS_MAX, value),
  );
}
