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
