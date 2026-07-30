import { useState, useCallback, useMemo, useRef } from 'react';
import { AlertTriangle, Send, Loader2, Save, Search, ChevronDown, X, FolderOpen, Globe } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useAiContext, nextMessageId } from '../AiContext';
import { useSpaces } from '../../../shared/hooks/use-spaces';
import { useLocalSpaces } from '../../../shared/hooks/use-standalone';
import { usePages, useCreatePage, type PageFilters } from '../../../shared/hooks/use-pages';
import { useAttachments } from '../../../shared/hooks/use-attachments';
import { DocumentUploadZone } from '../../../shared/components/upload/DocumentUploadZone';
import { ImageAttachZone, imageDisabledReason } from '../../../shared/components/upload/ImageAttachZone';
import { useAutoGrowTextarea } from '../../../shared/hooks/use-auto-grow-textarea';
import { PROMPT_MAX_LENGTH } from './prompt-limits';
import { apiFetch, ApiError } from '../../../shared/lib/api';
import { improveMarkdownToHtml } from '../../../shared/components/article/improve-markdown';
import { toast } from 'sonner';
import { cn } from '../../../shared/lib/cn';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract a title suggestion from the first markdown heading in the content. */
function extractTitleFromMarkdown(md: string): string {
  const match = md.match(/^#{1,3}\s+(.+)$/m);
  return match?.[1]?.trim() ?? '';
}

// ---------------------------------------------------------------------------
// Parent page picker (searchable within selected space)
// ---------------------------------------------------------------------------

function ParentPagePicker({
  spaceKey,
  parentId,
  selectedPageTitle,
  onSelect,
}: {
  spaceKey: string;
  parentId: string | null;
  selectedPageTitle: string | null;
  onSelect: (id: string | null, title: string | null) => void;
}) {
  const [search, setSearch] = useState('');
  const [isOpen, setIsOpen] = useState(false);

  const filters: PageFilters = useMemo(() => ({
    spaceKey,
    search: search || undefined,
    limit: 50,
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
          {parentId ? (selectedPage?.title ?? selectedPageTitle ?? 'Unknown page') : 'None (root level)'}
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
                !parentId && 'bg-primary/10 text-primary-ink',
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
                  parentId === page.id && 'bg-primary/10 text-primary-ink',
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
  const { data: localSpacesData } = useLocalSpaces();
  const createPage = useCreatePage();

  const [spaceKey, setSpaceKey] = useState('');
  const [parentId, setParentId] = useState<string | null>(null);
  const [selectedPageTitle, setSelectedPageTitle] = useState<string | null>(null);
  const [title, setTitle] = useState(() => extractTitleFromMarkdown(generatedContent));
  const [isSaving, setIsSaving] = useState(false);

  // Merge Confluence + local spaces for the selector
  const allSpaces = useMemo(() => {
    const merged: { key: string; name: string; source: 'confluence' | 'local' }[] = [];
    const confluenceSpaces = spaces ?? [];
    confluenceSpaces.forEach((s) => merged.push({
      key: s.key,
      name: s.name,
      source: s.source ?? 'confluence',
    }));
    const localArr = Array.isArray(localSpacesData) ? localSpacesData : [];
    localArr.forEach((s) => {
      // Avoid duplicates if a local space already appeared via /api/spaces
      if (!merged.some((m) => m.key === s.key)) {
        merged.push({ key: s.key, name: s.name, source: 'local' });
      }
    });
    return merged;
  }, [spaces, localSpacesData]);

  const selectedSpace = allSpaces.find((s) => s.key === spaceKey);
  const isLocalSpace = selectedSpace?.source === 'local';

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
      // #747: shared marked + DOMPurify helper — never send unsanitized
      // LLM-derived HTML to POST /pages.
      const bodyHtml = improveMarkdownToHtml(generatedContent);
      const result = await createPage.mutateAsync({
        spaceKey,
        title: title.trim(),
        bodyHtml,
        ...(parentId ? { parentId } : {}),
      });

      const label = isLocalSpace ? 'locally' : 'in Confluence';
      toast.success(`Page "${result.title}" created ${label}`);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save page');
    } finally {
      setIsSaving(false);
    }
  }, [title, spaceKey, parentId, generatedContent, createPage, onSaved, isLocalSpace]);

  const confluenceOptions = allSpaces.filter((s) => s.source === 'confluence');
  const localOptions = allSpaces.filter((s) => s.source === 'local');

  return (
    <div
      className="mt-4 space-y-3 rounded-xl border border-primary/20 bg-primary/5 p-4"
      data-testid="generate-save-panel"
    >
      <div className="flex items-center gap-2 text-sm font-medium text-primary">
        <FolderOpen size={16} />
        Save Page
      </div>

      <div className="space-y-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Title</label>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Page title..."
            className="nm-input"
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
                setSelectedPageTitle(null);
              }}
              className="nm-select-md w-full"
              data-testid="generate-space-select"
            >
              <option value="">Select space...</option>
              {confluenceOptions.length > 0 && (
                <optgroup label="Confluence">
                  {confluenceOptions.map((s) => (
                    <option key={s.key} value={s.key}>{s.name}</option>
                  ))}
                </optgroup>
              )}
              {localOptions.length > 0 && (
                <optgroup label="Local">
                  {localOptions.map((s) => (
                    <option key={s.key} value={s.key}>{s.name}</option>
                  ))}
                </optgroup>
              )}
            </select>
          </div>

          <ParentPagePicker
            spaceKey={spaceKey}
            parentId={parentId}
            selectedPageTitle={selectedPageTitle}
            onSelect={(id, pageTitle) => {
              setParentId(id);
              setSelectedPageTitle(pageTitle);
            }}
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
          {isSaving ? 'Saving...' : isLocalSpace ? 'Save Locally' : 'Save to Confluence'}
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
 * Optionally attach source material — a document (PDF, DOCX, MD, TXT, RTF or
 * ODT, #1132) and/or an image (#1154).
 * After generation completes, shows a save panel to publish to Confluence.
 */
export function GenerateModeInput() {
  const {
    input, setInput, isStreaming, model, thinkingMode, setMessages, runStream, chatVision,
  } = useAiContext();
  const [generatedContent, setGeneratedContent] = useState('');
  const [showSavePanel, setShowSavePanel] = useState(false);
  const [searchWeb, setSearchWeb] = useState(false);

  // Check if MCP docs sidecar is available (for web search toggle)
  const { data: mcpSettings } = useQuery<{ enabled: boolean }>({
    queryKey: ['mcp-docs', 'status'],
    queryFn: () => apiFetch('/mcp-docs/status'),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const mcpEnabled = mcpSettings?.enabled ?? false;

  // Both attachment slots, all intake routing, the shared drop target and paste
  // live in `useAttachments` (#1154). It owns the single `useExtractDocument`
  // instance the zone's spinner reads (#940), the format and 20 MB gates the
  // component used to apply, and — new here — the image half.
  //
  // The ref goes on the whole Generate block rather than just the prompt box:
  // the dashed dropzone, the web-search toggle and the composer are one surface
  // to a user with a file in hand, and a drop that lands on the gap between
  // them should attach rather than navigate the tab away.
  const surfaceRef = useRef<HTMLDivElement>(null);
  const attachments = useAttachments({
    dropTargetRef: surfaceRef,
    imageEnabled: chatVision === true,
    imageDisabledReason: imageDisabledReason(chatVision, model),
    disabled: isStreaming,
  });

  const handleGenerate = useCallback(async () => {
    // Block generation while an extraction or an image staging round-trip is in
    // flight — otherwise the prompt would be sent without the attachment that
    // is still being prepared (#940, widened to both slots by #1154).
    if (!input.trim() || isStreaming || attachments.isBusy) return;
    if (!model) {
      toast.error('No model available. Check your LLM provider settings.');
      return;
    }

    const prompt = input.trim();
    setInput('');

    // The filename already carries the format, so naming it twice ("Generate
    // from DOCX (notes.docx)") would only be noise.
    const displayMessage = attachments.document
      ? `Generate from ${attachments.document.filename}: ${prompt}`
      : `Generate: ${prompt}`;
    // Append, not replace (#1126) — matching runStream's seeded turn and Ask.
    // Generate is the one mode that still builds its own user turn by hand, and
    // it was the last remaining way for a submit to discard the thread it lands in.
    // The id is held so the 410 path below can take the turn back out again.
    const userMessageId = nextMessageId();
    setMessages((prev) => [...prev, { id: userMessageId, role: 'user', content: displayMessage }]);
    setGeneratedContent('');
    setShowSavePanel(false);

    const body: Record<string, unknown> = { prompt, model };
    if (attachments.document) {
      body.documentText = attachments.document.result.text;
    }
    if (attachments.image) {
      body.imageHandle = attachments.image.handle;
    }
    if (searchWeb) {
      body.searchWeb = true;
    }
    if (thinkingMode) {
      body.thinking = true;
    }

    await runStream('/llm/generate', body, {
      onComplete: (accumulated) => {
        if (accumulated) {
          setGeneratedContent(accumulated);
          setShowSavePanel(true);
        }
      },
      // A 410 means the 15-minute staging TTL lapsed between attaching the
      // image and sending (`routes/llm/_helpers.ts` → `httpErrors.gone`).
      // Nothing was generated, so the whole send is rolled back rather than
      // left as a dead turn with an error under it: the image slot is cleared
      // because that handle is gone for good, and the prompt goes back in the
      // box so it does not have to be retyped.
      onError: (err) => {
        if (!(err instanceof ApiError) || err.statusCode !== 410) return false;
        attachments.removeImage();
        setInput(prompt);
        setMessages((prev) => prev.filter((m) => m.id !== userMessageId));
        toast.error('The image expired — attach it again.');
        return true;
      },
    });
  }, [input, model, isStreaming, attachments, searchWeb, thinkingMode, setInput, setMessages, runStream]);

  const handleSubmit = () => handleGenerate();

  const promptRef = useAutoGrowTextarea(input);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Unchanged contract: Enter submits, Shift+Enter inserts a newline. On a
    // textarea the bare Enter has to be prevented explicitly, otherwise it
    // submits *and* leaves the browser's own newline behind in the field.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

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
            attachments.clearAll();
          }}
        />
      )}

      <div ref={surfaceRef} className="mt-3 space-y-3 border-t border-border/40 pt-3">
        {/* No `formats` prop: Generate offers everything the extractor supports
            (#1132), and the zone derives its accept list and every string it
            renders from that default.

            `isDragOver` hands the zone the hook's drag state — and with it the
            drop target itself. The zone's own listeners sat on a button that
            goes `pointer-events-none` while extracting, so a file dropped mid
            extraction reached no handler at all and the browser navigated the
            tab to it, taking the typed prompt with it. */}
        <DocumentUploadZone
          onPick={attachments.pickFile}
          extracted={attachments.document?.result ?? null}
          filename={attachments.document?.filename ?? null}
          onRemove={attachments.removeDocument}
          isExtracting={attachments.isExtracting}
          isDragOver={attachments.isDragOver}
          disabled={isStreaming}
        />

        {mcpEnabled && (
          <label className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="generate-search-web-toggle">
            <input
              type="checkbox"
              checked={searchWeb}
              onChange={(e) => setSearchWeb(e.target.checked)}
              disabled={isStreaming}
              className="rounded border-border/40"
            />
            <Globe size={14} />
            Search web for reference material
          </label>
        )}

        {/* An advisory, not a refusal: the backend accepts both, and only the
            resolved model knows whether they fit. Amber is the attention
            colour under ADR-010 v0.5 and this is exactly that. It sits above
            the composer so it reads between the two attachments it is about. */}
        {attachments.document && attachments.image && (
          <p
            className="flex items-center gap-1.5 text-xs text-warning"
            data-testid="attachment-context-warning"
          >
            <AlertTriangle size={12} className="shrink-0" aria-hidden />
            Both attachments will be sent — a small model may not fit them.
          </p>
        )}

        {/* flex-wrap so ImageAttachZone's full-width preview card stacks above
            the prompt row inside the same box, the way the dock's does. The
            zone brings its own `order-1` card and `order-2` trigger, so the two
            children this box owns take the slots after them — without those,
            both would default to `order: 0` and render ahead of the card. */}
        <div className="nm-composer flex-wrap">
          <ImageAttachZone
            vision={chatVision}
            model={model}
            image={attachments.image}
            onPick={attachments.pickFile}
            onRemove={attachments.removeImage}
            isPreparing={attachments.isPreparing}
            disabled={isStreaming}
          />
          <textarea
            ref={promptRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            // "this document" rather than the format's name: the six labels
            // live in DocumentUploadZone's FORMAT_META and copying them here
            // would give the same string two owners. An attached *image* keeps
            // the default: "from this document" would be a lie about a PNG.
            placeholder={attachments.document ? 'Instructions for generating from this document...' : 'Describe the page to generate...'}
            maxLength={PROMPT_MAX_LENGTH}
            rows={1}
            disabled={isStreaming}
            // The composer wrapper owns the inset surface, border and focus
            // ring, so the field stays transparent. resize-none because the
            // auto-grow hook owns the height — a drag handle would fight it.
            // min-w-0 so a textarea's intrinsic `cols` width can't push the
            // composer wider than a narrow viewport.
            className="order-3 min-w-0 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground/70 disabled:opacity-50"
          />
          <button
            onClick={handleSubmit}
            disabled={isStreaming || attachments.isBusy || !input.trim() || !model}
            aria-label={isStreaming ? 'Sending...' : 'Send message'}
            // self-end keeps Send on the last line of a grown prompt instead of
            // floating it in the middle of the text block.
            className="order-4 shrink-0 self-end flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {isStreaming ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
          </button>
        </div>
      </div>
    </>
  );
}

export const GENERATE_EMPTY_TITLE = 'Describe the page you want to generate';
export const GENERATE_EMPTY_SUBTITLE = 'AI will create a full page based on your prompt';
