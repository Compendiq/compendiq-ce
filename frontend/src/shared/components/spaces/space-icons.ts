import {
  Book,
  Briefcase,
  Code,
  Globe,
  HardDrive,
  Heart,
  Lightbulb,
  Rocket,
  Shield,
  Star,
  Zap,
  type LucideIcon,
} from 'lucide-react';

export interface SpaceIconOption {
  /** The identifier persisted in `spaces.icon` (POST/PUT /api/spaces/local). */
  value: string;
  /** Visible label — recognition over recall, so it stays beside the glyph. */
  label: string;
  Icon: LucideIcon;
}

/**
 * The catalogue of icons a local space can carry. Every surface that renders
 * local-space identity resolves the stored value through this one map, so the
 * picker on /spaces/new, the sidebar space selector and Space Settings cannot
 * disagree about which picture a value names.
 */
export const SPACE_ICONS: readonly SpaceIconOption[] = [
  { value: 'book', label: 'Book', Icon: Book },
  { value: 'code', label: 'Code', Icon: Code },
  { value: 'globe', label: 'Globe', Icon: Globe },
  { value: 'shield', label: 'Shield', Icon: Shield },
  { value: 'zap', label: 'Zap', Icon: Zap },
  { value: 'rocket', label: 'Rocket', Icon: Rocket },
  { value: 'star', label: 'Star', Icon: Star },
  { value: 'heart', label: 'Heart', Icon: Heart },
  { value: 'briefcase', label: 'Work', Icon: Briefcase },
  { value: 'lightbulb', label: 'Ideas', Icon: Lightbulb },
];

/**
 * Resolve a stored `space.icon` value to its glyph. The column is free text,
 * so unset AND unrecognised both fall back to HardDrive — the generic
 * local-space mark the sidebar has always used.
 */
export function getSpaceIcon(icon: string | null | undefined): LucideIcon {
  return SPACE_ICONS.find((option) => option.value === icon)?.Icon ?? HardDrive;
}
