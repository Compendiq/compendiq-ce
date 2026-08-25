/**
 * Named collab TipTap schema (#1445 / Decision K).
 *
 * Schema-only: no React node views, no editor-only extensions, no pngDataUri.
 * Consumed by init/snapshot and the parity ratchet.
 */
/// <reference lib="dom" />
import {
  Node,
  Mark,
  mergeAttributes,
  getSchema,
  type AnyExtension,
  type JSONContent,
} from '@tiptap/core';
import type { Schema } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';
import { Image } from '@tiptap/extension-image';
import { Table, TableRow, TableCell, TableHeader } from '@tiptap/extension-table';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import { CodeBlock } from '@tiptap/extension-code-block';
import { Highlight } from '@tiptap/extension-highlight';
import TextAlign from '@tiptap/extension-text-align';
import { TextStyle } from '@tiptap/extension-text-style';
import { Color } from '@tiptap/extension-color';
import { generateHTML, generateJSON } from '@tiptap/html';
import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON } from '@tiptap/y-tiptap';
import * as Y from 'yjs';

const COLLAB_FIELD = 'default';

type MacroParamAttr = {
  default: string | null;
  parseHTML: (element: HTMLElement) => string | null;
};

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

const labelAttribute: MacroParamAttr = {
  default: '',
  parseHTML: (element) => element.textContent ?? '',
};

