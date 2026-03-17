/* eslint-disable react-refresh/only-export-components */
import { useCallback } from 'react';
import { GitBranch, FileInput, Loader2 } from 'lucide-react';
import { useAiContext } from '../AiContext';
import { MermaidDiagram } from '../../../shared/components/diagrams/MermaidDiagram';
import { cn } from '../../../shared/lib/cn';
import { apiFetch } from '../../../shared/lib/api';
import { toast } from 'sonner';

/** HTML-encode a string so it is safe to interpolate inside HTML elements. */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const DIAGRAM_TYPES = ['flowchart', 'sequence', 'state', 'mindmap'] as const;

/**
 * Diagram type selector rendered above the message area.
 */
export function DiagramTypeSelector() {
  const { diagramType, setDiagramType } = useAiContext();
  return (
    <div className="glass-toolbar mb-4 flex items-center gap-2 p-3">
      <span className="text-sm text-muted-foreground">Type:</span>
      {DIAGRAM_TYPES.map((type) => (
        <button
          key={type}
          onClick={() => setDiagramType(type)}
          className={cn(
            'rounded-md px-2.5 py-1 text-xs capitalize',
            diagramType === type ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-foreground/5',
          )}
        >
          {type}
        </button>
      ))}
    </div>
  );
}

/**
 * Rendered after a diagram stream completes: shows the Mermaid preview
 * and an "Use in article" button.
 */
export function DiagramPreview() {
  const { page, pageId, isStreaming, queryClient, diagramCode, isInsertingDiagram, setIsInsertingDiagram } = useAiContext();

  const handleInsertDiagram = useCallback(async () => {
    if (!diagramCode || !page || !pageId || isInsertingDiagram) return;
    setIsInsertingDiagram(true);
    try {
      const diagramHtml = `\n<pre><code class="language-mermaid">${escapeHtml(diagramCode)}</code></pre>\n`;
      const updatedHtml = page.bodyHtml + diagramHtml;
      await apiFetch(`/pages/${pageId}`, {
        method: 'PUT',
        body: JSON.stringify({
          title: page.title,
          bodyHtml: updatedHtml,
          version: page.version,
        }),
      });
      toast.success('Diagram inserted into article');
      queryClient.invalidateQueries({ queryKey: ['pages', pageId] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to insert diagram');
    } finally {
      setIsInsertingDiagram(false);
    }
  }, [diagramCode, page, pageId, isInsertingDiagram, queryClient, setIsInsertingDiagram]);

  if (!diagramCode || isStreaming) return null;

  return (
    <>
      <MermaidDiagram code={diagramCode} className="mt-4" />
      {page && pageId && (
        <button
          onClick={handleInsertDiagram}
          disabled={isInsertingDiagram}
          className="mt-2 flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {isInsertingDiagram ? (
            <><Loader2 size={14} className="animate-spin" /> Inserting...</>
          ) : (
            <><FileInput size={14} /> Use in article</>
          )}
        </button>
      )}
    </>
  );
}

/**
 * Input bar for diagram mode: a single action button.
 */
export function DiagramModeInput() {
  const { isStreaming, page, model, pageId, runStream, diagramType, setDiagramCode } = useAiContext();

  const handleDiagram = useCallback(async () => {
    if (isStreaming) return;
    if (!page) {
      toast.error('No page selected. Open a page first, then use "Diagram" mode.');
      return;
    }
    if (!model) {
      toast.error('No model available. Check your LLM provider settings.');
      return;
    }

    setDiagramCode('');

    await runStream(
      '/llm/generate-diagram',
      { content: page.bodyHtml, model, diagramType, pageId },
      {
        userMessage: `Generate ${diagramType} diagram: ${page.title}`,
        onComplete: (accumulated) => {
          setDiagramCode(accumulated);
        },
      },
    );
  }, [page, model, diagramType, pageId, isStreaming, runStream, setDiagramCode]);

  return (
    <div className="mt-3 flex items-center gap-3 border-t border-border/40 pt-3">
      <button
        onClick={handleDiagram}
        disabled={isStreaming || !page || !model}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
      >
        {isStreaming ? (
          <><Loader2 size={14} className="animate-spin" /> Processing...</>
        ) : !model ? (
          <><Loader2 size={14} className="animate-spin" /> Loading models...</>
        ) : (
          <><GitBranch size={14} /> Generate Diagram</>
        )}
      </button>
    </div>
  );
}

export const DIAGRAM_EMPTY_TITLE = 'Generate a diagram from a page';
export function diagramEmptySubtitle(page: { title: string } | undefined): string {
  return page
    ? `Ready to diagram: ${page.title}`
    : 'Navigate to a page and click "Diagram" to get started';
}
