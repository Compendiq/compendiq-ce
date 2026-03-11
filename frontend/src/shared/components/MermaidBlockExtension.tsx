import { useState, useCallback, useEffect, useRef } from 'react';
import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer, NodeViewWrapper } from '@tiptap/react';
import { Eye, Code2, AlertTriangle } from 'lucide-react';
import { MermaidDiagram } from './MermaidDiagram';
import { FeatureErrorBoundary } from './FeatureErrorBoundary';
import { cn } from '../lib/cn';
import type { NodeViewProps } from '@tiptap/react';

/**
 * React component rendered inside the TipTap editor for mermaid code blocks.
 * Shows a toggle between source editing and rendered diagram preview.
 */
function MermaidBlockView({ node, updateAttributes, editor }: NodeViewProps) {
  const [showPreview, setShowPreview] = useState(true);
  const code = node.attrs.code || '';
  const isEditable = editor.isEditable;
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea to fit content
  useEffect(() => {
    if (textareaRef.current && !showPreview) {
      const ta = textareaRef.current;
      ta.style.height = 'auto';
      ta.style.height = `${ta.scrollHeight}px`;
    }
  }, [code, showPreview]);

  const handleCodeChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      updateAttributes({ code: e.target.value });
    },
    [updateAttributes],
  );

  const togglePreview = useCallback(() => {
    setShowPreview((prev) => !prev);
  }, []);

  return (
    <NodeViewWrapper className="mermaid-diagram-wrapper" data-testid="mermaid-block">
      <div className="rounded-lg border border-border/50 bg-foreground/5 overflow-hidden">
        {/* Toolbar */}
        <div className="flex items-center justify-between border-b border-border/50 px-3 py-1.5">
          <span className="text-xs text-muted-foreground font-medium">Mermaid Diagram</span>
          <div className="flex items-center gap-1">
            {isEditable && (
              <button
                onClick={togglePreview}
                className={cn(
                  'flex items-center gap-1 rounded px-2 py-0.5 text-xs transition-colors',
                  showPreview
                    ? 'text-muted-foreground hover:bg-foreground/10 hover:text-foreground'
                    : 'bg-primary/15 text-primary',
                )}
                title={showPreview ? 'Edit source code' : 'Show preview'}
                type="button"
              >
                {showPreview ? (
                  <><Code2 size={12} /> Edit</>
                ) : (
                  <><Eye size={12} /> Preview</>
                )}
              </button>
            )}
          </div>
        </div>

        {/* Content area */}
        {showPreview ? (
          code.trim() ? (
            <FeatureErrorBoundary featureName="Mermaid Diagram">
              <MermaidDiagram code={code} />
            </FeatureErrorBoundary>
          ) : (
            <div className="flex items-center justify-center gap-2 p-8 text-muted-foreground">
              <AlertTriangle size={16} />
              <span className="text-sm">Empty diagram. Click Edit to add Mermaid code.</span>
            </div>
          )
        ) : (
          <div className="p-2">
            <textarea
              ref={textareaRef}
              value={code}
              onChange={handleCodeChange}
              className="w-full min-h-[120px] rounded-md bg-black/20 p-3 font-mono text-sm text-foreground outline-none resize-none"
              placeholder="Enter Mermaid diagram code..."
              spellCheck={false}
              data-testid="mermaid-source-editor"
            />
          </div>
        )}
      </div>
    </NodeViewWrapper>
  );
}

/**
 * MermaidBlock TipTap node extension.
 *
 * Parses `<pre><code class="language-mermaid">...</code></pre>` and renders
 * a React NodeView with diagram preview and source editing toggle.
 *
 * On serialization, outputs the same HTML structure so the content converter
 * can round-trip mermaid code through Confluence storage format.
 */
export const MermaidBlock = Node.create({
  name: 'mermaidBlock',
  group: 'block',
  atom: true,
  draggable: true,

  // Higher priority than codeBlock so mermaid blocks are parsed first
  priority: 200,

  addAttributes() {
    return {
      code: {
        default: '',
        parseHTML: (element) => {
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
        // Only match <pre> blocks that contain a <code class="language-mermaid">
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

  addNodeView() {
    return ReactNodeViewRenderer(MermaidBlockView);
  },
});
