import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Save, Upload, LayoutTemplate, Globe, Lock, X } from 'lucide-react';
import * as Dialog from '@radix-ui/react-dialog';
import { useCreatePage } from '../../shared/hooks/use-pages';
import { useSpaces } from '../../shared/hooks/use-spaces';
import { useTemplates, useUseTemplate, useImportMarkdown, useLocalSpaces } from '../../shared/hooks/use-standalone';
import { Editor, EditorToolbar, TableContextToolbar, LayoutContextToolbar, ColumnContextToolbar, clearDraft } from '../../shared/components/article/Editor';
import { FeatureErrorBoundary } from '../../shared/components/feedback/FeatureErrorBoundary';
import { LocationPicker } from '../../shared/components/LocationPicker';
import type { LocationSelection } from '../../shared/components/LocationPicker';
import { readLastConfluenceSpace, rememberConfluenceSpace } from './last-confluence-space';
import type { Editor as EditorType } from '@tiptap/core';
import { cn } from '../../shared/lib/cn';
import { toast } from 'sonner';

const NEW_PAGE_DRAFT_KEY = 'new-page';

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
      const markdown = await file.text();
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
    }
    // Reset file input so the same file can be re-selected
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [importMarkdownMutation, editorInstance]);

  // Labels ride along with the create (#1133), so there is exactly one request
  // between the click and the navigate — no window in which the button
  // re-enables while the user is still looking at the form.
  const isCreating = createMutation.isPending;

  const isCreateDisabled = isCreating
    || !title.trim()
    || !spaceKey;
  // Explain WHY create is disabled — but not while a create is in flight
  // (the button already says "Creating...").
  const showCreateHint = isCreateDisabled && !isCreating;
  // With a space preselected (#1122), "select a space" is usually already done —
  // saying so anyway sends the user hunting for a control that is fine.
  const createHint = !spaceKey
    ? (title.trim() ? 'Select a space first' : 'Enter a title and select a space first')
    : 'Enter a title first';

  return (
    <div>
      {/* ── Sticky header: action bar + title + metadata + toolbar ────────────────
          Everything above the editor scrolls up together and sticks at the top.
          The before:: pseudo-element masks the scroll-container padding gap that
          would otherwise expose article content above the stuck group.          */}
      <div
        data-testid="new-page-sticky-header"
        className="sticky top-0 z-30 relative bg-background space-y-2 before:absolute before:-z-10 before:-top-[100px] before:bottom-0 before:-left-[14px] before:-right-[14px] sm:before:-left-[22px] sm:before:-right-[22px] before:bg-background"
      >
        {/* Panel 1: Actions + Settings */}
        <div className="nm-card space-y-3 p-3">
          {/* Action bar */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <button onClick={() => navigate('/pages')} aria-label="Back to pages" className="nm-icon-button">
                <ArrowLeft size={18} />
              </button>
              <h1 className="text-xl font-bold">New Page</h1>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={importMarkdownMutation.isPending}
                className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm bg-foreground/5 hover:bg-foreground/10 disabled:opacity-50 transition-colors"
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
                className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm bg-foreground/5 hover:bg-foreground/10 transition-colors"
                data-testid="use-template-btn"
              >
                <LayoutTemplate size={14} />
                Use Template
              </button>
              {/* The hint span (not the button) carries the title: nm-button-primary
                  sets pointer-events:none on :disabled, so a tooltip on the button
                  itself would never show while it is disabled — exactly when the
                  user needs to know why. */}
              <span title={showCreateHint ? createHint : undefined}>
                <button
                  onClick={handleCreate}
                  disabled={isCreateDisabled}
                  aria-describedby={showCreateHint ? 'create-page-hint' : undefined}
                  className="nm-button-primary"
                >
                  <Save size={14} /> {isCreating ? 'Creating...' : 'Create Page'}
                </button>
              </span>
            </div>
          </div>

          {/* Visible variant of the tooltip hint: title attributes are
              mouse-hover-only, so keyboard, touch and screen-reader users
              need the explanation as real, aria-linked text. */}
          {showCreateHint && (
            <p id="create-page-hint" className="text-right text-xs text-muted-foreground">
              {createHint}
            </p>
          )}

          {/* Metadata bar */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {/* Article type toggle */}
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground">Type</span>
            <div className="flex gap-1" data-testid="article-type-toggle">
              <button
                onClick={() => handleArticleTypeChange('local')}
                aria-pressed={articleType === 'local'}
                className={cn(
                  'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
                  articleType === 'local'
                    ? 'bg-emerald-500/15 text-emerald-500 ring-1 ring-emerald-500/30'
                    : 'bg-foreground/5 text-muted-foreground hover:bg-foreground/10',
                )}
                data-testid="article-type-local"
              >
                Local
              </button>
              <button
                onClick={() => handleArticleTypeChange('confluence')}
                aria-pressed={articleType === 'confluence'}
                className={cn(
                  'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
                  articleType === 'confluence'
                    ? 'bg-blue-500/15 text-blue-500 ring-1 ring-blue-500/30'
                    : 'bg-foreground/5 text-muted-foreground hover:bg-foreground/10',
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
              <div className="flex gap-1" data-testid="visibility-picker">
                <button
                  onClick={() => setVisibility('private')}
                  aria-pressed={visibility === 'private'}
                  className={cn(
                    'flex items-center justify-center gap-1 rounded-lg px-2.5 py-1.5 text-sm transition-colors',
                    visibility === 'private'
                      ? 'bg-amber-500/15 text-amber-500 ring-1 ring-amber-500/30'
                      : 'bg-foreground/5 text-muted-foreground hover:bg-foreground/10',
                  )}
                  data-testid="visibility-private"
                >
                  <Lock size={12} /> Private
                </button>
                <button
                  onClick={() => setVisibility('shared')}
                  aria-pressed={visibility === 'shared'}
                  className={cn(
                    'flex items-center justify-center gap-1 rounded-lg px-2.5 py-1.5 text-sm transition-colors',
                    visibility === 'shared'
                      ? 'bg-sky-500/15 text-sky-500 ring-1 ring-sky-500/30'
                      : 'bg-foreground/5 text-muted-foreground hover:bg-foreground/10',
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
        {/* Close Panel 1 */}
        </div>

        {/* Panel 2: Toolbar + Title + Editor */}
        <div className="nm-card overflow-hidden">
          {/* Editor toolbar */}
          {editorInstance && (
            <div className="border-b border-border/25 px-1">
              <EditorToolbar editor={editorInstance} />
              <TableContextToolbar editor={editorInstance} />
              <LayoutContextToolbar editor={editorInstance} />
              <ColumnContextToolbar editor={editorInstance} />
            </div>
          )}

          {/* Title input */}
          <div className="px-5 pt-5 sm:px-10 sm:pt-8">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Untitled page"
              className="w-full bg-transparent text-2xl font-semibold text-foreground placeholder:text-muted-foreground/50 outline-none"
              data-testid="title-input"
              autoFocus
            />
          </div>

          {/* Editor body */}
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
          className="nm-card fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 p-6 outline-none"
          data-testid="template-gallery-modal"
        >
          <div className="mb-4 flex items-center justify-between">
            <Dialog.Title className="text-lg font-semibold">Choose a Template</Dialog.Title>
            <Dialog.Close
              aria-label="Close template gallery"
              className="text-muted-foreground hover:text-foreground"
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
