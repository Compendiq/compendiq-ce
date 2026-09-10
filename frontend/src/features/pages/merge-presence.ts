import type { PresenceViewer } from './use-presence';

export interface CollabAwarenessUser {
  id: string;
  name: string;
  color: string;
}

/**
 * Unify #301 SSE viewers with Yjs awareness. Pencil = collab-room membership
 * when awareness is non-empty; SSE `isEditing` is ignored for anyone in the
 * room. Merge by userId. Caller hides self before calling.
 */
export function mergePresence(
  sseViewers: PresenceViewer[],
  awareness: Iterable<CollabAwarenessUser>,
): PresenceViewer[] {
  const byId = new Map<string, PresenceViewer>();
  for (const v of sseViewers) {
    byId.set(v.userId, { ...v, isEditing: false });
  }
  for (const a of awareness) {
    const prev = byId.get(a.id);
    byId.set(a.id, {
      userId: a.id,
      name: a.name,
      role: prev?.role ?? '',
      isEditing: true,
      avatarUrl: prev?.avatarUrl,
      caretColor: a.color,
    });
  }
  return [...byId.values()].sort((a, b) => {
    if (a.isEditing !== b.isEditing) return a.isEditing ? -1 : 1;
    return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;
  });
}
