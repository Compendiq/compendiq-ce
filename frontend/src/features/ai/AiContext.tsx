/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useState, useRef, useEffect, useCallback, type ReactNode } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { UsecaseDefault } from '@compendiq/contracts';
import { apiFetch, ApiError } from '../../shared/lib/api';
import { streamSSE } from '../../shared/lib/sse';
import { usePage, useEmbeddingStatus, type EmbeddingStatusData } from '../../shared/hooks/use-pages';
import { useIsLightTheme } from '../../shared/hooks/use-is-light-theme';
import { useStreamingContent } from '../../shared/hooks/use-streaming-content';
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
  /** True when this assistant message reports a failed request (rendered with
   * destructive styling instead of the regular bubble). */
  isError?: boolean;
}

interface Conversation {
  id: string;
  title: string;
  model: string;
  createdAt: string;
}

export type Mode = 'ask' | 'improve' | 'generate' | 'summarize' | 'diagram' | 'quality';

interface PageData {
  id: string;
  title: string;
  bodyHtml: string;
  bodyText: string;
  version: number;
  hasChildren?: boolean;
}

interface AiContextValue {
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
  /** True when the models fetch failed (e.g. LLM provider down) — the UI must
   * surface a retry affordance instead of spinning forever. */
  modelsError: boolean;
  refetchModels: () => void;

  // Streaming state
  input: string;
  setInput: (v: string) => void;
  isStreaming: boolean;
  setIsStreaming: (v: boolean) => void;
  /**
   * rAF-batched content of the in-flight assistant answer (#747). During a
   * stream the placeholder assistant message in `messages` stays empty and
   * the UI renders this value instead; runStream commits the final content
   * to `messages` once the stream ends.
   */
  streamingContent: string;
  isThinking: boolean;
  setIsThinking: (v: boolean) => void;
  thinkingElapsed: boolean;
  abortRef: React.MutableRefObject<AbortController | null>;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;

  // Sub-pages
  includeSubPages: boolean;
  setIncludeSubPages: (v: boolean) => void;

  // Thinking mode (#20)
  thinkingMode: boolean;
  setThinkingMode: (v: boolean) => void;

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
  /** Markdown baseline (#704) the model was fed — diffed against `improvedContent`. */
  originalMarkdown: string;
  setOriginalMarkdown: (v: string) => void;

  // Diagram mode state
  diagramType: string;
  setDiagramType: (v: string) => void;
  diagramCode: string;
  setDiagramCode: (v: string) => void;
  isInsertingDiagram: boolean;
  setIsInsertingDiagram: (v: boolean) => void;

  // Streaming helper
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  runStream: <T extends StreamChunk>(
    endpoint: string,
    body: Record<string, unknown>,
    opts?: {
      onBeforeStream?: () => void;
      onContent?: (accumulated: string) => void;
      onComplete?: (accumulated: string, sources?: Source[], meta?: StreamMeta) => void;
      userMessage?: string;
    },
  ) => Promise<void>;
}

/** Shape of a single parsed SSE event from any `/llm/*` streaming route. */
interface StreamChunk {
  content?: string;
  error?: string;
  done?: boolean;
  final?: boolean;
  conversationId?: string;
  sources?: Source[];
  /** Improve route (#704): the original markdown the model was fed, echoed on the final event. */
  originalMarkdown?: string;
}

/** Extra, non-content metadata surfaced to `onComplete` once a stream finishes. */
export interface StreamMeta {
  /** Improve route (#704): markdown baseline for like-for-like diffing. */
  originalMarkdown?: string;
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
  const [includeSubPages, setIncludeSubPages] = useState(false);
  const [thinkingMode, setThinkingModeState] = useState(() => localStorage.getItem('ai-thinking-mode') === 'true');
  const handleSetThinkingMode = useCallback((v: boolean) => {
    setThinkingModeState(v);
    localStorage.setItem('ai-thinking-mode', String(v));
  }, []);
  const [improvementType, setImprovementType] = useState('grammar');
  const [showDiffView, setShowDiffView] = useState(false);
  const [improvedContent, setImprovedContent] = useState('');
  const [originalMarkdown, setOriginalMarkdown] = useState('');
  const [diagramType, setDiagramType] = useState('flowchart');
  const [diagramCode, setDiagramCode] = useState('');
  const [isInsertingDiagram, setIsInsertingDiagram] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const isStreamingRef = useRef(false);

  // #747: rAF-batched display buffer for the in-flight assistant answer.
  // SSE chunks are appended to a ref and flushed to React state at most once
  // per animation frame (~20x/s), instead of committing every chunk to
  // `messages` (which re-parsed the full Markdown answer per token).
  const streaming = useStreamingContent();
  const {
    start: streamingStart,
    append: streamingAppend,
    replace: streamingReplace,
    finish: streamingFinish,
  } = streaming;
  const streamingDisplayContent = streaming.displayContent;
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
      setOriginalMarkdown('');
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

