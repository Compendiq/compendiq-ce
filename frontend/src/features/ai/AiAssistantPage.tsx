import { memo } from 'react';
import { m, useReducedMotion } from 'framer-motion';
import {
  Bot, User, AlertTriangle, RefreshCw,
} from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '../../shared/lib/cn';
import { ConfidenceBadge } from '../../shared/components/badges/ConfidenceBadge';
import { RefusalMark, RefusalSourcesLabel, REFUSAL_ANNOUNCEMENT } from './refusal';
import { AIThinkingBlob } from '../../shared/components/feedback/AIThinkingBlob';
import { TypingIndicator } from '../../shared/components/feedback/TypingIndicator';
import { SourceCitations } from './SourceCitations';
import { CitationChips } from './CitationChips';
import { averageSourceSimilarity } from './source-confidence';
import { StreamingMessage } from './StreamingMessage';
import { useAiContext, type Mode, type Message } from './AiContext';
import {
  AskModeInput, AskExamplePrompts, ASK_EMPTY_TITLE, ASK_EMPTY_SUBTITLE, NO_EMBEDDINGS_NOTICE_ID,
  ImproveDiffView, ImproveModeInput, IMPROVE_EMPTY_TITLE, improveEmptySubtitle,
  GenerateModeInput, GENERATE_EMPTY_TITLE, GENERATE_EMPTY_SUBTITLE,
  DiagramTypeSelector, DiagramPreview, DiagramModeInput, DIAGRAM_EMPTY_TITLE, diagramEmptySubtitle,
} from './modes';
import { isZeroEmbeddings } from '../../shared/hooks/use-pages';
import { SETTINGS_PANELS } from '../settings/settings-nav';
import { AssistantAttachmentsScope } from './AssistantAttachments';
import { HeaderHost } from '../../shared/components/layout/header-slot';

// ---------------------------------------------------------------------------
// Memoized message bubble: skips re-render for completed (non-streaming) messages
// ---------------------------------------------------------------------------

interface MessageBubbleProps {
  msg: Message;
  index: number;
  isLast: boolean;
  isStreaming: boolean;
  isThinking: boolean;
  thinkingElapsed: boolean;
  shouldReduceMotion: boolean | null;
  /**
   * rAF-batched content of the in-flight answer (#747). Only passed to the
   * last message bubble while streaming; committed messages render msg.content.
   */
  streamingContent?: string;
}

