/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useState, useRef, useEffect, useCallback, type ReactNode } from 'react';
import { useSearchParams, useNavigate, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { UsecaseDefault } from '@compendiq/contracts';
import { apiFetch, ApiError } from '../../shared/lib/api';
import { streamSSE } from '../../shared/lib/sse';
import { usePage, useEmbeddingStatus, type EmbeddingStatusData } from '../../shared/hooks/use-pages';
import { DEFAULT_IMPROVEMENT_TYPE, type ImprovementType } from './improvement-types';
import { type CreateSkillId } from './create-skills';
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
  /**
   * True when this assistant turn is the #1105 low-confidence refusal: the
   * backend measured retrieval below the operator's threshold, ran no chat
   * completion, and returned an honest "I am not answering" turn plus the weak
   * sources it did find.
   *
   * Deliberately NOT `isError`. The request succeeded; the server declined to
   * guess, which is the correct outcome. Both renderers key a distinct, neutral
   * state on this — see `refusal.tsx` for the colour argument.
   */
  isRefusal?: boolean;
}

interface Conversation {
  id: string;
  title: string;
  model: string;
  createdAt: string;
}

export type Mode = 'ask' | 'improve' | 'generate' | 'diagram';

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
  /**
   * #1154: whether the resolved chat model accepts images. `null` means
   * capability is not established — not probed yet, or probed inconclusively —
   * which the composer renders differently from `false`. The chat use-case
   * default query below has always fetched this and discarded it.
   */
  chatVision: boolean | null;
  /**
   * #1154: the model `chatVision` is about, i.e. the chat use-case default.
   *
   * Distinct from `model`, and they diverge: `model` is what `/ai`'s dropdown
   * has selected, while `/llm/generate` and `/llm/improve` both gate images on
   * `resolveUsecase('chat')` and ignore the body's `model` outright. Copy that
   * explains a refusal has to name this one, or it attributes the server's
   * verdict to a model the verdict is not about.
   *
   * `''` until the query resolves, exactly like `model`.
   */
  chatVisionModel: string;

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
  /**
   * Which of the five passes `/llm/improve` will be asked for. Typed by the
   * contract's own enum (#1177) rather than `string`, so no picker can offer —
   * and no caller pass — a value the endpoint would reject with a 400.
   *
   * Deliberately session state rather than a persisted preference: it belongs
   * to the document in front of you, not to you. One page wants its structure
   * reworked and the next wants a spell-check, so a value that survived a
   * reload would be wrong more often than right. Both surfaces that set it show
   * what is selected before it runs — `/ai`'s selector inline, the dock's chip
   * in its own label — so the session lifetime is never a hidden one.
   */
  improvementType: ImprovementType;
  setImprovementType: (v: ImprovementType) => void;
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
  /** `page.version` the pending improvement was produced from — see `AiThread`. */
  diffBaseVersion: number | null;
  setDiffBaseVersion: (v: number | null) => void;

  // Create skill / generate state
  createSkill: CreateSkillId;
  setCreateSkill: (v: CreateSkillId) => void;
  generatedDraft: string;
  setGeneratedDraft: (v: string) => void;

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
      onError?: (err: unknown) => boolean;
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
  /**
   * Ask route (#1105): this turn is the low-confidence refusal, not an answer.
   * Carried on the final frame beside `sources`, which on this path are the
   * closest partial matches the gate declined to use.
   */
  refused?: boolean;
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
  /**
   * `page.version` at the moment the pending improvement was produced (#1126).
   * The dock compares it against the live version to detect that the document
   * moved under an un-applied diff, which is the difference between offering a
   * re-run and silently overwriting someone else's edit.
   */
  diffBaseVersion: number | null;
  generatedDraft: string;
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
  diffBaseVersion: null,
  generatedDraft: '',
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

