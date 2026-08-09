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
  normal: 'bg-action/15 text-action',
  insert: 'bg-success/15 text-success',
  visual: 'bg-warning/15 text-warning',
};

export function VimModeIndicator({ vimState }: VimModeIndicatorProps) {
  const { mode, pendingKeys, countPrefix, commandBuffer } = vimState;

  return (
    <div
      data-testid="vim-mode-indicator"
      className="flex items-center gap-2 border-t border-border bg-card px-3 py-1 text-xs font-mono"
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
