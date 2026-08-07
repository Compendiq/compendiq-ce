import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { AlertTriangle, ChevronDown, Loader2, PanelRightClose, Send, Sparkles, X } from 'lucide-react';
import { useAiContext, type Message } from '../AiContext';
import { StreamingMessage } from '../StreamingMessage';
import { CitationChips } from '../CitationChips';
import { DiagramPreview } from '../modes';
import { AIThinkingBlob } from '../../../shared/components/feedback/AIThinkingBlob';
import { TypingIndicator } from '../../../shared/components/feedback/TypingIndicator';
import { useAutoGrowTextarea } from '../../../shared/hooks/use-auto-grow-textarea';
import { useAttachments } from '../../../shared/hooks/use-attachments';
import { DocumentUploadZone } from '../../../shared/components/upload/DocumentUploadZone';
import { ImageAttachZone, imageDisabledReason } from '../../../shared/components/upload/ImageAttachZone';
import { PROMPT_MAX_LENGTH } from '../modes/prompt-limits';
import {
  DEFAULT_IMPROVEMENT_TYPE, IMPROVEMENT_DESCRIPTIONS, IMPROVEMENT_TYPES, type ImprovementType,
} from '../improvement-types';
import { cn } from '../../../shared/lib/cn';
import { DOCK_CHIPS, improveChipHint } from './dock-chips';
import { DockDiffCard } from './DockDiffCard';
import { useDockActions } from './use-dock-actions';

/**
 * The assistant's contents — everything between the header and the composer.
 *
 * Extracted from `AiDock` when the mobile bottom sheet landed (#1126): the
 * assistant has two *containers* — a column beside the article at `md` and up,
 * a sheet over it below — but only ever one set of contents. Anything that
 * differs between the two forms belongs in the shell, not here.
 *
 * This is the only part of the dock that consumes `AiContext`, which is what
 * keeps the hoisted provider inert on article routes where the assistant was
 * never opened.
 */
/**
 * `variant`:
 *  - `column` — the standalone right-hand column (retired on desktop, kept for
 *    any caller that still wants a self-contained panel)
 *  - `sheet`  — the mobile bottom sheet
 *  - `tab`    — mounted inside ArticleRightPane as one of its three views. The
 *    pane supplies the header and the collapse control, so this variant renders
 *    neither; two stacked headers were the tell that a column had been stuffed
 *    into a tab.
 */
