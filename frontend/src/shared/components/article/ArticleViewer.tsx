import { useEffect, useRef, useCallback, useMemo, useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Table, TableRow, TableCell, TableHeader } from '@tiptap/extension-table';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight';
import { Image } from '@tiptap/extension-image';
import { common, createLowlight } from 'lowlight';
import DOMPurify from 'dompurify';
import {
  Details,
  DetailsSummary,
  Panel,
  DrawioDiagram,
  ConfluenceToc,
  ConfluenceStatus,
  ConfluenceChildren,
  ConfluenceLayout,
  ConfluenceLayoutSection,
  ConfluenceLayoutCell,
  ConfluenceSection,
  ConfluenceColumn,
  UnknownMacro,
} from './article-extensions';
import { MermaidBlock } from './MermaidBlockExtension';
import { fetchAuthenticatedBlob } from '../../hooks/use-authenticated-src';
import { cn } from '../../lib/cn';
import { useIsLightTheme } from '../../hooks/use-is-light-theme';
import type { TocHeading } from './TableOfContents';

// Configure DOMPurify to preserve Confluence-specific attributes
DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
  if (
    data.attrName === 'data-diagram-name' ||
    data.attrName === 'data-drawio' ||
    data.attrName === 'data-confluence-link' ||
    data.attrName === 'data-type' ||
    data.attrName === 'data-checked' ||
    data.attrName === 'data-layout-type' ||
    data.attrName === 'data-cell-width' ||
    data.attrName === 'data-border'
  ) {
    data.forceKeepAttr = true;
  }
});

const lowlight = createLowlight(common);

interface ArticleViewerProps {
  /** HTML content to render (typically page.bodyHtml) */
  content: string;
  /** Callback when an image is clicked for lightbox */
  onImageClick?: (src: string, alt: string) => void;
  /** Confluence base URL for draw.io edit links */
  confluenceUrl?: string | null;
  /** Internal page ID (integer PK) — used for attachment URLs */
  pageId?: string | null;
  /** Confluence page ID for "Open in Confluence" / draw.io edit links */
  confluencePageId?: string | null;
  /** Callback with parsed headings for Table of Contents */
  onHeadingsReady?: (headings: TocHeading[]) => void;
  /** Callback to trigger a manual Confluence sync (e.g. refresh stale diagrams) */
  onRequestSync?: () => void;
  /** Callback when user clicks "Edit Diagram" on a draw.io container.
   *  Receives the diagram name so the parent can open the DrawioEditor. */
  onEditDiagram?: (diagramName: string) => void;
  /** Additional CSS classes */
  className?: string;
}

