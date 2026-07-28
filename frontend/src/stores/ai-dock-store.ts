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
  openDock: (seed?: DockSeed) => void;
  closeDock: () => void;
  consumeSeed: () => void;
}

export const useAiDockStore = create<AiDockState>()((set) => ({
  open: false,
  seed: null,
  openDock: (seed) => set({ open: true, seed: seed ?? null }),
  closeDock: () => set({ open: false, seed: null }),
  consumeSeed: () => set({ seed: null }),
}));
