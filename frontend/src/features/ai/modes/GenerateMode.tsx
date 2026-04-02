import { useState, useCallback, useRef, useMemo } from 'react';
import { Send, Loader2, Save, Search, ChevronDown, X, FolderOpen, Upload, FileText, AlertTriangle, Globe } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useAiContext, nextMessageId } from '../AiContext';
import { useSpaces } from '../../../shared/hooks/use-spaces';
import { useLocalSpaces } from '../../../shared/hooks/use-standalone';
import { usePages, useCreatePage, type PageFilters } from '../../../shared/hooks/use-pages';
import { useExtractPdf, type ExtractPdfResult } from '../../../shared/hooks/use-extract-pdf';
import { apiFetch } from '../../../shared/lib/api';
import { toast } from 'sonner';
import { marked } from 'marked';
import { cn } from '../../../shared/lib/cn';

/** Threshold above which the backend truncates PDF text for the LLM context window. */
export const PDF_TEXT_TRUNCATION_THRESHOLD = 80_000;

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

/** Format bytes to human-readable size. */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
// PDF Upload Zone
// ---------------------------------------------------------------------------

function PdfUploadZone({
  onExtracted,
  pdfData,
  pdfFilename,
  onRemove,
  isExtracting,
  disabled,
}: {
  onExtracted: (result: ExtractPdfResult, filename: string) => void;
  pdfData: ExtractPdfResult | null;
  pdfFilename: string | null;
  onRemove: () => void;
  isExtracting: boolean;
  disabled: boolean;
}) {
  const { extractPdf } = useExtractPdf();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  const handleFile = useCallback(async (file: File) => {
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      toast.error('Only PDF files are accepted');
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      toast.error('File exceeds 20 MB limit');
      return;
    }
    try {
      const result = await extractPdf(file);
      onExtracted(result, file.name);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'PDF extraction failed');
    }
  }, [extractPdf, onExtracted]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragOver(false);
  }, []);

  // Show preview card if PDF is already extracted
  if (pdfData && pdfFilename) {
    return (
      <div
        className="flex items-start gap-3 rounded-lg border border-border/40 bg-background/50 p-3"
        data-testid="pdf-preview-card"
      >
        <FileText size={20} className="mt-0.5 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm font-medium">
            <span className="truncate">{pdfFilename}</span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {formatFileSize(pdfData.fileSize)}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {pdfData.totalPages} {pdfData.totalPages === 1 ? 'page' : 'pages'}
            </span>
          </div>
          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
            {pdfData.preview}
          </p>
          {pdfData.text.length > PDF_TEXT_TRUNCATION_THRESHOLD && (
            <p className="mt-1 flex items-center gap-1 text-xs text-yellow-600 dark:text-yellow-400" data-testid="pdf-truncation-warning">
              <AlertTriangle size={12} />
              Document will be truncated to ~80K characters for the LLM
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onRemove}
          disabled={disabled}
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
          data-testid="pdf-remove-button"
        >
          <X size={14} />
        </button>
      </div>
    );
  }

  // Show upload zone
  return (
    <div>
      <input
        ref={fileInputRef}
        type="file"
        accept="application/pdf,.pdf"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFile(file);
          // Reset so re-selecting the same file triggers onChange
          e.target.value = '';
        }}
        data-testid="pdf-file-input"
      />
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        disabled={isExtracting || disabled}
        className={cn(
          'flex w-full items-center justify-center gap-2 rounded-lg border border-dashed px-4 py-3 text-sm transition-colors',
          isDragOver
            ? 'border-primary bg-primary/10 text-primary'
            : 'border-border/40 text-muted-foreground hover:border-border/60 hover:text-foreground',
          (isExtracting || disabled) && 'pointer-events-none opacity-50',
        )}
        data-testid="pdf-upload-zone"
      >
        {isExtracting ? (
          <>
            <Loader2 size={16} className="animate-spin" />
            Extracting text...
          </>
        ) : (
          <>
            <Upload size={16} />
            Drop a PDF here or click to browse (max 20 MB)
          </>
        )}
      </button>
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
      const bodyHtml = markdownToHtml(generatedContent);
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
        Save Article
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
                setSelectedPageTitle(null);
              }}
              className="w-full rounded-lg border border-border/40 bg-background/50 px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-primary/30"
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
 * Optionally upload a PDF to use as source material.
 * After generation completes, shows a save panel to publish to Confluence.
 */
export function GenerateModeInput() {
  const { input, setInput, isStreaming, model, setMessages, runStream } = useAiContext();
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

  // PDF upload state
  const { isExtracting } = useExtractPdf();
  const [pdfData, setPdfData] = useState<ExtractPdfResult | null>(null);
  const [pdfFilename, setPdfFilename] = useState<string | null>(null);

  const handlePdfExtracted = useCallback((result: ExtractPdfResult, filename: string) => {
    setPdfData(result);
    setPdfFilename(filename);
  }, []);

  const handlePdfRemove = useCallback(() => {
    setPdfData(null);
    setPdfFilename(null);
  }, []);

  const handleGenerate = useCallback(async () => {
    if (!input.trim() || isStreaming) return;
    if (!model) {
      toast.error('No model available. Check your LLM provider settings.');
      return;
    }

    const prompt = input.trim();
    setInput('');

    const displayMessage = pdfData
      ? `Generate from PDF (${pdfFilename}): ${prompt}`
      : `Generate: ${prompt}`;
    setMessages([{ id: nextMessageId(), role: 'user', content: displayMessage }]);
    setGeneratedContent('');
    setShowSavePanel(false);

    const body: Record<string, unknown> = { prompt, model };
    if (pdfData) {
      body.pdfText = pdfData.text;
    }
    if (searchWeb) {
      body.searchWeb = true;
    }

    await runStream('/llm/generate', body, {
      onComplete: (accumulated) => {
        if (accumulated) {
          setGeneratedContent(accumulated);
          setShowSavePanel(true);
        }
      },
    });
  }, [input, model, isStreaming, pdfData, pdfFilename, searchWeb, setInput, setMessages, runStream]);

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
            handlePdfRemove();
          }}
        />
      )}

      <div className="mt-3 space-y-3 border-t border-border/40 pt-3">
        <PdfUploadZone
          onExtracted={handlePdfExtracted}
          pdfData={pdfData}
          pdfFilename={pdfFilename}
          onRemove={handlePdfRemove}
          isExtracting={isExtracting}
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

        <div className="flex items-center gap-3">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSubmit()}
            placeholder={pdfData ? 'Instructions for generating from PDF...' : 'Describe the article to generate...'}
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
      </div>
    </>
  );
}

export const GENERATE_EMPTY_TITLE = 'Describe the article you want to generate';
export const GENERATE_EMPTY_SUBTITLE = 'AI will create a full article based on your prompt';
