import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { m } from 'framer-motion';
import { List, X } from 'lucide-react';
import { cn } from '../lib/cn';

interface TocHeading {
  id: string;
  text: string;
  level: number;
}

interface TableOfContentsProps {
  /** Raw HTML content to parse headings from (legacy mode) */
  htmlContent?: string;
  /** Pre-parsed headings list (preferred, from ArticleViewer) */
  headings?: TocHeading[];
  contentRef?: React.RefObject<HTMLElement | null>;
}

function parseHeadings(html: string): TocHeading[] {
  const headings: TocHeading[] = [];
  // Parse h1-h3 from HTML content
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const elements = doc.querySelectorAll('h1, h2, h3');

  elements.forEach((el, i) => {
    const level = parseInt(el.tagName[1], 10);
    const text = el.textContent?.trim() || '';
    const id = el.id || `heading-${i}`;
    if (text) {
      headings.push({ id, text, level });
    }
  });

  return headings;
}

export function TableOfContents({ htmlContent, headings: headingsProp, contentRef }: TableOfContentsProps) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [isMobileOpen, setIsMobileOpen] = useState(false);
  const [readingProgress, setReadingProgress] = useState(0);
  const observerRef = useRef<IntersectionObserver | null>(null);

  const parsedHeadings = useMemo(() => (htmlContent ? parseHeadings(htmlContent) : []), [htmlContent]);
  const headings = headingsProp ?? parsedHeadings;

  // Scroll tracking via IntersectionObserver
  useEffect(() => {
    if (!contentRef?.current || headings.length === 0) return;

    const headingElements = headings
      .map((h) => contentRef.current?.querySelector(`#${CSS.escape(h.id)}`))
      .filter(Boolean) as Element[];

    if (headingElements.length === 0) return;

    observerRef.current = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveId(entry.target.id);
          }
        }
      },
      { rootMargin: '-10% 0% -80% 0%', threshold: 0 },
    );

    headingElements.forEach((el) => observerRef.current?.observe(el));

    return () => observerRef.current?.disconnect();
  }, [headings, contentRef]);

  // Reading progress
  useEffect(() => {
    function handleScroll() {
      const scrollTop = window.scrollY;
      const docHeight = document.documentElement.scrollHeight - window.innerHeight;
      if (docHeight > 0) {
        setReadingProgress(Math.min(100, (scrollTop / docHeight) * 100));
      }
    }

    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const scrollToHeading = useCallback((id: string) => {
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setActiveId(id);
      setIsMobileOpen(false);
    }
  }, []);

  if (headings.length === 0) return null;

  return (
    <>
      {/* Reading progress bar */}
      <div className="fixed left-0 top-0 z-40 h-0.5 w-full" aria-hidden="true">
        <m.div
          className="h-full bg-primary"
          style={{ width: `${readingProgress}%` }}
          transition={{ duration: 0.1 }}
        />
      </div>

      {/* Mobile toggle */}
      <button
        onClick={() => setIsMobileOpen(!isMobileOpen)}
        className="fixed bottom-4 right-4 z-40 rounded-full bg-primary p-3 text-primary-foreground shadow-lg lg:hidden"
        aria-label="Toggle table of contents"
      >
        {isMobileOpen ? <X size={20} /> : <List size={20} />}
      </button>

      {/* Sidebar */}
      <div
        className={cn(
          'glass-card fixed right-0 top-0 z-30 h-full w-64 overflow-y-auto p-4 transition-transform duration-300 lg:sticky lg:top-6 lg:z-0 lg:h-fit lg:max-h-[calc(100vh-4rem)] lg:translate-x-0',
          isMobileOpen ? 'translate-x-0' : 'translate-x-full lg:translate-x-0',
        )}
        role="navigation"
        aria-label="Table of contents"
      >
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Table of Contents
        </h3>
        <nav>
          <ul className="space-y-1">
            {headings.map((heading) => (
              <li key={heading.id}>
                <button
                  onClick={() => scrollToHeading(heading.id)}
                  className={cn(
                    'block w-full truncate rounded-md px-2 py-1 text-left text-sm transition-colors',
                    heading.level === 1 && 'font-medium',
                    heading.level === 2 && 'pl-4',
                    heading.level === 3 && 'pl-6 text-xs',
                    activeId === heading.id
                      ? 'bg-primary/15 text-primary'
                      : 'text-muted-foreground hover:bg-white/5 hover:text-foreground',
                  )}
                >
                  {heading.text}
                </button>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export { parseHeadings };
export type { TocHeading };
