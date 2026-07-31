import type { ReactNode } from 'react';
import { Logo } from '../../../shared/components/Logo';

interface LoginBrandHeaderProps {
  controls?: ReactNode;
}

export function LoginBrandHeader({ controls }: LoginBrandHeaderProps) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-4">
      <Logo className="h-9 w-auto max-w-[10rem] text-foreground sm:h-10 sm:max-w-[12rem]" title="Compendiq" />
      <div className="ml-auto flex items-center gap-3">
        {controls}
        <span className="hidden text-xs font-medium text-muted-foreground sm:inline">Community Edition · AGPL-3.0</span>
      </div>
    </header>
  );
}
