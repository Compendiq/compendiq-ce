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
    preview: { bg: '#121212', card: '#1f1f1f', primary: '#f9c74f', accent: '#ece9e2' },
  },
  {
    id: 'honey-linen',
    label: 'Honey Linen',
    description: 'Linen cream with honey accent — neumorphic light',
    category: 'light',
    // Hex values must match the actual rendered surfaces in
    // index.css [data-theme="honey-linen"] — the picker chip is the only
    // way users see the surface color before applying the theme.
    preview: { bg: '#f7f7f7', card: '#ffffff', primary: '#f9c74f', accent: '#0a0a0a' },
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
 * Retired theme IDs whose names hint at light themes. A user who had one of
 * these persisted should land on the *light* default after upgrade rather than
 * being silently flipped to dark — that's a worse experience than picking the
 * wrong shade of light.
 */
const RETIRED_LIGHT_THEME_IDS: ReadonlySet<string> = new Set([
  'polar-slate',
  'parchment-glow',
  'sunrise-cream',
  'cloud-white',
]);

export function validateThemeId(id: string): ThemeId {
  if ((THEME_IDS as readonly string[]).includes(id)) return id as ThemeId;
  if (RETIRED_LIGHT_THEME_IDS.has(id)) return DEFAULT_LIGHT_THEME;
  return DEFAULT_DARK_THEME;
}

/**
 * Canonical writer for the active theme. Sets `data-theme`, `data-theme-type`,
 * and toggles the `dark` class on <html> in lockstep. This is the single
 * source of truth — no other code should mutate these attributes (the
 * pre-React FOUC script in index.html sets the same triplet for first paint).
 */
export function applyThemeToDocument(theme: ThemeId): void {
  const root = document.documentElement;
  const isLight = isLightTheme(theme);
  root.setAttribute('data-theme', theme);
  root.dataset.themeType = isLight ? 'light' : 'dark';
  root.classList.toggle('dark', !isLight);
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
