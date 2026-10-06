import { isPresetTextColor, type PageIcon } from '@compendiq/contracts';

export function toPageIcon(
  kind: string | null | undefined,
  value: string | null | undefined,
  color?: string | null,
  filled?: boolean | null,
): PageIcon | null {
  if (kind !== 'emoji' && kind !== 'lucide' && kind !== 'image' && kind !== 'brand') return null;
  if (!value) return null;
  const icon: PageIcon = { kind, value };
  if ((kind === 'lucide' || kind === 'brand') && color && isPresetTextColor(color)) {
    icon.color = color;
  }
  if (kind === 'lucide' && filled) {
    icon.filled = true;
  }
  return icon;
}
