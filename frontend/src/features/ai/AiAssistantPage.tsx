import { m, useReducedMotion } from 'framer-motion';
import {
  Bot, User, Loader2, MessageSquare, Plus, Trash2,
  Wand2, ListCollapse, Sparkles, GitBranch, FileText, ShieldCheck, Network,
} from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '../../shared/lib/cn';
import { ConfidenceBadge } from '../../shared/components/ConfidenceBadge';
import { StreamingCursor } from '../../shared/components/StreamingCursor';
import { AIThinkingBlob } from '../../shared/components/AIThinkingBlob';
import { SourceCitations } from './SourceCitations';
import { CitationChips } from './CitationChips';
import { AiProvider, useAiContext, type Mode } from './AiContext';
import {
  AskModeInput, ASK_EMPTY_TITLE, ASK_EMPTY_SUBTITLE,
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
    mode, setMode, page, pageId, pageHasChildren,
    messages, messagesEndRef, isStreaming, isThinking, thinkingElapsed,
    model, models, setModel, isLight,
    conversations, conversationId, startNewConversation, loadConversation, deleteConversation,
    embeddingStatus, includeSubPages, setIncludeSubPages,
  } = ctx;

  const shouldReduceMotion = useReducedMotion();

  return (
    <div className="flex h-full gap-4">
      {/* Sidebar - Conversation History */}
      <div className="hidden w-64 flex-col lg:flex">
        <div className="glass-card flex flex-col h-full">
          <div className="flex items-center justify-between border-b border-border/50 p-3">
            <span className="text-sm font-medium">Conversations</span>
            <button onClick={startNewConversation} className="rounded p-1 hover:bg-foreground/5" title="New conversation">
              <Plus size={16} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {conversations.map((conv) => (
              <div
                key={conv.id}
                className={cn(
                  'group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm cursor-pointer',
                  conversationId === conv.id ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-foreground/5',
                )}
              >
                <button onClick={() => loadConversation(conv.id)} className="flex-1 truncate text-left">
                  {conv.title || 'Untitled'}
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); deleteConversation(conv.id); }}
                  className="opacity-0 group-hover:opacity-100 rounded p-0.5 hover:bg-foreground/10"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>

          {embeddingStatus && (
            <div className="border-t border-border/50 p-3 text-xs text-muted-foreground">
              <p>Embeddings: {embeddingStatus.totalEmbeddings}</p>
              {embeddingStatus.dirtyPages > 0 && (
                <p className="text-warning">{embeddingStatus.dirtyPages} pages need embedding</p>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Main chat area */}
      <div className="flex flex-1 flex-col">
        {/* Mode selector + Model */}
        <div className="glass-card mb-4 flex items-center gap-3 p-3">
          {MODE_BUTTONS.map(({ key, icon: Icon, label }) => (
            <button
              key={key}
              onClick={() => setMode(key)}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors',
                mode === key ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-foreground/5',
              )}
            >
              <Icon size={14} /> {label}
            </button>
          ))}

          <div className="flex-1" />

          {models.length === 0 ? (
            <span className="flex items-center gap-1.5 rounded-md bg-foreground/5 px-2 py-1 text-sm text-muted-foreground">
              <Loader2 size={12} className="animate-spin" /> Loading models...
            </span>
          ) : (
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="rounded-md bg-foreground/5 px-2 py-1 text-sm outline-none"
            >
              {models.map((m) => (
                <option key={m.name} value={m.name}>{m.name}</option>
              ))}
            </select>
          )}

          {page && (
            <span className="flex items-center gap-1 rounded bg-primary/10 px-2 py-0.5 text-xs text-primary">
              <FileText size={12} /> {page.title}
            </span>
          )}

          {page && pageHasChildren && (
            <label
              className={cn(
                'flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs transition-colors',
                includeSubPages ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-foreground/5',
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
              <Network size={14} />
              <span>+ Sub-pages</span>
            </label>
          )}
        </div>

        {/* Mode-specific type selectors */}
        {mode === 'improve' && <ImproveTypeSelector />}
        {mode === 'diagram' && <DiagramTypeSelector />}

        {/* Messages */}
        <div className="glass-card flex-1 overflow-y-auto p-4 space-y-4">
          {messages.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center text-center">
              <Bot size={48} className="mb-4 text-muted-foreground" />
              <p className="text-lg font-medium">{getEmptyTitle(mode)}</p>
              <p className="text-sm text-muted-foreground">{getEmptySubtitle(mode, page)}</p>
            </div>
          )}

          {messages.map((msg, i) => {
            const isLastAssistant = msg.role === 'assistant' && i === messages.length - 1;
            const isStreamingThis = isStreaming && isLastAssistant;
            const effectiveContent = msg.content;
            const showStreamingCursor = isStreamingThis && !!effectiveContent;
            const showThinkingBlob = isThinking && isLastAssistant && !effectiveContent && thinkingElapsed;
            const showTypingIndicator = isThinking && isLastAssistant && !effectiveContent && !thinkingElapsed;

            return (
              <m.div
                key={i}
                initial={shouldReduceMotion ? false : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{
                  delay: shouldReduceMotion ? 0 : Math.min(i * 0.05, 0.3),
                  type: 'spring',
                  stiffness: 300,
                  damping: 25,
                }}
                className={cn('flex gap-3', msg.role === 'user' && 'justify-end')}
              >
                {msg.role === 'assistant' && (
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/20">
                    <Bot size={16} className="text-primary" />
                  </div>
                )}
                <div
                  className={cn(
                    'max-w-[80%] rounded-lg px-4 py-3 text-sm',
                    msg.role === 'user'
                      ? 'bg-primary/15 text-foreground'
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
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-secondary">
                    <User size={16} />
                  </div>
                )}
              </m.div>
            );
          })}
          <div ref={messagesEndRef} />

          {/* Mode-specific post-message content */}
          {mode === 'improve' && <ImproveDiffView />}
          {mode === 'diagram' && <DiagramPreview />}
        </div>

        {/* Mode-specific input bar */}
        {mode === 'ask' && <AskModeInput />}
        {mode === 'improve' && <ImproveModeInput />}
        {mode === 'generate' && <GenerateModeInput />}
        {mode === 'summarize' && <SummarizeModeInput />}
        {mode === 'diagram' && <DiagramModeInput />}
        {mode === 'quality' && <QualityModeInput />}
      </div>
    </div>
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
