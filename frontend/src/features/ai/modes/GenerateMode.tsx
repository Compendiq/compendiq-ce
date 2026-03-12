import { useState, useCallback, useMemo } from 'react';
import { Send, Loader2, Save, Search, ChevronDown, X, FolderOpen } from 'lucide-react';
import { useAiContext } from '../AiContext';
import { useSpaces } from '../../../shared/hooks/use-spaces';
import { usePages, useCreatePage, type PageFilters } from '../../../shared/hooks/use-pages';
import { toast } from 'sonner';
import { marked } from 'marked';
import { cn } from '../../../shared/lib/cn';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract a title suggestion from the first markdown heading in the content. */
function extractTitleFromMarkdown(md: string): string {
  const match = md.match(/^#{1,3}\s+(.+)$/m);
  return match ? match[1].trim() : '';
}

/** Convert markdown to HTML using marked (sync). */
function markdownToHtml(md: string): string {
  // marked.parse can return string | Promise<string>; with async: false (default) it's sync
  const result = marked.parse(md, { async: false });
  return typeof result === 'string' ? result : '';
}

// ---------------------------------------------------------------------------
// Parent page picker (searchable within selected space)
// ---------------------------------------------------------------------------

function ParentPagePicker({
  spaceKey,
  parentId,
  onSelect,
}: {
  spaceKey: string;
  parentId: string | null;
  onSelect: (id: string | null, title: string | null) => void;
}) {
  const [search, setSearch] = useState('');
  const [isOpen, setIsOpen] = useState(false);

  const filters: PageFilters = useMemo(() => ({
    spaceKey,
    search: search || undefined,
    limit: 20,
    sort: 'title',
  }), [spaceKey, search]);

  const { data: pagesData, isLoading } = usePages(spaceKey ? filters : { limit: 0 });
  const pages = pagesData?.items ?? [];

  const selectedPage = pages.find((p) => p.id === parentId);

  if (!spaceKey) return null;

  return (
    <div className="relative">
      <label className="mb-1 block text-xs font-medium text-muted-foreground">
        Parent page (optional)
      </label>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className={cn(
          'flex w-full items-center justify-between gap-2 rounded-lg border border-border/40 bg-background/50 px-3 py-1.5 text-left text-sm',
          'hover:border-border/60 focus:outline-none focus:ring-1 focus:ring-primary/30',
        )}
      >
        <span className={parentId ? 'text-foreground' : 'text-muted-foreground'}>
          {parentId && selectedPage ? selectedPage.title : 'None (root level)'}
        </span>
        <div className="flex items-center gap-1">
          {parentId && (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                onSelect(null, null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.stopPropagation();
                  onSelect(null, null);
                }
              }}
              className="rounded p-0.5 hover:bg-foreground/10"
            >
              <X size={12} />
            </span>
          )}
          <ChevronDown size={14} className="text-muted-foreground" />
        </div>
      </button>

      {isOpen && (
        <div className="absolute z-50 mt-1 w-full rounded-lg border border-border/40 bg-card shadow-lg backdrop-blur-md">
          <div className="flex items-center gap-2 border-b border-border/30 px-3 py-2">
            <Search size={14} className="text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search pages..."
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              autoFocus
            />
          </div>
          <div className="max-h-48 overflow-y-auto p-1">
            <button
              type="button"
              onClick={() => {
                onSelect(null, null);
                setIsOpen(false);
                setSearch('');
              }}
              className={cn(
                'w-full rounded-md px-3 py-1.5 text-left text-sm transition-colors hover:bg-foreground/5',
                !parentId && 'bg-primary/10 text-primary',
              )}
            >
              None (root level)
            </button>
            {isLoading && (
              <div className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
                <Loader2 size={12} className="animate-spin" /> Loading...
              </div>
            )}
            {pages.map((page) => (
              <button
                key={page.id}
                type="button"
                onClick={() => {
                  onSelect(page.id, page.title);
                  setIsOpen(false);
                  setSearch('');
                }}
                className={cn(
                  'w-full rounded-md px-3 py-1.5 text-left text-sm transition-colors hover:bg-foreground/5',
                  parentId === page.id && 'bg-primary/10 text-primary',
                )}
              >
                {page.title}
              </button>
            ))}
            {!isLoading && pages.length === 0 && search && (
              <p className="px-3 py-2 text-sm text-muted-foreground">No pages found</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Save to Confluence dialog
// ---------------------------------------------------------------------------

export function GenerateSavePanel({
  generatedContent,
  onSaved,
}: {
  generatedContent: string;
  onSaved: () => void;
}) {
  const { data: spaces } = useSpaces();
  const createPage = useCreatePage();

  const [spaceKey, setSpaceKey] = useState('');
  const [parentId, setParentId] = useState<string | null>(null);
  const [title, setTitle] = useState(() => extractTitleFromMarkdown(generatedContent));
  const [isSaving, setIsSaving] = useState(false);

  const handleSave = useCallback(async () => {
    if (!title.trim()) {
      toast.error('Title is required');
      return;
    }
    if (!spaceKey) {
      toast.error('Please select a space');
      return;
    }

    setIsSaving(true);
    try {
      const bodyHtml = markdownToHtml(generatedContent);
      const result = await createPage.mutateAsync({
        spaceKey,
        title: title.trim(),
        bodyHtml,
        ...(parentId ? { parentId } : {}),
      });

      toast.success(`Page "${result.title}" created in Confluence`);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save page');
    } finally {
      setIsSaving(false);
    }
  }, [title, spaceKey, parentId, generatedContent, createPage, onSaved]);

  return (
    <div
      className="mt-4 space-y-3 rounded-xl border border-primary/20 bg-primary/5 p-4"
      data-testid="generate-save-panel"
    >
      <div className="flex items-center gap-2 text-sm font-medium text-primary">
        <FolderOpen size={16} />
        Save to Confluence
      </div>

      <div className="space-y-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Title</label>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Page title..."
            className="w-full rounded-lg border border-border/40 bg-background/50 px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-primary/30"
            data-testid="generate-title-input"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Space</label>
            <select
              value={spaceKey}
              onChange={(e) => {
                setSpaceKey(e.target.value);
                setParentId(null);
              }}
              className="w-full rounded-lg border border-border/40 bg-background/50 px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-primary/30"
              data-testid="generate-space-select"
            >
              <option value="">Select space...</option>
              {spaces?.map((s) => (
                <option key={s.key} value={s.key}>{s.name}</option>
              ))}
            </select>
          </div>

          <ParentPagePicker
            spaceKey={spaceKey}
            parentId={parentId}
            onSelect={(id) => setParentId(id)}
          />
        </div>
      </div>

      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={handleSave}
          disabled={isSaving || !title.trim() || !spaceKey}
          className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
          data-testid="generate-save-button"
        >
          {isSaving ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Save size={14} />
          )}
          {isSaving ? 'Saving...' : 'Save to Confluence'}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Generate mode input
// ---------------------------------------------------------------------------

/**
 * Generate mode: free-text prompt to create a new article via LLM streaming.
 * After generation completes, shows a save panel to publish to Confluence.
 */
export function GenerateModeInput() {
  const { input, setInput, isStreaming, model, setMessages, runStream } = useAiContext();
  const [generatedContent, setGeneratedContent] = useState('');
  const [showSavePanel, setShowSavePanel] = useState(false);

  const handleGenerate = useCallback(async () => {
    if (!input.trim() || isStreaming) return;
    if (!model) {
      toast.error('No model available. Check your LLM provider settings.');
      return;
    }

    const prompt = input.trim();
    setInput('');
    setMessages([{ role: 'user', content: `Generate: ${prompt}` }]);
    setGeneratedContent('');
    setShowSavePanel(false);

    await runStream('/llm/generate', { prompt, model }, {
      onComplete: (accumulated) => {
        if (accumulated) {
          setGeneratedContent(accumulated);
          setShowSavePanel(true);
        }
      },
    });
  }, [input, model, isStreaming, setInput, setMessages, runStream]);

  const handleSubmit = () => handleGenerate();

  // Check if there's a completed generation (assistant message with content, not streaming)
  const hasCompletedGeneration = showSavePanel && generatedContent && !isStreaming;

  return (
    <>
      {hasCompletedGeneration && (
        <GenerateSavePanel
          generatedContent={generatedContent}
          onSaved={() => {
            setShowSavePanel(false);
            setGeneratedContent('');
          }}
        />
      )}

      <div className="mt-3 flex items-center gap-3 border-t border-border/40 pt-3">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSubmit()}
          placeholder="Describe the article to generate..."
          disabled={isStreaming}
          className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        <button
          onClick={handleSubmit}
          disabled={isStreaming || !input.trim() || !model}
          className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {isStreaming ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
        </button>
      </div>
    </>
  );
}

export const GENERATE_EMPTY_TITLE = 'Describe the article you want to generate';
export const GENERATE_EMPTY_SUBTITLE = 'AI will create a full article based on your prompt';
