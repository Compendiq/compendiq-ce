import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { HardDrive, ArrowLeft } from 'lucide-react';
import { useCreateLocalSpace } from '../../shared/hooks/use-standalone';
import { toast } from 'sonner';

const SPACE_ICONS = [
  { value: 'book', label: 'Book' },
  { value: 'code', label: 'Code' },
  { value: 'globe', label: 'Globe' },
  { value: 'shield', label: 'Shield' },
  { value: 'zap', label: 'Zap' },
  { value: 'rocket', label: 'Rocket' },
  { value: 'star', label: 'Star' },
  { value: 'heart', label: 'Heart' },
  { value: 'briefcase', label: 'Work' },
  { value: 'lightbulb', label: 'Ideas' },
];

export function NewSpacePage() {
  const navigate = useNavigate();
  const createSpace = useCreateLocalSpace();
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [description, setDescription] = useState('');
  const [selectedIcon, setSelectedIcon] = useState<string | undefined>(undefined);
  const [keyTouched, setKeyTouched] = useState(false);

  // Auto-generate key from name (unless user has manually edited it)
  const handleNameChange = useCallback(
    (value: string) => {
      setName(value);
      if (!keyTouched) {
        const autoKey = value
          .toUpperCase()
          .replace(/[^A-Z0-9]+/g, '_')
          .replace(/^_|_$/g, '')
          .slice(0, 20);
        setKey(autoKey);
      }
    },
    [keyTouched],
  );

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!name.trim() || !key.trim()) return;

      try {
        await createSpace.mutateAsync({
          key: key.trim(),
          name: name.trim(),
          description: description.trim() || undefined,
          icon: selectedIcon,
        });
        toast.success(`Space "${name}" created`);
        navigate('/');
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to create space';
        toast.error(message);
      }
    },
    [name, key, description, selectedIcon, createSpace, navigate],
  );

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
            <HardDrive size={20} className="text-primary" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-foreground">Create Local Space</h1>
            <p className="text-xs text-muted-foreground">
              Organize standalone articles in a local space
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Space Name */}
          <div>
            <label htmlFor="space-name" className="mb-1.5 block text-xs font-medium text-foreground">
              Space Name
            </label>
            <input
              id="space-name"
              type="text"
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              placeholder="e.g. Engineering Docs"
              className="w-full rounded-lg border border-border/50 bg-background/50 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
              required
              autoFocus
            />
          </div>

          {/* Space Key */}
          <div>
            <label htmlFor="space-key" className="mb-1.5 block text-xs font-medium text-foreground">
              Space Key
            </label>
            <input
              id="space-key"
              type="text"
              value={key}
              onChange={(e) => {
                setKeyTouched(true);
                setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''));
              }}
              placeholder="e.g. ENG_DOCS"
              pattern="[A-Z0-9_]+"
              maxLength={50}
              className="w-full rounded-lg border border-border/50 bg-background/50 px-3 py-2 text-sm font-mono text-foreground placeholder:text-muted-foreground/50 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
              required
            />
            <p className="mt-1 text-[10px] text-muted-foreground">
              Uppercase letters, numbers, and underscores only. Cannot be changed later.
            </p>
          </div>

          {/* Description */}
          <div>
            <label htmlFor="space-desc" className="mb-1.5 block text-xs font-medium text-foreground">
              Description
              <span className="ml-1 text-muted-foreground font-normal">(optional)</span>
            </label>
            <textarea
              id="space-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What is this space for?"
              rows={3}
              maxLength={2000}
              className="w-full rounded-lg border border-border/50 bg-background/50 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/30 resize-none"
            />
          </div>

          {/* Icon selector */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-foreground">
              Icon
              <span className="ml-1 text-muted-foreground font-normal">(optional)</span>
            </label>
            <div className="flex flex-wrap gap-1.5">
              {SPACE_ICONS.map((icon) => (
                <button
                  key={icon.value}
                  type="button"
                  onClick={() => setSelectedIcon(selectedIcon === icon.value ? undefined : icon.value)}
                  className={`rounded-md border px-2 py-1 text-[10px] transition-colors ${
                    selectedIcon === icon.value
                      ? 'border-primary bg-primary/10 text-primary font-medium'
                      : 'border-border/30 text-muted-foreground hover:bg-foreground/5 hover:text-foreground'
                  }`}
                  title={icon.label}
                >
                  {icon.label}
                </button>
              ))}
            </div>
          </div>

          {/* Submit */}
          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={() => navigate(-1)}
              className="rounded-lg px-4 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!name.trim() || !key.trim() || createSpace.isPending}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {createSpace.isPending ? 'Creating...' : 'Create Space'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
