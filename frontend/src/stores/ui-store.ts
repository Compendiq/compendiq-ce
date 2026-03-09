import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface UiState {
  sidebarCollapsed: boolean;
  treeSidebarCollapsed: boolean;
  treeSidebarSpaceKey: string | undefined;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleTreeSidebar: () => void;
  setTreeSidebarCollapsed: (collapsed: boolean) => void;
  setTreeSidebarSpaceKey: (spaceKey: string | undefined) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      treeSidebarCollapsed: false,
      treeSidebarSpaceKey: undefined,
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
      toggleTreeSidebar: () => set((s) => ({ treeSidebarCollapsed: !s.treeSidebarCollapsed })),
      setTreeSidebarCollapsed: (collapsed) => set({ treeSidebarCollapsed: collapsed }),
      setTreeSidebarSpaceKey: (spaceKey) => set({ treeSidebarSpaceKey: spaceKey }),
    }),
    { name: 'kb-ui' },
  ),
);
