import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export const THEME_IDS = [
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
] as const;

export type ThemeId = (typeof THEME_IDS)[number];

export interface ThemeMeta {
  id: ThemeId;
  label: string;
  description: string;
  preview: {
    bg: string;
    card: string;
    primary: string;
    accent: string;
  };
}

export const THEMES: ThemeMeta[] = [
  {
    id: 'midnight-blue',
    label: 'Midnight Blue',
    description: 'Deep blue-violet with electric blue accents',
    preview: { bg: '#1a1533', card: '#282244', primary: '#5b8af5', accent: '#7c5bf5' },
  },
  {
    id: 'ocean-depth',
    label: 'Ocean Depth',
    description: 'Dark teal waters with aqua highlights',
    preview: { bg: '#0f1e24', card: '#162d36', primary: '#22b8cf', accent: '#15aabf' },
  },
  {
    id: 'emerald-dark',
    label: 'Emerald Dark',
    description: 'Rich dark greens with lime accents',
    preview: { bg: '#0f1a14', card: '#162a1e', primary: '#40c057', accent: '#51cf66' },
  },
  {
    id: 'rose-noir',
    label: 'Rose Noir',
    description: 'Dark charcoal with rose-pink accents',
    preview: { bg: '#1a1318', card: '#2a1e26', primary: '#e64980', accent: '#f06595' },
  },
  {
    id: 'amber-night',
    label: 'Amber Night',
    description: 'Warm dark tones with golden amber',
    preview: { bg: '#1a1610', card: '#2a2418', primary: '#fab005', accent: '#fd7e14' },
  },
  {
    id: 'arctic-frost',
    label: 'Arctic Frost',
    description: 'Cool grays with icy blue accents',
    preview: { bg: '#151a1e', card: '#1e252c', primary: '#74c0fc', accent: '#a5d8ff' },
  },
  {
    id: 'violet-storm',
    label: 'Violet Storm',
    description: 'Deep purples with vivid violet flares',
    preview: { bg: '#18112a', card: '#241940', primary: '#9775fa', accent: '#b197fc' },
  },
  {
    id: 'cyber-teal',
    label: 'Cyber Teal',
    description: 'Neon-tinged dark with bright teal',
    preview: { bg: '#0a1a1a', card: '#122828', primary: '#20c997', accent: '#38d9a9' },
  },
  {
    id: 'sunset-glow',
    label: 'Sunset Glow',
    description: 'Warm dark canvas with coral and orange',
    preview: { bg: '#1a1210', card: '#2a1e18', primary: '#ff6b6b', accent: '#ffa94d' },
  },
  {
    id: 'slate-minimal',
    label: 'Slate Minimal',
    description: 'Neutral dark slate with subtle gray accents',
    preview: { bg: '#161618', card: '#222225', primary: '#909296', accent: '#c1c2c5' },
  },
];

interface ThemeState {
  theme: ThemeId;
  setTheme: (theme: ThemeId) => void;
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      theme: 'midnight-blue',
      setTheme: (theme) => set({ theme }),
    }),
    { name: 'kb-theme' },
  ),
);