export function ArticleViewer({
  content,
  onImageClick,
  confluenceUrl,
  pageId: _pageId,
  confluencePageId,
  onHeadingsReady,
  onRequestSync: _onRequestSync,
  onEditDiagram,
  className,
}: ArticleViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isReady, setIsReady] = useState(false);
  const isLight = useIsLightTheme();

  const sanitizedContent = useMemo(
    () =>
      DOMPurify.sanitize(content, {
        ADD_ATTR: ['data-diagram-name', 'data-drawio', 'data-confluence-link', 'data-type', 'data-checked', 'data-color', 'data-title', 'data-layout-type', 'data-cell-width', 'data-border'],
      }),
    [content],
  );

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        codeBlock: false,
        heading: { levels: [1, 2, 3, 4, 5, 6] },
        link: {
          openOnClick: true,
          HTMLAttributes: { target: '_blank', rel: 'noreferrer' },
        },
      }),
      Table.configure({ resizable: false }),
      TableRow,
      TableCell,
      TableHeader,
      TaskList,
      TaskItem.configure({ nested: true }),
      CodeBlockLowlight.extend({
        addAttributes() {
          return {
            ...this.parent?.(),
            title: {
              default: null,
              parseHTML: (element) => element.getAttribute('data-title'),
              renderHTML: (attributes) =>
                attributes.title ? { 'data-title': attributes.title } : {},
            },
          };
        },
      }).configure({ lowlight }),
      Image.configure({ inline: false }),
      Details,
      DetailsSummary,
      Panel,
      DrawioDiagram,
      ConfluenceToc,
      ConfluenceStatus,
      ConfluenceChildren,
      ConfluenceLayout,
      ConfluenceLayoutSection,
      ConfluenceLayoutCell,
      ConfluenceSection,
      ConfluenceColumn,
      MermaidBlock,
      UnknownMacro,
    ],
    content: sanitizedContent,
    editable: false,
    immediatelyRender: false,
    onCreate: () => setIsReady(true),
  });

  // Update content when it changes (e.g., navigating between pages)
  useEffect(() => {
    if (editor && isReady && sanitizedContent) {
      editor.commands.setContent(sanitizedContent);
    }
  }, [editor, isReady, sanitizedContent]);

  // Generate heading IDs and expose them for ToC
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !isReady) return;

    // Wait a frame for TipTap to finish rendering
    const raf = requestAnimationFrame(() => {
      const headingElements = container.querySelectorAll('h1, h2, h3, h4');
      const usedIds = new Set<string>();
      const headings: TocHeading[] = [];

      headingElements.forEach((heading, index) => {
        const text = heading.textContent?.trim() || '';
        if (!text) return;

        let id =
          text
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/(^-|-$)/g, '') || `heading-${index}`;

        // Ensure unique IDs
        const baseId = id;
        let counter = 1;
        while (usedIds.has(id)) {
          id = `${baseId}-${counter++}`;
        }
        usedIds.add(id);
        heading.id = id;

        const level = parseInt(heading.tagName[1], 10);
        headings.push({ id, text, level });
      });

      onHeadingsReady?.(headings);
    });

    return () => cancelAnimationFrame(raf);
  }, [isReady, sanitizedContent, onHeadingsReady]);

  // Add copy buttons to code blocks
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !isReady) return;

    const raf = requestAnimationFrame(() => {
      const codeBlocks = container.querySelectorAll('pre');
      codeBlocks.forEach((pre) => {
        if (pre.querySelector('.code-copy-btn')) return;

        pre.style.position = 'relative';
        const btn = document.createElement('button');
        btn.className = 'code-copy-btn';
        btn.textContent = 'Copy';
        btn.setAttribute('aria-label', 'Copy code to clipboard');
        btn.addEventListener('click', async () => {
          const code = pre.querySelector('code');
          const text = code?.textContent || pre.textContent || '';
          try {
            await navigator.clipboard.writeText(text);
            btn.textContent = 'Copied!';
            btn.classList.add('copied');
            setTimeout(() => {
              btn.textContent = 'Copy';
              btn.classList.remove('copied');
            }, 2000);
          } catch {
            btn.textContent = 'Failed';
            setTimeout(() => {
              btn.textContent = 'Copy';
            }, 2000);
          }
        });

        pre.appendChild(btn);
      });
    });

    return () => cancelAnimationFrame(raf);
  }, [isReady, sanitizedContent]);

  // Rewrite /api/attachments/... image srcs to authenticated blob URLs.
  // Browser <img> tags cannot send Authorization headers, so without this
  // the backend returns 401 for every inline image.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !isReady) return;

    const blobUrls: string[] = [];
    let cancelled = false;

    /**
     * Replace a failed image with an error placeholder containing a Retry button.
     * Idempotent: replaceWith on a detached node is a no-op per the DOM spec.
     */
    function createImageErrorPlaceholder(
      img: HTMLImageElement,
      originalSrc: string,
    ): void {
      const wrapper = document.createElement('div');
      // image-load-error kept for CSS backward compatibility; image-error-placeholder for targeting
      wrapper.className = 'image-error-placeholder image-load-error';

      const icon = document.createElement('span');
      icon.className = 'image-error-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = '⚠';

      const text = document.createElement('span');
      text.className = 'image-error-text';
      text.textContent = 'Image could not be loaded from Confluence';

      const retryBtn = document.createElement('button');
      retryBtn.className = 'image-retry-btn';
      retryBtn.textContent = 'Retry';
      retryBtn.setAttribute('type', 'button');
      retryBtn.addEventListener('click', async () => {
        if (cancelled) return;
        // Restore original image node (idempotent if already detached)
        try {
          wrapper.replaceWith(img);
        } catch {
          // Already detached — no-op
        }
        img.removeAttribute('src');

        const blobUrl = await fetchAuthenticatedBlob(originalSrc);
        if (cancelled) {
          if (blobUrl) URL.revokeObjectURL(blobUrl);
          return;
        }
        if (blobUrl) {
          blobUrls.push(blobUrl);
          img.src = blobUrl;
        } else {
          // Re-show the error placeholder on repeated failure
          img.replaceWith(wrapper);
        }
      });

      wrapper.appendChild(icon);
      wrapper.appendChild(text);
      wrapper.appendChild(retryBtn);

      img.replaceWith(wrapper);
    }

    const raf = requestAnimationFrame(() => {
      const images = container.querySelectorAll<HTMLImageElement>('img[src^="/api/attachments/"]');
      if (images.length === 0) return;

      images.forEach(async (img) => {
        const originalSrc = img.getAttribute('src');
        if (!originalSrc) return;

        // Prevent browser from attempting to load the unauthenticated URL
        // while we fetch with auth. Without this the browser fires a 401
        // request for every image before our blob rewrite kicks in.
        img.removeAttribute('src');
        img.setAttribute('data-original-src', originalSrc);

        const blobUrl = await fetchAuthenticatedBlob(originalSrc);
        if (cancelled) {
          if (blobUrl) URL.revokeObjectURL(blobUrl);
          return;
        }
        if (blobUrl) {
          blobUrls.push(blobUrl);
          img.src = blobUrl;
        } else {
          // Show an error placeholder with a Retry button
          createImageErrorPlaceholder(img, originalSrc);
        }
      });
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      blobUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [isReady, sanitizedContent]);

  // Image click-to-zoom
  const handleImageClick = useCallback(
    (e: Event) => {
      if (!onImageClick) return;
      const img = e.currentTarget as HTMLImageElement;
      onImageClick(img.src, img.alt || 'Image preview');
    },
    [onImageClick],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !isReady || !onImageClick) return;

    const raf = requestAnimationFrame(() => {
      const images = container.querySelectorAll('img');
      images.forEach((img) => {
        img.style.cursor = 'zoom-in';
        img.addEventListener('click', handleImageClick);
      });
    });

    return () => {
      cancelAnimationFrame(raf);
      const images = container.querySelectorAll('img');
      images.forEach((img) => {
        img.removeEventListener('click', handleImageClick);
      });
    };
  }, [isReady, sanitizedContent, handleImageClick, onImageClick]);

  // Update draw.io edit links with real Confluence URL (uses confluencePageId, not the internal integer PK)
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !isReady || !confluenceUrl || !confluencePageId) return;

    const raf = requestAnimationFrame(() => {
      const links = container.querySelectorAll('a.drawio-edit-link');
      links.forEach((link) => {
        const anchor = link as HTMLAnchorElement;
        anchor.href = `${confluenceUrl.replace(/\/+$/, "")}/pages/viewpage.action?pageId=${encodeURIComponent(confluencePageId)}`;
        anchor.target = '_blank';
        anchor.rel = 'noreferrer';
      });
    });

    return () => cancelAnimationFrame(raf);
  }, [isReady, confluenceUrl, confluencePageId]);

  // Add inline "Edit Diagram" overlay buttons on draw.io containers
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !isReady || !onEditDiagram) return;

    const raf = requestAnimationFrame(() => {
      const drawioContainers = container.querySelectorAll<HTMLElement>('.confluence-drawio');
      drawioContainers.forEach((drawioDiv) => {
        // Skip if already injected
        if (drawioDiv.querySelector('.drawio-inline-edit-btn')) return;

        drawioDiv.style.position = 'relative';

        const btn = document.createElement('button');
        btn.className = 'drawio-inline-edit-btn';
        btn.textContent = 'Edit Diagram';
        btn.setAttribute('aria-label', 'Edit this draw.io diagram');
        btn.setAttribute('data-testid', 'drawio-edit-btn');

        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const diagramName = drawioDiv.getAttribute('data-diagram-name');
          if (diagramName) {
            onEditDiagram(diagramName);
          }
        });

        drawioDiv.appendChild(btn);
      });
    });

    return () => cancelAnimationFrame(raf);
  }, [isReady, sanitizedContent, onEditDiagram]);

  return (
    <div ref={containerRef} className="article-viewer-container">
      <EditorContent
        editor={editor}
        className={cn(
          'article-viewer prose max-w-none',
          !isLight && 'prose-invert',
          '[&_.tiptap]:outline-none',
          // Table styles
          '[&_table]:border-collapse [&_td]:border [&_td]:border-[var(--glass-border)] [&_td]:p-2',
          '[&_th]:border [&_th]:border-[var(--glass-border)] [&_th]:bg-[oklch(from_var(--color-muted)_l_c_h_/_0.3)] [&_th]:p-2 [&_th]:font-semibold',
          // Task list styles
          '[&_ul[data-type=taskList]]:list-none [&_ul[data-type=taskList]]:pl-0',
          '[&_ul[data-type=taskList]_li]:flex [&_ul[data-type=taskList]_li]:items-center [&_ul[data-type=taskList]_li]:gap-2',
          className,
        )}
      />
    </div>
  );
}
