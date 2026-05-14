import DOMPurify from 'dompurify';
import { useMemo } from 'react';
import type { Config as DOMPurifyConfig } from 'dompurify';

interface SanitizedHtmlProps {
  html: string;
  className?: string;
  'data-testid'?: string;
  /**
   * Optional allowlist of additional attributes to permit through DOMPurify.
   * Use sparingly — only for attributes the renderer below the wrapper relies on
   * (e.g. `data-*` hooks for diagram macros).
   */
  additionalAllowedAttrs?: readonly string[];
  /**
   * Optional explicit tag allowlist. When provided, only these tags survive
   * sanitization (stricter than the default DOMPurify allowlist). Use for
   * narrowly-scoped inserts such as search-result highlight markup.
   */
  allowedTags?: readonly string[];
  /**
   * Optional explicit attribute allowlist. Pairs with `allowedTags` to lock
   * down inputs that should accept only a small set of attributes.
   */
  allowedAttrs?: readonly string[];
}

const FORBID_TAGS = ['script', 'style', 'iframe', 'object', 'embed', 'form'];
const FORBID_ATTR = ['onerror', 'onload', 'onclick', 'onmouseover', 'onfocus'];

/**
 * The single allowed entry point for rendering arbitrary HTML in the app.
 * All untrusted HTML (LLM output, Confluence body content, search snippets)
 * must flow through this component so sanitization has exactly one audited
 * configuration site.
 */
export function SanitizedHtml({
  html,
  className,
  additionalAllowedAttrs,
  allowedTags,
  allowedAttrs,
  ...rest
}: SanitizedHtmlProps) {
  const sanitized = useMemo(() => {
    const config: DOMPurifyConfig = {
      FORBID_TAGS,
      FORBID_ATTR,
    };
    if (allowedTags) {
      config.ALLOWED_TAGS = [...allowedTags];
    }
    if (allowedAttrs) {
      config.ALLOWED_ATTR = [...allowedAttrs];
    }
    if (additionalAllowedAttrs && additionalAllowedAttrs.length > 0) {
      config.ADD_ATTR = [...additionalAllowedAttrs];
    }
    return DOMPurify.sanitize(html, config) as string;
  }, [html, additionalAllowedAttrs, allowedTags, allowedAttrs]);

  return (
    <div
      className={className}
      data-testid={rest['data-testid']}
      // nosemgrep: typescript.react.security.audit.react-dangerouslysetinnerhtml.react-dangerouslysetinnerhtml -- single audited wrapper; input is DOMPurify-sanitized with hardened FORBID_TAGS/FORBID_ATTR config
      dangerouslySetInnerHTML={{ __html: sanitized }}
    />
  );
}
