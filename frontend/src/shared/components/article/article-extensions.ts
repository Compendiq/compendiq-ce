import { Node, mergeAttributes, type Editor } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { DrawioDiagramNodeView } from './DrawioDiagramNodeView';
import { StatusBadgeView } from './StatusBadgeView';
import { AttachmentsMacroView } from './AttachmentsMacroView';
import { ChildrenMacroView } from './ChildrenMacroView';
import { FigureIndexView } from './FigureIndexView';
import { TableIndexView } from './TableIndexView';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
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

/**
 * Details node — renders <details> for collapsible sections.
 * Handles Confluence expand macros converted to <details>/<summary>.
 *
 * Two fixes for TipTap editor:
 * 1. In edit mode, force `open` attribute so the content area is always
 *    visible and the cursor can be placed inside.
 * 2. Add a click handler on <summary> to toggle the `open` node attribute
 *    via ProseMirror transaction (native toggle is swallowed by PM).
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
    };
  },

  parseHTML() {
    return [{ tag: 'details' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['details', mergeAttributes(HTMLAttributes), 0];
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        key: new PluginKey('detailsToggle'),
        props: {
          handleClickOn(view, pos, node, nodePos, event) {
            // Check if the click target is a <summary> element
            const target = event.target as HTMLElement;
            if (target.tagName !== 'SUMMARY' && !target.closest('summary')) {
              return false;
            }
            // Find the parent details node in the document
            const resolved = view.state.doc.resolve(pos);
            for (let d = resolved.depth; d >= 0; d--) {
              const ancestor = resolved.node(d);
              if (ancestor.type.name === 'details') {
                const ancestorPos = resolved.before(d);
                // Toggle the open attribute
                const tr = view.state.tr.setNodeAttribute(ancestorPos, 'open', !ancestor.attrs.open);
                view.dispatch(tr);
                // Prevent the native toggle
                event.preventDefault();
                return true;
              }
            }
            return false;
          },
          // In edit mode, force all <details> elements to be open in the DOM
          // so users can always access the content area
          handleDOMEvents: {
            focus(view) {
              if (!view.editable) return false;
              const detailsEls = view.dom.querySelectorAll('details');
              detailsEls.forEach((el) => el.setAttribute('open', ''));
              return false;
            },
          },
        },
        view(editorView) {
          // On init: force open in edit mode
          function forceOpen() {
            if (!editorView.editable) return;
            const detailsEls = editorView.dom.querySelectorAll('details');
            detailsEls.forEach((el) => el.setAttribute('open', ''));
          }
          // Run after initial render
          requestAnimationFrame(forceOpen);
          return {
            update() {
              requestAnimationFrame(forceOpen);
            },
          };
        },
      }),
    ];
  },
});

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
});

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
 * ConfluenceToc node — placeholder for Confluence TOC macros.
 */
export const ConfluenceToc = Node.create({
  name: 'confluenceToc',
  group: 'block',
  atom: true,

  parseHTML() {
    return [{ tag: 'div.confluence-toc' }];
  },

  renderHTML() {
    return ['div', { class: 'confluence-toc' }, 'Table of Contents is displayed in the sidebar'];
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
    const paramNames = ['sort', 'reverse', 'depth', 'first', 'page', 'style', 'excerptType', 'macro-name'];
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
    const paramNames = ['sort', 'reverse', 'depth', 'first', 'page', 'style', 'excerptType', 'macro-name'];
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
            const blocks = existingContent[i] ? [...existingContent[i]] : [schema.nodes.paragraph.create()];
            if (i === targetCells - 1 && currentCells > targetCells) {
              for (let j = i + 1; j < currentCells; j++) {
                if (existingContent[j]) blocks.push(...existingContent[j]);
              }
            }
            newCells.push(schema.nodes.confluenceLayoutCell.create(null, blocks));
          }

          const newSection = schema.nodes.confluenceLayoutSection.create(
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
          const newColumn = state.schema.nodes.confluenceColumn.create(null, [
            state.schema.nodes.paragraph.create(),
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
          const newColumn = state.schema.nodes.confluenceColumn.create(null, [
            state.schema.nodes.paragraph.create(),
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
 * UnknownMacro node — catch-all for unsupported Confluence macros.
 */
export const UnknownMacro = Node.create({
  name: 'unknownMacro',
  group: 'block',
  content: 'block*',

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
        class: 'table-caption text-sm text-muted-foreground text-center mt-1 italic',
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
