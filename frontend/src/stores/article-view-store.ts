import { create } from 'zustand';
import type { TocHeading } from '../shared/components/article/TableOfContents';

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
