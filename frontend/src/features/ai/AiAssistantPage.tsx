import { memo } from 'react';
import { m, useReducedMotion } from 'framer-motion';
import {
  Bot, User, Loader2, MessageSquare, Brain,
  Wand2, ListCollapse, Sparkles, GitBranch, FileText, ShieldCheck, Network,
} from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '../../shared/lib/cn';
import { ConfidenceBadge } from '../../shared/components/badges/ConfidenceBadge';
import { StreamingCursor } from '../../shared/components/feedback/StreamingCursor';
import { AIThinkingBlob } from '../../shared/components/feedback/AIThinkingBlob';
import { SourceCitations } from './SourceCitations';
import { CitationChips } from './CitationChips';
import { AiProvider, useAiContext, type Mode, type Message } from './AiContext';
import {
  AskModeInput, AskExamplePrompts, ASK_EMPTY_TITLE, ASK_EMPTY_SUBTITLE,
  ImproveTypeSelector, ImproveDiffView, ImproveModeInput, IMPROVE_EMPTY_TITLE, improveEmptySubtitle,
  GenerateModeInput, GENERATE_EMPTY_TITLE, GENERATE_EMPTY_SUBTITLE,
  SummarizeModeInput, SUMMARIZE_EMPTY_TITLE, summarizeEmptySubtitle,
  DiagramTypeSelector, DiagramPreview, DiagramModeInput, DIAGRAM_EMPTY_TITLE, diagramEmptySubtitle,
  QualityModeInput, QUALITY_EMPTY_TITLE, qualityEmptySubtitle,
} from './modes';

// ---------------------------------------------------------------------------
// Typing indicator: 3 dots with staggered bounce
// ---------------------------------------------------------------------------

function TypingIndicator() {
  return (
    <div className="flex items-center gap-1" data-testid="typing-indicator" aria-label="AI is typing">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 rounded-full bg-primary/60"
          style={{
            animation: 'typing-bounce 1.2s ease-in-out infinite',
            animationDelay: `${i * 0.15}s`,
          }}
        />
      ))}
    </div>
  );
}

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
}

