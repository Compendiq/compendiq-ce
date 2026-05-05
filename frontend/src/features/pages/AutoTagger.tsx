import { useState, useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { m, AnimatePresence } from 'framer-motion';
import { Check, X, Loader2, Tag } from 'lucide-react';
import { toast } from 'sonner';
import { apiFetch } from '../../shared/lib/api';
import { cn } from '../../shared/lib/cn';

interface AutoTagResult {
  suggestedTags: string[];
  existingLabels: string[];
}

interface AutoTaggerProps {
  pageId: string;
  currentLabels: string[];
  model: string;
  className?: string;
}

export function AutoTagger({ pageId, currentLabels, model, className }: AutoTaggerProps) {
  const queryClient = useQueryClient();
  const [showDialog, setShowDialog] = useState(false);
  const [suggestedTags, setSuggestedTags] = useState<string[]>([]);
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());

  const autoTagMutation = useMutation({
    mutationFn: () =>
      apiFetch<AutoTagResult>(`/pages/${pageId}/auto-tag`, {
        method: 'POST',
        body: JSON.stringify({ model }),
      }),
    onSuccess: (data) => {
      const newTags = data.suggestedTags.filter((t) => !currentLabels.includes(t));
      if (newTags.length === 0) {
        toast.info('No new tags suggested - all relevant tags already applied');
        return;
      }
      setSuggestedTags(newTags);
      setSelectedTags(new Set(newTags));
      setShowDialog(true);
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Auto-tagging failed');
    },
  });

  const applyTagsMutation = useMutation({
    mutationFn: (tags: string[]) =>
      apiFetch(`/pages/${pageId}/apply-tags`, {
        method: 'POST',
        body: JSON.stringify({ tags }),
      }),
    onSuccess: () => {
      toast.success('Tags applied successfully');
      setShowDialog(false);
      setSuggestedTags([]);
      queryClient.invalidateQueries({ queryKey: ['pages', pageId] });
      queryClient.invalidateQueries({ queryKey: ['pages'] });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to apply tags');
    },
  });

  const toggleTag = useCallback((tag: string) => {
    setSelectedTags((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) {
        next.delete(tag);
      } else {
        next.add(tag);
      }
      return next;
    });
  }, []);

  const handleApply = () => {
    const tags = Array.from(selectedTags);
    if (tags.length === 0) {
      toast.info('No tags selected');
      return;
    }
    applyTagsMutation.mutate(tags);
  };

  return (
    <>
      <button
        onClick={() => autoTagMutation.mutate()}
        disabled={autoTagMutation.isPending}
        className={className ?? "nm-card flex items-center gap-1.5 px-3 py-1.5 text-sm hover:bg-foreground/5 disabled:opacity-50"}
        title="Suggest tags using AI"
      >
        {autoTagMutation.isPending ? (
          <Loader2 size={14} className="animate-spin" />
        ) : (
          <Tag size={15} className="shrink-0 opacity-70" />
        )}
        <span className="truncate">Auto-tag</span>
      </button>

      {/* Tag suggestion dialog */}
      <AnimatePresence>
        {showDialog && (
          <m.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
            onClick={() => setShowDialog(false)}
          >
            <m.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              onClick={(e) => e.stopPropagation()}
              className="nm-card mx-4 w-full max-w-md overflow-hidden"
            >
              {/* Dialog header */}
              <div className="flex items-center justify-between border-b border-border/50 px-5 py-4">
                <div className="flex items-center gap-2">
                  <Tag size={16} className="text-primary" />
                  <h3 className="font-semibold">Suggested Tags</h3>
                </div>
                <button
                  onClick={() => setShowDialog(false)}
                  className="rounded p-1 text-muted-foreground hover:bg-foreground/5"
                >
                  <X size={16} />
                </button>
              </div>

              {/* Tag chips */}
              <div className="p-5">
                <p className="mb-3 text-sm text-muted-foreground">
                  Select the tags you want to apply:
                </p>
                <div className="flex flex-wrap gap-2">
                  {suggestedTags.map((tag) => (
                    <button
                      key={tag}
                      onClick={() => toggleTag(tag)}
                      className={cn(
                        'flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition-colors',
                        selectedTags.has(tag)
                          ? 'bg-primary/20 text-primary ring-1 ring-primary/30'
                          : 'bg-foreground/5 text-muted-foreground hover:bg-foreground/10',
                      )}
                    >
                      {selectedTags.has(tag) && <Check size={12} />}
                      {tag}
                    </button>
                  ))}
                </div>

                {currentLabels.length > 0 && (
                  <div className="mt-4">
                    <p className="mb-2 text-xs text-muted-foreground">Current labels:</p>
                    <div className="flex flex-wrap gap-1">
                      {currentLabels.map((label) => (
                        <span
                          key={label}
                          className="rounded bg-foreground/5 px-2 py-0.5 text-xs text-muted-foreground"
                        >
                          {label}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Actions */}
              <div className="flex items-center justify-end gap-3 border-t border-border/50 px-5 py-3">
                <button
                  onClick={() => setShowDialog(false)}
                  className="rounded-lg border border-border/50 px-4 py-2 text-sm text-muted-foreground hover:bg-foreground/5"
                >
                  Cancel
                </button>
                <button
                  onClick={handleApply}
                  disabled={selectedTags.size === 0 || applyTagsMutation.isPending}
                  className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  {applyTagsMutation.isPending ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <Check size={14} />
                  )}
                  Apply {selectedTags.size} {selectedTags.size === 1 ? 'tag' : 'tags'}
                </button>
              </div>
            </m.div>
          </m.div>
        )}
      </AnimatePresence>
    </>
  );
}
