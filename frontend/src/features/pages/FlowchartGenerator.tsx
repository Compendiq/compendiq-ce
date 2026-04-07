import { useState, useCallback, useEffect, useRef } from 'react';
import { GitBranch, Loader2, X, FileInput } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { streamSSE } from '../../shared/lib/sse';
import { MermaidDiagram } from '../../shared/components/diagrams/MermaidDiagram';
import { FeatureErrorBoundary } from '../../shared/components/feedback/FeatureErrorBoundary';
import { apiFetch } from '../../shared/lib/api';
import { cn } from '../../shared/lib/cn';
import { toast } from 'sonner';
import type { DiagramType } from '@compendiq/contracts';

/** HTML-encode a string so it is safe to interpolate inside HTML elements. */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface FlowchartGeneratorProps {
  pageId: string;
  bodyHtml: string;
  pageTitle: string;
  pageVersion: number;
  /** When provided, the component is "controlled" — the parent owns the open state. */
  open?: boolean;
  /** Called when the user wants to toggle the panel open/closed. */
  onToggle?: () => void;
  /** When true, render only the trigger button (used for header placement). */
  renderTriggerOnly?: boolean;
  /** When true, render only the expanded panel (used for content-area placement). */
  renderPanelOnly?: boolean;
}

const DIAGRAM_TYPES: DiagramType[] = ['flowchart', 'sequence', 'state', 'mindmap'];

export function FlowchartGenerator({
  pageId, bodyHtml, pageTitle, pageVersion,
  open: controlledOpen, onToggle, renderTriggerOnly, renderPanelOnly,
}: FlowchartGeneratorProps) {
  const queryClient = useQueryClient();
  const [internalOpen, setInternalOpen] = useState(false);

  // Support both controlled and uncontrolled modes
  const open = controlledOpen !== undefined ? controlledOpen : internalOpen;
  const toggleOpen = onToggle ?? (() => setInternalOpen((prev) => !prev));
  const [diagramType, setDiagramType] = useState<DiagramType>('flowchart');
  const [diagramCode, setDiagramCode] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [isInserting, setIsInserting] = useState(false);
  const [model, setModel] = useState('');
  const [models, setModels] = useState<Array<{ name: string }>>([]);

  const abortRef = useRef<AbortController | null>(null);

  // Abort any in-flight stream on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!open || models.length > 0) return;
    apiFetch<Array<{ name: string }>>('/ollama/models')
      .then((m) => {
        setModels(m);
        if (m.length > 0 && !model) setModel(m[0]?.name ?? '');
      })
      .catch(() => {
        toast.error('Failed to load models');
      });
  }, [open, models.length, model]);

  const handleGenerate = useCallback(async () => {
    if (!model || isStreaming || !bodyHtml) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsStreaming(true);
    setDiagramCode('');

    let result = '';
    try {
      for await (const chunk of streamSSE<{ content?: string; error?: string; done?: boolean }>('/llm/generate-diagram', {
        content: bodyHtml,
        model,
        diagramType,
        pageId,
      }, controller.signal)) {
        if (chunk.error) {
          toast.error(chunk.error);
          break;
        }
        if (chunk.content) {
          result += chunk.content;
          setDiagramCode(result);
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      toast.error(err instanceof Error ? err.message : 'Diagram generation failed');
    } finally {
      setIsStreaming(false);
    }
  }, [model, isStreaming, bodyHtml, diagramType, pageId]);

  const handleInsertInArticle = useCallback(async () => {
    if (!diagramCode || isInserting) return;
    setIsInserting(true);
    try {
      const diagramHtml = `\n<pre><code class="language-mermaid">${escapeHtml(diagramCode)}</code></pre>\n`;
      const updatedHtml = bodyHtml + diagramHtml;
      await apiFetch(`/pages/${pageId}`, {
        method: 'PUT',
        body: JSON.stringify({
          title: pageTitle,
          bodyHtml: updatedHtml,
          version: pageVersion,
        }),
      });
      toast.success('Diagram inserted into article');
      queryClient.invalidateQueries({ queryKey: ['pages', pageId] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to insert diagram');
    } finally {
      setIsInserting(false);
    }
  }, [diagramCode, isInserting, bodyHtml, pageId, pageTitle, pageVersion, queryClient]);

  const triggerButton = (
    <button
      onClick={toggleOpen}
      className="glass-card flex items-center gap-1.5 px-3 py-1.5 text-sm hover:bg-foreground/5"
      title="Generate diagram from article"
    >
      <GitBranch size={14} /> <span className="hidden sm:inline">Diagram</span>
    </button>
  );

  const panel = (
    <div className="glass-card space-y-3 p-4">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <GitBranch size={16} className="text-primary" /> Generate Diagram
        </h3>
        <button
          onClick={toggleOpen}
          className="rounded p-1 text-muted-foreground hover:bg-foreground/5"
        >
          <X size={14} />
        </button>
      </div>

      {/* Diagram type selector */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Type:</span>
        {DIAGRAM_TYPES.map((type) => (
          <button
            key={type}
            onClick={() => setDiagramType(type)}
            className={cn(
              'rounded-md px-2.5 py-1 text-xs capitalize',
              diagramType === type
                ? 'bg-primary/15 text-primary'
                : 'text-muted-foreground hover:bg-foreground/5',
            )}
          >
            {type}
          </button>
        ))}
      </div>

      {/* Model selector + Generate button */}
      <div className="flex items-center gap-2">
        <select
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="flex-1 rounded-md bg-foreground/5 px-2 py-1.5 text-sm outline-none"
        >
          {models.map((m) => (
            <option key={m.name} value={m.name}>{m.name}</option>
          ))}
        </select>
        <button
          onClick={handleGenerate}
          disabled={isStreaming || !model}
          className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {isStreaming ? (
            <><Loader2 size={14} className="animate-spin" /> Generating...</>
          ) : (
            <><GitBranch size={14} /> Generate</>
          )}
        </button>
      </div>

      {/* Rendered diagram */}
      {diagramCode && !isStreaming && (
        <>
          <FeatureErrorBoundary featureName="Mermaid Diagram">
            <MermaidDiagram code={diagramCode} />
          </FeatureErrorBoundary>
          <button
            onClick={handleInsertInArticle}
            disabled={isInserting}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {isInserting ? (
              <><Loader2 size={14} className="animate-spin" /> Inserting...</>
            ) : (
              <><FileInput size={14} /> Use in article</>
            )}
          </button>
        </>
      )}

      {/* Streaming indicator */}
      {isStreaming && diagramCode && (
        <div className="rounded-lg border border-border/50 bg-foreground/5 p-4">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 size={12} className="animate-spin" /> Generating diagram...
          </div>
          <pre className="mt-2 max-h-32 overflow-auto text-xs text-muted-foreground">{diagramCode}</pre>
        </div>
      )}
    </div>
  );

  // Render trigger button only (for header placement)
  if (renderTriggerOnly) {
    return triggerButton;
  }

  // Render panel only (for content-area placement)
  if (renderPanelOnly) {
    return open ? panel : null;
  }

  // Default: self-contained toggle (backward compatible)
  return open ? panel : triggerButton;
}
