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
 * A raw `;` inside a message/note/label/alias produces a hard PARSE ERROR
 * (everything after it is re-lexed as a new statement, which is usually
 * gibberish). A raw `#` is worse: it parses cleanly and just silently
 * drops everything from the `#` to the end of that text, so a broken
 * diagram renders fine and looks correct in review.
 *
 * `mermaid.parse()` only catches the first class — a parse-only guard is
 * blind to every `#` truncation, which is exactly how #1191 shipped. This
 * file therefore does two things per block:
 *   1. Confirms every block still parses (catches the `;` class, and
 *      generalizes to any diagram type).
 *   2. For sequenceDiagram blocks, re-scans the raw *source* lines for a
 *      message, note, alt-else-loop-opt-par-and label, or participant/actor
 *      alias, and asserts the text portion contains no raw `#` or `;`
 *      outside the small set of numeric escapes this doc set has actually
 *      verified safe (see VALID_ESCAPE_RE below). That directly targets
 *      the lexer-hostile raw characters rather than trying to diff parsed
 *      output against source — the parsed text of an escaped block is
 *      mermaid's internal placeholder encoding, not the human-readable
 *      string, so comparing db output to source text is not a reliable
 *      truncation signal once a block is intentionally using an escape.
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

/**
 * Parse every fenced ```mermaid block out of one file's raw text. Split out
 * from extractMermaidBlocks() so it can be exercised directly with inline
 * fixtures below, instead of only ever running against the real docs.
 */
function extractBlocksFromText(file: string, text: string): MermaidBlock[] {
  const fileLines = text.split('\n');
  const blocks: MermaidBlock[] = [];

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

  // A fence opened but never closed would otherwise just drop the block
  // silently — the ">= 20 blocks" sanity check below is too coarse to
  // notice one missing block out of 23. And it's not an edge case: in 8 of
  // these 12 docs (01, 02, 03, 04, 06, 07, 08, 10) the LAST fenced block of
  // any kind — mermaid or otherwise — is a mermaid block, so deleting its
  // closing fence leaves no later ``` for the old code to (mis)use as a
  // substitute close, and the file just runs to EOF still "in" the block.
  // (This is about fence order, not file length — every doc still has
  // prose after that block; none of the 12 literally ends on mermaid's
  // closing ``` as its last line. Verified by measurement, not assumption:
  // an earlier draft of this comment claimed the opposite — PR #1213
  // review.)
  if (inBlock) {
    throw new Error(
      `${file}: unterminated \`\`\`mermaid fence opened at line ${startLine - 1} ` +
        `(no closing \`\`\` before end of file)`,
    );
  }

  return blocks;
}

/** Walk every docs/architecture/*.md file and extract fenced ```mermaid blocks. */
function extractMermaidBlocks(): MermaidBlock[] {
  const files = readdirSync(architectureDir).filter((f) => f.endsWith('.md'));
  return files.flatMap((file) =>
    extractBlocksFromText(file, readFileSync(resolve(architectureDir, file), 'utf-8')),
  );
}

/** The diagram-type keyword on the first non-empty line, e.g. "sequenceDiagram". */
function diagramType(block: MermaidBlock): string {
  const first = block.lines.find((l) => l.text.trim().length > 0);
  return first ? first.text.trim().split(/\s+/)[0] : '';
}

// Only the two escapes this doc set actually uses are blessed here — NOT
// mermaid's general `#<word>;` pre-lexer escape form. That general form is
// unsafe to wave through sight-unseen: `#906;` is itself a syntactically
// valid escape (mermaid's own encodeEntities accepts any `#\w+;`), but it
// decodes to the literal Unicode character U+038A "Ί" (a real HTML numeric
// character reference), not the text "#906" — and `#wontfix;` decodes to
// the literal string "&wontfix;" (not a recognised named HTML entity, so a
// browser renders it un-decoded, visible entity syntax and all). Both were
// confirmed against the installed mermaid's actual
// encodeEntities -> decodeEntities -> entityDecode pipeline (PR #1213
// review). Extend this list only for an escape a human has verified
// round-trips to the intended character.
const VALID_ESCAPE_RE = /#(?:35|59);/g;

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