const Details = Node.create({
  name: 'details',
  group: 'block',
  content: 'detailsSummary block*',
  defining: true,
  addAttributes() {
    return {
      open: {
        default: false,
        parseHTML: (element: HTMLElement) => element.hasAttribute('open'),
        renderHTML: (attributes: { open?: boolean }) => (attributes.open ? { open: '' } : {}),
      },
      macroName: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-macro-name'),
        renderHTML: (attributes: { macroName?: string | null }) =>
          attributes.macroName ? { 'data-macro-name': attributes.macroName } : {},
      },
      macroParams: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-macro-params'),
        renderHTML: (attributes: { macroParams?: string | null }) =>
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
});

const DetailsSummary = Node.create({
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

const Panel = Node.create({
  name: 'panel',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes() {
    return {
      panelType: {
        default: 'info',
        parseHTML: (element: HTMLElement) => {
          if (element.classList.contains('panel-warning')) return 'warning';
          if (element.classList.contains('panel-note')) return 'note';
          if (element.classList.contains('panel-tip')) return 'tip';
          return 'info';
        },
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

const DrawioDiagram = Node.create({
  name: 'drawioDiagram',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      diagramName: { default: null },
      xml: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-drawio-xml'),
        renderHTML: (attributes: Record<string, string | null>) =>
          attributes.xml ? { 'data-drawio-xml': attributes.xml } : {},
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
    const imageSrc = node.attrs.src as string | null;
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
      'data-diagram-name': node.attrs.diagramName as string | null,
    };
    if (node.attrs.xml) divAttrs['data-drawio-xml'] = node.attrs.xml as string;
    return ['div', divAttrs, ...children];
  },
});

const TOC_PARAMS = ['maxlevel', 'minlevel', 'outline', 'style', 'type', 'printable', 'absoluteurl'] as const;

const ConfluenceToc = Node.create({
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

const ConfluenceStatus = Node.create({
  name: 'confluenceStatus',
  group: 'inline',
  inline: true,
  atom: true,
  addAttributes() {
    return {
      color: {
        default: 'grey',
        parseHTML: (element: HTMLElement) => element.getAttribute('data-color') ?? 'grey',
      },
      label: {
        default: '',
        parseHTML: (element: HTMLElement) => element.textContent ?? '',
      },
    };
  },
  parseHTML() {
    return [{ tag: 'span.confluence-status' }];
  },
  renderHTML({ node }) {
    return [
      'span',
      { class: 'confluence-status', 'data-color': node.attrs.color },
      node.attrs.label,
    ];
  },
});

const ConfluenceChildren = Node.create({
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
      if (node.attrs[name] != null) htmlAttrs[`data-${name}`] = node.attrs[name] as string;
    }
    return ['div', htmlAttrs, '[Children pages listed here]'];
  },
});

const ConfluenceAttachments = Node.create({
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
});

const JIRA_PARAMS = ['key', 'server-id', 'server', 'columns', 'display'] as const;
const MENTION_PARAMS = ['username', 'userkey'] as const;
const INCLUDE_PARAMS = ['macro-name', 'page-title', 'space-key'] as const;
const LABELS_PARAMS = ['max', 'spaces', 'excludedlabels', 'showlabels'] as const;

const ConfluenceJiraIssue = Node.create({
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

const ConfluenceUserMention = Node.create({
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

const ConfluenceIncludeMacro = Node.create({
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

const ConfluenceLabelsMacro = Node.create({
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

const ConfluenceLayout = Node.create({
  name: 'confluenceLayout',
  group: 'block',
  content: 'confluenceLayoutSection+',
  defining: true,
  addAttributes() {
    return {
      layoutType: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-layout-type'),
        renderHTML: (attributes: { layoutType?: string | null }) =>
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
});

const ConfluenceLayoutSection = Node.create({
  name: 'confluenceLayoutSection',
  group: 'block',
  content: 'confluenceLayoutCell+',
  defining: true,
  addAttributes() {
    return {
      'data-layout-type': {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-layout-type'),
        renderHTML: (attributes: Record<string, string | null>) => {
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

const ConfluenceLayoutCell = Node.create({
  name: 'confluenceLayoutCell',
  group: 'block',
  content: 'block+',
  defining: true,
  isolating: true,
  addAttributes() {
    return {
      cellWidth: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-cell-width'),
        renderHTML: (attributes: { cellWidth?: string | null }) =>
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

const ConfluenceSection = Node.create({
  name: 'confluenceSection',
  group: 'block',
  content: 'confluenceColumn+',
  defining: true,
  addAttributes() {
    return {
      border: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-border'),
        renderHTML: (attributes: { border?: string | null }) =>
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
});

const ConfluenceColumn = Node.create({
  name: 'confluenceColumn',
  content: 'block+',
  defining: true,
  isolating: true,
  addAttributes() {
    return {
      cellWidth: {
        default: null,
        parseHTML: (element: HTMLElement) => {
          const dataWidth = element.getAttribute('data-cell-width');
          if (dataWidth) return dataWidth;
          const style = element.getAttribute('style') ?? '';
          const m = style.match(/flex:\s*0\s+0\s+(\S+)/);
          return m ? m[1] : null;
        },
        renderHTML: (attributes: { cellWidth?: string | null }) => {
          const result: Record<string, string> = {};
          if (attributes.cellWidth) {
            result['data-cell-width'] = attributes.cellWidth;
            const safeWidth = /^\d+(%|px|em|rem)$/.test(attributes.cellWidth) ? attributes.cellWidth : undefined;
            if (safeWidth) result.style = `flex: 0 0 ${safeWidth}`;
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

const UnknownMacro = Node.create({
  name: 'unknownMacro',
  group: 'block',
  content: 'block*',
  addAttributes() {
    return {
      macroName: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-macro-name'),
        renderHTML: (attributes: { macroName?: string | null }) =>
          attributes.macroName ? { 'data-macro-name': attributes.macroName } : {},
      },
      macroParams: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-macro-params'),
        renderHTML: (attributes: { macroParams?: string | null }) =>
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

const Figure = Node.create({
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

const Figcaption = Node.create({
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

const TableCaption = Node.create({
  name: 'tableCaption',
  group: 'block',
  content: 'inline*',
  addAttributes() {
    return {
      align: {
        default: 'left',
        parseHTML: (element: HTMLElement) =>
          element.getAttribute('data-align') || element.style.textAlign || 'left',
        renderHTML: (attributes: { align?: string }) => {
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
    return [{ tag: 'caption' }, { tag: 'div.table-caption' }];
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

const FigureIndex = Node.create({
  name: 'figureIndex',
  group: 'block',
  atom: true,
  parseHTML() {
    return [{ tag: 'div.figure-index' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { class: 'figure-index' })];
  },
});

const TableIndex = Node.create({
  name: 'tableIndex',
  group: 'block',
  atom: true,
  parseHTML() {
    return [{ tag: 'div.table-index' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { class: 'table-index' })];
  },
});

const ExtendedTable = Table.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      'data-layout': {
        default: 'default',
        parseHTML: (element: HTMLElement) => element.getAttribute('data-layout') || 'default',
        renderHTML: (attributes: Record<string, string>) => {
          if (!attributes['data-layout'] || attributes['data-layout'] === 'default') return {};
          return { 'data-layout': attributes['data-layout'] };
        },
      },
    };
  },
});

const ConfluenceImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      'data-confluence-image-source': {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-confluence-image-source'),
        renderHTML: (attributes: Record<string, string | null>) =>
          attributes['data-confluence-image-source']
            ? { 'data-confluence-image-source': attributes['data-confluence-image-source'] }
            : {},
      },
      'data-confluence-filename': {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-confluence-filename'),
        renderHTML: (attributes: Record<string, string | null>) =>
          attributes['data-confluence-filename']
            ? { 'data-confluence-filename': attributes['data-confluence-filename'] }
            : {},
      },
      'data-confluence-owner-page-title': {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-confluence-owner-page-title'),
        renderHTML: (attributes: Record<string, string | null>) =>
          attributes['data-confluence-owner-page-title']
            ? { 'data-confluence-owner-page-title': attributes['data-confluence-owner-page-title'] }
            : {},
      },
      'data-confluence-owner-space-key': {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-confluence-owner-space-key'),
        renderHTML: (attributes: Record<string, string | null>) =>
          attributes['data-confluence-owner-space-key']
            ? { 'data-confluence-owner-space-key': attributes['data-confluence-owner-space-key'] }
            : {},
      },
      'data-confluence-url': {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-confluence-url'),
        renderHTML: (attributes: Record<string, string | null>) =>
          attributes['data-confluence-url']
            ? { 'data-confluence-url': attributes['data-confluence-url'] }
            : {},
      },
      'data-import-failed': {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-import-failed'),
        renderHTML: (attributes: Record<string, string | null>) =>
          attributes['data-import-failed']
            ? { 'data-import-failed': attributes['data-import-failed'] }
            : {},
      },
    };
  },
});

const TitledCodeBlock = CodeBlock.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      title: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-title'),
        renderHTML: (attributes: { title?: string | null }) =>
          attributes.title ? { 'data-title': attributes.title } : {},
      },
    };
  },
  parseHTML() {
    return [
      {
        tag: 'pre',
        preserveWhitespace: 'full' as const,
        getAttrs: (node) => {
          const el = node as HTMLElement;
          return {
            language: el.querySelector('code')?.className.match(/language-(\w+)/)?.[1] ?? null,
            title: el.getAttribute('data-title'),
          };
        },
      },
    ];
  },
});

const InlineLucideIcon = Node.create({
  name: 'inlineLucideIcon',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      name: {
        default: 'book',
        parseHTML: (element: HTMLElement) => element.getAttribute('data-lucide') ?? 'book',
        renderHTML: (attributes: { name?: string }) => ({ 'data-lucide': attributes.name as string }),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'span[data-lucide]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { class: 'inline-lucide-icon' })];
  },
});

const MermaidBlock = Node.create({
  name: 'mermaidBlock',
  group: 'block',
  atom: true,
  draggable: true,
  priority: 200,
  addAttributes() {
    return {
      code: {
        default: '',
        parseHTML: (element: HTMLElement) => {
          const codeEl = element.querySelector('code');
          return codeEl?.textContent ?? '';
        },
      },
    };
  },
  parseHTML() {
    return [
      {
        tag: 'pre',
        getAttrs(node) {
          const el = node as HTMLElement;
          const codeEl = el.querySelector('code.language-mermaid');
          if (!codeEl) return false;
          return { code: codeEl.textContent ?? '' };
        },
      },
    ];
  },
  renderHTML({ node }) {
    return [
      'pre',
      mergeAttributes({}),
      ['code', { class: 'language-mermaid' }, node.attrs.code],
    ];
  },
});

const CommentMark = Mark.create({
  name: 'comment',
  priority: 1000,
  inclusive: false,
  excludes: '',
  addAttributes() {
    return {
      commentId: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-comment-id'),
        renderHTML: (attributes: Record<string, unknown>) => {
          if (!attributes.commentId) return {};
          return { 'data-comment-id': String(attributes.commentId) };
        },
      },
      resolved: {
        default: false,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-comment-resolved') === 'true',
        renderHTML: (attributes: Record<string, unknown>) => {
          if (!attributes.resolved) return {};
          return { 'data-comment-resolved': 'true' };
        },
      },
    };
  },
  parseHTML() {
    return [
      { tag: 'mark[data-comment-id]', priority: 1000 },
      { tag: 'span[data-comment-id]', priority: 1000 },
    ];
  },
  renderHTML({ HTMLAttributes }) {
    return ['mark', mergeAttributes(HTMLAttributes, { class: 'comment-mark' }), 0];
  },
});

const SafeHighlight = Highlight.extend({
  parseHTML() {
    return [
      {
        tag: 'mark',
        getAttrs: (node) => {
          if (typeof node !== 'string' && (node as HTMLElement).hasAttribute('data-comment-id')) {
            return false;
          }
          return {};
        },
      },
    ];
  },
});

let cachedExtensions: AnyExtension[] | null = null;
let cachedSchema: Schema | null = null;

export function collabExtensions(): AnyExtension[] {
  if (cachedExtensions) return cachedExtensions;
  cachedExtensions = [
    StarterKit.configure({
      codeBlock: false,
      undoRedo: false,
    }),
    TextAlign.configure({
      types: ['heading', 'paragraph', 'blockquote', 'tableCaption'],
      alignments: ['left', 'center', 'right', 'justify'],
    }),
    TextStyle,
    Color,
    CommentMark,
    SafeHighlight.configure({ multicolor: true }),
    ExtendedTable.configure({ resizable: false }),
    TableRow,
    TableCell,
    TableHeader,
    TaskList,
    TaskItem.configure({ nested: true }),
    MermaidBlock,
    Details,
    DetailsSummary,
    Panel,
    ConfluenceStatus,
    ConfluenceToc,
    ConfluenceJiraIssue,
    ConfluenceUserMention,
    ConfluenceIncludeMacro,
    ConfluenceLabelsMacro,
    UnknownMacro,
    ConfluenceLayout,
    ConfluenceLayoutSection,
    ConfluenceLayoutCell,
    ConfluenceSection,
    ConfluenceColumn,
    ConfluenceAttachments,
    ConfluenceChildren,
    DrawioDiagram,
    Figure,
    Figcaption,
    TableCaption,
    FigureIndex,
    TableIndex,
    TitledCodeBlock,
    InlineLucideIcon,
    ConfluenceImage.configure({ inline: false }),
  ] as AnyExtension[];
  return cachedExtensions;
}

export function getCollabSchema(): Schema {
  if (!cachedSchema) cachedSchema = getSchema(collabExtensions());
  return cachedSchema;
}

export function htmlToYDoc(html: string): Y.Doc {
  const json = generateJSON(html && html.trim().length > 0 ? html : '<p></p>', collabExtensions()) as JSONContent;
  return prosemirrorJSONToYDoc(getCollabSchema(), json, COLLAB_FIELD);
}

export function yDocToHtml(doc: Y.Doc): string {
  const json = yDocToProsemirrorJSON(doc, COLLAB_FIELD) as JSONContent;
  return generateHTML(json, collabExtensions());
}

export function applyHtmlToYDoc(doc: Y.Doc, html: string): void {
  const src = htmlToYDoc(html);
  try {
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(src), 'load');
  } finally {
    src.destroy();
  }
}
