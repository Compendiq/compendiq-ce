import { create } from 'zustand';

interface AiDockState {
  /**
   * Deliberately NOT persisted. The dock forces the article right pane into its
   * 40px rail while it is open, and a persisted `open` would mean a reload
   * silently re-opens an AI panel and re-collapses the outline for a user who
   * never asked for either. Dock *width* is a real preference and does persist
   * — it lives in `ui-store` as `aiDockWidth`.
   */
  open: boolean;
  /**
   * Opens the assistant, and only opens it.
   *
   * #1126 gave this a `seed` — a prompt the dock ran the moment a model and the
   * page resolved — so that "AI Improve" could stop navigating to
   * `/ai?mode=improve&pageId=…` and act beside the document instead. #1176
   * removed it: the click that opened the panel also started a full-page rewrite,
   * of an improvement type the user never picked, that the dock offers no way to
   * stop and that closing the panel does not abort. An opening gesture opens.
   * The request now waits for a chip press or a typed question.
   */
  openDock: () => void;
  closeDock: () => void;
}

export const useAiDockStore = create<AiDockState>()((set) => ({
  open: false,
  openDock: () => set({ open: true }),
  closeDock: () => set({ open: false }),
}));
