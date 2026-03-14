import { useState, useCallback, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Settings, ArrowLeft, Trash2, HardDrive } from 'lucide-react';
import {
  useLocalSpaces,
  useUpdateLocalSpace,
  useDeleteLocalSpace,
} from '../../shared/hooks/use-standalone';
import { toast } from 'sonner';

export function SpaceSettingsPage() {
  const navigate = useNavigate();
  const { key } = useParams<{ key: string }>();
  const { data: spacesData } = useLocalSpaces();
  const updateSpace = useUpdateLocalSpace();
  const deleteSpace = useDeleteLocalSpace();

  const localSpaces = Array.isArray(spacesData) ? spacesData : [];
  const space = localSpaces.find((s) => s.key === key);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // Populate form from space data
  useEffect(() => {
    if (space) {
      setName(space.name);
      setDescription(space.description ?? '');
    }
  }, [space]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!key || !name.trim()) return;

      try {
        await updateSpace.mutateAsync({
          key,
          name: name.trim(),
          description: description.trim() || undefined,
        });
        toast.success('Space updated');
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to update space';
        toast.error(message);
      }
    },
    [key, name, description, updateSpace],
  );

  const handleDelete = useCallback(async () => {
    if (!key) return;

    try {
      await deleteSpace.mutateAsync(key);
      toast.success('Space deleted');
      navigate('/');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to delete space';
      toast.error(message);
    }
  }, [key, deleteSpace, navigate]);

  if (!space) {
    return (
      <div className="mx-auto max-w-lg text-center py-12">
        <p className="text-muted-foreground">Space not found or is not a local space.</p>
        <button
          onClick={() => navigate(-1)}
          className="mt-4 text-sm text-primary hover:text-primary/80 transition-colors"
        >
          Go back
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg">
      <button
        onClick={() => navigate(-1)}
        className="mb-4 flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft size={14} />
        Back
      </button>

      <div className="rounded-xl border border-border/50 bg-card/80 p-6 shadow-lg backdrop-blur-md">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
            <Settings size={20} className="text-primary" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-foreground">Space Settings</h1>
            <p className="text-xs text-muted-foreground">
              <span className="font-mono">{key}</span> -- Local space
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Space Key (read-only) */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-foreground">
              Space Key
            </label>
            <div className="flex items-center gap-2 rounded-lg border border-border/30 bg-foreground/5 px-3 py-2">
              <HardDrive size={14} className="text-primary/70" />
              <span className="font-mono text-sm text-muted-foreground">{key}</span>
            </div>
            <p className="mt-1 text-[10px] text-muted-foreground">
              Space keys cannot be changed after creation.
            </p>
          </div>

          {/* Space Name */}
          <div>
            <label htmlFor="space-name" className="mb-1.5 block text-xs font-medium text-foreground">
              Space Name
            </label>
            <input
              id="space-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-lg border border-border/50 bg-background/50 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
              required
            />
          </div>

          {/* Description */}
          <div>
            <label htmlFor="space-desc" className="mb-1.5 block text-xs font-medium text-foreground">
              Description
            </label>
            <textarea
              id="space-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              maxLength={2000}
              className="w-full rounded-lg border border-border/50 bg-background/50 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/30 resize-none"
            />
          </div>

          {/* Page count (info) */}
          <div className="rounded-lg bg-foreground/5 px-3 py-2 text-xs text-muted-foreground">
            {space.pageCount} page{space.pageCount !== 1 ? 's' : ''} in this space
          </div>

          {/* Save button */}
          <div className="flex items-center justify-end pt-2">
            <button
              type="submit"
              disabled={!name.trim() || updateSpace.isPending}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {updateSpace.isPending ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </form>

        {/* Danger zone */}
        <div className="mt-8 rounded-lg border border-destructive/30 p-4">
          <h3 className="text-sm font-medium text-destructive">Danger Zone</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Deleting a space is permanent. All pages must be moved or deleted first.
          </p>

          {!showDeleteConfirm ? (
            <button
              type="button"
              onClick={() => setShowDeleteConfirm(true)}
              className="mt-3 flex items-center gap-1.5 rounded-lg border border-destructive/30 px-3 py-1.5 text-xs text-destructive hover:bg-destructive/10 transition-colors"
            >
              <Trash2 size={12} />
              Delete Space
            </button>
          ) : (
            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                onClick={handleDelete}
                disabled={deleteSpace.isPending}
                className="flex items-center gap-1.5 rounded-lg bg-destructive px-3 py-1.5 text-xs font-medium text-destructive-foreground hover:bg-destructive/90 transition-colors disabled:opacity-50"
              >
                <Trash2 size={12} />
                {deleteSpace.isPending ? 'Deleting...' : 'Confirm Delete'}
              </button>
              <button
                type="button"
                onClick={() => setShowDeleteConfirm(false)}
                className="rounded-lg px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
