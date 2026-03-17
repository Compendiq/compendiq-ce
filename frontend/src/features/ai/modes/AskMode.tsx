import { useCallback } from 'react';
import { Send, Loader2 } from 'lucide-react';
import { useAiContext } from '../AiContext';
import { toast } from 'sonner';

/**
 * Q&A mode: free-text input with RAG-powered streaming responses.
 * Renders the input bar and handles the ask handler.
 */
export function AskModeInput() {
  const {
    input, setInput, isStreaming, model, conversationId, pageId,
    includeSubPages, setMessages, runStream,
  } = useAiContext();

  const handleAsk = useCallback(async () => {
    if (!input.trim() || isStreaming) return;
    if (!model) {
      toast.error('No model available. Check your LLM provider settings.');
      return;
    }

    const question = input.trim();
    setInput('');
    setMessages((prev) => [...prev, { role: 'user', content: question }]);

    await runStream(
      '/llm/ask',
      { question, model, conversationId, pageId: pageId ?? undefined, includeSubPages },
      {
        onComplete: () => {
          // Sources are attached by runStream automatically
        },
      },
    );
  }, [input, model, isStreaming, conversationId, pageId, includeSubPages, setInput, setMessages, runStream]);

  const handleSubmit = () => handleAsk();

  return (
    <div className="mt-3 flex items-center gap-3 border-t border-border/40 pt-3">
      <input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSubmit()}
        placeholder="Ask a question..."
        disabled={isStreaming}
        className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
      />
      <button
        onClick={handleSubmit}
        disabled={isStreaming || !input.trim() || !model}
        className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
      >
        {isStreaming ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
      </button>
    </div>
  );
}

export const ASK_EMPTY_TITLE = 'Ask questions about your knowledge base';
export const ASK_EMPTY_SUBTITLE = 'Your questions will be answered using RAG over your Confluence pages';
