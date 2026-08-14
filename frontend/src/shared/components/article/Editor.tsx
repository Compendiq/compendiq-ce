import { useEffect, useRef, useCallback, useState } from 'react';
import { useEditor, useEditorState, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { TableRow, TableCell, TableHeader } from '@tiptap/extension-table';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import { Image } from '@tiptap/extension-image';
import { TitledCodeBlock } from './TitledCodeBlock';
import { Placeholder } from '@tiptap/extensions';
import TextAlign from '@tiptap/extension-text-align';
import { Highlight } from '@tiptap/extension-highlight';
import { TextStyle } from '@tiptap/extension-text-style';
import { Color } from '@tiptap/extension-color';
import { lowlight } from '../../lib/lowlight';
import { SearchAndReplaceExtension } from './search-extension';
import { SearchAndReplace } from './SearchAndReplace';
import { ArrowLeftFromLine, ArrowRightFromLine, Trash2, Columns3, Square } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '../../lib/cn';
import { apiFetch } from '../../lib/api';
import { fetchAuthenticatedBlob } from '../../hooks/use-authenticated-src';
import { useIsLightTheme } from '../../hooks/use-is-light-theme';
import { useUiStore } from '../../../stores/ui-store';
import { MermaidBlock } from './MermaidBlockExtension';
import {
  ConfluenceLayout,
  ConfluenceLayoutSection,
  ConfluenceLayoutCell,
  ConfluenceSection,
  ConfluenceColumn,
  ConfluenceChildren,
  ConfluenceStatus,
  ConfluenceAttachments,
  ConfluenceToc,
  ConfluenceJiraIssue,
  ConfluenceUserMention,
  ConfluenceIncludeMacro,
  ConfluenceLabelsMacro,
  Panel,
  UnknownMacro,
  Details,
  DetailsSummary,
  DrawioDiagram,
  Figure,
  Figcaption,
  TableCaption,
  FigureIndex,
  TableIndex,
  isInConfluenceSection,
  isInConfluenceLayout,
  LAYOUT_PRESETS,
  ExtendedTable,
} from './article-extensions';
import type { Editor as EditorType } from '@tiptap/react';
import { VimExtension, type VimState } from './vim-extension';
import { VimModeIndicator } from './VimModeIndicator';
import { EditorBubbleMenu } from './EditorBubbleMenu';
import { EditorBlockHandle } from './EditorBlockMenu';
import { TableContextToolbar, EditorTableOverlay, FloatingTableToolbar } from './EditorTableControls';
export { TableContextToolbar, EditorTableOverlay, FloatingTableToolbar };
import { handleTableCellTripleClick } from './table-cell-selection';
import { ToolbarButton, ToolbarSeparator, LayoutPreview } from './editor-toolbar-primitives';

/**
 * The main toolbar moved to its own module when its 27 flat icons were
 * restructured into menus; it is re-exported here because `PageViewPage`,
 * `NewPagePage` and the editor tests all import it alongside `Editor`, and the
 * three context strips below still live in this file.
 */
import { EditorToolbar } from './EditorToolbar';
export { EditorToolbar };

const ConfluenceImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      'data-confluence-image-source': {
        default: null,
        parseHTML: (element) => element.getAttribute('data-confluence-image-source'),
        renderHTML: (attributes) => attributes['data-confluence-image-source']
          ? { 'data-confluence-image-source': attributes['data-confluence-image-source'] }
          : {},
      },
      'data-confluence-filename': {
        default: null,
        parseHTML: (element) => element.getAttribute('data-confluence-filename'),
        renderHTML: (attributes) => attributes['data-confluence-filename']
          ? { 'data-confluence-filename': attributes['data-confluence-filename'] }
          : {},
      },
      'data-confluence-owner-page-title': {
        default: null,
        parseHTML: (element) => element.getAttribute('data-confluence-owner-page-title'),
        renderHTML: (attributes) => attributes['data-confluence-owner-page-title']
          ? { 'data-confluence-owner-page-title': attributes['data-confluence-owner-page-title'] }
          : {},
      },
      'data-confluence-owner-space-key': {
        default: null,
        parseHTML: (element) => element.getAttribute('data-confluence-owner-space-key'),
        renderHTML: (attributes) => attributes['data-confluence-owner-space-key']
          ? { 'data-confluence-owner-space-key': attributes['data-confluence-owner-space-key'] }
          : {},
      },
      'data-confluence-url': {
        default: null,
        parseHTML: (element) => element.getAttribute('data-confluence-url'),
        renderHTML: (attributes) => attributes['data-confluence-url']
          ? { 'data-confluence-url': attributes['data-confluence-url'] }
          : {},
      },
      // Set by the HTML-paste handler (#683) when an inline `<img src=…>` in
      // pasted HTML can't be auto-imported (relative path, fetch failure,
      // unsupported type). The CSS placeholder targets this attribute to
      // render the broken-image affordance instead of letting the browser
      // show its native 404 icon.
      'data-import-failed': {
        default: null,
        parseHTML: (element) => element.getAttribute('data-import-failed'),
        renderHTML: (attributes) => attributes['data-import-failed']
          ? { 'data-import-failed': attributes['data-import-failed'] }
          : {},
      },
    };
  },

  // Browser `img` tags cannot send Authorization headers, so the JWT-gated
  // `/api/attachments/...` endpoint returns 401 for every direct image load —
  // both for pasted uploads and for Confluence-synced attachments. The
  // ArticleViewer (read mode) works around this by rewriting srcs to blob
  // URLs fetched with `fetchAuthenticatedBlob`. Without this NodeView, images
  // in edit mode never render. The blob URL is display-only — `node.attrs.src`
  // remains the canonical `/api/attachments/...` URL so `editor.getHTML()`
  // serialises the right thing on save.
  addNodeView() {
    return ({ node, HTMLAttributes }) => {
      const dom = document.createElement('img');
      // Match TipTap's default Image behaviour for selection and drag.
      dom.setAttribute('contenteditable', 'false');
      dom.setAttribute('draggable', 'true');

      let blobUrl: string | null = null;
      let currentSrc = node.attrs.src as string | null;
      // Tracks the keys we've ever written to the DOM (other than `src`), so
      // we can remove ones that disappear from the node's attrs on update.
      // Without this, e.g. clearing an `alt` would leave the stale value in
      // the DOM until the editor remounts.
      const writtenAttrKeys = new Set<string>();
      // Set on destroy so any in-flight auth fetch can revoke its blob URL
      // instead of leaking it. The previous `currentSrc !== src` guard only
      // covered src-change races, not the case where the NodeView itself was
      // torn down while a fetch was still pending.
      let destroyed = false;

      function applySrc(src: string | null): void {
        if (blobUrl) {
          URL.revokeObjectURL(blobUrl);
          blobUrl = null;
        }
        if (!src) {
          dom.removeAttribute('src');
          return;
        }
        if (src.startsWith('/api/attachments/') || src.startsWith('/api/local-attachments/')) {
          // Defer src until the auth fetch resolves to avoid a flash of the
          // 401 broken-image icon.
          dom.removeAttribute('src');
          dom.setAttribute('data-original-src', src);
          fetchAuthenticatedBlob(src).then((url) => {
            // Three exit paths in priority order. `destroyed` MUST win over
            // the src-change check — after destroy, currentSrc may still
            // equal src and would otherwise leak the blob URL.
            if (destroyed) {
              if (url) URL.revokeObjectURL(url);
              return;
            }
            if (currentSrc !== src) {
              if (url) URL.revokeObjectURL(url);
              return;
            }
            if (url) {
              blobUrl = url;
              dom.setAttribute('src', url);
            }
          }).catch(() => {
            // Swallow — leaving the img without a src renders nothing, which
            // is the same outcome the unauthenticated direct load produced.
          });
        } else {
          dom.setAttribute('src', src);
        }
      }

      function syncAttrs(attrs: Record<string, unknown>): void {
        // Apply present attrs and track the keys we touched.
        const seen = new Set<string>();
        for (const [key, value] of Object.entries(attrs)) {
          if (key === 'src' || value == null) continue;
          dom.setAttribute(key, String(value));
          writtenAttrKeys.add(key);
          seen.add(key);
        }
        // Remove any attr we previously wrote that's gone this time around.
        for (const key of writtenAttrKeys) {
          if (!seen.has(key)) {
            dom.removeAttribute(key);
            writtenAttrKeys.delete(key);
          }
        }
      }

      // Initial render mirrors the merged renderHTML attributes (HTMLAttributes
      // already includes parent Image's `alt`/`title`/`width`/etc. plus our
      // custom `data-confluence-*` keys).
      syncAttrs(HTMLAttributes);

      applySrc(currentSrc);

      return {
        dom,
        update(newNode) {
          if (newNode.type !== node.type) return false;
          const newSrc = (newNode.attrs.src as string | null) ?? null;
          if (newSrc !== currentSrc) {
            currentSrc = newSrc;
            applySrc(newSrc);
          }
          // On update, node.attrs is the canonical source (renderHTML
          // transforms aren't re-applied here, but our addAttributes uses
          // identity transforms so the shape matches what we wrote initially).
          syncAttrs(newNode.attrs as Record<string, unknown>);
          return true;
        },
        destroy() {
          destroyed = true;
          if (blobUrl) URL.revokeObjectURL(blobUrl);
        },
      };
    };
  },
});

