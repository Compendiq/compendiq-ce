import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { migrateStorageKey } from '../shared/lib/migrate-storage-key';

migrateStorageKey('kb-theme', 'compendiq-theme');
migrateStorageKey('atlasmind-theme', 'compendiq-theme');

export const THEME_IDS = [
  'graphite-honey',
  'honey-linen',
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

export const DEFAULT_DARK_THEME: ThemeId = 'graphite-honey';
export const DEFAULT_LIGHT_THEME: ThemeId = 'honey-linen';

export const LIGHT_THEMES: ReadonlySet<ThemeId> = new Set(['honey-linen']);

export function isLightTheme(theme: ThemeId): boolean {
  return LIGHT_THEMES.has(theme);
}

export const THEMES: ThemeMeta[] = [
  {
    id: 'graphite-honey',
    label: 'Graphite Honey',
    description: 'Graphite surfaces with honey accent — neumorphic dark',
    category: 'dark',
    preview: { bg: '#121211', card: '#22211e', primary: '#f9c74f', accent: '#f5efe0' },
  },
  {
    id: 'honey-linen',
    label: 'Honey Linen',
    description: 'Linen cream with honey accent — neumorphic light',
    category: 'light',
    preview: { bg: '#fbf7ef', card: '#fffdf7', primary: '#f9c74f', accent: '#0a0a0a' },
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

function validateThemeId(id: string): ThemeId {
  if ((THEME_IDS as readonly string[]).includes(id)) return id as ThemeId;
  return DEFAULT_DARK_THEME;
}

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
      name: 'compendiq-theme',
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
