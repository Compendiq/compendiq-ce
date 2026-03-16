import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { migrateStorageKey } from '../shared/lib/migrate-storage-key';

// One-time migration from legacy kb-ui → atlasmind-ui localStorage key
migrateStorageKey('kb-ui', 'atlasmind-ui');

interface UiState {
  sidebarCollapsed: boolean;
  treeSidebarCollapsed: boolean;
  treeSidebarSpaceKey: string | undefined;
  treeSidebarWidth: number;
  articleSidebarCollapsed: boolean;
  articleSidebarWidth: number;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleTreeSidebar: () => void;
  setTreeSidebarCollapsed: (collapsed: boolean) => void;
  setTreeSidebarSpaceKey: (spaceKey: string | undefined) => void;
  setTreeSidebarWidth: (width: number) => void;
  toggleArticleSidebar: () => void;
  setArticleSidebarCollapsed: (collapsed: boolean) => void;
  setArticleSidebarWidth: (width: number) => void;
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
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
      toggleTreeSidebar: () => set((s) => ({ treeSidebarCollapsed: !s.treeSidebarCollapsed })),
      setTreeSidebarCollapsed: (collapsed) => set({ treeSidebarCollapsed: collapsed }),
      setTreeSidebarSpaceKey: (spaceKey) => set({ treeSidebarSpaceKey: spaceKey }),
      setTreeSidebarWidth: (width) => set({ treeSidebarWidth: Math.max(180, Math.min(600, width)) }),
      toggleArticleSidebar: () => set((s) => ({ articleSidebarCollapsed: !s.articleSidebarCollapsed })),
      setArticleSidebarCollapsed: (collapsed) => set({ articleSidebarCollapsed: collapsed }),
      setArticleSidebarWidth: (width) => set({ articleSidebarWidth: Math.max(200, Math.min(500, width)) }),
    }),
    { name: 'atlasmind-ui' },
  ),
);
