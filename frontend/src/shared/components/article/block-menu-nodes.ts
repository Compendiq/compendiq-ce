import type { Node as PMNode } from '@tiptap/pm/model';

/**
 * #1179 — which blocks the block context menu may offer text actions on, and
 * what to call each block in the UI.
 *
 * The allow-list is deliberately tiny and closed. Everything the editor's
 * schema contains beyond these four — every Confluence macro node, every
 * atom, every layout container, and anything added later — gets Delete only.
 *
 * This is the content-loss guard, not a convenience. The Improve flow ends in
 * `insertContentAt(range, markdownDerivedHtml)`; over a structured node that
 * replaces a draw.io diagram, a status macro or a layout with plain HTML, and
 * the next Save pushes the loss to Confluence. Hiding — rather than disabling —
 * the text actions means there is no control to flip on later, which is the
 * decision recorded on the issue.
 *
 * `codeBlock` is excluded to match `selectionShouldShow`, which has always
 * refused to offer inline formatting or Improve inside code.
 *
 * `listItem` is here because the decision on #1179 names it, but it is not
 * reachable through the drag handle as the editor is configured today:
 * `<DragHandle>` runs in its default non-nested mode, where the library's
 * `getOuterNode` climbs to the doc's direct child — so hovering a list resolves
 * to the `bulletList` / `orderedList` (Delete-only) and never to the item
 * inside it. That same climb is why `blockquote` IS reachable: it is itself a
 * top-level block. Turning the handle's `nested` option on would make
 * `listItem` live without any change here, which is why it stays.
 */
export const TEXT_BLOCK_TYPES: ReadonlySet<string> = new Set([
  'paragraph',
  'heading',
  'blockquote',
  'listItem',
]);

/** Whether formatting toggles and Improve may be offered for this node. */
export function supportsTextActions(node: PMNode): boolean {
  return TEXT_BLOCK_TYPES.has(node.type.name);
}

/**
 * The second half of the same guard, for content *inside* an allowed block.
 *
 * `TEXT_BLOCK_TYPES` keeps Improve away from block-level macros, but a plain
 * `paragraph` may still carry Confluence's **inline** atoms — `confluenceStatus`,
 * `confluenceUserMention`, `confluenceJiraIssue`. Those are invisible to the
 * rewrite twice over: `doc.textBetween` skips them entirely, so the model never
 * sees them (a paragraph reading "Ask @jdoe about DONE" is sent as
 * `"Ask  about "`), and the Markdown-derived HTML that comes back replaces the
 * whole content range, deleting the nodes. The next Save pushes that to
 * Confluence — the same silent loss `TEXT_BLOCK_TYPES` exists to prevent, just
 * one level down.
 *
 * Formatting toggles are unaffected: a mark toggle rewrites marks, not nodes,
 * and leaves the atoms in place.
 *
 * `hardBreak` is excluded deliberately. It is a leaf and so an atom by
 * ProseMirror's reckoning, but losing a line break is cosmetic and undoable —
 * not the structured Confluence content this guard is about — and blocking
 * Improve on every paragraph that contains a `<br>` would gut the feature.
 */
export function containsStructuredInline(doc: PMNode, from: number, to: number): boolean {
  let found = false;
  doc.nodesBetween(from, to, (node) => {
    if (found) return false;
    if (node.isInline && !node.isText && node.type.name !== 'hardBreak') found = true;
    return !found;
  });
  return found;
}

/**
 * Human names for the block types the editor can produce. The menu shows this
 * so the user can see what the menu targets before deleting it — the block is
 * also outlined in the document, but the two together remove any doubt.
 */
const BLOCK_LABELS: Readonly<Record<string, string>> = {
  paragraph: 'Paragraph',
  blockquote: 'Quote',
  listItem: 'List item',
  taskItem: 'Task',
  bulletList: 'Bulleted list',
  orderedList: 'Numbered list',
  taskList: 'Task list',
  codeBlock: 'Code block',
  horizontalRule: 'Divider',
  table: 'Table',
  tableRow: 'Table row',
  tableCaption: 'Table caption',
  image: 'Image',
  figure: 'Figure',
  figcaption: 'Caption',
  figureIndex: 'Figure index',
  tableIndex: 'Table index',
  details: 'Expand',
  detailsSummary: 'Expand title',
  panel: 'Panel',
  mermaidBlock: 'Mermaid diagram',
  drawioDiagram: 'Draw.io diagram',
  confluenceToc: 'Table of contents',
  confluenceStatus: 'Status badge',
  confluenceChildren: 'Child pages',
  confluenceAttachments: 'Attachments',
  confluenceJiraIssue: 'Jira issue',
  confluenceUserMention: 'Mention',
  confluenceIncludeMacro: 'Included page',
  confluenceLabelsMacro: 'Labels',
  confluenceLayout: 'Layout',
  confluenceLayoutSection: 'Layout section',
  confluenceLayoutCell: 'Layout cell',
  confluenceSection: 'Section',
  confluenceColumn: 'Column',
};

