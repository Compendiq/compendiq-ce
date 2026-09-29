import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../../stores/auth-store';
import {
  beginDraftEdit,
  discardDraftsOnSignOut,
  persistDraft,
  purgeLegacyDrafts,
  readDraft,
} from './editor-drafts';

const ALICE = { id: 'alice-id', username: 'alice', role: 'user' as const };
const BOB = { id: 'bob-id', username: 'bob', role: 'user' as const };
const CAROL = { id: 'carol-id', username: 'carol', role: 'user' as const };

function signIn(user: typeof ALICE) {
  useAuthStore.getState().setAuth(`jwt-${user.id}`, user);
}

function writeDraftAs(user: typeof ALICE, draftKey: string, html: string) {
  signIn(user);
  const pending = beginDraftEdit(draftKey);
  if (!pending) throw new Error('expected a signed-in draft scope');
  persistDraft(pending, () => html);
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  useAuthStore.getState().clearAuth();
  localStorage.clear();
});

describe('editor drafts', () => {
  it('neither reads nor writes a draft while nobody is signed in', () => {
    writeDraftAs(ALICE, 'page-1', '<p>alice</p>');
    useAuthStore.getState().clearAuth();

    expect(readDraft('page-1')).toBeNull();
    expect(beginDraftEdit('page-1')).toBeNull();
  });

  it('drops a pending edit once a different account is signed in, in either scope', () => {
    signIn(ALICE);
    const pending = beginDraftEdit('page-2');
    if (!pending) throw new Error('expected a signed-in draft scope');

    signIn(BOB);
    persistDraft(pending, () => '<p>alice edit</p>');
    expect(readDraft('page-2')).toBeNull();
    signIn(ALICE);
    expect(readDraft('page-2')).toBeNull();
  });

  it("keeps other accounts' drafts when one account signs out", () => {
    writeDraftAs(CAROL, 'page-3', '<p>carol</p>');
    writeDraftAs(ALICE, 'page-3', '<p>alice</p>');

    discardDraftsOnSignOut(ALICE.id);
    useAuthStore.getState().clearAuth();

    signIn(ALICE);
    expect(readDraft('page-3')).toBeNull();
    signIn(CAROL);
    expect(readDraft('page-3')).toBe('<p>carol</p>');
  });

  it("fences this tab's pending autosave when another tab signs out", async () => {
    signIn(ALICE);
    const pending = beginDraftEdit('page-4');
    if (!pending) throw new Error('expected a signed-in draft scope');

    // A second tab: fresh module instances sharing this origin's storage,
    // whose store rehydrates Alice from the persisted auth blob.
    vi.resetModules();
    const otherTab = await import('./editor-drafts');
    otherTab.discardDraftsOnSignOut(ALICE.id);

    // This tab has not processed the logout yet: Alice is still signed in here.
    persistDraft(pending, () => '<p>resurrected</p>');
    expect(readDraft('page-4')).toBeNull();
  });

  it('purges legacy unscoped drafts and nothing else', () => {
    writeDraftAs(ALICE, 'page-5', '<p>scoped</p>');
    localStorage.setItem('draft:page-5', '<p>legacy page</p>');
    localStorage.setItem('draft:new-page', '<p>legacy new page</p>');
    localStorage.setItem('editor-header-numbering', 'true');

    purgeLegacyDrafts();

    expect(localStorage.getItem('draft:page-5')).toBeNull();
    expect(localStorage.getItem('draft:new-page')).toBeNull();
    expect(localStorage.getItem('editor-header-numbering')).toBe('true');
    expect(readDraft('page-5')).toBe('<p>scoped</p>');
  });
});
