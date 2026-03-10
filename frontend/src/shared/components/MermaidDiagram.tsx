import { useEffect, useRef, useState, useId } from 'react';
import mermaid from 'mermaid';
import { Copy, Check, Download } from 'lucide-react';
import { cn } from '../lib/cn';

/**
 * Sanitize Mermaid diagram code by quoting node labels that contain
 * special characters (parentheses, brackets, braces) which would
 * otherwise be misinterpreted as Mermaid syntax.
 *
 * Handles square-bracket labels `[...]`, curly-brace labels `{...}`,
 * and round-paren labels `(...)` used in flowchart node definitions.
 * Already-quoted labels like `["text"]` are left untouched.
 */
export function sanitizeMermaidCode(code: string): string {
  return code.replace(
    // Match a node shape delimiter with its content:
    //   [content] or {content} or (content)
    // but NOT already-quoted forms like ["content"] or {"content"} or ("content")
    /(\w+)\[(?!")([^\]]*)\]|(\w+)\{(?!")([^}]*)\}|(\w+)\((?!")([^)]*)\)/g,
    (_match, sqId?: string, sqContent?: string, brId?: string, brContent?: string, rnId?: string, rnContent?: string) => {
      if (sqId !== undefined && sqContent !== undefined) {
        // Square bracket label: A[label] — quote if it contains special chars
        if (/[()[\]{}]/.test(sqContent)) {
          return `${sqId}["${sqContent}"]`;
        }
        return `${sqId}[${sqContent}]`;
      }
      if (brId !== undefined && brContent !== undefined) {
        // Curly brace label: A{label} — quote if it contains special chars
        if (/[()[\]{}]/.test(brContent)) {
          return `${brId}{"${brContent}"}`;
        }
        return `${brId}{${brContent}}`;
      }
      if (rnId !== undefined && rnContent !== undefined) {
        // Round paren label: A(label) — quote if it contains special chars
        if (/[()[\]{}]/.test(rnContent)) {
          return `${rnId}("${rnContent}")`;
        }
        return `${rnId}(${rnContent})`;
      }
      return _match;
    },
  );
}

mermaid.initialize({
  startOnLoad: false,
  theme: 'dark',
  securityLevel: 'antiscript',
  fontFamily: 'inherit',
});

interface MermaidDiagramProps {
  /** Raw Mermaid diagram code */
  code: string;
  className?: string;
}

/**
 * Renders a Mermaid diagram from raw Mermaid syntax.
 * Includes copy-source and download-SVG actions.
 */
export function MermaidDiagram({ code, className }: MermaidDiagramProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [svgContent, setSvgContent] = useState<string>('');
  const uniqueId = useId();
  const diagramId = `mermaid-${uniqueId.replace(/:/g, '')}`;

  useEffect(() => {
    if (!code.trim() || !containerRef.current) return;

    let cancelled = false;

    async function renderDiagram() {
      try {
        // Clean the code - strip markdown fences if the LLM included them
        let cleanCode = code.trim();
        if (cleanCode.startsWith('```')) {
          cleanCode = cleanCode.replace(/^```(?:mermaid)?\n?/, '').replace(/\n?```$/, '');
        }

        // Sanitize node labels that contain special characters
        cleanCode = sanitizeMermaidCode(cleanCode);

        const { svg } = await mermaid.render(diagramId, cleanCode);
        if (!cancelled && containerRef.current) {
          containerRef.current.innerHTML = svg;
          setSvgContent(svg);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to render diagram');
          // Show the raw code as fallback
          if (containerRef.current) {
            containerRef.current.textContent = '';
          }
        }
      }
    }

    renderDiagram();
    return () => { cancelled = true; };
  }, [code, diagramId]);

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

      {/* Diagram render area */}
      <div className="flex items-center justify-center overflow-auto p-4">
        <div ref={containerRef} className="mermaid-container" />
      </div>

      {/* Error fallback: show raw code */}
      {error && (
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
