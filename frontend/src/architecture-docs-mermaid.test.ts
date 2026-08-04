import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';
import mermaid from 'mermaid';

/**
 * Regression guard for #1191: every fenced ```mermaid block under
 * docs/architecture/*.md must actually be what it looks like.
 *
 * Mermaid's sequence-diagram message-text lexer rule stops dead at the
 * first `#`, `;` or newline (`/^(?::(?:(?:no)?wrap)?[^#\n;]*)/` for TXT).
 * A raw `;` inside a message/note/section-label produces a hard PARSE
 * ERROR (everything after it is re-lexed as a new statement, which is
 * usually gibberish). A raw `#` is worse: it parses cleanly and just
 * silently drops everything from the `#` to the end of that text, so a
 * broken diagram renders fine and looks correct in review.
 *
 * `mermaid.parse()`/`getDiagramFromText()` only catches the first class —
 * a parse-only guard is blind to every `#` truncation, which is exactly
 * how #1191 shipped. This file therefore does two things per block:
 *   1. Confirms every block still parses (catches the `;` class, and
 *      generalizes to any diagram type).
 *   2. For sequenceDiagram blocks, re-scans the raw *source* lines for a
 *      message/note/alt-else-loop-opt-par-and label and asserts the text
 *      portion contains no raw `#` or `;` outside of mermaid's own
 *      `#<word>;` numeric-escape form (the same regex mermaid's internal
 *      `encodeEntities` pre-lexer pass uses to protect escaped text before
 *      handing it to the parser). That directly targets the lexer-hostile
 *      raw characters rather than trying to diff parsed output against
 *      source — the parsed text of an escaped block is mermaid's internal
 *      placeholder encoding, not the human-readable string, so comparing
 *      db output to source text is not a reliable truncation signal once
 *      a block is intentionally using the escape form.
 *
 * Limitation: only sequenceDiagram blocks get the hazard scan. Other
 * diagram types (flowchart, erDiagram, C4Context, ...) have their own dbs
 * with no unified message/label accessor, so they only get the
 * parse-does-not-throw check (step 1). None of the current defects are in
 * a non-sequence diagram, but a `#`/`;` truncation in, say, a flowchart
 * edge label would not be caught here.
 */

const architectureDir = resolve(__dirname, '../../docs/architecture');

interface SourceLine {
  /** 1-based line number in the original .md file. */
  number: number;
  text: string;
}

interface MermaidBlock {
  file: string;
  /** 1-based line number of the fence's first content line (for reporting). */
  startLine: number;
  source: string;
  lines: SourceLine[];
}

/** Walk every docs/architecture/*.md file and extract fenced ```mermaid blocks. */
function extractMermaidBlocks(): MermaidBlock[] {
  const files = readdirSync(architectureDir).filter((f) => f.endsWith('.md'));
  const blocks: MermaidBlock[] = [];

  for (const file of files) {
    const text = readFileSync(resolve(architectureDir, file), 'utf-8');
    const fileLines = text.split('\n');

    let inBlock = false;
    let startLine = 0;
    let buffer: SourceLine[] = [];

    fileLines.forEach((line, idx) => {
      const lineNumber = idx + 1;
      if (!inBlock && line.trim() === '```mermaid') {
        inBlock = true;
        startLine = lineNumber + 1;
        buffer = [];
        return;
      }
      if (inBlock && line.trim() === '```') {
        inBlock = false;
        blocks.push({
          file,
          startLine,
          source: buffer.map((l) => l.text).join('\n'),
          lines: buffer,
        });
        return;
      }
      if (inBlock) buffer.push({ number: lineNumber, text: line });
    });
  }

  return blocks;
}

/** The diagram-type keyword on the first non-empty line, e.g. "sequenceDiagram". */
function diagramType(block: MermaidBlock): string {
  const first = block.lines.find((l) => l.text.trim().length > 0);
  return first ? first.text.trim().split(/\s+/)[0] : '';
}

