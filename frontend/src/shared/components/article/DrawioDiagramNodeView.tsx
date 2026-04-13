import { useState, useCallback, useRef } from 'react';
import { NodeViewWrapper } from '@tiptap/react';
import { Pencil, Trash2, Plus, GripVertical } from 'lucide-react';
import { DrawioEditor } from '../diagrams/DrawioEditor';
import { cn } from '../../lib/cn';
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
  const [editorOpen, setEditorOpen] = useState(false);
  const isEditable = editor.isEditable;
  const wrapperRef = useRef<HTMLDivElement>(null);

  const { src, alt, diagramName, xml, pngDataUri } = node.attrs;

  // The image to display: prefer pngDataUri (locally edited) over src (server-backed)
  const displaySrc = pngDataUri || src;
  const hasImage = Boolean(displaySrc);
  const hasXml = Boolean(xml);

  const handleEdit = useCallback(() => {
    if (!isEditable) return;
    setEditorOpen(true);
  }, [isEditable]);

  const handleSave = useCallback(
    async (dataUri: string, newXml: string) => {
      updateAttributes({
        pngDataUri: dataUri,
        xml: newXml,
        // Generate a name if none exists
        diagramName: diagramName || `diagram-${Date.now()}`,
      });
      setEditorOpen(false);
    },
    [updateAttributes, diagramName],
  );

  const handleClose = useCallback(() => {
    setEditorOpen(false);
  }, []);

  const handleDelete = useCallback(() => {
    deleteNode();
  }, [deleteNode]);

  // Open editor on double-click
  const handleDoubleClick = useCallback(() => {
    if (isEditable) setEditorOpen(true);
  }, [isEditable]);

  // The XML to send to the editor: use stored xml, or empty template
  const editorXml = xml || EMPTY_DIAGRAM_XML;

  return (
    <NodeViewWrapper className="drawio-nodeview-wrapper" data-testid="drawio-diagram-node">
      <div
        ref={wrapperRef}
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
        ) : (
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
        )}

        {/* Hover overlay with edit/delete buttons */}
        {isEditable && hasImage && (
          <div className="drawio-nodeview__overlay">
            <button
              type="button"
              className="drawio-nodeview__btn drawio-nodeview__btn--edit"
              onClick={handleEdit}
              title="Edit diagram"
              data-testid="drawio-edit-btn"
            >
              <Pencil size={14} />
              <span>Edit</span>
            </button>
            <button
              type="button"
              className="drawio-nodeview__btn drawio-nodeview__btn--delete"
              onClick={handleDelete}
              title="Delete diagram"
              data-testid="drawio-delete-btn"
            >
              <Trash2 size={14} />
            </button>
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
      {editorOpen && (
        <DrawioEditor xml={editorXml} onSave={handleSave} onClose={handleClose} />
      )}
    </NodeViewWrapper>
  );
}
