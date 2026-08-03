import { useEditorState } from '@tiptap/react';
import type { Editor as EditorType } from '@tiptap/react';
import { Bold, Italic, Underline, Strikethrough, Code, Highlighter } from 'lucide-react';
import { cn } from '../../lib/cn';

/**
 * #708 / #1179 — the editor's inline-formatting toggles, shared by the
 * selection bubble menu and the block context menu.
 *
 * The two surfaces differ only in *what* they format. The bubble menu acts on
 * the live selection; the block menu acts on one block's content range, which
 * it resolves fresh on every render and every click (`getRange`) because the
 * position is remapped through each transaction. Passing a resolver rather than
 * a range keeps the pressed state honest — it is recomputed from the live
 * document, not from a value captured when the menu opened.
 */

interface MarkSpec {
  key: string;
  /** Schema mark name — also the TipTap `toggle<Name>` command suffix. */
  mark: string;
  title: string;
  Icon: typeof Bold;
  run: (editor: EditorType, range: { from: number; to: number } | null) => void;
}

/**
 * Apply a mark toggle. When a range is supplied it is selected *inside the same
 * chain*, so the command runs against the whole block rather than wherever the
 * caret happened to be — then the selection is collapsed again.
 *
 * That collapse matters: a block-wide selection left behind outlives the menu,
 * and the moment the menu's marker clears, `selectionShouldShow` sees a
 * non-empty selection and pops the bubble menu over the block the user just
 * finished with. Nothing is lost by collapsing — while the block menu is open
 * the target is shown by its outline decoration, not by the selection.
 */
function toggle(
  editor: EditorType,
  range: { from: number; to: number } | null,
  command: (chain: ReturnType<EditorType['chain']>) => ReturnType<EditorType['chain']>,
): void {
  const chain = editor.chain().focus();
  if (!range) {
    command(chain).run();
    return;
  }
  command(chain.setTextSelection(range)).setTextSelection(range.to).run();
}

const MARKS: readonly MarkSpec[] = [
  {
    key: 'bold', mark: 'bold', title: 'Bold (Ctrl+B)', Icon: Bold,
    run: (e, r) => toggle(e, r, (c) => c.toggleBold()),
  },
  {
    key: 'italic', mark: 'italic', title: 'Italic (Ctrl+I)', Icon: Italic,
    run: (e, r) => toggle(e, r, (c) => c.toggleItalic()),
  },
  {
    key: 'underline', mark: 'underline', title: 'Underline (Ctrl+U)', Icon: Underline,
    run: (e, r) => toggle(e, r, (c) => c.toggleUnderline()),
  },
  {
    key: 'strike', mark: 'strike', title: 'Strikethrough (Ctrl+Shift+X)', Icon: Strikethrough,
    run: (e, r) => toggle(e, r, (c) => c.toggleStrike()),
  },
  {
    key: 'code', mark: 'code', title: 'Inline code (Ctrl+E)', Icon: Code,
    run: (e, r) => toggle(e, r, (c) => c.toggleCode()),
  },
  {
    key: 'highlight', mark: 'highlight', title: 'Highlight (Ctrl+Shift+H)', Icon: Highlighter,
    run: (e, r) => toggle(e, r, (c) => c.toggleHighlight()),
  },
];

/**
 * Whether a toggle would *remove* the mark. Mirrors prosemirror-commands'
 * `toggleMark`, which removes when ANY of the range already carries the mark —
 * so a "some" test, not an "all" test, is what predicts the click's outcome.
 */
function rangeIsActive(
  editor: EditorType,
  mark: string,
  range: { from: number; to: number },
): boolean {
  const type = editor.schema.marks[mark];
  if (!type) return false;
  const { doc } = editor.state;
  const from = Math.max(0, Math.min(range.from, doc.content.size));
  const to = Math.max(from, Math.min(range.to, doc.content.size));
  return doc.rangeHasMark(from, to, type);
}

function MenuButton({
  onClick, active, title, children,
}: {
  onClick: () => void;
  active?: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()} // keep editor selection on click
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={cn(
        'flex h-8 w-8 items-center justify-center rounded transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
        active
          ? 'bg-primary/20 text-primary ring-1 ring-primary/30'
          : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

export function EditorFormatBar({
  editor,
  ariaLabel,
  getRange,
  className,
  children,
}: {
  editor: EditorType;
  ariaLabel: string;
  /**
   * Resolve the range to format. Omit to act on the live selection (bubble
   * menu). Supplying it opts into *scoped* mode: if it ever returns `null` the
   * target is gone and the toggles go inert rather than silently falling back
   * to the live selection and formatting some other block.
   */
  getRange?: () => { from: number; to: number } | null;
  className?: string;
  /** Trailing slot, rendered after a vertical separator (the Improve entry). */
  children?: React.ReactNode;
}) {
  // Subscribe to the document so the pressed states re-render on every
  // selection change and every toggle. `useEditorState` compares results
  // deeply, so a fresh object per transaction still re-renders only on change.
  const scoped = getRange !== undefined;
  const active = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const range = getRange?.() ?? null;
      return MARKS.map(({ mark }) => {
        if (!scoped) return e.isActive(mark);
        return range ? rangeIsActive(e, mark, range) : false;
      });
    },
  });

  return (
    <div role="toolbar" aria-label={ariaLabel} className={cn('flex items-center gap-0.5 p-1', className)}>
      {MARKS.map(({ key, title, Icon, run }, i) => (
        <MenuButton
          key={key}
          onClick={() => {
            if (!getRange) { run(editor, null); return; }
            // Re-resolved at click time: the document may have moved since the
            // last render, and a vanished target must be a no-op, not a
            // fall-through onto the live selection.
            const range = getRange();
            if (range) run(editor, range);
          }}
          active={active[i]}
          title={title}
        >
          <Icon size={15} />
        </MenuButton>
      ))}

      {children && (
        <>
          <div role="separator" aria-orientation="vertical" className="mx-0.5 h-5 w-px bg-border" />
          {children}
        </>
      )}
    </div>
  );
}
