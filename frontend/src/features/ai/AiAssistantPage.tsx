import { useState, useRef, useEffect, useCallback } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { m } from 'framer-motion';
import {
  Send, Bot, User, Loader2, MessageSquare, Plus, Trash2,
  Wand2, FileText, ListCollapse, Sparkles, GitBranch,
} from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { apiFetch } from '../../shared/lib/api';
import { streamSSE } from '../../shared/lib/sse';
import { usePage, useEmbeddingStatus } from '../../shared/hooks/use-pages';
import { cn } from '../../shared/lib/cn';
import { DiffView } from '../../shared/components/DiffView';
import { MermaidDiagram } from '../../shared/components/MermaidDiagram';
import { SourceCitations, type Source } from './SourceCitations';
import { toast } from 'sonner';

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

type Mode = 'ask' | 'improve' | 'generate' | 'summarize' | 'diagram';

export function AiAssistantPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const pageId = searchParams.get('pageId');

  const [mode, setMode] = useState<Mode>(pageId ? 'improve' : 'ask');
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [model, setModel] = useState('');
  const [models, setModels] = useState<Array<{ name: string }>>([]);
  const [improvementType, setImprovementType] = useState<string>('grammar');
  const [showDiffView, setShowDiffView] = useState(false);
  const [improvedContent, setImprovedContent] = useState<string>('');
  const [diagramType, setDiagramType] = useState<string>('flowchart');
  const [diagramCode, setDiagramCode] = useState<string>('');

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const { data: page } = usePage(pageId ?? undefined);
  const { data: embeddingStatus } = useEmbeddingStatus();

  // Abort any in-flight stream on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

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
  }, [messages]);

  const handleAsk = useCallback(async () => {
    if (!input.trim() || !model || isStreaming) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const question = input.trim();
    setInput('');
    setMessages((prev) => [...prev, { role: 'user', content: question }]);
    setIsStreaming(true);

    let assistantContent = '';
    let finalSources: Source[] = [];
    setMessages((prev) => [...prev, { role: 'assistant', content: '' }]);

    try {
      for await (const chunk of streamSSE<{ content?: string; done?: boolean; final?: boolean; conversationId?: string; sources?: Source[] }>(
        '/llm/ask',
        { question, model, conversationId },
        controller.signal,
      )) {
        if (chunk.content) {
          assistantContent += chunk.content;
          setMessages((prev) => {
            const updated = [...prev];
            updated[updated.length - 1] = { role: 'assistant', content: assistantContent };
            return updated;
          });
        }
        if (chunk.conversationId) {
          setConversationId(chunk.conversationId);
        }
        if (chunk.final && chunk.sources) {
          finalSources = chunk.sources;
        }
      }
      // Attach sources to the last assistant message
      if (finalSources.length > 0) {
        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = { ...updated[updated.length - 1], sources: finalSources };
          return updated;
        });
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      toast.error(err instanceof Error ? err.message : 'Failed to get response');
      setMessages((prev) => prev.slice(0, -1));
    } finally {
      setIsStreaming(false);
    }
  }, [input, model, isStreaming, conversationId]);

  const handleImprove = useCallback(async () => {
    if (!page || !model || isStreaming) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsStreaming(true);
    setShowDiffView(false);
    setImprovedContent('');
    setMessages([{ role: 'user', content: `Improve (${improvementType}): ${page.title}` }]);

    let result = '';
    setMessages((prev) => [...prev, { role: 'assistant', content: '' }]);

    try {
      for await (const chunk of streamSSE('/llm/improve', {
        content: page.bodyHtml,
        type: improvementType,
        model,
        pageId,
      }, controller.signal)) {
        if (chunk.content) {
          result += chunk.content;
          setMessages((prev) => {
            const updated = [...prev];
            updated[updated.length - 1] = { role: 'assistant', content: result };
            return updated;
          });
        }
      }
      // Show diff view after improve completes
      setImprovedContent(result);
      setShowDiffView(true);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      toast.error(err instanceof Error ? err.message : 'Improvement failed');
    } finally {
      setIsStreaming(false);
    }
  }, [page, model, improvementType, pageId, isStreaming]);

  const handleGenerate = useCallback(async () => {
    if (!input.trim() || !model || isStreaming) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const prompt = input.trim();
    setInput('');
    setMessages([{ role: 'user', content: `Generate: ${prompt}` }]);
    setIsStreaming(true);

    let result = '';
    setMessages((prev) => [...prev, { role: 'assistant', content: '' }]);

    try {
      for await (const chunk of streamSSE('/llm/generate', { prompt, model }, controller.signal)) {
        if (chunk.content) {
          result += chunk.content;
          setMessages((prev) => {
            const updated = [...prev];
            updated[updated.length - 1] = { role: 'assistant', content: result };
            return updated;
          });
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      toast.error(err instanceof Error ? err.message : 'Generation failed');
    } finally {
      setIsStreaming(false);
    }
  }, [input, model, isStreaming]);

  const handleSummarize = useCallback(async () => {
    if (!page || !model || isStreaming) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsStreaming(true);
    setMessages([{ role: 'user', content: `Summarize: ${page.title}` }]);

    let result = '';
    setMessages((prev) => [...prev, { role: 'assistant', content: '' }]);

    try {
      for await (const chunk of streamSSE('/llm/summarize', {
        content: page.bodyHtml,
        model,
      }, controller.signal)) {
        if (chunk.content) {
          result += chunk.content;
          setMessages((prev) => {
            const updated = [...prev];
            updated[updated.length - 1] = { role: 'assistant', content: result };
            return updated;
          });
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      toast.error(err instanceof Error ? err.message : 'Summarization failed');
    } finally {
      setIsStreaming(false);
    }
  }, [page, model, isStreaming]);

  const handleDiagram = useCallback(async () => {
    if (!page || !model || isStreaming) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsStreaming(true);
    setDiagramCode('');
    setMessages([{ role: 'user', content: `Generate ${diagramType} diagram: ${page.title}` }]);

    let result = '';
    setMessages((prev) => [...prev, { role: 'assistant', content: '' }]);

    try {
      for await (const chunk of streamSSE('/llm/generate-diagram', {
        content: page.bodyHtml,
        model,
        diagramType,
        pageId,
      }, controller.signal)) {
        if (chunk.content) {
          result += chunk.content;
          setMessages((prev) => {
            const updated = [...prev];
            updated[updated.length - 1] = { role: 'assistant', content: result };
            return updated;
          });
        }
      }
      setDiagramCode(result);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      toast.error(err instanceof Error ? err.message : 'Diagram generation failed');
    } finally {
      setIsStreaming(false);
    }
  }, [page, model, diagramType, pageId, isStreaming]);

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
  };

  return (
    <div className="flex h-full gap-4">
      {/* Sidebar - Conversation History */}
      <div className="hidden w-64 flex-col lg:flex">
        <div className="glass-card flex flex-col h-full">
          <div className="flex items-center justify-between border-b border-white/10 p-3">
            <span className="text-sm font-medium">Conversations</span>
            <button onClick={startNewConversation} className="rounded p-1 hover:bg-white/5" title="New conversation">
              <Plus size={16} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {conversations.map((conv) => (
              <div
                key={conv.id}
                className={cn(
                  'group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm cursor-pointer',
                  conversationId === conv.id ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-white/5',
                )}
              >
                <button onClick={() => loadConversation(conv.id)} className="flex-1 truncate text-left">
                  {conv.title || 'Untitled'}
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); deleteConversation(conv.id); }}
                  className="opacity-0 group-hover:opacity-100 rounded p-0.5 hover:bg-white/10"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>

          {/* Embedding status */}
          {embeddingStatus && (
            <div className="border-t border-white/10 p-3 text-xs text-muted-foreground">
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
          ] as const).map(({ key, icon: Icon, label }) => (
            <button
              key={key}
              onClick={() => setMode(key)}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors',
                mode === key ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-white/5',
              )}
            >
              <Icon size={14} /> {label}
            </button>
          ))}

          <div className="flex-1" />

          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="rounded-md bg-white/5 px-2 py-1 text-sm outline-none"
          >
            {models.map((m) => (
              <option key={m.name} value={m.name}>{m.name}</option>
            ))}
          </select>

          {page && (
            <span className="flex items-center gap-1 rounded bg-primary/10 px-2 py-0.5 text-xs text-primary">
              <FileText size={12} /> {page.title}
            </span>
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
                  improvementType === type ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-white/5',
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
                  diagramType === type ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-white/5',
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
              </p>
              <p className="text-sm text-muted-foreground">
                {mode === 'ask' && 'Your questions will be answered using RAG over your Confluence pages'}
                {mode === 'improve' && page ? `Ready to improve: ${page.title}` : 'Open a page first'}
                {mode === 'generate' && 'AI will create a full article based on your prompt'}
                {mode === 'summarize' && page ? `Ready to summarize: ${page.title}` : 'Open a page first'}
                {mode === 'diagram' && page ? `Ready to diagram: ${page.title}` : 'Open a page first'}
              </p>
            </div>
          )}

          {messages.map((msg, i) => (
            <m.div
              key={i}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
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
                    : 'bg-white/5',
                )}
              >
                <div className="prose prose-invert prose-sm max-w-none">
                  {msg.content ? (
                    <Markdown remarkPlugins={[remarkGfm]}>{msg.content}</Markdown>
                  ) : (isStreaming && i === messages.length - 1 ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : null)}
                </div>
                {/* Source citations for Q&A responses */}
                {msg.role === 'assistant' && msg.sources && msg.sources.length > 0 && (
                  <SourceCitations sources={msg.sources} />
                )}
              </div>
              {msg.role === 'user' && (
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-secondary">
                  <User size={16} />
                </div>
              )}
            </m.div>
          ))}
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
            <MermaidDiagram code={diagramCode} className="mt-4" />
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
                disabled={isStreaming || !input.trim()}
                className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
              >
                {isStreaming ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              </button>
            </>
          ) : (
            <button
              onClick={handleSubmit}
              disabled={isStreaming || !page}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {isStreaming ? (
                <><Loader2 size={14} className="animate-spin" /> Processing...</>
              ) : (
                <>
                  {mode === 'improve' && <><Wand2 size={14} /> Improve Page</>}
                  {mode === 'summarize' && <><ListCollapse size={14} /> Summarize Page</>}
                  {mode === 'diagram' && <><GitBranch size={14} /> Generate Diagram</>}
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