interface EditorProps {
  content?: string;
  /**
   * Fired on every document change with a `dirty` flag (always `true`). This is
   * intentionally a cheap boolean, NOT the serialized HTML: serializing the
   * whole document (getHTML) on the hot per-keystroke path is O(doc) and, when
   * the parent stored the result in React state, re-rendered the page on every
   * keystroke (#954). Read the current HTML from the editor instance
   * (via `onEditorReady`) only when you actually need it — e.g. on save.
   */
  onChange?: (dirty: boolean) => void;
  editable?: boolean;
  placeholder?: string;
  /** Key for localStorage auto-save (e.g. "page-draft-12345"). Omit to disable. */
  draftKey?: string;
  /** Remove the nm-card wrapper (use inside an already-styled card). Default false. */
  naked?: boolean;
  /** Callback fired when the TipTap editor instance is ready (or destroyed). */
  onEditorReady?: (editor: EditorType | null) => void;
  /** Hide built-in toolbar. Default false. */
  hideToolbar?: boolean;
  /** Page ID for image paste/drop uploads. When set, clipboard images are uploaded to this page. */
  pageId?: string;
  /** Callback to trigger a server-side save (used by vim :w command). */
  onSave?: () => void;
}

export function LayoutContextToolbar({ editor }: { editor: EditorType }) {
  const { inLayout, currentType } = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      inLayout: isInConfluenceLayout(e),
      currentType: (e.getAttributes('confluenceLayoutSection')['data-layout-type'] ?? '') as string,
    }),
  });
  if (!inLayout) return null;

  return (
    <div
      data-testid="layout-context-toolbar"
      className="flex flex-wrap items-center gap-0.5 border-t border-action/20 bg-action/5 px-2 py-1.5"
    >
      <span className="mr-1 text-xs font-semibold text-action/70 select-none">Layout</span>

      <ToolbarSeparator />

      {LAYOUT_PRESETS.map((preset) => (
        <ToolbarButton
          key={preset.type}
          onClick={() => editor.chain().focus().changeLayoutType({ layoutType: preset.type }).run()}
          active={currentType === preset.type}
          title={preset.label}
        >
          <LayoutPreview bars={preset.bars} />
        </ToolbarButton>
      ))}

      <div className="flex-1" />

      <ToolbarButton
        onClick={() => editor.chain().focus().deleteLayout().run()}
        title="Delete layout"
      >
        <Trash2 size={15} className="text-destructive/70" />
      </ToolbarButton>
    </div>
  );
}

