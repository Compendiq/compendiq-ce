import type { ReactNode } from 'react';
import type { AppEdition } from '@compendiq/contracts';
import { Logo } from '../../../shared/components/Logo';

interface LoginBrandHeaderProps {
  controls?: ReactNode;
  /** Null while the presentation config is in flight, or when it failed / came
   *  from a backend predating the field. The badge is then omitted: both
   *  editions ship this same SPA, so a hardcoded default would brand every EE
   *  sign-in screen "Community Edition · AGPL-3.0". */
  edition?: AppEdition | null;
}

const EDITION_LABELS: Record<AppEdition, string> = {
  community: 'Community Edition · AGPL-3.0',
  enterprise: 'Enterprise Edition',
};

export function LoginBrandHeader({ controls, edition }: LoginBrandHeaderProps) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-4">
      <Logo className="h-9 w-auto max-w-[10rem] text-foreground sm:h-10 sm:max-w-[12rem]" title="Compendiq" />
      <div className="ml-auto flex items-center gap-3">
        {controls}
        {edition && (
          <span className="text-xs font-medium text-muted-foreground">
            {EDITION_LABELS[edition]}
          </span>
        )}
      </div>
    </header>
  );
}
