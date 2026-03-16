import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { migrateStorageKey } from '../shared/lib/migrate-storage-key';

// One-time migration from legacy kb-theme → atlasmind-theme localStorage key
migrateStorageKey('kb-theme', 'atlasmind-theme');

export const THEME_IDS = [
  // Dark themes
  'midnight-blue',
  'ocean-depth',
  'emerald-dark',
  'rose-noir',
  'amber-night',
  'arctic-frost',
  'violet-storm',
  'cyber-teal',
  'sunset-glow',
  'slate-minimal',
  // Bright themes
  'cloud-white',
  'lavender-bloom',
  'mint-fresh',
  'peach-blossom',
  'sky-blue',
  'lemon-drop',
  'rose-garden',
  'sage-light',
  'sand-dune',
  'ice-crystal',
  // Catppuccin themes
  'catppuccin-latte',
  'catppuccin-frappe',
  'catppuccin-macchiato',
  'catppuccin-mocha',
] as const;

export type ThemeId = (typeof THEME_IDS)[number];

export type ThemeCategory = 'dark' | 'bright' | 'catppuccin';

export interface ThemeMeta {
  id: ThemeId;
  label: string;
  description: string;
  category: ThemeCategory;
  preview: {
    bg: string;
    card: string;
    primary: string;
    accent: string;
  };
}

export const LIGHT_THEMES: ReadonlySet<ThemeId> = new Set([
  'cloud-white',
  'lavender-bloom',
  'mint-fresh',
  'peach-blossom',
  'sky-blue',
  'lemon-drop',
  'rose-garden',
  'sage-light',
  'sand-dune',
  'ice-crystal',
  'catppuccin-latte',
]);

export function isLightTheme(theme: ThemeId): boolean {
  return LIGHT_THEMES.has(theme);
}

