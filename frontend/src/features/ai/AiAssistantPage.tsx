import { useState, useRef, useEffect, useCallback } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { m, useReducedMotion } from 'framer-motion';
import {
  Send, Bot, User, Loader2, MessageSquare, Plus, Trash2,
  Wand2, FileText, ListCollapse, Sparkles, GitBranch, FileInput, ShieldCheck, Network,
} from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../../shared/lib/api';
import { streamSSE } from '../../shared/lib/sse';
import { usePage, useEmbeddingStatus, usePageHasChildren } from '../../shared/hooks/use-pages';
import { useStreamingContent } from '../../shared/hooks/use-streaming-content';
import { cn } from '../../shared/lib/cn';
import { useIsLightTheme } from '../../shared/hooks/use-is-light-theme';
import { DiffView } from '../../shared/components/DiffView';
import { MermaidDiagram } from '../../shared/components/MermaidDiagram';
import { FeatureErrorBoundary } from '../../shared/components/FeatureErrorBoundary';
import { ConfidenceBadge } from '../../shared/components/ConfidenceBadge';
import { StreamingCursor } from '../../shared/components/StreamingCursor';
import { AIThinkingBlob } from '../../shared/components/AIThinkingBlob';
import { StreamingMessage } from './StreamingMessage';
import { SourceCitations, type Source } from './SourceCitations';
import { CitationChips } from './CitationChips';
import { toast } from 'sonner';

/** Typing indicator: 3 dots with staggered bounce */
function TypingIndicator() {
  return (
    <div className="flex items-center gap-1" data-testid="typing-indicator" aria-label="AI is typing">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 rounded-full bg-primary/60"
          style={{
            animation: 'typing-bounce 1.2s ease-in-out infinite',
            animationDelay: `${i * 0.15}s`,
          }}
        />
      ))}
    </div>
  );
}

/** HTML-encode a string so it is safe to interpolate inside HTML elements. */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
  sources?: Source[];
}

interface Conversation {
  id: string;
  title: string;
  model: string;
  createdAt: string;
}

type Mode = 'ask' | 'improve' | 'generate' | 'summarize' | 'diagram' | 'quality';

