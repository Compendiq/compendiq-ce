import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  BookOpen,
  Bot,
  Check,
  Columns3,
  Focus,
  LayoutTemplate,
} from 'lucide-react';
import { cn } from '../../lib/cn';

export type LayoutPreset = 'reading' | 'editing' | 'focus' | 'research';

const presets: Array<{
  id: LayoutPreset;
  label: string;
  description: string;
  icon: typeof BookOpen;
}> = [
  {
    id: 'reading',
    label: 'Reading',
    description: 'Outline open, navigation quiet',
    icon: BookOpen,
  },
  {
    id: 'editing',
    label: 'Editing',
    description: 'Page tree and details visible',
    icon: Columns3,
  },
  {
    id: 'focus',
    label: 'Focus',
    description: 'Collapse both side panels',
    icon: Focus,
  },
  {
    id: 'research',
    label: 'Research',
    description: 'Page tree with AI assistant',
    icon: Bot,
  },
];

export function LayoutPresetMenu({
  activePreset,
  onSelect,
}: {
  activePreset: LayoutPreset | null;
  onSelect: (preset: LayoutPreset) => void;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="app-search flex h-9 items-center gap-2 rounded-lg px-2.5 text-xs font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
          aria-label="Layout presets"
          title="Layout presets"
        >
          <LayoutTemplate size={15} aria-hidden="true" />
          <span className="hidden xl:inline">Layout</span>
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={8}
          className="z-50 w-64 rounded-xl border border-border bg-card p-1.5 shadow-xl"
          aria-label="Layout presets"
        >
          <DropdownMenu.Label className="px-2.5 pb-1 pt-2 text-[11px] font-semibold text-muted-foreground">
            Page layout
          </DropdownMenu.Label>
          {presets.map((preset) => {
            const Icon = preset.icon;
            const active = activePreset === preset.id;
            return (
              <DropdownMenu.Item
                key={preset.id}
                onSelect={() => onSelect(preset.id)}
                className={cn(
                  'flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 outline-none transition-colors',
                  'data-[highlighted]:bg-foreground/[0.07] data-[highlighted]:text-foreground',
                  active ? 'text-foreground' : 'text-muted-foreground',
                )}
              >
                <span
                  className={cn(
                    'flex size-7 shrink-0 items-center justify-center rounded-lg',
                    active ? 'bg-primary/12 text-primary-ink' : 'bg-foreground/[0.045]',
                  )}
                >
                  <Icon size={14} aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-medium">{preset.label}</span>
                  <span className="mt-0.5 block text-[11px] text-muted-foreground">
                    {preset.description}
                  </span>
                </span>
                {active && <Check size={13} className="shrink-0 text-action" aria-label="Active" />}
              </DropdownMenu.Item>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
