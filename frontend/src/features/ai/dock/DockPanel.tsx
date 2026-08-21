import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, PanelRightClose, Paperclip, Send, Sparkles, Square, X } from 'lucide-react';
import { SUPPORTED_DOCUMENT_FORMATS, SUPPORTED_IMAGE_FORMATS } from '@compendiq/contracts';
import { useAiContext, type Message } from '../AiContext';
import { StreamingMessage } from '../StreamingMessage';
import { CitationChips } from '../CitationChips';
import { DiagramPreview } from '../modes';
import { AIThinkingBlob } from '../../../shared/components/feedback/AIThinkingBlob';
import { TypingIndicator } from '../../../shared/components/feedback/TypingIndicator';
import { useAutoGrowTextarea } from '../../../shared/hooks/use-auto-grow-textarea';
import { buildDocumentReferenceText, useAttachments } from '../../../shared/hooks/use-attachments';
import { DocumentUploadZone } from '../../../shared/components/upload/DocumentUploadZone';
import { ImageAttachZone, imageDisabledReason } from '../../../shared/components/upload/ImageAttachZone';
import { PROMPT_MAX_LENGTH } from '../modes/prompt-limits';
import { DeepSearchToggle } from '../DeepSearchToggle';
import { RefusalMark, RefusalSourcesLabel, REFUSAL_ANNOUNCEMENT } from '../refusal';
import { DockDiffCard } from './DockDiffCard';
import { DockDraftCard } from './DockDraftCard';
import { useDockActions } from './use-dock-actions';
import { AssistantActionSelect, resolveAssistantAction } from '../AssistantActionSelect';
import { CREATE_SKILLS, getCreateSkill, type CreateSkillId } from '../create-skills';
import { cn } from '../../../shared/lib/cn';

// This filter helps native file pickers offer the full attachment surface. It
// does not decide what is accepted: `useAttachments` routes and validates the
// selected files, including the chat model's vision capability.
const ATTACHMENT_ACCEPT = [
  ...SUPPORTED_DOCUMENT_FORMATS.map((format) => `.${format}`),
  '.markdown', '.text', '.yml', '.yaml',
  ...SUPPORTED_IMAGE_FORMATS.map((format) => `image/${format}`),
  '.png', '.jpg', '.jpeg', '.webp', '.gif',
].join(',');

