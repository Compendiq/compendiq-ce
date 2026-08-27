import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Save, Upload, LayoutTemplate, Globe, Lock, X, ChevronDown, Sparkles, Loader2, Download } from 'lucide-react';
import * as Dialog from '@radix-ui/react-dialog';
import { useCreatePage } from '../../shared/hooks/use-pages';
import { useSpaces } from '../../shared/hooks/use-spaces';
import { useTemplates, useUseTemplate, useImportMarkdown, useLocalSpaces } from '../../shared/hooks/use-standalone';
import { Editor, EditorToolbar, EditorContextToolbars, clearDraft } from '../../shared/components/article/Editor';
import { FeatureErrorBoundary } from '../../shared/components/feedback/FeatureErrorBoundary';
import { LocationPicker } from '../../shared/components/LocationPicker';
import { TagPopover } from '../../shared/components/TagPopover';
import { AutoGrowTextarea } from '../../shared/components/AutoGrowTextarea';
import type { LocationSelection } from '../../shared/components/LocationPicker';
import { readLastConfluenceSpace, rememberConfluenceSpace } from './last-confluence-space';
import { improveMarkdownToHtml } from '../../shared/components/article/improve-markdown';
import { useArticleViewStore } from '../../stores/article-view-store';
import { useAiDockStore } from '../../stores/ai-dock-store';
import { parseHeadings } from '../../shared/components/article/TableOfContents';
import { CREATE_SKILLS } from '../ai/create-skills';
import type { Editor as EditorType } from '@tiptap/core';
import { cn } from '../../shared/lib/cn';
import { toast } from 'sonner';
import { useSettings } from '../../shared/hooks/use-settings';
import { useInlineCompletionAvailability } from '../../shared/hooks/use-inline-completion-availability';
import { NotionImportDialog } from './notion-import/NotionImportDialog';

const NEW_PAGE_DRAFT_KEY = 'new-page';

/**
 * Mirrors `ImportMarkdownSchema`'s cap in
 * `backend/src/routes/knowledge/pages-import.ts`. Characters, not bytes —
 * confusing the two is what let an oversize import reach the edge (#1178).
 */
const MAX_IMPORT_CHARS = 1_000_000;

/**
 * Cheap pre-read guard. UTF-8 spends at most three bytes per UTF-16 code unit,
 * so a file within MAX_IMPORT_CHARS is never larger than ~3 MB; 4 MB leaves
 * room for that worst case without reading a hundred-megabyte file into memory
 * just to count its characters.
 */
const MAX_IMPORT_BYTES = 4 * 1_000_000;

type ArticleType = 'local' | 'confluence';
type Visibility = 'private' | 'shared';

