/* eslint-disable react-refresh/only-export-components */
import { useCallback } from 'react';
import { Send, FileInput } from 'lucide-react';
import { useAiContext } from '../AiContext';
import { AssistantActionSelect } from '../AssistantActionSelect';
import { AI_HOME_ACTIONS } from '../assistant-actions';
import { MermaidDiagram } from '../../../shared/components/diagrams/MermaidDiagram';
import { cn } from '../../../shared/lib/cn';
import { apiFetch } from '../../../shared/lib/api';
import { Button } from '../../../shared/components/Button';
import { toast } from 'sonner';
import { useAutoGrowTextarea } from '../../../shared/hooks/use-auto-grow-textarea';
import { useArticleViewStore } from '../../../stores/article-view-store';
import { AssistantAttachmentsScope, useAssistantAttachments } from '../AssistantAttachments';

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

const DIAGRAM_DESCRIPTIONS: Record<(typeof DIAGRAM_TYPES)[number], string> = {
  flowchart: 'Boxes-and-arrows process or system overview',
  sequence: 'Time-ordered interaction between actors or services',
  state: 'Lifecycle with states and the events that transition between them',
  mindmap: 'Hierarchical brainstorm radiating from a single root concept',
};

/**
 * Diagram type selector rendered under the assistant context toolbar.
 * Visual grammar matches the AI sub-header: a single `rounded-xl border` card
 * with h-7 outlined chips so all of the AI surfaces feel like one toolbar
 * stack rather than three different controls.
 */
export function DiagramTypeSelector() {
  const { diagramType, setDiagramType } = useAiContext();
  const activeType = DIAGRAM_TYPES.includes(diagramType as (typeof DIAGRAM_TYPES)[number])
    ? (diagramType as (typeof DIAGRAM_TYPES)[number])
    : 'flowchart';
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-border bg-card px-3 py-2">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground/80">
        Diagram type
      </span>
      <div className="flex flex-wrap items-center gap-1.5">
        {DIAGRAM_TYPES.map((type) => (
          <button
            key={type}
            onClick={() => setDiagramType(type)}
            title={DIAGRAM_DESCRIPTIONS[type]}
            aria-pressed={diagramType === type}
            className={cn(
              'flex h-7 items-center rounded-md border px-2.5 text-xs capitalize transition-colors',
              diagramType === type
                ? 'border-primary/45 bg-primary/15 text-primary-ink font-medium'
                : 'border-border text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
            )}
          >
            {type}
          </button>
        ))}
      </div>
      <p className="basis-full text-xs text-muted-foreground/80">
        {DIAGRAM_DESCRIPTIONS[activeType]}
      </p>
    </div>
  );
}

/**
 * Rendered after a diagram stream completes: shows the Mermaid preview
 * and an "Use in page" button.
 */
export function DiagramPreview() {
  const { page, pageId, isStreaming, queryClient, diagramCode, isInsertingDiagram, setIsInsertingDiagram } = useAiContext();
  const editing = useArticleViewStore((s) => s.editing);

  const handleInsertDiagram = useCallback(async () => {
    if (!diagramCode || !page || !pageId || isInsertingDiagram || editing) return;
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
      toast.success('Diagram inserted into page');
      queryClient.invalidateQueries({ queryKey: ['pages', pageId] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to insert diagram');
    } finally {
      setIsInsertingDiagram(false);
    }
  }, [diagramCode, page, pageId, isInsertingDiagram, editing, queryClient, setIsInsertingDiagram]);

  if (!diagramCode || isStreaming) return null;

  return (
    <>
      <MermaidDiagram code={diagramCode} className="mt-4" />
      {page && pageId && (
        <div className="mt-2 space-y-1.5">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={handleInsertDiagram}
            disabled={isInsertingDiagram || editing}
            isLoading={isInsertingDiagram}
            leftIcon={<FileInput size={14} />}
            data-testid="diagram-insert-btn"
          >
            Use in page
          </Button>
          {editing && (
            <p className="text-xs text-muted-foreground" data-testid="diagram-editing-notice">
              Save or cancel editing to insert this diagram into the page.
            </p>
          )}
        </div>
      )}
    </>
  );
}

/**
 * Input bar for diagram mode: a single action button.
 */
export function DiagramModeInput() {
  return (
    <AssistantAttachmentsScope>
      <DiagramModeInputContent />
    </AssistantAttachmentsScope>
  );
}

function DiagramModeInputContent() {
  const {
    input, setInput, isStreaming, page, model, pageId, thinkingMode,
    runStream, diagramType, setDiagramCode,
  } = useAiContext();
  const attachments = useAssistantAttachments();
  const inputRef = useAutoGrowTextarea(input);

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
    const instruction = input.trim();

    await runStream(
      '/llm/generate-diagram',
      {
        content: page.bodyHtml,
        model,
        diagramType,
        pageId: pageId ?? undefined,
        ...(instruction && { instruction }),
        ...(thinkingMode && { thinking: true }),
      },
      {
        userMessage: instruction || `Generate ${diagramType} diagram: ${page.title}`,
        onComplete: (accumulated) => {
          setDiagramCode(accumulated);
        },
      },
    );
  }, [input, page, model, diagramType, pageId, thinkingMode, isStreaming, runStream, setDiagramCode]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    void handleDiagram();
  };

  return (
    <div className="mt-3 border-t border-border pt-3">
      {(attachments.documents.length > 0 || attachments.image) && (
        <p className="mb-2 text-xs text-muted-foreground" data-testid="ai-attachments-paused">
          Attachments are kept here but are not sent to Diagram.
        </p>
      )}
      <div className="nm-composer">
        <AssistantActionSelect actions={AI_HOME_ACTIONS} disabled={isStreaming} className="self-end" />
        <textarea
          ref={inputRef}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Diagram instructions (optional)"
          maxLength={10000}
          rows={1}
          disabled={isStreaming}
          className="min-w-0 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground/70 disabled:opacity-50"
          data-testid="diagram-instruction"
        />
        <Button
          type="button"
          variant="primary"
          size="sm"
          onClick={() => void handleDiagram()}
          disabled={isStreaming || !page || !model}
          isLoading={isStreaming}
          aria-label={isStreaming ? 'Processing diagram' : 'Generate Diagram'}
          className="shrink-0 self-end h-8 px-2.5"
          leftIcon={<Send size={14} />}
          data-testid="diagram-send"
        >
          <span className="sr-only">Generate Diagram</span>
        </Button>
      </div>
    </div>
  );
}

export const DIAGRAM_EMPTY_TITLE = 'Generate a diagram from a page';
export function diagramEmptySubtitle(page: { title: string } | undefined): string {
  return page
    ? `Ready to diagram: ${page.title}`
    : 'Navigate to a page and click "Diagram" to get started';
}
