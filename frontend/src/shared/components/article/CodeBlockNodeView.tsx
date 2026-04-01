import { useCallback, useEffect, useState } from 'react';
import { NodeViewWrapper, NodeViewContent } from '@tiptap/react';
import { supportedLanguages, lowlight } from '../../lib/lowlight';
import type { NodeViewProps } from '@tiptap/react';

/**
 * React NodeView for code blocks rendered inside the TipTap editor.
 *
 * Shows a compact header bar with:
 * - Title label (from Confluence data-title attribute)
 * - Language selector dropdown (edit mode) or language label (read-only)
 * - Auto-detect button when no language is set
 * - Copy-to-clipboard button
 */
export function CodeBlockNodeView({ node, updateAttributes, editor }: NodeViewProps) {
  const currentLang: string | null = node.attrs.language;
  const title: string | null = node.attrs.title;
  const isEditable = editor.isEditable;
  const [copied, setCopied] = useState(false);

  const handleLanguageChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      updateAttributes({ language: e.target.value || null });
    },
    [updateAttributes],
  );

  const handleAutoDetect = useCallback(() => {
    const code = node.textContent;
    if (!code.trim()) return;
    const result = lowlight.highlightAuto(code);
    if (result.data && result.data.language && (result.data.relevance ?? 0) > 3) {
      updateAttributes({ language: result.data.language });
    }
  }, [node, updateAttributes]);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(node.textContent);
    setCopied(true);
  }, [node]);

  // Reset "Copied!" feedback after a short delay
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  // Auto-detect language on mount when content is present but no language set
  useEffect(() => {
    if (!currentLang && node.textContent.trim().length > 20) {
      handleAutoDetect();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Stop keyboard events from the select/button elements from propagating
   * into TipTap, which would otherwise intercept them as editor commands.
   */
  const stopPropagation = useCallback((e: React.KeyboardEvent) => {
    e.stopPropagation();
  }, []);

  return (
    <NodeViewWrapper
      as="pre"
      className={`code-block-wrapper ${title ? 'has-title' : ''}`}
      data-testid="code-block-node-view"
    >
      <div
        className="code-block-header"
        contentEditable={false}
      >
        {title && <span className="code-block-title">{title}</span>}

        {isEditable ? (
          <select
            value={currentLang || ''}
            onChange={handleLanguageChange}
            onKeyDown={stopPropagation}
            className="code-block-language-select"
            data-testid="code-block-language-select"
          >
            <option value="">Plain text</option>
            {supportedLanguages.map((lang) => (
              <option key={lang} value={lang}>
                {lang}
              </option>
            ))}
          </select>
        ) : (
          currentLang && (
            <span className="code-block-language-label" data-testid="code-block-language-label">
              {currentLang}
            </span>
          )
        )}

        {isEditable && !currentLang && (
          <button
            onClick={handleAutoDetect}
            onKeyDown={stopPropagation}
            className="code-block-detect-btn"
            type="button"
            data-testid="code-block-detect-btn"
          >
            Detect
          </button>
        )}

        <button
          onClick={handleCopy}
          onKeyDown={stopPropagation}
          className={`code-block-copy-btn ${copied ? 'copied' : ''}`}
          type="button"
          data-testid="code-block-copy-btn"
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>

      <NodeViewContent<'code'>
        as="code"
        className={currentLang ? `language-${currentLang}` : ''}
      />
    </NodeViewWrapper>
  );
}
