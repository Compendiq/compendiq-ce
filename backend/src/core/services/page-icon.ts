import type { PageIcon } from '@compendiq/contracts';

export function toPageIcon(
  kind: string | null | undefined,
  value: string | null | undefined,
): PageIcon | null {
  if (kind !== 'emoji' && kind !== 'lucide' && kind !== 'image' && kind !== 'brand') return null;
  if (!value) return null;
  return { kind, value };
}
