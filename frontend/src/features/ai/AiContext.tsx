/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useState, useRef, useEffect, useMemo, useCallback, type ReactNode } from 'react';
import { useSearchParams, useNavigate, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ConversationDetail, UsecaseDefault } from '@compendiq/contracts';
import { apiFetch, ApiError } from '../../shared/lib/api';
import { streamSSE } from '../../shared/lib/sse';
import { AI_HOME_PATH, isAiRoute, conversationIdFromPath, conversationPath } from '../../shared/lib/ai-routes';
import { usePage, useEmbeddingStatus, type EmbeddingStatusData } from '../../shared/hooks/use-pages';
import { DEFAULT_IMPROVEMENT_TYPE, type ImprovementType } from './improvement-types';
import { isAiHomeAction } from './assistant-actions';
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
   * #1361: the delete mutation succeeded. Removes `conv:<id>`, clears the id
   * from every other retained thread that carried it (keeping their messages),
   * and leaves a dead URL with a `replace` navigation to `/ai`.
   */
  purgeConversation: (id: string) => void;
  /**
   * #1361: hydration state of the ACTIVE thread. `draft` and `page:` threads
   * are always `'ready'`; a `conv:` thread is `'loading'` from the first paint
   * of `/ai/c/:id` until `GET /llm/conversations/:id` answers.
   */
  threadLoadState: 'ready' | 'loading' | 'error';
  /**
   * The curated `ApiError.message` behind a `'error'` load, or `null` for a
   * failure that produced no prose worth showing (a raw network `TypeError`).
   * The page renders its own sentence in that case — `SidebarTreeView`'s rule.
   */
  threadLoadError: string | null;
  /** Re-arm the hydration effect for the open conversation. */
  retryThreadLoad: () => void;
  /**
   * Decision 10: the server dropped older exchanges from the replay budget for
   * this conversation. Two sources — each ask's final frame, and
   * `GET /llm/conversations/:id` on reopen — or the note is invisible in
   * exactly the case it exists for.
   */
  historyTruncated: boolean;
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
  /**
   * #1361: `string | null`. The ask route's final frame is
   * `conversationId: convId ?? null` (`llm-ask.ts`), and `null` is a fact, not
   * an absence — the append hit zero rows because the conversation was deleted
   * in another tab while the answer was streaming. Absent (`undefined`) still
   * means "this stream is not about a conversation at all", which is every
   * other `/llm/*` route.
   */
  conversationId?: string | null;
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
  /**
   * Ask route (#1361, decision 10): the replay budget dropped older exchanges
   * from what the model was shown. Omitted entirely when the whole history
   * fitted, so ABSENT means false.
   */
  historyTruncated?: boolean;
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

/**
 * Evict least-recently-used entries down to the cap, in place. A Map iterates
 * in insertion order, so the first key is always the oldest touch.
 *
 * Shared by `fileThread` and `touchThread` below, and by the promotion
 * (#1361): filing a fresh `draft` beside the thread it just re-keyed can
 * therefore push the map one over the cap — a second copy of this loop is how
 * the two would drift.
 */
