/**
 * Storage-derivation features (#1953, epic #2027).
 *
 * A version restore derives the storage it sends to Confluence from a stored
 * historical `body_html`, records only a digest of the result in its write
 * intent, and derives it again when it publishes — in the request, or in a
 * recovery that may run on a later release (page-put-intent-reconciler.ts).
 * A change to what the write-back derives from the same stored HTML would
 * leave such an intent with a digest no release can reproduce.
 *
 * So every change of that kind is a named feature. A restore intent records
 * the names in force when it was reserved and is recovered with exactly that
 * set; an intent without the record was reserved before the first feature and
 * is recovered with none. Each feature's step is gated with
 * {@link derivationHas}, in the reverse pass and in any forward conversion the
 * write-back itself runs (`storedTasks`), so the empty set keeps writing what
 * the write-back wrote before the first feature
 * (`__fixtures__/storage-derivation-base-corpus.ts`).
 *
 * Every other writer derives with all features and passes nothing.
 */

/**
 * The registered features. Append only: a name that has shipped stays, since
 * a pending intent may record it. A name is 1–32 characters of `a-z`, `0-9`
 * and `-`, starting with a letter; at most 16 names.
 */
export const STORAGE_DERIVATION_FEATURES = ['nested-tasks'] as const satisfies readonly string[];

export type StorageDerivationFeature = (typeof STORAGE_DERIVATION_FEATURES)[number];
export type StorageDerivationFeatures = ReadonlySet<StorageDerivationFeature>;

/** The key of a `page.version_restore` intent effect that records its features. */
export const STORAGE_DERIVATION_EFFECT_KEY = 'derivationFeatures';

const FEATURE_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_FEATURES = 16;

export type DecodedStorageDerivation<F extends string> =
  | { ok: true; features: ReadonlySet<F> }
  /** `malformed`: not a recorded set at all. `unknown`: a well-formed set that names a feature not registered here. */
  | { ok: false; reason: 'malformed' | 'unknown' };

export interface StorageDerivationRegistry<F extends string> {
  /** Every registered feature: what a writer derives with when it states no set. */
  readonly all: ReadonlySet<F>;
  /** No feature: the derivation before the first one. */
  readonly none: ReadonlySet<F>;
  /** Whether a step gated on `feature` runs; `undefined` means every registered feature. */
  has(features: ReadonlySet<F> | undefined, feature: F): boolean;
  /** The recorded form: the names in ascending order, or `undefined` for the empty set (no key is written). */
  encode(features: ReadonlySet<F>): string[] | undefined;
  /** Read a recorded form back. Only the exact output of {@link encode} is accepted. */
  decode(value: unknown): DecodedStorageDerivation<F>;
  /** Throws for a set that names a feature not registered here: its step could not be derived. */
  assert(features: ReadonlySet<string>): void;
}

/**
 * The operations over one list of registered names. The module's own exports
 * are this registry over {@link STORAGE_DERIVATION_FEATURES}; a test builds
 * one over names of its own.
 */
export function storageDerivationRegistry<const F extends string>(
  names: readonly F[],
): StorageDerivationRegistry<F> {
  if (
    names.length > MAX_FEATURES
    || names.some((name) => !FEATURE_NAME.test(name))
    || new Set(names).size !== names.length
  ) {
    throw new Error('Invalid storage-derivation feature registration');
  }
  const all: ReadonlySet<F> = new Set(names);
  const none: ReadonlySet<F> = new Set();
  const registered: ReadonlySet<string> = all;
  return {
    all,
    none,
    has: (features, feature) => features === undefined || features.has(feature),
    encode: (features) => (features.size === 0 ? undefined : [...features].sort()),
    decode: (value) => {
      if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FEATURES) {
        return { ok: false, reason: 'malformed' };
      }
      const recorded: unknown[] = value;
      for (const [index, name] of recorded.entries()) {
        const previous = recorded[index - 1];
        if (
          typeof name !== 'string'
          || !FEATURE_NAME.test(name)
          // Strictly ascending: one spelling per set, no repeated name.
          || (typeof previous === 'string' && previous >= name)
        ) {
          return { ok: false, reason: 'malformed' };
        }
      }
      if (recorded.some((name) => !registered.has(name as string))) return { ok: false, reason: 'unknown' };
      return { ok: true, features: new Set(recorded as F[]) };
    },
    assert: (features) => {
      for (const name of features) {
        if (!registered.has(name)) throw new Error('Storage derivation names an unregistered feature');
      }
    },
  };
}

const registry = storageDerivationRegistry(STORAGE_DERIVATION_FEATURES);

/** Every registered feature. A writer that passes no set derives with these. */
export const ALL_STORAGE_DERIVATION_FEATURES: StorageDerivationFeatures = registry.all;

/**
 * No feature: the derivation of `origin/dev` bff6d4ec, the release before the
 * first feature. A restore intent that records no set is recovered with this.
 */
export const NO_STORAGE_DERIVATION_FEATURES: StorageDerivationFeatures = registry.none;

/**
 * Whether the step of `feature` runs for a write-back that derives with
 * `features`. `undefined` is a writer that states no set: every registered
 * feature.
 */
export function derivationHas(
  features: StorageDerivationFeatures | undefined,
  feature: StorageDerivationFeature,
): boolean {
  return registry.has(features, feature);
}

/** The names a restore intent records, ascending; `undefined` for the empty set, which records no key. */
export function encodeStorageDerivationFeatures(features: StorageDerivationFeatures): string[] | undefined {
  return registry.encode(features);
}

/** The set a restore intent recorded under {@link STORAGE_DERIVATION_EFFECT_KEY}. */
export function decodeStorageDerivationFeatures(value: unknown): DecodedStorageDerivation<StorageDerivationFeature> {
  return registry.decode(value);
}

/**
 * Refuse a set that names a feature this release does not register. The
 * converter checks the set of every write-back and of every forward
 * conversion a write-back runs, so neither can derive with a name it would
 * silently ignore.
 */
export function assertStorageDerivationFeatures(features: ReadonlySet<string>): void {
  registry.assert(features);
}
