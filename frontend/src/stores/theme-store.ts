import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { migrateStorageKey } from '../shared/lib/migrate-storage-key';

migrateStorageKey('kb-theme', 'compendiq-theme');
migrateStorageKey('atlasmind-theme', 'compendiq-theme');

export const THEME_IDS = [
  'graphite',
  'paper',
] as const;

export type ThemeId = (typeof THEME_IDS)[number];

type ThemeCategory = 'dark' | 'light';

/**
 * What the user actually chooses. `system` is the default and is NOT a third
 * palette — it resolves to `graphite` or `paper` from the OS setting and keeps
 * tracking it for the life of the session.
 *
 * Preference and resolved theme are stored separately on purpose: persisting
 * only the resolved ThemeId would silently convert "follow my OS" into a fixed
 * choice the first time the store rehydrated.
 */
export const THEME_PREFERENCES = ['system', 'dark', 'light'] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'system';

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

export const DEFAULT_DARK_THEME: ThemeId = 'graphite';
export const DEFAULT_LIGHT_THEME: ThemeId = 'paper';

export const LIGHT_THEMES: ReadonlySet<ThemeId> = new Set(['paper']);

export function isLightTheme(theme: ThemeId): boolean {
  return LIGHT_THEMES.has(theme);
}

export const THEMES: ThemeMeta[] = [
  {
    id: 'graphite',
    label: 'Graphite',
    description: 'Neutral graphite surfaces with one Steel accent',
    category: 'dark',
    // Hex values must match the rendered surfaces in index.css — the picker
    // chip is the only way users see a surface before applying the theme, and
    // a test compares these against the tokens rather than trusting either.
    preview: { bg: '#0f0f10', card: '#161617', primary: '#86aec8', accent: '#e7e9eb' },
  },
  {
    id: 'paper',
    label: 'Paper',
    description: 'Neutral paper surfaces with one Steel accent',
    category: 'light',
    preview: { bg: '#f7f7f8', card: '#fafafb', primary: '#3f627c', accent: '#17181a' },
  },
];

export const THEME_CATEGORIES: { key: ThemeCategory; label: string }[] = [
  { key: 'dark', label: 'Dark' },
  { key: 'light', label: 'Light' },
];

interface ThemeState {
  /** What the user chose. `system` tracks the OS for the whole session. */
  preference: ThemePreference;
  /** The palette actually painted right now — always a real ThemeId. */
  theme: ThemeId;
  setPreference: (preference: ThemePreference) => void;
  /** Explicit palette pick; implies a non-system preference. */
  setTheme: (theme: ThemeId) => void;
}

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** The OS's current answer. Defaults to dark where matchMedia is unavailable. */
export function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  return window.matchMedia(DARK_QUERY).matches;
}

export function resolvePreference(preference: ThemePreference): ThemeId {
  if (preference === 'dark') return DEFAULT_DARK_THEME;
  if (preference === 'light') return DEFAULT_LIGHT_THEME;
  return systemPrefersDark() ? DEFAULT_DARK_THEME : DEFAULT_LIGHT_THEME;
}

export function validateThemePreference(value: unknown): ThemePreference {
  return (THEME_PREFERENCES as readonly string[]).includes(value as string)
    ? (value as ThemePreference)
    : DEFAULT_THEME_PREFERENCE;
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
  // Light half of the retired Slate Steel / Frost Steel pair. Its dark sibling
  // (`slate-steel`) needs no entry: it falls through to DEFAULT_DARK_THEME.
  'frost-steel',
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
      preference: DEFAULT_THEME_PREFERENCE,
      theme: resolvePreference(DEFAULT_THEME_PREFERENCE),
      setPreference: (preference: ThemePreference) => {
        const theme = resolvePreference(preference);
        applyThemeToDocument(theme);
        set({ preference, theme });
      },
      setTheme: (theme: ThemeId) => {
        applyThemeToDocument(theme);
        set({ preference: isLightTheme(theme) ? 'light' : 'dark', theme });
      },
    }),
    {
      name: 'compendiq-theme',
      // `theme` is derived state and is deliberately NOT persisted: writing it
      // would let a stale resolved value win over the live OS reading on the
      // next boot, which is how "follow the OS" quietly stops following.
      partialize: (state) => ({ preference: state.preference }),
      onRehydrateStorage: () => {
        return (state?: ThemeState) => {
          if (!state) return;
          const preference = validateThemePreference(state.preference);
          state.preference = preference;
          state.theme = resolvePreference(preference);
          applyThemeToDocument(state.theme);
        };
      },
    },
  ),
);

/**
 * Track the OS setting for as long as the user's preference is `system`.
 * Called once at boot. Returns a teardown for tests.
 *
 * Reading the preference off the store at event time (rather than closing over
 * it) is what lets a user switch to `system` mid-session and have the next OS
 * flip take effect without a reload.
 */
export function startSystemThemeSync(): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {};
  }
  const query = window.matchMedia(DARK_QUERY);

  const onChange = () => {
    // Do nothing until the persisted preference has been read back. Any write
    // before that point re-serializes the store's INITIAL state — `system` —
    // straight over the user's stored choice, so an OS event arriving in the
    // gap silently converts "dark" into "follow the OS" and the palette flips
    // on the next reload. The listener is only attached post-hydration, and
    // this guard covers the synchronous-rehydrate case where a change can
    // still land inside the same tick.
    if (!useThemeStore.persist.hasHydrated()) return;

    const { preference, theme } = useThemeStore.getState();
    if (preference !== 'system') return;
    const next = resolvePreference('system');
    if (next === theme) return;
    applyThemeToDocument(next);
    useThemeStore.setState({ theme: next });
  };

  // Re-resolve once hydration lands: the OS may disagree with whatever the
  // pre-React inline script painted, and with `system` the OS is the authority.
  const settle = () => {
    const { preference, theme } = useThemeStore.getState();
    if (preference !== 'system') return;
    const next = resolvePreference('system');
    if (next === theme) return;
    applyThemeToDocument(next);
    useThemeStore.setState({ theme: next });
  };

  query.addEventListener('change', onChange);

  let unsubHydrate = () => {};
  if (useThemeStore.persist.hasHydrated()) {
    settle();
  } else {
    unsubHydrate = useThemeStore.persist.onFinishHydration(settle);
  }

  return () => {
    query.removeEventListener('change', onChange);
    unsubHydrate();
  };
}
