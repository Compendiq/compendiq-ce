import { describe, it, expect, beforeEach } from 'vitest';
import { useAiDockStore } from './ai-dock-store';

describe('ai-dock-store', () => {
  beforeEach(() => {
    useAiDockStore.setState({ open: false });
  });

  it('opens and closes the assistant', () => {
    useAiDockStore.getState().openDock();
    expect(useAiDockStore.getState().open).toBe(true);

    useAiDockStore.getState().closeDock();
    expect(useAiDockStore.getState().open).toBe(false);
  });

  /**
   * #1176. The store used to carry a `seed` / `seedPageId` pair that the dock
   * ran the moment a model and page resolved, so opening the assistant from
   * "AI Improve" started a full-page rewrite nobody had asked for — of an
   * improvement type nobody had picked, with no way to stop it.
   *
   * Opening queues nothing now. This asserts the state that made an auto-run
   * possible is *gone* rather than merely left unset, because an inert `seed`
   * field is an invitation to wire it back up.
   */
  it('carries no queued action for the dock to run on open', () => {
    useAiDockStore.getState().openDock();

    expect(Object.keys(useAiDockStore.getState()).sort()).toEqual([
      'closeDock',
      'open',
      'openDock',
    ]);
  });
});
