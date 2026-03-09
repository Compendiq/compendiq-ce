import { useState, useCallback, useRef, useEffect } from 'react';
import { Tag, X, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { useUpdatePageLabels } from '../../shared/hooks/use-pages';

interface TagEditorProps {
  pageId: string;
  labels: string[];
  editing?: boolean;
}

export function TagEditor({ pageId, labels, editing = false }: TagEditorProps) {
  const [isAdding, setIsAdding] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const updateLabelsMutation = useUpdatePageLabels();

  useEffect(() => {
    if (isAdding && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isAdding]);

  const handleAdd = useCallback(() => {
    const tag = inputValue.trim().toLowerCase();
    if (!tag) {
      setIsAdding(false);
      return;
    }
    if (labels.includes(tag)) {
      toast.info(`Tag "${tag}" already exists`);
      setInputValue('');
      return;
    }
    updateLabelsMutation.mutate(
      { id: pageId, addLabels: [tag] },
      {
        onSuccess: () => {
          setInputValue('');
          setIsAdding(false);
          toast.success(`Tag "${tag}" added`);
        },
        onError: (err) => {
          toast.error(err instanceof Error ? err.message : 'Failed to add tag');
        },
      },
    );
  }, [inputValue, labels, pageId, updateLabelsMutation]);

  const handleRemove = useCallback(
    (tag: string) => {
      updateLabelsMutation.mutate(
        { id: pageId, removeLabels: [tag] },
        {
          onSuccess: () => {
            toast.success(`Tag "${tag}" removed`);
          },
          onError: (err) => {
            toast.error(err instanceof Error ? err.message : 'Failed to remove tag');
          },
        },
      );
    },
    [pageId, updateLabelsMutation],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleAdd();
      } else if (e.key === 'Escape') {
        setIsAdding(false);
        setInputValue('');
      }
    },
    [handleAdd],
  );

  return (
    <div className="flex items-center gap-1 flex-wrap">
      <Tag size={12} className="shrink-0 text-muted-foreground" />
      {labels.map((label) => (
        <span
          key={label}
          className="group flex items-center gap-0.5 rounded bg-white/5 px-1.5 py-0.5 text-xs"
        >
          {label}
          <button
            onClick={() => handleRemove(label)}
            disabled={updateLabelsMutation.isPending}
            className={`ml-0.5 rounded-sm p-0.5 text-muted-foreground hover:bg-white/10 hover:text-foreground ${editing ? 'inline-flex' : 'hidden group-hover:inline-flex'}`}
            aria-label={`Remove tag ${label}`}
          >
            <X size={10} />
          </button>
        </span>
      ))}
      {isAdding ? (
        <input
          ref={inputRef}
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={handleAdd}
          placeholder="tag name"
          disabled={updateLabelsMutation.isPending}
          className="w-24 rounded bg-white/5 px-1.5 py-0.5 text-xs outline-none focus:ring-1 focus:ring-primary"
        />
      ) : (
        <button
          onClick={() => setIsAdding(true)}
          className="flex items-center gap-0.5 rounded px-1 py-0.5 text-xs text-muted-foreground hover:bg-white/5 hover:text-foreground"
          aria-label="Add tag"
        >
          <Plus size={10} />
        </button>
      )}
    </div>
  );
}
