/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useState, useRef, useEffect, useCallback, type ReactNode } from 'react';
import { useSearchParams, useNavigate, useLocation } from 'react-router-dom';
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
  /**
   * Registers the calling component as an active AI consumer. `useAiContext`
   * calls this for you; nothing else should. See `retainAi` in the provider
   * for why the provider stays inert until someone does.
   */
  retainAi: () => () => void;

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
  /**
   * Backend verdict from the Improve stream's final event: the output lost
   * the page's layout boundary tokens beyond recovery. Authoritative over
   * any client-side token heuristic; undefined when the stream ended without
   * a final event (abort) — callers fall back to their own check then.
   */
  layoutTokensLost: boolean | undefined;
  setLayoutTokensLost: (v: boolean | undefined) => void;

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
  /** Improve route: backend verdict that the output lost the layout tokens beyond recovery. */
  layoutTokensLost?: boolean;
}

/** Extra, non-content metadata surfaced to `onComplete` once a stream finishes. */
export interface StreamMeta {
  /** Improve route (#704): markdown baseline for like-for-like diffing. */
  originalMarkdown?: string;
  /** Improve route: backend verdict that the output lost the layout tokens beyond recovery. */
  layoutTokensLost?: boolean;
}

const AiCtx = createContext<AiContextValue | null>(null);

export function useAiContext(): AiContextValue {
  const ctx = useContext(AiCtx);
  // Registering as a consumer is what wakes the provider up. AiProvider mounts
  // in AppLayout — i.e. on every route — so it must not fetch models,
  // conversations, embedding status or the context page on routes where no AI
  // surface is on screen. The hooks run unconditionally (before the throw) so
  // the hook order is stable for every component that consumes the context.
  const retainAi = ctx?.retainAi;
  useEffect(() => retainAi?.(), [retainAi]);
  if (!ctx) throw new Error('useAiContext must be used within AiProvider');
  return ctx;
}

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

/**
 * The slice of provider state that belongs to one conversation. Everything in
 * here is swapped when the AI context page changes; everything outside it
 * (mode, model, thinking mode, improvement / diagram type) is a preference
 * that follows the user across pages.
 */
interface AiThread {
  messages: Message[];
  conversationId: string | null;
  input: string;
  showDiffView: boolean;
  improvedContent: string;
  originalMarkdown: string;
  layoutTokensLost: boolean | undefined;
  diagramCode: string;
}

const EMPTY_THREAD: AiThread = {
  messages: [],
  conversationId: null,
  input: '',
  showDiffView: false,
  improvedContent: '',
  originalMarkdown: '',
  layoutTokensLost: undefined,
  diagramCode: '',
};

/**
 * Thread key for the no-document case (`/ai` with no page context). The
 * `page:` prefix on every real key makes a collision with a page id — even a
 * page literally called `no-page` — impossible.
 */
const NO_PAGE_THREAD_KEY = 'no-page';

function threadKeyFor(pageId: string | null): string {
  return pageId ? `page:${pageId}` : NO_PAGE_THREAD_KEY;
}

/**
 * Cap on retained threads. Threads live in memory for the whole session now
 * that the provider outlives the route, so an uncapped map would grow without
 * bound as a user walks the page tree. Eviction is least-recently-used, and
 * the active thread is by construction the most recently used one, so it can
 * never be evicted. Losing an evicted thread is cheap: anything with a
 * `conversationId` is also persisted server-side and can be reopened from the
 * conversation list.
 */
const MAX_RETAINED_THREADS = 12;

/**
 * Apply `patch` to one thread and mark it most-recently-used. A Map iterates
 * in insertion order, so delete-then-set moves the touched key to the end and
 * the first key is always the least recently used thread.
 */
