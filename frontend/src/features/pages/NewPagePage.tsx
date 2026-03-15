import { useState, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Save, Upload, LayoutTemplate, Globe, Lock } from 'lucide-react';
import { useCreatePage } from '../../shared/hooks/use-pages';
import { useSpaces } from '../../shared/hooks/use-spaces';
import { useTemplates, useUseTemplate, useImportMarkdown } from '../../shared/hooks/use-standalone';
import { Editor, clearDraft } from '../../shared/components/article/Editor';
import { FeatureErrorBoundary } from '../../shared/components/feedback/FeatureErrorBoundary';
import { LocationPicker } from '../../shared/components/LocationPicker';
import type { LocationSelection } from '../../shared/components/LocationPicker';
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
  const [bodyHtml, setBodyHtml] = useState('');
  const [articleType, setArticleType] = useState<ArticleType>('local');
  const [visibility, setVisibility] = useState<Visibility>('private');
  const [showTemplateGallery, setShowTemplateGallery] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleSpaceChange = useCallback((newSpaceKey: string) => {
    setSpaceKey(newSpaceKey);
    setParentId(undefined); // Reset parent when space changes
  }, []);

  const handleLocationSelect = useCallback((selection: LocationSelection) => {
    setParentId(selection.parentId);
  }, []);

  const handleCreate = async () => {
    if (!title.trim()) {
      toast.error('Title is required');
      return;
    }
    if (articleType === 'confluence' && !spaceKey) {
      toast.error('Space is required for Confluence articles');
      return;
    }
    try {
      const result = await createMutation.mutateAsync({
        spaceKey: articleType === 'confluence' ? spaceKey : '__local__',
        title: title.trim(),
        bodyHtml,
        ...(parentId ? { parentId } : {}),
        ...(articleType === 'local' ? { visibility } : {}),
      } as Parameters<typeof createMutation.mutateAsync>[0]);
      clearDraft(NEW_PAGE_DRAFT_KEY);
      navigate(`/pages/${result.id}`);
      toast.success('Page created');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create page');
    }
  };

  const handleImportMarkdown = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const markdown = await file.text();
      const fileTitle = file.name.replace(/\.md$/, '');
      const result = await importMarkdownMutation.mutateAsync({
        markdown,
        title: fileTitle,
        spaceKey: articleType === 'confluence' ? spaceKey : undefined,
      });
      navigate(`/pages/${result.id}`);
      toast.success('Markdown imported successfully');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to import markdown');
    }
    // Reset file input so the same file can be re-selected
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [articleType, spaceKey, importMarkdownMutation, navigate]);

  const isCreateDisabled = createMutation.isPending
    || !title.trim()
    || (articleType === 'confluence' && !spaceKey);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate('/pages')} className="glass-button-ghost">
            <ArrowLeft size={18} />
          </button>
          <h1 className="text-xl font-bold">New Page</h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={importMarkdownMutation.isPending}
            className="glass-card flex items-center gap-2 px-3 py-2 text-sm hover:bg-foreground/5 disabled:opacity-50"
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
            className="glass-card flex items-center gap-2 px-3 py-2 text-sm hover:bg-foreground/5"
            data-testid="use-template-btn"
          >
            <LayoutTemplate size={14} />
            Use Template
          </button>
          <button
            onClick={handleCreate}
            disabled={isCreateDisabled}
            className="glass-button-primary"
          >
            <Save size={14} /> {createMutation.isPending ? 'Creating...' : 'Create Page'}
          </button>
        </div>
      </div>

      <div className="glass-card space-y-4 p-4">
        {/* Article type toggle */}
        <div>
          <label className="mb-1 block text-sm font-medium">Article Type</label>
          <div className="flex gap-2" data-testid="article-type-toggle">
            <button
              onClick={() => setArticleType('local')}
              className={cn(
                'flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors',
                articleType === 'local'
                  ? 'bg-emerald-500/15 text-emerald-500 ring-1 ring-emerald-500/30'
                  : 'bg-foreground/5 text-muted-foreground hover:bg-foreground/10',
              )}
              data-testid="article-type-local"
            >
              Local Article
            </button>
            <button
              onClick={() => setArticleType('confluence')}
              className={cn(
                'flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors',
                articleType === 'confluence'
                  ? 'bg-blue-500/15 text-blue-500 ring-1 ring-blue-500/30'
                  : 'bg-foreground/5 text-muted-foreground hover:bg-foreground/10',
              )}
              data-testid="article-type-confluence"
            >
              Confluence Article
            </button>
          </div>
        </div>

        <div className="flex gap-4">
          <div className="flex-1">
            <label className="mb-1 block text-sm font-medium">Title</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Page title..."
              className="glass-input"
            />
          </div>

          {articleType === 'confluence' ? (
            <div className="w-48">
              <label className="mb-1 block text-sm font-medium">Space</label>
              <select
                value={spaceKey}
                onChange={(e) => handleSpaceChange(e.target.value)}
                className="glass-select w-full"
                data-testid="space-selector"
              >
                <option value="">Select space...</option>
                {spaces?.map((s) => (
                  <option key={s.key} value={s.key}>{s.name}</option>
                ))}
              </select>
            </div>
          ) : (
            <div className="w-48">
              <label className="mb-1 block text-sm font-medium">Visibility</label>
              <div className="flex gap-2" data-testid="visibility-picker">
                <button
                  onClick={() => setVisibility('private')}
                  className={cn(
                    'flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm transition-colors',
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
                  className={cn(
                    'flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm transition-colors',
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
        </div>

        {/* Location picker — select parent page within the chosen space */}
        {(articleType === 'local' || (articleType === 'confluence' && spaceKey)) && (
          <div data-testid="location-picker-section">
            <label className="mb-1 block text-sm font-medium">Parent Location</label>
            <LocationPicker
              spaceKey={articleType === 'confluence' ? spaceKey : '__local__'}
              parentId={parentId}
              onSelect={handleLocationSelect}
            />
          </div>
        )}
      </div>

      <FeatureErrorBoundary featureName="Editor">
        <Editor content="" onChange={setBodyHtml} placeholder="Start writing your article..." draftKey={NEW_PAGE_DRAFT_KEY} />
      </FeatureErrorBoundary>

      {/* Template Gallery Modal */}
      {showTemplateGallery && (
        <TemplateGallery
          onSelect={(html) => {
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" data-testid="template-gallery-modal">
      <div className="glass-card w-full max-w-lg p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Choose a Template</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">&times;</button>
        </div>
        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-12 animate-pulse rounded bg-foreground/5" />
            ))}
          </div>
        ) : !templatesData?.items.length ? (
          <p className="py-8 text-center text-sm text-muted-foreground">No templates available</p>
        ) : (
          <div className="max-h-80 space-y-2 overflow-y-auto">
            {templatesData.items.map((tpl) => (
              <button
                key={tpl.id}
                onClick={() => handleUse(tpl.id)}
                disabled={useTemplateMutation.isPending}
                className="glass-card-hover flex w-full items-center justify-between p-3 text-left"
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
      </div>
    </div>
  );
}
