import { create } from 'zustand';

/**
 * A prompt the dock should run the moment it opens (#1126). "AI Improve" in the
 * article rail, in the expanded pane, and on Alt+I all used to navigate away to
 * `/ai?mode=improve&pageId=…`; they now open the dock with `'improve'` seeded
 * instead, which is the whole point of the dock — the document stays on screen.
 */
export type DockSeed = 'improve';

interface AiDockState {
  /**
   * Deliberately NOT persisted. The dock forces the article right pane into its
   * 40px rail while it is open, and a persisted `open` would mean a reload
   * silently re-opens an AI panel and re-collapses the outline for a user who
   * never asked for either. Dock *width* is a real preference and does persist
   * — it lives in `ui-store` as `aiDockWidth`.
   */
  open: boolean;
  /** Consumed once by the dock on open, then cleared. */
  seed: DockSeed | null;
  /**
   * The page the seed was requested for.
   *
   * The dock waits for `page` to resolve before running a seeded action, and
   * that wait is unbounded — a slow or failed page query (a trashed page, a bad
   * link) gives the user time to navigate somewhere else with the dock still
   * open. Without this, the seed would fire against whatever document loaded
   * next: an inference nobody asked for, a user turn written into the wrong
   * thread, and a diff card proposing to rewrite a page they never selected.
   */
  seedPageId: string | null;
  openDock: (seed?: DockSeed, seedPageId?: string | null) => void;
  closeDock: () => void;
  consumeSeed: () => void;
}

export const useAiDockStore = create<AiDockState>()((set) => ({
  open: false,
  seed: null,
  seedPageId: null,
  openDock: (seed, seedPageId) => set({
    open: true,
    seed: seed ?? null,
    seedPageId: seed ? seedPageId ?? null : null,
  }),
  closeDock: () => set({ open: false, seed: null, seedPageId: null }),
  consumeSeed: () => set({ seed: null, seedPageId: null }),
}));