  // Load settings, models and conversations on mount.
  // #355: prefer the admin-configured chat use-case default (resolveUsecase
  // 'chat') over the legacy per-user settings.ollamaModel/openaiModel. The
  // settings model remains a fallback so the input never shows empty if the
  // chat use-case isn't configured.
  //
  // Refactored to TanStack Query (Finding 1, AC-3) so admin-side changes to
  // the chat use-case assignment propagate to the chat UI without a hard
  // reload. LlmTab's save handler invalidates ['llm', 'usecase-default'] and
  // ['llm', 'models'], which causes these queries to refetch automatically.
  const chatDefaultQuery = useQuery<UsecaseDefault>({
    queryKey: ['llm', 'usecase-default', 'chat'],
    queryFn: () => apiFetch<UsecaseDefault>('/llm/usecase-default?usecase=chat'),
    // Returns 404 when no provider is configured for chat — that's a legitimate
    // "no default" signal that we should fall through to the legacy /settings
    // path; do not retry it as an error.
    retry: false,
    staleTime: 30_000,
  });
  const chatDefault = chatDefaultQuery.data;
  const isChatDefaultSettled = !chatDefaultQuery.isLoading;

  // Legacy fallback only consulted when the chat use-case has no configured
  // default. Skipped while the primary query is still in flight so we don't
  // race-set the wrong model.
  const settingsFallbackQuery = useQuery<{
    llmProvider: string;
    ollamaModel: string;
    openaiModel: string | null;
  }>({
    queryKey: ['settings', 'llm-fallback'],
    queryFn: () =>
      apiFetch('/settings'),
    enabled: isChatDefaultSettled && !chatDefault?.model,
    retry: false,
    staleTime: 30_000,
  });

  // Models for the chat use case. Finding 4: the backend route at
  // backend/src/routes/llm/llm-models.ts only parses ?usecase=… — it ignores
  // ?provider=… entirely. Calling with the wrong query param silently returned
  // the default provider's models, which broke when chat was assigned to a
  // non-default provider.
  const modelsQuery = useQuery<Array<{ name: string }>>({
    queryKey: ['llm', 'models', 'chat'],
    queryFn: () => apiFetch<Array<{ name: string }>>('/ollama/models?usecase=chat'),
    retry: false,
    staleTime: 30_000,
  });
  const models = modelsQuery.data ?? [];

  const conversationsQuery = useQuery<Conversation[]>({
    queryKey: ['llm', 'conversations'],
    queryFn: () => apiFetch<Conversation[]>('/llm/conversations'),
    retry: false,
    staleTime: 30_000,
  });
  useEffect(() => {
    if (conversationsQuery.data) setConversations(conversationsQuery.data);
  }, [conversationsQuery.data]);

  // Initial model selection. Runs once when the resolved default (or its
  // fallback chain) becomes available. Subsequent admin-side changes update
  // the dropdown options live, but the *selected* model only resets on the
  // next startNewConversation() call — see Finding 2.
  const modelInitializedRef = useRef(false);
  useEffect(() => {
    if (modelInitializedRef.current) return;
    if (chatDefault?.model) {
      setModel(chatDefault.model);
      modelInitializedRef.current = true;
      return;
    }
    if (settingsFallbackQuery.data) {
      const s = settingsFallbackQuery.data;
      const provider = s.llmProvider ?? 'ollama';
      const fb = provider === 'openai' ? s.openaiModel ?? '' : s.ollamaModel ?? '';
      if (fb) {
        setModel(fb);
        modelInitializedRef.current = true;
        return;
      }
    }
    const modelsList = modelsQuery.data;
    if (modelsList && modelsList.length > 0) {
      setModel((prev) => prev || (modelsList[0]?.name ?? ''));
      modelInitializedRef.current = true;
    }
  }, [chatDefault, settingsFallbackQuery.data, modelsQuery.data]);