const MessageBubble = memo(function MessageBubble({
  msg, index, isLast, isStreaming, isThinking, thinkingElapsed, shouldReduceMotion, streamingContent,
}: MessageBubbleProps) {
  const isLastAssistant = msg.role === 'assistant' && isLast;
  const isStreamingThis = isStreaming && isLastAssistant;
  const effectiveContent = isStreamingThis ? (streamingContent ?? msg.content) : msg.content;
  const showThinkingBlob = isThinking && isLastAssistant && !effectiveContent && thinkingElapsed;
  const showTypingIndicator = isThinking && isLastAssistant && !effectiveContent && !thinkingElapsed;

  return (
    <m.div
      initial={shouldReduceMotion ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        delay: shouldReduceMotion ? 0 : Math.min(index * 0.05, 0.3),
        type: 'spring',
        stiffness: 300,
        damping: 25,
      }}
      className={cn('flex gap-3', msg.role === 'user' && 'justify-end')}
    >
      {msg.role === 'assistant' && (
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/15">
          <Bot size={16} className="text-primary" />
        </div>
      )}
      <div
        className={cn(
          'max-w-[80%] rounded-2xl px-4 py-3 text-sm xl:max-w-2xl',
          msg.role === 'user'
            ? 'bg-primary/10 text-foreground'
            : msg.isError
              ? 'border border-destructive/40 bg-destructive/10'
              // The #1105 refusal (#1119): the ordinary bubble ground plus a
              // hairline. A value step and a 1px border is all ADR-010 v0.6
              // allows for distinguishing a surface, and the "Not answered"
              // chip inside carries the meaning. No hue — see `refusal.tsx`.
              : msg.isRefusal
                ? 'border border-border bg-foreground/5'
                : 'bg-foreground/5',
        )}
        // No role="alert" here: the role and the error content would arrive
        // in the same render, which AT generally does not announce (MDN alert
        // role). The primed announcer next to the message list handles SR
        // announcement; this bubble is the visual surface only.
        data-testid={msg.isError ? 'message-error' : msg.isRefusal ? 'message-refusal' : undefined}
      >
        {showThinkingBlob && <AIThinkingBlob active />}
        {showTypingIndicator && <TypingIndicator />}
        {isStreamingThis ? (
          // #747: the in-flight answer renders through the rAF-batched
          // StreamingMessage, so the Markdown re-parse happens at most once
          // per animation frame instead of once per SSE chunk.
          effectiveContent ? (
            <StreamingMessage content={effectiveContent} isStreaming />
          ) : (!showThinkingBlob && !showTypingIndicator ? (
            <div className="prose prose-sm max-w-none">
              <TypingIndicator />
            </div>
          ) : null)
        ) : msg.isError ? (
          // Error messages render as plain text (not Markdown) so the
          // destructive color isn't overridden by the prose styles.
          <p className="text-destructive">{msg.content}</p>
        ) : msg.isRefusal ? (
          // Plain text, not Markdown: the backend writes one prose sentence
          // with no Markdown in it, and a refusal is the last place to let a
          // renderer invent structure over what the server actually said.
          <>
            <RefusalMark />
            <p className="mt-2 whitespace-pre-wrap text-foreground">{msg.content}</p>
          </>
        ) : (
          <div className="prose prose-sm max-w-none">
            {msg.content ? (
              <Markdown remarkPlugins={[remarkGfm]}>{msg.content}</Markdown>
            ) : null}
          </div>
        )}
        {msg.role === 'assistant' && msg.sources && msg.sources.length > 0 && (
          <div className="mt-3 space-y-2">
            {/* Named on a refusal, bare on an answer: an unlabelled chip row
                under "I am not answering" reads as the sources the answer was
                built from, which is the reading the backend's own live text
                goes out of its way to prevent. */}
            {msg.isRefusal && <RefusalSourcesLabel />}
            <div className="flex items-center gap-2">
              {(() => {
                // A refusal gets NO ConfidenceBadge. The badge rates the
                // sources an answer stands on; here there is no answer, and
                // "Low confidence" beside a turn that declined to answer reads
                // as a weak answer rather than none — rating a thing that does
                // not exist (#1119).
                if (msg.isRefusal) return null;
                // null means no similarity was measured (keyword-only hit, a
                // web source, or a pre-#1117 conversation) — render no badge
                // rather than a zero, which paints it red.
                const avgSimilarity = averageSourceSimilarity(msg.sources!);
                if (avgSimilarity === null) return null;
                return <ConfidenceBadge score={avgSimilarity} />;
              })()}
              <CitationChips sources={msg.sources!} />
            </div>
            <SourceCitations sources={msg.sources} />
          </div>
        )}
      </div>
      {msg.role === 'user' && (
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-foreground/8">
          <User size={16} className="text-muted-foreground" />
        </div>
      )}
    </m.div>
  );
}, (prev, next) => {
  // Custom comparator: skip re-render if message content and streaming state haven't changed.
  // Completed messages (not last or not streaming) will never re-render.
  if (prev.msg.id !== next.msg.id) return false;
  if (prev.msg.content !== next.msg.content) return false;
  if (prev.msg.isError !== next.msg.isError) return false;
  // Without this, the placeholder committed as a refusal keeps the bubble it
  // was already rendering: `content` changes on the same commit today, so the
  // bug would only surface for an empty-bodied refusal — a landmine, not a
  // theoretical.
  if (prev.msg.isRefusal !== next.msg.isRefusal) return false;
  if (prev.msg.sources !== next.msg.sources) return false;
  if (prev.isLast !== next.isLast) return false;
  if (prev.isStreaming !== next.isStreaming) return false;
  if (prev.streamingContent !== next.streamingContent) return false;
  if (prev.isThinking !== next.isThinking) return false;
  if (prev.thinkingElapsed !== next.thinkingElapsed) return false;
  return true;
});

// ---------------------------------------------------------------------------
// Empty state text per mode
// ---------------------------------------------------------------------------

function getEmptyTitle(mode: Mode): string {
  switch (mode) {
    case 'ask': return ASK_EMPTY_TITLE;
    case 'improve': return IMPROVE_EMPTY_TITLE;
    case 'generate': return GENERATE_EMPTY_TITLE;
    case 'diagram': return DIAGRAM_EMPTY_TITLE;
  }
}

function getEmptySubtitle(mode: Mode, page: { title: string } | undefined): string {
  switch (mode) {
    case 'ask': return ASK_EMPTY_SUBTITLE;
    case 'improve': return improveEmptySubtitle(page);
    case 'generate': return GENERATE_EMPTY_SUBTITLE;
    case 'diagram': return diagramEmptySubtitle(page);
  }
}

