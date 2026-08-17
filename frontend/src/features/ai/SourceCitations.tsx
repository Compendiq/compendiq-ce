import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { m, AnimatePresence } from 'framer-motion';
import { ChevronDown, ChevronRight, ExternalLink, FileText, Globe, Layers } from 'lucide-react';
import { cn } from '../../shared/lib/cn';
import { resolveSourceTarget } from './source-target';
import { imageSourceFileName, isImageSource } from './image-source';
import { SourceThumbnail } from './SourceThumbnail';

export interface Source {
  pageTitle: string;
  /**
   * Confluence space key, or the `Web` / `External` display label. NULL for
   * locally-created (standalone) pages, which belong to no Confluence space —
   * `pages.space_key` is nullable and the RAG search result has always
   * returned it as such.
   */
  spaceKey?: string | null;
  /**
   * Integer `pages.id` — the id every other navigation in the app uses, and
   * the only one a locally-created page has. 0/absent means the source is not
   * a knowledge-base page at all (web or external docs).
   */
  pageId?: number;
  /**
   * Confluence page id. NULL for locally-created (standalone) pages, and
   * **never a navigation target** — see {@link resolveSourceTarget} for why
   * routing it can open the wrong page.
   */
  confluenceId?: string | null;
  /** Absolute http(s) URL — present only on web / external-docs sources. */
  url?: string;
  sectionTitle?: string;
  /**
   * Retrieval ORDERING value, in whichever unit produced it — an RRF fusion
   * score for a hybrid answer (typically ~0.033, and since #1106's
   * best-chunk-only fusion rule that is also the ceiling at every width; rows
   * persisted before that deploy could reach ~0.17 on this path via per-chunk
   * summing), or a flat `1` for web and external sources, which never went
   * through retrieval. Kept because it orders the array. See
   * `SearchResult.score` in `rag-service.ts` for the scale history.
   *
   * @deprecated Never render or threshold this. Use {@link Source.similarity}.
   */
  score?: number;
  /**
   * Cosine similarity — the only score field with one meaning. `null` or absent
   * when none was measured: a keyword-only retrieval hit, or a web/external
   * source. Absent must render no confidence badge rather than a zero (#1117).
   *
   * Nominally [0,1] but genuinely [-1,1] — see `SearchResult.vectorScore` in
   * `rag-service.ts`. Display sites must not assume a percentage in [0,100].
   */
  similarity?: number | null;
  /**
   * #1115 P3 — `'image'` marks a picture the image retrieval leg matched on
   * one of the answer's pages. **Absent means a knowledge-base page**, which
   * is what every source was before this existed.
   *
   * A separate discriminator from the web/page one on purpose: that split is
   * keyed on `url` (#1125's fix) and the page and web shapes were left
   * untouched, so nothing that already reads this array changes meaning. An
   * image source is still a source ABOUT a page — it carries `pageId` and
   * routes through {@link resolveSourceTarget} exactly like its page — it is
   * only rendered with the picture beside the title.
   */
  kind?: 'image';
  /**
   * The authenticated attachment route serving this image
   * (`/api/attachments/…` or `/api/local-attachments/…`), built server-side by
   * the same builder that parses the `<img src>` back out of a page body.
   *
   * Only ever present with `kind: 'image'`. It is NOT a navigation target —
   * `resolveSourceTarget` never sees it — because clicking a source must open
   * the PAGE, not a bare file.
   */
  attachmentUrl?: string;
}

interface SourceCitationsProps {
  sources: Source[];
}

