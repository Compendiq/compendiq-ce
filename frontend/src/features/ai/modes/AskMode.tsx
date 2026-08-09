import { useCallback, useEffect, useState } from 'react';
import { Send, Loader2, Link2, X, Plus } from 'lucide-react';
import { useAiContext, nextMessageId } from '../AiContext';
import { toast } from 'sonner';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../../../shared/lib/api';
import { useAutoGrowTextarea } from '../../../shared/hooks/use-auto-grow-textarea';
import { PROMPT_MAX_LENGTH } from './prompt-limits';
import { buildAskPrompts } from './ask-example-prompts';
import { usePages, usePageFilterOptions } from '../../../shared/hooks/use-pages';
import { useSpaces } from '../../../shared/hooks/use-spaces';

interface McpDocsSettings {
  enabled: boolean;
}

/**
 * Q&A mode: free-text input with RAG-powered streaming responses.
 * Supports attaching external URLs for documentation context via MCP sidecar.
 */
export function AskModeInput() {
  const {
    input, setInput, isStreaming, model, conversationId, pageId,
    includeSubPages, thinkingMode, setMessages, runStream,
  } = useAiContext();

  const [externalUrls, setExternalUrls] = useState<string[]>([]);
  const [urlInput, setUrlInput] = useState('');
  const [showUrlInput, setShowUrlInput] = useState(false);

  // Check if MCP docs is enabled via public status endpoint (cache for 5 min)
  const { data: mcpSettings } = useQuery<McpDocsSettings>({
    queryKey: ['mcp-docs', 'status'],
    queryFn: () => apiFetch('/mcp-docs/status'),
    staleTime: 5 * 60_000,
    retry: false,
  });

  const mcpEnabled = mcpSettings?.enabled ?? false;

  const addUrl = () => {
    const url = urlInput.trim();
    if (!url) return;
    try {
      new URL(url); // Validate
    } catch {
      toast.error('Invalid URL');
      return;
    }
    if (externalUrls.length >= 5) {
      toast.error('Maximum 5 external URLs');
      return;
    }
    if (!externalUrls.includes(url)) {
      setExternalUrls((prev) => [...prev, url]);
    }
    setUrlInput('');
  };

  const removeUrl = (url: string) => {
    setExternalUrls((prev) => prev.filter((u) => u !== url));
  };

  // Doubles as the auto-grow handle and the mount-focus target.
  const inputRef = useAutoGrowTextarea(input);

  // #350: focus input on mount so the user can type immediately. Use a ref +
  // useEffect rather than autoFocus so it survives StrictMode double-mount and
  // route transitions reliably.
  useEffect(() => {
    inputRef.current?.focus();
  }, [inputRef]);

  const handleAsk = useCallback(async () => {
    if (!input.trim() || isStreaming) return;
    if (!model) {
      toast.error('No model available. Check your LLM provider settings.');
      return;
    }

    const question = input.trim();
    setInput('');
    setMessages((prev) => [...prev, { id: nextMessageId(), role: 'user', content: question }]);

    const body: Record<string, unknown> = {
      question,
      model,
      conversationId: conversationId ?? undefined,
      pageId: pageId ?? undefined,
      includeSubPages,
      ...(thinkingMode && { thinking: true }),
    };

    if (externalUrls.length > 0) {
      body.externalUrls = externalUrls;
    }

    await runStream('/llm/ask', body, {
      onComplete: () => {
        // Sources are attached by runStream automatically
      },
    });

    // Clear external URLs after sending
    setExternalUrls([]);
    setShowUrlInput(false);
  }, [input, model, isStreaming, conversationId, pageId, includeSubPages, thinkingMode, externalUrls, setInput, setMessages, runStream]);

  const handleSubmit = () => handleAsk();

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Unchanged contract: Enter submits, Shift+Enter inserts a newline. On a
    // textarea the bare Enter has to be prevented explicitly, otherwise it
    // submits *and* leaves the browser's own newline behind in the field.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="mt-3 border-t border-border pt-3">
      {/* External URLs chips */}
      {externalUrls.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {externalUrls.map((url) => (
            <span
              key={url}
              className="inline-flex items-center gap-1 rounded-full border border-primary/20 bg-primary/5 px-2 py-0.5 text-xs text-primary-ink"
            >
              <Link2 size={10} />
              {new URL(url).hostname}
              <button
                onClick={() => removeUrl(url)}
                aria-label={`Remove ${new URL(url).hostname}`}
                className="hover:text-destructive"
              >
                <X size={10} />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* URL input row */}
      {showUrlInput && mcpEnabled && (
        <div className="nm-composer mb-2">
          <Link2 size={14} className="shrink-0 text-muted-foreground" />
          <input
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addUrl()}
            placeholder="Paste documentation URL..."
            className="flex-1 bg-transparent px-1 py-1 text-xs outline-none placeholder:text-muted-foreground/70"
            data-testid="external-url-input"
          />
          <button
            onClick={addUrl}
            aria-label="Add URL"
            className="shrink-0 rounded-md px-2 py-1 text-xs text-primary-ink hover:bg-primary/10"
          >
            <Plus size={12} />
          </button>
          <button
            onClick={() => { setShowUrlInput(false); setUrlInput(''); }}
            aria-label="Close URL input"
            className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* Main input row */}
      <div className="nm-composer">
        {mcpEnabled && (
          <button
            onClick={() => setShowUrlInput(!showUrlInput)}
            title="Attach external documentation URL"
            className={`shrink-0 self-end rounded-md p-1.5 transition-colors ${
              showUrlInput || externalUrls.length > 0
                ? 'bg-primary/15 text-primary-ink'
                : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground'
            }`}
            data-testid="attach-url-button"
          >
            <Link2 size={16} />
          </button>
        )}
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask a question..."
          maxLength={PROMPT_MAX_LENGTH}
          rows={1}
          disabled={isStreaming}
          // The composer wrapper owns the inset surface, border and focus ring,
          // so the field stays transparent. resize-none because the auto-grow
          // hook owns the height — a drag handle would fight it.
          // min-w-0 so a textarea's intrinsic `cols` width can't push the
          // composer wider than a narrow viewport.
          className="min-w-0 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground/70 disabled:opacity-50"
          data-testid="ask-input"
        />
        <button
          onClick={handleSubmit}
          disabled={isStreaming || !input.trim() || !model}
          aria-label={isStreaming ? 'Sending...' : 'Send message'}
          // self-end keeps Send on the last line of a grown prompt instead of
          // floating it in the middle of the text block.
          className="shrink-0 self-end flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {isStreaming ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
        </button>
      </div>
    </div>
  );
}

export const ASK_EMPTY_TITLE = 'Ask questions about your knowledge base';
// "RAG" is implementation vocabulary; it told the reader how the feature is
// built, not what it will do for them. The rewrite states the behaviour that
// actually distinguishes this from a plain chat box: answers cite pages.
export const ASK_EMPTY_SUBTITLE = 'Answers are drawn from your synced pages, with links to the ones they came from';

export function AskExamplePrompts() {
  const { setInput } = useAiContext();

  // Suggestions are built from this instance's real content. The previous
  // hardcoded list named a tag and a space that do not exist in a fresh
  // install, so the AI surface opened by inventing facts about the user's
  // own knowledge base — the exact failure the AI Safety panel forbids.
  const { data: pageList } = usePages({ sort: 'modified', limit: 5 });
  const { data: filterOptions } = usePageFilterOptions();
  const { data: spaces } = useSpaces();

  const prompts = buildAskPrompts({
    recentPages: (pageList?.items ?? []).map((p) => ({
      title: p.title,
      spaceKey: p.spaceKey,
      labels: p.labels ?? [],
    })),
    labels: filterOptions?.labels ?? [],
    spaceKeys: (spaces ?? []).map((s) => s.key),
  });

  const pick = (prompt: string) => {
    setInput(prompt);
    // Defer focus to next tick so the input mounts before we focus it.
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLTextAreaElement>('[data-testid="ask-input"]');
      el?.focus();
    });
  };

  // Use real <ul>/<li> elements so each <button> keeps its implicit "button"
  // role for assistive tech. Previously we set role="listitem" on the buttons,
  // which stripped the button role and made screen readers announce
  // "listitem" instead of "button".
  return (
    <ul
      aria-label="Example prompts"
      className="mt-8 grid w-full max-w-2xl grid-cols-1 gap-2 sm:grid-cols-2 list-none p-0"
    >
      {prompts.map((prompt) => (
        <li key={prompt}>
          {/* Lighter card than nm-card-interactive — the heavy neumorphic
              extrusion fights the flat composer that sits 80 px below it
              (May-2026 audit). A 1 px border + faint inset surface keeps the
              prompts skim-readable as a row of suggestions, not buttons that
              look more important than the composer. */}
          <button
            type="button"
            onClick={() => pick(prompt)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                pick(prompt);
              }
            }}
            className="group flex w-full items-start gap-2.5 rounded-lg border border-border bg-foreground/[0.03] px-3 py-2.5 text-left text-sm text-foreground/85 transition-colors hover:border-primary/40 hover:bg-foreground/[0.06] hover:text-foreground focus-visible:border-primary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="ask-example-prompt"
          >
            {/* No leading icon: the same Sparkles glyph on all four cards
                differentiated nothing and read as decoration. The prompt text
                is the content. */}
            <span>{prompt}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
