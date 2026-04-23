/**
 * Drain pending draw.io diagrams before the editor-save serialises its HTML
 * (#302 Gap 3).
 *
 * In the TipTap editor, `DrawioDiagramNodeView.handleSave` writes the edited
 * diagram's `pngDataUri` + `xml` into the node's attributes but never
 * flushes the PNG to the backend. The page-level save then serialises HTML
 * via `DrawioDiagram.renderHTML`, which emits the `pngDataUri` into the
 * `<img src="...">` attribute. That's fine for visual parity in the editor
 * — but on reload, the backend returns the stored `body_html` with the
 * huge base64 data URI embedded inline; it works but bloats the row, and
 * the node's `src` attr is still null so the next edit-and-save cycle
 * inflates the row again.
 *
 * This module walks the editor's document, finds every `drawioDiagram`
 * node that has a `pngDataUri` but no server-backed `src`, uploads it via
 * `PUT /api/attachments/:pageId/:filename`, and rewrites the node's
 * attributes with the resolved URL. On success, the serialised HTML
 * references the attachment URL (small) instead of the data URI (huge).
 *
 * Local (non-Confluence) pages currently have no attachment backend —
 * those are tracked in #302 Gap 4 and are no-ops here for now.
 */

import type { Editor } from '@tiptap/core';
import { apiFetch } from '../../lib/api';

export interface DrainOptions {
  /**
   * Attachment-store page id. For Confluence pages this is the
   * `confluenceId`; for standalone pages it's the numeric DB id. When
   * standalone-page attachment storage lands (#302 Gap 4) this will route
   * to a different backend endpoint; until then, standalone pages skip.
   */
  attachmentPageId: string | null;
  /** `confluence` or `standalone` — gates the endpoint choice. */
  pageSource: 'confluence' | 'standalone';
}

export interface DrainResult {
  uploaded: number;
  skipped: number;
  failed: number;
  /** Human-readable reasons for any failures, for the caller to toast. */
  errors: string[];
}

interface PendingDiagram {
  pos: number;
  diagramName: string;
  xml: string | null;
  pngDataUri: string;
}

/**
 * Walk the editor doc and collect every draw.io diagram node that has a
 * locally-edited PNG data URI but no server-backed `src`. These are the
 * ones that would otherwise ship inline base64 into the saved body_html.
 */
function findPendingDiagrams(editor: Editor): PendingDiagram[] {
  const pending: PendingDiagram[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== 'drawioDiagram') return;
    const attrs = node.attrs as {
      diagramName: string | null;
      xml: string | null;
      pngDataUri: string | null;
      src: string | null;
    };
    // Skip diagrams that already have a persisted src (nothing to do) or
    // that have no local edit (nothing to flush).
    if (attrs.src && !attrs.pngDataUri) return;
    if (!attrs.pngDataUri) return;
    pending.push({
      pos,
      diagramName: attrs.diagramName ?? `diagram-${Date.now()}-${pos}`,
      xml: attrs.xml,
      pngDataUri: attrs.pngDataUri,
    });
  });
  return pending;
}

/**
 * Upload a single pending diagram and return the resolved server URL that
 * the node's `src` should point at.
 *
 * Routes to `/api/attachments/…` for Confluence-backed pages and to
 * `/api/local-attachments/…` for standalone pages (#302 Gap 4 backend).
 * Both endpoints accept the same JSON body shape (`dataUri` + optional
 * `xml`), so the rest of the drain logic stays source-agnostic.
 */
async function uploadOne(
  diagram: PendingDiagram,
  attachmentPageId: string,
  pageSource: 'confluence' | 'standalone',
): Promise<string> {
  const filename = `${diagram.diagramName}.png`;
  const basePath = pageSource === 'standalone' ? '/local-attachments' : '/attachments';
  const encodedId = encodeURIComponent(attachmentPageId);
  const encodedName = encodeURIComponent(filename);
  await apiFetch(`${basePath}/${encodedId}/${encodedName}`, {
    method: 'PUT',
    body: JSON.stringify({
      dataUri: diagram.pngDataUri,
      // Push the XML sibling too per #302 Gap 2 — the Confluence route
      // forwards it to Confluence's native draw.io plugin; the local
      // route stores it as a `.drawio` sibling under the same
      // ATTACHMENTS_DIR/local tree.
      ...(diagram.xml ? { xml: diagram.xml } : {}),
    }),
  });
  return `/api${basePath}/${encodedId}/${encodedName}`;
}

/**
 * Main entry. Call from the page-level save path **before** serialising
 * the body HTML. Rewrites the editor's doc in-place so the subsequent
 * `editor.getHTML()` emits the resolved `src` URL instead of the inline
 * data URI.
 */
export async function drainPendingDrawioDiagrams(
  editor: Editor | null,
  opts: DrainOptions,
): Promise<DrainResult> {
  const result: DrainResult = { uploaded: 0, skipped: 0, failed: 0, errors: [] };
  if (!editor) return result;

  const pending = findPendingDiagrams(editor);
  if (pending.length === 0) return result;

  if (!opts.attachmentPageId) {
    result.failed = pending.length;
    result.errors.push('Cannot save diagrams — page has no attachment id.');
    return result;
  }

  // Upload sequentially rather than in parallel. Confluence's attachment
  // endpoint serialises per page anyway, and a burst of parallel PUTs
  // would just trip the per-user rate limit.
  for (const diagram of pending) {
    try {
      const srcUrl = await uploadOne(diagram, opts.attachmentPageId, opts.pageSource);
      // Rewrite the node so the serialised body HTML emits the URL
      // instead of the data URI. We go through the ProseMirror tr API
      // directly (rather than `editor.chain().setNodeAttribute()`, which
      // targets the current selection) because we want to address the
      // node by its document position.
      const currentNode = editor.state.doc.nodeAt(diagram.pos);
      if (!currentNode) {
        result.errors.push(`${diagram.diagramName}: node disappeared between find and update`);
        result.failed++;
        continue;
      }
      const tr = editor.state.tr.setNodeMarkup(diagram.pos, null, {
        ...currentNode.attrs,
        src: srcUrl,
        pngDataUri: null,
        diagramName: currentNode.attrs.diagramName ?? diagram.diagramName,
      });
      editor.view.dispatch(tr);
      result.uploaded++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown upload failure';
      result.errors.push(`${diagram.diagramName}: ${msg}`);
      result.failed++;
    }
  }

  return result;
}