  // Auto-scroll when committed messages change and on each batched streaming
  // flush (#747: the in-flight answer renders via streamingDisplayContent and
  // no longer updates `messages` per SSE chunk).
  useEffect(() => {
    if (messages.length === 0 && !streamingDisplayContent) return;
    // Skip auto-scroll in improve mode — the page should stay in place
    // so the user can see the full UI instead of jumping to the message area
    if (mode === 'improve') return;
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, mode, streamingDisplayContent]);

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
    // #355 (Finding 2, AC-4): reset the model selector to the current chat
    // default so a per-conversation override (set via loadConversation or the
    // dropdown) doesn't leak into newly-started conversations. We read from
    // the live TanStack Query result so admin-side changes are picked up
    // without remounting.
    if (chatDefault?.model) {
      setModel(chatDefault.model);
    }
  }, [chatDefault]);

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
  const runStream = useCallback(async <T extends StreamChunk>(
    endpoint: string,
    body: Record<string, unknown>,
    opts?: {
      onBeforeStream?: () => void;
      onContent?: (accumulated: string) => void;
      onComplete?: (accumulated: string, sources?: Source[], meta?: StreamMeta) => void;
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
    let originalMarkdown: string | undefined;

    // Add the placeholder assistant message with a stable ID. It stays empty
    // during the stream (#747) — the in-flight answer renders through the
    // rAF-batched streamingContent — and gets the full content committed in
    // a single update once the stream ends.
    const assistantMsgId = nextMessageId();
    setMessages((prev) => [...prev, { id: assistantMsgId, role: 'assistant', content: '' }]);
    streamingStart();

    // Commit the accumulated answer (and sources, if any) to the placeholder
    // assistant message in one state update.
    const commitToMessages = () => {
      setMessages((prev) => {
        const updated = [...prev];
        const lastMsg = updated[updated.length - 1];
        if (lastMsg) {
          updated[updated.length - 1] = {
            ...lastMsg,
            content: accumulated,
            ...(finalSources.length > 0 ? { sources: finalSources } : {}),
          };
        }
        return updated;
      });
    };

    // Replace the placeholder assistant message with an inline error bubble —
    // shared by thrown errors (catch below) and in-band SSE error events.
    const failLastMessage = (text: string) => {
      setMessages((prev) => {
        const updated = [...prev];
        const lastMsg = updated[updated.length - 1];
        if (lastMsg && lastMsg.role === 'assistant') {
          updated[updated.length - 1] = { ...lastMsg, content: text, isError: true };
        }
        return updated;
      });
    };

    try {
      let streamError: string | null = null;
      for await (const chunk of streamSSE<T>(endpoint, body, controller.signal)) {
        if (chunk.error) {
          streamError = chunk.error;
          break;
        }
        // Handle finalContent from output post-processing (cleaned content replaces accumulated)
        if ((chunk as Record<string, unknown>).finalContent) {
          accumulated = (chunk as Record<string, unknown>).finalContent as string;
          streamingReplace(accumulated);
          opts?.onContent?.(accumulated);
        }
        if (chunk.content) {
          setIsThinking(false);
          accumulated += chunk.content;
          streamingAppend(chunk.content);
          opts?.onContent?.(accumulated);
        }
        if (chunk.conversationId) {
          setConversationId(chunk.conversationId);
        }
        if (chunk.final && chunk.sources) {
          finalSources = chunk.sources;
        }
        // Improve route (#704): capture the original markdown baseline so the
        // diff compares like-for-like markdown instead of stripped bodyText.
        // Use !== undefined (not truthiness) so an intentionally empty baseline
        // (empty page → htmlToMarkdown('') === '') is preserved rather than
        // falling back to the also-empty bodyText.
        if (chunk.originalMarkdown !== undefined) {
          originalMarkdown = chunk.originalMarkdown;
        }
      }
      if (streamError) {
        // In-band SSE error events (HTTP 200 already established — the common
        // mid-stream provider failure) get the same inline treatment as thrown
        // errors, plus the toast that non-403 throws keep.
        toast.error(streamError);
        failLastMessage(streamError);
        return;
      }
      commitToMessages();
      opts?.onComplete?.(
        accumulated,
        finalSources.length > 0 ? finalSources : undefined,
        originalMarkdown !== undefined ? { originalMarkdown } : undefined,
      );
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        // Keep whatever was streamed before the abort (matches the previous
        // per-chunk-commit behavior).
        commitToMessages();
        return;
      }
      // Surface the failure INLINE: replace the placeholder assistant message
      // with an error message instead of silently removing it (the user
      // previously saw a bubble appear and then vanish with no explanation).
      const isForbidden = err instanceof ApiError && err.statusCode === 403;
      // The backend's 403 body names the exact missing permission (each
      // streamed mode has its own: llm:query, llm:improve, llm:generate,
      // llm:summarize) — pass it through instead of hardcoding one.
      const friendly = isForbidden
        ? `You don't have permission to use this AI feature (${err.message || 'permission denied'}). Ask an administrator to assign you a role that includes it.`
        : err instanceof Error ? err.message : 'Request failed';
      // 403 is fully explained inline — keep the toast only for other errors.
      if (!isForbidden) toast.error(friendly);
      failLastMessage(friendly);
    } finally {
      streamingFinish();
      isStreamingRef.current = false;
      setIsStreaming(false);
      setIsThinking(false);
    }
  }, [streamingStart, streamingAppend, streamingReplace, streamingFinish]);

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
    modelsError: modelsQuery.isError,
    refetchModels: modelsQuery.refetch,
    input,
    setInput,
    isStreaming,
    setIsStreaming,
    streamingContent: streamingDisplayContent,
    isThinking,
    setIsThinking,
    thinkingElapsed,
    abortRef,
    messagesEndRef,
    includeSubPages,
    setIncludeSubPages,
    thinkingMode,
    setThinkingMode: handleSetThinkingMode,
    isPageLoading,
    embeddingStatus,
    isLight,
    improvementType,
    setImprovementType,
    showDiffView,
    setShowDiffView,
    improvedContent,
    setImprovedContent,
    originalMarkdown,
    setOriginalMarkdown,
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
