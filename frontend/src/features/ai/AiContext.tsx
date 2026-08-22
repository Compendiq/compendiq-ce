/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useState, useRef, useEffect, useMemo, useCallback, type ReactNode } from 'react';
import { useSearchParams, useNavigate, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { UsecaseDefault } from '@compendiq/contracts';
import { apiFetch, ApiError } from '../../shared/lib/api';
import { streamSSE } from '../../shared/lib/sse';
import { AI_HOME_PATH, isAiRoute, conversationIdFromPath } from '../../shared/lib/ai-routes';
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
  /**
   * Identity of the thread on screen, as a string (#1361). Opaque — only
   * equality is meaningful. Every switch-sensitive effect keys on it: the
   * abort-on-switch effect, `DeepSearchToggle`, `AssistantAttachmentsScope`,
   * and the Ask composer's `externalUrls`.
   */
  activeThreadId: string;
  startNewConversation: () => void;
  /**
   * Bumped by `startNewConversation`. The composer focuses its textarea
   * whenever this changes — a counter rather than a boolean, because two New
   * chats in a row have to be two focus requests.
   */
  composerFocusRequest: number;

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
   * Identity of the thread whose answer is streaming, or null (#1361).
   * `isStreaming` is provider-wide; the two renderers gate "this bubble is the
   * in-flight answer" on `streamingThreadId === activeThreadId` so a stream on
   * one thread cannot repaint another thread's last answer.
   */
  streamingThreadId: string | null;
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
  /**
   * Stamped when the thread is FILED (#1361), never by a write.
   *
   * Keys move — the first answer on a draft re-keys it to `conv:<id>` — so a
   * stream writer bound to a key would either miss its own thread after the
   * re-key or, worse, land an orphan turn in whatever now sits under the old
   * key. Writers bind to this instead: a re-key is followed for free, and a
   * thread that has since been REPLACED (New chat while its stream was
   * running) simply is not found, so the write drops.
   */
  identity: number;
  /** `conv:` hydration only; `'ready'` for `draft` and `page:` threads. */
  loadState: 'ready' | 'loading' | 'error';
  loadError: string | null;
  /** Last final frame, or `GET /llm/conversations/:id` on reopen (decision 10). */
  historyTruncated: boolean;
}

/**
 * A TEMPLATE, not an entry. `identity: 0` is never observed on a filed thread —
 * identities start at 1 — so a writer that finds 0 has found nothing.
 */
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
  identity: 0,
  loadState: 'ready',
  loadError: null,
  historyTruncated: false,
};

let threadIdentityCounter = 0;
/** Module counter, starting at 1. Opaque: only equality is ever read. */
function nextIdentity(): number {
  return ++threadIdentityCounter;
}

/**
 * One function knows what an unfiled thread looks like, so the answer is the
 * same whichever of its three callers runs first: the read path, `touchThread`
 * when a write arrives for a missing key, and provider init for `draft`.
 *
 * The `conv:` seed is the load-bearing half. The read path yields it on the
 * FIRST render of `/ai/c/X`, so that render shows *Loading conversation…* and
 * never the Ask empty state; and a write arriving before the filing effect —
 * the widened `/ai/c/X?q=` prefill is exactly such a write — files `'loading'`
 * rather than a `'ready'` thread that hydration would then skip for good.
 *
 * Identity is deliberately NOT stamped here: the filer stamps it, because
 * filing is what creates an entry and `seedFor` is also used to READ one that
 * does not exist yet.
 */
function seedFor(key: string): AiThread {
  return { ...EMPTY_THREAD, loadState: key.startsWith('conv:') ? 'loading' : 'ready' };
}

const ARTICLE_ROUTE = /^\/pages\/([^/]+)$/;

/**
 * Where the thread on screen comes from (#1361). The location, not a page id:
 *
 *   /ai            -> 'draft'      (exactly one, filed at provider init)
 *   /ai/c/<id>     -> 'conv:<id>'  (filed on activation, hydrated into)
 *   /pages/:id     -> 'page:<id>'  (the dock, unchanged)
 *
 * Everything else gets the draft. `?pageId=` selects no thread any more — an AI
 * route has no document (`resolveAiPageId`), and the three producers of
 * `/ai?pageId=` go with the page tree. The `conv:` / `page:` prefixes are what
 * make a collision with a page or conversation literally called `draft`
 * impossible.
 */
type ThreadKey = 'draft' | `conv:${string}` | `page:${string}`;

