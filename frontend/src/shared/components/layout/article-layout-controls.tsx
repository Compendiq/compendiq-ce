/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext } from 'react';
import type { LayoutPreset } from './LayoutPresetMenu';

export interface ArticleLayoutControls {
  activePreset: LayoutPreset | null;
  applyPreset: (preset: LayoutPreset) => void;
}

const ArticleLayoutControlsContext = createContext<ArticleLayoutControls | null>(null);

export const ArticleLayoutControlsProvider = ArticleLayoutControlsContext.Provider;

/** Present only under AppLayout on an existing article route. */
export function useArticleLayoutControls(): ArticleLayoutControls | null {
  return useContext(ArticleLayoutControlsContext);
}
