import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface UiState {
  sidebarCollapsed: boolean;
  treeSidebarCollapsed: boolean;
  treeSidebarSpaceKey: string | undefined;
  treeSidebarWidth: number;
  articleSidebarCollapsed: boolean;
  articleSidebarWidth: number;
  reduceEffects: boolean;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleTreeSidebar: () => void;
  setTreeSidebarCollapsed: (collapsed: boolean) => void;
  setTreeSidebarSpaceKey: (spaceKey: string | undefined) => void;
  setTreeSidebarWidth: (width: number) => void;
  toggleArticleSidebar: () => void;
  setArticleSidebarCollapsed: (collapsed: boolean) => void;
  setArticleSidebarWidth: (width: number) => void;
  setReduceEffects: (reduce: boolean) => void;
}

/**
 * Check whether the OS-level prefers-reduced-motion media query matches.
 * Used as the default for reduceEffects when no persisted value exists.
 */
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      treeSidebarCollapsed: false,
      treeSidebarSpaceKey: undefined,
      treeSidebarWidth: 256,
      articleSidebarCollapsed: false,
      articleSidebarWidth: 280,
      reduceEffects: prefersReducedMotion(),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
      toggleTreeSidebar: () => set((s) => ({ treeSidebarCollapsed: !s.treeSidebarCollapsed })),
      setTreeSidebarCollapsed: (collapsed) => set({ treeSidebarCollapsed: collapsed }),
      setTreeSidebarSpaceKey: (spaceKey) => set({ treeSidebarSpaceKey: spaceKey }),
      setTreeSidebarWidth: (width) => set({ treeSidebarWidth: Math.max(180, Math.min(600, width)) }),
      toggleArticleSidebar: () => set((s) => ({ articleSidebarCollapsed: !s.articleSidebarCollapsed })),
      setArticleSidebarCollapsed: (collapsed) => set({ articleSidebarCollapsed: collapsed }),
      setArticleSidebarWidth: (width) => set({ articleSidebarWidth: Math.max(200, Math.min(500, width)) }),
      setReduceEffects: (reduce) => set({ reduceEffects: reduce }),
    }),
    { name: 'kb-ui' },
  ),
);
