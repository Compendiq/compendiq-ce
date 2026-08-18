import { z } from 'zod';

export const PageIconKindEnum = z.enum(['emoji', 'lucide', 'image']);
export type PageIconKind = z.infer<typeof PageIconKindEnum>;

/**
 * Closed Lucide catalogue a page mark may carry. Kept here so the PATCH
 * validator and the picker cannot disagree about which ids are legal.
 * HardDrive / Globe stay out — those are sidebar chrome for local / Confluence
 * spaces, and a page wearing either would be indistinguishable from that state.
 */
export const PAGE_LUCIDE_ICONS = [
  { value: 'book', label: 'Book' },
  { value: 'bookmark', label: 'Bookmark' },
  { value: 'file-text', label: 'Document' },
  { value: 'files', label: 'Files' },
  { value: 'folder', label: 'Folder' },
  { value: 'folder-open', label: 'Open folder' },
  { value: 'clipboard-list', label: 'Checklist' },
  { value: 'notebook', label: 'Notebook' },
  { value: 'newspaper', label: 'Newspaper' },
  { value: 'library', label: 'Library' },
  { value: 'rocket', label: 'Rocket' },
  { value: 'lightbulb', label: 'Idea' },
  { value: 'zap', label: 'Zap' },
  { value: 'star', label: 'Star' },
  { value: 'heart', label: 'Heart' },
  { value: 'flag', label: 'Flag' },
  { value: 'target', label: 'Target' },
  { value: 'compass', label: 'Compass' },
  { value: 'map', label: 'Map' },
  { value: 'milestone', label: 'Milestone' },
  { value: 'code', label: 'Code' },
  { value: 'terminal', label: 'Terminal' },
  { value: 'bug', label: 'Bug' },
  { value: 'git-branch', label: 'Branch' },
  { value: 'database', label: 'Database' },
  { value: 'server', label: 'Server' },
  { value: 'cpu', label: 'CPU' },
  { value: 'wifi', label: 'Network' },
  { value: 'lock', label: 'Lock' },
  { value: 'shield', label: 'Shield' },
  { value: 'key', label: 'Key' },
  { value: 'users', label: 'Team' },
  { value: 'user', label: 'Person' },
  { value: 'briefcase', label: 'Work' },
  { value: 'building-2', label: 'Building' },
  { value: 'calendar', label: 'Calendar' },
  { value: 'clock', label: 'Clock' },
  { value: 'mail', label: 'Mail' },
  { value: 'message-circle', label: 'Chat' },
  { value: 'bell', label: 'Bell' },
  { value: 'settings', label: 'Settings' },
  { value: 'wrench', label: 'Wrench' },
  { value: 'search', label: 'Search' },
  { value: 'filter', label: 'Filter' },
  { value: 'list', label: 'List' },
  { value: 'layout-grid', label: 'Grid' },
  { value: 'layers', label: 'Layers' },
  { value: 'puzzle', label: 'Puzzle' },
  { value: 'boxes', label: 'Boxes' },
  { value: 'package', label: 'Package' },
  { value: 'check-circle', label: 'Done' },
  { value: 'alert-triangle', label: 'Warning' },
  { value: 'info', label: 'Info' },
  { value: 'help-circle', label: 'Help' },
  { value: 'circle-dot', label: 'Point' },
  { value: 'pen-line', label: 'Edit' },
  { value: 'image', label: 'Image' },
  { value: 'camera', label: 'Camera' },
  { value: 'video', label: 'Video' },
  { value: 'music', label: 'Music' },
  { value: 'mic', label: 'Mic' },
  { value: 'play', label: 'Play' },
  { value: 'film', label: 'Film' },
  { value: 'leaf', label: 'Leaf' },
  { value: 'sun', label: 'Sun' },
  { value: 'moon', label: 'Moon' },
  { value: 'cloud', label: 'Cloud' },
  { value: 'droplet', label: 'Drop' },
  { value: 'flame', label: 'Flame' },
  { value: 'mountain', label: 'Mountain' },
  { value: 'tree-pine', label: 'Tree' },
  { value: 'flower-2', label: 'Flower' },
  { value: 'car', label: 'Car' },
  { value: 'plane', label: 'Plane' },
  { value: 'ship', label: 'Ship' },
  { value: 'bike', label: 'Bike' },
  { value: 'house', label: 'Home' },
  { value: 'coffee', label: 'Coffee' },
  { value: 'utensils', label: 'Food' },
  { value: 'gift', label: 'Gift' },
  { value: 'trophy', label: 'Trophy' },
  { value: 'medal', label: 'Medal' },
  { value: 'link', label: 'Link' },
  { value: 'paperclip', label: 'Attachment' },
  { value: 'pin', label: 'Pin' },
  { value: 'tag', label: 'Tag' },
  { value: 'hash', label: 'Hash' },
  { value: 'chart-column', label: 'Chart' },
  { value: 'graduation-cap', label: 'Learning' },
  { value: 'stethoscope', label: 'Health' },
  { value: 'scale', label: 'Legal' },
  { value: 'wallet', label: 'Finance' },
  { value: 'megaphone', label: 'Announce' },
  { value: 'sparkles', label: 'Sparkles' },
  { value: 'bot', label: 'Bot' },
] as const;

export type PageLucideIconId = (typeof PAGE_LUCIDE_ICONS)[number]['value'];

export const PAGE_LUCIDE_ICON_IDS: readonly PageLucideIconId[] = PAGE_LUCIDE_ICONS.map(
  (icon) => icon.value,
);

const LUCIDE_ID_SET = new Set<string>(PAGE_LUCIDE_ICON_IDS);

export function isPageLucideIconId(value: string): value is PageLucideIconId {
  return LUCIDE_ID_SET.has(value);
}

/** One persisted page mark. `value` is the emoji, the Lucide id, or the image sha. */
export const PageIconSchema = z.object({
  kind: PageIconKindEnum,
  value: z.string().min(1).max(128),
});
export type PageIcon = z.infer<typeof PageIconSchema>;
export type SettablePageIcon = { kind: 'emoji' | 'lucide'; value: string };

/** PATCH /pages/:id/icon — image marks go through POST /pages/:id/icon-image. */
export const UpdatePageIconSchema = z.object({
  icon: z
    .union([
      z.object({
        kind: z.literal('emoji'),
        value: z
          .string()
          .min(1)
          .max(32)
          .refine((value) => !/[\u0000-\u001f<>\\]/.test(value), 'Invalid emoji'),
      }),
      z.object({
        kind: z.literal('lucide'),
        value: z.string().refine(isPageLucideIconId, 'Unknown icon'),
      }),
    ])
    .nullable(),
});
export type UpdatePageIconInput = z.infer<typeof UpdatePageIconSchema>;

export const PageIconResponseSchema = z.object({
  icon: PageIconSchema.nullable(),
});
export type PageIconResponse = z.infer<typeof PageIconResponseSchema>;