export function ColumnContextToolbar({ editor }: { editor: EditorType }) {
  const { inSection, hasBorder } = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      inSection: isInConfluenceSection(e),
      hasBorder: e.getAttributes('confluenceSection').border === 'true',
    }),
  });
  if (!inSection) return null;

  return (
    <div
      data-testid="column-context-toolbar"
      className="flex flex-wrap items-center gap-0.5 border-t border-action/20 bg-action/5 px-2 py-1.5"
    >
      <span className="mr-1 text-xs font-semibold text-action/70 select-none">Columns</span>

      <ToolbarSeparator />

      {/* Add/remove columns */}
      <ToolbarButton
        onClick={() => editor.chain().focus().addSectionColumnBefore().run()}
        disabled={!editor.can().addSectionColumnBefore()}
        title="Add column before"
      >
        <ArrowLeftFromLine size={15} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().addSectionColumnAfter().run()}
        disabled={!editor.can().addSectionColumnAfter()}
        title="Add column after"
      >
        <ArrowRightFromLine size={15} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().removeSectionColumn().run()}
        disabled={!editor.can().removeSectionColumn()}
        title="Remove column"
      >
        <Columns3 size={15} className="text-destructive/70" />
      </ToolbarButton>

      <ToolbarSeparator />

      {/* Toggle border */}
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleSectionBorder().run()}
        active={hasBorder}
        title="Toggle border"
      >
        <Square size={15} />
      </ToolbarButton>

      <div className="flex-1" />

      {/* Delete row (section = row in Confluence layout model) */}
      <ToolbarButton
        onClick={() => editor.chain().focus().deleteSection().run()}
        disabled={!editor.can().deleteSection()}
        title="Delete row"
      >
        <Trash2 size={15} className="text-destructive/70" />
      </ToolbarButton>
    </div>
  );
}

