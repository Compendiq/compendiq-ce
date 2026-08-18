import { Extension, Node, mergeAttributes, type Editor } from '@tiptap/core';
import { Table } from '@tiptap/extension-table';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { toast } from 'sonner';
import { DrawioDiagramNodeView } from './DrawioDiagramNodeView';
import { StatusBadgeView } from './StatusBadgeView';
import { AttachmentsMacroView } from './AttachmentsMacroView';
import { ChildrenMacroView } from './ChildrenMacroView';
import { FigureIndexView } from './FigureIndexView';
import { TableIndexView } from './TableIndexView';
import { createTableSelectionPerimeterPlugin } from './table-cell-selection';
import { CompendiqTableView } from './table-layout-view';
import { blockLabel } from './block-menu-nodes';

const SUMMARY_INTERACTIVE_DESCENDANT =
  'a[href], button, input, select, textarea, [role="button"], [role="link"], [contenteditable="true"]';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    details: {
      /** Persist UI Expand default-open (`open` on the node). Native expand ignores this. */
      setDetailsOpen: (options: { pos: number; open: boolean }) => ReturnType;
    };
    confluenceSection: {
      insertColumns: (options?: { cols?: number }) => ReturnType;
      addSectionColumnBefore: () => ReturnType;
      addSectionColumnAfter: () => ReturnType;
      removeSectionColumn: () => ReturnType;
      toggleSectionBorder: () => ReturnType;
      deleteSection: () => ReturnType;
    };
    confluenceLayout: {
      insertLayout: (options?: { layoutType?: string }) => ReturnType;
      changeLayoutType: (options: { layoutType: string }) => ReturnType;
      deleteLayout: () => ReturnType;
    };
    drawioDiagram: {
      insertDrawioDiagram: () => ReturnType;
    };
  }
}

/** Confluence page layout presets — matches ac:layout-section ac:type values. */
export const LAYOUT_PRESETS = [
  { type: 'two_equal', label: 'Two equal', cols: 2, bars: [1, 1] },
  { type: 'two_left_sidebar', label: 'Left sidebar', cols: 2, bars: [1, 2] },
  { type: 'two_right_sidebar', label: 'Right sidebar', cols: 2, bars: [2, 1] },
  { type: 'three_equal', label: 'Three equal', cols: 3, bars: [1, 1, 1] },
  { type: 'three_with_sidebars', label: 'Side panels', cols: 3, bars: [1, 2, 1] },
] as const;

function applyExpandIdentity(el: HTMLElement, attrs: { macroName?: unknown; macroParams?: unknown }) {
  if (typeof attrs.macroName === 'string' && attrs.macroName) {
    el.setAttribute('data-macro-name', attrs.macroName);
  } else {
    el.removeAttribute('data-macro-name');
  }
  if (typeof attrs.macroParams === 'string' && attrs.macroParams) {
    el.setAttribute('data-macro-params', attrs.macroParams);
  } else {
    el.removeAttribute('data-macro-params');
  }
  el.classList.add('cq-expand');
}

/**
 * Details node — renders <details> for collapsible sections.
 * Handles Confluence expand macros converted to <details>/<summary>.
 *
 * Stored `open` is UI Expand's default-open bit (#1129). Native expand must
 * never write it. The NodeView keeps DOM `open` as a session preview: summary
 * clicks toggle the element without a document transaction, and a stored-open
 * change (block menu) is the only thing that resyncs the DOM from attrs.
 * Edit mode used to force every section open, which hid the reader state and
 * made a title click persist `expanded` on Refined.
 */
export const Details = Node.create({
  name: 'details',
  group: 'block',
  content: 'detailsSummary block*',
  defining: true,

  addAttributes() {
    return {
      open: {
        default: false,
        parseHTML: (element) => element.hasAttribute('open'),
        renderHTML: (attributes) => (attributes.open ? { open: '' } : {}),
      },
      // #1211: identity of the Confluence macro this <details> was converted
      // from, stamped by the backend forward pass. ProseMirror serializes only
      // declared attributes — without these declarations an editor save strips
      // the stamp and the backend reverse pass rewrites every section into a
      // native expand macro, silently deleting a third-party macro from the
      // Confluence page (#1129). Mirrors UnknownMacro's shape and naming so a
      // macro graduating from the fallback keeps the same attribute names.
      macroName: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-macro-name'),
        renderHTML: (attributes) =>
          attributes.macroName ? { 'data-macro-name': attributes.macroName } : {},
      },
      macroParams: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-macro-params'),
        renderHTML: (attributes) =>
          attributes.macroParams ? { 'data-macro-params': attributes.macroParams } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: 'details' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['details', mergeAttributes(HTMLAttributes), 0];
  },

  addCommands() {
    return {
      setDetailsOpen:
        ({ pos, open }) =>
        ({ tr, state, dispatch }) => {
          const node = state.doc.nodeAt(pos);
          if (node?.type.name !== 'details') return false;
          if (node.attrs.macroName !== 'ui-expand') return false;
          if (dispatch) tr.setNodeMarkup(pos, undefined, { ...node.attrs, open });
          return true;
        },
    };
  },

  addNodeView() {
    return ({ node }) => {
      const el = document.createElement('details');
      applyExpandIdentity(el, node.attrs);
      el.open = !!node.attrs.open;
      let storedOpen = !!node.attrs.open;

      return {
        dom: el,
        contentDOM: el,
        update(updatedNode) {
          if (updatedNode.type.name !== 'details') return false;
          applyExpandIdentity(el, updatedNode.attrs);
          const nextStored = !!updatedNode.attrs.open;
          if (nextStored !== storedOpen) {
            el.open = nextStored;
            storedOpen = nextStored;
          }
          return true;
        },
        ignoreMutation: (mutation) =>
          mutation.type === 'attributes' && mutation.attributeName === 'open',
      };
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('detailsToggle'),
        props: {
          // Toggle on `click`, not `handleClickOn`. ProseMirror fires
          // handleClickOn from mouseup; the UA then runs the summary's
          // default on click and toggles again — first click is a no-op,
          // second is a double-click that skips handleClickOn and only
          // the native open lands.
          handleDOMEvents: {
            click(view, event) {
              const target = event.target;
              if (!(target instanceof HTMLElement)) return false;
              const summary = target.closest('summary');
              const details = summary?.parentElement;
              if (!summary || details?.tagName !== 'DETAILS' || !view.dom.contains(details)) {
                return false;
              }
              const interactiveDescendant = target.closest(SUMMARY_INTERACTIVE_DESCENDANT);
              if (interactiveDescendant && summary.contains(interactiveDescendant)) {
                return false;
              }
              details.toggleAttribute('open', !details.hasAttribute('open'));
              event.preventDefault();
              return true;
            },
          },
        },
      }),
    ];
  },
});

