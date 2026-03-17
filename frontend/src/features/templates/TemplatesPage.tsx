import { useState, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

import { Plus, LayoutGrid, FolderOpen } from 'lucide-react';
import * as Dialog from '@radix-ui/react-dialog';
import DOMPurify from 'dompurify';
import { toast } from 'sonner';
import { apiFetch } from '../../shared/lib/api';
import { TemplateCard, type Template } from './TemplateCard';
import { EmptyState } from '../../shared/components/feedback/EmptyState';
import { cn } from '../../shared/lib/cn';
import { useIsLightTheme } from '../../shared/hooks/use-is-light-theme';

const CATEGORIES = ['All', 'Meetings', 'Operations', 'Documentation', 'Engineering'] as const;
type Category = (typeof CATEGORIES)[number];

function useTemplates() {
  return useQuery<Template[]>({
    queryKey: ['templates'],
    queryFn: () => apiFetch('/templates'),
  });
}

function useCreateFromTemplate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (templateId: number) =>
      apiFetch<{ id: number; title: string; bodyJson: string; bodyHtml: string }>(`/templates/${templateId}/use`, {
        method: 'POST',
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates'] });
    },
  });
}

export function TemplatesPage() {
  const navigate = useNavigate();
  const isLight = useIsLightTheme();
  const [activeCategory, setActiveCategory] = useState<Category>('All');
  const [previewTemplate, setPreviewTemplate] = useState<Template | null>(null);

  const { data: templates, isLoading } = useTemplates();
  const createFromTemplate = useCreateFromTemplate();

  const filtered = useMemo(() => {
    if (!templates) return [];
    if (activeCategory === 'All') return templates;
    return templates.filter(
      (t) => t.category.toLowerCase() === activeCategory.toLowerCase(),
    );
  }, [templates, activeCategory]);

  const handleUse = useCallback(
    async (template: Template) => {
      try {
        const result = await createFromTemplate.mutateAsync(template.id);
        toast.success(`Template "${template.title}" loaded`);
        navigate('/pages/new', { state: { templateTitle: result.title, templateBodyHtml: result.bodyHtml } });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to use template');
      }
    },
    [createFromTemplate, navigate],
  );

  const handlePreview = useCallback((template: Template) => {
    setPreviewTemplate(template);
  }, []);

  const sanitizedPreviewHtml = useMemo(
    () =>
      previewTemplate
        ? DOMPurify.sanitize(previewTemplate.bodyHtml, {
            ADD_ATTR: ['data-diagram-name', 'data-drawio', 'data-color'],
          })
        : '',
    [previewTemplate],
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Templates</h1>
          <p className="text-sm text-muted-foreground">
            Start from a pre-built template to create pages faster
          </p>
        </div>
        <button
          onClick={() => navigate('/pages/new')}
          className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          <Plus size={16} />
          Create Template
        </button>
      </div>

      {/* Category tabs */}
      <div className="glass-card flex flex-wrap items-center gap-1 p-1.5">
        {CATEGORIES.map((cat) => (
          <button
            key={cat}
            onClick={() => setActiveCategory(cat)}
            className={cn(
              'rounded-md px-3.5 py-1.5 text-sm transition-colors',
              activeCategory === cat
                ? 'bg-primary/15 font-medium text-primary'
                : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
            )}
            data-testid={`category-tab-${cat.toLowerCase()}`}
          >
            {cat}
          </button>
        ))}
      </div>

      {/* Template grid */}
      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="glass-card h-48 animate-pulse" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={activeCategory === 'All' ? LayoutGrid : FolderOpen}
          title={activeCategory === 'All' ? 'No templates yet' : `No ${activeCategory.toLowerCase()} templates`}
          description={
            activeCategory === 'All'
              ? 'Create your first template to get started'
              : 'Try selecting a different category'
          }
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((template, i) => (
            <TemplateCard
              key={template.id}
              template={template}
              index={i}
              onUse={handleUse}
              onPreview={handlePreview}
            />
          ))}
        </div>
      )}

      {/* Preview dialog */}
      <Dialog.Root
        open={!!previewTemplate}
        onOpenChange={(open) => {
          if (!open) setPreviewTemplate(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-full max-w-2xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-border/50 bg-card p-6 shadow-2xl">
            {previewTemplate && (
              <>
                <Dialog.Title className="mb-1 text-lg font-semibold">
                  {previewTemplate.title}
                </Dialog.Title>
                <Dialog.Description className="mb-4 text-sm text-muted-foreground">
                  {previewTemplate.description}
                </Dialog.Description>
                <div
                  className={cn('prose max-w-none rounded-lg border border-border/30 bg-foreground/5 p-4', !isLight && 'prose-invert')}
                  dangerouslySetInnerHTML={{ __html: sanitizedPreviewHtml }}
                />
                <div className="mt-4 flex justify-end gap-2">
                  <Dialog.Close asChild>
                    <button className="glass-card px-4 py-2 text-sm hover:bg-foreground/5">
                      Close
                    </button>
                  </Dialog.Close>
                  <button
                    onClick={() => {
                      if (previewTemplate) {
                        void handleUse(previewTemplate);
                      }
                    }}
                    className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                  >
                    Use Template
                  </button>
                </div>
              </>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