export function AiAssistantPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const pageId = searchParams.get('pageId');
  const isLight = useIsLightTheme();

  const shouldReduceMotion = useReducedMotion();

  const [mode, setMode] = useState<Mode>(pageId ? 'improve' : 'ask');
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [thinkingElapsed, setThinkingElapsed] = useState(false);
  const thinkingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [model, setModel] = useState('');
  const [models, setModels] = useState<Array<{ name: string }>>([]);
  const [improvementType, setImprovementType] = useState<string>('grammar');
  const [showDiffView, setShowDiffView] = useState(false);
  const [improvedContent, setImprovedContent] = useState<string>('');
  const [diagramType, setDiagramType] = useState<string>('flowchart');
  const [diagramCode, setDiagramCode] = useState<string>('');
  const [isInsertingDiagram, setIsInsertingDiagram] = useState(false);
  const [includeSubPages, setIncludeSubPages] = useState(false);

  const streaming = useStreamingContent();

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const { data: page } = usePage(pageId ?? undefined);
  const { data: embeddingStatus } = useEmbeddingStatus();
  const { data: hasChildrenData } = usePageHasChildren(pageId ?? undefined);
  const pageHasChildren = hasChildrenData?.hasChildren ?? false;

  // Abort any in-flight stream on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  // After 2 seconds of thinking, promote from TypingIndicator to ThinkingBlob
  useEffect(() => {
    if (isThinking) {
      setThinkingElapsed(false);
      thinkingTimerRef.current = setTimeout(() => {
        setThinkingElapsed(true);
      }, 2000);
    } else {
      setThinkingElapsed(false);
      if (thinkingTimerRef.current) {
        clearTimeout(thinkingTimerRef.current);
        thinkingTimerRef.current = null;
      }
    }
    return () => {
      if (thinkingTimerRef.current) {
        clearTimeout(thinkingTimerRef.current);
        thinkingTimerRef.current = null;
      }
    };
  }, [isThinking]);

  // Load settings, models and conversations on mount
  useEffect(() => {
    // Load user settings to get their preferred provider and model
    apiFetch<{ llmProvider: string; ollamaModel: string; openaiModel: string | null }>('/settings')
      .then((settings) => {
        const provider = settings.llmProvider ?? 'ollama';
        const preferredModel = provider === 'openai'
          ? settings.openaiModel ?? ''
          : settings.ollamaModel ?? '';

        // Load models for the active provider
        apiFetch<Array<{ name: string }>>(`/ollama/models?provider=${provider}`)
          .then((m) => {
            setModels(m);
            // Use preferred model if available, otherwise first from list
            if (preferredModel) {
              setModel(preferredModel);
            } else if (m.length > 0) {
              setModel((prev) => prev || m[0].name);
            }
          })
          .catch(() => {
            // If model list fails but we have a preferred model, use it
            if (preferredModel) setModel(preferredModel);
          });
      })
      .catch(() => {
        // Fallback: load Ollama models directly
        apiFetch<Array<{ name: string }>>('/ollama/models')
          .then((m) => {
            setModels(m);
            if (m.length > 0) setModel((prev) => prev || m[0].name);
          })
          .catch(() => {});
      });

    apiFetch<Conversation[]>('/llm/conversations')
      .then(setConversations)
      .catch(() => {});
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streaming.displayContent]);

  const handleAsk = useCallback(async () => {
    if (!input.trim() || isStreaming) return;
    if (!model) {
      toast.error('No model available. Check your LLM provider settings.');
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const question = input.trim();
    setInput('');
    setMessages((prev) => [...prev, { role: 'user', content: question }]);
    setIsStreaming(true);
    setIsThinking(true);
    streaming.start();

    let finalSources: Source[] = [];
    setMessages((prev) => [...prev, { role: 'assistant', content: '' }]);

    try {
      for await (const chunk of streamSSE<{ content?: string; error?: string; done?: boolean; final?: boolean; conversationId?: string; sources?: Source[] }>(
        '/llm/ask',
        { question, model, conversationId, pageId: pageId ?? undefined, includeSubPages },
        controller.signal,
      )) {
        if (chunk.error) {
          toast.error(chunk.error);
          break;
        }
        if (chunk.content) {
          setIsThinking(false);
          streaming.append(chunk.content);
        }
        if (chunk.conversationId) {
          setConversationId(chunk.conversationId);
        }
        if (chunk.final && chunk.sources) {
          finalSources = chunk.sources;
        }
      }
      // Flush remaining content and commit to messages array
      streaming.finish();
      const finalContent = streaming.getContent();
      setMessages((prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = {
          role: 'assistant',
          content: finalContent,
          ...(finalSources.length > 0 ? { sources: finalSources } : {}),
        };
        return updated;
      });
    } catch (err) {
      streaming.finish();
      if (err instanceof DOMException && err.name === 'AbortError') return;
      toast.error(err instanceof Error ? err.message : 'Failed to get response');
      setMessages((prev) => prev.slice(0, -1));
    } finally {
      setIsStreaming(false);
      setIsThinking(false);
    }
  }, [input, model, isStreaming, conversationId, pageId, includeSubPages, streaming]);

  const handleImprove = useCallback(async () => {
    if (isStreaming) return;
    if (!page) {
      toast.error('No page selected. Open a page first, then click "AI Improve".');
      return;
    }
    if (!model) {
      toast.error('No model available. Check your LLM provider settings.');
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsStreaming(true);
    setIsThinking(true);
    setShowDiffView(false);
    setImprovedContent('');
    streaming.start();
    setMessages([{ role: 'user', content: `Improve (${improvementType}): ${page.title}` }]);
    setMessages((prev) => [...prev, { role: 'assistant', content: '' }]);

    try {
      for await (const chunk of streamSSE<{ content?: string; error?: string; done?: boolean }>('/llm/improve', {
        content: page.bodyHtml,
        type: improvementType,
        model,
        pageId,
        includeSubPages,
      }, controller.signal)) {
        if (chunk.error) {
          toast.error(chunk.error);
          break;
        }
        if (chunk.content) {
          setIsThinking(false);
          streaming.append(chunk.content);
        }
      }
      streaming.finish();
      const finalContent = streaming.getContent();
      setMessages((prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = { role: 'assistant', content: finalContent };
        return updated;
      });
      // Show diff view after improve completes
      setImprovedContent(finalContent);
      setShowDiffView(true);
    } catch (err) {
      streaming.finish();
      if (err instanceof DOMException && err.name === 'AbortError') return;
      toast.error(err instanceof Error ? err.message : 'Improvement failed');
    } finally {
      setIsStreaming(false);
      setIsThinking(false);
    }
  }, [page, model, improvementType, pageId, isStreaming, includeSubPages, streaming]);

  const handleGenerate = useCallback(async () => {
    if (!input.trim() || isStreaming) return;
    if (!model) {
      toast.error('No model available. Check your LLM provider settings.');
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const prompt = input.trim();
    setInput('');
    setMessages([{ role: 'user', content: `Generate: ${prompt}` }]);
    setIsStreaming(true);
    setIsThinking(true);
    streaming.start();

    setMessages((prev) => [...prev, { role: 'assistant', content: '' }]);

    try {
      for await (const chunk of streamSSE<{ content?: string; error?: string; done?: boolean }>('/llm/generate', { prompt, model }, controller.signal)) {
        if (chunk.error) {
          toast.error(chunk.error);
          break;
        }
        if (chunk.content) {
          setIsThinking(false);
          streaming.append(chunk.content);
        }
      }
      streaming.finish();
      const finalContent = streaming.getContent();
      setMessages((prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = { role: 'assistant', content: finalContent };
        return updated;
      });
    } catch (err) {
      streaming.finish();
      if (err instanceof DOMException && err.name === 'AbortError') return;
      toast.error(err instanceof Error ? err.message : 'Generation failed');
    } finally {
      setIsStreaming(false);
      setIsThinking(false);
    }
  }, [input, model, isStreaming, streaming]);

  const handleSummarize = useCallback(async () => {
    if (isStreaming) return;
    if (!page) {
      toast.error('No page selected. Open a page first, then click "Summarize".');
      return;
    }
    if (!model) {
      toast.error('No model available. Check your LLM provider settings.');
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsStreaming(true);
    setIsThinking(true);
    streaming.start();
    setMessages([{ role: 'user', content: `Summarize: ${page.title}` }]);
    setMessages((prev) => [...prev, { role: 'assistant', content: '' }]);

    try {
      for await (const chunk of streamSSE<{ content?: string; error?: string; done?: boolean }>('/llm/summarize', {
        content: page.bodyHtml,
        model,
        pageId,
        includeSubPages,
      }, controller.signal)) {
        if (chunk.error) {
          toast.error(chunk.error);
          break;
        }
        if (chunk.content) {
          setIsThinking(false);
          streaming.append(chunk.content);
        }
      }
      streaming.finish();
      const finalContent = streaming.getContent();
      setMessages((prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = { role: 'assistant', content: finalContent };
        return updated;
      });
    } catch (err) {
      streaming.finish();
      if (err instanceof DOMException && err.name === 'AbortError') return;
      toast.error(err instanceof Error ? err.message : 'Summarization failed');
    } finally {
      setIsStreaming(false);
      setIsThinking(false);
    }
  }, [page, model, isStreaming, pageId, includeSubPages, streaming]);

  const handleQuality = useCallback(async () => {
    if (isStreaming) return;
    if (!page) {
      toast.error('No page selected. Open a page first, then click "Analyze Quality".');
      return;
    }
    if (!model) {
      toast.error('No model available. Check your LLM provider settings.');
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsStreaming(true);
    setIsThinking(true);
    streaming.start();
    setMessages([{ role: 'user', content: `Analyze Quality: ${page.title}` }]);
    setMessages((prev) => [...prev, { role: 'assistant', content: '' }]);

    try {
      for await (const chunk of streamSSE<{ content?: string; error?: string; done?: boolean }>('/llm/analyze-quality', {
        content: page.bodyHtml,
        model,
        pageId,
        includeSubPages,
      }, controller.signal)) {
        if (chunk.error) {
          toast.error(chunk.error);
          break;
        }
        if (chunk.content) {
          setIsThinking(false);
          streaming.append(chunk.content);
        }
      }
      streaming.finish();
      const finalContent = streaming.getContent();
      setMessages((prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = { role: 'assistant', content: finalContent };
        return updated;
      });
    } catch (err) {
      streaming.finish();
      if (err instanceof DOMException && err.name === 'AbortError') return;
      toast.error(err instanceof Error ? err.message : 'Quality analysis failed');
    } finally {
      setIsStreaming(false);
      setIsThinking(false);
    }
  }, [page, model, pageId, isStreaming, includeSubPages, streaming]);

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
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsStreaming(true);
    setIsThinking(true);
    setDiagramCode('');
    streaming.start();
    setMessages([{ role: 'user', content: `Generate ${diagramType} diagram: ${page.title}` }]);
    setMessages((prev) => [...prev, { role: 'assistant', content: '' }]);

    try {
      for await (const chunk of streamSSE<{ content?: string; error?: string; done?: boolean }>('/llm/generate-diagram', {
        content: page.bodyHtml,
        model,
        diagramType,
        pageId,
      }, controller.signal)) {
        if (chunk.error) {
          toast.error(chunk.error);
          break;
        }
        if (chunk.content) {
          setIsThinking(false);
          streaming.append(chunk.content);
        }
      }
      streaming.finish();
      const finalContent = streaming.getContent();
      setMessages((prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = { role: 'assistant', content: finalContent };
        return updated;
      });
      setDiagramCode(finalContent);
    } catch (err) {
      streaming.finish();
      if (err instanceof DOMException && err.name === 'AbortError') return;
      toast.error(err instanceof Error ? err.message : 'Diagram generation failed');
    } finally {
      setIsStreaming(false);
      setIsThinking(false);
    }
  }, [page, model, diagramType, pageId, isStreaming, streaming]);

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
  }, [diagramCode, page, pageId, isInsertingDiagram, queryClient]);

  const startNewConversation = () => {
    setMessages([]);
    setConversationId(null);
    setInput('');
  };

  const loadConversation = async (id: string) => {
    try {
      const conv = await apiFetch<{ messages: Message[]; model: string; id: string }>(`/llm/conversations/${id}`);
      setMessages(conv.messages.filter((m: { role: string }) => m.role !== 'system') as Message[]);
      setConversationId(conv.id);
      setModel(conv.model);
      setMode('ask');
    } catch {
      toast.error('Failed to load conversation');
    }
  };

  const deleteConversation = async (id: string) => {
    try {
      await apiFetch(`/llm/conversations/${id}`, { method: 'DELETE' });
      setConversations((prev) => prev.filter((c) => c.id !== id));
      if (conversationId === id) startNewConversation();
    } catch {
      toast.error('Failed to delete conversation');
    }
  };

  const handleSubmit = () => {
    if (mode === 'ask') handleAsk();
    else if (mode === 'improve') handleImprove();
    else if (mode === 'generate') handleGenerate();
    else if (mode === 'summarize') handleSummarize();
    else if (mode === 'diagram') handleDiagram();
    else if (mode === 'quality') handleQuality();
  };

  return (
    <div className="flex h-full gap-4">
      {/* Sidebar - Conversation History */}
      <div className="hidden w-64 flex-col lg:flex">
        <div className="glass-card flex flex-col h-full">
          <div className="flex items-center justify-between border-b border-border/50 p-3">
            <span className="text-sm font-medium">Conversations</span>
            <button onClick={startNewConversation} className="rounded p-1 hover:bg-foreground/5" title="New conversation">
              <Plus size={16} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {conversations.map((conv) => (
              <div
                key={conv.id}
                className={cn(
                  'group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm cursor-pointer',
                  conversationId === conv.id ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-foreground/5',
                )}
              >
                <button onClick={() => loadConversation(conv.id)} className="flex-1 truncate text-left">
                  {conv.title || 'Untitled'}
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); deleteConversation(conv.id); }}
                  className="opacity-0 group-hover:opacity-100 rounded p-0.5 hover:bg-foreground/10"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>

          {/* Embedding status */}
          {embeddingStatus && (
            <div className="border-t border-border/50 p-3 text-xs text-muted-foreground">
              <p>Embeddings: {embeddingStatus.totalEmbeddings}</p>
              {embeddingStatus.dirtyPages > 0 && (
                <p className="text-warning">{embeddingStatus.dirtyPages} pages need embedding</p>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Main chat area */}
      <div className="flex flex-1 flex-col">
        {/* Mode selector + Model */}
        <div className="glass-card mb-4 flex items-center gap-3 p-3">
          {([
            { key: 'ask', icon: MessageSquare, label: 'Q&A' },
            { key: 'improve', icon: Wand2, label: 'Improve' },
            { key: 'generate', icon: Sparkles, label: 'Generate' },
            { key: 'summarize', icon: ListCollapse, label: 'Summarize' },
            { key: 'diagram', icon: GitBranch, label: 'Diagram' },
            { key: 'quality', icon: ShieldCheck, label: 'Quality' },
          ] as const).map(({ key, icon: Icon, label }) => (
            <button
              key={key}
              onClick={() => setMode(key)}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors',
                mode === key ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-foreground/5',
              )}
            >
              <Icon size={14} /> {label}
            </button>
          ))}

          <div className="flex-1" />

          {models.length === 0 ? (
            <span className="flex items-center gap-1.5 rounded-md bg-foreground/5 px-2 py-1 text-sm text-muted-foreground">
              <Loader2 size={12} className="animate-spin" /> Loading models...
            </span>
          ) : (
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="rounded-md bg-foreground/5 px-2 py-1 text-sm outline-none"
            >
              {models.map((m) => (
                <option key={m.name} value={m.name}>{m.name}</option>
              ))}
            </select>
          )}

          {page && (
            <span className="flex items-center gap-1 rounded bg-primary/10 px-2 py-0.5 text-xs text-primary">
              <FileText size={12} /> {page.title}
            </span>
          )}

          {page && pageHasChildren && (
            <label
              className={cn(
                'flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs transition-colors',
                includeSubPages ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-foreground/5',
              )}
              title="Include sub-pages in the AI context"
            >
              <input
                type="checkbox"
                checked={includeSubPages}
                onChange={(e) => setIncludeSubPages(e.target.checked)}
                className="sr-only"
                aria-label="Include sub-pages"
              />
              <Network size={14} />
              <span>+ Sub-pages</span>
            </label>
          )}
        </div>

        {/* Improvement type selector */}
        {mode === 'improve' && (
          <div className="glass-card mb-4 flex items-center gap-2 p-3">
            <span className="text-sm text-muted-foreground">Type:</span>
            {['grammar', 'structure', 'clarity', 'technical', 'completeness'].map((type) => (
              <button
                key={type}
                onClick={() => setImprovementType(type)}
                className={cn(
                  'rounded-md px-2.5 py-1 text-xs capitalize',
                  improvementType === type ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-foreground/5',
                )}
              >
                {type}
              </button>
            ))}
          </div>
        )}

        {/* Diagram type selector */}
        {mode === 'diagram' && (
          <div className="glass-card mb-4 flex items-center gap-2 p-3">
            <span className="text-sm text-muted-foreground">Type:</span>
            {['flowchart', 'sequence', 'state', 'mindmap'].map((type) => (
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
        )}

        {/* Messages */}
        <div className="glass-card flex-1 overflow-y-auto p-4 space-y-4">
          {messages.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center text-center">
              <Bot size={48} className="mb-4 text-muted-foreground" />
              <p className="text-lg font-medium">
                {mode === 'ask' && 'Ask questions about your knowledge base'}
                {mode === 'improve' && 'Select a page and improvement type'}
                {mode === 'generate' && 'Describe the article you want to generate'}
                {mode === 'summarize' && 'Select a page to summarize'}
                {mode === 'diagram' && 'Generate a diagram from a page'}
                {mode === 'quality' && 'Analyze article quality across multiple dimensions'}
              </p>
              <p className="text-sm text-muted-foreground">
                {mode === 'ask' && 'Your questions will be answered using RAG over your Confluence pages'}
                {mode === 'improve' && (page ? `Ready to improve: ${page.title}` : 'Navigate to a page and click "AI Improve" to get started')}
                {mode === 'generate' && 'AI will create a full article based on your prompt'}
                {mode === 'summarize' && (page ? `Ready to summarize: ${page.title}` : 'Navigate to a page and click "Summarize" to get started')}
                {mode === 'diagram' && (page ? `Ready to diagram: ${page.title}` : 'Navigate to a page and click "Diagram" to get started')}
                {mode === 'quality' && (page ? `Ready to analyze: ${page.title}` : 'Navigate to a page to analyze its quality')}
              </p>
            </div>
          )}

          {messages.map((msg, i) => {
            const isLastAssistant = msg.role === 'assistant' && i === messages.length - 1;
            const isStreamingThis = isStreaming && isLastAssistant;
            // During streaming, content lives in streaming.displayContent, not msg.content
            const effectiveContent = isStreamingThis ? streaming.displayContent : msg.content;
            const showThinkingBlob = isThinking && isLastAssistant && !effectiveContent && thinkingElapsed;
            const showTypingIndicator = isThinking && isLastAssistant && !effectiveContent && !thinkingElapsed;

            return (
              <m.div
                key={i}
                initial={shouldReduceMotion ? false : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{
                  delay: shouldReduceMotion ? 0 : Math.min(i * 0.05, 0.3),
                  type: 'spring',
                  stiffness: 300,
                  damping: 25,
                }}
                className={cn('flex gap-3', msg.role === 'user' && 'justify-end')}
              >
                {msg.role === 'assistant' && (
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/20">
                    <Bot size={16} className="text-primary" />
                  </div>
                )}
                <div
                  className={cn(
                    'max-w-[80%] rounded-lg px-4 py-3 text-sm',
                    msg.role === 'user'
                      ? 'bg-primary/15 text-foreground'
                      : 'bg-foreground/5',
                  )}
                >
                  {/* AI Thinking Blob - shown while waiting for first token */}
                  {showThinkingBlob && (
                    <AIThinkingBlob active />
                  )}
                  {/* Typing indicator - shown before streaming starts */}
                  {showTypingIndicator && (
                    <TypingIndicator />
                  )}
                  {/* Batched streaming content (reads from useStreamingContent hook) */}
                  {isStreamingThis && effectiveContent && !isThinking ? (
                    <StreamingMessage
                      content={effectiveContent}
                      isStreaming
                    />
                  ) : (
                    <div className={cn('prose prose-sm max-w-none', !isLight && 'prose-invert')}>
                      {msg.content ? (
                        <Markdown remarkPlugins={[remarkGfm]}>{msg.content}</Markdown>
                      ) : (!showThinkingBlob && !showTypingIndicator && isStreamingThis ? (
                        <TypingIndicator />
                      ) : null)}
                    </div>
                  )}
                  {/* Confidence badge + citation chips + source citations for Q&A responses */}
                  {msg.role === 'assistant' && msg.sources && msg.sources.length > 0 && (
                    <div className="mt-3 space-y-2">
                      <div className="flex items-center gap-2">
                        {(() => {
                          const scores = msg.sources!.filter((s) => s.score != null).map((s) => s.score!);
                          if (scores.length === 0) return null;
                          const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
                          return <ConfidenceBadge score={avgScore} />;
                        })()}
                        <CitationChips sources={msg.sources!} />
                      </div>
                      <SourceCitations sources={msg.sources} />
                    </div>
                  )}
                </div>
                {msg.role === 'user' && (
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-secondary">
                    <User size={16} />
                  </div>
                )}
              </m.div>
            );
          })}
          <div ref={messagesEndRef} />

          {/* Diff view for improve mode */}
          {mode === 'improve' && showDiffView && page && improvedContent && !isStreaming && (
            <DiffView
              original={page.bodyText || page.bodyHtml}
              improved={improvedContent}
              onAccept={() => {
                navigate(`/pages/${pageId}?edit=true`);
              }}
              onReject={() => setShowDiffView(false)}
            />
          )}

          {/* Mermaid diagram for diagram mode */}
          {mode === 'diagram' && diagramCode && !isStreaming && (
            <>
              <FeatureErrorBoundary featureName="Mermaid Diagram">
                <MermaidDiagram code={diagramCode} className="mt-4" />
              </FeatureErrorBoundary>
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
          )}
        </div>

        {/* Input */}
        <div className="glass-card mt-4 flex items-center gap-3 p-3">
          {(mode === 'ask' || mode === 'generate') ? (
            <>
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSubmit()}
                placeholder={mode === 'ask' ? 'Ask a question...' : 'Describe the article to generate...'}
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
            </>
          ) : (
            <button
              onClick={handleSubmit}
              disabled={isStreaming || !page || !model}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {isStreaming ? (
                <><Loader2 size={14} className="animate-spin" /> Processing...</>
              ) : !model ? (
                <><Loader2 size={14} className="animate-spin" /> Loading models...</>
              ) : (
                <>
                  {mode === 'improve' && <><Wand2 size={14} /> Improve Page</>}
                  {mode === 'summarize' && <><ListCollapse size={14} /> Summarize Page</>}
                  {mode === 'diagram' && <><GitBranch size={14} /> Generate Diagram</>}
                  {mode === 'quality' && <><ShieldCheck size={14} /> Analyze Quality</>}
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