/**
 * Label an untitled expand section shows in place of its own title (#1227).
 *
 * These are Confluence's, not ours: an untitled section renders with the
 * macro's own default label on the page, so mirroring it is what makes our
 * read view match. Nothing is ever stored for it — the label is a decoration,
 * so a section that arrived with no `title` parameter still writes back with
 * none, which is the whole point of the issue.
 *
 * Both strings were measured, not recalled:
 * - `expand` — `expand-macro.default-title` in the bundled
 *   `confluence-expand-macro-19.2.44` plugin of a Confluence DC 9.2.14
 *   container (the key `ExpandMacro` resolves when the parameter is absent).
 *   Note the ellipsis; the mobile renderer says "Tap here to expand..." and is
 *   deliberately not modelled here.
 * - `ui-expand` — Refined's public DC demo (`confluence-dc-demo.refined.com`),
 *   rendered through `/rest/api/contentbody/convert/view`. It has NO ellipsis;
 *   the near-collision with the native string is real, not a typo.
 */
const EXPAND_PLACEHOLDER_LABELS: Record<string, string> = {
  expand: 'Click here to expand...',
  'ui-expand': 'Click here to expand',
};

/**
 * Shown for a <details> carrying no identity stamp (pre-#1211 body_html, and
 * editor-created sections) or an unrecognised one. Generic on purpose: guessing
 * a third-party macro's label would be the same fabrication in the UI that this
 * issue removed from the storage format.
 */
const DEFAULT_EXPAND_PLACEHOLDER = 'Click to expand';

function expandPlaceholderLabel(macroName: unknown): string {
  return (typeof macroName === 'string' && EXPAND_PLACEHOLDER_LABELS[macroName]) ||
    DEFAULT_EXPAND_PLACEHOLDER;
}

/**
 * DetailsSummary node — renders <summary> inside <details>.
 */
