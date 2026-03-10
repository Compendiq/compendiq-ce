import { useEffect, useRef, useCallback, useMemo, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
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
  UnknownMacro,
} from './article-extensions';
import { MermaidDiagram } from './MermaidDiagram';
import { DrawioDiagramPreview } from './DrawioDiagramPreview';
import { cn } from '../lib/cn';
import type { TocHeading } from './TableOfContents';

// Configure DOMPurify to preserve Confluence-specific attributes
DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
  if (
    data.attrName === 'data-diagram-name' ||
    data.attrName === 'data-drawio' ||
    data.attrName === 'data-confluence-link' ||
    data.attrName === 'data-type' ||
    data.attrName === 'data-checked'
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
  /** Page ID for Confluence links */
  pageId?: string | null;
  /** Callback with parsed headings for Table of Contents */
  onHeadingsReady?: (headings: TocHeading[]) => void;
  /** Additional CSS classes */
  className?: string;
}

export function ArticleViewer({
  content,
  onImageClick,
  confluenceUrl,
  pageId,
  onHeadingsReady,
  className,
}: ArticleViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isReady, setIsReady] = useState(false);

  const sanitizedContent = useMemo(
    () =>
      DOMPurify.sanitize(content, {
        ADD_ATTR: ['data-diagram-name', 'data-drawio', 'data-confluence-link', 'data-type', 'data-checked'],
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
      CodeBlockLowlight.configure({ lowlight }),
      Image.configure({ inline: false }),
      Details,
      DetailsSummary,
      Panel,
      DrawioDiagram,
      ConfluenceToc,
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

  // Render Mermaid diagrams: replace pre>code.language-mermaid with MermaidDiagram React components
  const mermaidRootsRef = useRef<Root[]>([]);
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !isReady) return;

    // Cleanup any previously mounted mermaid roots
    for (const root of mermaidRootsRef.current) {
      root.unmount();
    }
    mermaidRootsRef.current = [];

    const raf = requestAnimationFrame(() => {
      const mermaidCodes = container.querySelectorAll('pre > code.language-mermaid');
      mermaidCodes.forEach((codeEl) => {
        const pre = codeEl.parentElement;
        if (!pre) return;

        const mermaidCode = codeEl.textContent ?? '';
        if (!mermaidCode.trim()) return;

        // Create a container div that will replace the <pre> block
        const wrapper = document.createElement('div');
        wrapper.className = 'mermaid-diagram-wrapper';
        wrapper.setAttribute('data-testid', 'mermaid-diagram-wrapper');
        pre.replaceWith(wrapper);

        // Mount a MermaidDiagram React component into the wrapper
        const root = createRoot(wrapper);
        root.render(<MermaidDiagram code={mermaidCode} />);
        mermaidRootsRef.current.push(root);
      });
    });

    return () => {
      cancelAnimationFrame(raf);
      for (const root of mermaidRootsRef.current) {
        root.unmount();
      }
      mermaidRootsRef.current = [];
    };
  }, [isReady, sanitizedContent]);

  // Render Draw.io diagrams: replace .confluence-drawio with DrawioDiagramPreview React components
  const drawioRootsRef = useRef<Root[]>([]);
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !isReady) return;

    // Cleanup any previously mounted drawio roots
    for (const root of drawioRootsRef.current) {
      root.unmount();
    }
    drawioRootsRef.current = [];

    const raf = requestAnimationFrame(() => {
      const drawioElements = container.querySelectorAll('div.confluence-drawio');
      drawioElements.forEach((el) => {
        const htmlEl = el as HTMLElement;
        const diagramName = htmlEl.getAttribute('data-diagram-name');
        const img = htmlEl.querySelector('img');
        const src = img?.getAttribute('src') || null;
        const alt = img?.getAttribute('alt') || 'Diagram';
        const link = htmlEl.querySelector('a.drawio-edit-link') as HTMLAnchorElement | null;

        // Build the edit href — use the existing link if already rewritten,
        // otherwise construct from confluenceUrl + pageId
        let editHref = link?.getAttribute('href') || '#';
        if (confluenceUrl && pageId && (editHref === '#' || !editHref.startsWith('http'))) {
          editHref = `${confluenceUrl}/pages/viewpage.action?pageId=${encodeURIComponent(pageId)}`;
        }

        // Create a wrapper div that will replace the original .confluence-drawio element
        const wrapper = document.createElement('div');
        wrapper.className = 'drawio-diagram-wrapper';
        wrapper.setAttribute('data-testid', 'drawio-diagram-wrapper');
        htmlEl.replaceWith(wrapper);

        // Mount a DrawioDiagramPreview React component into the wrapper
        const root = createRoot(wrapper);
        root.render(
          <DrawioDiagramPreview
            src={src}
            diagramName={diagramName}
            alt={alt}
            editHref={editHref}
          />,
        );
        drawioRootsRef.current.push(root);
      });
    });

    return () => {
      cancelAnimationFrame(raf);
      for (const root of drawioRootsRef.current) {
        root.unmount();
      }
      drawioRootsRef.current = [];
    };
  }, [isReady, sanitizedContent, confluenceUrl, pageId]);

  // Add copy buttons to code blocks (skip mermaid blocks which are already replaced)
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !isReady) return;

    const raf = requestAnimationFrame(() => {
      const codeBlocks = container.querySelectorAll('pre');
      codeBlocks.forEach((pre) => {
        // Skip mermaid code blocks (they are replaced by MermaidDiagram)
        const codeEl = pre.querySelector('code');
        if (codeEl?.classList.contains('language-mermaid')) return;

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
        // Skip images inside draw.io diagram wrappers (they have their own lightbox)
        if (img.closest('.drawio-diagram-wrapper') || img.closest('.drawio-preview-container')) return;
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

  return (
    <div ref={containerRef} className="article-viewer-container">
      <EditorContent
        editor={editor}
        className={cn(
          'article-viewer prose prose-invert max-w-none',
          '[&_.tiptap]:outline-none',
          // Table styles
          '[&_table]:border-collapse [&_td]:border [&_td]:border-[var(--glass-border)] [&_td]:p-2',
          '[&_th]:border [&_th]:border-[var(--glass-border)] [&_th]:bg-[oklch(from_var(--color-muted)_l_c_h_/_0.3)] [&_th]:p-2 [&_th]:font-semibold',
          // Task list styles
          '[&_ul[data-type=taskList]]:list-none [&_ul[data-type=taskList]]:pl-0',
          '[&_ul[data-type=taskList]_li]:flex [&_ul[data-type=taskList]_li]:items-start [&_ul[data-type=taskList]_li]:gap-2',
          className,
        )}
      />
    </div>
  );
}
