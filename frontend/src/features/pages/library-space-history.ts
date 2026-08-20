const STORAGE_KEY = 'compendiq:library-recent-spaces';
const MAX_RECENT_SPACES = 3;

function normalizeSpaceKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((key): key is string => typeof key === 'string' && key.length > 0))]
    .slice(0, MAX_RECENT_SPACES);
}

export function readRecentLibrarySpaces(): string[] {
  try {
    return normalizeSpaceKeys(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]'));
  } catch {
    return [];
  }
}

export function rememberRecentLibrarySpace(spaceKey: string): string[] {
  if (!spaceKey) return readRecentLibrarySpaces();
  const next = [spaceKey, ...readRecentLibrarySpaces().filter((key) => key !== spaceKey)]
    .slice(0, MAX_RECENT_SPACES);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Recent scopes are a convenience; storage failure must never block search.
  }
  return next;
}

export function forgetRecentLibrarySpaces(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing stored, nothing to forget.
  }
}
