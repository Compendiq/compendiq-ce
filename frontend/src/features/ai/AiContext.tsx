/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useState, useRef, useEffect, useCallback, type ReactNode } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../../shared/lib/api';
import { streamSSE } from '../../shared/lib/sse';
import { usePage, useEmbeddingStatus, type EmbeddingStatusData } from '../../shared/hooks/use-pages';
import { useIsLightTheme } from '../../shared/hooks/use-is-light-theme';
import { type Source } from './SourceCitations';
import { toast } from 'sonner';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

let messageIdCounter = 0;
/** Generate a stable, unique ID for each message. */
export function nextMessageId(): string {
  return `msg-${++messageIdCounter}`;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sources?: Source[];
}

export interface Conversation {
  id: string;
  title: string;
  model: string;
  createdAt: string;
}

export type Mode = 'ask' | 'improve' | 'generate' | 'summarize' | 'diagram' | 'quality';

export interface PageData {
  id: string;
  title: string;
  bodyHtml: string;
  bodyText: string;
  version: number;
  hasChildren?: boolean;
}

export interface AiContextValue {
  // Route / query state
  pageId: string | null;
  page: PageData | undefined;
  pageHasChildren: boolean;
  navigate: ReturnType<typeof useNavigate>;
  queryClient: ReturnType<typeof useQueryClient>;

  // Mode
  mode: Mode;
  setMode: (m: Mode) => void;

  // Conversation & messages
  messages: Message[];
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  conversationId: string | null;
  setConversationId: (id: string | null) => void;
  conversations: Conversation[];
  setConversations: React.Dispatch<React.SetStateAction<Conversation[]>>;
  startNewConversation: () => void;
  loadConversation: (id: string) => Promise<void>;
  deleteConversation: (id: string) => Promise<void>;

  // Models
  model: string;
  setModel: (m: string) => void;
  models: Array<{ name: string }>;

  // Streaming state
  input: string;
  setInput: (v: string) => void;
  isStreaming: boolean;
  setIsStreaming: (v: boolean) => void;
  isThinking: boolean;
  setIsThinking: (v: boolean) => void;
  thinkingElapsed: boolean;
  abortRef: React.MutableRefObject<AbortController | null>;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;

  // Sub-pages
  includeSubPages: boolean;
  setIncludeSubPages: (v: boolean) => void;

  // Page loading
  isPageLoading: boolean;

  // Embedding status
  embeddingStatus: EmbeddingStatusData | undefined;

  // Theme
  isLight: boolean;

  // Improve mode state
  improvementType: string;
  setImprovementType: (v: string) => void;
  showDiffView: boolean;
  setShowDiffView: (v: boolean) => void;
  improvedContent: string;
  setImprovedContent: (v: string) => void;

  // Diagram mode state
  diagramType: string;
  setDiagramType: (v: string) => void;
  diagramCode: string;
  setDiagramCode: (v: string) => void;
  isInsertingDiagram: boolean;
  setIsInsertingDiagram: (v: boolean) => void;

  // Streaming helper
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  runStream: <T extends { content?: string; error?: string; done?: boolean; final?: boolean; conversationId?: string; sources?: Source[] }>(
    endpoint: string,
    body: Record<string, unknown>,
    opts?: {
      onBeforeStream?: () => void;
      onContent?: (accumulated: string) => void;
      onComplete?: (accumulated: string, sources?: Source[]) => void;
      userMessage?: string;
    },
  ) => Promise<void>;
}

const AiCtx = createContext<AiContextValue | null>(null);