// ---------------------------------------------------------------------------
// Page (consumes AiContext)
//
// The provider is NOT mounted here: it lives in AppLayout (#1126) so a
// conversation outlives the route. Mounting one here again would give /ai its
// own thread map and reintroduce exactly the reset this fixed.
// ---------------------------------------------------------------------------

export function AiAssistantPage() {
  const ctx = useAiContext();
  const {
    mode, page,
    messages, messagesEndRef, isStreaming, isThinking, thinkingElapsed,
    streamingContent, streamingThreadId, activeThreadId,
    embeddingStatus,
    threadLoadState, threadLoadError, retryThreadLoad,
  } = ctx;

  // #1361: `isStreaming` / `isThinking` / `streamingContent` are one
  // provider-wide value each, and this renderer decides "the last bubble is the
  // in-flight answer" from `isStreaming && isLast`. A question asked on another
  // thread — the dock on an article, or a conversation left running — would
  // therefore repaint THIS thread's last answer with that thread's partial
  // text. `streamingThreadId` is the identity of the thread that asked.
  //
  // Only the message bubbles are gated. The announcer, the composer's disabled
  // state and the Stop control stay provider-wide: a stream really is running.
  const streamingHere = isStreaming && streamingThreadId === activeThreadId;
  const thinkingHere = isThinking && streamingThreadId === activeThreadId;

  const shouldReduceMotion = useReducedMotion();

  return (
    <m.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      // flex-1 walks up through the wrapper chain (AppLayout +
      // PageTransition both opt into a flex column) so this page fills the
      // available scroll height without depending on a `calc(100vh - chrome)`
      // magic number that would drift if the header / service-status banner
      // height changes.
      //
      // min-h-0 is the last link of a four-link chain (#1218). A flex item's
      // automatic minimum size (`min-height: auto`) refuses to shrink below
      // its content, so any link keeping it stops the whole chain and this
      // column grows to its messages — leaving AppLayout's padded scroll
      // container as the thing that scrolls, with live message text passing
      // through the padding strip above the top bar and below the input bar.
      // The chain is AppLayout's scroll container -> PageTransition ->
      // AppLayout's max-width wrapper -> this root -> the message pane's own
      // scroller below. All four are load-bearing; three of four fixes
      // nothing. Guarded by name in `src/ai-scroll-chain.test.ts`.
      className="flex min-h-0 flex-1 flex-col gap-3"
    >
      {/* The route's heading. New chat is NOT here any more (owner request,
          2026-09-01): the conversations rail carries it — full-width when the
          rail is expanded, a `SquarePen` glyph when it is collapsed — and two
          buttons 200px apart doing the same thing made the page's one heading
          row carry a duplicate. `AiConversationsSidebar` owns it in both of its
          states, so no width loses the action.

          `HeaderHost` renders in the document now: there is no
          #app-header-slot producer left, no AppHeaderMain to suppress a
          fallback title, and no data-header-kpis to avoid.

          FIRST CHILD INSIDE the root <m.div>, never a fragment sibling above
          it, and the root's className must stay a STATIC string literal:
          `ai-scroll-chain.test.ts:110-126` finds this page's root with
          /return \(\s*<m\.div([\s\S]*?)>/ and then requires className="…" on
          it, throwing on either failure — which takes two of its cases down and
          leaves `scroll-padding-mask.test.ts` describing a strategy nothing
          enforces. */}
      <HeaderHost fallbackClassName="mb-1">
        <div className="flex min-w-0 items-center gap-3">
          <h1 className="min-w-0 truncate text-[15px] font-semibold sm:text-lg">AI</h1>
        </div>
      </HeaderHost>

      {/* Diagram's one secondary setting, and nothing else. The durable-option
          row that used to sit here — a `bg-card` strip holding the single
          `Think` chip — went into the composer's action row (owner request,
          2026-09-01, see `ThinkToggle`), which left a full-width card
          describing the request from 600px above it. With it gone the sticky
          strip only exists for the mode that has a setting: an empty sticky box
          would still consume its `py-1` and both gaps out of the message
          pane's height at every other mode.

          The opaque UNDER-mask (bg-background, z-[-1]) behind the bar is
          belt-and-braces through the supported viewport range, not
          load-bearing. It was what occluded chat content scrolling up behind
          the bar (#703) — but since #1218 the message pane owns the scroller
          and this column does not scroll, so nothing passes behind it. It
          covers exactly the bar's box (inset-0), and that constraint still
          binds: an absolutely positioned mask overflowing the block-end edge
          creates scrollable overflow in a container that now has none, which is
          #769's phantom scroll re-opened on a page that had stopped scrolling
          entirely. */}
      {mode === 'diagram' && (
        <div className="sticky top-0 z-20 isolate -mx-1 bg-background px-1 py-1">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 z-[-1] bg-background"
          />
          <DiagramTypeSelector />
        </div>
      )}

      {/* Primed live region for error announcements. It must exist (empty)
          BEFORE any error so assistive tech watches it for content changes —
          adding role="alert" together with the message in one render is
          generally not announced (MDN alert role). The visible error bubble
          below carries no alert role. For the toast-suppressed 403 path this
          region is the only announcement; other errors keep their toast, so
          they may announce twice — over-announcing beats silence.
          The child span is keyed by message id: Ask mode appends on retry, so
          a repeated identical failure derives byte-identical text — only a
          freshly inserted node makes AT announce it again. */}
      <div role="alert" data-testid="ai-error-announcer" className="sr-only">
        {(() => {
          const lastError = [...messages].reverse().find((msg) => msg.isError);
          return lastError ? <span key={lastError.id}>{lastError.content}</span> : null;
        })()}
      </div>

      {/* Primed polite live region for completed answers (#937). The error
          announcer above only speaks failures; without this, a screen-reader
          user hears nothing when an answer finishes and the streamed text is
          silently painted into the bubble. Gated on !isStreaming so we announce
          the finished answer once, not mid-stream (which would interrupt the
          visible streaming). Keyed by the completed message id so a fresh node
          is inserted per answer — that insertion is what AT re-announces. */}
      <div role="status" aria-live="polite" data-testid="ai-answer-announcer" className="sr-only">
        {(() => {
          if (isStreaming) return null;
          const lastAnswer = [...messages].reverse().find(
            (msg) => msg.role === 'assistant' && !msg.isError && msg.content,
          );
          if (!lastAnswer) return null;
          // A refusal is the one thing this region must not call an answer
          // (#1119). It is not an error either, so it stays in the polite
          // region rather than being routed to the alert one above — a correct
          // response does not warrant interrupting.
          return (
            <span key={lastAnswer.id}>
              {lastAnswer.isRefusal ? REFUSAL_ANNOUNCEMENT : 'Answer ready'}
            </span>
          );
        })()}
      </div>

      {/* Messages — clean document-like surface, no heavy glass.
          flex-1 so the messages area grows to fill the column, pushing
          the sticky input bar to the bottom of the page.

          overflow-y-auto, not overflow-hidden: at viewport heights at or below
          768px the empty-state prompt cards were clipped with no way to reach
          them — measured clean at 900px and cut at 720px, so any 1366x768
          laptop lost them entirely, and on mobile they rendered behind the
          composer. min-h-0 lets the flex child actually shrink so the scroll
          container resolves instead of overflowing its parent. */}
      <div className="min-h-0 flex-1 overflow-y-auto rounded-xl bg-card" data-testid="ai-message-pane">
        <div className="min-h-[360px] space-y-4 p-5">
          {/* Zero-embeddings notice (#938). Q&A answers via RAG over embedded
              pages; with none embedded, buildRagContext returns "No relevant
              context found", so the LLM answers as if the query matched
              nothing. Surface the real cause here — scoped to ask mode (other
              modes operate on the current page's text, not RAG) and shown in
              both the empty and answered states so it never gets hidden behind
              a misleading answer. */}
          {mode === 'ask' && isZeroEmbeddings(embeddingStatus) && (
            <div
              // The id is the aria-describedby target of the example-prompt
              // chips below, which go inert under the same condition — the
              // banner's text doubles as their programmatic disabled reason.
              id={NO_EMBEDDINGS_NOTICE_ID}
              data-testid="ai-no-embeddings-notice"
              className="flex items-start gap-3 rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm text-warning"
            >
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <span>
                Pages not embedded yet — configure an embedding provider in
                Settings → {SETTINGS_PANELS.models.label} and run an embedding pass.
                Until then, Q&amp;A has no knowledge-base context to draw on.
              </span>
            </div>
          )}
          {/* #1361: a `conv:` thread is fetched, so this pane has two states
              the draft never had. Neither may fall through to the empty state
              below — "Ask questions about your knowledge base" over a
              conversation that is still loading, or that failed to load, says
              the conversation is empty. */}
          {threadLoadState === 'loading' && (
            <div
              role="status"
              data-testid="ai-thread-loading"
              className="flex min-h-[300px] items-center justify-center text-sm text-muted-foreground"
            >
              Loading conversation…
            </div>
          )}
          {threadLoadState === 'error' && (
            // The tree's destructive block, verbatim in intent (ADR-010: red is
            // failure, amber is degraded — this request FAILED). `threadLoadError`
            // is ApiError's curated prose, which is the only place the reader
            // learns why.
            <div className="flex flex-col items-center px-3 py-8 text-center" role="alert" data-testid="ai-thread-error">
              <div className="mb-3 rounded-full bg-muted p-2.5">
                <AlertTriangle size={20} className="text-destructive" aria-hidden="true" />
              </div>
              <p className="text-xs font-medium text-foreground/70">Couldn&rsquo;t load conversation</p>
              <p className="mt-1 break-words line-clamp-3 text-[11px] text-muted-foreground">
                {threadLoadError ?? 'The request did not complete.'}
              </p>
              <button
                type="button"
                onClick={() => retryThreadLoad()}
                className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-action bg-transparent px-3 py-1.5 text-xs font-medium text-action transition-colors hover:bg-action hover:text-action-foreground"
              >
                <RefreshCw size={12} aria-hidden="true" />
                Retry
              </button>
            </div>
          )}
          {threadLoadState === 'ready' && messages.length === 0 && (
            <div className="flex min-h-[300px] flex-col items-center justify-center text-center">
              {/* Robot wrapped in a violet aura so the empty state reads as
                  "ready to help", not "page failed to load" (a complaint in
                  the May-2026 audit). 64 px icon + soft glow vs. the prior
                  44 px muted-grey glyph.
                  Violet, not steel: under ADR-010 v0.5 --color-status-ai marks
                  "an AI does this" and steel means "you can operate this".
                  This ornament is the former — it is not clickable. */}
              {/* A plain glyph, matching the dock's empty state. This was an
                  80px blurred halo behind a 64px ringed disc behind the icon —
                  three stacked decorations to say "AI". Violet still carries
                  that meaning (ADR-010); it does not need a light source, and a
                  blurred glow is the one effect this system removed everywhere
                  else. */}
              <Bot size={28} className="mb-4 text-status-ai" aria-hidden />
              <p className="text-lg font-medium">{getEmptyTitle(mode)}</p>
              <p className="mt-2 max-w-md text-sm text-muted-foreground">{getEmptySubtitle(mode, page)}</p>
              {mode === 'ask' && <AskExamplePrompts />}
            </div>
          )}

          {messages.map((msg, i) => (
            <MessageBubble
              key={msg.id}
              msg={msg}
              index={i}
              isLast={i === messages.length - 1}
              isStreaming={streamingHere}
              isThinking={thinkingHere}
              thinkingElapsed={thinkingElapsed}
              shouldReduceMotion={shouldReduceMotion}
              // #747: only the last bubble receives the batched in-flight
              // content; earlier (committed) bubbles keep a stable prop so
              // the memo comparator skips re-rendering them per flush.
              streamingContent={
                streamingHere && i === messages.length - 1 ? streamingContent : undefined
              }
            />
          ))}
          <div ref={messagesEndRef} />

          {/* Mode-specific post-message content */}
          {mode === 'improve' && <ImproveDiffView />}
          {mode === 'diagram' && <DiagramPreview />}
        </div>
      </div>

      {/* Mode-specific input bar — sticky at the bottom of the column, with a
          translucent backdrop.

          Its opaque UNDER-mask (bg-background, z-[-1]) is belt-and-braces for
          the same reason as the sub-header's above: it occluded chat content
          scrolling down behind the bar (#703), but since #1218 the message
          pane owns the scroller and this column does not scroll through the
          supported viewport range, so nothing reaches behind it. It goes back
          to doing real work at the extremes the sub-header's comment records
          (bars taller than the column, outer scroller re-engaged), and it
          costs one div, which is why it stays.

          inset-0, and no overhang in either direction. The block-end rule is
          the sharp one: an absolutely positioned mask past that edge grows the
          scroll container's scrollable overflow — the former -bottom-[100px]
          extension added ~100px of phantom scroll on every mode (#769) — and
          it would now do that to a container whose overflow is zero. The
          mirrored -bottom-5 this bug was originally filed with is exactly that
          mistake; the strip it aimed at is gone because nothing scrolls into
          it, not because something covers it. */}
      {/* Opaque, no blur — same reasoning as the sub-header above. */}
      <div className="sticky bottom-0 z-20 isolate -mx-1 bg-background px-1 py-1">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-[-1] bg-background"
        />
        <AssistantAttachmentsScope>
          {mode === 'ask' && <AskModeInput />}
          {mode === 'improve' && <ImproveModeInput />}
          {mode === 'generate' && <GenerateModeInput />}
          {mode === 'diagram' && <DiagramModeInput />}
        </AssistantAttachmentsScope>
      </div>
    </m.div>
  );
}
