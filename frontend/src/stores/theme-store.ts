import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { migrateStorageKey } from '../shared/lib/migrate-storage-key';

migrateStorageKey('kb-theme', 'compendiq-theme');
migrateStorageKey('atlasmind-theme', 'compendiq-theme');

export const THEME_IDS = [
  'slate-steel',
  'frost-steel',
] as const;

export type ThemeId = (typeof THEME_IDS)[number];

type ThemeCategory = 'dark' | 'light';

interface ThemeMeta {
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

export const DEFAULT_DARK_THEME: ThemeId = 'slate-steel';
export const DEFAULT_LIGHT_THEME: ThemeId = 'frost-steel';

export const LIGHT_THEMES: ReadonlySet<ThemeId> = new Set(['frost-steel']);

export function isLightTheme(theme: ThemeId): boolean {
  return LIGHT_THEMES.has(theme);
}

export const THEMES: ThemeMeta[] = [
  {
    id: 'slate-steel',
    label: 'Slate Steel',
    description: 'Navy slate surfaces with a steel accent — neumorphic dark',
    category: 'dark',
    // Hex values must match the actual rendered surfaces in index.css — the
    // picker chip is the only way users see the surface color before applying
    // the theme. `bg` is the flat --color-background rather than the lightest
    // stop of --surface-backdrop: the chip is too small to read a gradient,
    // and the flat value is what the majority of the viewport settles to.
    preview: { bg: '#0e1220', card: '#151b2c', primary: '#6ea8ff', accent: '#e8ecf5' },
  },
  {
    id: 'frost-steel',
    label: 'Frost Steel',
    description: 'Cool near-white with a steel accent — neumorphic light',
    category: 'light',
    preview: { bg: '#f4f6fa', card: '#ffffff', primary: '#2f6bd8', accent: '#171c2c' },
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
 *
 * `honey-linen` is the light half of the retired Honey Linen / Graphite Honey
 * pair, replaced by Frost Steel / Slate Steel. Its dark sibling
 * (`graphite-honey`) needs no entry: it falls through to DEFAULT_DARK_THEME,
 * which is already the right answer.
 */
const RETIRED_LIGHT_THEME_IDS: ReadonlySet<string> = new Set([
  'polar-slate',
  'parchment-glow',
  'sunrise-cream',
  'cloud-white',
  'honey-linen',
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
