import { cn } from '../../lib/cn';
import type { VimMode, VimState } from './vim-extension';

interface VimModeIndicatorProps {
  vimState: VimState;
}

const MODE_LABELS: Record<VimMode, string> = {
  normal: '-- NORMAL --',
  insert: '-- INSERT --',
  visual: '-- VISUAL --',
};

const MODE_COLORS: Record<VimMode, string> = {
  normal: 'bg-primary/15 text-primary',
  insert: 'bg-emerald-500/15 text-emerald-400',
  visual: 'bg-amber-500/15 text-amber-400',
};

export function VimModeIndicator({ vimState }: VimModeIndicatorProps) {
  const { mode, pendingKeys, countPrefix, commandBuffer } = vimState;

  return (
    <div
      data-testid="vim-mode-indicator"
      className="flex items-center gap-2 border-t border-border/50 bg-card/80 px-3 py-1 text-xs font-mono"
    >
      <span
        className={cn(
          'rounded px-2 py-0.5 font-bold tracking-wider',
          MODE_COLORS[mode],
        )}
      >
        {MODE_LABELS[mode]}
      </span>

      {/* Show pending operator / count prefix */}
      {(countPrefix || pendingKeys) && (
        <span className="text-muted-foreground">
          {countPrefix}{pendingKeys}
        </span>
      )}

      {/* Command-line buffer */}
      {commandBuffer !== null && (
        <span className="text-foreground">
          :{commandBuffer}
          <span className="animate-pulse">|</span>
        </span>
      )}
    </div>
  );
}