/** Map MIME type to file extension for pasted images */
const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/**
 * Upload a pasted/dropped image file to the server.
 * Returns the served URL on success, or null on failure (shows a toast).
 */
async function uploadPastedImage(file: File, pageId: string): Promise<string | null> {
  const ext = MIME_TO_EXT[file.type];
  if (!ext) {
    toast.error(`Unsupported image type: ${file.type}`);
    return null;
  }

  const hex = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
  const filename = `paste-${Date.now()}-${hex}.${ext}`;

  const dataUri = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

  try {
    const result = await apiFetch<{ url: string }>(
      `/pages/${encodeURIComponent(pageId)}/images`,
      {
        method: 'POST',
        body: JSON.stringify({ dataUri, filename }),
      },
    );
    return result.url;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to upload image';
    toast.error(message);
    return null;
  }
}

/**
 * True when `src` points at one of our own backend attachment routes. We never
 * try to re-import these — they're already where we want them.
 */
function isInternalAttachmentSrc(src: string): boolean {
  return src.startsWith('/api/attachments/') || src.startsWith('/api/local-attachments/');
}

/**
 * Tiny FIFO semaphore — caps how many import requests we keep in flight at
 * once. Pasting HTML with dozens of images would otherwise fire every upload
 * in parallel and risk tripping the backend's global rate limit (300/min).
 */
function makeConcurrencyLimiter(max: number): <T>(fn: () => Promise<T>) => Promise<T> {
  const queue: Array<() => void> = [];
  let inFlight = 0;
  const tryDequeue = () => {
    if (inFlight >= max) return;
    const next = queue.shift();
    if (next) { inFlight++; next(); }
  };
  // `<T,>` rather than `<T>` so the .tsx parser doesn't mistake the type
  // parameter for a JSX tag.
  return async <T,>(fn: () => Promise<T>): Promise<T> => {
    if (inFlight >= max) {
      await new Promise<void>((resolve) => queue.push(resolve));
    } else {
      inFlight++;
    }
    try {
      return await fn();
    } finally {
      inFlight--;
      tryDequeue();
    }
  };
}

/**
 * Upload an image referenced by a `data:image/...;base64,...` URI via the
 * existing per-page upload endpoint. Returns the internal `/api/attachments/…`
 * URL on success, or `null` on failure (logs a console warning so failures
 * are triagable from user reports).
 */
