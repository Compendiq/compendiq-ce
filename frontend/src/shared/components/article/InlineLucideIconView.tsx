import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { getPageLucideIcon } from '../page-icon/page-lucide-icons';

export function InlineLucideIconView({ node }: NodeViewProps) {
  const name = String(node.attrs.name ?? 'book');
  const Glyph = getPageLucideIcon(name);
  return (
    <NodeViewWrapper as="span" className="inline-lucide-icon" data-lucide={name} contentEditable={false}>
      {Glyph ? <Glyph size={16} aria-hidden className="inline-block align-text-bottom" /> : name}
    </NodeViewWrapper>
  );
}
