import {
  Book,
  Briefcase,
  Code,
  GraduationCap,
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
 *
 * Two glyphs are banned from the catalogue because the SAME sidebar control
 * already spends them on chrome: HardDrive is the fallback for a local space
 * that never chose an icon, and Globe marks every Confluence space and "All
 * Spaces". A local space wearing either would be indistinguishable from the
 * state the glyph names. 'globe' WAS catalogued until PR #1256's review;
 * previously-saved rows fall back to HardDrive via the unrecognised-value
 * path in getSpaceIcon below. GraduationCap backfills the slot (unused
 * anywhere else in the app) so the picker keeps ten options.
 */
export const SPACE_ICONS: readonly SpaceIconOption[] = [
  { value: 'book', label: 'Book', Icon: Book },
  { value: 'code', label: 'Code', Icon: Code },
  { value: 'graduation-cap', label: 'Learning', Icon: GraduationCap },
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
