import { useState, useCallback, useEffect, useRef } from 'react';
import { ShieldCheck, Loader2, X } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { streamSSE } from '../../shared/lib/sse';
import { apiFetch } from '../../shared/lib/api';
import { cn } from '../../shared/lib/cn';
import { useIsLightTheme } from '../../shared/hooks/use-is-light-theme';
import { toast } from 'sonner';

interface QualityAnalysisPanelProps {
  pageId: string;
  bodyHtml: string;
  pageTitle: string;
  /** When provided, the component is "controlled" — the parent owns the open state. */
  open?: boolean;
  /** Called when the user wants to toggle the panel open/closed. */
  onToggle?: () => void;
  /** When true, render only the trigger button (used for header placement). */
  renderTriggerOnly?: boolean;
  /** When true, render only the expanded panel (used for content-area placement). */
  renderPanelOnly?: boolean;
}

export function QualityAnalysisPanel({
  pageId, bodyHtml, pageTitle,
  open: controlledOpen, onToggle, renderTriggerOnly, renderPanelOnly,
}: QualityAnalysisPanelProps) {
  const isLight = useIsLightTheme();
  const [internalOpen, setInternalOpen] = useState(false);

  // Support both controlled and uncontrolled modes
  const open = controlledOpen !== undefined ? controlledOpen : internalOpen;
  const toggleOpen = onToggle ?? (() => setInternalOpen((prev) => !prev));
  const [result, setResult] = useState('');
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
        if (m.length > 0 && !model) setModel(m[0]?.name ?? '');
      })
      .catch(() => {
        toast.error('Failed to load models');
      });
  }, [open, models.length, model]);

  const handleAnalyze = useCallback(async () => {
    if (!model || isStreaming || !bodyHtml) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsStreaming(true);
    setResult('');

    let accumulated = '';
    try {
      for await (const chunk of streamSSE<{ content?: string; error?: string; done?: boolean }>('/llm/analyze-quality', {
        content: bodyHtml,
        model,
        pageId,
      }, controller.signal)) {
        if (chunk.error) {
          toast.error(chunk.error);
          break;
        }
        if (chunk.content) {
          accumulated += chunk.content;
          setResult(accumulated);
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      toast.error(err instanceof Error ? err.message : 'Quality analysis failed');
    } finally {
      setIsStreaming(false);
    }
  }, [model, isStreaming, bodyHtml, pageId]);

  const triggerButton = (
    <button
      onClick={toggleOpen}
      className="nm-card flex items-center gap-1.5 px-3 py-1.5 text-sm hover:bg-foreground/5"
      title="Analyze article quality"
    >
      <ShieldCheck size={14} /> <span className="hidden sm:inline">Quality</span>
    </button>
  );

  const panel = (
    <div className="nm-card space-y-3 p-4">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <ShieldCheck size={16} className="text-primary" /> Quality Analysis
        </h3>
        <button
          onClick={toggleOpen}
          className="rounded p-1 text-muted-foreground hover:bg-foreground/5"
        >
          <X size={14} />
        </button>
      </div>

      <p className="text-xs text-muted-foreground">
        Analyzing: {pageTitle}
      </p>

      {/* Model selector + Analyze button */}
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
          onClick={handleAnalyze}
          disabled={isStreaming || !model}
          className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {isStreaming ? (
            <><Loader2 size={14} className="animate-spin" /> Analyzing...</>
          ) : (
            <><ShieldCheck size={14} /> Analyze</>
          )}
        </button>
      </div>

      {/* Results */}
      {result && (
        <div className={cn(
          'rounded-lg border border-border/50 bg-foreground/5 p-4',
          'prose prose-sm max-w-none',
          !isLight && 'prose-invert',
        )}>
          <Markdown remarkPlugins={[remarkGfm]}>{result}</Markdown>
        </div>
      )}

      {/* Streaming indicator without result yet */}
      {isStreaming && !result && (
        <div className="flex items-center gap-2 rounded-lg border border-border/50 bg-foreground/5 p-4 text-xs text-muted-foreground">
          <Loader2 size={12} className="animate-spin" /> Analyzing article quality...
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