function touchThread(
  threads: Map<string, AiThread>,
  key: string,
  patch: (thread: AiThread) => Partial<AiThread>,
): Map<string, AiThread> {
  const current = threads.get(key) ?? EMPTY_THREAD;
  const next = new Map(threads);
  next.delete(key);
  next.set(key, { ...current, ...patch(current) });
  while (next.size > MAX_RETAINED_THREADS) {
    const oldest = next.keys().next().value;
    if (oldest === undefined) break;
    next.delete(oldest);
  }
  return next;
}

const ARTICLE_ROUTE = /^\/pages\/([^/]+)$/;

/**
 * Resolve which page the assistant is talking about. `?pageId=` is one *input*
 * to this, not the definition of it: on an article route the open document is
 * the context, which is what lets a thread follow the page being read. An
 * explicit `?pageId=` still wins, so `/ai?pageId=…` keeps working unchanged.
 */
export function resolveAiPageId(pathname: string, searchParams: URLSearchParams): string | null {
  const explicit = searchParams.get('pageId');
  if (explicit) return explicit;
  const routeId = ARTICLE_ROUTE.exec(pathname)?.[1];
  // /pages/new is the create route, not a document.
  return routeId && routeId !== 'new' ? routeId : null;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

const VALID_MODES: Mode[] = ['ask', 'improve', 'generate', 'summarize', 'diagram', 'quality'];

export function AiProvider({ children }: { children: ReactNode }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const pageId = resolveAiPageId(location.pathname, searchParams);
  const isLight = useIsLightTheme();

  // Consumer registration (see `useAiContext`). The count lives in a ref so
  // mount/unmount churn is cheap; the boolean is state because the queries
  // below have to re-run when it flips.
  const consumerCountRef = useRef(0);
  const [hasConsumers, setHasConsumers] = useState(false);
  const retainAi = useCallback(() => {
    consumerCountRef.current += 1;
    setHasConsumers(true);
    return () => {
      consumerCountRef.current -= 1;
      if (consumerCountRef.current === 0) setHasConsumers(false);
    };
  }, []);

  const rawMode = searchParams.get('mode');
  const urlMode = VALID_MODES.includes(rawMode as Mode) ? (rawMode as Mode) : null;
  const [mode, setMode] = useState<Mode>(urlMode ?? (pageId ? 'improve' : 'ask'));
  // Conversations keyed by page and retained (#1126). Changing pages swaps
  // which thread is on screen; it never destroys one.
  const threadKey = threadKeyFor(pageId);
  const [threads, setThreads] = useState<Map<string, AiThread>>(() => new Map());
  const {
    messages, conversationId, input, showDiffView,
    improvedContent, originalMarkdown, layoutTokensLost, diagramCode,
  } = threads.get(threadKey) ?? EMPTY_THREAD;
  const [isStreaming, setIsStreaming] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [thinkingElapsed, setThinkingElapsed] = useState(false);
  const thinkingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [model, setModel] = useState('');
  const [includeSubPages, setIncludeSubPages] = useState(false);
  const [thinkingMode, setThinkingModeState] = useState(() => localStorage.getItem('ai-thinking-mode') === 'true');
  const handleSetThinkingMode = useCallback((v: boolean) => {
    setThinkingModeState(v);
    localStorage.setItem('ai-thinking-mode', String(v));
  }, []);
  const [improvementType, setImprovementType] = useState('grammar');
  const [diagramType, setDiagramType] = useState('flowchart');
  const [isInsertingDiagram, setIsInsertingDiagram] = useState(false);

  // Writers for the active thread. Each is bound to the thread key of the
  // render that produced it, so a handler captured before a page change (most
  // importantly runStream's) keeps writing into the thread it started in.
  const updateThread = useCallback(
    (key: string, patch: (thread: AiThread) => Partial<AiThread>) => {
      setThreads((prev) => touchThread(prev, key, patch));
    },
    [],
  );
  const setMessages = useCallback<React.Dispatch<React.SetStateAction<Message[]>>>(
    (action) =>
      updateThread(threadKey, (t) => ({
        messages: typeof action === 'function' ? action(t.messages) : action,
      })),
    [threadKey, updateThread],
  );
  const setConversationId = useCallback(
    (id: string | null) => updateThread(threadKey, () => ({ conversationId: id })),
    [threadKey, updateThread],
  );
  const setInput = useCallback(
    (v: string) => updateThread(threadKey, () => ({ input: v })),
    [threadKey, updateThread],
  );
  const setShowDiffView = useCallback(
    (v: boolean) => updateThread(threadKey, () => ({ showDiffView: v })),
    [threadKey, updateThread],
  );
  const setImprovedContent = useCallback(
    (v: string) => updateThread(threadKey, () => ({ improvedContent: v })),
    [threadKey, updateThread],
  );
  const setOriginalMarkdown = useCallback(
    (v: string) => updateThread(threadKey, () => ({ originalMarkdown: v })),
    [threadKey, updateThread],
  );
  const setLayoutTokensLost = useCallback(
    (v: boolean | undefined) => updateThread(threadKey, () => ({ layoutTokensLost: v })),
    [threadKey, updateThread],
  );
  const setDiagramCode = useCallback(
    (v: string) => updateThread(threadKey, () => ({ diagramCode: v })),
    [threadKey, updateThread],
  );

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
  const { data: page, isLoading: isPageLoading } = usePage(hasConsumers ? pageId ?? undefined : undefined);
  const { data: embeddingStatus } = useEmbeddingStatus(hasConsumers);
  const pageHasChildren = page?.hasChildren ?? false;

  // Abort any in-flight stream on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  // Changing the AI context page swaps threads (#1126) — it no longer clears
  // messages, conversation id or diff/diagram state, which is what silently
  // discarded an in-progress conversation on a sidebar click. The one thing a
  // switch still does is stop an in-flight stream; its partial answer is
  // committed to the thread that started it, not to the one being switched to,
  // because runStream captured that thread's writers.
  const prevThreadKeyRef = useRef(threadKey);
  useEffect(() => {
    if (threadKey === prevThreadKeyRef.current) return;
    prevThreadKeyRef.current = threadKey;
    abortRef.current?.abort();
  }, [threadKey]);

  // The provider now outlives the /ai route, so `mode` can no longer be seeded
  // once from the URL at mount. Re-apply an explicit `?mode=` whenever the
  // URL's mode/page inputs change — that is what navigations like
  // /ai?mode=improve&pageId=… (the article rail's "AI Improve" button) relied
  // on when entering the route still remounted the provider. Only an explicit
  // mode is applied: inferring one from the page would flip the mode under a
  // user who is merely browsing articles.
  const urlModeSignature = `${rawMode ?? ''}|${pageId ?? ''}`;
  const appliedModeSignatureRef = useRef(urlModeSignature);
  useEffect(() => {
    if (appliedModeSignatureRef.current === urlModeSignature) return;
    appliedModeSignatureRef.current = urlModeSignature;
    if (urlMode) setMode(urlMode);
  }, [urlModeSignature, urlMode]);

  // Prefill the composer from the ?q param so a question typed in the command
  // palette's AI mode isn't dropped on navigation (#957). Reactive (not a mount
  // initializer) so it also works when /ai is already mounted and only the
  // search params change. The param is consumed — removed from the URL with a
  // replace navigation — so refresh/back doesn't re-prefill an asked question.
  //
  // Scoped to /ai, which is the only route CommandPalette ever puts ?q= on
  // (CommandPalette.tsx:134). The provider mounts app-wide now, so without the
  // guard it would claim `q` from ANY route carrying it — silently rewriting
  // that page's URL and stuffing its search term into the AI composer.
  const isAiRoute = location.pathname === '/ai';
  const urlQuestion = isAiRoute ? searchParams.get('q') : null;
  useEffect(() => {
    if (urlQuestion === null) return;
    if (urlQuestion) setInput(urlQuestion);
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('q');
        return next;
      },
      { replace: true },
    );
  }, [urlQuestion, setSearchParams, setInput]);

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

  // Load models and conversations once an AI surface is actually mounted.
  // These were mount-time fetches when the provider only existed on /ai; it
  // now mounts app-wide, so every one of them is gated on `hasConsumers`.
  // #355: prefer the admin-configured chat use-case default (resolveUsecase
  // 'chat'); when the chat use-case isn't configured we fall through to the
  // first available model (see modelsQuery below) so the input never shows
  // empty.
  //
  // Refactored to TanStack Query (Finding 1, AC-3) so admin-side changes to
  // the chat use-case assignment propagate to the chat UI without a hard
  // reload. LlmTab's save handler invalidates ['llm', 'usecase-default'] and
  // ['llm', 'models'], which causes these queries to refetch automatically.
  const chatDefaultQuery = useQuery<UsecaseDefault>({
    queryKey: ['llm', 'usecase-default', 'chat'],
    queryFn: () => apiFetch<UsecaseDefault>('/llm/usecase-default?usecase=chat'),
    // Returns 404 when no provider is configured for chat — that's a legitimate
    // "no default" signal that we should fall through to the models list; do
    // not retry it as an error.
    retry: false,
    staleTime: 30_000,
    enabled: hasConsumers,
  });
  const chatDefault = chatDefaultQuery.data;

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
    enabled: hasConsumers,
  });
  const models = modelsQuery.data ?? [];

  const conversationsQuery = useQuery<Conversation[]>({
    queryKey: ['llm', 'conversations'],
    queryFn: () => apiFetch<Conversation[]>('/llm/conversations'),
    retry: false,
    staleTime: 30_000,
    enabled: hasConsumers,
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
    const modelsList = modelsQuery.data;
    if (modelsList && modelsList.length > 0) {
      setModel((prev) => prev || (modelsList[0]?.name ?? ''));
      modelInitializedRef.current = true;
    }
  }, [chatDefault, modelsQuery.data]);

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

  // Deliberate reset of the *active* thread. Threads are no longer discarded
  // by navigation (#1126), so this is the one way a user clears one — other
  // pages' threads are untouched.
  const startNewConversation = useCallback(() => {
    updateThread(threadKey, () => ({ messages: [], conversationId: null, input: '' }));
    // #355 (Finding 2, AC-4): reset the model selector to the current chat
    // default so a per-conversation override (set via loadConversation or the
    // dropdown) doesn't leak into newly-started conversations. We read from
    // the live TanStack Query result so admin-side changes are picked up
    // without remounting.
    if (chatDefault?.model) {
      setModel(chatDefault.model);
    }
  }, [chatDefault, threadKey, updateThread]);

  const loadConversation = useCallback(async (id: string) => {
    try {
      const conv = await apiFetch<{ messages: Array<{ role: string; content: string; sources?: Source[] }>; model: string; id: string }>(`/llm/conversations/${id}`);
      updateThread(threadKey, () => ({
        messages: conv.messages
          .filter((m) => m.role !== 'system')
          .map((m) => ({ id: nextMessageId(), role: m.role as 'user' | 'assistant', content: m.content, sources: m.sources })),
        conversationId: conv.id,
      }));
      setModel(conv.model);
      setMode('ask');
    } catch {
      toast.error('Failed to load conversation');
    }
  }, [threadKey, updateThread]);

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
   *
   * `setMessages` / `setConversationId` are the *active thread's* writers, so a
   * call that started before a page change keeps writing into the thread that
   * asked the question — including the partial answer committed on abort.
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
    let streamLayoutTokensLost: boolean | undefined;

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
        if (chunk.layoutTokensLost !== undefined) {
          streamLayoutTokensLost = chunk.layoutTokensLost;
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
        originalMarkdown !== undefined || streamLayoutTokensLost !== undefined
          ? { originalMarkdown, layoutTokensLost: streamLayoutTokensLost }
          : undefined,
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
  }, [streamingStart, streamingAppend, streamingReplace, streamingFinish, setMessages, setConversationId]);

  const value: AiContextValue = {
    retainAi,
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
    layoutTokensLost,
    setLayoutTokensLost,
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
