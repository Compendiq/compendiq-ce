import { useEffect, useRef, useState, useId } from 'react';
import { Copy, Check, Download } from 'lucide-react';
import { cn } from '../../lib/cn';
import { useIsLightTheme } from '../../hooks/use-is-light-theme';

/**
 * Sanitize Mermaid diagram code by quoting node labels that contain
 * special characters (parentheses, brackets, braces) which would
 * otherwise be misinterpreted as Mermaid syntax.
 *
 * Handles square-bracket labels `[...]`, curly-brace labels `{...}`,
 * and round-paren labels `(...)` used in flowchart node definitions.
 * Already-quoted labels like `["text"]` are left untouched.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function sanitizeMermaidCode(code: string): string {
  return code.replace(
    // Match a node shape delimiter with its content:
    //   [content] or {content} or (content)
    // but NOT already-quoted forms like ["content"] or {"content"} or ("content")
    /(\w+)\[(?!")([^\]]*)\]|(\w+)\{(?!")([^}]*)\}|(\w+)\((?!")([^)]*)\)/g,
    (
      _match,
      sqId?: string,
      sqContent?: string,
      brId?: string,
      brContent?: string,
      rnId?: string,
      rnContent?: string,
    ) => {
      if (sqId !== undefined && sqContent !== undefined) {
        if (/[()[\]{}]/.test(sqContent)) {
          return `${sqId}["${sqContent}"]`;
        }
        return `${sqId}[${sqContent}]`;
      }
      if (brId !== undefined && brContent !== undefined) {
        if (/[()[\]{}]/.test(brContent)) {
          return `${brId}{"${brContent}"}`;
        }
        return `${brId}{${brContent}}`;
      }
      if (rnId !== undefined && rnContent !== undefined) {
        if (/[()[\]{}]/.test(rnContent)) {
          return `${rnId}("${rnContent}")`;
        }
        return `${rnId}(${rnContent})`;
      }
      return _match;
    },
  );
}

/** Mermaid default-export type (the mermaid API object). */
type MermaidAPI = typeof import('mermaid')['default'];

/**
 * Module-level cache for the lazily-loaded mermaid module.
 * Shared across all MermaidDiagram instances so the 2 MB+ library
 * is fetched at most once.
 */
let mermaidInstance: MermaidAPI | null = null;
let mermaidLoadPromise: Promise<MermaidAPI> | null = null;

/**
 * Lazily load the mermaid library. Returns a cached instance if
 * already loaded, otherwise triggers a single dynamic import.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function loadMermaid(): Promise<MermaidAPI> {
  if (mermaidInstance) return Promise.resolve(mermaidInstance);
  if (!mermaidLoadPromise) {
    mermaidLoadPromise = import('mermaid').then((m) => {
      mermaidInstance = m.default;
      return mermaidInstance;
    });
  }
  return mermaidLoadPromise;
}

/**
 * Re-initialize mermaid with the given theme.
 * Uses 'strict' securityLevel which prevents script injection.
 *
 * Accepts an optional mermaid API instance. When omitted, uses the cached
 * lazily-loaded instance (no-op if mermaid has not been loaded yet).
 */
// eslint-disable-next-line react-refresh/only-export-components
export function initializeMermaid(isDark: boolean, mermaidApi?: MermaidAPI): void {
  const api = mermaidApi ?? mermaidInstance;
  if (!api) return;
  api.initialize({
    startOnLoad: false,
    theme: isDark ? 'dark' : 'default',
    securityLevel: 'strict',
    fontFamily: 'inherit',
  });
}

/** Reset the module-level mermaid cache. Exported for testing only. */
// eslint-disable-next-line react-refresh/only-export-components
export function _resetMermaidCache(): void {
  mermaidInstance = null;
  mermaidLoadPromise = null;
}

interface MermaidDiagramProps {
  /** Raw Mermaid diagram code */
  code: string;
  className?: string;
  /** Override theme detection (useful for testing) */
  forceDark?: boolean;
}

/**
 * Renders a Mermaid diagram from raw Mermaid syntax.
 * Lazy-loads the mermaid library (~2 MB) on first render to avoid
 * penalizing pages that don't display diagrams.
 * Includes copy-source and download-SVG actions.
 * Automatically detects light/dark theme and re-renders accordingly.
 */