const VALID_MODES: Mode[] = ['ask', 'improve', 'generate', 'diagram'];

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
  // A page context is still an input to Q&A, so it remains the honest default.
  // An explicit valid `?mode=` can deep-link to another selectable action;
  // retired Summarize and Quality values deliberately fall back to Q&A.
  const [mode, setMode] = useState<Mode>(urlMode ?? 'ask');
  // Conversations keyed by page and retained (#1126). Changing pages swaps
  // which thread is on screen; it never destroys one.
  const threadKey = threadKeyFor(pageId);
  const [threads, setThreads] = useState<Map<string, AiThread>>(() => new Map());
  const {
    messages, conversationId, input, showDiffView,
    improvedContent, originalMarkdown, layoutTokensLost, diagramCode, diffBaseVersion,
    generatedDraft,
  } = threads.get(threadKey) ?? EMPTY_THREAD;
  const [createSkill, setCreateSkill] = useState<CreateSkillId>('spec');
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
  const [improvementType, setImprovementType] = useState<ImprovementType>(DEFAULT_IMPROVEMENT_TYPE);
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
  const setDiffBaseVersion = useCallback(
    (v: number | null) => updateThread(threadKey, () => ({ diffBaseVersion: v })),
    [threadKey, updateThread],
  );
  const setGeneratedDraft = useCallback(
    (v: string) => updateThread(threadKey, () => ({ generatedDraft: v })),
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
  // once from the URL at mount. Re-apply the URL's mode whenever its mode/page
  // inputs change — that is what navigations like /ai?mode=improve&pageId=…
  // relied on when entering the route still remounted the provider.
  //
  // A navigation carrying NO explicit mode resets to Ask rather than leaving
  // the previous one in place (#1126). `/ai` offers Ask and Generate only now,
  // so a sticky `improve` — arrived at by deep link, then carried to a plain
  // `/ai` — would render a document screen with no tab selected and no route
  // back except the URL bar. Absent an explicit mode, the mode is Ask.
  const urlModeSignature = `${rawMode ?? ''}|${pageId ?? ''}`;
  const appliedModeSignatureRef = useRef(urlModeSignature);
  useEffect(() => {
    if (appliedModeSignatureRef.current === urlModeSignature) return;
    appliedModeSignatureRef.current = urlModeSignature;
    setMode(urlMode ?? 'ask');
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
    // #1361 PR 1: the list endpoint now returns { items, nextCursor }; this
    // mirror is deleted in PR 2 (the pane owns the query). Tolerate both.
    queryFn: async () => {
      const r = await apiFetch<Conversation[] | { items: Conversation[] }>('/llm/conversations');
      return Array.isArray(r) ? r : r.items;
    },
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
      // `refused` is what `saveConversation` writes onto a #1105 refusal turn
      // (llm-ask.ts `StoredChatMessage`), and the route returns the messages
      // JSONB verbatim — so reopening a thread must carry the marker across or
      // the refusal silently downgrades to an ordinary answer on reload, which
      // is precisely the state #1119 exists to stop rendering.
      // Since #1361 the persisted turn carries its `sources` (the chip
      // allow-list) — the mapping below reads them; the persisted PROSE still
      // omits the "closest matches attached" sentence, so a reloaded refusal
      // never names a list it does not show.
      const conv = await apiFetch<{ messages: Array<{ role: string; content: string; sources?: Source[]; refused?: boolean }>; model: string; id: string }>(`/llm/conversations/${id}`);
      updateThread(threadKey, () => ({
        messages: conv.messages
          .filter((m) => m.role !== 'system')
          .map((m) => ({
            id: nextMessageId(),
            role: m.role as 'user' | 'assistant',
            content: m.content,
            sources: m.sources,
            ...(m.refused === true ? { isRefusal: true } : {}),
          })),
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
      /**
       * First refusal on a thrown request error (#1154).
       *
       * This exists because runStream **never rethrows**: it catches
       * everything and renders it inline, so a caller that must *undo*
       * something on a specific status — Generate rolling back a lapsed image
       * handle on a 410 — otherwise has no way to see the error at all. A
       * `try`/`catch` around `await runStream(...)` is dead code.
       *
       * Return `false` (or nothing) for anything you did not handle and the
       * existing behaviour applies unchanged, which is why every current caller
       * can omit this prop entirely.
       *
       * **Returning `true` claims the error and rolls the send back.** runStream
       * skips both its toast and `failLastMessage`, because you have already
       * explained the failure in context, and then removes **both messages it
       * added itself**:
       *
       * - the `userMessage` turn, when you passed one (Improve, Summarize,
       *   Quality and Diagram all do);
       * - the placeholder assistant message.
       *
       * Both are removed here rather than by you because neither id leaves this
       * function. And both must go: `failLastMessage` is what normally turns
       * the placeholder into the visible error bubble, so skipping it would
       * otherwise strand an empty bubble — which reads as "the model returned
       * nothing" rather than "something went wrong" — and dropping only the
       * placeholder would strand the seeded turn above it with nothing under
       * it, the same defect one row up.
       *
       * **What is still yours to undo:** a user turn you appended *yourself*
       * before calling (Generate does this, so it removes its own), the input
       * you cleared, and any attachment state the request consumed. See
       * `GenerateMode.tsx`'s 410 branch for the shape.
       *
       * Two traps:
       * - Your `setMessages` calls must use the **functional** form. A stale
       *   closure over `messages` will resurrect the very rows removed here.
       * - This runs inside runStream's `catch`, so an exception thrown from
       *   here **escapes runStream** and rejects the returned promise. Do not
       *   let it throw; the `finally` still runs, but nothing else does.
       */
      onError?: (err: unknown) => boolean;
      userMessage?: string;
    },
  ) => {
    if (isStreamingRef.current) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    // Append, never replace (#1126). This used to be `setMessages([...])`, which
    // meant every mode that seeds its own turn — Improve, Summarize, Diagram,
    // Quality — silently wiped the thread it was added to. That was survivable
    // while each of those was a *mode* you switched into (the switch felt like a
    // reset anyway); it is not survivable now that all four are chips seeding one
    // continuous conversation in the dock. Ask already appended (AskMode:83).
    // The id is allocated here rather than inside the updater so `onError` can
    // withdraw this turn: a caller never sees it and so could not remove it
    // itself. Eager allocation also makes the id stable if React invokes the
    // updater more than once, which matches `assistantMsgId` below.
    const seededUserMessage = opts?.userMessage;
    const seededUserMsgId = seededUserMessage ? nextMessageId() : null;
    if (seededUserMessage && seededUserMsgId) {
      setMessages((prev) => [...prev, { id: seededUserMsgId, role: 'user', content: seededUserMessage }]);
    }

    opts?.onBeforeStream?.();
    isStreamingRef.current = true;
    setIsStreaming(true);
    setIsThinking(true);

    let accumulated = '';
    let finalSources: Source[] = [];
    let originalMarkdown: string | undefined;
    let streamLayoutTokensLost: boolean | undefined;
    // #1119: the #1105 refusal verdict, read off the final frame. Local rather
    // than state because it is committed with the content in one update below.
    let refusedTurn = false;

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
            ...(refusedTurn ? { isRefusal: true } : {}),
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
        // #1119: the #1105 refusal marker rides the same final frame as
        // `sources`, and is read the same way. Only ever set true here — a
        // later frame cannot un-refuse a turn, and the refusal path emits
        // exactly one final frame anyway.
        if (chunk.final && chunk.refused === true) {
          refusedTurn = true;
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
      // The caller may claim the error (#1154). It has then already told the
      // user what happened, so both messages runStream added are withdrawn
      // rather than turned into a second, redundant explanation: the seeded
      // user turn and the placeholder that would otherwise sit under it empty.
      // `seededUserMsgId` is null when the caller seeded its own turn, and no
      // message carries a null id, so that case filters nothing.
      if (opts?.onError?.(err)) {
        setMessages((prev) => prev.filter(
          (m) => m.id !== assistantMsgId && m.id !== seededUserMsgId,
        ));
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
    chatVision: chatDefault?.vision ?? null,
    chatVisionModel: chatDefault?.model ?? '',
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
    diffBaseVersion,
    setDiffBaseVersion,
    createSkill,
    setCreateSkill,
    generatedDraft,
    setGeneratedDraft,
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
