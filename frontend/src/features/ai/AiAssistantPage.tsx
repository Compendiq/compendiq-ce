import { memo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { m, useReducedMotion } from 'framer-motion';
import {
  Bot, User, Loader2, MessageSquare, Brain, AlertTriangle,
  Sparkles, Network, FileText, X,
} from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '../../shared/lib/cn';
import { ConfidenceBadge } from '../../shared/components/badges/ConfidenceBadge';
import { AIThinkingBlob } from '../../shared/components/feedback/AIThinkingBlob';
import { TypingIndicator } from '../../shared/components/feedback/TypingIndicator';
import { SourceCitations } from './SourceCitations';
import { CitationChips } from './CitationChips';
import { averageSourceSimilarity } from './source-confidence';
import { StreamingMessage } from './StreamingMessage';
import { useAiContext, type Mode, type Message } from './AiContext';
import {
  AskModeInput, AskExamplePrompts, ASK_EMPTY_TITLE, ASK_EMPTY_SUBTITLE,
  ImproveTypeSelector, ImproveDiffView, ImproveModeInput, IMPROVE_EMPTY_TITLE, improveEmptySubtitle,
  GenerateModeInput, GENERATE_EMPTY_TITLE, GENERATE_EMPTY_SUBTITLE,
  SummarizeModeInput, SUMMARIZE_EMPTY_TITLE, summarizeEmptySubtitle,
  DiagramTypeSelector, DiagramPreview, DiagramModeInput, DIAGRAM_EMPTY_TITLE, diagramEmptySubtitle,
  QualityModeInput, QUALITY_EMPTY_TITLE, qualityEmptySubtitle,
} from './modes';
import { isZeroEmbeddings } from '../../shared/hooks/use-pages';
import { SETTINGS_PANELS } from '../settings/settings-nav';
import { ShortcutHint } from '../../shared/components/ShortcutHint';

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
  isLight: boolean;
  shouldReduceMotion: boolean | null;
  /**
   * rAF-batched content of the in-flight answer (#747). Only passed to the
   * last message bubble while streaming; committed messages render msg.content.
   */
  streamingContent?: string;
}

