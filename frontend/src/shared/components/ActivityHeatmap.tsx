import { useMemo } from 'react';
import { m } from 'framer-motion';
import { cn } from '../lib/cn';

interface ActivityDay {
  date: string; // ISO date string (YYYY-MM-DD)
  count: number;
}

interface ActivityHeatmapProps {
  /** Array of { date, count } for edit/sync activity */
  data: ActivityDay[];
  /** Number of weeks to show (default 26 = ~6 months) */
  weeks?: number;
  /** CSS class name */
  className?: string;
}

const DAY_LABELS = ['', 'Mon', '', 'Wed', '', 'Fri', ''];
const CELL_SIZE = 12;
const CELL_GAP = 2;
const TOTAL_CELL = CELL_SIZE + CELL_GAP;

/** Format a local Date as YYYY-MM-DD without timezone issues */
function toLocalDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * GitHub-style contribution heatmap showing article edit/sync activity over time.
 */
export function ActivityHeatmap({ data, weeks = 26, className }: ActivityHeatmapProps) {
  const { grid, maxCount, monthLabels } = useMemo(() => {
    // Build a map of date -> count
    const countMap = new Map<string, number>();
    for (const d of data) {
      countMap.set(d.date, (countMap.get(d.date) ?? 0) + d.count);
    }

    // Calculate the date range: end = today, start = (weeks * 7) days ago, aligned to Sunday
    const today = new Date();
    const endDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    // Find the last Saturday (end of week) or just use today
    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - (weeks * 7) + 1);
    // Align start to the previous Sunday
    startDate.setDate(startDate.getDate() - startDate.getDay());

    let max = 0;
    const cells: Array<{ date: string; count: number; dayOfWeek: number; weekIndex: number }> = [];
    const months: Array<{ label: string; weekIndex: number }> = [];
    let lastMonth = -1;

    const current = new Date(startDate);
    let weekIndex = 0;

    while (current <= endDate) {
      const dayOfWeek = current.getDay();
      const dateStr = toLocalDateStr(current);
      const count = countMap.get(dateStr) ?? 0;
      if (count > max) max = count;

      cells.push({ date: dateStr, count, dayOfWeek, weekIndex });

      // Track month labels
      if (current.getMonth() !== lastMonth) {
        months.push({
          label: current.toLocaleString('default', { month: 'short' }),
          weekIndex,
        });
        lastMonth = current.getMonth();
      }

      current.setDate(current.getDate() + 1);
      if (current.getDay() === 0) weekIndex++;
    }

    return { grid: cells, maxCount: max, monthLabels: months };
  }, [data, weeks]);

  // Color intensity levels (4 levels + empty)
  function getCellClass(count: number): string {
    if (count === 0) return 'fill-foreground/5';
    if (maxCount === 0) return 'fill-foreground/5';
    const ratio = count / maxCount;
    if (ratio <= 0.25) return 'fill-success/30';
    if (ratio <= 0.5) return 'fill-success/50';
    if (ratio <= 0.75) return 'fill-success/70';
    return 'fill-success/90';
  }

  const totalWeeks = Math.ceil(grid.length / 7) + 1;
  const svgWidth = totalWeeks * TOTAL_CELL + 30; // 30px for day labels
  const svgHeight = 7 * TOTAL_CELL + 20; // 20px for month labels

  // Respect prefers-reduced-motion
  const prefersReducedMotion = useMemo(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }, []);

  return (
    <m.div
      initial={prefersReducedMotion ? {} : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className={cn('glass-card overflow-x-auto p-4', className)}
      data-testid="activity-heatmap"
    >
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-medium">Activity</h3>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span>Less</span>
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-foreground/5" />
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-success/30" />
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-success/50" />
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-success/70" />
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-success/90" />
          <span>More</span>
        </div>
      </div>

      <svg
        width={svgWidth}
        height={svgHeight}
        className="text-muted-foreground"
        role="img"
        aria-label="Activity heatmap showing article edits and syncs over time"
      >
        {/* Month labels */}
        {monthLabels.map((m, i) => (
          <text
            key={`month-${i}`}
            x={m.weekIndex * TOTAL_CELL + 30}
            y={10}
            className="fill-current text-[9px]"
          >
            {m.label}
          </text>
        ))}

        {/* Day labels */}
        {DAY_LABELS.map((label, i) => (
          label ? (
            <text
              key={`day-${i}`}
              x={0}
              y={i * TOTAL_CELL + 24}
              className="fill-current text-[9px]"
              dominantBaseline="middle"
            >
              {label}
            </text>
          ) : null
        ))}

        {/* Grid cells */}
        {grid.map((cell) => (
          <rect
            key={cell.date}
            x={cell.weekIndex * TOTAL_CELL + 30}
            y={cell.dayOfWeek * TOTAL_CELL + 16}
            width={CELL_SIZE}
            height={CELL_SIZE}
            rx={2}
            className={getCellClass(cell.count)}
          >
            <title>{`${cell.date}: ${cell.count} ${cell.count === 1 ? 'activity' : 'activities'}`}</title>
          </rect>
        ))}
      </svg>
    </m.div>
  );
}
