import { isPresetTextColor, type PageIcon } from '@compendiq/contracts';

export function toPageIcon(
  kind: string | null | undefined,
  value: string | null | undefined,
  color?: string | null,
): PageIcon | null {
  if (kind !== 'emoji' && kind !== 'lucide' && kind !== 'image' && kind !== 'brand') return null;
  if (!value) return null;
  if ((kind === 'lucide' || kind === 'brand') && color && isPresetTextColor(color)) {
    return { kind, value, color };
  }
  return { kind, value };
}