export const DetailsSummary = Node.create({
  name: 'detailsSummary',
  content: 'inline*',
  defining: true,

  parseHTML() {
    return [{ tag: 'summary' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['summary', mergeAttributes(HTMLAttributes), 0];
  },

  /**
   * #1227: stamp `data-expand-placeholder` on an empty summary so CSS can show
   * the macro's default label. A decoration rather than a stored attribute —
   * nothing about this may reach `body_html`, or it becomes the fabricated
   * title all over again.
   *
   * Not CSS `:empty`: ProseMirror renders an empty textblock as
   * `<summary><br class="ProseMirror-trailingBreak"></summary>` in editable AND
   * non-editable mode, so the selector never matches in either. A decoration
   * also computes under jsdom, which a CSS-only form does not, so it is
   * testable.
   *
   * Registered on the node, so `Editor` and `ArticleViewer` both get it from
   * `article-extensions.ts` — one change covers edit mode and read view.
   */
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('detailsSummaryPlaceholder'),
        props: {
          decorations(state) {
            const decorations: Decoration[] = [];
            state.doc.descendants((node, pos, parent) => {
              if (node.type.name !== 'detailsSummary') return undefined;
              // Strictly empty, not trimmed-empty: a summary holding only
              // spaces looks blank but has the user's own text in it, and
              // prefixing a label onto it would read as their own typing.
              // (htmlToConfluence trims, so such a section still writes back
              // untitled — the label is the only thing that differs.)
              if (node.content.size > 0) return false;
              const label = expandPlaceholderLabel(parent?.attrs.macroName);
              decorations.push(
                Decoration.node(pos, pos + node.nodeSize, {
                  'data-expand-placeholder': label,
                  'aria-label': label,
                }),
              );
              return false;
            });
            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
    ];
  },
});

/**
 * A pass-through `data-*` attribute definition used by the Confluence macro
 * placeholder nodes. `default: null` (widened to string|null so a `label`
 * attr with a `''` default can sit in the same object) plus a `parseHTML`
 * that reads `data-<name>`.
 */
type MacroParamAttr = {
  default: string | null;
  parseHTML: (element: HTMLElement) => string | null;
};

/**
 * Build pass-through `data-*` attribute definitions for a placeholder macro
 * node. Each name maps to a `data-<name>` attribute that round-trips unchanged
 * so the backend's htmlToConfluence pass can rebuild the original
 * ac:structured-macro. Dropping these wrappers permanently deletes the macro
 * from the Confluence page on the next editor save (#765 / #857).
 */
function dataParamAttributes(names: readonly string[]): Record<string, MacroParamAttr> {
  const attrs: Record<string, MacroParamAttr> = {};
  for (const name of names) {
    attrs[name] = {
      default: null,
      parseHTML: (element) => element.getAttribute(`data-${name}`),
    };
  }
  return attrs;
}

/** Serialize the pass-through `data-*` attributes back onto the element. */
function renderDataParams(
  attrs: Record<string, unknown>,
  names: readonly string[],
  base: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = { ...base };
  for (const name of names) {
    const value = attrs[name];
    if (value != null) out[`data-${name}`] = String(value);
  }
  return out;
}

/**
 * Panel node — renders Confluence info/warning/note/tip panels.
 */
export const Panel = Node.create({
  name: 'panel',
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      panelType: {
        default: 'info',
        parseHTML: (element) => {
          if (element.classList.contains('panel-warning')) return 'warning';
          if (element.classList.contains('panel-note')) return 'note';
          if (element.classList.contains('panel-tip')) return 'tip';
          return 'info';
        },
        // The `panel-*` class written by renderHTML below is the type's only
        // serialized form: parseHTML above reads it back off classList, and
        // the backend converter keys on it to rebuild the macro. Letting
        // TipTap render the attribute as well would write a second copy of
        // the type into every saved page that nothing ever reads.
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [
      { tag: 'div.panel-info' },
      { tag: 'div.panel-warning' },
      { tag: 'div.panel-note' },
      { tag: 'div.panel-tip' },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { class: `panel-${node.attrs.panelType}` }), 0];
  },
});

/**
 * DrawioDiagram node — renders draw.io diagrams inline in the TipTap editor.
 *
 * In edit mode, uses ReactNodeViewRenderer to show an interactive preview
 * with edit/delete overlay. Double-click opens the full-screen DrawioEditor.
 *
 * Atom node (no editable content). Draggable in edit mode.
 */
export const DrawioDiagram = Node.create({
  name: 'drawioDiagram',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      diagramName: { default: null },
      /** Raw draw.io XML — stored so the diagram can be re-edited. */
      xml: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-drawio-xml'),
        renderHTML: (attributes: Record<string, string | null>) =>
          attributes.xml ? { 'data-drawio-xml': attributes.xml } : {},
      },
      /** PNG data URI from local edits (takes priority over src). */
      pngDataUri: {
        default: null,
        // Not persisted in HTML — the src attribute is used for serialization.
        // pngDataUri is set transiently by the editor and written into src on save.
        parseHTML: () => null,
        renderHTML: () => ({}),
      },
      src: { default: null },
      alt: { default: 'Diagram' },
      editHref: { default: '#' },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'div.confluence-drawio',
        getAttrs(dom) {
          const el = dom as HTMLElement;
          const img = el.querySelector('img');
          const link = el.querySelector('a.drawio-edit-link');
          return {
            diagramName: el.getAttribute('data-diagram-name'),
            xml: el.getAttribute('data-drawio-xml'),
            src: img?.getAttribute('src') || null,
            alt: img?.getAttribute('alt') || 'Diagram',
            editHref: link?.getAttribute('href') || '#',
          };
        },
      },
    ];
  },

  renderHTML({ node }) {
    // Use pngDataUri (local edit) if available, otherwise fall back to src (server URL)
    const imageSrc = node.attrs.pngDataUri || node.attrs.src;
    const children: unknown[] = [];
    if (imageSrc) {
      children.push(['img', { src: imageSrc, alt: node.attrs.alt }]);
    }
    if (node.attrs.editHref && node.attrs.editHref !== '#') {
      children.push([
        'a',
        { class: 'drawio-edit-link', href: node.attrs.editHref, target: '_blank', rel: 'noreferrer' },
        'Edit in Confluence',
      ]);
    }
    const divAttrs: Record<string, string | null> = {
      class: 'confluence-drawio',
      'data-diagram-name': node.attrs.diagramName,
    };
    if (node.attrs.xml) {
      divAttrs['data-drawio-xml'] = node.attrs.xml;
    }
    return ['div', divAttrs, ...children];
  },

  addNodeView() {
    return ReactNodeViewRenderer(DrawioDiagramNodeView);
  },

  addCommands() {
    return {
      insertDrawioDiagram:
        () =>
        ({ commands }) => {
          return commands.insertContent({
            type: this.name,
            attrs: {
              diagramName: null,
              xml: null,
              pngDataUri: null,
              src: null,
              alt: 'Diagram',
              editHref: '#',
            },
          });
        },
    };
  },
});

/**
 * Confluence TOC macro parameters (lowercased data-* suffixes). Must match the
 * names the backend converter emits/consumes (content-converter.ts).
 */
const TOC_PARAMS = ['maxlevel', 'minlevel', 'outline', 'style', 'type', 'printable', 'absoluteurl'] as const;

/**
 * ConfluenceToc node — placeholder for Confluence TOC macros. Round-trips the
 * macro's parameters as data-* attributes so htmlToConfluence can rebuild the
 * ac:structured-macro[name=toc] losslessly (#857).
 */
export const ConfluenceToc = Node.create({
  name: 'confluenceToc',
  group: 'block',
  atom: true,

  addAttributes() {
    return dataParamAttributes(TOC_PARAMS);
  },

  parseHTML() {
    return [{ tag: 'div.confluence-toc' }];
  },

  renderHTML({ node }) {
    return [
      'div',
      renderDataParams(node.attrs, TOC_PARAMS, { class: 'confluence-toc' }),
      'Table of Contents is displayed in the sidebar',
    ];
  },
});

/**
 * ConfluenceStatus node — renders Confluence status macros as colored inline badges.
 * Inline atom node (non-editable).
 */
