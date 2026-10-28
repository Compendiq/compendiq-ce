import { useState, useCallback } from 'react';
import { NodeViewWrapper } from '@tiptap/react';
import { Pencil, Trash2, Plus, GripVertical } from 'lucide-react';
import { DrawioEditor } from '../diagrams/DrawioEditor';
import { useAuthenticatedSrc } from '../../hooks/use-authenticated-src';
import { useAuthStore } from '../../../stores/auth-store';
import { refreshAccessTokenOnce } from '../../lib/api';
import { cn } from '../../lib/cn';
import { Button, IconButton } from '../Button';
import type { NodeViewProps } from '@tiptap/react';

/**
 * Default empty draw.io diagram XML used when creating a new diagram.
 */
const EMPTY_DIAGRAM_XML =
  '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>';

/**
 * React component rendered inside the TipTap editor for draw.io diagram nodes.
 *
 * Shows a preview of the diagram image with an overlay to edit (opens the
 * full-screen DrawioEditor) or delete. For new diagrams that have no image
 * yet, renders a clickable placeholder.
 */
export function DrawioDiagramNodeView({ node, updateAttributes, deleteNode, editor }: NodeViewProps) {
  const [editorXml, setEditorXml] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isEditable = editor.isEditable;

  const { src, alt, diagramName, xml, pngDataUri, drawioSource } = node.attrs;

  // The image to display: prefer pngDataUri (locally edited) over src (server-backed)
  const { blobSrc } = useAuthenticatedSrc(pngDataUri ? null : src);
  const displaySrc = pngDataUri || blobSrc || src;
  const hasImage = Boolean(pngDataUri || src);
  const hasXml = Boolean(xml);
  const isExisting = Boolean(diagramName || xml || src || pngDataUri || drawioSource);

  const handleEdit = useCallback(async () => {
    if (!isEditable || loading) return;
    setError(null);
    if (xml || !isExisting) {
      setEditorXml(xml || EMPTY_DIAGRAM_XML);
      return;
    }

    // Older preview-backed diagrams can still be opened from their PNG+XML.
    const source = drawioSource || src;
    if (!source || (drawioSource && !source.startsWith('/api/attachments/') && !source.startsWith('/api/local-attachments/'))) {
      setError('Diagram source is unavailable. Try again when the source is available.');
      return;
    }
    setLoading(true);
    try {
      const headers: HeadersInit = {};
      const token = useAuthStore.getState().accessToken;
      if (token && source.startsWith('/api/')) headers.Authorization = `Bearer ${token}`;
      let response = await fetch(source, { headers, credentials: 'include', cache: 'no-store' });
      if (response.status === 401 && source.startsWith('/api/')) {
        const refreshed = await refreshAccessTokenOnce();
        if (refreshed) {
          headers.Authorization = `Bearer ${refreshed}`;
          response = await fetch(source, { headers, credentials: 'include', cache: 'no-store' });
        }
      }
      if (!response.ok) throw new Error('Source request failed');
      let content: string;
      if (drawioSource) {
        content = await response.text();
      } else {
        const blob = await response.blob();
        content = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        });
      }
      if (!content.trim()) throw new Error('Source is empty');
      setEditorXml(content);
    } catch {
      setError('Could not load the diagram source. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [isEditable, loading, xml, isExisting, drawioSource, src]);

  const handleSave = useCallback(
    async (dataUri: string, newXml: string) => {
      updateAttributes({
        pngDataUri: dataUri,
        xml: newXml,
        drawioSource: null,
        // Generate a name if none exists
        diagramName: diagramName || `diagram-${Date.now()}`,
      });
      setEditorXml(null);
    },
    [updateAttributes, diagramName],
  );

  const handleClose = useCallback(() => {
    setEditorXml(null);
  }, []);

  const handleDelete = useCallback(() => {
    deleteNode();
  }, [deleteNode]);

  const handleDoubleClick = useCallback(() => {
    void handleEdit();
  }, [handleEdit]);

  return (
    <NodeViewWrapper className="drawio-nodeview-wrapper" data-testid="drawio-diagram-node">
      <div
        contentEditable={false}
        className={cn(
          'drawio-nodeview group relative',
          !hasImage && 'drawio-nodeview--empty',
        )}
        onDoubleClick={handleDoubleClick}
      >
        {/* Drag handle */}
        {isEditable && (
          <div
            className="drawio-nodeview__drag-handle"
            data-drag-handle=""
            contentEditable={false}
            title="Drag to reorder"
          >
            <GripVertical size={14} />
          </div>
        )}

        {hasImage ? (
          /* Diagram preview image */
          <div className="drawio-nodeview__preview">
            <img
              src={displaySrc}
              alt={alt || `Draw.io diagram: ${diagramName || 'untitled'}`}
              draggable={false}
            />
          </div>
        ) : isExisting ? (
          <div className="drawio-nodeview__placeholder" data-testid="drawio-unavailable">
            <span>Preview unavailable{diagramName ? `: ${diagramName}` : ''}</span>
            {isEditable && (
              <div className="flex gap-2">
                <Button type="button" variant="primary" size="sm" onClick={handleEdit} disabled={loading} data-testid="drawio-edit-btn">
                  {loading ? 'Loading source…' : 'Edit diagram'}
                </Button>
                <IconButton variant="destructive-ghost" size="icon-sm" onClick={handleDelete} label="Delete diagram" title="Delete diagram" testid="drawio-delete-btn" icon={<Trash2 size={14} />} />
              </div>
            )}
          </div>
        ) : isEditable ? (
          /* Empty placeholder for new diagrams */
          <button
            type="button"
            className="drawio-nodeview__placeholder"
            onClick={handleEdit}
            data-testid="drawio-placeholder"
          >
            <Plus size={24} />
            <span>Click to create a draw.io diagram</span>
          </button>
        ) : null}
        {error && <p role="alert">{error}</p>}

        {/* Hover overlay with edit/delete buttons */}
        {isEditable && hasImage && (
          <div className="drawio-nodeview__overlay">
            <Button
              type="button"
              variant="primary"
              size="sm"
              className="drawio-nodeview__btn drawio-nodeview__btn--edit"
              onClick={handleEdit}
              title="Edit diagram"
              leftIcon={<Pencil size={14} />}
              data-testid="drawio-edit-btn"
            >
              <span>Edit</span>
            </Button>
            <IconButton
              variant="destructive-ghost"
              size="icon-sm"
              className="drawio-nodeview__btn drawio-nodeview__btn--delete"
              onClick={handleDelete}
              title="Delete diagram"
              label="Delete diagram"
              testid="drawio-delete-btn"
              icon={<Trash2 size={14} />}
            />
          </div>
        )}

        {/* Label */}
        {diagramName && hasImage && (
          <div className="drawio-nodeview__label">
            {diagramName}
            {!hasXml && <span className="drawio-nodeview__badge">Confluence</span>}
          </div>
        )}
      </div>

      {/* Full-screen draw.io editor overlay */}
      {editorXml !== null && (
        <DrawioEditor xml={editorXml} onSave={handleSave} onClose={handleClose} />
      )}
    </NodeViewWrapper>
  );
}