// Mirrors mermaid's own pre-lexer escape: chunk-5ZQYHXKU.mjs `encodeEntities`
// swaps every `#<word>;` for a placeholder before the jison lexer ever runs,
// specifically so an escaped `#59;` (-> `;`) or `#35;` (-> `#`) doesn't trip
// the message-text stop characters. Anything matching this is safe.
const VALID_ESCAPE_RE = /#\w+;/g;

// `A->>B: text`, `A-->>B: text`, `A-)B: text`, `A-xB: text`, optional +/-
// activation shorthand right after the arrow (`A->>+B:`).
const ARROW_MESSAGE_RE =
  /^\s*[A-Za-z0-9_]+\s*(?:-{1,2}(?:>{1,2}|[xX]|\)))[+-]?\s*[A-Za-z0-9_]+\s*:\s*(.*)$/;

// `Note over A,B: text`, `note left of A: text`, `note right of A: text`.
const NOTE_RE = /^\s*note\s+(?:over|left of|right of)\s+[^:]+:\s*(.*)$/i;

// Section-header labels that carry free text. `rect` deliberately excluded:
// its argument is a background colour (e.g. `rect rgb(200,200,200)`), not a
// label, and could contain a legitimate `#RRGGBB` that isn't a truncation.
const LABEL_RE = /^\s*(?:alt|else|opt|loop|par|and|critical|break|option)\b\s*(.*)$/;

interface Hazard {
  line: number;
  /** Every hazardous character found — a line can carry both a `;` and a `#` (#1191). */
  chars: string[];
  raw: string;
}

/** Find message/note/label text on sequence-diagram lines carrying a raw, unescaped `#` or `;`. */
function findHazards(block: MermaidBlock): Hazard[] {
  const hazards: Hazard[] = [];

  for (const { number, text } of block.lines) {
    const match =
      text.match(ARROW_MESSAGE_RE) ?? text.match(NOTE_RE) ?? text.match(LABEL_RE);
    if (!match) continue;

    const textPortion = match[1] ?? '';
    const stripped = textPortion.replace(VALID_ESCAPE_RE, '');
    // Global match so a line with both a raw `;` and a raw `#` reports both
    // (e.g. 08-flow-sync.md:60 and 09-flow-rag-chat.md:73 each have one of
    // each) instead of silently stopping at whichever comes first.
    const hazardChars = [...stripped.matchAll(/[#;]/g)].map((m) => m[0]);
    if (hazardChars.length > 0) {
      hazards.push({ line: number, chars: hazardChars, raw: text.trim() });
    }
  }

  return hazards;
}

describe('docs/architecture mermaid blocks', () => {
  const blocks = extractMermaidBlocks();

  beforeAll(() => {
    mermaid.initialize({ startOnLoad: false });
  });

  it('found fenced mermaid blocks to check (extractor sanity check)', () => {
    // Guards against the extractor silently matching nothing (e.g. a fence
    // convention change) and every other test in this file passing vacuously.
    expect(blocks.length).toBeGreaterThanOrEqual(20);
  });

  describe('parses without throwing', () => {
    for (const block of blocks) {
      it(`${block.file}:${block.startLine}`, async () => {
        await expect(mermaid.mermaidAPI.getDiagramFromText(block.source)).resolves.toBeTruthy();
      });
    }
  });

  describe('sequence diagrams: no raw # or ; in message/note/label text', () => {
    const sequenceBlocks = blocks.filter((b) => diagramType(b) === 'sequenceDiagram');

    it('found sequence diagrams to check (extractor sanity check)', () => {
      expect(sequenceBlocks.length).toBeGreaterThan(0);
    });

    for (const block of sequenceBlocks) {
      it(`${block.file}:${block.startLine}`, () => {
        const hazards = findHazards(block);
        expect(
          hazards,
          hazards
            .map(
              (h) =>
                `${block.file}:${h.line} has a raw "${h.chars.join('", "')}" that mermaid's ` +
                `lexer treats as end-of-message (use #59; for ";" or #35; for "#"): ${h.raw}`,
            )
            .join('\n'),
        ).toEqual([]);
      });
    }
  });
});
