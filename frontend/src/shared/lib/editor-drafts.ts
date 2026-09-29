import { useAuthStore } from '../../stores/auth-store';

/**
 * Local (non-collaborative) editor drafts, kept in localStorage per ACCOUNT.
 *
 * localStorage is shared by every account that signs in to the same browser
 * profile, so a draft is stored under the signed-in user's id
 * (`draft:u:<userId>:<draftKey>`) and is only ever read back for that same
 * id. With no signed-in user nothing is read or written. This module is the
 * only place that builds a draft storage key.
 *
 * Lifecycle:
 * - An explicit sign-out (`discardDraftsOnSignOut`, called by `logoutApi`)
 *   deletes the signing-out user's drafts and every legacy unscoped key,
 *   advances the sign-out epoch so pending autosaves are dropped, and marks
 *   the user signed out so no draft is started or written for them until
 *   their session is established again (`forgetDraftSignOut`, called by
 *   `setAuth` on sign-in and token refresh). The signing-out tab is fenced
 *   synchronously; other tabs are fenced once the epoch and marker writes are
 *   visible to them — browsers may replicate localStorage asynchronously
 *   between tabs in different processes, so a write in that sub-millisecond
 *   window can survive, but only under the signed-out user's own scope.
 * - Any other session loss (refresh failure, expiry → `clearAuth`) keeps the
 *   user's drafts, so the same user can restore them after signing back in.
 * - Legacy `draft:<key>` entries written before drafts were scoped are never
 *   read; `purgeLegacyDrafts` deletes them at app start.
 */

const DRAFT_PREFIX = 'draft:';
const SCOPED_PREFIX = 'draft:u:';
// Shared by every tab of the origin, so a sign-out in one tab fences the
// pending autosaves of the others before their logout broadcast arrives.
const SIGN_OUT_EPOCH_KEY = 'compendiq-draft-signout-epoch';
// Per-user marker, also shared by every tab: a tab that has not yet processed
// the logout still believes the user is signed in, and an edit it starts in
// that window captures the NEW epoch — the marker is what refuses it.
const SIGNED_OUT_PREFIX = 'compendiq-draft-signedout:';

let signOutEpochInMemory = 0;

// Storage keys whose pending write must be dropped because the parent cleared
// the draft (page saved or edit discarded). A fresh edit re-arms the key.
const suppressedKeys = new Set<string>();

/** Who an edit belonged to when it was made; see `persistDraft`. */
export interface PendingDraft {
  readonly storageKey: string;
  readonly userId: string;
  readonly signOutEpoch: string;
}

/** Logical draft name of a page's body. */
export function pageDraftKey(pageId: string): string {
  return `page-${pageId}`;
}

function userPrefix(userId: string): string {
  return `${SCOPED_PREFIX}${encodeURIComponent(userId)}:`;
}

function draftStorageKey(userId: string, draftKey: string): string {
  return `${userPrefix(userId)}${draftKey}`;
}

function signedInUserId(): string | null {
  const { isAuthenticated, user } = useAuthStore.getState();
  return isAuthenticated && user?.id ? user.id : null;
}

function readSignOutEpoch(): string {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(SIGN_OUT_EPOCH_KEY);
  } catch { /* storage unavailable — the in-memory half still fences this tab */ }
  return `${signOutEpochInMemory}|${stored ?? ''}`;
}

function signedOutMarkerKey(userId: string): string {
  return `${SIGNED_OUT_PREFIX}${encodeURIComponent(userId)}`;
}

function hasSignedOut(userId: string): boolean {
  try {
    return localStorage.getItem(signedOutMarkerKey(userId)) !== null;
  } catch {
    return false; // storage unavailable — no draft can be written either
  }
}

function removeDraftKeys(shouldRemove: (key: string) => boolean): void {
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key?.startsWith(DRAFT_PREFIX) && shouldRemove(key)) doomed.push(key);
    }
    for (const key of doomed) localStorage.removeItem(key);
  } catch { /* storage unavailable — nothing to remove */ }
}

function isLegacyDraftKey(key: string): boolean {
  return !key.startsWith(SCOPED_PREFIX);
}

/** The signed-in user's draft for `draftKey`, or null. */
export function readDraft(draftKey: string): string | null {
  const userId = signedInUserId();
  if (!userId) return null;
  try {
    return localStorage.getItem(draftStorageKey(userId, draftKey));
  } catch {
    return null;
  }
}

/**
 * Delete the signed-in user's draft for `draftKey` and drop any pending write
 * of it (the page was saved or the edit discarded).
 */
export function clearDraft(draftKey: string): void {
  const userId = signedInUserId();
  if (!userId) return;
  const storageKey = draftStorageKey(userId, draftKey);
  try {
    localStorage.removeItem(storageKey);
  } catch { /* ignore */ }
  suppressedKeys.add(storageKey);
}

/**
 * Record who is making an edit, at the moment it is made. Returns null when
 * no user is signed in, or when this user has signed out explicitly (in any
 * tab) since: that edit is never persisted.
 */
export function beginDraftEdit(draftKey: string): PendingDraft | null {
  const userId = signedInUserId();
  if (!userId || hasSignedOut(userId)) return null;
  const storageKey = draftStorageKey(userId, draftKey);
  // Fresh edits mean there is unsaved work again — allow it to be written.
  suppressedKeys.delete(storageKey);
  return { storageKey, userId, signOutEpoch: readSignOutEpoch() };
}

/**
 * Write a pending edit (debounced autosave or unmount flush) under the scope
 * captured by `beginDraftEdit`. Dropped when the draft was cleared since, when
 * any tab signed out explicitly since, when the edit's user has signed out and
 * not back in, or when a different user is now signed in. A session that
 * merely ended keeps the write, in its own user's scope. `serialize` runs
 * only when the write goes ahead.
 */
export function persistDraft(pending: PendingDraft, serialize: () => string | null | undefined): void {
  if (suppressedKeys.has(pending.storageKey)) return;
  if (readSignOutEpoch() !== pending.signOutEpoch) return;
  if (hasSignedOut(pending.userId)) return;
  const currentUserId = signedInUserId();
  if (currentUserId !== null && currentUserId !== pending.userId) return;
  try {
    const html = serialize();
    if (html != null) localStorage.setItem(pending.storageKey, html);
  } catch { /* quota exceeded — ignore */ }
}

/**
 * Explicit sign-out completed: discard `userId`'s drafts and every legacy
 * unscoped draft, fence all pending writes captured before now, and refuse
 * new drafts for `userId` until that user signs in again.
 */
export function discardDraftsOnSignOut(userId: string | null): void {
  signOutEpochInMemory += 1;
  try {
    localStorage.setItem(SIGN_OUT_EPOCH_KEY, `${Date.now()}.${Math.random()}`);
    if (userId) localStorage.setItem(signedOutMarkerKey(userId), '1');
  } catch { /* the in-memory epoch still fences this tab */ }
  const prefix = userId ? userPrefix(userId) : null;
  removeDraftKeys((key) => isLegacyDraftKey(key) || (prefix !== null && key.startsWith(prefix)));
}

/** `userId` has a live session (sign-in or token refresh): their drafts may be kept again. */
export function forgetDraftSignOut(userId: string): void {
  try {
    localStorage.removeItem(signedOutMarkerKey(userId));
  } catch { /* storage unavailable — nothing to forget */ }
}

/** Delete drafts written before they were scoped to an account. */
export function purgeLegacyDrafts(): void {
  removeDraftKeys(isLegacyDraftKey);
}
