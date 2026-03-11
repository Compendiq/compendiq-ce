import { useCallback } from 'react';
import { Send, Loader2 } from 'lucide-react';
import { useAiContext } from '../AiContext';
import { toast } from 'sonner';

/**
 * Generate mode: free-text prompt to create a new article via LLM streaming.
 */
export function GenerateModeInput() {
  const { input, setInput, isStreaming, model, setMessages, runStream } = useAiContext();

  const handleGenerate = useCallback(async () => {
    if (!input.trim() || isStreaming) return;
    if (!model) {
      toast.error('No model available. Check your LLM provider settings.');
      return;
    }

    const prompt = input.trim();
    setInput('');
    setMessages([{ role: 'user', content: `Generate: ${prompt}` }]);

    await runStream('/llm/generate', { prompt, model });
  }, [input, model, isStreaming, setInput, setMessages, runStream]);

  const handleSubmit = () => handleGenerate();

  return (
    <div className="mt-3 flex items-center gap-3 border-t border-border/40 pt-3">
      <input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSubmit()}
        placeholder="Describe the article to generate..."
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

export const GENERATE_EMPTY_TITLE = 'Describe the article you want to generate';
export const GENERATE_EMPTY_SUBTITLE = 'AI will create a full article based on your prompt';
