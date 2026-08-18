import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Save, Upload, LayoutTemplate, Globe, Lock, X } from 'lucide-react';
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
import type { Editor as EditorType } from '@tiptap/core';
import { cn } from '../../shared/lib/cn';
import { toast } from 'sonner';

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
  // a selection made in one context to the wrong context. This is deliberately
  // a handler and not an effect on `articleType`: an effect also fires on mount
  // and would immediately wipe the preselection below.
  //
  // The `next === articleType` guard restores what the effect gave for free.
  // React bails out of `setArticleType(sameValue)` and the effect's dependency
  // never changed, so clicking the already-pressed toggle used to be a no-op;
  // without the guard it would now throw away the space and parent the user
  // had chosen.
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
   * Most articles are authored in Confluence, so starting on "Local" with an
   * empty picker made the common case two clicks longer than the rare one.
   *
   * - **No permission to write there** — `GET /api/spaces` returns only
   *   RBAC-accessible spaces, and `POST /api/pages` gates a Confluence create on
   *   that same `getUserAccessibleSpaces` check. Preselecting from this list
   *   therefore cannot preselect a space the app would reject. (Confluence's own
   *   PAT permissions can still refuse, but that is strictly narrower than what
   *   any client-side check could predict, and it already surfaces on create.)
   * - **Confluence not configured** — nothing is RBAC-assigned and nothing is
   *   synced, so the list holds no Confluence space and the form stays on Local
   *   exactly as before.
   * - **Assigned but not yet synced** — `GET /api/spaces` appends those keys
   *   with `source: 'confluence'`, `lastSynced: null` and the key as the name
   *   (`spaces.ts`, `unsyncedSelections`). They are legitimate create targets —
   *   `POST /api/pages` writes straight to Confluence, not to the mirror — but a
   *   space the user demonstrably works in is the better guess, so a synced one
   *   wins and an unsynced one is only the fallback.
   * - **Which of several** — the space the user last created in, if they can
   *   still reach it; otherwise the first, which the API returns sorted by name.
   */
  useEffect(() => {
    if (preselectSettled.current) return;
    // Only `spaces` feeds `confluenceSpaces` — every entry from
    // `localSpacesData` is forced to `source: 'local'` above — so waiting on the
    // local-spaces query too would just delay this, and strand it entirely if
    // that query failed.
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
      // Read the live HTML off the editor instance (#954). `bodyHtml` is only a
      // fallback seed (empty, or a template applied before the editor mounted).
      const bodyToSave = editorInstance?.getHTML() ?? bodyHtml;
      const result = await createMutation.mutateAsync({
        spaceKey: spaceKey,
        title: title.trim(),
        bodyHtml: bodyToSave,
        ...(parentId ? { parentId } : {}),
        ...(selectedSpace?.source === 'local' ? { visibility } : {}),
        // Front-matter labels from an imported file (#1133). Sent with the
        // create rather than applied afterwards: the id this route returns is
        // the *Confluence content id* for a Confluence create, and it is
        // numeric, so `PUT /pages/:id/labels` would read it as a database
        // primary key and label a different page entirely.
        ...(pendingLabels.length > 0 ? { labels: pendingLabels } : {}),
      } as Parameters<typeof createMutation.mutateAsync>[0]);
      // Only after a create actually succeeded — remembering a space the user
      // merely browsed to would make the next visit preselect a dead end.
      if (selectedSpace?.source === 'confluence') rememberConfluenceSpace(spaceKey);

      clearDraft(NEW_PAGE_DRAFT_KEY);
      navigate(`/pages/${result.id}`);
      toast.success('Page created');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create page');
    }
  };

  /**
   * Load an uploaded Markdown file into the editor — the same shape as "Use
   * Template", and for the same reason (#1133).
   *
   * This used to POST the Markdown to a route that created the page outright,
   * always under the hardcoded `_standalone` space, then navigate straight to
   * the read-only view. So picking a Confluence space and then importing filed
   * the page somewhere else, and the user never saw it before it was saved.
   * Now nothing is persisted here: the converted body lands in the editor and
   * `handleCreate` performs the save with the space, parent and visibility the
   * form is showing.
   */
  const handleImportMarkdown = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      // Size is checked here, in the app's own words, because the round-trip
      // has no good answer for an oversize file (#1178): the nginx edge
      // answers first with an HTML 413 whose "Request Entity Too Large" names
      // the proxy's rule, not this limit, and nothing in it suggests a smaller
      // file. Bytes first — the cheap check that avoids pulling a huge file
      // into memory just to count its characters — then characters, which is
      // the unit the route's schema actually enforces.
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

      // Push into the live TipTap instance — the Editor never re-reads its
      // `content` prop after mount, so setContent is how this becomes visible.
      // `emitUpdate` fires onUpdate so the localStorage draft is written, and
      // `setBodyHtml` seeds the brief window before TipTap has mounted. Both
      // mirror the template flow exactly (#954).
      editorInstance?.commands.setContent(preview.bodyHtml, { emitUpdate: true });
      setBodyHtml(preview.bodyHtml);

      // Front-matter title, else the filename — but never over something the
      // user has already typed. A title a *previous import* wrote is not that,
      // so importing a second file replaces it rather than leaving the new
      // body under the old file's name.
      // Read before the assignment below: `setTitle`'s updater runs later, so
      // comparing against the ref inside it would compare against *this*
      // import's title and never match.
      const titleFromPreviousImport = importedTitleRef.current;
      setTitle((current) => (
        !current.trim() || current === titleFromPreviousImport ? preview.title : current
      ));
      importedTitleRef.current = preview.title;
      // Applied after the page exists; `POST /pages` has no labels field.
      setPendingLabels(preview.labels);

      toast.success('Markdown loaded — review it, then press Create Page');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to import markdown');
    } finally {
      // Reset file input so the same file can be re-selected — including after
      // one of the size guards above returned early.
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, [importMarkdownMutation, editorInstance]);

  // Labels ride along with the create (#1133), so there is exactly one request
  // between the click and the navigate — no window in which the button
  // re-enables while the user is still looking at the form.
  const isCreating = createMutation.isPending;

  const isCreateDisabled = isCreating
    || !title.trim()
    || !spaceKey;
  // Explain WHY create is disabled — but not while a create is in flight
  // (the button already says "Creating…").
  const showCreateHint = isCreateDisabled && !isCreating;
  const handleCancel = useCallback(() => {
    navigate('/pages');
  }, [navigate]);
  // With a space preselected (#1122), "select a space" is usually already done —
  // saying so anyway sends the user hunting for a control that is fine.
  const createHint = !spaceKey
    ? (title.trim() ? 'Select a space first' : 'Enter a title and select a space first')
    : 'Enter a title first';

  return (
    <div>
      {/* Sticky write chrome: formatting + Create/Cancel, then the identity
          row (type, space, visibility, location). Both stay pinned so a long
          draft cannot scroll away the only exit or the space/visibility
          decision. The editor body is outside this box — a sticky element's
          stuck position is bounded by its own box, so wrapping the document
          would make nothing pin.
          `-top-5`/`-mt-5`/`isolate` plus the under-mask are the same
          fix #1186 gave PageViewPage's edit toolbar. The under-mask fills
          `bg-card`, not `bg-background` — on this route the main column IS
          the pane. */}
      <div
        data-testid="new-page-sticky-header"
        className="sticky -top-5 z-30 isolate -mt-5"
      >
        <div
          aria-hidden
          data-testid="new-page-toolbar-mask"
          className="absolute inset-x-0 -top-5 bottom-0 z-[-1] bg-card"
        />
        <div className="-mx-4 border-b border-border bg-card sm:-mx-6 relative">
          {editorInstance && (
            <div className="mx-auto max-w-[1248px] px-4 sm:px-16">
              <EditorToolbar
                editor={editorInstance}
                headerNumbering={headerNumbering}
                onToggleHeaderNumbering={toggleHeaderNumbering}
                pageProperty={
                  <TagPopover
                    tags={pendingLabels}
                    onAddTag={(t) => setPendingLabels((prev) => [...prev, t])}
                    onRemoveTag={(t) => setPendingLabels((prev) => prev.filter((item) => item !== t))}
                  />
                }
                actions={
                  <>
                    <button
                      type="button"
                      onClick={handleCancel}
                      className="nm-button-ghost shrink-0"
                      data-testid="cancel-new-page-btn"
                    >
                      <X size={15} aria-hidden="true" />
                      Cancel
                    </button>
                    <span title={showCreateHint ? createHint : undefined}>
                      <button
                        onClick={handleCreate}
                        disabled={isCreateDisabled}
                        aria-describedby={showCreateHint ? 'create-page-hint' : undefined}
                        className="nm-button-primary shrink-0"
                      >
                        <Save size={15} aria-hidden="true" /> {isCreating ? 'Creating…' : 'Create Page'}
                      </button>
                    </span>
                  </>
                }
              />
            </div>
          )}
          {editorInstance && (
            <EditorContextToolbars editor={editorInstance} innerClassName="mx-auto max-w-[1248px] px-4 sm:px-16" />
          )}
          <div className="mx-auto max-w-[1248px] px-4 py-3 sm:px-16">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
              <h1 className="text-lg font-semibold">New Page</h1>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={importMarkdownMutation.isPending}
                  className="nm-button-ghost"
                  data-testid="import-markdown-btn"
                >
                  <Upload size={14} />
                  {importMarkdownMutation.isPending ? 'Importing...' : 'Import Markdown'}
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".md,.markdown"
                  onChange={handleImportMarkdown}
                  className="hidden"
                  data-testid="import-markdown-input"
                />
                <button
                  onClick={() => setShowTemplateGallery(true)}
                  className="nm-button-ghost"
                  data-testid="use-template-btn"
                >
                  <LayoutTemplate size={14} />
                  Use Template
                </button>
              </div>
            </div>

            {/* Visible variant of the tooltip hint: title attributes are
                mouse-hover-only, so keyboard, touch and screen-reader users
                need the explanation as real, aria-linked text. */}
            {showCreateHint && (
              <p id="create-page-hint" className="mt-2 text-right text-xs text-muted-foreground">
                {createHint}
              </p>
            )}

            {/* Metadata row. The selected halves of these toggles are NEUTRAL
                (value step + ink + measured ring), matching the toolbar's
                pressed recipe: "selected" is an interaction state, and each
                option used to light up in its badge's borrowed hue — green,
                indigo, even amber on Private, on a control that warns of
                nothing. */}
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
            {/* Article type toggle — same recessed-track segmented control as
                PagesPage's search-mode toggle: neutral fill plus weight carries
                "selected", not a borrowed badge hue or a ring around a loose
                pill. */}
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-muted-foreground">Type</span>
              <div
                className="inline-flex shrink-0 items-center gap-0.5 rounded-md border border-border bg-muted p-0.5"
                role="group"
                aria-label="Article type"
                data-testid="article-type-toggle"
              >
                <button
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

            <div className="h-5 w-px bg-border/50" />

            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-muted-foreground">Space</span>
              <select
                value={spaceKey}
                onChange={(e) => handleSpaceChange(e.target.value)}
                className="nm-select-md"
                data-testid="space-selector"
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

            {selectedSpace?.source === 'local' && (
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-muted-foreground">Visibility</span>
                <div
                  className="inline-flex shrink-0 items-center gap-0.5 rounded-md border border-border bg-muted p-0.5"
                  role="group"
                  aria-label="Visibility"
                  data-testid="visibility-picker"
                >
                  <button
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
            )}

            {/* Location picker — select parent page within the chosen space */}
            {!!spaceKey && (
              <>
                <div className="h-5 w-px bg-border/50" />
                <div className="flex items-center gap-2" data-testid="location-picker-section">
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

      <div className="mt-7">
        {/* Title — same type ramp as the article editor's own title
            (text-3xl/4xl bold) so a page in progress carries the same weight
            it will have the moment it's saved. */}
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

        {/* Editor body — same 1200px reading column as the article editor,
            so the writing experience matches the reading one exactly. */}
        <div className={cn('mx-auto max-w-[1200px] px-5 sm:px-10', headerNumbering && 'header-numbering')}>
          <FeatureErrorBoundary featureName="Editor">
            <Editor
              content={bodyHtml}
              placeholder="Start writing your page..."
              draftKey={NEW_PAGE_DRAFT_KEY}
              naked
              hideToolbar
              onEditorReady={setEditorInstance}
            />
          </FeatureErrorBoundary>
        </div>
      </div>

      {/* Template Gallery Modal */}
      {showTemplateGallery && (
        <TemplateGallery
          onSelect={(html) => {
            // Push the template into the live TipTap editor — the Editor never
            // re-reads the content prop after mount, so setContent is how the
            // template becomes visible. emitUpdate fires onUpdate so the
            // localStorage draft is written; the body is read back from the
            // editor instance on create (#954).
            editorInstance?.commands.setContent(html, { emitUpdate: true });
            // The imported body is gone, so its front-matter labels go with it.
            setPendingLabels([]);
            // Seed fallback for the brief window before TipTap finishes
            // mounting (immediatelyRender: false), when editorInstance is still
            // null: the Editor picks this up as its initial content.
            setBodyHtml(html);
            setShowTemplateGallery(false);
          }}
          onClose={() => setShowTemplateGallery(false)}
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

  // Radix Dialog supplies role=dialog, aria-modal, focus trap + initial focus,
  // focus restore, Escape-to-close and overlay-click-to-close for free — the
  // hand-rolled div had none of these (#942). Mounted already-open, so
  // onOpenChange only ever fires for a close request.
  return (
    <Dialog.Root open onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
        <Dialog.Content
          className="nm-card-elevated fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 p-6 outline-none"
          data-testid="template-gallery-modal"
        >
          <div className="mb-4 flex items-center justify-between">
            <Dialog.Title className="text-lg font-semibold">Choose a Template</Dialog.Title>
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
