import { NodeViewWrapper } from '@tiptap/react';
import { useEffect, useState } from 'react';
import { File, FileText, FileImage, FileArchive, FileCode, Loader2 } from 'lucide-react';
import { useParams } from 'react-router-dom';
import type { NodeViewProps } from '@tiptap/react';

interface Attachment {
  filename: string;
  size: number;
  url: string;
}

/** Return a human-readable file size string. */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Pick an icon component based on file extension. */
function FileIcon({ filename }: { filename: string }) {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp'].includes(ext)) {
    return <FileImage size={16} className="text-blue-400 shrink-0" />;
  }
  if (['zip', 'tar', 'gz', 'rar', '7z'].includes(ext)) {
    return <FileArchive size={16} className="text-yellow-400 shrink-0" />;
  }
  if (['js', 'ts', 'py', 'java', 'xml', 'json', 'html', 'css', 'sh'].includes(ext)) {
    return <FileCode size={16} className="text-green-400 shrink-0" />;
  }
  if (['pdf', 'doc', 'docx', 'txt', 'md', 'rtf'].includes(ext)) {
    return <FileText size={16} className="text-orange-400 shrink-0" />;
  }
  return <File size={16} className="text-muted-foreground shrink-0" />;
}

/**
 * React NodeView component for the Confluence attachments macro.
 * Fetches the list of cached attachments from the backend and renders them
 * as a table with download links.
 */
export function AttachmentsMacroView({ editor }: NodeViewProps) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const params = useParams<{ pageId?: string; id?: string }>();
  const pageId = params.pageId ?? params.id;

  useEffect(() => {
    if (!pageId) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/attachments/${encodeURIComponent(pageId)}/list`);
        if (!res.ok) {
          throw new Error(`Failed to load attachments (${res.status})`);
        }
        const data = await res.json();
        if (!cancelled) {
          setAttachments(data.attachments ?? []);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load attachments');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [pageId]);

  const isEditable = editor.isEditable;

  return (
    <NodeViewWrapper className="confluence-attachments-macro my-4">
      <div className="rounded-lg border border-border/50 bg-card/50 overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border/30 bg-muted/30">
          <File size={14} className="text-muted-foreground" />
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Attachments
          </span>
        </div>

        {/* Body */}
        <div className="px-4 py-3">
          {loading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
              <Loader2 size={14} className="animate-spin" />
              <span>Loading attachments...</span>
            </div>
          )}

          {error && (
            <p className="text-sm text-destructive py-2">{error}</p>
          )}

          {!loading && !error && attachments.length === 0 && (
            <p className="text-sm text-muted-foreground py-2">
              {pageId ? 'No attachments found.' : 'Save the page to view attachments.'}
            </p>
          )}

          {!loading && !error && attachments.length > 0 && (
            <ul className="space-y-1">
              {attachments.map((att) => (
                <li key={att.filename} className="flex items-center gap-2 py-1.5 text-sm">
                  <FileIcon filename={att.filename} />
                  {isEditable ? (
                    <span className="truncate">{att.filename}</span>
                  ) : (
                    <a
                      href={att.url}
                      target="_blank"
                      rel="noreferrer"
                      className="truncate text-primary hover:underline"
                    >
                      {att.filename}
                    </a>
                  )}
                  <span className="ml-auto text-xs text-muted-foreground whitespace-nowrap">
                    {formatFileSize(att.size)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </NodeViewWrapper>
  );
}
