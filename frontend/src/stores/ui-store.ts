import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface UiState {
  sidebarCollapsed: boolean;
  treeSidebarCollapsed: boolean;
  treeSidebarSpaceKey: string | undefined;
  treeSidebarWidth: number;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleTreeSidebar: () => void;
  setTreeSidebarCollapsed: (collapsed: boolean) => void;
  setTreeSidebarSpaceKey: (spaceKey: string | undefined) => void;
  setTreeSidebarWidth: (width: number) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      treeSidebarCollapsed: false,
      treeSidebarSpaceKey: undefined,
      treeSidebarWidth: 256,
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
      toggleTreeSidebar: () => set((s) => ({ treeSidebarCollapsed: !s.treeSidebarCollapsed })),
      setTreeSidebarCollapsed: (collapsed) => set({ treeSidebarCollapsed: collapsed }),
      setTreeSidebarSpaceKey: (spaceKey) => set({ treeSidebarSpaceKey: spaceKey }),
      setTreeSidebarWidth: (width) => set({ treeSidebarWidth: Math.max(180, Math.min(600, width)) }),
    }),
    { name: 'kb-ui' },
  ),
);