function threadKeyFor(pathname: string): ThreadKey {
  const conversationId = conversationIdFromPath(pathname);
  if (conversationId) return `conv:${conversationId}`;
  if (isAiRoute(pathname)) return 'draft';
  const routeId = ARTICLE_ROUTE.exec(pathname)?.[1];
  // /pages/new is the create route, not a document.
  return routeId && routeId !== 'new' ? `page:${routeId}` : 'draft';
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

/** LRU eviction, shared by the two writers below. */
function evictOldest(next: Map<string, AiThread>): Map<string, AiThread> {
  while (next.size > MAX_RETAINED_THREADS) {
    const oldest = next.keys().next().value;
    if (oldest === undefined) break;
    next.delete(oldest);
  }
  return next;
}

/**
 * File a FRESH thread under `key`, replacing whatever was there, and stamp a
 * new identity. This is the only way an entry is created (provider init, the
 * filing effect, New chat) — and stamping here is what makes New chat's
 * "new -> new" case work: the old object is gone, so a stream still writing
 * into it drops rather than landing in the fresh draft.
 */
function fileThread(threads: Map<string, AiThread>, key: string): Map<string, AiThread> {
  const next = new Map(threads);
  next.delete(key);
  next.set(key, { ...seedFor(key), identity: nextIdentity() });
  return evictOldest(next);
}

/**
 * Apply `patch` to one thread and mark it most-recently-used. A Map iterates
 * in insertion order, so delete-then-set moves the touched key to the end and
 * the first key is always the least recently used thread.
 *
 * A write is NOT a filing (#1361). A missing key is filed through `seedFor` +
 * `nextIdentity()` — `EMPTY_THREAD` was wrong here, because it would file a
 * `conv:` thread as `'ready'` and silently suppress its hydration — and an
 * existing entry KEEPS its identity: the patch's `identity` is re-pinned after
 * the spread, so no writer can renumber the thread its own stream is bound to.
 */
function touchThread(
  threads: Map<string, AiThread>,
  key: string,
  patch: (thread: AiThread) => Partial<AiThread>,
): Map<string, AiThread> {
  const base = threads.get(key) ?? { ...seedFor(key), identity: nextIdentity() };
  const next = new Map(threads);
  next.delete(key);
  next.set(key, { ...base, ...patch(base), identity: base.identity });
  return evictOldest(next);
}

/**
 * The key a given identity currently sits under, or undefined if the thread is
 * gone. A ≤ 12-entry scan: `MAX_RETAINED_THREADS` is the whole map, so an index
 * would be a second thing to keep in step for no measurable gain.
 */
function findThreadKeyByIdentity(
  threads: Map<string, AiThread>,
  identity: number,
): string | undefined {
  for (const [key, thread] of threads) {
    if (thread.identity === identity) return key;
  }
  return undefined;
}

/**
 * Resolve which page the assistant is talking about — the dock's context, and
 * nothing else since #1361.
 *
 * An AI route has no document. `/ai` and `/ai/c/:id` are conversation routes:
 * the left rail there lists conversations, not pages, so nothing can set a page
 * context and nothing would clear one. A legacy `/ai?pageId=…` bookmark
 * therefore opens a plain new chat rather than silently scoping answers to a
 * page the UI does not mention — which is the state the context chip existed to
 * paper over. Off the AI routes an explicit `?pageId=` still wins over the
 * article route, which is what lets a thread follow the page being read.
 */
export function resolveAiPageId(pathname: string, searchParams: URLSearchParams): string | null {
  if (isAiRoute(pathname)) return null;
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
  // Threads keyed by LOCATION and retained (#1126, re-keyed in #1361). Changing
  // where you are swaps which thread is on screen; it never destroys one.
  const threadKey = threadKeyFor(location.pathname);
  // The draft is filed at init, so `/ai` never renders an unfiled active key.
  const [threads, setThreads] = useState<Map<string, AiThread>>(() => fileThread(new Map(), 'draft'));
  // Memoised because `seedFor` builds a new object per call: an inline
  // `?? seedFor(key)` would hand a fresh `messages: []` to the auto-scroll
  // effect on every render of a not-yet-filed thread.
  const activeThread = useMemo(() => threads.get(threadKey) ?? seedFor(threadKey), [threads, threadKey]);
  const {
    messages, conversationId, input, showDiffView,
    improvedContent, originalMarkdown, layoutTokensLost, diagramCode, diffBaseVersion,
    generatedDraft,
  } = activeThread;
  /**
   * The one thing every switch-sensitive effect keys on (#1361): the filed
   * identity, or the bare key for the one render before the entry is filed (so
   * two unfiled keys still differ). It changes on every switch — open, New
   * chat, dock page change, delete-of-active — and on nothing else: not on a
   * keystroke, not on a `?q=` prefill, not while streaming, and not on the
   * promotion re-key, which moves the same object.
   */
  const activeThreadId = String(threads.get(threadKey)?.identity ?? threadKey);
  const [composerFocusRequest, setComposerFocusRequest] = useState(0);

  // File the active key if it is absent. On STATE, not on presence: this is
  // what stamps the identity, and the hydration effect (which keys on
  // `loadState`) needs the entry to exist with the seed `seedFor` chose. The
  // key -> identity transition therefore happens exactly once, at activation,
  // within the first effect flush — before a person can type.
  useEffect(() => {
    setThreads((prev) => (prev.has(threadKey) ? prev : fileThread(prev, threadKey)));
  }, [threadKey]);
  // Through refs so `runStream` can read the map and the active key at CALL
  // time without taking `threads` as a dependency — which would rebuild it, and
  // every composer handler that depends on it, on each keystroke. Same pattern
  // and same reason as `EmbeddingShadowMigrationCard.tsx:89-90`.
  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  const threadKeyRef = useRef(threadKey);
  threadKeyRef.current = threadKey;
  const [createSkill, setCreateSkill] = useState<CreateSkillId>('spec');
  const [isStreaming, setIsStreaming] = useState(false);
  /**
   * Identity of the thread whose answer is in flight (#1361), or null.
   *
   * `streamingContent`, `isStreaming` and `isThinking` are one provider-wide
   * value each and cannot be bound to a thread, while both renderers decide
   * "this bubble is the in-flight answer" from `isStreaming && isLast`. Without
   * this marker, switching to a retained conversation mid-stream repaints ITS
   * last answer with the other thread's partial text.
   */
  const [streamingThreadId, setStreamingThreadId] = useState<string | null>(null);
  const [isThinking, setIsThinking] = useState(false);
  const [thinkingElapsed, setThinkingElapsed] = useState(false);
  const thinkingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  /**
   * Write to a thread by identity rather than key (#1361).
   *
   * A missing identity is a silent DROP, and that is the feature: it means the
   * thread that started this stream has been replaced (New chat) or evicted, so
   * there is nothing this write could correctly land on. Landing it on whatever
   * now holds the old key is the defect.
   */
  const updateThreadByIdentity = useCallback(
    (identity: number, patch: (thread: AiThread) => Partial<AiThread>) => {
      setThreads((prev) => {
        const key = findThreadKeyByIdentity(prev, identity);
        if (key === undefined) return prev;
        return touchThread(prev, key, patch);
      });
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

  // Changing which thread is on screen swaps threads (#1126) — it no longer
  // clears messages, conversation id or diff/diagram state, which is what
  // silently discarded an in-progress conversation on a sidebar click. The one
  // thing a switch still does is stop an in-flight stream; its partial answer
  // is committed to the thread that started it, located by identity, and
  // dropped if that thread is gone.
  //
  // Keyed on `activeThreadId`, not on the key (#1361). A RE-KEY is not a
  // switch: the first answer on a draft moves the same object to `conv:<id>`
  // and replaces the URL, and aborting the very stream that produced the id
  // would kill the answer mid-flight. The identity does not move, so this
  // effect does not fire.
  const prevActiveThreadIdRef = useRef(activeThreadId);
  useEffect(() => {
    if (activeThreadId === prevActiveThreadIdRef.current) return;
    prevActiveThreadIdRef.current = activeThreadId;
    abortRef.current?.abort();
  }, [activeThreadId]);

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
  // Scoped to the AI route FAMILY. CommandPalette's two producers both land on
  // bare /ai (its AI mode and #1364's no-results recovery item), but the guard
  // is about which routes may have their `q` claimed, and `/ai/c/:id` is the
  // same surface. The provider mounts app-wide, so without it the prefill would
  // claim `q` from ANY route carrying it — silently rewriting that page's URL
  // and stuffing its search term into the AI composer.
  //
  // The local is `onAiRoute` because `isAiRoute` is now the imported predicate.
  const onAiRoute = isAiRoute(location.pathname);
  const urlQuestion = onAiRoute ? searchParams.get('q') : null;
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

  // The conversation list is TanStack Query state owned by the pane
  // (`useConversationList`, key ['llm','conversations','list']) since #1361.
  // The provider used to hold a useState mirror of it, which meant two copies
  // of the same server data and a provider-wide fetch on every route.

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

  /**
   * New chat (#1361). Not "clear the thread you are looking at" any more — it
   * puts a brand-new draft on screen, wherever you pressed it.
   *
   * Four things, in this order:
   *  - abort explicitly. The identity braces already drop the aborted commit
   *    (the old draft object is gone below), but a stream left running would
   *    keep the provider's `isStreaming` lit over a thread it does not belong
   *    to. This is the belt.
   *  - file a FRESH `draft`: a new identity, so every composer reset keyed on
   *    `activeThreadId` fires even on the already-empty draft (Deep Search and
   *    staged attachments clear — the "new -> new" AC).
   *  - `setMode('ask')`: a new chat is a question, and it is what puts
   *    `AskModeInput` on screen for the focus request below. `mode` is
   *    provider-wide and the URL-mode effect does not fire on a same-path
   *    navigation, so nothing else would do it.
   *  - navigate home ONLY when not already there. react-router pushes even for
   *    a same-path `navigate`, so pressing New chat n times on /ai would
   *    otherwise bury the page the user came from under n dead entries. Push,
   *    not replace: Back returns to the conversation.
   *
   * No model reset. #355 AC-4 reset it because `/ai`'s dropdown could put a
   * per-conversation override on the provider; that dropdown is gone and
   * nothing on `/ai` writes `model` any more.
   */
  const startNewConversation = useCallback(() => {
    abortRef.current?.abort();
    setThreads((prev) => fileThread(prev, 'draft'));
    setMode('ask');
    if (location.pathname !== AI_HOME_PATH) navigate(AI_HOME_PATH);
    setComposerFocusRequest((n) => n + 1);
  }, [location.pathname, navigate]);

  // `loadConversation` is route-driven and internal since #1361: opening a row
  // navigates to `/ai/c/:id` and the hydration effect fetches into `conv:<id>`,
  // never into "the current thread". `deleteConversation` belongs to the pane's
  // mutation, which calls `purgeConversation` here when the server confirms.

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

    // Bind this stream to the thread that started it (#1361). The KEY is kept
    // for the fallback below; the IDENTITY is what every write dispatches on,
    // so a re-key is followed (the promotion moves the same object) and a
    // thread that has since been REPLACED — New chat while this stream was
    // running — is not found at all, so the write drops instead of landing an
    // orphan turn in the fresh draft.
    const originKey = threadKeyRef.current;
    const originIdentity = threadsRef.current.get(originKey)?.identity ?? 0;
    // 0 means the active key was not filed yet — reachable only in the render
    // before the filing effect runs, i.e. before anyone could have clicked.
    // Fall back to a key-bound write rather than dispatching on an identity no
    // entry carries, which would silently drop the entire answer.
    const writeOrigin = (patch: (thread: AiThread) => Partial<AiThread>) => {
      if (originIdentity === 0) updateThread(originKey, patch);
      else updateThreadByIdentity(originIdentity, patch);
    };
    const setThreadMessages = (action: React.SetStateAction<Message[]>) =>
      writeOrigin((thread) => ({
        messages: typeof action === 'function' ? action(thread.messages) : action,
      }));

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
      setThreadMessages((prev) => [...prev, { id: seededUserMsgId, role: 'user', content: seededUserMessage }]);
    }

    opts?.onBeforeStream?.();
    isStreamingRef.current = true;
    setIsStreaming(true);
    setIsThinking(true);
    // Mirrors `activeThreadId`'s own fallback: the bare key in the one render
    // window where the thread is not filed yet, so the two can still compare
    // equal and the renderers do not blank the typing indicator.
    setStreamingThreadId(originIdentity === 0 ? originKey : String(originIdentity));

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
    setThreadMessages((prev) => [...prev, { id: assistantMsgId, role: 'assistant', content: '' }]);
    streamingStart();

    // Commit the accumulated answer (and sources, if any) to the placeholder
    // assistant message in one state update.
    const commitToMessages = () => {
      setThreadMessages((prev) => {
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
      setThreadMessages((prev) => {
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
          const id = chunk.conversationId;
          writeOrigin(() => ({ conversationId: id }));
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
        setThreadMessages((prev) => prev.filter(
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
      setStreamingThreadId(null);
    }
  }, [streamingStart, streamingAppend, streamingReplace, streamingFinish, updateThread, updateThreadByIdentity]);

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
    activeThreadId,
    startNewConversation,
    composerFocusRequest,
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
    streamingThreadId,
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