// `participant B as Backend`, `actor B as Backend`, and the mermaid >=10.3
// `create participant B as Backend` / `create actor B as Backend` forms.
// The alias text is a display name, not code, and mermaid truncates/breaks
// it exactly like message text on a raw `#`/`;` — confirmed for both the
// plain and `create`-prefixed forms (PR #1213 review — previously
// unguarded; the `create` prefix was still missed in that review's first
// pass and closed in this follow-up).
const ALIAS_RE = /^\s*(?:create\s+)?(?:participant|actor)\s+\S+\s+as\s+(.*)$/i;

// `box <label>` group headers were checked and are deliberately NOT added
// to the hazard scan. A raw `;` still hard-fails the same as everywhere
// else (already caught by the generic "parses without throwing" check
// above, for every construct, not just this one). But a raw `#` does NOT
// truncate a box label the way it does a message/note/label/alias: probing
// the installed mermaid showed identical parse behaviour with and without
// a `#` in the box argument (same downstream code reached either way), and
// mermaid's own source confirms why — SequenceDB#parseBoxData splits an
// already-fully-captured line into color/title with a plain JS regex, not
// through the lexer's `[^#\n;]*` boundary (its own comment: "#hex codes
// are not supported for now because of the way the char # is handled" is
// about color *detection* falling back to treating the whole string as the
// title, not about text loss). This could only be confirmed by reading
// that source directly: mermaid.render() and even mermaid.parse() cannot
// run a `box` statement to completion under jsdom at all (clean box labels
// throw "window.CSS.supports is not a function" from inside
// parseBoxData — a jsdom gap, not a mermaid or docs defect), so there is no
// way to observe the final title end-to-end in this test environment. No
// current doc uses `box`.

interface Hazard {
  line: number;
  /** Every hazardous character found — a line can carry both a `;` and a `#` (#1191). */
  chars: string[];
  raw: string;
}

/**
 * Find message/note/label/alias text on sequence-diagram lines carrying a
 * raw `#` or `;` that isn't part of an allow-listed escape.
 */
