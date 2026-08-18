import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { InlineLucideIconView } from './InlineLucideIconView';

/** Inline Lucide glyph, same catalogue as the page-icon picker. */
export const InlineLucideIcon = Node.create({
  name: 'inlineLucideIcon',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      name: {
        default: 'book',
        parseHTML: (element) => element.getAttribute('data-lucide') ?? 'book',
        renderHTML: (attributes) => ({ 'data-lucide': attributes.name as string }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-lucide]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { class: 'inline-lucide-icon' })];
  },

  addNodeView() {
    return ReactNodeViewRenderer(InlineLucideIconView);
  },
});
