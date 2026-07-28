import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { migrateStorageKey } from '../shared/lib/migrate-storage-key';

// One-time migrations for localStorage key renames
migrateStorageKey('kb-ui', 'compendiq-ui');
migrateStorageKey('atlasmind-ui', 'compendiq-ui');

interface UiState {
  sidebarCollapsed: boolean;
  treeSidebarCollapsed: boolean;
  treeSidebarSpaceKey: string | undefined;
  treeSidebarWidth: number;
  articleSidebarCollapsed: boolean;
  articleSidebarWidth: number;
  /**
   * Width of the docked AI assistant (#1126). Persisted because it is a real
   * layout preference; whether the dock is *open* is not persisted and lives in
   * the ephemeral `ai-dock-store`.
   */
  aiDockWidth: number;
  /** When false, single-key shortcuts (no Ctrl/Alt) are suppressed (WCAG 2.1.4). */
  singleKeyShortcutsEnabled: boolean;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleTreeSidebar: () => void;
  setTreeSidebarCollapsed: (collapsed: boolean) => void;
  setTreeSidebarSpaceKey: (spaceKey: string | undefined) => void;
  setTreeSidebarWidth: (width: number) => void;
  toggleArticleSidebar: () => void;
  setArticleSidebarCollapsed: (collapsed: boolean) => void;
  setArticleSidebarWidth: (width: number) => void;
  setAiDockWidth: (width: number) => void;
  setSingleKeyShortcutsEnabled: (enabled: boolean) => void;
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
      aiDockWidth: 420,
      singleKeyShortcutsEnabled: true,
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
      toggleTreeSidebar: () => set((s) => ({ treeSidebarCollapsed: !s.treeSidebarCollapsed })),
      setTreeSidebarCollapsed: (collapsed) => set({ treeSidebarCollapsed: collapsed }),
      setTreeSidebarSpaceKey: (spaceKey) => set({ treeSidebarSpaceKey: spaceKey }),
      setTreeSidebarWidth: (width) => set({ treeSidebarWidth: Math.max(180, Math.min(600, width)) }),
      toggleArticleSidebar: () => set((s) => ({ articleSidebarCollapsed: !s.articleSidebarCollapsed })),
      setArticleSidebarCollapsed: (collapsed) => set({ articleSidebarCollapsed: collapsed }),
      setArticleSidebarWidth: (width) => set({ articleSidebarWidth: Math.max(200, Math.min(500, width)) }),
      // Floor of 340 keeps the diff card's Apply/Skip footer on one line; ceiling
      // of 640 keeps the article's reading measure viable beside it.
      setAiDockWidth: (width) => set({ aiDockWidth: Math.max(340, Math.min(640, width)) }),
      setSingleKeyShortcutsEnabled: (enabled) => set({ singleKeyShortcutsEnabled: enabled }),
    }),
    { name: 'compendiq-ui' },
  ),
);