async function importDataUriImage(dataUri: string, pageId: string): Promise<string | null> {
  // Pull the MIME so we can pick a sensible extension; the schema on the
  // server requires `^[\w.-]+$` for the filename, so we generate a fresh
  // one here rather than trusting whatever the source HTML implied.
  const mimeMatch = /^data:(image\/([a-z+.-]+));base64,/.exec(dataUri);
  if (!mimeMatch) return null;
  const ext = MIME_TO_EXT[mimeMatch[1]!] ?? mimeMatch[2]!;
  const hex = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
  const filename = `imported-${Date.now()}-${hex}.${ext}`;
  try {
    const result = await apiFetch<{ url: string }>(
      `/pages/${encodeURIComponent(pageId)}/images`,
      { method: 'POST', body: JSON.stringify({ dataUri, filename }) },
    );
    return result.url;
  } catch (err) {
    console.warn('[paste-import] data: URI import failed', { mime: mimeMatch[1], err });
    return null;
  }
}

/**
 * Server-side fetch + import for an absolute `http(s)://` source URL via the
 * `/import` endpoint. The backend SSRF-guards the URL and stores it via the
 * same attachment infrastructure pasted uploads use.
 */
async function importHttpImage(sourceUrl: string, pageId: string): Promise<string | null> {
  try {
    const result = await apiFetch<{ url: string }>(
      `/pages/${encodeURIComponent(pageId)}/images/import`,
      { method: 'POST', body: JSON.stringify({ url: sourceUrl }) },
    );
    return result.url;
  } catch (err) {
    console.warn('[paste-import] http(s) import failed', { sourceUrl, err });
    return null;
  }
}

/** Max upload requests in flight at once during a single paste. Five is
 *  a conservative middle ground — well under the backend's 300/min global
 *  rate limit even when several users paste simultaneously. */
const PASTE_IMPORT_CONCURRENCY = 5;

/**
 * Walk pasted HTML and replace any non-internal `img` srcs with our own
 * attachment URLs (#683). Mutates a clone of the input; returns the rewritten
 * HTML plus a summary of imports for the user-facing toast.
 *
 * Decision tree per src:
 *   - already-internal (`/api/attachments/...`)  → leave alone, count as "imported"
 *   - `data:image/...`                           → upload via /api/pages/:id/images
 *   - `http(s)://...`                            → import via /api/pages/:id/images/import
 *   - anything else (relative, file:, …)         → leave src, set `data-import-failed`
 *
 * Failed imports get `data-import-failed="true"` so the editor's CSS
 * placeholder renders a "couldn't import" affordance instead of a native
 * broken-image icon.
 *
 * Imports are run through a small concurrency limiter so pasting a 50-image
 * document doesn't fire 50 simultaneous backend fetches.
 */
async function rewriteHtmlImageSrcs(
  html: string,
  pageId: string,
): Promise<{ html: string; imported: number; failed: number; total: number }> {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const imgs = Array.from(doc.querySelectorAll('img'));
  let imported = 0;
  let failed = 0;
  const limit = makeConcurrencyLimiter(PASTE_IMPORT_CONCURRENCY);

  const pending = imgs.map((img) => limit(async () => {
    const src = img.getAttribute('src') ?? '';
    if (!src) {
      img.setAttribute('data-import-failed', 'true');
      failed += 1;
      return;
    }
    if (isInternalAttachmentSrc(src)) {
      // Already pointing at our backend — nothing to import, count as a
      // success for the toast's "Imported N of M" math.
      imported += 1;
      return;
    }
    let newSrc: string | null = null;
    if (src.startsWith('data:image/')) {
      newSrc = await importDataUriImage(src, pageId);
    } else if (/^https?:\/\//i.test(src)) {
      newSrc = await importHttpImage(src, pageId);
    } else {
      // Relative path (`../_images/...`), `file:`, blob:, etc. — no auto-fix.
      img.setAttribute('data-import-failed', 'true');
      failed += 1;
      return;
    }
    if (newSrc) {
      img.setAttribute('src', newSrc);
      // Strip any pre-existing `data-import-failed` from a previous round.
      img.removeAttribute('data-import-failed');
      imported += 1;
    } else {
      img.setAttribute('data-import-failed', 'true');
      failed += 1;
    }
  }));

  await Promise.allSettled(pending);
  // `body.innerHTML` is what we want for clipboard HTML — DOMParser wraps the
  // input in `<html><body>`, and the editor's `insertContent` expects bare
  // fragment HTML.
  return { html: doc.body.innerHTML, imported, failed, total: imgs.length };
}

