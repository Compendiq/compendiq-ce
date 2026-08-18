import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';

/**
 * Guards the #1115 documentation set after the P6 close-out sweep.
 *
 * Three things this pins, each of which was wrong before P6 and each of which
 * regresses the same way — by someone adding a paragraph rather than editing
 * one.
 *
 * 1. **CLAUDE.md is loaded every session, so its #1115 material is budgeted.**
 *    Before P6 the feature owned four paragraphs under "LLM Provider Model"
 *    (~6,800 words) and three under "Testing & Mocks" (~4,000), which is half
 *    the file for one feature whose full argument already lives in ADR-025,
 *    the design of record and three runbooks. P6 rewrote them as exactly two
 *    named blocks. The budget is the point: a rule that will not fit in it
 *    belongs in the ADR with a pointer here.
 *
 * 2. **The consolidation has to STAY one block per section.** A word budget
 *    alone is satisfied by writing a third paragraph, so the shape is pinned
 *    too: every paragraph in CLAUDE.md that names #1115 is one of the two
 *    blocks or a named cross-reference from another section.
 *
 * 3. **The measured record must not live in only one place.** The #1115 P5b
 *    image-axis numbers are quoted in the retrieval-eval runbook (where an
 *    operator meets them) and in ADR-025 (where the decision they inform
 *    lives). Publishing them in the runbook while the ADR still says the
 *    measurement is outstanding is the drift this catches.
 *
 * Nothing here reads app source: these are documentation invariants, and they
 * sit beside `architecture-docs-mermaid.test.ts` for the same reason that one
 * does — the frontend suite is the only one that runs on every PR.
 */

const REPO_ROOT = resolve(__dirname, '..', '..');
const read = (...parts: string[]) => readFileSync(join(REPO_ROOT, ...parts), 'utf-8');

const claudeMd = read('CLAUDE.md');
const adr = read('docs', 'ARCHITECTURE-DECISIONS.md');
const evalRunbook = read('docs', 'runbooks', 'retrieval-eval.md');

/** Blank-line separated blocks, as a Markdown reader sees them. */
const paragraphs = (text: string): string[] =>
  text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

const words = (text: string): number => text.split(/\s+/).filter(Boolean).length;

const RETRIEVAL_BLOCK = '**Multimodal image retrieval (#1115, ADR-025).**';
const EVAL_BLOCK = '**The image corpus, fixture and `--images` axis (#1115 P5).**';

/**
 * Paragraphs elsewhere in CLAUDE.md that legitimately NAME #1115 because the
 * rule they state is about something else and #1115 is the reason for one
 * clause of it. Keyed by their own opening bold phrase so the entry describes
 * a paragraph rather than a line number.
 */
const CROSS_REFERENCES = [
  // ADR-021's own opener lists the use cases that never inherit, and
  // `image_embedding` is the second of them.
  'N named `openai-compatible` providers in `llm_providers` table',
  // #1119's refusal treatment names `image_only_context` as its fourth reason.
  '**An honest refusal is a verdict, and it is neutral (#1119).**',
];

describe('CLAUDE.md keeps the #1115 material consolidated', () => {
  const blocks = paragraphs(claudeMd).filter((p) => p.includes('#1115'));

  it('carries exactly one multimodal-retrieval block, under a 1,300-word budget', () => {
    const found = blocks.filter((p) => p.startsWith(RETRIEVAL_BLOCK));
    expect(found, `expected exactly one paragraph opening ${RETRIEVAL_BLOCK}`).toHaveLength(1);
    expect(words(found[0]!)).toBeLessThanOrEqual(1300);
  });

  it('carries exactly one corpus/fixture/axis block, under a 700-word budget', () => {
    const found = blocks.filter((p) => p.startsWith(EVAL_BLOCK));
    expect(found, `expected exactly one paragraph opening ${EVAL_BLOCK}`).toHaveLength(1);
    expect(words(found[0]!)).toBeLessThanOrEqual(700);
  });

  it('names #1115 nowhere else but the declared cross-references', () => {
    const stray = blocks
      .filter((p) => !p.startsWith(RETRIEVAL_BLOCK) && !p.startsWith(EVAL_BLOCK))
      .filter((p) => !CROSS_REFERENCES.some((prefix) => p.startsWith(prefix)))
      .map((p) => p.slice(0, 90));
    expect(
      stray,
      'a new #1115 paragraph in CLAUDE.md: fold it into one of the two blocks, ' +
        'or move the argument to ADR-025 and leave a pointer',
    ).toEqual([]);
  });
});

