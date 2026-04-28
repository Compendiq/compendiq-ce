import { useCallback, useEffect, useRef, useState } from 'react';
import { Send, Loader2, Link2, X, Plus, Sparkles } from 'lucide-react';
import { useAiContext, nextMessageId } from '../AiContext';
import { toast } from 'sonner';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../../../shared/lib/api';
import { ASK_EXAMPLE_PROMPTS } from './ask-example-prompts';

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

  const inputRef = useRef<HTMLInputElement>(null);

  // #350: focus input on mount so the user can type immediately. Use a ref +
  // useEffect rather than autoFocus so it survives StrictMode double-mount and
  // route transitions reliably.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

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

  return (
    <div className="mt-3 border-t border-border/40 pt-3">
      {/* External URLs chips */}
      {externalUrls.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {externalUrls.map((url) => (
            <span
              key={url}
              className="inline-flex items-center gap-1 rounded-full border border-primary/20 bg-primary/5 px-2 py-0.5 text-xs text-primary"
            >
              <Link2 size={10} />
              {new URL(url).hostname}
              <button onClick={() => removeUrl(url)} className="hover:text-red-400">
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
            className="shrink-0 rounded-md px-2 py-1 text-xs text-primary hover:bg-primary/10"
          >
            <Plus size={12} />
          </button>
          <button
            onClick={() => { setShowUrlInput(false); setUrlInput(''); }}
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
            className={`shrink-0 rounded-md p-1.5 transition-colors ${
              showUrlInput || externalUrls.length > 0
                ? 'bg-primary/15 text-primary'
                : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground'
            }`}
            data-testid="attach-url-button"
          >
            <Link2 size={16} />
          </button>
        )}
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSubmit()}
          placeholder="Ask a question..."
          disabled={isStreaming}
          className="flex-1 bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground/70 disabled:opacity-50"
          data-testid="ask-input"
        />
        <button
          onClick={handleSubmit}
          disabled={isStreaming || !input.trim() || !model}
          aria-label={isStreaming ? 'Sending...' : 'Send message'}
          className="shrink-0 flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {isStreaming ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
        </button>
      </div>
    </div>
  );
}

export const ASK_EMPTY_TITLE = 'Ask questions about your knowledge base';
export const ASK_EMPTY_SUBTITLE = 'Your questions will be answered using RAG over your Confluence pages';

export function AskExamplePrompts() {
  const { setInput } = useAiContext();

  const pick = (prompt: string) => {
    setInput(prompt);
    // Defer focus to next tick so the input mounts before we focus it.
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLInputElement>('[data-testid="ask-input"]');
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
      className="mt-6 grid w-full max-w-xl grid-cols-1 gap-2 sm:grid-cols-2 list-none p-0"
    >
      {ASK_EXAMPLE_PROMPTS.map((prompt) => (
        <li key={prompt}>
          <button
            type="button"
            onClick={() => pick(prompt)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                pick(prompt);
              }
            }}
            className="nm-card-interactive flex w-full items-start gap-2 rounded-lg p-3 text-left text-xs text-foreground/80 hover:text-foreground"
            data-testid="ask-example-prompt"
          >
            <Sparkles size={14} className="mt-0.5 shrink-0 text-primary" />
            <span>{prompt}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