function DockAttachmentPicker({
  onPickFiles,
  disabled,
}: {
  onPickFiles: (files: readonly File[]) => void;
  disabled: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="flex shrink-0 items-center self-end">
      <input
        ref={inputRef}
        type="file"
        accept={ATTACHMENT_ACCEPT}
        multiple
        className="hidden"
        onChange={(event) => {
          onPickFiles(Array.from(event.target.files ?? []));
          event.target.value = '';
        }}
        data-testid="ai-dock-attach-file-input"
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={disabled}
        aria-label="Attach a document or image"
        title="Attach a document or image"
        className="flex shrink-0 items-center rounded-md border border-transparent px-2 py-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
        data-testid="ai-dock-attach-button"
      >
        <Paperclip size={16} aria-hidden />
      </button>
    </div>
  );
}

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
    chatVisionModel, mode, setMode, improvementType, createSkill, setCreateSkill, abortRef,
  } = useAiContext();
  const selectedAction = resolveAssistantAction(mode, improvementType, createSkill);
  const isCreateAction = selectedAction.startsWith('create-') || selectedAction === 'generate';
  const currentSkill = isCreateAction && createSkill ? getCreateSkill(createSkill) : undefined;

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
    disabled: isStreaming || selectedAction === 'diagram',
  });
  const {
    documents: references, image, pickFiles, removeDocument, removeImage, clearAll, isDragOver,
    isExtracting, isPreparing, isBusy,
  } = attachments;

  /**
   * #1112's multi-query expansion, opted into for ONE question (#1119).
   *
   * Panel-local `useState`, next to the attachments and for the same reason:
   * it is state of the next request, not of the conversation. Two stores were
   * available and both are wrong. `AiContext` is where the sticky options live
   * (`thinkingMode` is written to localStorage, `includeSubPages` survives every
   * ask and every page change), and `AiThread` retains 12 threads' `input`, so
   * a field there would make the toggle per-conversation sticky. Even
   * `ai-dock-store` — deliberately ephemeral already — is off limits: a store
   * is a thing later work persists, and this flag must not become persistable
   * by accident. `ask()` clears it at submit; a remount clears it too.
   */
  const [deepSearch, setDeepSearch] = useState(false);
  const clearDeepSearch = useCallback(() => setDeepSearch(false), []);

  const { ask, runChip, runCreateSkill } = useDockActions({
    referenceText: buildDocumentReferenceText(references),
    imageHandle: image?.handle,
    isBusy,
    onImageExpired: removeImage,
    onImageConsumed: removeImage,
    deepSearch,
    onDeepSearchConsumed: clearDeepSearch,
  });

  const sendSelectedAction = useCallback(() => {
    if (selectedAction === 'ask') return ask();
    if (selectedAction === 'diagram') return runChip('diagram');
    if (selectedAction.startsWith('create-')) {
      const skillId = selectedAction.replace('create-', '') as CreateSkillId;
      return runCreateSkill(skillId);
    }
    if (selectedAction === 'generate') {
      return runCreateSkill('custom');
    }
    return runChip('improve');
  }, [selectedAction, ask, runChip, runCreateSkill]);

  // A document or image attached while reading one page is not background for
  // the next one. Threads are retained per page; an attachment silently
  // following the user to a different document is exactly the kind of surprise
  // #1126 set out to remove, so both slots are dropped at the boundary instead.
  useEffect(() => {
    clearAll();
    // Same boundary, same argument: the toggle describes the question you were
    // about to ask about the page you were reading. Carrying it to the next
    // document would be the quiet stickiness this feature must not have.
    clearDeepSearch();
  }, [pageId, clearAll, clearDeepSearch]);

  const handlePickFiles = useCallback((files: readonly File[]) => {
    void pickFiles(files);
  }, [pickFiles]);

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
      void sendSelectedAction();
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
          className="shrink-0 rounded-lg p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
      <div className="h-px shrink-0 bg-border">
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
          if (!lastAnswer) return null;
          // The same verdict `/ai`'s announcer reaches, and it has to be
          // reached twice because there are two renderers (#1119). A refusal
          // is the one turn this region must not call an answer: the server
          // ran no completion, so "Answer ready" tells a screen-reader user to
          // go and read something that is not there. It is not an error
          // either, so it stays polite rather than being routed into the alert
          // region above — a correct response is not worth interrupting for.
          return (
            <span key={lastAnswer.id}>
              {lastAnswer.isRefusal ? REFUSAL_ANNOUNCEMENT : 'Answer ready'}
            </span>
          );
        })()}
      </div>

      {/* Thread. `overscroll-contain` so reaching the end of the conversation
          does not chain the scroll into the article underneath — the sheet sits
          over the document, and scroll leaking through it would move the page
          the user is asking about out from under them. */}
      <div className="scroll-mask min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3" data-testid="ai-dock-thread">
        {messages.length === 0 && !isStreaming ? (
          <DockEmptyState
            pageTitle={page?.title}
            onSelectSkill={(skillId) => {
              setMode('generate');
              setCreateSkill(skillId);
              const skill = getCreateSkill(skillId);
              if (skill?.suggestedPrompt && !input.trim()) {
                setInput(skill.suggestedPrompt);
              }
              composerRef.current?.focus();
            }}
          />
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
            {/* Artifacts belong to the assistant's turn, so they line up with
                its prose rather than the column edge: ml-7 is the avatar's
                20px plus the 8px gap. */}
            <div className="ml-7 space-y-2">
              <DockDiffCard onRerun={runChip} />
              <DockDraftCard />
              <DiagramPreview />
            </div>
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* One selector, one composer, one Send path. The selected action is
          visible beside Send so the request cannot quietly fall back to Q&A. */}
      <div className="shrink-0 border-t border-border px-3 pb-3 pt-2.5">
        {modelsError && (
          <button
            type="button"
            onClick={() => refetchModels()}
            title="Failed to load models from the LLM provider — click to retry"
            className="mb-2 flex h-7 items-center gap-1.5 rounded-md border border-destructive/60 px-2.5 text-xs text-destructive transition-colors hover:bg-destructive/10"
          >
            <AlertTriangle size={12} aria-hidden /> Models unavailable — retry
          </button>
        )}

        {/* An advisory, not a refusal: the backend accepts both, and only the
            resolved model knows whether they fit. Amber is the attention colour
            under ADR-010 v0.5 and this is exactly that. It sits above the
            composer, not inside it: it is about the pair of attachments rather
            than either one, so it belongs beside neither zone's row — and a
            full-width paragraph among those rows would push the field away from
            the cards it describes. */}
        {selectedAction !== 'diagram' && references.length > 0 && image && (
          <p
            id="dock-attachment-context-warning"
            role="status"
            className="mb-2 flex items-center gap-1.5 text-xs text-warning"
            data-testid="ai-dock-attachment-context-warning"
          >
            <AlertTriangle size={12} className="shrink-0" aria-hidden />
            Both attachments will be sent — a small model may not fit them.
          </p>
        )}

        {selectedAction === 'diagram' && (references.length > 0 || image) && (
          <p className="mb-2 text-xs text-muted-foreground" data-testid="ai-dock-attachments-paused">
            Attachments are kept here but are not sent to Diagram.
          </p>
        )}

        {/* Per-question retrieval option, in the same slot as `/ai`'s so the
            two Q&A composers read the same way. It stays above the box because
            it modifies only the next knowledge question, not every selectable
            action in the composer. */}
        {selectedAction === 'ask' && (
          <DeepSearchToggle
            checked={deepSearch}
            onChange={setDeepSearch}
            disabled={isStreaming}
            testId="ai-dock-deep-search"
            className="mb-2"
          />
        )}

        {/* Suggested prompt chip when a create skill is active with empty input */}
        {isCreateAction && currentSkill?.suggestedPrompt && !input.trim() && (
          <button
            type="button"
            onClick={() => {
              setInput(currentSkill.suggestedPrompt);
              composerRef.current?.focus();
            }}
            className="mb-2 flex max-w-full items-center gap-1.5 truncate text-left text-xs text-muted-foreground hover:text-primary transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            data-testid="dock-suggested-prompt-chip"
            title="Click to fill with suggested prompt"
          >
            <Sparkles size={12} className="shrink-0 text-primary" aria-hidden />
            <span className="truncate">Suggestion: <span className="italic">{currentSkill.suggestedPrompt}</span></span>
          </button>
        )}

        {/* flex-wrap so attached-source rows stack above the prompt inside the
            same box. One Attach control receives both documents and images;
            the shared router decides their path. An attachment belongs to what
            you are about to send, so it lives in the thing you send from, not
            in a band above it.
            Document order is the only order here: no `order-*` on any child,
            because that is what keeps the tab sequence matching what the eye
            reads (WCAG 2.4.3 — see `composerRowClass`). Anything added below
            lands where its markup sits, so put it where it should be read. */}
        <div className="nm-composer flex-wrap" ref={composerBoxRef}>
          <DocumentUploadZone
            variant="composer"
            onPick={(file) => handlePickFiles([file])}
            onPickFiles={handlePickFiles}
            isExtracting={isExtracting}
            extracted={references[0]?.result ?? null}
            filename={references[0]?.filename ?? null}
            documents={references}
            onRemove={removeDocument}
            disabled={isStreaming || selectedAction === 'diagram'}
            showTrigger={false}
            usageHint="context for Q&A or rewriting"
            isDragOver={isDragOver}
            testIdPrefix="ai-dock-doc"
          />
          <ImageAttachZone
            vision={chatVision}
            visionModel={chatVisionModel}
            image={image}
            onPick={(file) => handlePickFiles([file])}
            onRemove={removeImage}
            isPreparing={isPreparing}
            disabled={isStreaming || selectedAction === 'diagram'}
            showTrigger={false}
            testIdPrefix="ai-dock-image"
          />
          <DockAttachmentPicker
            onPickFiles={handlePickFiles}
            disabled={isStreaming || selectedAction === 'diagram' || isBusy}
          />
          <AssistantActionSelect disabled={isStreaming || modelsError} className="self-end" />
          <textarea
            ref={composerRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={selectedAction === 'ask'
              ? (page ? 'Ask about this page…' : 'Ask your knowledge base…')
              : selectedAction === 'diagram'
                ? 'Diagram instructions (optional)'
                : isCreateAction
                  ? (currentSkill?.suggestedPrompt ? `e.g. ${currentSkill.suggestedPrompt}` : 'Describe what to create (e.g. topic, requirements)...')
                  : `Additional ${selectedAction} instructions (optional)`}
            maxLength={PROMPT_MAX_LENGTH}
            rows={1}
            disabled={isStreaming}
            aria-describedby={
              selectedAction !== 'diagram' && references.length > 0 && image
                ? 'dock-attachment-context-warning'
                : undefined
            }
            aria-label={selectedAction === 'ask'
              ? 'Ask the assistant'
              : selectedAction === 'diagram'
                ? 'Diagram instructions'
                : isCreateAction
                  ? 'Create instructions'
                  : `${selectedAction} rewrite instructions`}
            // The composer wrapper owns the inset surface, border and focus
            // ring; resize-none because the auto-grow hook owns the height.
            className="min-w-0 grow basis-40 resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground/70 disabled:opacity-50"
            data-testid="ai-dock-input"
          />
          {isStreaming ? (
            <button
              type="button"
              onClick={() => abortRef.current?.abort()}
              aria-label="Stop response"
              title="Stop response"
              className="flex shrink-0 self-end items-center rounded-md border border-destructive/70 bg-destructive/10 px-2.5 py-1.5 text-sm font-medium text-destructive transition-all hover:bg-destructive/20 active:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              data-testid="ai-dock-stop"
            >
              <Square size={13} className="fill-current" aria-hidden />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void sendSelectedAction()}
              disabled={
                !model
                || (selectedAction === 'ask' && !input.trim())
                || (isCreateAction && !input.trim())
                || (!isCreateAction && selectedAction !== 'ask' && !page)
                || (selectedAction !== 'diagram' && isBusy)
              }
              aria-label={`Send with ${selectedAction}`}
              className="flex shrink-0 self-end items-center rounded-md border border-primary bg-primary px-2.5 py-1.5 text-sm font-medium text-primary-foreground transition-all hover:brightness-105 active:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              data-testid="ai-dock-send"
            >
              <Send size={14} aria-hidden />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function DockEmptyState({
  pageTitle,
  onSelectSkill,
}: {
  pageTitle: string | undefined;
  onSelectSkill?: (skillId: CreateSkillId) => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-2 text-center" role="region" aria-label="Assistant empty state" data-testid="ai-dock-empty">
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
          : 'Draft a new page with a create skill, or ask a question.'}
      </p>
      {!pageTitle && (
        <div className="mt-4 flex w-full flex-col gap-1.5 text-left" data-testid="dock-empty-skills">
          <span className="px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Create Skills
          </span>
          <div className="grid grid-cols-1 gap-1.5">
            {CREATE_SKILLS.map((skill) => (
              <button
                key={skill.id}
                type="button"
                onClick={() => onSelectSkill?.(skill.id)}
                className="flex items-center gap-2 rounded-md border border-border/70 bg-card p-2 text-left text-xs transition-colors hover:border-border hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                data-testid={`dock-empty-skill-${skill.id}`}
              >
                <span className="flex size-5 shrink-0 items-center justify-center rounded bg-primary/10 text-primary">
                  <Sparkles size={11} aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <span className="block font-medium text-foreground">{skill.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">{skill.description}</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
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

function DockUserMessage({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = content.length > 200 || content.split('\n').length > 3;

  return (
    <div className="flex justify-end">
      <div className="max-w-[88%] break-words rounded-xl rounded-br-sm bg-primary/12 px-3 py-2 text-sm text-foreground">
        <div
          className={cn(
            'whitespace-pre-wrap',
            isLong && !expanded && 'line-clamp-3',
          )}
        >
          {content}
        </div>
        {isLong && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="mt-1 block text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            data-testid="dock-user-message-expand"
          >
            {expanded ? 'Show less' : 'Show more'}
          </button>
        )}
      </div>
    </div>
  );
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
    return <DockUserMessage content={msg.content} />;
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
        ) : msg.isRefusal ? (
          // The #1105 refusal (#1119). Neutral: it is a verdict, not a fault
          // and not a warning — the colour argument is in `refusal.tsx`. Depth
          // is a value step plus a hairline, which is the whole treatment.
          // Plain text, not StreamingMessage: the backend writes one prose
          // sentence with no Markdown in it, and a refusal is the last place to
          // risk a renderer inventing structure.
          <div
            className="rounded-lg border border-border bg-foreground/5 px-2.5 py-2"
            data-testid="message-refusal"
          >
            <RefusalMark />
            <p className="mt-1.5 whitespace-pre-wrap text-sm text-foreground">{msg.content}</p>
          </div>
        ) : (
          content && <StreamingMessage content={content} isStreaming={isStreamingThis} />
        )}
        {msg.sources && msg.sources.length > 0 && (
          <div className="mt-2 space-y-1">
            {/* Named on a refusal, bare on an answer. Unlabelled chips under
                "I am not answering" read as the sources it answered from. */}
            {msg.isRefusal && <RefusalSourcesLabel />}
            <CitationChips sources={msg.sources} />
          </div>
        )}
      </div>
    </div>
  );
}
