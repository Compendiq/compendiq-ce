import { create } from 'zustand';
import type { TocHeading } from '../shared/components/article/TableOfContents';

/**
 * Read-only mirrors of the open article's state, published by PageViewPage for
 * surfaces that live outside the route — `ArticleRightPane` and the docked AI
 * assistant, both mounted in AppLayout.
 *
 * Deliberately still mirrors only. An earlier revision of #1126 added
 * `requestEdit` / `applyContent` capabilities here so the dock could write an
 * AI rewrite straight into TipTap; they were removed once it was clear that a
 * client-side Markdown→HTML round-trip bypasses the media and column-layout
 * guards `POST /llm/improvements/apply` runs server-side (see the header
 * comment on `features/ai/dock/DockDiffCard.tsx`). Apply is a server call, so
 * nothing outside the route needs to reach into the editor — keep it that way.
 */
interface ArticleViewState {
  headings: TocHeading[];
  editing: boolean;
  setHeadings: (headings: TocHeading[]) => void;
  setEditing: (editing: boolean) => void;
}

export const useArticleViewStore = create<ArticleViewState>()((set) => ({
  headings: [],
  editing: false,
  setHeadings: (headings) => set({ headings }),
  setEditing: (editing) => set({ editing }),
}));