const AUTO_SAVE_DELAY = 2000;

// eslint-disable-next-line react-refresh/only-export-components
export function getDraft(key: string): string | null {
  try {
    return localStorage.getItem(`draft:${key}`);
  } catch {
    return null;
  }
}

// Keys whose pending unmount-flush must be suppressed because the parent
// explicitly cleared the draft (page saved or edit cancelled). Prevents the
// #877 flush-on-unmount from resurrecting a draft the user just discarded.
const suppressedFlushKeys = new Set<string>();

// eslint-disable-next-line react-refresh/only-export-components
export function clearDraft(key: string): void {
  try {
    localStorage.removeItem(`draft:${key}`);
  } catch { /* ignore */ }
  suppressedFlushKeys.add(key);
}

function defaultVimDisplayState(): VimState {
  return { mode: 'normal', pendingKeys: '', countPrefix: '', register: '', commandBuffer: null };
}

export function Editor({ content, onChange, editable = true, placeholder, draftKey, naked = false, onEditorReady, hideToolbar = false, pageId, onSave }: EditorProps) {
  const isLight = useIsLightTheme();
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  // draftKey of a debounced draft awaiting write, so unmount can flush it
  // (#877). We store only the key and serialize the editor lazily at flush
  // time (#954) rather than snapshotting getHTML() on every keystroke.
  const pendingDraftRef = useRef<string | null>(null);
  // Ref for the editor instance so async paste/drop handlers can insert images
  const editorRef = useRef<EditorType | null>(null);
  // Keep pageId in a ref so editorProps closures see the latest value
  const pageIdRef = useRef(pageId);
  pageIdRef.current = pageId;
  // Keep onSave in a ref so the VimExtension closure always sees the latest callback
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  const [headerNumbering, setHeaderNumbering] = useState(() =>
    localStorage.getItem('editor-header-numbering') === 'true'
  );

  const toggleHeaderNumbering = () => {
    setHeaderNumbering(prev => {
      localStorage.setItem('editor-header-numbering', String(!prev));
      return !prev;
    });
  };

  // Vim mode is a personal editing preference, toggled from Settings -> Appearance
  // (ui-store's vimModeEnabled), not from a permanent slot in the toolbar every
  // document loads with. A single global source means every open editor picks up
  // the change together, rather than each instance carrying its own copy of the
  // same on/off switch.
  const vimEnabled = useUiStore((s) => s.vimModeEnabled);
  const [vimDisplayState, setVimDisplayState] = useState<VimState>(defaultVimDisplayState);

  // Reset the status-line state when Vim mode is turned off elsewhere (the
  // toggle no longer lives in this component to clear it inline).
  useEffect(() => {
    if (!vimEnabled) setVimDisplayState(defaultVimDisplayState());
  }, [vimEnabled]);

  const saveDraft = useCallback(() => {
    if (!draftKey) return;
    // Fresh edits mean there IS unsaved work again — allow it to be flushed.
    suppressedFlushKeys.delete(draftKey);
    pendingDraftRef.current = draftKey;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      // Serialize lazily here (once per debounce window) instead of on every
      // keystroke (#954). editorRef is still live — the timer only fires while
      // mounted; the unmount path clears it and flushes separately below.
      try {
        const html = editorRef.current?.getHTML();
        if (html != null) localStorage.setItem(`draft:${draftKey}`, html);
      } catch { /* quota exceeded — ignore */ }
      pendingDraftRef.current = null;
      timerRef.current = undefined;
    }, AUTO_SAVE_DELAY);
  }, [draftKey]);

  // Flush any pending debounced draft on unmount so navigating away within
  // the AUTO_SAVE_DELAY window still persists the last edit (#877). Skip keys
  // the parent explicitly cleared (save/cancel) to avoid resurrecting a
  // discarded draft. Uses refs only, so [] deps are correct.
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const pendingKey = pendingDraftRef.current;
    if (pendingKey && !suppressedFlushKeys.has(pendingKey)) {
      // This cleanup runs before useEditor's own teardown, so editorRef still
      // points at a live editor we can serialize (#954).
      try {
        const html = editorRef.current?.getHTML();
        if (html != null) localStorage.setItem(`draft:${pendingKey}`, html);
      } catch { /* quota exceeded — ignore */ }
    }
    pendingDraftRef.current = null;
  }, []);

  /**
   * Handle pasted or dropped image files: upload to server, insert as image node.
   * Returns true if an image was handled, false to let TipTap process normally.
   */
  const handleImageFiles = useCallback((files: File[]): boolean => {
    const imageFile = files.find((f) => f.type.startsWith('image/'));
    if (!imageFile) return false;

    const currentPageId = pageIdRef.current;
    if (!currentPageId) {
      toast.error('Save the page first to paste images.');
      return true; // Prevent default paste of raw data
    }

    uploadPastedImage(imageFile, currentPageId).then((url) => {
      if (url && editorRef.current) {
        editorRef.current.chain().focus().setImage({ src: url }).run();
      }
    });

    return true;
  }, []);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        codeBlock: false,
      }),
      TextAlign.configure({
        types: ['heading', 'paragraph', 'blockquote'],
        alignments: ['left', 'center', 'right', 'justify'],
      }),
      TextStyle,
      Color,
      Highlight.configure({ multicolor: true }),
      ExtendedTable.configure({ resizable: true }),
      TableRow,
      TableCell,
      TableHeader,
      TaskList,
      TaskItem.configure({ nested: true }),
      MermaidBlock,
      Details,
      DetailsSummary,
      Panel,
      ConfluenceStatus,
      ConfluenceToc,
      ConfluenceJiraIssue,
      ConfluenceUserMention,
      ConfluenceIncludeMacro,
      ConfluenceLabelsMacro,
      UnknownMacro,
      ConfluenceLayout,
      ConfluenceLayoutSection,
      ConfluenceLayoutCell,
      ConfluenceSection,
      ConfluenceColumn,
      ConfluenceAttachments,
      ConfluenceChildren,
      DrawioDiagram,
      Figure,
      Figcaption,
      TableCaption,
      FigureIndex,
      TableIndex,
      TitledCodeBlock.configure({ lowlight }),
      ConfluenceImage.configure({ inline: false }),
      Placeholder.configure({ placeholder: placeholder ?? 'Start writing...' }),
      SearchAndReplaceExtension,
      ...(vimEnabled ? [VimExtension.configure({
        onStateChange: setVimDisplayState,
        onSave: () => {
          // Mark dirty then trigger the server-side save. The save handler
          // reads the current HTML straight off the editor instance (#954),
          // so there's no editor→React-state flush to do here.
          onChange?.(true);
          onSaveRef.current?.();
        },
      })] : []),
    ],
    editorProps: {
      // #1135 — triple-click selects the whole cell, not one paragraph.
      handleTripleClick: handleTableCellTripleClick,
      handlePaste(_view, event) {
        const items = Array.from(event.clipboardData?.items ?? []);
        const imageItem = items.find((i) => i.type.startsWith('image/'));
        if (imageItem) {
          // Single-image paste (Cmd+C on an image in a browser/file viewer) —
          // existing fast path that uploads the file directly.
          event.preventDefault();
          const file = imageItem.getAsFile();
          if (!file) return false;
          return handleImageFiles([file]);
        }

        // Rich HTML paste (#683). If the clipboard carries `text/html` that
        // contains `img` tags with non-internal srcs (relative paths from
        // imported Sphinx docs, absolute URLs from a wiki, data: URIs), walk
        // the HTML and rewrite each src to an internal attachment URL we
        // actually serve. We hold off on inserting the original HTML so the
        // user never sees the broken-image flash.
        const htmlPayload = event.clipboardData?.getData('text/html');
        if (!htmlPayload || !/<img\b/i.test(htmlPayload)) return false;

        const currentPageId = pageIdRef.current;
        if (!currentPageId) {
          // No pageId means we can't upload anything — fall back to TipTap's
          // default paste so the user at least sees the text content.
          return false;
        }

        event.preventDefault();
        const editorInstance = editorRef.current;
        if (!editorInstance) return true;

        const importToastId = toast.loading('Importing pasted images…');
        rewriteHtmlImageSrcs(htmlPayload, currentPageId)
          .then(({ html, imported, failed, total }) => {
            editorInstance.chain().focus().insertContent(html).run();
            if (total === 0) {
              toast.dismiss(importToastId);
              return;
            }
            if (failed === 0) {
              toast.success(`Imported ${imported} image${imported === 1 ? '' : 's'}`, { id: importToastId });
            } else if (imported === 0) {
              toast.error(`Couldn't import ${failed} image${failed === 1 ? '' : 's'}`, { id: importToastId });
            } else {
              toast.warning(`Imported ${imported} of ${total} images`, { id: importToastId });
            }
          })
          .catch(() => {
            toast.error("Couldn't import pasted images", { id: importToastId });
          });
        return true;
      },
      handleDrop(_view, event, _slice, moved) {
        // Only handle external drops (not internal drag-and-drop of existing content)
        if (moved) return false;
        const files = Array.from(event.dataTransfer?.files ?? []);
        if (files.length === 0) return false;
        const hasImage = files.some((f) => f.type.startsWith('image/'));
        if (!hasImage) return false;
        event.preventDefault();
        return handleImageFiles(files);
      },
    },
    content,
    editable,
    immediatelyRender: false,
    onUpdate: () => {
      // Hot path: fire a cheap dirty signal and schedule the debounced draft
      // save. Do NOT serialize getHTML() here (#954) — that runs on every
      // keystroke and, when the parent stored it in state, re-rendered the
      // whole page each time. The draft/save paths serialize lazily instead.
      onChange?.(true);
      saveDraft();
    },
  }, [vimEnabled]);

  // Keep the editor ref in sync
  editorRef.current = editor;

  // Notify parent when editor instance is ready (triggers re-render via setState)
  useEffect(() => {
    onEditorReady?.(editor);
    return () => onEditorReady?.(null);
  }, [editor, onEditorReady]);

  return (
    <div className={cn('relative', naked ? '' : 'nm-card', headerNumbering && 'header-numbering')}>
      {editable && editor && !hideToolbar && (
        <div className="sticky top-0 z-30 border-b border-border bg-card px-1">
          <EditorToolbar editor={editor} headerNumbering={headerNumbering} onToggleHeaderNumbering={toggleHeaderNumbering} />
          <LayoutContextToolbar editor={editor} />
          <ColumnContextToolbar editor={editor} />
        </div>
      )}
      {editable && editor && <SearchAndReplace editor={editor} />}
      {editable && editor && <EditorBubbleMenu editor={editor} />}
      {/* #49 drag handle, #1179 its block context menu. The handle and its
          menu live together in EditorBlockMenu: they share the hovered-node
          tracking, the handle lock and the target marker. */}
      {editable && editor && <EditorBlockHandle editor={editor} />}
      {editable && editor && <FloatingTableToolbar editor={editor} />}
      {editable && editor && <EditorTableOverlay editor={editor} />}
      <EditorContent
        editor={editor}
        className={cn(
          'prose max-w-none',
          !isLight && 'prose-invert',
          '[&_.tiptap]:min-h-[200px] [&_.tiptap]:px-10 [&_.tiptap]:py-6 [&_.tiptap]:outline-none',
          '[&_table]:border-collapse [&_td]:border [&_td]:border-border [&_td]:p-2 [&_th]:border [&_th]:border-border [&_th]:bg-foreground/5 [&_th]:p-2',
          '[&_pre]:rounded-md [&_pre]:bg-foreground/5 [&_pre:not([data-title])]:p-4 [&_pre[data-title]]:px-4 [&_pre[data-title]]:pb-4',
          '[&_ul[data-type=taskList]]:list-none [&_ul[data-type=taskList]]:pl-0',
        )}
      />
      {vimEnabled && editable && <VimModeIndicator vimState={vimDisplayState} />}
    </div>
  );
}
