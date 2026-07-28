import { create } from 'zustand';
import type { TocHeading } from '../shared/components/article/TableOfContents';

/**
 * Result of asking the open article to absorb AI-authored HTML.
 *
 * `no-editor` is not a failure the caller can retry — it means the article is
 * in read mode, so there is no TipTap instance to write into and the caller has
 * to ask for edit mode first.
 */
export type ApplyArticleContentResult = 'applied' | 'no-editor';

interface ArticleViewState {
  headings: TocHeading[];
  editing: boolean;
  /** True once the open editor has unsaved changes (mirrors PageViewPage's `isDirty`). */
  editorDirty: boolean;
  setHeadings: (headings: TocHeading[]) => void;
  setEditing: (editing: boolean) => void;
  setEditorDirty: (dirty: boolean) => void;

  // --- Capabilities registered by PageViewPage while it is mounted ----------
  //
  // `editing` above is a *mirror*: writing it would lie about the article's
  // state without changing it. The docked assistant (#1126) lives in AppLayout,
  // outside the route, and has to be able to (a) ask the article to enter edit
  // mode and (b) hand it improved content. Both are operations only
  // PageViewPage can perform — it owns the draft-restore flow and the editor
  // instance — so it registers them here rather than exposing its internals.

  /**
   * Enter edit mode. May not take effect synchronously (or at all): when a
   * localStorage draft diverges from the published body, PageViewPage defers
   * behind a "Restore draft?" dialog and the user may dismiss it. Callers must
   * watch `editing` rather than assume this succeeded.
   */
  requestEdit: (() => void) | null;
  setRequestEdit: (fn: (() => void) | null) => void;

  /** Replace the open editor's document with `html`. Null / `'no-editor'` in read mode. */
  applyContent: ((html: string) => ApplyArticleContentResult) | null;
  setApplyContent: (fn: ((html: string) => ApplyArticleContentResult) | null) => void;
}

export const useArticleViewStore = create<ArticleViewState>()((set) => ({
  headings: [],
  editing: false,
  editorDirty: false,
  setHeadings: (headings) => set({ headings }),
  setEditing: (editing) => set({ editing }),
  // Guarded so the editor's per-keystroke `setIsDirty(true)` doesn't notify
  // every subscriber on every keystroke once the flag is already true.
  setEditorDirty: (dirty) => set((s) => (s.editorDirty === dirty ? s : { editorDirty: dirty })),
  requestEdit: null,
  setRequestEdit: (fn) => set({ requestEdit: fn }),
  applyContent: null,
  setApplyContent: (fn) => set({ applyContent: fn }),
}));