function findHazards(block: MermaidBlock): Hazard[] {
  const hazards: Hazard[] = [];

  for (const { number, text } of block.lines) {
    const match =
      text.match(ARROW_MESSAGE_RE) ??
      text.match(NOTE_RE) ??
      text.match(LABEL_RE) ??
      text.match(ALIAS_RE);
    if (!match) continue;

    const textPortion = match[1] ?? '';
    const stripped = textPortion.replace(VALID_ESCAPE_RE, '');
    // Global match so a line with both a raw `;` and a raw `#` reports both
    // (08-flow-sync.md:60 and 09-flow-rag-chat.md:73 each had one of each
    // before #1191's fix) instead of silently stopping at whichever comes
    // first.
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
        // mermaid.mermaidAPI is @deprecated/@internal in 11.15.0; the
        // top-level parse() is the supported entry point and throws on
        // invalid syntax the same way (PR #1213 review).
        await expect(mermaid.parse(block.source)).resolves.toBeTruthy();
      });
    }
  });

  describe('sequence diagrams: no raw # or ; in message/note/label/alias text', () => {
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
                `${block.file}:${h.line} has a raw "${h.chars.join('", "')}" that isn't part of ` +
                `an allow-listed escape (use #59; for ";" or #35; for "#"): ${h.raw}`,
            )
            .join('\n'),
        ).toEqual([]);
      });
    }
  });

  // Inline-fixture unit tests below pin the guard's own machinery — the
  // regexes and the extractor — rather than only the current docs'
  // cleanliness, so a future edit that reopens one of these gaps fails here
  // even if nobody has (yet) written the offending doc line (PR #1213 review).
  describe('findHazards (unit, inline fixtures)', () => {
    /** Build a MermaidBlock through the real extractor, from inline lines. */
    function block(lines: string[]): MermaidBlock {
      const text = ['```mermaid', ...lines, '```', ''].join('\n');
      const [b] = extractBlocksFromText('fixture.md', text);
      if (!b) throw new Error('fixture produced no block');
      return b;
    }

    it('flags a raw # inside a participant alias', () => {
      const hazards = findHazards(
        block([
          'sequenceDiagram',
          'participant B as Backend #906 area',
          'participant C as Client',
          'B->>C: hi',
        ]),
      );
      expect(hazards).toHaveLength(1);
      expect(hazards[0]!.chars).toEqual(['#']);
      expect(hazards[0]!.raw).toContain('Backend #906 area');
    });

    it('flags a raw # inside an actor alias', () => {
      const hazards = findHazards(
        block(['sequenceDiagram', 'actor B as Backend #906 area', 'B->>B: hi']),
      );
      expect(hazards).toHaveLength(1);
      expect(hazards[0]!.chars).toEqual(['#']);
    });

    it('flags a raw # inside a `create participant ... as` alias', () => {
      const hazards = findHazards(
        block([
          'sequenceDiagram',
          'participant A',
          'create participant B as Backend #906 area',
          'A->>B: hi',
        ]),
      );
      expect(hazards).toHaveLength(1);
      expect(hazards[0]!.chars).toEqual(['#']);
      expect(hazards[0]!.raw).toContain('create participant B as Backend #906 area');
    });

    it('flags a raw # inside a `create actor ... as` alias', () => {
      const hazards = findHazards(
        block([
          'sequenceDiagram',
          'participant A',
          'create actor B as Backend #906 area',
          'A->>B: hi',
        ]),
      );
      expect(hazards).toHaveLength(1);
      expect(hazards[0]!.chars).toEqual(['#']);
    });

    it('does not flag a clean `create participant ... as` alias', () => {
      const hazards = findHazards(
        block([
          'sequenceDiagram',
          'participant A',
          'create participant B as Backend area',
          'A->>B: hi',
        ]),
      );
      expect(hazards).toEqual([]);
    });

    it('does not flag a clean participant alias', () => {
      const hazards = findHazards(
        block([
          'sequenceDiagram',
          'participant B as Backend area',
          'participant C as Client',
          'B->>C: hi',
        ]),
      );
      expect(hazards).toEqual([]);
    });

    it('does not treat #906; as a safe escape even though it is a syntactically valid #<word>; form', () => {
      const hazards = findHazards(
        block([
          'sequenceDiagram',
          'participant A',
          'participant B',
          'A->>B: lock lapse (#906; see runbook)',
        ]),
      );
      expect(hazards).toHaveLength(1);
      expect(hazards[0]!.chars).toEqual(['#', ';']);
    });

    it('does not treat #wontfix; as a safe escape', () => {
      const hazards = findHazards(
        block(['sequenceDiagram', 'participant A', 'participant B', 'A->>B: status is #wontfix; confirmed']),
      );
      expect(hazards).toHaveLength(1);
    });

    it('still allows the two escapes the docs actually use (#35; and #59;)', () => {
      const hazards = findHazards(
        block(['sequenceDiagram', 'participant A', 'participant B', 'A->>B: allow #35;814 skip#59; tree']),
      );
      expect(hazards).toEqual([]);
    });
  });

  describe('extractBlocksFromText (unit, inline fixtures)', () => {
    it('extracts a normally closed block', () => {
      const blocks2 = extractBlocksFromText(
        'fixture.md',
        ['# heading', '```mermaid', 'sequenceDiagram', 'A->>B: hi', '```', ''].join('\n'),
      );
      expect(blocks2).toHaveLength(1);
      expect(blocks2[0]!.source).toContain('A->>B: hi');
    });

    it('throws, naming the file, when a fence is never closed before end of file', () => {
      const text = ['# heading', '```mermaid', 'sequenceDiagram', 'A->>B: hi'].join('\n');
      expect(() => extractBlocksFromText('unterminated.md', text)).toThrow(/unterminated\.md/);
    });
  });
});
