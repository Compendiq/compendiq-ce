// backend/src/domains/llm/services/cache-bus.ts
let version = 0;
type Listener = (v: number) => void;
const listeners = new Set<Listener>();

export function bumpProviderCacheVersion(): void {
  version += 1;
  for (const l of listeners) l(version);
}
export function getProviderCacheVersion(): number { return version; }
export function onProviderCacheBump(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

// ─── Provider deletion (issue #267) ──────────────────────────────────────────
// Carries the deleted providerId so subscribers can drop per-id resources
// (circuit breakers, undici dispatchers, config-cache entries) that a plain
// `bumpProviderCacheVersion()` would miss. The bump listener only iterates
// the resolver's `configCache`; a provider whose breaker was created via
// "Test connection" before any use-case assignment is NOT in that cache and
// would otherwise leak forever. Emitted only from `deleteProvider()`.
type DeletedListener = (id: string) => void;
const deletedListeners = new Set<DeletedListener>();

export function emitProviderDeleted(id: string): void {
  for (const l of deletedListeners) l(id);
}
export function onProviderDeleted(l: DeletedListener): () => void {
  deletedListeners.add(l);
  return () => deletedListeners.delete(l);
}