export const THEMES: ThemeMeta[] = [
  // -- Dark themes --
  {
    id: 'midnight-blue',
    label: 'Midnight Blue',
    description: 'Deep blue-violet with electric blue accents',
    category: 'dark',
    preview: { bg: '#1a1533', card: '#282244', primary: '#5b8af5', accent: '#7c5bf5' },
  },
  {
    id: 'ocean-depth',
    label: 'Ocean Depth',
    description: 'Dark teal waters with aqua highlights',
    category: 'dark',
    preview: { bg: '#0f1e24', card: '#162d36', primary: '#22b8cf', accent: '#15aabf' },
  },
  {
    id: 'emerald-dark',
    label: 'Emerald Dark',
    description: 'Rich dark greens with lime accents',
    category: 'dark',
    preview: { bg: '#0f1a14', card: '#162a1e', primary: '#40c057', accent: '#51cf66' },
  },
  {
    id: 'rose-noir',
    label: 'Rose Noir',
    description: 'Dark charcoal with rose-pink accents',
    category: 'dark',
    preview: { bg: '#1a1318', card: '#2a1e26', primary: '#e64980', accent: '#f06595' },
  },
  {
    id: 'amber-night',
    label: 'Amber Night',
    description: 'Warm dark tones with golden amber',
    category: 'dark',
    preview: { bg: '#1a1610', card: '#2a2418', primary: '#fab005', accent: '#fd7e14' },
  },
  {
    id: 'arctic-frost',
    label: 'Arctic Frost',
    description: 'Cool grays with icy blue accents',
    category: 'dark',
    preview: { bg: '#151a1e', card: '#1e252c', primary: '#74c0fc', accent: '#a5d8ff' },
  },
  {
    id: 'violet-storm',
    label: 'Violet Storm',
    description: 'Deep purples with vivid violet flares',
    category: 'dark',
    preview: { bg: '#18112a', card: '#241940', primary: '#9775fa', accent: '#b197fc' },
  },
  {
    id: 'cyber-teal',
    label: 'Cyber Teal',
    description: 'Neon-tinged dark with bright teal',
    category: 'dark',
    preview: { bg: '#0a1a1a', card: '#122828', primary: '#20c997', accent: '#38d9a9' },
  },
  {
    id: 'sunset-glow',
    label: 'Sunset Glow',
    description: 'Warm dark canvas with coral and orange',
    category: 'dark',
    preview: { bg: '#1a1210', card: '#2a1e18', primary: '#ff6b6b', accent: '#ffa94d' },
  },
  {
    id: 'slate-minimal',
    label: 'Slate Minimal',
    description: 'Neutral dark slate with subtle gray accents',
    category: 'dark',
    preview: { bg: '#161618', card: '#222225', primary: '#909296', accent: '#c1c2c5' },
  },
  // -- Bright themes --
  {
    id: 'cloud-white',
    label: 'Cloud White',
    description: 'Clean white canvas with soft blue accents',
    category: 'bright',
    preview: { bg: '#f8f9fc', card: '#ffffff', primary: '#3b82f6', accent: '#6366f1' },
  },
  {
    id: 'lavender-bloom',
    label: 'Lavender Bloom',
    description: 'Light lavender tones with purple highlights',
    category: 'bright',
    preview: { bg: '#f5f3ff', card: '#ffffff', primary: '#8b5cf6', accent: '#a78bfa' },
  },
  {
    id: 'mint-fresh',
    label: 'Mint Fresh',
    description: 'Cool mint green with emerald accents',
    category: 'bright',
    preview: { bg: '#f0fdf4', card: '#ffffff', primary: '#22c55e', accent: '#10b981' },
  },
  {
    id: 'peach-blossom',
    label: 'Peach Blossom',
    description: 'Warm peach cream with coral touches',
    category: 'bright',
    preview: { bg: '#fff7ed', card: '#ffffff', primary: '#f97316', accent: '#fb923c' },
  },
  {
    id: 'sky-blue',
    label: 'Sky Blue',
    description: 'Airy light blue with cerulean highlights',
    category: 'bright',
    preview: { bg: '#f0f9ff', card: '#ffffff', primary: '#0ea5e9', accent: '#38bdf8' },
  },
  {
    id: 'lemon-drop',
    label: 'Lemon Drop',
    description: 'Sunny cream canvas with golden accents',
    category: 'bright',
    preview: { bg: '#fefce8', card: '#ffffff', primary: '#eab308', accent: '#f59e0b' },
  },
  {
    id: 'rose-garden',
    label: 'Rose Garden',
    description: 'Soft pink with rosy red accents',
    category: 'bright',
    preview: { bg: '#fff1f2', card: '#ffffff', primary: '#f43f5e', accent: '#fb7185' },
  },
  {
    id: 'sage-light',
    label: 'Sage Light',
    description: 'Muted sage green with earthy tones',
    category: 'bright',
    preview: { bg: '#f1f5f2', card: '#ffffff', primary: '#6b8f71', accent: '#84a98c' },
  },
  {
    id: 'sand-dune',
    label: 'Sand Dune',
    description: 'Warm beige with sandy gold accents',
    category: 'bright',
    preview: { bg: '#faf8f5', card: '#ffffff', primary: '#a8884a', accent: '#c4a265' },
  },
  {
    id: 'ice-crystal',
    label: 'Ice Crystal',
    description: 'Cool blue-gray with steel accents',
    category: 'bright',
    preview: { bg: '#f1f5f9', card: '#ffffff', primary: '#64748b', accent: '#94a3b8' },
  },
  // -- Catppuccin themes --
  {
    id: 'catppuccin-latte',
    label: 'Catppuccin Latte',
    description: 'Catppuccin light palette with pastel accents',
    category: 'catppuccin',
    preview: { bg: '#eff1f5', card: '#e6e9ef', primary: '#1e66f5', accent: '#8839ef' },
  },
  {
    id: 'catppuccin-frappe',
    label: 'Catppuccin Frappe',
    description: 'Catppuccin mid-dark with muted pastels',
    category: 'catppuccin',
    preview: { bg: '#303446', card: '#292c3c', primary: '#8caaee', accent: '#ca9ee6' },
  },
  {
    id: 'catppuccin-macchiato',
    label: 'Catppuccin Macchiato',
    description: 'Catppuccin dark with warm pastel accents',
    category: 'catppuccin',
    preview: { bg: '#24273a', card: '#1e2030', primary: '#8aadf4', accent: '#c6a0f6' },
  },
  {
    id: 'catppuccin-mocha',
    label: 'Catppuccin Mocha',
    description: 'Catppuccin darkest with vibrant pastels',
    category: 'catppuccin',
    preview: { bg: '#1e1e2e', card: '#181825', primary: '#89b4fa', accent: '#cba6f7' },
  },
];

export const THEME_CATEGORIES: { key: ThemeCategory; label: string }[] = [
  { key: 'dark', label: 'Dark' },
  { key: 'bright', label: 'Bright' },
  { key: 'catppuccin', label: 'Catppuccin' },
];

interface ThemeState {
  theme: ThemeId;
  setTheme: (theme: ThemeId) => void;
}

/**
 * Apply the data-theme attribute + data-theme-type to <html>.
 * The CSS uses [data-theme="..."] selectors for theme variables
 * and [data-theme-type="light"] for shared light-theme overrides.
 */
export function applyThemeToDocument(theme: ThemeId): void {
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
  root.dataset.themeType = isLightTheme(theme) ? 'light' : 'dark';
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      theme: 'midnight-blue',
      setTheme: (theme: ThemeId) => {
        applyThemeToDocument(theme);
        set({ theme });
      },
    }),
    {
      name: 'atlasmind-theme',
      onRehydrateStorage: () => {
        return (state?: ThemeState) => {
          if (state?.theme) {
            applyThemeToDocument(state.theme);
          }
        };
      },
    },
  ),
);