export function DockPanel({ onClose, variant = 'column' }: { onClose: () => void; variant?: 'column' | 'sheet' | 'tab' }) {
  const {
    page, pageId, messages, messagesEndRef, isStreaming, isThinking, thinkingElapsed,
    streamingContent, input, setInput, modelsError, refetchModels, model, chatVision,
    chatVisionModel, improvementType, setImprovementType,
  } = useAiContext();

  // Which improvement pass Improve will run is a *setting*, so it hides behind a
  // disclosure on the Improve chip rather than spending a permanent line of a
  // 420px column on five options most runs leave at `grammar` (#1177). Open
  // state is per-mount and deliberately not restored: a drawer that reopened
  // itself would cost the height it was designed to save.
  const [typesOpen, setTypesOpen] = useState(false);
  const typesPanelId = useId();
  const typesToggleRef = useRef<HTMLButtonElement>(null);
  const collapseTypes = useCallback(() => {
    setTypesOpen(false);
    typesToggleRef.current?.focus();
  }, []);

  // While the drawer is open, Escape belongs to the drawer: fold it away, hand
  // focus back to the caret, and let the *next* Escape close the assistant.
  //
  // Mounted on the split chip as well as on the drawer, because focus is
  // usually on neither's contents but on the caret itself — clicking a button
  // focuses it in every real browser (jsdom does not, which is why the first
  // version of this passed its test while failing in Chrome). A handler that
  // only listens inside the drawer misses the commonest route by construction,
  // and the panel root's Escape wins: the user presses it to tidy away a drawer
  // and loses the whole conversation.
  const handleTypesEscape = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== 'Escape' || !typesOpen) return;
    e.stopPropagation();
    collapseTypes();
  }, [typesOpen, collapseTypes]);

  // The retry chip replaces the whole row when the model list fails, taking the
  // caret with it. Drop the open state at the same time, or a later recovery
  // brings the drawer back unasked — the one thing the comment above promises
  // it will not do. The render guard below still stands: it covers the frame
  // between the failure and this effect.
  useEffect(() => {
    if (modelsError) setTypesOpen(false);
  }, [modelsError]);

  // Source material attached in the composer (#1131, #1154). Dock-local rather
  // than AiContext state: it is material for the *next* action, not part of the
  // conversation, and nothing outside this panel reads it.
  //
  // `useAttachments` owns the composer as a shared drop target, so a file can be
  // let go anywhere on the prompt box rather than onto a 28px paperclip, and one
  // router decides document-vs-image rather than each zone guessing. The image
  // half opens only once the resolved chat model has probed as vision-capable:
  // `chatVision` is tri-state, and anything other than a confirmed `true` keeps
  // intake shut — with the reason the user is shown coming from the same
  // function the trigger's tooltip uses.
  const composerBoxRef = useRef<HTMLDivElement>(null);
  const attachments = useAttachments({
    dropTargetRef: composerBoxRef,
    imageEnabled: chatVision === true,
    imageDisabledReason: imageDisabledReason(chatVision, chatVisionModel),
    disabled: isStreaming,
  });
  const {
    document: reference, image, pickFile, removeDocument, removeImage, clearAll, isDragOver,
    isExtracting, isPreparing, isBusy,
  } = attachments;

  const { ask, runChip } = useDockActions({
    referenceText: reference?.result.text,
    imageHandle: image?.handle,
    isBusy,
    onImageExpired: removeImage,
  });

  // A document or image attached while reading one page is not background for
  // the next one. Threads are retained per page; an attachment silently
  // following the user to a different document is exactly the kind of surprise
  // #1126 set out to remove, so both slots are dropped at the boundary instead.
  useEffect(() => {
    clearAll();
  }, [pageId, clearAll]);

  const handlePick = useCallback((file: File) => {
    void pickFile(file);
  }, [pickFile]);

  const composerRef = useAutoGrowTextarea(input);

  // Opening the assistant moves focus to the composer; closing it returns focus
  // to whatever opened it. The column form is a docked panel rather than a
  // modal, so it deliberately does not trap Tab — the article beside it must
  // stay reachable. The sheet form *is* modal and adds a trap around this, but
  // it leaves focus-in and focus-restore here: there is one composer to focus
  // and one opener to return to either way.
  //
  // Restoring is not simply "focus whatever was focused before", because
  // opening the assistant destroys its trigger in most layouts: the expanded
  // pane's "AI Assistant" row unmounts when the pane is forced to its rail, and
  // below 1100px — which includes every phone — the entire pane unmounts. For
  // those, by the time this effect's cleanup runs the opener is already
  // detached and focus has fallen to <body>, so restoring it would strand the
  // keyboard at the top of the document. Fall back to the equivalent control
  // that does survive, and only then to the article itself.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    composerRef.current?.focus();
    return () => {
      if (opener && opener !== document.body && opener.isConnected) {
        opener.focus();
        return;
      }
      // Whichever form of the article pane is on screen once the assistant has
      // gone — expanded row or 40px rail — carries this marker. Closing it
      // re-renders the pane in the same commit, so which one it is depends on
      // the user's own collapse preference and the viewport; the marker is on
      // both so the hand-off does not have to care.
      const assistantTrigger = document.querySelector<HTMLElement>('[data-ai-assistant-trigger]');
      if (assistantTrigger) {
        assistantTrigger.focus();
        return;
      }
      const main = document.querySelector<HTMLElement>('main');
      if (!main) return;
      // <main> is not focusable by default; making it programmatically
      // focusable is the skip-link idiom for exactly this kind of hand-off.
      main.tabIndex = -1;
      main.focus();
    };
  }, [composerRef]);

  // Nothing runs on open (#1176). The panel used to fire a seeded action here as
  // soon as a model resolved, which made opening the assistant and rewriting the
  // whole document the same gesture. Every request now starts at a chip or the
  // composer, where the user can see what they are asking for.

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter submits, Shift+Enter inserts a newline — the contract #1120
    // established for the Ask composer, in the surface where it matters most.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void ask();
    }
  };

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        // Stop the native event before it reaches the document-level shortcut
        // listener, which would otherwise also exit the article's edit mode.
        e.stopPropagation();
        onClose();
      }}
    >
      {/* Header — h-10 and px-3 exactly matching ArticleRightPane's
          "Properties" header, so the two panels share a baseline. Violet marks
          the surface as the AI one (ADR-010 v0.5); it never fills a control.

          Not rendered in the `tab` variant: the inspector already has a header
          naming the page and a collapse control, and the tab itself says
          "Assistant". */}
      {variant !== 'tab' && (
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 px-3">
        <span className="flex min-w-0 items-center gap-1.5">
          <Sparkles size={13} className="shrink-0 text-status-ai" aria-hidden />
          <span className="truncate text-xs font-semibold text-foreground">Assistant</span>
        </span>
        <button
          onClick={onClose}
          className="shrink-0 rounded-lg p-1 text-muted-foreground transition-colors hover:bg-[var(--glass-pill-hover)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Close AI assistant"
          title="Close assistant (Esc)"
          data-testid="ai-dock-close"
        >
          {/* The glyph names where the thing goes. `PanelRightClose` draws a
              right-hand column folding away, which is exactly what happens at
              md and up and exactly what does not happen to a sheet at the
              bottom of a phone — that one just closes. */}
          {variant === 'sheet' ? <X size={15} /> : <PanelRightClose size={14} />}
        </button>
      </div>
      )}

      {/* Streaming indicator: a violet hairline under the header, visible even
          when the thread is scrolled away from the in-flight answer. */}
      <div className="h-px shrink-0 bg-[var(--glass-sidebar-divider)]">
        {isStreaming && (
          <div className="h-px w-full animate-pulse bg-status-ai" role="status" aria-label="Assistant is responding" data-testid="ai-dock-streaming" />
        )}
      </div>

      {/* Primed live regions — same contract as /ai: the role must exist before
          the content arrives or assistive tech will not announce it. */}
      <div role="alert" data-testid="ai-dock-error-announcer" className="sr-only">
        {(() => {
          const lastError = [...messages].reverse().find((msg) => msg.isError);
          return lastError ? <span key={lastError.id}>{lastError.content}</span> : null;
        })()}
      </div>
      <div role="status" aria-live="polite" data-testid="ai-dock-answer-announcer" className="sr-only">
        {(() => {
          if (isStreaming) return null;
          const lastAnswer = [...messages].reverse().find((m2) => m2.role === 'assistant' && !m2.isError && m2.content);
          return lastAnswer ? <span key={lastAnswer.id}>Answer ready</span> : null;
        })()}
      </div>

      {/* Thread. `overscroll-contain` so reaching the end of the conversation
          does not chain the scroll into the article underneath — the sheet sits
          over the document, and scroll leaking through it would move the page
          the user is asking about out from under them. */}
      <div className="scroll-mask min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3" data-testid="ai-dock-thread">
        {messages.length === 0 && !isStreaming ? (
          <DockEmptyState pageTitle={page?.title} />
        ) : (
          <div className="space-y-4">
            {messages.map((msg, i) => (
              <DockMessage
                key={msg.id}
                msg={msg}
                isLast={i === messages.length - 1}
                isStreaming={isStreaming}
                isThinking={isThinking}
                thinkingElapsed={thinkingElapsed}
                streamingContent={i === messages.length - 1 ? streamingContent : undefined}
              />
            ))}
            <div ref={messagesEndRef} />
            {/* Artifacts belong to the assistant's turn, so they line up with
                its prose rather than the column edge: ml-7 is the avatar's
                20px plus the 8px gap. */}
            <div className="ml-7">
              <DockDiffCard onRerun={runChip} />
              <DiagramPreview />
            </div>
          </div>
        )}
      </div>

      {/* Composer block: chips, then the prompt. Chips are steel-outlined —
          steel is what "you can operate this" means under ADR-010 v0.5 — and
          take --color-border-interactive rather than the quiet hairline, which
          separators and pane edges use (WCAG 1.4.11). */}
      <div className="shrink-0 border-t border-border px-3 pb-3 pt-2.5">
        <div className="mb-2 flex flex-wrap gap-1.5">
          {modelsError ? (
            <button
              type="button"
              onClick={() => refetchModels()}
              title="Failed to load models from the LLM provider — click to retry"
              className="flex h-7 items-center gap-1.5 rounded-md border border-destructive/60 px-2.5 text-xs text-destructive transition-colors hover:bg-destructive/10"
            >
              <AlertTriangle size={12} aria-hidden /> Models unavailable — retry
            </button>
          ) : (
            DOCK_CHIPS.map(({ id, label, Icon, hint }) => {
              // Improve alone waits out an in-flight attachment: firing it now
              // would send the request without the reference text still being
              // extracted or the image still being staged (#940's lesson,
              // widened to both slots by #1154). The other three read no
              // attachment, so they stay live.
              const isImprove = id === 'improve';
              const disabled = isStreaming || !page || !model || (isImprove && isBusy);
              const chip = (
                <button
                  // Carries the array key for the other three chips; ignored
                  // for Improve, which returns it inside the keyed <div> below.
                  key={id}
                  type="button"
                  onClick={() => {
                    // The choice is committed the moment the run starts, so the
                    // drawer folds away with it and the column goes back to one
                    // row of chips. The thread jumps at the same instant (user
                    // turn plus placeholder), which absorbs the reflow.
                    if (isImprove) setTypesOpen(false);
                    void runChip(id);
                  }}
                  disabled={disabled}
                  title={isImprove ? improveChipHint(improvementType) : hint}
                  className={cn(
                    'flex h-7 items-center gap-1.5 rounded-md border border-border-interactive px-2.5 text-xs text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
                    // Half of a split control: the caret picks up the right end.
                    isImprove && 'relative rounded-r-none hover:z-10 focus-visible:z-10',
                  )}
                  data-testid={`ai-dock-chip-${id}`}
                >
                  <Icon size={12} aria-hidden /> {label}
                  {/* The type is spelled out exactly when it is news. Saying
                      "grammar" on every dock in the product would cost the row's
                      one spare line to repeat the documented default; saying
                      nothing after the user picked `structure` would leave a
                      chip that rewrites a page differently than it reads.

                      Steel marks the choice here and in the drawer, but by
                      different means, because the substrate differs: this is
                      bare text on the panel, so it takes `--color-primary-ink`,
                      the system's steel-as-a-text-colour token. The selected
                      option down there sits on a steel tint already and keeps
                      the neutral `text-action` — steel ink on a steel wash
                      loses the contrast the token exists to guarantee. */}
                  {isImprove && improvementType !== DEFAULT_IMPROVEMENT_TYPE && (
                    <span className="font-medium text-primary-ink" data-testid="ai-dock-improve-type-label">
                      · {improvementType}
                    </span>
                  )}
                </button>
              );
              if (!isImprove) return chip;
              return (
                // One flex item, so the row's `gap-1.5` never opens a seam
                // between the two halves and wrapping never splits them — and
                // one Escape handler, so the drawer absorbs the key from either
                // half rather than only from its own contents.
                <div key={id} className="flex" onKeyDown={handleTypesEscape}>
                  {chip}
                  <button
                    ref={typesToggleRef}
                    type="button"
                    onClick={() => setTypesOpen((open) => !open)}
                    // The caret shares Improve's disabled state rather than
                    // computing its own. They are one control, a half-lit split
                    // chip reads as a rendering fault, and every reason Improve
                    // is unavailable — no page, no model, an attachment still
                    // staging, a stream in flight — is a moment when there is
                    // nothing yet to configure.
                    disabled={disabled}
                    aria-expanded={typesOpen}
                    // Only while the drawer exists. `aria-controls` pointing at
                    // an unrendered id is a dangling reference, and the two
                    // other AI disclosures in the app (`bubble-ai-trigger`,
                    // `block-ai-trigger`) already gate it the same way.
                    aria-controls={typesOpen ? typesPanelId : undefined}
                    aria-label={`Improvement type: ${improvementType}`}
                    title={`${improvementType} — ${IMPROVEMENT_DESCRIPTIONS[improvementType]}`}
                    // -ml-px collapses the two 1px borders into the single hairline
                    // that makes the pair read as one chip; z-10 on hover/focus
                    // lifts whichever half is being addressed so its own border
                    // and ring win over its neighbour's.
                    className="relative -ml-px flex h-7 w-7 items-center justify-center rounded-md rounded-l-none border border-border-interactive text-muted-foreground transition-colors hover:z-10 hover:bg-foreground/5 hover:text-foreground focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                    data-testid="ai-dock-improve-types-toggle"
                  >
                    <ChevronDown
                      size={12}
                      aria-hidden
                      className={cn(
                        'transition-transform duration-200 motion-reduce:transition-none',
                        typesOpen && 'rotate-180',
                      )}
                    />
                  </button>
                </div>
              );
            })
          )}
        </div>

        {!modelsError && typesOpen && (
          <ImprovementTypeDrawer
            id={typesPanelId}
            value={improvementType}
            onChange={setImprovementType}
            disabled={isStreaming || !page || !model || isBusy}
            onKeyDown={handleTypesEscape}
          />
        )}

        {/* An advisory, not a refusal: the backend accepts both, and only the
            resolved model knows whether they fit. Amber is the attention colour
            under ADR-010 v0.5 and this is exactly that. It sits above the
            composer, not inside it: it is about the pair of attachments rather
            than either one, so it belongs beside neither zone's row — and a
            full-width paragraph among those rows would push the field away from
            the cards it describes. */}
        {reference && image && (
          <p
            className="mb-2 flex items-center gap-1.5 text-xs text-warning"
            data-testid="ai-dock-attachment-context-warning"
          >
            <AlertTriangle size={12} className="shrink-0" aria-hidden />
            Both attachments will be sent to Improve — a small model may not fit them.
          </p>
        )}

        {/* flex-wrap so each zone's row — its card or drop hint plus its own
            trigger — stacks above the prompt inside the same box. An attachment
            belongs to what you are about to send, so it lives in the thing you
            send from, not in a band above it.
            Document order is the only order here: no `order-*` on any child,
            because that is what keeps the tab sequence matching what the eye
            reads (WCAG 2.4.3 — see `composerRowClass`). Anything added below
            lands where its markup sits, so put it where it should be read. */}
        <div className="nm-composer flex-wrap" ref={composerBoxRef}>
          <DocumentUploadZone
            variant="composer"
            onPick={handlePick}
            isExtracting={isExtracting}
            extracted={reference?.result ?? null}
            filename={reference?.filename ?? null}
            onRemove={removeDocument}
            disabled={isStreaming}
            triggerLabel="Attach a document as reference for Improve"
            usageHint="reference for Improve"
            isDragOver={isDragOver}
            testIdPrefix="ai-dock-doc"
          />
          {/* Prefixed like the document zone above it: within one composer the
              two halves should be selectable the same way, and the dock is the
              one surface where a zone can sit beside an unrelated one. `/ai`'s
              two modes keep the components' defaults.

              Both zones name Improve, because in this composer neither
              attachment reaches Send: `ask()` posts to `/llm/ask`, which takes
              a reference text and an image handle from nobody — wiring either
              in would be a 400, not a feature. So the honesty is in the copy,
              on the trigger and again on the card, the way #1131 already
              handled the identical asymmetry for the document half. */}
          <ImageAttachZone
            vision={chatVision}
            visionModel={chatVisionModel}
            image={image}
            onPick={handlePick}
            onRemove={removeImage}
            isPreparing={isPreparing}
            disabled={isStreaming}
            triggerLabel="Attach an image as reference for Improve"
            usageHint="reference for Improve"
            testIdPrefix="ai-dock-image"
          />
          <textarea
            ref={composerRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={page ? 'Ask about this page…' : 'Ask a question…'}
            maxLength={PROMPT_MAX_LENGTH}
            rows={1}
            disabled={isStreaming}
            aria-label="Ask the assistant about this page"
            // The composer wrapper owns the inset surface, border and focus
            // ring; resize-none because the auto-grow hook owns the height.
            className="min-w-0 grow basis-40 resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground/70 disabled:opacity-50"
            data-testid="ai-dock-input"
          />
          <button
            onClick={() => void ask()}
            disabled={isStreaming || !input.trim() || !model}
            aria-label={isStreaming ? 'Sending…' : 'Send message'}
            className="flex shrink-0 self-end items-center rounded-md border border-primary bg-primary px-2.5 py-1.5 text-sm font-medium text-primary-foreground transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            data-testid="ai-dock-send"
          >
            {isStreaming ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Improvement type
// ---------------------------------------------------------------------------

interface ImprovementTypeDrawerProps {
  id: string;
  value: ImprovementType;
  onChange: (value: ImprovementType) => void;
  disabled: boolean;
  /**
   * Escape handling, owned by `DockPanel` and mounted on the split chip too —
   * the drawer is only one of the two places focus can be while it is open.
   */
  onKeyDown: (e: React.KeyboardEvent) => void;
}

/**
 * The five improvement passes, restored to the dock (#1177).
 *
 * `/ai`'s `ImproveTypeSelector` is a card with a heading, h-7 chips and a
 * caption — the proportions of a control that owns its own screen. Here the
 * same five options are a drawer that opens out of the Improve chip and closes
 * when the run starts, so the resting state of a 420px column is still one row
 * of chips.
 *
 * The border grammar is the dock's, not the selector's: unselected options take
 * `--color-border-interactive` like every other operable edge in the panel
 * (WCAG 1.4.11), and the selected one takes `nm-pill-active` — the same pressed
 * steel the sidebar and the article rail use for "this is the one", which also
 * brings its own `forced-colors: active` treatment. The quiet `--color-border`
 * appears once, around the drawer itself, because that is a grouping surface
 * rather than something you press.
 *
 * `nm-pill-active text-action` is the pairing every selected pill in the app
 * uses (`SidebarTreeView`, `DndLocalSpaceTree`, `ArticleRightPane`,
 * `CommentsSidebar`). The steel is the tint and the border; the label stays
 * neutral, because `nm-pill-active`'s own `color: var(--color-primary)` would
 * put steel ink on a steel wash.
 */
function ImprovementTypeDrawer({ id, value, onChange, disabled, onKeyDown }: ImprovementTypeDrawerProps) {
  return (
    <div
      id={id}
      role="group"
      aria-label="Improvement type"
      onKeyDown={onKeyDown}
      className="mb-2 rounded-lg border border-border bg-foreground/[0.03] px-2 py-2"
      data-testid="ai-dock-improve-types"
    >
      <div className="flex flex-wrap gap-1">
        {IMPROVEMENT_TYPES.map((type) => {
          const selected = value === type;
          return (
            <button
              key={type}
              type="button"
              onClick={() => onChange(type)}
              disabled={disabled}
              // Kept from `ImproveTypeSelector` verbatim: five toggles reporting
              // their own pressed state, each carrying its description, is what
              // a screen reader gets on `/ai` and there is no reason for the
              // dock to announce the same choice differently.
              aria-pressed={selected}
              title={IMPROVEMENT_DESCRIPTIONS[type]}
              className={cn(
                'flex h-6 items-center rounded-md px-2 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
                selected
                  ? 'nm-pill-active font-medium text-action'
                  : 'border border-border-interactive text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
              )}
              data-testid={`ai-dock-improve-type-${type}`}
            >
              {/* Lower case, like the turn these produce in the thread
                  ("Improve this page (structure).") and like the chip's own
                  suffix. They are parameters, not headings. */}
              {type}
            </button>
          );
        })}
      </div>
      {/* Five one-word options need the sentence that `/ai` prints under them —
          "technical" and "completeness" are not self-explanatory, and a `title`
          alone is unreachable by touch. It costs one line, and only while the
          drawer the user opened is open. */}
      <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
        {IMPROVEMENT_DESCRIPTIONS[value]}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function DockEmptyState({ pageTitle }: { pageTitle: string | undefined }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-2 text-center" data-testid="ai-dock-empty">
      {/* A plain glyph, not a glowing disc. This was a 56px blurred halo behind
          a ringed circle behind the icon — three stacked decorations to say
          "AI", in the one panel whose job is to get out of the way until it has
          something to show. Violet still marks AI (ADR-010); it just does not
          need a light source to do it. */}
      <Sparkles size={20} className="mb-3 text-status-ai" aria-hidden />
      {/* The headline names the scope rather than repeating the composer's
          own placeholder back at the reader. On a 420px column the page title
          is the one piece of orientation worth spending two lines on: it is
          the answer to "what is this assistant attached to?". */}
      <p className="line-clamp-2 max-w-[24ch] text-sm font-medium text-foreground">
        {pageTitle ?? 'No page open'}
      </p>
      <p className="mt-1.5 max-w-[32ch] text-balance text-xs leading-relaxed text-muted-foreground">
        {pageTitle
          ? 'Ask about it, or pick an action.'
          : 'The assistant works on the article you are reading.'}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One turn
// ---------------------------------------------------------------------------

interface DockMessageProps {
  msg: Message;
  isLast: boolean;
  isStreaming: boolean;
  isThinking: boolean;
  thinkingElapsed: boolean;
  streamingContent?: string;
}

/**
 * A single turn, sized for a 420px column.
 *
 * `/ai`'s MessageBubble gives every turn a 32px avatar and caps bubbles at 80%
 * width; here that would spend a tenth of the column on repeated ornament. The
 * user's turn is a right-aligned steel-tinted bubble, the assistant's is
 * flush-left prose behind one small violet mark — the asymmetry alone says who
 * is speaking, which is what a narrow column needs.
 */
function DockMessage({ msg, isLast, isStreaming, isThinking, thinkingElapsed, streamingContent }: DockMessageProps) {
  if (msg.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[88%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-primary/12 px-3 py-2 text-sm text-foreground">
          {msg.content}
        </div>
      </div>
    );
  }

  const isLastAssistant = isLast;
  const isStreamingThis = isStreaming && isLastAssistant;
  const content = isStreamingThis ? (streamingContent ?? msg.content) : msg.content;
  const showThinkingBlob = isThinking && isLastAssistant && !content && thinkingElapsed;
  const showTypingIndicator = isThinking && isLastAssistant && !content && !thinkingElapsed;

  return (
    <div className="flex gap-2">
      <span
        className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-status-ai/12 ring-1 ring-status-ai/25"
        aria-hidden
      >
        <Sparkles size={11} className="text-status-ai" />
      </span>
      <div className="min-w-0 flex-1">
        {showThinkingBlob && <AIThinkingBlob active />}
        {showTypingIndicator && (
          <TypingIndicator
            dotClassName="bg-status-ai/60"
            testId="ai-dock-typing"
            label="Assistant is typing"
          />
        )}
        {msg.isError ? (
          <p
            className="rounded-lg border border-destructive/40 bg-destructive/10 px-2.5 py-2 text-sm text-destructive"
            data-testid="message-error"
          >
            {msg.content}
          </p>
        ) : (
          content && <StreamingMessage content={content} isStreaming={isStreamingThis} />
        )}
        {msg.sources && msg.sources.length > 0 && (
          <div className="mt-2">
            <CitationChips sources={msg.sources} />
          </div>
        )}
      </div>
    </div>
  );
}
