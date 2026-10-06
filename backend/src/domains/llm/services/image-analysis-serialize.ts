/**
 * ADR-027 D8 — `serializeImageAnalysis(payload, context)`: the derived chunk
 * text, built by `embedPage` at composition time from the stored payload and
 * the page's CURRENT context. Deterministic and pure: the same payload and
 * context always produce the same text, and nothing here is stored — the
 * table keeps the validated payload, never a serialization.
 *
 * Fixed order and fixed labels (D8), chosen for #1617's rerank window (D11):
 * label, bounded context lines and the ≤ 1,200-char description come first so
 * the cross-encoder always sees provenance, page context and the
 * retrieval-oriented summary; only the tail of a long transcription can fall
 * outside `RERANK_DOC_MAX_CHARS`.
 *
 *   [Image: <attachment_key> — <kind>]
 *   Page: <title>                              (≤ 200)
 *   Caption (author-supplied): <caption>       (≤ 300; omitted when none)
 *   Section: <heading>                         (≤ 200; omitted when none)
 *   Description: <description>
 *   Visible text:                              (omitted when empty)
 *   <visibleText>
 *   Table:                                     (structured blocks; each omitted when absent)
 *   <row> …
 *   Chart: x: …; y: …; series: …; trend: …
 *   Diagram: <node>, … / <edge> …
 *   Limitations: <l1>; <l2>; …                 (omitted when empty)
 *
 * Author-supplied context is labelled as such so it is never conflated with
 * what the model observed. One chunk per image; a serialization over
 * `CHUNK_HARD_LIMIT` splits on the block boundaries above into at most
 * {@link MAX_DERIVED_PARTS} parts, each repeating the label and context lines
 * (the "full provenance") so every part is anchored on its own.
 */
import type { ImageAnalysisPayload } from './image-analysis-provider.js';

export const MAX_DERIVED_PARTS = 3;

const TITLE_MAX = 200;
const CAPTION_MAX = 300;
const HEADING_MAX = 200;

export interface SerializeContext {
  attachmentKey: string;
  pageTitle: string;
  /** `alt` / `<figcaption>` of the reference, when the body carries one. */
  caption?: string | null;
  /** The nearest preceding heading of the reference, when there is one. */
  heading?: string | null;
}

/** Collapse whitespace and bound a context line; `''` when nothing is left. */
function contextLine(value: string | null | undefined, max: number): string {
  if (!value) return '';
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The label + context header every part repeats. */
function header(payload: ImageAnalysisPayload, context: SerializeContext): string {
  const lines = [`[Image: ${context.attachmentKey} — ${payload.kind}]`];
  const title = contextLine(context.pageTitle, TITLE_MAX);
  if (title) lines.push(`Page: ${title}`);
  const caption = contextLine(context.caption, CAPTION_MAX);
  if (caption) lines.push(`Caption (author-supplied): ${caption}`);
  const heading = contextLine(context.heading, HEADING_MAX);
  if (heading) lines.push(`Section: ${heading}`);
  return lines.join('\n');
}

/** The body blocks in D8's order; empty blocks are omitted. */
function blocks(payload: ImageAnalysisPayload): string[] {
  const out: string[] = [];
  const description = payload.description.trim();
  if (description) out.push(`Description: ${description}`);
  const visible = payload.visibleText.trim();
  if (visible) out.push(`Visible text:\n${visible}`);

  const s = payload.structured;
  if (s?.tableRows && s.tableRows.length > 0) {
    out.push(`Table:\n${s.tableRows.join('\n')}`);
  }
  if (s?.chart) {
    const parts: string[] = [];
    if (s.chart.xAxis) parts.push(`x: ${s.chart.xAxis}`);
    if (s.chart.yAxis) parts.push(`y: ${s.chart.yAxis}`);
    if (s.chart.series && s.chart.series.length > 0) parts.push(`series: ${s.chart.series.join(', ')}`);
    if (s.chart.trend) parts.push(`trend: ${s.chart.trend}`);
    if (parts.length > 0) out.push(`Chart: ${parts.join('; ')}`);
  }
  if (s?.diagram) {
    const nodes = s.diagram.nodes ?? [];
    const edges = s.diagram.edges ?? [];
    if (nodes.length > 0 || edges.length > 0) {
      out.push(`Diagram: ${nodes.join(', ')} / ${edges.join('; ')}`);
    }
  }

  const limitations = payload.limitations.map((l) => l.trim()).filter(Boolean);
  if (limitations.length > 0) out.push(`Limitations: ${limitations.join('; ')}`);
  return out;
}

/**
 * The chunk text(s) for one analysis: one part in the ordinary case, up to
 * `MAX_DERIVED_PARTS` when the serialization exceeds `chunkHardLimit`.
 * A block that alone exceeds the room a part has is hard-cut at the limit
 * rather than spilling into a fourth part — the D8 bounds make that
 * unreachable for a conforming payload, and three is the contract.
 */
export function serializeImageAnalysis(
  payload: ImageAnalysisPayload,
  context: SerializeContext,
  chunkHardLimit: number,
): string[] {
  const head = header(payload, context);
  const body = blocks(payload);
  const whole = [head, ...body].join('\n');
  if (whole.length <= chunkHardLimit) return [whole];

  const room = Math.max(1, chunkHardLimit - head.length - 1);
  const parts: string[] = [];
  let current: string[] = [];
  let currentLen = 0;
  const flush = () => {
    if (current.length > 0) parts.push([head, ...current].join('\n'));
    current = [];
    currentLen = 0;
  };
  for (const block of body) {
    const piece = block.length > room ? block.slice(0, room) : block;
    const added = piece.length + (current.length > 0 ? 1 : 0);
    if (current.length > 0 && currentLen + added > room) flush();
    current.push(piece);
    currentLen += added;
  }
  flush();
  return parts.slice(0, MAX_DERIVED_PARTS);
}

const URL_TOKEN = /\b(?:https?|ftp):\/\/\S+|\bwww\.\S+/gi;

/**
 * D8's substantive floor input: `description.length + visibleText.length`
 * after trimming, with URL tokens removed first (URLs alone never count) and
 * context lines outside the sum. Compared against `MIN_EMBEDDABLE_TEXT_CHARS`
 * by `embedPage` (D9.5) — together with the authored text, so an image-only
 * page with one substantive analysis embeds.
 */
export function substantiveChars(payload: ImageAnalysisPayload): number {
  const strip = (s: string): string => s.replace(URL_TOKEN, ' ').replace(/\s+/g, ' ').trim();
  return strip(payload.description).length + strip(payload.visibleText).length;
}
