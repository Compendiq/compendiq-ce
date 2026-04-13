import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight';
import { mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { CodeBlockNodeView } from './CodeBlockNodeView';

/**
 * Extended CodeBlockLowlight that preserves the `data-title` attribute
 * from Confluence code macros. The title is stored on the <pre> element
 * and rendered as a styled header above the code block via CSS.
 *
 * Round-trip: Confluence XHTML -> HTML (data-title on <pre>) -> TipTap -> HTML (data-title on <pre>) -> Confluence XHTML
 */
export const TitledCodeBlock = CodeBlockLowlight.extend({
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

  addAttributes() {
    return {
      ...this.parent?.(),
      title: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-title'),
        renderHTML: (attributes) => {
          if (!attributes.title) {
            return {};
          }
          return { 'data-title': attributes.title };
        },
      },
    };
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'pre',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes),
      [
        'code',
        {
          class: node.attrs.language
            ? this.options.languageClassPrefix + node.attrs.language
            : null,
        },
        0,
      ],
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockNodeView);
  },
});