export function useAiContext(): AiContextValue {
  const ctx = useContext(AiCtx);
  if (!ctx) throw new Error('useAiContext must be used within AiProvider');
  return ctx;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function AiProvider({ children }: { children: ReactNode }) {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const pageId = searchParams.get('pageId');
  const isLight = useIsLightTheme();

  const VALID_MODES: Mode[] = ['ask', 'improve', 'generate', 'summarize', 'diagram', 'quality'];
  const rawMode = searchParams.get('mode');
  const urlMode = VALID_MODES.includes(rawMode as Mode) ? (rawMode as Mode) : null;
  const [mode, setMode] = useState<Mode>(urlMode ?? (pageId ? 'improve' : 'ask'));
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
  const [includeSubPages, setIncludeSubPages] = useState(false);
  const [improvementType, setImprovementType] = useState('grammar');
  const [showDiffView, setShowDiffView] = useState(false);
  const [improvedContent, setImprovedContent] = useState('');
  const [diagramType, setDiagramType] = useState('flowchart');
  const [diagramCode, setDiagramCode] = useState('');
  const [isInsertingDiagram, setIsInsertingDiagram] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const isStreamingRef = useRef(false);
  const { data: page, isLoading: isPageLoading } = usePage(pageId ?? undefined);
  const { data: embeddingStatus } = useEmbeddingStatus();
  const pageHasChildren = page?.hasChildren ?? false;

  // Abort any in-flight stream on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  // Clear conversation when the AI context page changes (e.g. sidebar click)
  const prevPageIdRef = useRef(pageId);
  useEffect(() => {
    if (pageId !== prevPageIdRef.current) {
      prevPageIdRef.current = pageId;
      // Abort any in-flight stream and reset conversation state
      abortRef.current?.abort();
      setMessages([]);
      setConversationId(null);
      setInput('');
      setShowDiffView(false);
      setImprovedContent('');
      setDiagramCode('');
    }
  }, [pageId]);

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
    apiFetch<{ llmProvider: string; ollamaModel: string; openaiModel: string | null }>('/settings')
      .then((settings) => {
        const provider = settings.llmProvider ?? 'ollama';
        const preferredModel = provider === 'openai'
          ? settings.openaiModel ?? ''
          : settings.ollamaModel ?? '';

        apiFetch<Array<{ name: string }>>(`/ollama/models?provider=${provider}`)
          .then((m) => {
            setModels(m);
            if (preferredModel) {
              setModel(preferredModel);
            } else if (m.length > 0) {
              setModel((prev) => prev || m[0].name);
            }
          })
          .catch(() => {
            if (preferredModel) setModel(preferredModel);
          });
      })
      .catch(() => {
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
    if (messages.length === 0) return;
    // Skip auto-scroll in improve mode — the page should stay in place
    // so the user can see the full UI instead of jumping to the message area
    if (mode === 'improve') return;
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, mode]);

  // Scroll to bottom immediately when switching conversations so the latest
  // messages are visible right away (independent of the messages-change effect).
  useEffect(() => {
    if (!conversationId) return;
    messagesEndRef.current?.scrollIntoView({ behavior: 'instant' });
  }, [conversationId]);

  const startNewConversation = useCallback(() => {
    setMessages([]);
    setConversationId(null);
    setInput('');
  }, []);

  const loadConversation = useCallback(async (id: string) => {
    try {
      const conv = await apiFetch<{ messages: Array<{ role: string; content: string; sources?: Source[] }>; model: string; id: string }>(`/llm/conversations/${id}`);
      setMessages(
        conv.messages
          .filter((m) => m.role !== 'system')
          .map((m) => ({ id: nextMessageId(), role: m.role as 'user' | 'assistant', content: m.content, sources: m.sources })),
      );
      setConversationId(conv.id);
      setModel(conv.model);
      setMode('ask');
    } catch {
      toast.error('Failed to load conversation');
    }
  }, []);

  const deleteConversation = useCallback(async (id: string) => {
    try {
      await apiFetch(`/llm/conversations/${id}`, { method: 'DELETE' });
      setConversations((prev) => prev.filter((c) => c.id !== id));
      if (conversationId === id) startNewConversation();
    } catch {
      toast.error('Failed to delete conversation');
    }
  }, [conversationId, startNewConversation]);

  /**
   * Generic SSE streaming helper used by all mode handlers.
   * Manages abort controller, streaming state, thinking state, and message accumulation.
   */
  const runStream = useCallback(async <T extends { content?: string; error?: string; done?: boolean; final?: boolean; conversationId?: string; sources?: Source[] }>(
    endpoint: string,
    body: Record<string, unknown>,
    opts?: {
      onBeforeStream?: () => void;
      onContent?: (accumulated: string) => void;
      onComplete?: (accumulated: string, sources?: Source[]) => void;
      userMessage?: string;
    },
  ) => {
    if (isStreamingRef.current) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    if (opts?.userMessage) {
      setMessages([{ id: nextMessageId(), role: 'user', content: opts.userMessage }]);
    }

    opts?.onBeforeStream?.();
    isStreamingRef.current = true;
    setIsStreaming(true);
    setIsThinking(true);

    let accumulated = '';
    let finalSources: Source[] = [];

    // Add the placeholder assistant message with a stable ID
    const assistantMsgId = nextMessageId();
    setMessages((prev) => [...prev, { id: assistantMsgId, role: 'assistant', content: '' }]);

    try {
      for await (const chunk of streamSSE<T>(endpoint, body, controller.signal)) {
        if (chunk.error) {
          toast.error(chunk.error);
          break;
        }
        // Handle finalContent from output post-processing (cleaned content replaces accumulated)
        if ((chunk as Record<string, unknown>).finalContent) {
          accumulated = (chunk as Record<string, unknown>).finalContent as string;
          setMessages((prev) => {
            const updated = [...prev];
            updated[updated.length - 1] = { ...updated[updated.length - 1], content: accumulated };
            return updated;
          });
          opts?.onContent?.(accumulated);
        }
        if (chunk.content) {
          setIsThinking(false);
          accumulated += chunk.content;
          setMessages((prev) => {
            const updated = [...prev];
            updated[updated.length - 1] = { ...updated[updated.length - 1], content: accumulated };
            return updated;
          });
          opts?.onContent?.(accumulated);
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
      opts?.onComplete?.(accumulated, finalSources.length > 0 ? finalSources : undefined);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      toast.error(err instanceof Error ? err.message : 'Request failed');
      // Always remove the empty assistant message on error — runStream unconditionally
      // adds a placeholder assistant message, regardless of whether userMessage was passed.
      setMessages((prev) => prev.slice(0, -1));
    } finally {
      isStreamingRef.current = false;
      setIsStreaming(false);
      setIsThinking(false);
    }
  }, []);

  const value: AiContextValue = {
    pageId,
    page: page as PageData | undefined,
    pageHasChildren,
    navigate,
    queryClient,
    mode,
    setMode,
    messages,
    setMessages,
    conversationId,
    setConversationId,
    conversations,
    setConversations,
    startNewConversation,
    loadConversation,
    deleteConversation,
    model,
    setModel,
    models,
    input,
    setInput,
    isStreaming,
    setIsStreaming,
    isThinking,
    setIsThinking,
    thinkingElapsed,
    abortRef,
    messagesEndRef,
    includeSubPages,
    setIncludeSubPages,
    isPageLoading,
    embeddingStatus,
    isLight,
    improvementType,
    setImprovementType,
    showDiffView,
    setShowDiffView,
    improvedContent,
    setImprovedContent,
    diagramType,
    setDiagramType,
    diagramCode,
    setDiagramCode,
    isInsertingDiagram,
    setIsInsertingDiagram,
    runStream,
  };

  return <AiCtx.Provider value={value}>{children}</AiCtx.Provider>;
}
