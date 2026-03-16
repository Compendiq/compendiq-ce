/**
 * One-time localStorage key migration for the ai-kb-creator → AtlasMind rebrand.
 *
 * If the old key exists and the new key does not, copies the value over and
 * removes the old key. This preserves user theme/auth/UI state across the rename.
 *
 * Safe to call multiple times — it's a no-op once the old key is gone.
 */
export function migrateStorageKey(oldKey: string, newKey: string): void {
  try {
    const existing = localStorage.getItem(newKey);
    if (existing) return; // new key already populated — nothing to do

    const legacy = localStorage.getItem(oldKey);
    if (legacy) {
      localStorage.setItem(newKey, legacy);
      localStorage.removeItem(oldKey);
    }
  } catch {
    // localStorage unavailable (SSR, private browsing quota, etc.) — ignore
  }
}
