import { useEditorState } from '@tiptap/react';
import type { Editor as EditorType } from '@tiptap/react';
import {
  Bold, Italic, Underline, Strikethrough, Code, Highlighter,
  AlignLeft, AlignCenter, AlignRight, AlignJustify,
} from 'lucide-react';
import { cn } from '../../lib/cn';

/**
 * #708 / #1179 — the editor's inline-formatting toggles, shared by the
 * selection bubble menu and the block context menu.
 */

interface MarkSpec {
  key: string;
  /** Schema mark name — also the TipTap `toggle<Name>` command suffix. */
  mark: string;
  title: string;
  Icon: typeof Bold;
  run: (editor: EditorType, range: { from: number; to: number } | null) => void;
}

interface AlignSpec {
  alignment: 'left' | 'center' | 'right' | 'justify';
  title: string;
  Icon: typeof AlignLeft;
}

const ALIGNMENTS: readonly AlignSpec[] = [
  { alignment: 'left', title: 'Align left', Icon: AlignLeft },
  { alignment: 'center', title: 'Align center', Icon: AlignCenter },
  { alignment: 'right', title: 'Align right', Icon: AlignRight },
  { alignment: 'justify', title: 'Justify', Icon: AlignJustify },
];

/**
 * Apply a mark toggle. When a range is supplied it is selected *inside the same
 * chain*, so the command runs against the whole block rather than wherever the
 * caret happened to be — then the selection is collapsed again.
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

function setAlign(
  editor: EditorType,
  range: { from: number; to: number } | null,
  alignment: 'left' | 'center' | 'right' | 'justify',
): void {
  const chain = editor.chain().focus();
  if (!range) {
    chain.setTextAlign(alignment).run();
    return;
  }
  chain
    .setTextSelection({ from: range.from, to: range.to })
    .setTextAlign(alignment)
    .setTextSelection({ from: range.from, to: range.from })
    .run();
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

function getAlignActive(
  editor: EditorType,
  alignment: 'left' | 'center' | 'right' | 'justify',
  range: { from: number; to: number } | null,
  scoped: boolean,
): boolean {
  if (scoped) {
    if (!range) return false;
    const parentNode = editor.state.doc.resolve(range.from).parent;
    const currentAlign = parentNode.attrs.textAlign || 'left';
    return currentAlign === alignment;
  }
  return editor.isActive({ textAlign: alignment });
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
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className="nm-icon-button"
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
  getRange?: () => { from: number; to: number } | null;
  className?: string;
  children?: React.ReactNode;
}) {
  const scoped = getRange !== undefined;
  const activeState = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const range = getRange?.() ?? null;
      const marks = MARKS.map(({ mark }) => {
        if (!scoped) return e.isActive(mark);
        return range ? rangeIsActive(e, mark, range) : false;
      });
      const aligns = ALIGNMENTS.map(({ alignment }) =>
        getAlignActive(e, alignment, range, scoped),
      );
      return { marks, aligns };
    },
  });

  return (
    <div role="toolbar" aria-label={ariaLabel} className={cn('flex flex-wrap items-center gap-0.5 p-1', className)}>
      {MARKS.map(({ key, title, Icon, run }, i) => (
        <MenuButton
          key={key}
          onClick={() => {
            if (!getRange) { run(editor, null); return; }
            const range = getRange();
            if (range) run(editor, range);
          }}
          active={activeState.marks[i]}
          title={title}
        >
          <Icon size={15} />
        </MenuButton>
      ))}

      <div role="separator" aria-orientation="vertical" className="mx-0.5 h-5 w-px bg-border" />

      {ALIGNMENTS.map(({ alignment, title, Icon }, i) => (
        <MenuButton
          key={alignment}
          onClick={() => {
            const range = getRange ? getRange() : null;
            if (scoped && !range) return;
            setAlign(editor, range, alignment);
          }}
          active={activeState.aligns[i]}
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
