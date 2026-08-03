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
  // An unrecognised Confluence macro carries the real macro name — far more
  // useful than the generic "Macro" when deciding whether to delete it.
  if (name === 'unknownMacro') {
    const macro = node.attrs.macroName as string | undefined;
    return macro ? `${macro} macro` : 'Macro';
  }
  return BLOCK_LABELS[name] ?? humanizeTypeName(name);
}