function trimThreads(threads: Map<string, AiThread>): Map<string, AiThread> {
  while (threads.size > MAX_RETAINED_THREADS) {
    const oldest = threads.keys().next().value;
    if (oldest === undefined) break;
    threads.delete(oldest);
  }
  return threads;
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
  return trimThreads(next);
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
  return trimThreads(next);
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
 * Move the thread at `fromKey` to `toKey`, in place — the SAME object, not a
 * copy, so its `identity` (and everything else) survives untouched. The
 * #1361 promotion depends on this: a re-key is not a switch, and stamping a
 * new identity (what `fileThread` does) would fire every switch-sensitive
 * effect keyed on `activeThreadId` for what is, from the user's chair, the
 * same conversation growing an id.
 *
 * A no-op when `fromKey` is already gone — the caller checks
 * `findThreadKeyByIdentity` first and only calls this when it found
 * something, but staying defensive here costs nothing.
 */
function rekeyThread(
  threads: Map<string, AiThread>,
  fromKey: string,
  toKey: string,
): Map<string, AiThread> {
  const thread = threads.get(fromKey);
  if (!thread) return threads;
  threads.delete(fromKey);
  threads.set(toKey, thread);
  return threads;
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

  // #1361: which modes a `?mode=` deep link may select depends on the surface
  // the provider is serving. On an AI route it is the two `isAiHomeAction`
  // admits — `ask` and `generate` — deliberately NARROWER than the seven-item
  // `AI_HOME_ACTIONS` menu list, because a `create-*` skill is picked in-app
  // and is never a URL value; on `/pages/:id` — the dock — the full set still
  // applies, because the dock offers the rewrite skills and Diagram. This
  // boolean is read again by the `?q=` prefill below; there is exactly one of
  // it in the provider.
  const onAiRoute = isAiRoute(location.pathname);
  const rawMode = searchParams.get('mode');
  const urlMode = rawMode !== null
    && (onAiRoute ? isAiHomeAction(rawMode) : VALID_MODES.includes(rawMode as Mode))
    ? (rawMode as Mode)
    : null;
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
    loadState, loadError, historyTruncated,
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
   * The LIVE active thread key, for callbacks captured before a navigation.
   *
   * The promotion has to answer "is the thread I started in still the one on
   * screen?". A `threadKey` captured when the stream started answers "was it,
   * when I started" — always yes — and would drag a user who navigated away
   * mid-answer back onto the promoted conversation.
   */
  const activeKeyRef = useRef(threadKey);
  useEffect(() => {
    activeKeyRef.current = threadKey;
  }, [threadKey]);

  /**
   * Everything that happens once a completed exchange lands: the three
   * post-commit rows of #1361's state machine, plus list invalidation.
   *
   * One `setThreads` pass, so a promotion and the mirror can never be observed
   * half-applied — and `navigate` is queued in the same synchronous block, so
   * React batches the map write and the URL change into ONE render. That is
   * what keeps `activeThreadId` from dipping through the fresh draft's
   * identity between the re-key and the URL landing; a dip would fire the
   * abort effect and clear both composers on a promotion, which is a re-key
   * and explicitly not a switch.
   */
  const completeExchange = useCallback((args: {
    originKey: string;
    originIdentity: number;
    originHadId: boolean;
    assistantMsgId: string;
    frameConversationId: string | null | undefined;
    historyTruncated: boolean;
  }) => {
    const {
      originKey, originIdentity, originHadId, assistantMsgId,
      frameConversationId, historyTruncated,
    } = args;

    // Nothing on this stream concerns conversations: Improve, Generate,
    // Diagram and Summarize emit no `conversationId` frame at all. Returning
    // here is also what keeps an Improve run on a page thread that happens to
    // carry an id from refetching the conversation list.
    if (frameConversationId === undefined) return;

    // Decision 10: the flag describes THIS conversation's replay budget, so it
    // is written only for an exchange that was saved to one. Its own update —
    // the big pass below returns `prev` untouched when nothing was promoted
    // and nothing was mirrored, and this must land either way.
    updateThreadByIdentity(originIdentity, () => ({ historyTruncated }));

    // Promotion guard, both halves. The key half is what stops the dock: a
    // `page:` origin never promotes, never re-keys and never navigates. The
    // id half is what stops a follow-up: only a thread that had NO id when the
    // stream started is a conversation being born.
    const promotedId =
      typeof frameConversationId === 'string'
      && !originHadId
      && (originKey === 'draft' || originKey.startsWith('conv:'))
        ? frameConversationId
        : null;

    // Minted OUTSIDE the updater: React may invoke a state updater twice, and
    // an updater that allocates ids is not pure. Two is the whole mirror — the
    // pair is at most (user, assistant) — and reusing them across two target
    // threads is correct, because a message id only has to be unique inside
    // its own list.
    const mirrorUserId = nextMessageId();
    const mirrorAssistantId = nextMessageId();
    const freshDraftIdentity = promotedId !== null && originKey === 'draft' ? nextIdentity() : 0;

    setThreads((prev) => {
      const fromKey = findThreadKeyByIdentity(prev, originIdentity);
      // The thread that asked has been replaced (New chat while its stream was
      // running). Its content write was dropped upstream; so is this.
      if (fromKey === undefined) return prev;
      const origin = prev.get(fromKey)!;

      // The mirror pair. Only a SAVED exchange mirrors: a `null` frame means
      // the row is gone, so there is no second view of it to keep in step.
      const pair: Message[] = [];
      if (typeof frameConversationId === 'string') {
        const at = origin.messages.findIndex((msg) => msg.id === assistantMsgId);
        if (at >= 0) {
          const before = origin.messages[at - 1];
          if (before && before.role === 'user') pair.push({ ...before, id: mirrorUserId });
          pair.push({ ...origin.messages[at]!, id: mirrorAssistantId });
        }
      }
      const mirrorTargets = pair.length > 0
        ? Array.from(prev).filter(([, thread]) =>
            thread.identity !== originIdentity && thread.conversationId === frameConversationId)
        : [];

      if (promotedId === null && mirrorTargets.length === 0) return prev;

      let next = new Map(prev);
      if (promotedId !== null) {
        next = rekeyThread(next, fromKey, `conv:${promotedId}`);
        if (fromKey === 'draft') {
          // Exactly one draft exists. The promoted object took its content
          // with it, so the draft slot is re-seeded with a fresh identity —
          // which is what makes /ai a new chat again.
          next.set('draft', { ...seedFor('draft'), identity: freshDraftIdentity });
          next = trimThreads(next);
        }
      }
      for (const [key] of mirrorTargets) {
        const thread = next.get(key);
        // Evicted by the trim above; nothing to keep in step.
        if (!thread) continue;
        // Map.set on an existing key keeps its position, so the mirror never
        // reorders the LRU and never promotes a stale thread out of eviction.
        next.set(key, { ...thread, messages: [...thread.messages, ...pair] });
      }
      return next;
    });

    if (promotedId !== null && activeKeyRef.current === originKey) {
      // replace, not push: Back returns to where the user came from, not to
      // the empty draft this conversation grew out of.
      navigate(conversationPath(promotedId), { replace: true });
    }
    // Every completed ask moves a row or its position — a promotion creates
    // one, a follow-up bumps `updated_at`, a null frame means it is gone.
    queryClient.invalidateQueries({ queryKey: ['llm', 'conversations'] });
  }, [navigate, queryClient, updateThreadByIdentity]);

  /**
   * Delete succeeded — the pane owns the mutation (`useDeleteConversation`),
   * this is the thread-side half.
   *
   * The conversation's own thread goes. Every OTHER retained thread carrying
   * the id — the dock's `page:` thread on the page the conversation started
   * from — keeps its messages and loses the id, so its next question starts a
   * fresh row instead of 404-looping against a row that is gone.
   */
  const purgeConversation = useCallback((id: string) => {
    setThreads((prev) => {
      const next = new Map(prev);
      next.delete(`conv:${id}`);
      for (const [key, thread] of next) {
        if (thread.conversationId === id) next.set(key, { ...thread, conversationId: null });
      }
      return next;
    });
    // The open URL is dead. `replace`, so it is not one Back press away.
    if (conversationIdFromPath(location.pathname) === id) {
      navigate(AI_HOME_PATH, { replace: true });
    }
  }, [location.pathname, navigate]);

  /**
   * Keys with a `GET /llm/conversations/:id` in flight. A ref, not state: it
   * exists only to stop the effect firing twice for the same key, and putting
   * it in state would re-run the effect it guards.
   */
  const hydratingRef = useRef<Set<string>>(new Set());

  /**
   * Fetch one conversation INTO its own key — never into "the current thread".
   * The internal successor of #1126's `loadConversation`, exported nowhere:
   * opening a row is a navigation now, and the route is the only caller.
   */
  const hydrateThread = useCallback(async (key: string, id: string) => {
    if (hydratingRef.current.has(key)) return;
    hydratingRef.current.add(key);
    try {
      const conv = await apiFetch<ConversationDetail>(`/llm/conversations/${id}`);
      updateThread(key, () => ({
        // `refused` is what `saveConversation` writes onto a #1105 refusal
        // turn, and the route returns the messages JSONB verbatim — so a
        // reopened thread has to carry the marker across or the refusal
        // silently downgrades to an ordinary answer, which is precisely the
        // state #1119 exists to stop rendering. Since PR 1 the persisted turn
        // carries its `sources` (the chip allow-list) too.
        messages: conv.messages
          .filter((msg) => msg.role !== 'system')
          .map((msg) => ({
            id: nextMessageId(),
            role: msg.role as 'user' | 'assistant',
            content: msg.content,
            ...(msg.sources ? { sources: msg.sources as Source[] } : {}),
            ...(msg.refused === true ? { isRefusal: true } : {}),
          })),
        conversationId: conv.id,
        historyTruncated: conv.historyTruncated,
        loadState: 'ready',
        loadError: null,
      }));
      // Opening loads, never sends (#1176), and puts the Ask composer on
      // screen. It deliberately does NOT call setModel: the per-conversation
      // dropdown is gone, and a stored model would silently repoint every
      // later question on the instance.
      setMode('ask');
    } catch (err) {
      const status = err instanceof ApiError ? err.statusCode : 0;
      if (status === 404 || status === 400) {
        toast.error('Conversation not found');
        // Remove the placeholder in the same tick as the navigation, so the
        // two batch into one render and the read path never re-seeds
        // `conv:<id>` as `loading` behind the redirect.
        setThreads((prev) => {
          const next = new Map(prev);
          next.delete(key);
          return next;
        });
        navigate(AI_HOME_PATH, { replace: true });
        return;
      }
      // Anything else stays put with an in-pane error and a Retry: redirecting
      // on a network blip would lose a URL the user typed.
      updateThread(key, () => ({
        loadState: 'error',
        loadError: err instanceof ApiError ? err.message : null,
      }));
    } finally {
      hydratingRef.current.delete(key);
    }
  }, [navigate, updateThread]);

  /**
   * Hydration is keyed on STATE, not on presence: whenever the active thread
   * says `loading` and no fetch is in flight for its key, fetch. Effect order
   * therefore cannot break it — a `?q=` prefill that files the key first files
   * it through `seedFor`, which is what keeps `loading` on the entry.
   *
   * Reads `threads` directly rather than the destructured `loadState` —
   * `activeThread`'s `?? seedFor(threadKey)` fallback is a render-only
   * artifact for a key that is not (or no longer) in the map, and a rekey
   * lands its `setThreads` update at least one render ahead of the matching
   * `navigate`. On that in-between render `threadKey` still names the OLD
   * key (which the rekey just vacated), so the fallback reports a phantom
   * `'loading'` for a conversation this tab no longer has open. Firing on
   * that would fetch an id the app has already moved past — one whose
   * record may be legitimately gone (a stale-404 promotion, #1361) — and its
   * 404 branch would toast and redirect the user off the thread they are
   * actually looking at. Reading `threads.get(key)` bypasses the fallback:
   * it is undefined for that same render, so the effect stands down and
   * fires only once the filing effect (or a real reopen) has actually
   * committed a `loading` entry under `key`.
   */
  useEffect(() => {
    const id = conversationIdFromPath(location.pathname);
    if (!id) return;
    const key = `conv:${id}`;
    if (threads.get(key)?.loadState !== 'loading') return;
    if (hydratingRef.current.has(key)) return;
    void hydrateThread(key, id);
  }, [threads, location.pathname, hydrateThread]);

  /**
   * The error state's remedy. Setting `loadState` back to `'loading'` is the
   * whole mechanism — the effect above is armed by state, so this re-arms it.
   */
  const retryThreadLoad = useCallback(() => {
    const id = conversationIdFromPath(location.pathname);
    if (!id) return;
    updateThread(`conv:${id}`, () => ({ loadState: 'loading', loadError: null }));
  }, [location.pathname, updateThread]);

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
    // #1361: did the ORIGIN thread carry an id when this call started? Read
    // off the request body — the only place a caller states it (`AskMode`
    // passes its own `conversationId`) — which is also what the stale-404
    // guard below keys on, per the same "a conversationId in the body is the
    // REQUEST body" reasoning.
    const originHadId = typeof body.conversationId === 'string';
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
    /**
     * #1361: the id the server named on this stream. Three distinct values,
     * and the state machine reads all three — `undefined` (no frame: not an
     * ask), a string (saved to that row), `null` (the append hit zero rows).
     */
    let frameConversationId: string | null | undefined;
    /**
     * Decision 10's live half. Absent on the frame ⇒ false: the backend omits
     * the field when the whole history fitted.
     */
    let frameHistoryTruncated = false;

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
        // `in` plus an explicit undefined check, NOT truthiness: the final
        // frame is `conversationId: convId ?? null`, and the truthiness guard
        // swallowed exactly the `null` — leaving the client holding an id for
        // a row that was deleted mid-answer in another tab.
        if ('conversationId' in chunk && chunk.conversationId !== undefined) {
          const frameId = chunk.conversationId;
          if (
            frameId !== null
            && originHadId
            && originKey.startsWith('conv:')
            && frameId !== originKey.slice('conv:'.length)
          ) {
            // Defensive: the server answered about a different row than the
            // one this thread is pinned to. Adopting it would silently move
            // the user's conversation, and `AskMode` reads this id straight
            // into the next request body. Log and keep the thread where it is.
            console.warn('[ai] final frame named a different conversation; ignored', {
              originKey,
              frameId,
            });
          } else {
            frameConversationId = frameId;
            writeOrigin(() => ({ conversationId: frameId }));
          }
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
        if (chunk.final) {
          frameHistoryTruncated = chunk.historyTruncated === true;
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
      // Promotion, the mirror and list invalidation — the NORMAL path only.
      // An aborted or errored first answer is never promoted (decision 9): the
      // abort branch below commits its partial and returns before reaching
      // here, and so does every error branch.
      completeExchange({
        originKey,
        originIdentity,
        originHadId,
        assistantMsgId,
        frameConversationId,
        historyTruncated: frameHistoryTruncated,
      });
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
      // #1361: a stale conversation id. The server refuses BEFORE any SSE
      // header, so this arrives as a thrown ApiError rather than an in-band
      // error frame, and it is handled here — ahead of `onError` — so both
      // surfaces get it from the one helper they share.
      //
      // The id is read off the REQUEST body: `ApiError` carries a status and a
      // message and never the response payload (`shared/lib/sse.ts`), so the
      // body is the only place the client holds the id this 404 is about.
      if (
        err instanceof ApiError
        && err.statusCode === 404
        && typeof body.conversationId === 'string'
      ) {
        // No toast — the sentence IS the turn. No re-key and no navigation
        // either: re-keying onto `draft` would clobber the incumbent draft,
        // and the promotion rule already gives the next question a fresh row
        // and a fresh URL. Never auto-resend (#1176).
        failLastMessage('This conversation no longer exists — your next question starts a new one.');
        writeOrigin(() => ({ conversationId: null }));
        queryClient.invalidateQueries({ queryKey: ['llm', 'conversations'] });
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
  }, [streamingStart, streamingAppend, streamingReplace, streamingFinish, updateThread, updateThreadByIdentity, completeExchange, queryClient]);

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
    purgeConversation,
    threadLoadState: loadState,
    threadLoadError: loadError,
    retryThreadLoad,
    historyTruncated,
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