export function MermaidDiagram({ code, className, forceDark }: MermaidDiagramProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [svgContent, setSvgContent] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const uniqueId = useId();
  const diagramId = `mermaid-${uniqueId.replace(/:/g, '')}`;

  // Theme awareness: detect light/dark and re-render when theme changes
  const isLight = useIsLightTheme();
  const isDark = forceDark !== undefined ? forceDark : !isLight;

  useEffect(() => {
    if (!code.trim()) return;

    let cancelled = false;

    async function loadAndRender() {
      try {
        const mermaidApi = await loadMermaid();

        if (cancelled) return;

        initializeMermaid(isDark, mermaidApi);

        setLoading(false);
        setLoadError(null);

        // Clean the code - strip markdown fences if the LLM included them
        let cleanCode = code.trim();
        if (cleanCode.startsWith('```')) {
          cleanCode = cleanCode.replace(/^```(?:mermaid)?\n?/, '').replace(/\n?```$/, '');
        }

        cleanCode = sanitizeMermaidCode(cleanCode);

        const { svg } = await mermaidApi.render(diagramId, cleanCode);
        if (!cancelled && containerRef.current) {
          containerRef.current.innerHTML = svg;
          setSvgContent(svg);
          setError(null);
        }
      } catch (err) {
        if (cancelled) return;
        if (!mermaidInstance) {
          setLoadError(err instanceof Error ? err.message : 'Failed to load Mermaid library');
          setLoading(false);
        } else {
          setError(err instanceof Error ? err.message : 'Failed to render diagram');
          setLoading(false);
          if (containerRef.current) {
            containerRef.current.textContent = '';
          }
        }
      }
    }

    loadAndRender();
    return () => {
      cancelled = true;
    };
  }, [code, diagramId, isDark]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API may not be available
    }
  };

  const handleDownloadSvg = () => {
    if (!svgContent) return;
    const blob = new Blob([svgContent], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'diagram.svg';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className={cn('rounded-lg border border-border/50 bg-foreground/5', className)}>
      {/* Toolbar */}
      <div className="flex items-center justify-between border-b border-border/50 px-3 py-1.5">
        <span className="text-xs text-muted-foreground">Mermaid Diagram</span>
        <div className="flex items-center gap-1">
          <button
            onClick={handleCopy}
            className="rounded p-1 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
            title="Copy Mermaid source"
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
          {svgContent && (
            <button
              onClick={handleDownloadSvg}
              className="rounded p-1 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
              title="Download as SVG"
            >
              <Download size={14} />
            </button>
          )}
        </div>
      </div>

      {/* Loading skeleton (shown while mermaid library loads) */}
      {loading && !loadError && (
        <div className="flex items-center justify-center p-8" data-testid="mermaid-loading">
          <div className="flex flex-col items-center gap-3">
            <div className="h-24 w-48 animate-pulse rounded-lg bg-foreground/10 backdrop-blur-sm" />
            <span className="text-xs text-muted-foreground">Loading diagram...</span>
          </div>
        </div>
      )}

      {/* Load error state */}
      {loadError && (
        <div className="border-t border-border/50 p-3" data-testid="mermaid-load-error">
          <p className="mb-2 text-xs text-red-400">
            Failed to load Mermaid library: {loadError}
          </p>
          <pre className="max-h-48 overflow-auto rounded bg-black/30 p-2 text-xs text-muted-foreground">
            {code}
          </pre>
        </div>
      )}

      {/* Diagram render area -- always mounted so the ref is available */}
      <div
        className={cn(
          'flex items-center justify-center overflow-auto p-4',
          (loading || loadError) && 'hidden',
        )}
      >
        <div ref={containerRef} className="mermaid-container" />
      </div>

      {/* Error fallback: show raw code */}
      {error && !loadError && (
        <div className="border-t border-border/50 p-3">
          <p className="mb-2 text-xs text-red-400">Diagram rendering failed: {error}</p>
          <pre className="max-h-48 overflow-auto rounded bg-black/30 p-2 text-xs text-muted-foreground">
            {code}
          </pre>
        </div>
      )}
    </div>
  );
}
