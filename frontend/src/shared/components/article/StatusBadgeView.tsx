import { useState, useCallback } from 'react';
import { NodeViewWrapper } from '@tiptap/react';
import * as Popover from '@radix-ui/react-popover';
import type { NodeViewProps } from '@tiptap/react';

const STATUS_COLORS = [
  { label: 'Grey', value: 'grey' },
  { label: 'Blue', value: 'blue' },
  { label: 'Green', value: 'green' },
  { label: 'Yellow', value: 'yellow' },
  { label: 'Red', value: 'red' },
] as const;

/**
 * React NodeView component for the ConfluenceStatus inline node.
 *
 * In edit mode, clicking the badge opens a Radix Popover with a text input
 * and color picker to modify the status label inline.
 *
 * In read-only mode, renders as a static colored badge using the existing
 * `.confluence-status` CSS classes from index.css.
 */
export function StatusBadgeView({ node, updateAttributes, editor }: NodeViewProps) {
  const { color, label } = node.attrs;
  const isEditable = editor.isEditable;

  const [open, setOpen] = useState(false);
  const [editLabel, setEditLabel] = useState(label);
  const [editColor, setEditColor] = useState(color);

  const handleOpen = useCallback(
    (nextOpen: boolean) => {
      if (!isEditable) return;
      setOpen(nextOpen);
      if (nextOpen) {
        // Reset edit state to current node values when opening
        setEditLabel(label);
        setEditColor(color);
      }
    },
    [isEditable, label, color],
  );

  const handleApply = useCallback(() => {
    const newLabel = editLabel.trim() || 'STATUS';
    updateAttributes({ color: editColor, label: newLabel });
    setOpen(false);
  }, [editLabel, editColor, updateAttributes]);

  return (
    <NodeViewWrapper as="span" className="status-badge-nodeview" style={{ display: 'inline' }}>
      <Popover.Root open={open} onOpenChange={handleOpen}>
        <Popover.Trigger asChild>
          <span
            role="button"
            tabIndex={0}
            className="confluence-status"
            data-color={color}
            data-testid="status-badge"
            style={{ cursor: isEditable ? 'pointer' : 'default' }}
            onKeyDown={(e) => {
              if (isEditable && (e.key === 'Enter' || e.key === ' ')) {
                e.preventDefault();
                setOpen(true);
              }
            }}
          >
            {label || 'STATUS'}
          </span>
        </Popover.Trigger>

        {isEditable && (
          <Popover.Portal>
            <Popover.Content
              className="z-50 w-56 rounded-lg border border-border bg-card p-3 shadow-lg"
              sideOffset={6}
              align="start"
              data-testid="status-badge-popover"
              onOpenAutoFocus={(e) => e.preventDefault()}
            >
              {/* Color picker */}
              <div className="mb-2 flex gap-1.5" data-testid="status-color-picker">
                {STATUS_COLORS.map((c) => (
                  <button
                    key={c.value}
                    type="button"
                    title={c.label}
                    data-testid={`status-color-${c.value}`}
                    onClick={() => setEditColor(c.value)}
                    className={`confluence-status h-6 min-w-[2.5rem] text-center transition-transform ${
                      editColor === c.value ? 'ring-2 ring-primary ring-offset-1 ring-offset-card scale-105' : ''
                    }`}
                    data-color={c.value}
                  >
                    {c.label.charAt(0)}
                  </button>
                ))}
              </div>

              {/* Label input */}
              <input
                type="text"
                value={editLabel}
                onChange={(e) => setEditLabel(e.target.value.toUpperCase())}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleApply();
                  }
                  // Prevent TipTap from capturing keyboard events inside the popover
                  e.stopPropagation();
                }}
                placeholder="STATUS"
                className="mb-2 w-full rounded-md border border-border bg-background px-2 py-1 text-xs font-semibold uppercase tracking-wide"
                data-testid="status-label-input"
                autoFocus
              />

              {/* Apply button */}
              <button
                type="button"
                onClick={handleApply}
                className="w-full rounded-md bg-primary/20 px-2 py-1 text-xs font-medium text-primary hover:bg-primary/30 transition-colors"
                data-testid="status-apply-btn"
              >
                Apply
              </button>

              <Popover.Arrow className="fill-card" />
            </Popover.Content>
          </Popover.Portal>
        )}
      </Popover.Root>
    </NodeViewWrapper>
  );
}