/** `confluenceJiraIssue` → `Confluence jira issue`, for node types we missed. */
function humanizeTypeName(name: string): string {
  const spaced = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Display name for a block, e.g. `Heading 2`, `Draw.io diagram`, `info panel`. */
export function blockLabel(node: PMNode): string {
  const name = node.type.name;
  if (name === 'heading') {
    const level = node.attrs.level as number | undefined;
    return level ? `Heading ${level}` : 'Heading';
  }
  if (name === 'panel') {
    const type = node.attrs.panelType as string | undefined;
    if (type) {
      const capitalized = type.charAt(0).toUpperCase() + type.slice(1);
      return `${capitalized} panel`;
    }
    return 'Panel';
  }
  if (name === 'details') {
    const macroName = node.attrs.macroName as string | undefined;
    if (macroName === 'ui-expand') return 'UI Expand';
    return 'Expand';
  }
  // An unrecognised Confluence macro carries the real macro name — far more
  // useful than the generic "Macro" when deciding whether to delete it.
  if (name === 'unknownMacro') {
    const macro = node.attrs.macroName as string | undefined;
    return macro ? `${macro} macro` : 'Macro';
  }
  return BLOCK_LABELS[name] ?? humanizeTypeName(name);
}

/**
 * Marks that do not survive a rewrite, because `doc.textBetween` strips every
 * mark before the text reaches the model and nothing it returns can restore
 * them. Listed rather than "all marks" because the distinction is whether the
 * loss is *recoverable from the answer itself*:
 *
 * - `link` — the href is data, not formatting. A bare word ships to Confluence
 *   where a page link was.
 * - `code` — the worst of these in a KB. `POST /api/pages` demoted to prose
 *   changes what the sentence means, and unlike a colour the reader cannot tell
 *   by looking that it used to be code.
 * - `highlight`, `textStyle` — deliberate emphasis and colour the user applied.
 *
 * `bold` / `italic` / `strike` are deliberately absent: they are expressible in
 * Markdown, so a rewrite plausibly re-emits them, and warning about them would
 * fire on almost every block and train the user to ignore the warning.
 */
const LOSSY_MARKS: readonly string[] = ['link', 'code', 'highlight', 'textStyle'];

/**
 * Whether a range carries marks a Markdown round-trip cannot give back.
 *
 * Unlike an inline macro node this only warns rather than hides. The text
 * survives, the loss is confined to the formatting, the streamed preview shows
 * the answer before the user accepts — and these marks are common enough that
 * hiding Improve wherever one appears would gut the feature. The user is told
 * before they accept, which is the part that was missing.
 */
export function containsLossyMarks(doc: PMNode, from: number, to: number): boolean {
  const { marks } = doc.type.schema;
  return LOSSY_MARKS.some((name) => {
    const type = marks[name];
    return type ? doc.rangeHasMark(from, to, type) : false;
  });
}

/**
 * Configuration for nested drag handle behavior.
 * Enables drag handles on blocks inside columns, layout cells, panels, quotes, and expand sections,
 * while excluding structural column/cell wrappers from being dragged as loose blocks.
 */
export const NESTED_DRAG_OPTIONS = {
  defaultRules: true,
  edgeDetection: 'none' as const,
  rules: [
    {
      id: 'excludeLayoutContainers',
      evaluate: ({ node, parent }: { node: { type: { name: string } }; parent?: { type: { name: string } } | null }) => {
        const layoutContainers = [
          'confluenceColumn',
          'confluenceLayoutCell',
          'confluenceLayoutSection',
          'tableRow',
          'tableCell',
          'tableHeader',
        ];
        if (layoutContainers.includes(node.type.name)) return 1000;
        // Direct content inside table cells routes drag targeting to the parent table
        if (parent?.type.name === 'tableCell' || parent?.type.name === 'tableHeader') {
          return 1000;
        }
        return 0;
      },
    },
  ],
};

