import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Save } from 'lucide-react';
import { useCreatePage } from '../../shared/hooks/use-pages';
import { useSpaces } from '../../shared/hooks/use-spaces';
import { Editor } from '../../shared/components/Editor';
import { toast } from 'sonner';

export function NewPagePage() {
  const navigate = useNavigate();
  const { data: spaces } = useSpaces();
  const createMutation = useCreatePage();

  const [title, setTitle] = useState('');
  const [spaceKey, setSpaceKey] = useState('');
  const [bodyHtml, setBodyHtml] = useState('');

  const handleCreate = async () => {
    if (!title.trim() || !spaceKey) {
      toast.error('Title and space are required');
      return;
    }
    try {
      const result = await createMutation.mutateAsync({
        spaceKey,
        title: title.trim(),
        bodyHtml,
      });
      navigate(`/pages/${result.id}`);
      toast.success('Page created');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create page');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate('/pages')} className="rounded p-1.5 text-muted-foreground hover:bg-white/5">
            <ArrowLeft size={18} />
          </button>
          <h1 className="text-xl font-bold">New Page</h1>
        </div>
        <button
          onClick={handleCreate}
          disabled={createMutation.isPending || !title.trim() || !spaceKey}
          className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          <Save size={14} /> {createMutation.isPending ? 'Creating...' : 'Create Page'}
        </button>
      </div>

      <div className="glass-card space-y-4 p-4">
        <div className="flex gap-4">
          <div className="flex-1">
            <label className="mb-1 block text-sm font-medium">Title</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Page title..."
              className="w-full rounded-md bg-white/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          <div className="w-48">
            <label className="mb-1 block text-sm font-medium">Space</label>
            <select
              value={spaceKey}
              onChange={(e) => setSpaceKey(e.target.value)}
              className="w-full rounded-md bg-white/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
            >
              <option value="">Select space...</option>
              {spaces?.map((s) => (
                <option key={s.key} value={s.key}>{s.name}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <Editor content="" onChange={setBodyHtml} placeholder="Start writing your article..." />
    </div>
  );
}