describe('every #1115 backend module is named in the domain diagram', () => {
  const domains = read('docs', 'architecture', '03-backend-domains.md');
  const servicesDir = join(REPO_ROOT, 'backend', 'src', 'domains', 'llm', 'services');
  const modules = readdirSync(servicesDir).filter(
    (f) => /^(image-|retrieved-images|vl-embedding)/.test(f) && f.endsWith('.ts') && !f.includes('.test.'),
  );

  it('finds the image-side services on disk', () => {
    // A guard whose subject list came back empty passes vacuously.
    expect(modules.length).toBeGreaterThanOrEqual(5);
  });

  it.each(modules)('%s is documented', (file) => {
    expect(domains).toContain(file);
  });
});

describe('the measured image-axis record is in both places', () => {
  const measuredInRunbook = /^#{2,4}\s+Measured 2026-08-18/m.test(evalRunbook);

  it('the runbook publishes it', () => {
    expect(measuredInRunbook).toBe(true);
  });

  it('ADR-025 carries a Measured section rather than claiming the run is pending', () => {
    const adr025 = adr.slice(adr.indexOf('## ADR-025:'));
    expect(adr025).toMatch(/^###\s+Measured/m);
    // The two headline claims an operator would act on. Quoted rather than
    // recomputed: the harness output is the source, and a doc that rounds it
    // differently from the runbook is the drift this file exists to catch.
    for (const figure of ['4.26 img/s', '0.98 img/s']) {
      expect(adr025, `ADR-025's Measured section must quote ${figure}`).toContain(figure);
      expect(evalRunbook, `the runbook must quote ${figure}`).toContain(figure);
    }
  });

  it('no longer says the measurement is a follow-up', () => {
    const adr025 = adr.slice(adr.indexOf('## ADR-025:'));
    expect(adr025).not.toContain('the MEASUREMENT is not');
    expect(adr025).not.toContain('**The numbers\nthemselves are a follow-up**');
  });
});

describe('the docs put the P4 vision gate in the caller, not in the pick', () => {
  /**
   * Review r1 (major). The P6 sweep's new `03` paragraph said
   * "`pickRetrievedImages` gates on the stored #1154 vision verdict". It does
   * not, and never did: the function takes `(pages, { max, byteBudget })` and
   * contains no capability check at all. The gate is one level up, in
   * `routes/llm/llm-ask.ts` — `chatVision === true ? await
   * pickRetrievedImages(...) : <empty pick>`.
   *
   * That paragraph is the one that argues where the module boundary sits, so a
   * reader who believes the pick self-gates can add a second caller and send
   * bytes to a text-only model. `09` and the ADR both stated it correctly, so
   * this was one divergent copy — exactly the drift a close-out sweep exists to
   * remove, and exactly the drift the next paragraph-adder reintroduces.
   *
   * Two halves, so it fails from either side.
   */
  const RECORD_FILES = [
    'CLAUDE.md',
    'docs/ARCHITECTURE-DECISIONS.md',
    'docs/architecture/03-backend-domains.md',
    'docs/architecture/09-flow-rag-chat.md',
    'docs/superpowers/specs/2026-08-16-multimodal-image-retrieval-design.md',
  ];

  /**
   * The shape the wrong claim shipped in, and nothing broader: the function
   * name as the SUBJECT of a gating verb whose object is the vision verdict.
   * Deliberately narrow, like `attachment-store.test.ts`'s `RETIRED_CLAIM` —
   * "the vision-gated image parts" sitting beside `retrieved-images.ts` in the
   * ADR's P4 list is correct prose and must keep passing.
   */
  const MISATTRIBUTED_GATE =
    /pickRetrievedImages`?\s+(?:only\s+)?(?:gates?|checks?|reads?|requires?|verifies|refuses)\b[^.;]*\bvision\b/i;

  it('the code half: the gate lives in the route, not in the service', () => {
    const service = read('backend', 'src', 'domains', 'llm', 'services', 'retrieved-images.ts');
    const route = read('backend', 'src', 'routes', 'llm', 'llm-ask.ts');
    expect(
      service,
      'the pick now reads the capability itself — if that is deliberate, the ' +
        'records below must move the gate with it',
    ).not.toContain('getVisionCapability');
    expect(route).toContain('getVisionCapability');
  });

  it.each(RECORD_FILES)('%s does not make the pick its own vision gate', (rel) => {
    const text = read(...rel.split('/'));
    // Sentence-scoped, so an unrelated "vision" elsewhere in a 2,000-line file
    // cannot trip it.
    const offenders = text
      .split(/(?<=[.;])\s+/)
      .filter((sentence) => MISATTRIBUTED_GATE.test(sentence))
      .map((sentence) => sentence.trim().slice(0, 160));
    expect(
      offenders,
      `${rel}: pickRetrievedImages(pages, { max, byteBudget }) applies no ` +
        'capability check. The gate is llm-ask.ts — see 09, "Four gates, ' +
        'cheapest first".',
    ).toEqual([]);
  });
});
