import { useCallback, useEffect, useMemo, useState } from 'react';
import { Edit2, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { Editor as EditorType } from '@tiptap/core';
import type { TemplateSummary } from '@compendiq/contracts';
import { PanelHeader } from '../PanelHeader';
import { Button, IconButton } from '../../../shared/components/Button';
import { ConfirmDialog } from '../../../shared/components/ConfirmDialog';
import { Editor } from '../../../shared/components/article/Editor';
import {
  useCreateTemplate,
  useDeleteTemplate,
  useTemplate,
  useTemplates,
  useUpdateTemplate,
} from '../../../shared/hooks/use-standalone';
import { useAuthStore } from '../../../stores/auth-store';

function emptyDocJson(): string {
  return JSON.stringify({ type: 'doc', content: [{ type: 'paragraph' }] });
}

export function TemplatesTab() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = user?.role === 'admin';
  const userId = user?.id;

  const { data: templates, isLoading } = useTemplates();
  const createTemplate = useCreateTemplate();
  const updateTemplate = useUpdateTemplate();
  const deleteTemplate = useDeleteTemplate();

  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  const [icon, setIcon] = useState('');
  const [shareWithEveryone, setShareWithEveryone] = useState(false);
  const [editor, setEditor] = useState<EditorType | null>(null);
  const [pendingDelete, setPendingDelete] = useState<TemplateSummary | null>(null);

  const { data: editingTemplate, isLoading: isLoadingTemplate } = useTemplate(editingId ?? undefined);

  const mine = useMemo(() => (templates ?? []).filter((t) => !t.isGlobal), [templates]);
  const shared = useMemo(() => (templates ?? []).filter((t) => t.isGlobal), [templates]);

  const resetForm = useCallback(() => {
    setEditingId(null);
    setTitle('');
    setDescription('');
    setCategory('');
    setIcon('');
    setShareWithEveryone(false);
    setEditor(null);
  }, []);

  const openCreate = useCallback(() => {
    resetForm();
    setFormOpen(true);
  }, [resetForm]);

  const openEdit = useCallback((id: number) => {
    resetForm();
    setEditingId(id);
    setFormOpen(true);
  }, [resetForm]);

  const closeForm = useCallback(() => {
    setFormOpen(false);
    resetForm();
  }, [resetForm]);

  useEffect(() => {
    if (!editingTemplate) return;
    setTitle(editingTemplate.title);
    setDescription(editingTemplate.description ?? '');
    setCategory(editingTemplate.category ?? '');
    setIcon(editingTemplate.icon ?? '');
    setShareWithEveryone(editingTemplate.isGlobal);
  }, [editingTemplate]);

  const canManage = useCallback(
    (tpl: TemplateSummary) => isAdmin || tpl.createdBy === userId,
    [isAdmin, userId],
  );

  const handleSave = async () => {
    const trimmed = title.trim();
    if (!trimmed) {
      toast.error('Title is required');
      return;
    }
    const bodyHtml = editor?.getHTML() || '<p></p>';
    const bodyJson = editor ? JSON.stringify(editor.getJSON()) : emptyDocJson();
    const payload = {
      title: trimmed,
      description: description.trim() || undefined,
      category: category.trim() || undefined,
      icon: icon.trim().slice(0, 10) || undefined,
      bodyHtml,
      bodyJson,
      ...(isAdmin ? { isGlobal: shareWithEveryone } : {}),
    };
    try {
      if (editingId != null) {
        await updateTemplate.mutateAsync({ id: editingId, ...payload });
        toast.success('Template updated');
      } else {
        await createTemplate.mutateAsync(payload);
        toast.success('Template created');
      }
      closeForm();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save template');
    }
  };

  const handleConfirmDelete = () => {
    if (!pendingDelete) return;
    const id = pendingDelete.id;
    setPendingDelete(null);
    deleteTemplate.mutate(id, {
      onSuccess: () => toast.success('Template deleted'),
      onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to delete template'),
    });
  };

  const isSaving = createTemplate.isPending || updateTemplate.isPending;
  const showEditor = formOpen && (editingId == null || !isLoadingTemplate);

  return (
    <div className="space-y-6" data-testid="templates-tab">
      <PanelHeader
        subtitle="Create personal templates for new pages. Admins can share a template with everyone."
        action={
          !formOpen ? (
            <Button
              variant="primary"
              size="sm"
              leftIcon={<Plus size={14} />}
              onClick={openCreate}
              data-testid="create-template-btn"
            >
              New template
            </Button>
          ) : undefined
        }
      />

      {formOpen ? (
        <form
          className="space-y-4"
          data-testid="template-form"
          onSubmit={(e) => {
            e.preventDefault();
            void handleSave();
          }}
        >
          <div>
            <label htmlFor="template-title" className="mb-1 block text-sm font-medium">Title</label>
            <input
              id="template-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="nm-input w-full"
              required
              data-testid="template-title-input"
            />
          </div>
          <div>
            <label htmlFor="template-description" className="mb-1 block text-sm font-medium">Description</label>
            <input
              id="template-description"
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="nm-input w-full"
              data-testid="template-description-input"
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="template-category" className="mb-1 block text-sm font-medium">Category</label>
              <input
                id="template-category"
                type="text"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="nm-input w-full"
                data-testid="template-category-input"
              />
            </div>
            <div>
              <label htmlFor="template-icon" className="mb-1 block text-sm font-medium">Icon</label>
              <input
                id="template-icon"
                type="text"
                value={icon}
                maxLength={10}
                onChange={(e) => setIcon(e.target.value.slice(0, 10))}
                className="nm-input w-full"
                placeholder="emoji"
                data-testid="template-icon-input"
              />
            </div>
          </div>
          {isAdmin && (
            <label htmlFor="template-share" className="flex items-center gap-2">
              <input
                id="template-share"
                type="checkbox"
                checked={shareWithEveryone}
                onChange={(e) => setShareWithEveryone(e.target.checked)}
                className="accent-primary h-4 w-4"
                data-testid="template-share-checkbox"
              />
              <span className="text-sm">Share with everyone</span>
            </label>
          )}
          <div>
            <p className="mb-1 text-sm font-medium">Body</p>
            {showEditor ? (
              <Editor
                key={editingId ?? 'new'}
                content={editingTemplate?.bodyHtml ?? ''}
                naked
                onEditorReady={setEditor}
                placeholder="Template body…"
              />
            ) : (
              <div className="h-32 animate-pulse rounded-lg bg-foreground/5" />
            )}
          </div>
          <div className="flex gap-2">
            <Button
              type="submit"
              variant="primary"
              size="sm"
              isLoading={isSaving}
              disabled={isSaving || !title.trim()}
              data-testid="template-save-btn"
            >
              {editingId != null ? 'Save changes' : 'Create template'}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={closeForm} data-testid="template-cancel-btn">
              Cancel
            </Button>
          </div>
        </form>
      ) : isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-12 animate-pulse rounded-lg bg-foreground/5" />
          ))}
        </div>
      ) : (
        <div className="space-y-8">
          <TemplateList
            heading="My templates"
            testid="my-templates-list"
            empty="You have no personal templates yet"
            templates={mine}
            canManage={canManage}
            onEdit={openEdit}
            onDelete={setPendingDelete}
          />
          <TemplateList
            heading="Shared templates"
            testid="shared-templates-list"
            empty="No shared templates yet"
            templates={shared}
            canManage={canManage}
            onEdit={openEdit}
            onDelete={setPendingDelete}
          />
        </div>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title={`Delete "${pendingDelete?.title ?? ''}"?`}
        description="This cannot be undone."
        confirmLabel="Delete template"
        destructive
        onConfirm={handleConfirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}

function TemplateList({
  heading,
  testid,
  empty,
  templates,
  canManage,
  onEdit,
  onDelete,
}: {
  heading: string;
  testid: string;
  empty: string;
  templates: TemplateSummary[];
  canManage: (tpl: TemplateSummary) => boolean;
  onEdit: (id: number) => void;
  onDelete: (tpl: TemplateSummary) => void;
}) {
  return (
    <section data-testid={testid}>
      <h3 className="mb-3 text-sm font-semibold text-foreground">{heading}</h3>
      {templates.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">{empty}</p>
      ) : (
        <div className="rounded-lg border border-border">
          {templates.map((tpl) => (
            <div
              key={tpl.id}
              className="flex items-center gap-3 border-b border-border px-4 py-2.5 last:border-b-0"
              data-testid={`template-row-${tpl.id}`}
            >
              {tpl.icon && <span className="text-lg" aria-hidden>{tpl.icon}</span>}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{tpl.title}</p>
                {tpl.description && (
                  <p className="truncate text-xs text-muted-foreground">{tpl.description}</p>
                )}
                {tpl.category && (
                  <p className="text-xs text-muted-foreground">{tpl.category}</p>
                )}
              </div>
              {canManage(tpl) && (
                <div className="flex shrink-0 items-center gap-1">
                  <IconButton
                    icon={<Edit2 size={14} />}
                    label={`Edit ${tpl.title}`}
                    title="Edit"
                    testid={`edit-template-${tpl.id}`}
                    onClick={() => onEdit(tpl.id)}
                  />
                  <IconButton
                    variant="destructive-ghost"
                    icon={<Trash2 size={14} />}
                    label={`Delete ${tpl.title}`}
                    title="Delete"
                    testid={`delete-template-${tpl.id}`}
                    onClick={() => onDelete(tpl)}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