export const ConfluenceStatus = Node.create({
  name: 'confluenceStatus',
  group: 'inline',
  inline: true,
  atom: true,

  addAttributes() {
    return {
      color: {
        default: 'grey',
        parseHTML: (element) => element.getAttribute('data-color') ?? 'grey',
      },
      label: {
        default: '',
        parseHTML: (element) => element.textContent ?? '',
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span.confluence-status' }];
  },

  renderHTML({ node }) {
    return [
      'span',
      {
        class: 'confluence-status',
        'data-color': node.attrs.color,
      },
      node.attrs.label,
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(StatusBadgeView);
  },
});

/**
 * ConfluenceChildren node — placeholder for Confluence children display macros.
 * Block-level atom node (non-editable).
 */
export const ConfluenceChildren = Node.create({
  name: 'confluenceChildren',
  group: 'block',
  atom: true,

  addAttributes() {
    const paramNames = ['sort', 'reverse', 'depth', 'first', 'page', 'style', 'excerptType', 'columns', 'macro-name'];
    const attrs: Record<string, { default: null; parseHTML: (el: HTMLElement) => string | null }> = {};
    for (const name of paramNames) {
      attrs[name] = {
        default: null,
        parseHTML: (element) => element.getAttribute(`data-${name}`),
      };
    }
    return attrs;
  },

  parseHTML() {
    return [{ tag: 'div.confluence-children-macro' }];
  },

  renderHTML({ node }) {
    const htmlAttrs: Record<string, string> = { class: 'confluence-children-macro' };
    const paramNames = ['sort', 'reverse', 'depth', 'first', 'page', 'style', 'excerptType', 'columns', 'macro-name'];
    for (const name of paramNames) {
      if (node.attrs[name] != null) htmlAttrs[`data-${name}`] = node.attrs[name];
    }
    return ['div', htmlAttrs, '[Children pages listed here]'];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ChildrenMacroView);
  },
});

/**
 * ConfluenceAttachments node — placeholder for Confluence attachments macro.
 * Block-level atom node (non-editable). Renders as a placeholder that the
 * AttachmentsMacroView NodeView component can hydrate with real attachment data.
 */
export const ConfluenceAttachments = Node.create({
  name: 'confluenceAttachments',
  group: 'block',
  atom: true,

  addAttributes() {
    return {
      upload: {
        default: 'false',
        parseHTML: (element: HTMLElement) => element.getAttribute('data-upload') ?? 'false',
      },
      old: {
        default: 'false',
        parseHTML: (element: HTMLElement) => element.getAttribute('data-old') ?? 'false',
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div.confluence-attachments-macro' }];
  },

  renderHTML({ node }) {
    return [
      'div',
      {
        class: 'confluence-attachments-macro',
        'data-upload': node.attrs.upload,
        'data-old': node.attrs.old,
      },
      '[Attachments]',
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(AttachmentsMacroView);
  },
});

// Macro-placeholder parameter sets (lowercased data-* suffixes). Each must
// match exactly what the backend converter emits/consumes so the reverse pass
// rebuilds the original ac:structured-macro / ri:user element (#857).
const JIRA_PARAMS = ['key', 'server-id', 'server', 'columns', 'display'] as const;
const MENTION_PARAMS = ['username', 'userkey'] as const;
const INCLUDE_PARAMS = ['macro-name', 'page-title', 'space-key'] as const;
const LABELS_PARAMS = ['max', 'spaces', 'excludedlabels', 'showlabels'] as const;

/** Shared `label` attribute — captures the placeholder's visible text. */
const labelAttribute: MacroParamAttr = {
  default: '',
  parseHTML: (element) => element.textContent ?? '',
};

/**
 * ConfluenceJiraIssue node — inline placeholder for Confluence JIRA-issue
 * macros. Preserves the issue key + server/columns/display params so
 * htmlToConfluence can rebuild ac:structured-macro[name=jira] (#857).
 * Inline atom (non-editable), mirroring ConfluenceStatus.
 */
export const ConfluenceJiraIssue = Node.create({
  name: 'confluenceJiraIssue',
  group: 'inline',
  inline: true,
  atom: true,

  addAttributes() {
    return { ...dataParamAttributes(JIRA_PARAMS), label: labelAttribute };
  },

  parseHTML() {
    return [{ tag: 'span.confluence-jira-issue' }];
  },

  renderHTML({ node }) {
    return [
      'span',
      renderDataParams(node.attrs, JIRA_PARAMS, { class: 'confluence-jira-issue' }),
      node.attrs.label,
    ];
  },
});

/**
 * ConfluenceUserMention node — inline placeholder for user mentions.
 * Preserves data-username/data-userkey so htmlToConfluence can rebuild the
 * ri:user element wrapped in ac:link (#857). Inline atom (non-editable).
 */
export const ConfluenceUserMention = Node.create({
  name: 'confluenceUserMention',
  group: 'inline',
  inline: true,
  atom: true,

  addAttributes() {
    return { ...dataParamAttributes(MENTION_PARAMS), label: labelAttribute };
  },

  parseHTML() {
    return [{ tag: 'span.confluence-user-mention' }];
  },

  renderHTML({ node }) {
    return [
      'span',
      renderDataParams(node.attrs, MENTION_PARAMS, { class: 'confluence-user-mention' }),
      node.attrs.label,
    ];
  },
});

/**
 * ConfluenceIncludeMacro node — block placeholder for include / excerpt-include
 * macros. Preserves the referenced page title + space key so htmlToConfluence
 * can rebuild the ac:structured-macro with its ri:page reference (#857).
 * Block-level atom (non-editable).
 */
export const ConfluenceIncludeMacro = Node.create({
  name: 'confluenceIncludeMacro',
  group: 'block',
  atom: true,

  addAttributes() {
    return { ...dataParamAttributes(INCLUDE_PARAMS), label: labelAttribute };
  },

  parseHTML() {
    return [{ tag: 'div.confluence-include-macro' }];
  },

  renderHTML({ node }) {
    return [
      'div',
      renderDataParams(node.attrs, INCLUDE_PARAMS, { class: 'confluence-include-macro' }),
      node.attrs.label,
    ];
  },
});

/**
 * ConfluenceLabelsMacro node — block placeholder for the labels macro.
 * Preserves its params so htmlToConfluence can rebuild
 * ac:structured-macro[name=labels] (#765 / #857). Block-level atom.
 */
export const ConfluenceLabelsMacro = Node.create({
  name: 'confluenceLabelsMacro',
  group: 'block',
  atom: true,

  addAttributes() {
    return { ...dataParamAttributes(LABELS_PARAMS), label: labelAttribute };
  },

  parseHTML() {
    return [{ tag: 'div.confluence-labels-macro' }];
  },

  renderHTML({ node }) {
    return [
      'div',
      renderDataParams(node.attrs, LABELS_PARAMS, { class: 'confluence-labels-macro' }),
      node.attrs.label,
    ];
  },
});

/**
 * ConfluenceLayout node — page layout wrapper.
 * Maps to Confluence's ac:layout element.
 * Contains one or more ConfluenceLayoutSection children.
 */
export const ConfluenceLayout = Node.create({
  name: 'confluenceLayout',
  group: 'block',
  content: 'confluenceLayoutSection+',
  defining: true,

  addAttributes() {
    return {
      layoutType: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-layout-type'),
        renderHTML: (attributes) =>
          attributes.layoutType ? { 'data-layout-type': attributes.layoutType } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div.confluence-layout' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { class: 'confluence-layout' }), 0];
  },

  addCommands() {
    return {
      insertLayout:
        (options) =>
        ({ commands }) => {
          const layoutType = options?.layoutType ?? 'two_equal';
          const cellCount = layoutType.startsWith('three') ? 3 : layoutType === 'single' ? 1 : 2;
          const cells = Array.from({ length: cellCount }, () => ({
            type: 'confluenceLayoutCell',
            content: [{ type: 'paragraph' }],
          }));
          return commands.insertContent({
            type: this.name,
            content: [{
              type: 'confluenceLayoutSection',
              attrs: { 'data-layout-type': layoutType },
              content: cells,
            }],
          });
        },

      changeLayoutType:
        (options) =>
        ({ state, dispatch }) => {
          if (!options?.layoutType) return false;
          const layoutType = options.layoutType;
          const { $from } = state.selection;

          let sectionDepth = -1;
          for (let d = $from.depth; d > 0; d--) {
            if ($from.node(d).type.name === 'confluenceLayoutSection') {
              sectionDepth = d;
              break;
            }
          }
          if (sectionDepth === -1) return false;

          const sectionNode = $from.node(sectionDepth);
          const sectionPos = $from.before(sectionDepth);
          const targetCells = layoutType.startsWith('three') ? 3 : layoutType === 'single' ? 1 : 2;
          const currentCells = sectionNode.childCount;
          const schema = state.schema;

          // Collect existing cell contents
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const existingContent: any[][] = [];
          for (let i = 0; i < currentCells; i++) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const blocks: any[] = [];
            sectionNode.child(i).forEach((block) => blocks.push(block.copy(block.content)));
            existingContent.push(blocks);
          }

          // Build target cells — last cell absorbs excess cells' content
          const newCells = [];
          for (let i = 0; i < targetCells; i++) {
            const existing = existingContent[i];
            const blocks = existing ? [...existing] : [schema.nodes.paragraph!.create()];
            if (i === targetCells - 1 && currentCells > targetCells) {
              for (let j = i + 1; j < currentCells; j++) {
                const extra = existingContent[j];
                if (extra) blocks.push(...extra);
              }
            }
            newCells.push(schema.nodes.confluenceLayoutCell!.create(null, blocks));
          }

          const newSection = schema.nodes.confluenceLayoutSection!.create(
            { 'data-layout-type': layoutType },
            newCells,
          );

          if (dispatch) {
            dispatch(state.tr.replaceWith(sectionPos, sectionPos + sectionNode.nodeSize, newSection));
          }
          return true;
        },

      deleteLayout:
        () =>
        ({ state, dispatch }) => {
          const { $from } = state.selection;
          let layoutDepth = -1;
          for (let d = $from.depth; d > 0; d--) {
            if ($from.node(d).type.name === 'confluenceLayout') {
              layoutDepth = d;
              break;
            }
          }
          if (layoutDepth === -1) return false;

          if (dispatch) {
            dispatch(state.tr.delete($from.before(layoutDepth), $from.after(layoutDepth)));
          }
          return true;
        },
    };
  },
});

/**
 * ConfluenceLayoutSection node — preserves Confluence layout section divs.
 * Renders <div class="confluence-layout-section" data-layout-type="..."> elements.
 * The data-layout-type attribute drives CSS grid column rules.
 */
export const ConfluenceLayoutSection = Node.create({
  name: 'confluenceLayoutSection',
  group: 'block',
  content: 'confluenceLayoutCell+',
  defining: true,

  addAttributes() {
    return {
      'data-layout-type': {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-layout-type'),
        renderHTML: (attributes: Record<string, string>) => {
          if (!attributes['data-layout-type']) return {};
          return { 'data-layout-type': attributes['data-layout-type'] };
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div.confluence-layout-section' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { class: 'confluence-layout-section' }), 0];
  },
});

/**
 * ConfluenceLayoutCell node — preserves Confluence layout cell divs.
 * Renders <div class="confluence-layout-cell" data-cell-width="..."> elements.
 */
export const ConfluenceLayoutCell = Node.create({
  name: 'confluenceLayoutCell',
  group: 'block',
  content: 'block+',
  defining: true,
  isolating: true,

  addAttributes() {
    return {
      cellWidth: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-cell-width'),
        renderHTML: (attributes) =>
          attributes.cellWidth ? { 'data-cell-width': attributes.cellWidth } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div.confluence-layout-cell' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { class: 'confluence-layout-cell' }), 0];
  },
});

/**
 * ConfluenceSection node — multi-column section container.
 * Maps to Confluence's ac:structured-macro[name=section].
 * Contains one or more ConfluenceColumn children.
 */
export const ConfluenceSection = Node.create({
  name: 'confluenceSection',
  group: 'block',
  content: 'confluenceColumn+',
  defining: true,

  addAttributes() {
    return {
      border: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-border'),
        renderHTML: (attributes) =>
          attributes.border ? { 'data-border': attributes.border } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div.confluence-section' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { class: 'confluence-section' }), 0];
  },

  addCommands() {
    return {
      insertColumns:
        (options) =>
        ({ commands }) => {
          const cols = options?.cols ?? 2;
          const columns = Array.from({ length: cols }, () => ({
            type: 'confluenceColumn',
            content: [{ type: 'paragraph' }],
          }));
          return commands.insertContent({
            type: this.name,
            content: columns,
          });
        },

      addSectionColumnBefore:
        () =>
        ({ state, dispatch }) => {
          const { $from } = state.selection;
          let columnDepth = -1;
          for (let d = $from.depth; d > 0; d--) {
            if ($from.node(d).type.name === 'confluenceColumn') {
              columnDepth = d;
              break;
            }
          }
          if (columnDepth === -1) return false;

          const insertPos = $from.before(columnDepth);
          const newColumn = state.schema.nodes.confluenceColumn!.create(null, [
            state.schema.nodes.paragraph!.create(),
          ]);
          if (dispatch) dispatch(state.tr.insert(insertPos, newColumn));
          return true;
        },

      addSectionColumnAfter:
        () =>
        ({ state, dispatch }) => {
          const { $from } = state.selection;
          let columnDepth = -1;
          for (let d = $from.depth; d > 0; d--) {
            if ($from.node(d).type.name === 'confluenceColumn') {
              columnDepth = d;
              break;
            }
          }
          if (columnDepth === -1) return false;

          const insertPos = $from.after(columnDepth);
          const newColumn = state.schema.nodes.confluenceColumn!.create(null, [
            state.schema.nodes.paragraph!.create(),
          ]);
          if (dispatch) dispatch(state.tr.insert(insertPos, newColumn));
          return true;
        },

      removeSectionColumn:
        () =>
        ({ state, dispatch }) => {
          const { $from } = state.selection;
          let columnDepth = -1;
          let sectionDepth = -1;
          for (let d = $from.depth; d > 0; d--) {
            const node = $from.node(d);
            if (node.type.name === 'confluenceColumn' && columnDepth === -1) columnDepth = d;
            if (node.type.name === 'confluenceSection' && sectionDepth === -1) sectionDepth = d;
          }
          if (columnDepth === -1 || sectionDepth === -1) return false;

          // If last column, delete entire section
          if ($from.node(sectionDepth).childCount <= 1) {
            if (dispatch) {
              dispatch(state.tr.delete($from.before(sectionDepth), $from.after(sectionDepth)));
            }
            return true;
          }
          if (dispatch) {
            dispatch(state.tr.delete($from.before(columnDepth), $from.after(columnDepth)));
          }
          return true;
        },

      toggleSectionBorder:
        () =>
        ({ state, dispatch }) => {
          const { $from } = state.selection;
          let sectionDepth = -1;
          for (let d = $from.depth; d > 0; d--) {
            if ($from.node(d).type.name === 'confluenceSection') {
              sectionDepth = d;
              break;
            }
          }
          if (sectionDepth === -1) return false;

          const sectionNode = $from.node(sectionDepth);
          const pos = $from.before(sectionDepth);
          const newBorder = sectionNode.attrs.border === 'true' ? null : 'true';
          if (dispatch) {
            dispatch(state.tr.setNodeMarkup(pos, undefined, { ...sectionNode.attrs, border: newBorder }));
          }
          return true;
        },

      deleteSection:
        () =>
        ({ state, dispatch }) => {
          const { $from } = state.selection;
          let sectionDepth = -1;
          for (let d = $from.depth; d > 0; d--) {
            if ($from.node(d).type.name === 'confluenceSection') {
              sectionDepth = d;
              break;
            }
          }
          if (sectionDepth === -1) return false;

          if (dispatch) {
            dispatch(state.tr.delete($from.before(sectionDepth), $from.after(sectionDepth)));
          }
          return true;
        },
    };
  },
});

/**
 * ConfluenceColumn node — individual column within a ConfluenceSection.
 * Maps to Confluence's ac:structured-macro[name=column].
 * No group — can only appear inside ConfluenceSection.
 */
export const ConfluenceColumn = Node.create({
  name: 'confluenceColumn',
  content: 'block+',
  defining: true,
  isolating: true,

  addAttributes() {
    return {
      cellWidth: {
        default: null,
        parseHTML: (element) => {
          const dataWidth = element.getAttribute('data-cell-width');
          if (dataWidth) return dataWidth;
          // Fall back to extracting from inline style (backend sets flex: 0 0 <width>)
          const style = element.getAttribute('style') ?? '';
          const m = style.match(/flex:\s*0\s+0\s+(\S+)/);
          return m ? m[1] : null;
        },
        renderHTML: (attributes) => {
          const result: Record<string, string> = {};
          if (attributes.cellWidth) {
            result['data-cell-width'] = attributes.cellWidth;
            const safeWidth = /^\d+(%|px|em|rem)$/.test(attributes.cellWidth) ? attributes.cellWidth : undefined;
            if (safeWidth) {
              result.style = `flex: 0 0 ${safeWidth}`;
            }
          }
          return result;
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div.confluence-column' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { class: 'confluence-column' }), 0];
  },
});

/** Helper: check if the editor cursor is inside a ConfluenceSection (old-style section/column macros). */
/** Helper: check if the editor cursor is inside a ConfluenceSection (column system).
 *  Uses $pos.node() walk because isolating cells prevent isActive() from detecting parents. */
export function isInConfluenceSection(editor: Editor): boolean {
  if (editor.isActive('confluenceSection') || editor.isActive('confluenceColumn')) {
    return true;
  }
  try {
    const { $from } = editor.state.selection;
    for (let d = $from.depth; d >= 0; d--) {
      const node = $from.node(d);
      if (node.type.name === 'confluenceSection' || node.type.name === 'confluenceColumn') {
        return true;
      }
    }
  } catch { /* selection not in doc */ }
  return false;
}

/** Helper: check if the editor cursor is inside a ConfluenceLayout (page layout system).
 *  Uses $pos.node() walk because isolating cells prevent isActive() from detecting parents. */
export function isInConfluenceLayout(editor: Editor): boolean {
  if (editor.isActive('confluenceLayout') || editor.isActive('confluenceLayoutSection') || editor.isActive('confluenceLayoutCell')) {
    return true;
  }
  // Fallback: walk up the node tree from cursor position
  try {
    const { $from } = editor.state.selection;
    for (let d = $from.depth; d >= 0; d--) {
      const node = $from.node(d);
      if (node.type.name === 'confluenceLayout' || node.type.name === 'confluenceLayoutSection' || node.type.name === 'confluenceLayoutCell') {
        return true;
      }
    }
  } catch { /* selection not in doc */ }
  return false;
}

/**
 * UnknownMacro node — catch-all for unsupported Confluence macros. Preserves
 * the macro name (`data-macro-name`), its serialized parameters
 * (`data-macro-params`, written by the #865 backend forward pass) and inner
 * rich-text body so the macro survives an editor save round-trip instead of
 * being flattened to plain text or losing its parameters (#857).
 */
export const UnknownMacro = Node.create({
  name: 'unknownMacro',
  group: 'block',
  content: 'block*',

  addAttributes() {
    return {
      macroName: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-macro-name'),
        renderHTML: (attributes) =>
          attributes.macroName ? { 'data-macro-name': attributes.macroName } : {},
      },
      macroParams: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-macro-params'),
        renderHTML: (attributes) =>
          attributes.macroParams ? { 'data-macro-params': attributes.macroParams } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div.confluence-macro-unknown' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { class: 'confluence-macro-unknown' }), 0];
  },
});

/**
 * Figure node — wraps an image + editable caption.
 * Renders as <figure class="figure-block">.
 * The content schema uses `image` which matches the TipTap Image extension node name.
 */
export const Figure = Node.create({
  name: 'figure',
  group: 'block',
  content: 'image figcaption',
  draggable: true,

  parseHTML() {
    return [{ tag: 'figure' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['figure', mergeAttributes(HTMLAttributes, { class: 'figure-block' }), 0];
  },
});

/**
 * Figcaption node — editable caption text inside a Figure.
 * Renders as <figcaption> with styling classes.
 */
export const Figcaption = Node.create({
  name: 'figcaption',
  content: 'inline*',

  parseHTML() {
    return [{ tag: 'figcaption' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'figcaption',
      mergeAttributes(HTMLAttributes, {
        class: 'text-sm text-muted-foreground text-center mt-1 italic',
      }),
      0,
    ];
  },
});

/**
 * TableCaption node — caption for tables.
 * Renders as <div class="table-caption">.
 * Parses from both <caption> (standard HTML) and <div class="table-caption">.
 */
export const TableCaption = Node.create({
  name: 'tableCaption',
  group: 'block',
  content: 'inline*',

  addAttributes() {
    return {
      align: {
        default: 'left',
        parseHTML: (element) => element.getAttribute('data-align') || element.style.textAlign || 'left',
        renderHTML: (attributes) => {
          if (!attributes.align || attributes.align === 'left') {
            return { 'data-align': 'left' };
          }
          return {
            'data-align': attributes.align,
            style: `text-align: ${attributes.align}`,
          };
        },
      },
    };
  },

  parseHTML() {
    return [
      { tag: 'caption' },
      { tag: 'div.table-caption' },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        class: 'table-caption text-sm text-muted-foreground text-left mt-1.5 mb-2 italic',
      }),
      0,
    ];
  },
});

/**
 * FigureIndex node — auto-generated list of figures in the document.
 * Atom node rendered via React NodeView that scans for figure nodes.
 */
export const FigureIndex = Node.create({
  name: 'figureIndex',
  group: 'block',
  atom: true,

  parseHTML() {
    return [{ tag: 'div.figure-index' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { class: 'figure-index' })];
  },

  addNodeView() {
    return ReactNodeViewRenderer(FigureIndexView);
  },
});

/**
 * TableIndex node — auto-generated list of tables in the document.
 * Atom node rendered via React NodeView that scans for tableCaption nodes.
 */
export const TableIndex = Node.create({
  name: 'tableIndex',
  group: 'block',
  atom: true,

  parseHTML() {
    return [{ tag: 'div.table-index' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { class: 'table-index' })];
  },

  addNodeView() {
    return ReactNodeViewRenderer(TableIndexView);
  },
});

/**
 * ExtendedTable — TipTap Table extension with `data-layout` attribute support.
 * Supports `data-layout="default"` (prose width) and `data-layout="full-width"` (expand to page width).
 */
export const ExtendedTable = Table.extend({
  addOptions() {
    // parent is always defined on Table.extend; optional-call spread would
    // make required TableOptions fields (HTMLAttributes) optional and fail tsc.
    return {
      ...this.parent!(),
      View: CompendiqTableView,
    };
  },

  addAttributes() {
    return {
      ...this.parent?.(),
      'data-layout': {
        default: 'default',
        parseHTML: (element) => element.getAttribute('data-layout') || 'default',
        renderHTML: (attributes) => {
          if (!attributes['data-layout'] || attributes['data-layout'] === 'default') {
            return {};
          }
          return { 'data-layout': attributes['data-layout'] };
        },
      },
    };
  },

  addProseMirrorPlugins() {
    return [
      ...(this.parent?.() || []),
      createTableSelectionPerimeterPlugin(),
    ];
  },
});

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    blockShortcuts: {
      duplicateBlock: () => ReturnType;
    };
  }
}

const NON_DUPLICABLE_CONTAINERS = new Set([
  'confluenceColumn',
  'confluenceLayoutCell',
  'confluenceLayoutSection',
  'tableRow',
  'tableCell',
  'tableHeader',
]);

/**
 * BlockShortcutsExtension — Global keyboard shortcuts and commands for block-level operations.
 * - Mod-d (Cmd+D / Ctrl+D): Duplicate the active block containing the selection (supports nested blocks).
 */
export const BlockShortcutsExtension = Extension.create({
  name: 'blockShortcuts',

  addCommands() {
    return {
      duplicateBlock:
        () =>
        ({ tr, state, dispatch }) => {
          const { selection } = state;
          const $from = selection.$from;
          if ($from.depth < 1 && state.doc.childCount === 0) return false;

          let targetDepth = $from.depth >= 1 ? 1 : 0;
          for (let d = $from.depth; d >= 1; d--) {
            const n = $from.node(d);
            if (n.isBlock && !NON_DUPLICABLE_CONTAINERS.has(n.type.name)) {
              targetDepth = d;
              break;
            }
          }

          const node = targetDepth === 0 ? state.doc.firstChild : $from.node(targetDepth);
          if (!node) return false;

          const insertPos = targetDepth === 0 ? (state.doc.firstChild?.nodeSize ?? 0) : $from.after(targetDepth);
          const label = blockLabel(node);

          if (dispatch) {
            tr.insert(insertPos, node);
            toast.success(`${label} duplicated`, {
              action: {
                label: 'Undo',
                onClick: () => {
                  if (!this.editor.isDestroyed) this.editor.commands.undo();
                },
              },
            });
          }
          return true;
        },
    };
  },

  addKeyboardShortcuts() {
    return {
      'Mod-d': () => this.editor.commands.duplicateBlock(),
    };
  },
});

export type PanelType = 'info' | 'warning' | 'note' | 'tip';

/**
 * Inserts `node` and leaves the caret inside its first child, so the author
 * types straight into the new box instead of underneath it.
 */
export function insertBlockWithCaret(editor: Editor, typeName: string, node: Record<string, unknown>) {
  editor
    .chain()
    .focus()
    .insertContent(node)
    .command(({ tr, dispatch }) => {
      if (!dispatch) return true;
      const { from } = tr.selection;
      let caret: number | null = null;
      tr.doc.descendants((child, pos) => {
        if (child.type.name === typeName && pos <= from) {
          caret = pos + 2;
        }
        return true;
      });
      if (caret !== null) {
        tr.setSelection(TextSelection.create(tr.doc, caret));
      }
      return true;
    })
    .run();
}

/**
 * Inserts an empty panel and leaves the caret inside it, so the author types
 * straight into the box instead of clearing out placeholder copy first.
 */
export function insertPanel(editor: Editor, panelType: PanelType) {
  insertBlockWithCaret(editor, 'panel', {
    type: 'panel',
    attrs: { panelType },
    content: [{ type: 'paragraph' }],
  });
}

/**
 * Inserts the shared Expand module (empty title and body, caret in the title).
 * Authoring always creates native `expand`. Synced `ui-expand` still loads as
 * the same module and keeps its Confluence identity on save (#1211).
 */
export function insertExpandSection(editor: Editor, macroName: 'expand' | 'ui-expand' = 'expand') {
  insertBlockWithCaret(editor, 'details', {
    type: 'details',
    attrs: { macroName },
    content: [
      { type: 'detailsSummary' },
      { type: 'paragraph' },
    ],
  });
}

/** Wrap the image at the caret in a `figure` so it can carry a caption. */
export function captionSelectedImage(editor: Editor) {
  const { from } = editor.state.selection;
  const node = editor.state.doc.nodeAt(from);
  if (node?.type.name !== 'image') return;
  editor
    .chain()
    .deleteRange({ from, to: from + node.nodeSize })
    .insertContentAt(from, {
      type: 'figure',
      content: [{ type: 'image', attrs: node.attrs }, { type: 'figcaption' }],
    })
    .run();
}