const MessageBubble = memo(function MessageBubble({
  msg, index, isLast, isStreaming, isThinking, thinkingElapsed, isLight, shouldReduceMotion,
}: MessageBubbleProps) {
  const isLastAssistant = msg.role === 'assistant' && isLast;
  const isStreamingThis = isStreaming && isLastAssistant;
  const effectiveContent = msg.content;
  const showStreamingCursor = isStreamingThis && !!effectiveContent;
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
            : 'bg-foreground/5',
        )}
      >
        {showThinkingBlob && <AIThinkingBlob active />}
        {showTypingIndicator && <TypingIndicator />}
        <div className={cn('prose prose-sm max-w-none', !isLight && 'prose-invert')}>
          {msg.content ? (
            <>
              <Markdown remarkPlugins={[remarkGfm]}>{msg.content}</Markdown>
              {showStreamingCursor && <StreamingCursor />}
            </>
          ) : (!showThinkingBlob && !showTypingIndicator && isStreamingThis ? (
            <TypingIndicator />
          ) : null)}
        </div>
        {msg.role === 'assistant' && msg.sources && msg.sources.length > 0 && (
          <div className="mt-3 space-y-2">
            <div className="flex items-center gap-2">
              {(() => {
                const scores = msg.sources!.filter((s) => s.score != null).map((s) => s.score!);
                if (scores.length === 0) return null;
                const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
                return <ConfidenceBadge score={avgScore} />;
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
  if (prev.msg.sources !== next.msg.sources) return false;
  if (prev.isLast !== next.isLast) return false;
  if (prev.isStreaming !== next.isStreaming) return false;
  if (prev.isThinking !== next.isThinking) return false;
  if (prev.thinkingElapsed !== next.thinkingElapsed) return false;
  if (prev.isLight !== next.isLight) return false;
  return true;
});

// ---------------------------------------------------------------------------
// Mode button definitions
// ---------------------------------------------------------------------------

const MODE_BUTTONS: Array<{ key: Mode; icon: typeof MessageSquare; label: string }> = [
  { key: 'ask', icon: MessageSquare, label: 'Q&A' },
  { key: 'improve', icon: Wand2, label: 'Improve' },
  { key: 'generate', icon: Sparkles, label: 'Generate' },
  { key: 'summarize', icon: ListCollapse, label: 'Summarize' },
  { key: 'diagram', icon: GitBranch, label: 'Diagram' },
  { key: 'quality', icon: ShieldCheck, label: 'Quality' },
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
// Inner component (consumes AiContext)
// ---------------------------------------------------------------------------

function AiAssistantInner() {
  const ctx = useAiContext();
  const {
    mode, setMode, page, pageHasChildren,
    messages, messagesEndRef, isStreaming, isThinking, thinkingElapsed,
    model, models, setModel, isLight,
    includeSubPages, setIncludeSubPages,
    thinkingMode, setThinkingMode,
  } = ctx;

  const shouldReduceMotion = useReducedMotion();

  return (
    <m.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      className="space-y-3"
    >
      {/* Mode selector — Obsidian-like: minimal, no heavy glass */}
      <div className="flex flex-wrap items-center gap-1 rounded-xl border border-border/40 bg-card/50 px-3 py-2 backdrop-blur-sm">
        <div
          role="tablist"
          aria-label="AI mode"
          className="flex items-center gap-1"
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
              e.preventDefault();
              const keys = MODE_BUTTONS.map((b) => b.key);
              const idx = keys.indexOf(mode);
              const next = e.key === 'ArrowRight'
                ? (idx + 1) % keys.length
                : (idx - 1 + keys.length) % keys.length;
              const nextKey = keys[next];
              if (nextKey) setMode(nextKey);
            }
          }}
        >
          {MODE_BUTTONS.map(({ key, icon: Icon, label }) => (
            <button
              key={key}
              role="tab"
              aria-selected={mode === key}
              tabIndex={mode === key ? 0 : -1}
              onClick={() => setMode(key)}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors',
                mode === key
                  ? 'bg-primary/12 font-medium text-primary'
                  : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
              )}
            >
              <Icon size={13} /> {label}
            </button>
          ))}
        </div>

        <div className="flex-1" />

        {models.length === 0 ? (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 size={11} className="animate-spin" /> Loading models...
          </span>
        ) : (
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="rounded bg-foreground/5 px-2 py-0.5 text-xs outline-none"
          >
            {models
              .filter((m) => !m.name.includes('embed'))
              .map((m) => (
                <option key={m.name} value={m.name}>{m.name}</option>
              ))}
          </select>
        )}

        {page && (
          <span className="flex items-center gap-1 rounded bg-foreground/5 px-2 py-0.5 text-[11px] text-muted-foreground">
            <FileText size={11} /> {page.title}
          </span>
        )}

        {page && pageHasChildren && (
          <label
            className={cn(
              'flex cursor-pointer items-center gap-1 rounded-md px-2 py-0.5 text-xs transition-colors',
              includeSubPages ? 'bg-primary/12 text-primary' : 'text-muted-foreground hover:bg-foreground/5',
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

        {/* Thinking mode toggle (#20) */}
        <label
          className={cn(
            'flex cursor-pointer items-center gap-1 rounded-md px-2 py-0.5 text-xs transition-colors',
            thinkingMode ? 'bg-purple-500/12 text-purple-500' : 'text-muted-foreground hover:bg-foreground/5',
          )}
          title="Enable extended thinking for more thorough responses"
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

      {/* Mode-specific type selectors */}
      {mode === 'improve' && <ImproveTypeSelector />}
      {mode === 'diagram' && <DiagramTypeSelector />}

      {/* Messages — clean document-like surface, no heavy glass */}
      <div className="overflow-hidden rounded-xl border border-border/40 bg-card/40 backdrop-blur-sm">
        <div className="min-h-[360px] space-y-4 p-5">
          {messages.length === 0 && (
            <div className="flex min-h-[300px] flex-col items-center justify-center text-center">
              <Bot size={44} className="mb-4 text-muted-foreground/50" />
              <p className="text-base font-medium">{getEmptyTitle(mode)}</p>
              <p className="mt-1 max-w-sm text-sm text-muted-foreground">{getEmptySubtitle(mode, page)}</p>
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
            />
          ))}
          <div ref={messagesEndRef} />

          {/* Mode-specific post-message content */}
          {mode === 'improve' && <ImproveDiffView />}
          {mode === 'diagram' && <DiagramPreview />}
        </div>
      </div>

      {/* Mode-specific input bar */}
      {mode === 'ask' && <AskModeInput />}
      {mode === 'improve' && <ImproveModeInput />}
      {mode === 'generate' && <GenerateModeInput />}
      {mode === 'summarize' && <SummarizeModeInput />}
      {mode === 'diagram' && <DiagramModeInput />}
      {mode === 'quality' && <QualityModeInput />}
    </m.div>
  );
}

// ---------------------------------------------------------------------------
// Public export: wraps inner in AiProvider
// ---------------------------------------------------------------------------

export function AiAssistantPage() {
  return (
    <AiProvider>
      <AiAssistantInner />
    </AiProvider>
  );
}
