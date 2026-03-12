import { Node, mergeAttributes } from '@tiptap/core';

/**
 * Details node — renders <details> for collapsible sections.
 * Handles Confluence expand macros converted to <details>/<summary>.
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
 * DrawioDiagram node — renders Confluence draw.io diagram embeds.
 * Atom node (no editable content).
 */
export const DrawioDiagram = Node.create({
  name: 'drawioDiagram',
  group: 'block',
  atom: true,

  addAttributes() {
    return {
      diagramName: { default: null },
      drawio: { default: null },
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
            drawio: el.getAttribute('data-drawio'),
            src: img?.getAttribute('src') || null,
            alt: img?.getAttribute('alt') || 'Diagram',
            editHref: link?.getAttribute('href') || '#',
          };
        },
      },
    ];
  },

  renderHTML({ node }) {
    const children: unknown[] = [];
    if (node.attrs.src) {
      children.push(['img', { src: node.attrs.src, alt: node.attrs.alt }]);
    }
    children.push([
      'a',
      { class: 'drawio-edit-link', href: node.attrs.editHref, target: '_blank', rel: 'noreferrer' },
      'Edit in Confluence',
    ]);
    return [
      'div',
      {
        class: 'confluence-drawio',
        'data-diagram-name': node.attrs.diagramName,
        'data-drawio': node.attrs.drawio,
      },
      ...children,
    ];
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
});

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
