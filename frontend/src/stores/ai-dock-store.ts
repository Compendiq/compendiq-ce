import { create } from 'zustand';

interface AiDockState {
  /**
   * "The mobile sheet is up" — and, transiently, "someone asked for the
   * assistant". Deliberately NOT persisted: a stored `open` would mean a reload
   * silently raises an AI panel for a user who never asked for one.
   *
   * At `md` and up there is no dock to open — the assistant is a tab in
   * `ArticleRightPane` — so `AppLayout` consumes this flag on an article route
   * and re-expresses it as a tab request, lowering it in the same tick. That
   * keeps `open` meaning exactly one thing on screen. Read it as "the sheet is
   * showing"; never as "the desktop assistant is showing".
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
