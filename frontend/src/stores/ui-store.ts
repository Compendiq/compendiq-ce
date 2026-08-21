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
  /**
   * Below `xl` the inspector starts collapsed so the article keeps the
   * workspace. Wide layouts still use `articleSidebarCollapsed`. This flag
   * is the laptop expand (layout presets, Alt+I, the expand control).
   */
  articleSidebarLaptopExpanded: boolean;
  articleSidebarWidth: number;
  /** A personal editing preference, not a per-document action — belongs in
   *  Settings, not on a permanent slot in the editor toolbar (see
   *  ThemeTab.tsx's "Editor" section). */
  vimModeEnabled: boolean;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleTreeSidebar: () => void;
  setTreeSidebarCollapsed: (collapsed: boolean) => void;
  setTreeSidebarSpaceKey: (spaceKey: string | undefined) => void;
  setTreeSidebarWidth: (width: number) => void;
  toggleArticleSidebar: () => void;
  setArticleSidebarCollapsed: (collapsed: boolean) => void;
  setArticleSidebarLaptopExpanded: (expanded: boolean) => void;
  setArticleSidebarWidth: (width: number) => void;
  setVimModeEnabled: (enabled: boolean) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      treeSidebarCollapsed: false,
      treeSidebarSpaceKey: undefined,
      // 280, not 256: at 256 a level-1 leaf gave its title 158px while real
      // Confluence titles routinely need 250-400px, so 43 of 57 rendered rows
      // truncated — with no `title`, no hover card and no keyboard path to the
      // hidden text. The row gutter was rebuilt to reclaim ~35px of that (see
      // SidebarTreeNode); this carries the remaining 24. Both halves are needed:
      // widening alone just moves the panel's cost onto the article.
      treeSidebarWidth: 282,
      articleSidebarCollapsed: false,
      articleSidebarLaptopExpanded: false,
      // 360, not 280: at the old default the Assistant tab's prose column
      // measured ~233px after the pane's own chrome — a third of the app's
      // enforced 640px/~80-char article reading measure, for the one surface
      // meant to answer questions about that same article. 360 leaves >900px
      // of article at a 1440px viewport (still comfortably above the 640px
      // measure) while giving generated prose room to read as prose.
      articleSidebarWidth: 360,
      // Carries over anyone's existing preference from the old standalone
      // localStorage key the toolbar toggle used to write directly. Safe as a
      // one-time plain read (not a full migrateStorageKey, which expects a
      // JSON-shaped store, not a raw 'true'/'false' string): zustand persist
      // merges this initial value under any already-persisted `compendiq-ui`
      // blob, and blobs written before this field existed simply don't have
      // `vimModeEnabled` yet, so the merge falls through to this default.
      vimModeEnabled: typeof window !== 'undefined' && localStorage.getItem('compendiq-vim-mode') === 'true',
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
      toggleTreeSidebar: () => set((s) => ({ treeSidebarCollapsed: !s.treeSidebarCollapsed })),
      setTreeSidebarCollapsed: (collapsed) => set({ treeSidebarCollapsed: collapsed }),
      setTreeSidebarSpaceKey: (spaceKey) => set({ treeSidebarSpaceKey: spaceKey }),
      setTreeSidebarWidth: (width) => set({ treeSidebarWidth: Math.max(180, Math.min(600, width)) }),
      toggleArticleSidebar: () => set((s) => ({ articleSidebarCollapsed: !s.articleSidebarCollapsed })),
      setArticleSidebarCollapsed: (collapsed) => set({ articleSidebarCollapsed: collapsed }),
      setArticleSidebarLaptopExpanded: (expanded) => set({ articleSidebarLaptopExpanded: expanded }),
      setArticleSidebarWidth: (width) => set({ articleSidebarWidth: Math.max(200, Math.min(1200, width)) }),
      setVimModeEnabled: (enabled) => set({ vimModeEnabled: enabled }),
    }),
    { name: 'compendiq-ui' },
  ),
);