const MessageBubble = memo(function MessageBubble({
  msg, index, isLast, isStreaming, isThinking, thinkingElapsed, isLight, shouldReduceMotion, streamingContent,
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
              : 'bg-foreground/5',
        )}
        // No role="alert" here: the role and the error content would arrive
        // in the same render, which AT generally does not announce (MDN alert
        // role). The primed announcer next to the message list handles SR
        // announcement; this bubble is the visual surface only.
        data-testid={msg.isError ? 'message-error' : undefined}
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
            <div className={cn('prose prose-sm max-w-none', !isLight && 'prose-invert')}>
              <TypingIndicator />
            </div>
          ) : null)
        ) : msg.isError ? (
          // Error messages render as plain text (not Markdown) so the
          // destructive color isn't overridden by the prose styles.
          <p className="text-destructive">{msg.content}</p>
        ) : (
          <div className={cn('prose prose-sm max-w-none', !isLight && 'prose-invert')}>
            {msg.content ? (
              <Markdown remarkPlugins={[remarkGfm]}>{msg.content}</Markdown>
            ) : null}
          </div>
        )}
        {msg.role === 'assistant' && msg.sources && msg.sources.length > 0 && (
          <div className="mt-3 space-y-2">
            <div className="flex items-center gap-2">
              {(() => {
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
  if (prev.msg.sources !== next.msg.sources) return false;
  if (prev.isLast !== next.isLast) return false;
  if (prev.isStreaming !== next.isStreaming) return false;
  if (prev.streamingContent !== next.streamingContent) return false;
  if (prev.isThinking !== next.isThinking) return false;
  if (prev.thinkingElapsed !== next.thinkingElapsed) return false;
  if (prev.isLight !== next.isLight) return false;
  return true;
});

// ---------------------------------------------------------------------------
// Mode button definitions
// ---------------------------------------------------------------------------

/**
 * The tabs `/ai` offers (#1126).
 *
 * Improve, Summarize, Diagram and Quality are gone from this list: they act on
 * an open document, and the dock is where a document is open. Leaving them here
 * would advertise six modes on a route that cannot show you the page they
 * operate on, beside a dock offering four chips for the same jobs — two
 * surfaces for one task, with no signal which is canonical.
 *
 * Their screens below are NOT removed. `/ai?mode=improve&pageId=…` still
 * renders Improve in full, so bookmarks and any link made before this change
 * keep working. Nothing in the app builds such a URL any more, and
 * SidebarTreeView never did: its `isAiRoute` re-navigation is `/ai?pageId=…`
 * with `replace: true`, which drops a `mode=` rather than carrying one, and
 * AiContext reads the mode-less result as Ask. Retiring those screens is a
 * separate change, once nothing is observed reaching them.
 */
const MODE_BUTTONS: Array<{ key: Mode; icon: typeof MessageSquare; label: string }> = [
  { key: 'ask', icon: MessageSquare, label: 'Q&A' },
  { key: 'generate', icon: Sparkles, label: 'Generate' },
];

// ---------------------------------------------------------------------------
// Empty state text per mode
// ---------------------------------------------------------------------------

function getEmptyTitle(mode: Mode): string {
  switch (mode) {
    case 'ask': return ASK_EMPTY_TITLE;
    case 'improve': return IMPROVE_EMPTY_TITLE;
    case 'generate': return GENERATE_EMPTY_TITLE;
    case 'summarize': return SUMMARIZE_EMPTY_TITLE;
    case 'diagram': return DIAGRAM_EMPTY_TITLE;
    case 'quality': return QUALITY_EMPTY_TITLE;
  }
}

function getEmptySubtitle(mode: Mode, page: { title: string } | undefined): string {
  switch (mode) {
    case 'ask': return ASK_EMPTY_SUBTITLE;
    case 'improve': return improveEmptySubtitle(page);
    case 'generate': return GENERATE_EMPTY_SUBTITLE;
    case 'summarize': return summarizeEmptySubtitle(page);
    case 'diagram': return diagramEmptySubtitle(page);
    case 'quality': return qualityEmptySubtitle(page);
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
    mode, setMode, page, pageHasChildren,
    messages, messagesEndRef, isStreaming, isThinking, thinkingElapsed,
    streamingContent,
    model, models, setModel, modelsError, refetchModels, isLight,
    includeSubPages, setIncludeSubPages,
    thinkingMode, setThinkingMode,
    embeddingStatus,
  } = ctx;

  const shouldReduceMotion = useReducedMotion();
  const [searchParams, setSearchParams] = useSearchParams();
  // False when a `?mode=` deep link put us on one of the four document screens
  // that no longer have a tab here (#1126).
  const modeHasTab = MODE_BUTTONS.some((b) => b.key === mode);

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
      {/* Sticky sub-header: mode selector | context + options.
          Sits at top-0 of the column so it stays visible as messages grow.

          The opaque UNDER-mask (bg-background, z-[-1]) behind the translucent
          bar is belt-and-braces through the supported viewport range, not
          load-bearing. It was what occluded chat content scrolling up behind
          the bar (#703) — but since #1218 the message pane owns the scroller
          and this column does not scroll, so nothing passes behind the bar to
          occlude. Do not read a live mask as evidence that it still does.

          It is not decorative at the extremes, which is the other half of why
          it stays: both bars are content-sized and cannot shrink, so once they
          plus the two gaps exceed the column, the outer scroller re-engages
          and they scroll over each other. Measured at 1280x300 with the
          composer at AUTO_GROW_MAX_HEIGHT: pane 0px, outer overflow 34px,
          growing to 134px at 1280x200. No message bleed there — the pane has
          no height to show one — but the mask is doing work again. It also
          costs one div, and it is what keeps #703 from returning if a future
          change re-engages outer scrolling in the ordinary range.

          It covers exactly the bar's box (inset-0), and that constraint still
          binds: an absolutely positioned mask overflowing the block-end edge
          creates scrollable overflow in a container that now has none, which
          is #769's phantom scroll re-opened on a page that had stopped
          scrolling entirely. Note the bar does NOT pin flush at the scrollport
          edge — a sticky box is clamped to its containing block, which begins
          after the scroll container's padding (#1186). What removed the live
          strip that gap used to expose is the min-h-0 chain, not this mask.

          Visual grammar: two clear groups separated by a thin divider.
          Group A (left): which mode are we in. Inset segmented control.
          Group B (right): what's the model + what's the context window +
            what options are on. Outlined chips of uniform 28 px height. */}
      {/* Opaque, no blur. The `inset-0` under-mask directly below already
          guarantees occlusion, so `bg-background/85 backdrop-blur` on the bar
          itself was belt-and-braces over something already solid — and blur is
          the most expensive thing the compositor does, here on a bar that is
          composited on every scroll frame. (Missed by the glass sweep: its
          regex required a suffix, `backdrop-blur-sm`, and this is the bare
          utility.) */}
      <div className="sticky top-0 z-20 isolate -mx-1 space-y-3 bg-background px-1 py-1">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-[-1] bg-background"
      />
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2 rounded-xl border border-border bg-card px-3 py-2">
        {/* Group A — mode segmented control */}
        {/* Horizontally scrollable below the width that fits all six modes.
            At 390px the row previously cut off mid-word after "Summar…", so
            Diagram and Quality were unreachable with no scroll cue at all —
            two of six modes simply did not exist on a phone. snap-x keeps the
            tabs from resting half-visible; the edge mask signals there is more
            to the right. Arrow-key navigation still reaches every tab, moving
            focus with the selection so the focused tab is the visible one. */}
        <div
          role="tablist"
          aria-label="AI mode"
          data-testid="ai-mode-tablist"
          className="flex max-w-full snap-x snap-mandatory items-center gap-0.5 overflow-x-auto rounded-lg bg-foreground/[0.04] p-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [mask-image:linear-gradient(to_right,transparent_0,black_12px,black_calc(100%-12px),transparent_100%)]"
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
              e.preventDefault();
              const keys = MODE_BUTTONS.map((b) => b.key);
              const idx = keys.indexOf(mode);
              const next = e.key === 'ArrowRight'
                ? (idx + 1) % keys.length
                : (idx - 1 + keys.length) % keys.length;
              const nextKey = keys[next];
              if (nextKey) {
                setMode(nextKey);
                // Move DOM focus along with the selection. These tabs use a
                // roving tabindex, so selecting without focusing strands focus
                // on a tab that just became tabIndex={-1} — and once the row
                // scrolls, off-screen as well: the highlighted tab and the
                // focused one were different tabs. preventScroll + an explicit
                // scrollIntoView keeps the correction horizontal, inside the
                // tablist, instead of letting the browser jump the page.
                const nextTab = e.currentTarget.querySelector<HTMLElement>(
                  `[data-mode-tab="${nextKey}"]`,
                );
                nextTab?.focus({ preventScroll: true });
                nextTab?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
              }
            }
          }}
        >
          {MODE_BUTTONS.map(({ key, icon: Icon, label }, i) => (
            <button
              key={key}
              role="tab"
              data-mode-tab={key}
              aria-selected={mode === key}
              // A `?mode=` deep link can put `mode` on a document screen that
              // has no tab here. Without this fallback every tab would be
              // tabIndex={-1} and the roving-tabindex tablist would have no
              // keyboard entry point at all (WCAG 2.1.1) — someone following an
              // old bookmark could not reach Q&A or Generate without editing
              // the URL. Arrow keys recover too: indexOf(mode) is -1, so either
              // arrow lands on the first tab.
              tabIndex={mode === key || (!modeHasTab && i === 0) ? 0 : -1}
              onClick={() => setMode(key)}
              className={cn(
                'flex h-7 shrink-0 snap-start items-center gap-1.5 rounded-md px-2.5 text-sm transition-colors',
                mode === key
                  // `panel-tab-active` is the one active-segment treatment in
                  // the system, shared with the inspector's view switcher, the
                  // main nav and Settings' sub-tabs. This was a second copy of
                  // the retired v0.5 shape — a tinted pane carrying `shadow-sm`
                  // and a primary ring — which is how the same control ended up
                  // looking different on four routes.
                  ? 'panel-tab-active font-medium'
                  : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
              )}
            >
              <Icon size={14} /> {label}
            </button>
          ))}
        </div>

        <div className="flex-1" />

        {/* Group B — context + options. Each chip is 28 px tall (h-7),
            border-border at rest, tinted on active. The divider between
            the model dropdown and the toggles separates "infrastructure" the
            user sets once from "context flags" they flip per question. */}
        <div className="flex flex-wrap items-center gap-1.5">
          {modelsError ? (
            // Models fetch failed (LLM provider down / unreachable): surface
            // the failure with a retry affordance instead of spinning forever.
            <button
              type="button"
              onClick={() => refetchModels()}
              title="Failed to load models from the LLM provider — click to retry"
              className="flex h-7 items-center gap-1.5 rounded-md border border-destructive/40 px-2.5 text-xs text-destructive transition-colors hover:bg-destructive/10"
            >
              <AlertTriangle size={12} /> Models unavailable — retry
            </button>
          ) : models.length === 0 ? (
            <span className="flex h-7 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs text-muted-foreground">
              <Loader2 size={12} className="animate-spin" /> Loading models...
            </span>
          ) : (
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              aria-label="LLM model"
              title="LLM model"
              className="nm-select"
            >
              {models
                .filter((m) => !m.name.includes('embed'))
                .map((m) => (
                  <option key={m.name} value={m.name}>{m.name}</option>
                ))}
            </select>
          )}

          {/* Context chip (#1126). The original was a static <span> naming a
              page you could not click, clear, or change — the literal "context
              is invisible and unswitchable" defect. Deleting it outright was
              wrong: SidebarTreeView still navigates `/ai?pageId=…` and Ask
              still sends that id, so answers stayed scoped to a page the UI no
              longer mentioned. It is back as a real control — it names the
              scope and clears it. */}
          {page && (
            <button
              type="button"
              onClick={() => {
                const next = new URLSearchParams(searchParams);
                next.delete('pageId');
                setSearchParams(next, { replace: true });
              }}
              className="flex h-7 items-center gap-1.5 rounded-md border border-border-interactive bg-foreground/[0.03] px-2.5 text-xs text-muted-foreground transition-colors hover:bg-foreground/[0.07] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              title={`Answers are scoped to "${page.title}" — click to clear`}
              data-testid="ai-context-chip"
            >
              <FileText size={12} aria-hidden />
              <span className="max-w-[180px] truncate">{page.title}</span>
              <X size={12} aria-hidden />
            </button>
          )}

          {page && pageHasChildren && (
            <label
              className={cn(
                'flex h-7 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 text-xs transition-colors',
                includeSubPages
                  ? 'border-primary/45 bg-primary/12 text-primary-ink'
                  : 'border-border text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
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
              <Network size={12} />
              <span>+ Sub-pages</span>
            </label>
          )}

          {/* Divider between "what model + what context" and "what options". */}
          <span aria-hidden className="mx-0.5 h-5 w-px bg-border/50" />

          {/* Thinking mode toggle (#20). Always render the resting surface so
              the affordance reads as a toggle rather than collapsing into a
              label-with-icon when off. */}
          <label
            className={cn(
              'flex h-7 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 text-xs transition-colors',
              thinkingMode
                ? 'border-status-ai/45 bg-status-ai/15 text-status-ai'
                : 'border-border text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
            )}
            title={thinkingMode
              ? 'Extended thinking is on — responses take longer but reason more carefully'
              : 'Enable extended thinking for more thorough responses'}
          >
            <input
              type="checkbox"
              checked={thinkingMode}
              onChange={(e) => setThinkingMode(e.target.checked)}
              className="sr-only"
              aria-label="Thinking mode"
            />
            <Brain size={12} />
            <span>Think</span>
          </label>
        </div>
      </div>

      {/* Arrived on a document screen from an old `?mode=` link. Say so, rather
          than leaving a tablist with nothing selected looking broken (#1126). */}
      {!modeHasTab && (
        <p
          className="rounded-xl border border-border bg-card px-3 py-2 text-xs text-muted-foreground"
          data-testid="ai-legacy-mode-notice"
        >
          This view moved into the assistant that opens beside an article. Open the page and press{' '}
          <ShortcutHint shortcutId="ai-assistant" /> — or pick Q&amp;A or Generate above.
        </p>
      )}

      {/* Mode-specific type selectors — included in the sticky header so
          they stay alongside the tabs while scrolling. */}
      {mode === 'improve' && <ImproveTypeSelector />}
      {mode === 'diagram' && <DiagramTypeSelector />}
      </div>

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
          return lastAnswer ? <span key={lastAnswer.id}>Answer ready</span> : null;
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
      <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-border bg-card" data-testid="ai-message-pane">
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
          {messages.length === 0 && (
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
              isStreaming={isStreaming}
              isThinking={isThinking}
              thinkingElapsed={thinkingElapsed}
              isLight={isLight}
              shouldReduceMotion={shouldReduceMotion}
              // #747: only the last bubble receives the batched in-flight
              // content; earlier (committed) bubbles keep a stable prop so
              // the memo comparator skips re-rendering them per flush.
              streamingContent={i === messages.length - 1 ? streamingContent : undefined}
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
        {mode === 'ask' && <AskModeInput />}
        {mode === 'improve' && <ImproveModeInput />}
        {mode === 'generate' && <GenerateModeInput />}
        {mode === 'summarize' && <SummarizeModeInput />}
        {mode === 'diagram' && <DiagramModeInput />}
        {mode === 'quality' && <QualityModeInput />}
      </div>
    </m.div>
  );
}
