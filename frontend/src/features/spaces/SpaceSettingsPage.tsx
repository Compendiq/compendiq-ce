import { useState, useCallback, useEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Settings, ArrowLeft, Trash2 } from 'lucide-react';
import {
  useLocalSpaces,
  useUpdateLocalSpace,
  useDeleteLocalSpace,
} from '../../shared/hooks/use-standalone';
import { getSpaceIcon } from '../../shared/components/spaces/space-icons';
import { SpaceIconPicker } from './SpaceIconPicker';
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
  const [icon, setIcon] = useState<string | undefined>(undefined);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // Populate the form from space data ONCE per space key. `space` is a
  // `find()` over the list query, so any refetch whose payload is not
  // deep-equal (a pageCount bump, another user's edit) hands this component a
  // fresh reference — and the app query client refetches mid-edit (staleTime
  // 30s + refetchOnWindowFocus). Seeding keyed on the reference silently
  // snapped the form back to server state over unsaved edits. The ref also
  // carries the server state the submit's ''-vs-omit decision needs, advanced
  // on every successful save — never read from the live query row, which a
  // racing post-save refetch leaves stale.
  const savedRef = useRef<{ key: string; description: string | null; icon: string | null } | null>(
    null,
  );
  useEffect(() => {
    if (space && savedRef.current?.key !== space.key) {
      savedRef.current = {
        key: space.key,
        description: space.description ?? null,
        icon: space.icon || null,
      };
      setName(space.name);
      setDescription(space.description ?? '');
      setIcon(space.icon || undefined);
    }
  }, [space]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!key || !name.trim()) return;

      // The last state this form saved (or was seeded from) — NOT the live
      // query row, which is stale between a save and its refetch landing.
      const saved = savedRef.current;
      try {
        const trimmedDescription = description.trim();
        await updateSpace.mutateAsync({
          key,
          // The update schema takes strings, not null: '' clears a previously
          // set description/icon, and when the space never had one the field
          // is omitted entirely (JSON.stringify drops undefined) so a plain
          // rename does not write an empty string over NULL.
          name: name.trim(),
          description: trimmedDescription || (saved?.description ? '' : undefined),
          icon: icon ?? (saved?.icon ? '' : undefined),
        });
        // Advance the baseline so a second edit in the same session decides
        // ''-vs-omit against this save. Only on success — a failed save
        // changed nothing on the server.
        if (saved) {
          savedRef.current = {
            key: saved.key,
            description: trimmedDescription || null,
            icon: icon ?? null,
          };
        }
        toast.success('Space updated');
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to update space';
        toast.error(message);
      }
    },
    [key, name, description, icon, updateSpace],
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

  // The saved identity mark: the space's chosen icon, HardDrive when unset.
  const SpaceGlyph = getSpaceIcon(space?.icon);

  if (!space) {
    return (
      <div className="mx-auto max-w-lg text-center py-12">
        <p className="text-muted-foreground">Space not found or is not a local space.</p>
        <button
          onClick={() => navigate(-1)}
          className="mt-4 text-sm text-action hover:text-action/80 transition-colors"
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

      <div className="rounded-xl border border-border bg-card p-6">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-action/10">
            <Settings size={20} className="text-action" />
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
            <div className="flex items-center gap-2 rounded-lg border border-border bg-foreground/5 px-3 py-2">
              <SpaceGlyph size={14} className="text-action/70" aria-hidden="true" />
              <span className="font-mono text-sm text-muted-foreground">{key}</span>
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
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
              className="w-full rounded-lg border border-border bg-background/50 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-ring"
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
              className="w-full rounded-lg border border-border bg-background/50 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-ring resize-none"
            />
          </div>

          {/* Icon selector — the picker is a named group ("Space icon"), so
              this heading is visual only, not a <label> pointing at nothing. */}
          <div>
            <span className="mb-1.5 block text-xs font-medium text-foreground">
              Icon
              <span className="ml-1 text-muted-foreground font-normal">(optional)</span>
            </span>
            <SpaceIconPicker value={icon} onChange={setIcon} />
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
              // The form's submit: filled, like every other page primary.
              className="nm-button-primary disabled:cursor-not-allowed"
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
