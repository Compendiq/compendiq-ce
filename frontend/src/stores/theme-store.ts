import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { migrateStorageKey } from '../shared/lib/migrate-storage-key';

// One-time migration from legacy kb-theme → atlasmind-theme localStorage key
migrateStorageKey('kb-theme', 'atlasmind-theme');

export const THEME_IDS = [
  // Dark themes
  'void-indigo',
  'obsidian-violet',
  // Light themes
  'polar-slate',
  'parchment-glow',
] as const;

export type ThemeId = (typeof THEME_IDS)[number];

export type ThemeCategory = 'dark' | 'light';

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

export const DEFAULT_DARK_THEME: ThemeId = 'void-indigo';
export const DEFAULT_LIGHT_THEME: ThemeId = 'polar-slate';

export const LIGHT_THEMES: ReadonlySet<ThemeId> = new Set([
  'polar-slate',
  'parchment-glow',
]);

export function isLightTheme(theme: ThemeId): boolean {
  return LIGHT_THEMES.has(theme);
}

export const THEMES: ThemeMeta[] = [
  // -- Dark themes --
  {
    id: 'void-indigo',
    label: 'Void',
    description: 'Inky graphite with indigo accents — Linear × GitHub',
    category: 'dark',
    preview: { bg: '#1e1e22', card: '#2c2c31', primary: '#6366f1', accent: '#818cf8' },
  },
  {
    id: 'obsidian-violet',
    label: 'Obsidian',
    description: 'Warm graphite with violet accents — Raycast × Obsidian',
    category: 'dark',
    preview: { bg: '#23211e', card: '#312f2b', primary: '#a855f7', accent: '#c084fc' },
  },
  // -- Light themes --
  {
    id: 'polar-slate',
    label: 'Polar Slate',
    description: 'Cool slate-white with indigo accents — Vercel × Linear Light',
    category: 'light',
    preview: { bg: '#f1f5f9', card: '#ffffff', primary: '#4f46e5', accent: '#6366f1' },
  },
  {
    id: 'parchment-glow',
    label: 'Parchment Glow',
    description: 'Warm cream with violet-indigo accents — Notion × Stripe',
    category: 'light',
    preview: { bg: '#faf8f5', card: '#ffffff', primary: '#7c3aed', accent: '#8b5cf6' },
  },
];

export const THEME_CATEGORIES: { key: ThemeCategory; label: string }[] = [
  { key: 'dark', label: 'Dark' },
  { key: 'light', label: 'Light' },
];

interface ThemeState {
  theme: ThemeId;
  setTheme: (theme: ThemeId) => void;
}

/**
 * Validate that a persisted theme ID is still valid.
 * Removed themes (from the old 24-theme system) fall back to the default.
 */
function validateThemeId(id: string): ThemeId {
  if ((THEME_IDS as readonly string[]).includes(id)) return id as ThemeId;
  return DEFAULT_DARK_THEME;
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
      theme: DEFAULT_DARK_THEME,
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
            const validated = validateThemeId(state.theme);
            if (validated !== state.theme) {
              state.theme = validated;
            }
            applyThemeToDocument(state.theme);
          }
        };
      },
    },
  ),
);
