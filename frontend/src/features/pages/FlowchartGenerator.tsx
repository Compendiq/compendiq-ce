import { useState, useCallback, useEffect, useRef } from 'react';
import { GitBranch, Loader2, X } from 'lucide-react';
import { streamSSE } from '../../shared/lib/sse';
import { MermaidDiagram } from '../../shared/components/MermaidDiagram';
import { apiFetch } from '../../shared/lib/api';
import { cn } from '../../shared/lib/cn';
import { toast } from 'sonner';
import type { DiagramType } from '@kb-creator/contracts';

interface FlowchartGeneratorProps {
  pageId: string;
  bodyHtml: string;
}

const DIAGRAM_TYPES: DiagramType[] = ['flowchart', 'sequence', 'state', 'mindmap'];

export function FlowchartGenerator({ pageId, bodyHtml }: FlowchartGeneratorProps) {
  const [open, setOpen] = useState(false);
  const [diagramType, setDiagramType] = useState<DiagramType>('flowchart');
  const [diagramCode, setDiagramCode] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
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
        if (m.length > 0 && !model) setModel(m[0].name);
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
      for await (const chunk of streamSSE<{ content?: string; done?: boolean }>('/llm/generate-diagram', {
        content: bodyHtml,
        model,
        diagramType,
        pageId,
      }, controller.signal)) {
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

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="glass-card flex items-center gap-1.5 px-3 py-1.5 text-sm hover:bg-foreground/5"
        title="Generate diagram from article"
      >
        <GitBranch size={14} /> Diagram
      </button>
    );
  }

  return (
    <div className="glass-card space-y-3 p-4">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <GitBranch size={16} className="text-primary" /> Generate Diagram
        </h3>
        <button
          onClick={() => setOpen(false)}
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
        <MermaidDiagram code={diagramCode} />
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
}