export function SourceCitations({ sources }: SourceCitationsProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const navigate = useNavigate();

  if (!sources.length) return null;

  return (
    <m.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      className="mt-3"
    >
      {/* Toggle button */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        Sources ({sources.length})
      </button>

      {/* Source cards */}
      <AnimatePresence>
        {isExpanded && (
          <m.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.15 }}
            className="mt-2 space-y-1.5 overflow-hidden"
          >
            {sources.map((source, i) => {
              const target = resolveSourceTarget(source);
              // `null` on every non-image source, and on an image whose URL
              // carries no usable final segment.
              const imageFile = imageSourceFileName(source);
              const motionProps = {
                initial: { opacity: 0, x: -4 },
                animate: { opacity: 1, x: 0 },
                transition: { delay: i * 0.05 },
              };
              const cardClass = cn(
                'flex w-full items-start gap-2.5 rounded-lg bg-primary/10 px-3 py-2 text-left',
                target.kind === 'none'
                  ? 'cursor-default opacity-70'
                  : 'transition-colors hover:bg-primary/15',
              );
              const body = (
                <>
                  {/* #1115 P3 — an image source shows the picture where the
                      glyph would be. It renders nothing while loading or on a
                      failed fetch, and the row degrades to the title-only
                      shape below rather than to a broken-image box. */}
                  {isImageSource(source)
                    ? <SourceThumbnail url={source.attachmentUrl!} size={32} className="mt-0.5" />
                    : target.kind === 'external'
                      ? <Globe size={14} aria-hidden className="mt-0.5 shrink-0 text-primary" />
                      : <FileText size={14} aria-hidden className="mt-0.5 shrink-0 text-primary" />}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium text-foreground">
                      {source.pageTitle}
                    </p>
                    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                      {/* #1115 P3 — the word, not a colour. An image source is
                          a CATEGORY (ADR-010), and the label is what still
                          identifies it when the thumbnail has not loaded, in
                          forced-colors, and to a screen reader (the picture
                          itself is decorative).
                          The filename is the NEXT item in the same row (review
                          r1), because one page contributes up to three image
                          sources and every other word here is identical across
                          them. It is the one item that can be long, so it is
                          the one that truncates — `min-w-0` is what lets it,
                          and `shrink-0` on the label above is what stops the
                          category word being eaten first. The card's
                          accessible name is its text content, so the full name
                          is still announced. */}
                      {isImageSource(source) && (
                        <span className="shrink-0" data-testid="source-image-label">Image</span>
                      )}
                      {imageFile && (
                        <span className="min-w-0 truncate" data-testid="source-image-file">
                          {imageFile}
                        </span>
                      )}
                      {/* Standalone pages have no space — render nothing rather
                          than an orphaned icon with a blank label. */}
                      {source.spaceKey && (
                        <span className="flex items-center gap-0.5">
                          <Layers size={10} aria-hidden /> {source.spaceKey}
                        </span>
                      )}
                      {source.sectionTitle && (
                        <span className="truncate">
                          {source.sectionTitle}
                        </span>
                      )}
                    </div>
                  </div>
                  {target.kind === 'external' && (
                    <ExternalLink size={12} aria-hidden className="mt-0.5 shrink-0 text-muted-foreground" />
                  )}
                </>
              );
              const testId = `source-card-${i + 1}`;

              // Web / external-docs sources are links, not routes. Navigating to
              // `/pages/<url>` never matches `/pages/:id` and lands on the
              // not-found page (#1125).
              if (target.kind === 'external') {
                return (
                  <m.a
                    key={i}
                    {...motionProps}
                    href={target.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    // The ExternalLink glyph is the sighted cue; it is
                    // aria-hidden, so the new tab has to be named here.
                    aria-label={`${source.pageTitle} (opens in a new tab)`}
                    className={cardClass}
                    data-testid={testId}
                  >
                    {body}
                  </m.a>
                );
              }

              if (target.kind === 'internal') {
                return (
                  <m.button
                    key={i}
                    {...motionProps}
                    onClick={() => navigate(target.path)}
                    className={cardClass}
                    data-testid={testId}
                  >
                    {body}
                  </m.button>
                );
              }

              // No usable target: still list the source (the numbering is
              // referenced from the answer text) but don't offer a dead link.
              return (
                <m.div
                  key={i}
                  {...motionProps}
                  className={cardClass}
                  title="This source has no page that can be opened."
                  data-testid={testId}
                >
                  {body}
                </m.div>
              );
            })}
          </m.div>
        )}
      </AnimatePresence>
    </m.div>
  );
}