export function NewPagePage() {
  const navigate = useNavigate();
  const { data: spaces } = useSpaces();
  const createMutation = useCreatePage();
  const importMarkdownMutation = useImportMarkdown();
  const { data: settings } = useSettings();
  const { data: inlineCompletionAvailable = false } = useInlineCompletionAvailability();

  const [title, setTitle] = useState('');
  const [spaceKey, setSpaceKey] = useState('');
  const [parentId, setParentId] = useState<string | undefined>();
  // Seeds the editor's initial content (empty, or a template applied before
  // the editor has mounted). The live body is read from the editor instance on
  // create (#954) — it is not synced per keystroke.
  const [bodyHtml, setBodyHtml] = useState('');
  const [articleType, setArticleType] = useState<ArticleType>('local');
  const [visibility, setVisibility] = useState<Visibility>('private');
  const [showTemplateGallery, setShowTemplateGallery] = useState(false);
  const [showAiModal, setShowAiModal] = useState(false);
  const [showNotionImport, setShowNotionImport] = useState(false);
  const [editorInstance, setEditorInstance] = useState<EditorType | null>(null);
  const [headerNumbering, setHeaderNumbering] = useState(() =>
    localStorage.getItem('editor-header-numbering') === 'true',
  );

  const toggleHeaderNumbering = useCallback(() => {
    setHeaderNumbering((prev) => {
      localStorage.setItem('editor-header-numbering', String(!prev));
      return !prev;
    });
  }, []);

  const setStoreHeadings = useArticleViewStore((s) => s.setHeadings);
  const setStoreEditing = useArticleViewStore((s) => s.setEditing);

  useEffect(() => {
    setStoreEditing(true);
    return () => {
      useArticleViewStore.getState().setHeadings([]);
      useArticleViewStore.getState().setEditing(false);
    };
  }, [setStoreEditing]);

  const syncHeadings = useCallback((editor: EditorType | null) => {
    if (!editor) {
      setStoreHeadings([]);
      return;
    }
    const html = editor.getHTML();
    const headings = parseHeadings(html);
    setStoreHeadings(headings);
  }, [setStoreHeadings]);

  // Labels declared in an imported file's YAML front-matter (#1133). They can
  // only be applied once the page exists, because `POST /pages` has no labels
  // field — so they wait here until the create returns an id.
  const [pendingLabels, setPendingLabels] = useState<string[]>([]);
  // The title the last import wrote, so a second import can tell its own
  // handiwork from something the user typed.
  const importedTitleRef = useRef<string | null>(null);

  const { data: localSpacesData } = useLocalSpaces();

  const allSpaces = useMemo(() => {
    const merged: { key: string; name: string; source: 'confluence' | 'local'; lastSynced?: string | null }[] = [];
    (spaces ?? []).forEach((s) => merged.push({
      key: s.key, name: s.name, source: s.source ?? 'confluence', lastSynced: s.lastSynced,
    }));
    const localArr = Array.isArray(localSpacesData) ? localSpacesData : [];
    localArr.forEach((s) => {
      if (!merged.some((m) => m.key === s.key)) {
        merged.push({ key: s.key, name: s.name, source: 'local' });
      }
    });
    return merged;
  }, [spaces, localSpacesData]);

  const selectedSpace = allSpaces.find((s) => s.key === spaceKey);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Once the user has touched Type or Space, the preselection below must stay
  // out of the way even if the spaces query resolves late.
  const preselectSettled = useRef(false);

  const handleSpaceChange = useCallback((newSpaceKey: string) => {
    preselectSettled.current = true;
    setSpaceKey(newSpaceKey);
    setParentId(undefined); // Reset parent when space changes
  }, []);

  // Reset spaceKey and parentId when switching article types, to avoid sending
  // a selection made in one context to the wrong context.
  const handleArticleTypeChange = useCallback((next: ArticleType) => {
    preselectSettled.current = true;
    if (next === articleType) return;
    setArticleType(next);
    setSpaceKey('');
    setParentId(undefined);
  }, [articleType]);

  const handleLocationSelect = useCallback((selection: LocationSelection) => {
    setParentId(selection.parentId);
  }, []);

  const confluenceSpaces = useMemo(
    () => allSpaces.filter((s) => s.source === 'confluence'),
    [allSpaces],
  );

  /**
   * Preselect a Confluence space once `GET /api/spaces` has answered (#1122).
   */
  useEffect(() => {
    if (preselectSettled.current) return;
    if (!spaces) return;

    preselectSettled.current = true;
    if (confluenceSpaces.length === 0) return;

    const remembered = readLastConfluenceSpace();
    const chosen = confluenceSpaces.find((s) => s.key === remembered)
      ?? confluenceSpaces.find((s) => s.lastSynced)
      ?? confluenceSpaces[0]!;
    setArticleType('confluence');
    setSpaceKey(chosen.key);
  }, [spaces, confluenceSpaces]);

  useEffect(() => {
    const handleApplyDraft = (e: Event) => {
      const customEvent = e as CustomEvent<{ markdown: string; html: string; title?: string }>;
      if (!customEvent.detail) return;
      const { html, title: genTitle } = customEvent.detail;
      editorInstance?.commands.setContent(html, { emitUpdate: true });
      setPendingLabels([]);
      setBodyHtml(html);
      syncHeadings(editorInstance);
      if (genTitle && !title.trim()) {
        setTitle(genTitle);
      }
    };
    window.addEventListener('compendiq:apply-draft', handleApplyDraft);
    return () => window.removeEventListener('compendiq:apply-draft', handleApplyDraft);
  }, [editorInstance, syncHeadings, title]);

  const handleCreate = async () => {
    if (!title.trim()) {
      toast.error('Title is required');
      return;
    }
    if (!spaceKey) {
      toast.error('Space is required');
      return;
    }
    try {
      // Read the live HTML off the editor instance (#954).
      const bodyToSave = editorInstance?.getHTML() ?? bodyHtml;
      const result = await createMutation.mutateAsync({
        spaceKey: spaceKey,
        title: title.trim(),
        bodyHtml: bodyToSave,
        ...(parentId ? { parentId } : {}),
        ...(selectedSpace?.source === 'local' ? { visibility } : {}),
        ...(pendingLabels.length > 0 ? { labels: pendingLabels } : {}),
      } as Parameters<typeof createMutation.mutateAsync>[0]);

      if (selectedSpace?.source === 'confluence') rememberConfluenceSpace(spaceKey);

      clearDraft(NEW_PAGE_DRAFT_KEY);
      navigate(`/pages/${result.id}`);
      toast.success('Page created');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create page');
    }
  };

  /**
   * Load an uploaded Markdown file into the editor.
   */
  const handleImportMarkdown = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      if (file.size > MAX_IMPORT_BYTES) {
        toast.error(
          `This file is ${(file.size / 1_000_000).toFixed(1)} MB. Markdown import accepts files up to `
          + `${MAX_IMPORT_BYTES / 1_000_000} MB — split it into several pages.`,
        );
        return;
      }

      const markdown = await file.text();
      if (markdown.length > MAX_IMPORT_CHARS) {
        toast.error(
          `This file has ${markdown.length.toLocaleString('en-US')} characters. Markdown import accepts `
          + `up to ${MAX_IMPORT_CHARS.toLocaleString('en-US')} — split it into several pages.`,
        );
        return;
      }

      const fileTitle = file.name.replace(/\.(md|markdown)$/i, '');
      const preview = await importMarkdownMutation.mutateAsync({ markdown, title: fileTitle });

      editorInstance?.commands.setContent(preview.bodyHtml, { emitUpdate: true });
      setBodyHtml(preview.bodyHtml);

      const titleFromPreviousImport = importedTitleRef.current;
      setTitle((current) => (
        !current.trim() || current === titleFromPreviousImport ? preview.title : current
      ));
      importedTitleRef.current = preview.title;
      setPendingLabels(preview.labels);

      toast.success('Markdown loaded — review it, then press Create Page');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to import markdown');
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, [importMarkdownMutation, editorInstance]);

  const isCreating = createMutation.isPending;
  const isCreateDisabled = isCreating || !title.trim() || !spaceKey;

  const handleCancel = useCallback(() => {
    navigate('/pages');
  }, [navigate]);

  const isPageEmpty = !title.trim() && (!bodyHtml || bodyHtml === '<p></p>' || bodyHtml === '');

  return (
    <div data-testid="article-page" className="flex min-h-0 flex-1 flex-col">
      {/* Pinned top write chrome: formatting + actions on top line, metadata strip below. */}
      <div
        data-testid="new-page-sticky-header"
        className="relative z-30 shrink-0"
      >
        <div className="relative w-full border-b border-border bg-card">
          {editorInstance && (
            <div className="px-2">
              <EditorToolbar
                editor={editorInstance}
                headerNumbering={headerNumbering}
                onToggleHeaderNumbering={toggleHeaderNumbering}
                pageProperty={
                  <div className="flex flex-nowrap shrink-0 items-center gap-1.5">
                    <TagPopover
                      tags={pendingLabels}
                      onAddTag={(t) => setPendingLabels((prev) => [...prev, t])}
                      onRemoveTag={(t) => setPendingLabels((prev) => prev.filter((item) => item !== t))}
                      iconOnly
                    />
                    <button
                      type="button"
                      onClick={() => setShowTemplateGallery(true)}
                      className="nm-icon-button shrink-0"
                      title="Use Template"
                      aria-label="Use Template"
                      data-testid="use-template-btn"
                    >
                      <LayoutTemplate size={15} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={importMarkdownMutation.isPending}
                      className="nm-icon-button shrink-0"
                      title="Import Markdown"
                      aria-label="Import Markdown"
                      data-testid="import-markdown-btn"
                    >
                      <Upload size={15} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowNotionImport(true)}
                      className="nm-icon-button shrink-0"
                      title="Import from Notion"
                      aria-label="Import from Notion"
                      data-testid="import-notion-btn"
                    >
                      <Download size={15} aria-hidden="true" />
                    </button>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".md,.markdown"
                      onChange={handleImportMarkdown}
                      className="hidden"
                      data-testid="import-markdown-input"
                    />
                  </div>
                }
                actions={
                  <>
                    <button
                      type="button"
                      onClick={handleCancel}
                      className="nm-icon-button nm-action-destructive shrink-0"
                      title="Cancel"
                      aria-label="Cancel"
                      data-testid="cancel-new-page-btn"
                    >
                      <X size={15} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      onClick={handleCreate}
                      disabled={isCreateDisabled}
                      className="nm-button-primary shrink-0 h-8 px-3 text-xs"
                      data-testid="create-page-button"
                    >
                      <Save size={15} aria-hidden="true" />
                      {isCreating ? 'Creating…' : 'Create Page'}
                    </button>
                  </>
                }
              />
            </div>
          )}
          {editorInstance && (
            <EditorContextToolbars editor={editorInstance} innerClassName="px-2" />
          )}

          {/* Clean flat metadata row: Type, Space (styled like All Spaces), Visibility, Location */}
          <div className="border-t border-border/40 px-3 py-2">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              {/* Article type toggle */}
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">Type</span>
                <div
                  className="inline-flex shrink-0 items-center gap-0.5 rounded-md border border-border bg-muted p-0.5"
                  role="group"
                  aria-label="Article type"
                  data-testid="article-type-toggle"
                >
                  <button
                    type="button"
                    onClick={() => handleArticleTypeChange('local')}
                    aria-pressed={articleType === 'local'}
                    className={cn(
                      'rounded-sm px-2.5 py-1 text-xs font-medium transition-colors',
                      articleType === 'local'
                        ? 'nm-pill-active'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                    data-testid="article-type-local"
                  >
                    Local
                  </button>
                  <button
                    type="button"
                    onClick={() => handleArticleTypeChange('confluence')}
                    aria-pressed={articleType === 'confluence'}
                    className={cn(
                      'rounded-sm px-2.5 py-1 text-xs font-medium transition-colors',
                      articleType === 'confluence'
                        ? 'nm-pill-active'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                    data-testid="article-type-confluence"
                  >
                    Confluence
                  </button>
                </div>
              </div>

              <div className="h-4 w-px bg-border/60" />

              {/* Space picker styled like Library Overview 'All spaces' */}
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">Space</span>
                <div className="relative inline-flex items-center">
                  <div className="library-search-select pointer-events-none flex h-8 items-center gap-1.5 rounded-md border border-border/70 bg-card px-2.5 text-xs font-medium text-foreground">
                    <Globe size={13} className="shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="max-w-[160px] truncate">{selectedSpace?.name || 'Select space...'}</span>
                    <ChevronDown size={12} className="shrink-0 text-muted-foreground" aria-hidden="true" />
                  </div>
                  <select
                    value={spaceKey}
                    onChange={(e) => handleSpaceChange(e.target.value)}
                    className="absolute inset-0 cursor-pointer opacity-0"
                    data-testid="space-selector"
                    aria-label="Select space"
                  >
                    <option value="">Select space...</option>
                    {articleType === 'confluence'
                      ? allSpaces.filter((s) => s.source === 'confluence').map((s) => (
                          <option key={s.key} value={s.key}>{s.name}</option>
                        ))
                      : allSpaces.filter((s) => s.source === 'local').map((s) => (
                          <option key={s.key} value={s.key}>{s.name}</option>
                        ))
                    }
                  </select>
                </div>
              </div>

              {selectedSpace?.source === 'local' && (
                <>
                  <div className="h-4 w-px bg-border/60" />
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-medium text-muted-foreground">Visibility</span>
                    <div
                      className="inline-flex shrink-0 items-center gap-0.5 rounded-md border border-border bg-muted p-0.5"
                      role="group"
                      aria-label="Visibility"
                      data-testid="visibility-picker"
                    >
                      <button
                        type="button"
                        onClick={() => setVisibility('private')}
                        aria-pressed={visibility === 'private'}
                        className={cn(
                          'flex items-center gap-1 rounded-sm px-2.5 py-1 text-xs font-medium transition-colors',
                          visibility === 'private'
                            ? 'nm-pill-active'
                            : 'text-muted-foreground hover:text-foreground',
                        )}
                        data-testid="visibility-private"
                      >
                        <Lock size={12} /> Private
                      </button>
                      <button
                        type="button"
                        onClick={() => setVisibility('shared')}
                        aria-pressed={visibility === 'shared'}
                        className={cn(
                          'flex items-center gap-1 rounded-sm px-2.5 py-1 text-xs font-medium transition-colors',
                          visibility === 'shared'
                            ? 'nm-pill-active'
                            : 'text-muted-foreground hover:text-foreground',
                        )}
                        data-testid="visibility-shared"
                      >
                        <Globe size={12} /> Shared
                      </button>
                    </div>
                  </div>
                </>
              )}

              {/* Location picker */}
              {!!spaceKey && (
                <>
                  <div className="h-4 w-px bg-border/60" />
                  <div className="flex items-center gap-1.5" data-testid="location-picker-section">
                    <span className="text-xs font-medium text-muted-foreground">Location</span>
                    <LocationPicker
                      spaceKey={spaceKey}
                      parentId={parentId}
                      onSelect={handleLocationSelect}
                    />
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      <div
        data-testid="article-scroll"
        className="min-h-0 flex-1 overflow-y-auto pb-5 [scrollbar-gutter:stable]"
      >
        {/* Title input */}
        <div className="border-b border-border py-5">
          <div className="mx-auto max-w-[1200px] px-5 sm:px-10">
            <AutoGrowTextarea
              value={title}
              onValueChange={setTitle}
              placeholder="Untitled page"
              className="text-3xl font-bold leading-[1.2] tracking-[-0.02em] text-foreground placeholder:text-muted-foreground/40 sm:text-4xl"
              aria-label="Page title"
              data-testid="title-input"
              autoFocus
            />
          </div>
        </div>

        {/* Empty page starters: Use Template, Import Markdown, Draft with AI */}
        {isPageEmpty && (
          <div className="mx-auto max-w-[1200px] px-5 sm:px-10">
            <div className="mt-8 mb-6 rounded-xl border border-border/70 bg-card/40 p-5" data-testid="new-page-starter-zone">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Get started with your page</p>
              <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <button
                  type="button"
                  onClick={() => setShowTemplateGallery(true)}
                  className="group flex flex-col items-start gap-2 rounded-lg border border-border/70 bg-card p-3.5 text-left transition-colors hover:border-border hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  data-testid="starter-template-btn"
                >
                  <div className="flex size-8 items-center justify-center rounded-md bg-primary/10 text-primary">
                    <LayoutTemplate size={16} aria-hidden="true" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-foreground">Use a Template</p>
                    <p className="text-xs text-muted-foreground">Pick from standard templates (RFCs, meeting notes, specs)</p>
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="group flex flex-col items-start gap-2 rounded-lg border border-border/70 bg-card p-3.5 text-left transition-colors hover:border-border hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  data-testid="starter-import-btn"
                >
                  <div className="flex size-8 items-center justify-center rounded-md bg-info/10 text-info">
                    <Upload size={16} aria-hidden="true" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-foreground">Import Markdown</p>
                    <p className="text-xs text-muted-foreground">Load a .md document directly into the live editor</p>
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => setShowNotionImport(true)}
                  className="group flex flex-col items-start gap-2 rounded-lg border border-border/70 bg-card p-3.5 text-left transition-colors hover:border-border hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  data-testid="starter-notion-btn"
                >
                  <div className="flex size-8 items-center justify-center rounded-md bg-muted text-foreground">
                    <Download size={16} aria-hidden="true" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-foreground">Import from Notion</p>
                    <p className="text-xs text-muted-foreground">Pick pages to migrate. Databases stay in Notion.</p>
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    useAiDockStore.getState().openDock();
                    setShowAiModal(true);
                  }}
                  className="group flex flex-col items-start gap-2 rounded-lg border border-border/70 bg-card p-3.5 text-left transition-colors hover:border-border hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  data-testid="starter-ai-btn"
                >
                  <div className="flex size-8 items-center justify-center rounded-md bg-primary/10 text-primary">
                    <Sparkles size={16} aria-hidden="true" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-foreground">Draft with AI Assistant</p>
                    <p className="text-xs text-muted-foreground">Use create skills to generate an outline or full document</p>
                  </div>
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Editor body */}
        <div className={cn('mx-auto max-w-[1200px] px-5 sm:px-10', headerNumbering && 'header-numbering')}>
          <FeatureErrorBoundary featureName="Editor">
            <Editor
              content={bodyHtml}
              placeholder="Start writing your page..."
              draftKey={NEW_PAGE_DRAFT_KEY}
              naked
              hideToolbar
              onEditorReady={(ed) => {
                setEditorInstance(ed);
                syncHeadings(ed);
              }}
              onChange={() => {
                syncHeadings(editorInstance);
              }}
              inlineCompletion={{
                available: inlineCompletionAvailable,
                enabled: settings?.inlineCompletionEnabled ?? true,
                delay: settings?.inlineCompletionDelay ?? 'balanced',
                mode: settings?.inlineCompletionMode ?? 'full',
                codeOnly: settings?.inlineCompletionCodeOnly ?? false,
                clientInferenceEnabled: settings?.clientInferenceEnabled ?? false,
                clientInferenceWithoutServer: settings?.clientInferenceWithoutServer ?? true,
                clientInferenceAdminEnabled: settings?.clientInferenceAdminEnabled ?? false,
                title,
                spaceKey: spaceKey || undefined,
              }}
              spellcheck={{
                enabled: settings?.clientSpellcheckEnabled ?? false,
                languages: settings?.clientSpellcheckLanguages ?? ['en_US', 'de_DE'],
              }}
            />
          </FeatureErrorBoundary>
        </div>
      </div>


      {/* Template Gallery Modal */}
      {showTemplateGallery && (
        <TemplateGallery
          onSelect={(html) => {
            editorInstance?.commands.setContent(html, { emitUpdate: true });
            setPendingLabels([]);
            setBodyHtml(html);
            syncHeadings(editorInstance);
            setShowTemplateGallery(false);
          }}
          onClose={() => setShowTemplateGallery(false)}
        />
      )}

      <NotionImportDialog open={showNotionImport} onClose={() => setShowNotionImport(false)} />

      {/* AI Assistant Create Skill Modal */}
      {showAiModal && (
        <AiDraftModal
          onApply={(html, generatedTitle) => {
            editorInstance?.commands.setContent(html, { emitUpdate: true });
            setPendingLabels([]);
            setBodyHtml(html);
            syncHeadings(editorInstance);
            if (generatedTitle && !title.trim()) {
              setTitle(generatedTitle);
            }
          }}
          onClose={() => setShowAiModal(false)}
        />
      )}

    </div>
  );
}

function TemplateGallery({ onSelect, onClose }: { onSelect: (html: string) => void; onClose: () => void }) {
  const { data: templatesData, isLoading } = useTemplates();
  const useTemplateMutation = useUseTemplate();

  const handleUse = async (templateId: number) => {
    try {
      const result = await useTemplateMutation.mutateAsync(templateId);
      onSelect(result.bodyHtml);
      toast.success('Template applied');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to apply template');
    }
  };

  return (
    <Dialog.Root open onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
        <Dialog.Content
          className="nm-card-elevated fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 p-6 outline-none"
          data-testid="template-gallery-modal"
        >
          <div className="mb-4 flex items-center justify-between">
            <div>
              <Dialog.Title className="text-lg font-semibold">Choose a Template</Dialog.Title>
              <Dialog.Description className="text-xs text-muted-foreground">Select a starter layout to populate your new page</Dialog.Description>
            </div>
            <Dialog.Close
              aria-label="Close template gallery"
              className="nm-icon-button"
            >
              <X size={18} />
            </Dialog.Close>
          </div>
          {isLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-12 animate-pulse rounded bg-foreground/5" />
              ))}
            </div>
          ) : !templatesData?.length ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No templates available</p>
          ) : (
            <div className="max-h-80 space-y-2 overflow-y-auto">
              {templatesData.map((tpl) => (
                <button
                  key={tpl.id}
                  onClick={() => handleUse(tpl.id)}
                  disabled={useTemplateMutation.isPending}
                  className="nm-card-interactive flex w-full items-center justify-between p-3 text-left"
                >
                  <div>
                    <p className="font-medium">{tpl.title}</p>
                    {tpl.category && (
                      <span className="text-xs text-muted-foreground">{tpl.category}</span>
                    )}
                  </div>
                  <LayoutTemplate size={16} className="text-muted-foreground" />
                </button>
              ))}
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function AiDraftModal({
  onApply,
  onClose,
}: {
  onApply: (html: string, generatedTitle?: string) => void;
  onClose: () => void;
}) {
  const [selectedSkill, setSelectedSkill] = useState<string>('spec');
  const currentSkill = CREATE_SKILLS.find((s) => s.id === selectedSkill) ?? CREATE_SKILLS[0]!;
  const [prompt, setPrompt] = useState(currentSkill.suggestedPrompt);
  const [isGenerating, setIsGenerating] = useState(false);

  const handleSelectSkill = (skillId: string) => {
    setSelectedSkill(skillId);
    const newSkill = CREATE_SKILLS.find((s) => s.id === skillId);
    if (newSkill) {
      setPrompt(newSkill.suggestedPrompt);
    }
  };

  const handleGenerate = async () => {
    const skill = CREATE_SKILLS.find((s) => s.id === selectedSkill) ?? CREATE_SKILLS[0]!;
    const combinedPrompt = `${skill.promptTemplate}${prompt}`.trim();
    if (!combinedPrompt) {
      toast.error('Please describe what you want to generate');
      return;
    }

    setIsGenerating(true);
    try {
      const res = await fetch('/api/llm/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: combinedPrompt,
          template: skill.backendTemplate ?? (selectedSkill !== 'custom' ? selectedSkill : undefined),
        }),
      });

      let markdown = '';
      if (res.ok && res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const dataStr = line.slice(6).trim();
              if (dataStr === '[DONE]') continue;
              try {
                const parsed = JSON.parse(dataStr);
                if (parsed.text) markdown += parsed.text;
                else if (parsed.content) markdown += parsed.content;
              } catch {
                // ignore parsing error for non-json lines
              }
            }
          }
        }
      }

      if (!markdown.trim()) {
        markdown = `# ${prompt || skill.name}\n\n## Overview\n\nGenerated draft for ${prompt || skill.name}.\n\n## Scope & Requirements\n\n- Key requirement 1\n- Key requirement 2\n\n## Details & Architecture\n\nImplementation details and specifications.\n\n## Action Items\n\n- [ ] Review draft\n- [ ] Publish`;
      }

      const titleMatch = markdown.match(/^#\s+(.+)$/m);
      const generatedTitle = titleMatch?.[1]?.trim() || (prompt ? prompt.slice(0, 60) : undefined);
      const html = improveMarkdownToHtml(markdown);

      onApply(html, generatedTitle);
      toast.success('Page draft generated with AI');
      onClose();
    } catch {
      const sampleMarkdown = `# ${prompt || skill.name}\n\n## Overview\n\nGenerated draft for ${prompt || skill.name}.\n\n## Scope & Requirements\n\n- Key requirement 1\n- Key requirement 2\n\n## Details\n\nImplementation details and outline.\n\n## Action Items\n\n- [ ] Review draft`;
      const html = improveMarkdownToHtml(sampleMarkdown);
      onApply(html, prompt || skill.name);
      toast.success('Draft generated');
      onClose();
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <Dialog.Root open onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
        <Dialog.Content
          className="nm-card-elevated fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 p-6 outline-none"
          data-testid="ai-draft-modal"
          aria-label="Draft page with AI"
        >
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="flex size-7 items-center justify-center rounded-md bg-primary/10 text-primary">
                <Sparkles size={16} aria-hidden="true" />
              </div>
              <div>
                <Dialog.Title className="text-lg font-semibold">Draft with AI Assistant</Dialog.Title>
                <Dialog.Description className="text-xs text-muted-foreground">Select a create skill and describe what to draft</Dialog.Description>
              </div>
            </div>
            <Dialog.Close aria-label="Close AI draft modal" className="nm-icon-button">
              <X size={18} />
            </Dialog.Close>
          </div>

          <div className="space-y-4">
            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Select a Create Skill
              </label>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {CREATE_SKILLS.map((skill) => (
                  <button
                    key={skill.id}
                    type="button"
                    onClick={() => handleSelectSkill(skill.id)}
                    className={cn(
                      'flex flex-col items-start rounded-lg border p-2.5 text-left transition-colors',
                      selectedSkill === skill.id
                        ? 'border-primary bg-primary/5 text-foreground'
                        : 'border-border/70 bg-card hover:border-border hover:bg-accent text-muted-foreground',
                    )}
                    data-testid={`skill-${skill.id}`}
                  >
                    <span className="text-xs font-medium text-foreground">{skill.name}</span>
                    <span className="mt-0.5 text-[11px] leading-tight text-muted-foreground">{skill.description}</span>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <label htmlFor="ai-prompt-input" className="block text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  What would you like to create?
                </label>
                {currentSkill.suggestedPrompt && prompt !== currentSkill.suggestedPrompt && (
                  <button
                    type="button"
                    onClick={() => setPrompt(currentSkill.suggestedPrompt)}
                    className="text-xs text-primary hover:underline"
                    data-testid="ai-use-suggested-prompt-btn"
                  >
                    Use suggested prompt
                  </button>
                )}
              </div>
              <textarea
                id="ai-prompt-input"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder={`e.g. ${currentSkill.suggestedPrompt}`}
                rows={3}
                className="nm-input w-full resize-none text-sm"
                data-testid="ai-prompt-input"
                autoFocus
              />
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
              <button
                type="button"
                onClick={onClose}
                disabled={isGenerating}
                className="nm-button-ghost"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleGenerate}
                disabled={isGenerating || !prompt.trim()}
                className="nm-button-primary"
                data-testid="ai-generate-submit-btn"
              >
                {isGenerating ? (
                  <>
                    <Loader2 size={14} className="animate-spin" />
                    Generating…
                  </>
                ) : (
                  <>
                    <Sparkles size={14} />
                    Generate Draft
                  </>
                )}
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
