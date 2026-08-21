import { useCallback, useState } from 'react';
import { Check, Copy, FilePlus2, Sparkles, X } from 'lucide-react';
import { toast } from 'sonner';
import { useAiContext } from '../AiContext';
import { improveMarkdownToHtml } from '../../../shared/components/article/improve-markdown';

export function DockDraftCard() {
  const { generatedDraft, setGeneratedDraft, isStreaming } = useAiContext();
  const [copied, setCopied] = useState(false);

  const titleMatch = generatedDraft ? generatedDraft.match(/^#{1,3}\s+(.+)$/m) : null;
  const draftTitle = titleMatch?.[1]?.trim() || 'Generated Page Draft';

  const handleApply = useCallback(() => {
    if (!generatedDraft) return;
    const html = improveMarkdownToHtml(generatedDraft);
    window.dispatchEvent(
      new CustomEvent('compendiq:apply-draft', {
        detail: {
          markdown: generatedDraft,
          html,
          title: draftTitle,
        },
      }),
    );
    toast.success('Draft applied to page');
  }, [generatedDraft, draftTitle]);

  const handleCopy = useCallback(async () => {
    if (!generatedDraft) return;
    try {
      await navigator.clipboard.writeText(generatedDraft);
      setCopied(true);
      toast.success('Copied markdown to clipboard');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Failed to copy to clipboard');
    }
  }, [generatedDraft]);

  if (!generatedDraft || isStreaming) return null;

  return (
    <div className="nm-card overflow-hidden" data-testid="dock-draft-card">
      <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Sparkles size={14} className="shrink-0 text-status-ai" aria-hidden />
          <h3 className="truncate text-xs font-semibold text-foreground">
            {draftTitle}
          </h3>
        </div>
        <button
          type="button"
          onClick={() => setGeneratedDraft('')}
          className="nm-icon-button shrink-0 text-muted-foreground hover:text-foreground"
          title="Dismiss draft"
          aria-label="Dismiss draft"
          data-testid="dock-draft-dismiss"
        >
          <X size={13} aria-hidden />
        </button>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border px-3 py-2">
        <button
          type="button"
          onClick={() => void handleCopy()}
          className="nm-button-ghost text-xs"
          data-testid="dock-draft-copy"
        >
          {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button
          type="button"
          onClick={handleApply}
          className="nm-button-primary text-xs"
          data-testid="dock-draft-apply"
        >
          <FilePlus2 size={13} aria-hidden /> Apply to Page
        </button>
      </div>
    </div>
  );
}
