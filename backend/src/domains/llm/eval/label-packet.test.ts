/**
 * #1619 — the O15 labelling packet and the validator for what comes back.
 *
 * Two contracts are load-bearing here and neither is visible from the fixture
 * suite:
 *
 * 1. **The packet asks; it never answers.** The gate's primary endpoint runs
 *    on the image-dependent labels, so a packet that arrived with a value in
 *    it — even a plausible one — would be the harness deciding its own sample
 *    under a labeller's name.
 * 2. **The validator's arithmetic is `auditSample`'s.** It reports distances
 *    so a pass knows whether it is six labels or sixty from deciding, and it
 *    must count the same things the gate counts: the per-page cap over
 *    `expectedFiles[0]`, the negatives over `style`. A validator that accepts
 *    a file the gate then refuses is worse than no validator, because the
 *    labelling pass is 309 human decisions long.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ARM_SAMPLE } from './arms.js';
import { IMAGE_CORPUS_DIR, loadImageCorpusManifest } from './corpus-images.js';
import {
  IMAGE_DEPENDENT_CLASSES,
  IMAGE_FIXTURE_PATH,
  loadImageFixture,
  type ImageFixture,
  type ImageFixtureLabel,
} from './fixture.js';
import { auditSample } from './judgments.js';
import { imageAttachmentKey } from './seed-images.js';
import {
  MIN_ITEMS_PER_CLASS,
  REPO_ROOT,
  applyDecisions,
  buildLabelPacket,
  controlQuerySets,
  packetCsv,
  packetJsonl,
  packetReadme,
  parseCsv,
  parseDecisions,
  parseWrittenFixture,
  serializeFixture,
  validateDecisions,
  type LabelDecision,
} from './label-packet.js';

const manifest = loadImageCorpusManifest();
const shipped = loadImageFixture();

/**
 * A fixture with exactly the shape the counts are computed over, so a test can
 * put the sample one label under a threshold without hand-editing 309 rows.
 * Never loaded through `loadImageFixture`: these pages do not exist on disk,
 * and the corpus-relative checks are the shipped fixture's guard, not this
 * one's.
 */
function syntheticFixture(opts: { dependentCandidates: number; negatives: number; pages: number }): ImageFixture {
  const labels: ImageFixtureLabel[] = [];
  for (let i = 0; i < opts.dependentCandidates; i += 1) {
    labels.push({
      id: `syn-${i}`,
      query: `Frage ${i}`,
      lang: i % 3 === 0 ? 'en' : 'de',
      expectedFiles: [`page-${i % opts.pages}.md`],
      expectedImages: [`images/page-${i % opts.pages}__1.png`],
      style: 'image',
      rationale: 'synthetic',
    });
  }
  for (let i = 0; i < opts.negatives; i += 1) {
    labels.push({
      id: `syn-neg-${i}`,
      query: `Negative Frage ${i}`,
      lang: 'de',
      expectedFiles: [`page-${i % opts.pages}.md`],
      expectedImages: [],
      style: 'image-negative',
      rationale: 'synthetic',
    });
  }
  return { corpusManifestSha: 'synthetic', labeledBy: 'synthetic', notUsable: [], labels };
}

/** Decide every label: the first `dependent` positives true, everything else false. */
function decisionsFor(fixture: ImageFixture, dependent: number): LabelDecision[] {
  let marked = 0;
  return fixture.labels.map((label, index) => {
    const isDependent = label.expectedImages.length > 0 && marked < dependent;
    if (isDependent) marked += 1;
    return {
      labelId: label.id,
      imageDependent: isDependent,
      class: isDependent ? IMAGE_DEPENDENT_CLASSES[marked % IMAGE_DEPENDENT_CLASSES.length]! : null,
      row: index + 2,
    };
  });
}

const CONTROLS_AT_O2 = [
  { language: 'en', file: 'fixture.json', queries: ARM_SAMPLE.controlPerLanguage },
  { language: 'de', file: 'fixture-de.json', queries: ARM_SAMPLE.controlPerLanguage },
];

describe('the packet (#1619)', () => {
  const rows = buildLabelPacket(shipped, manifest);

  it('covers every shipped label, in order, with both decision columns empty', () => {
    expect(rows).toHaveLength(shipped.labels.length);
    expect(rows.map((r) => r.labelId)).toEqual(shipped.labels.map((l) => l.id));
    // The whole point of the deliverable: the harness asks, O15 answers.
    expect(rows.filter((r) => r.imageDependent !== '' || r.class !== '')).toEqual([]);
  });

  it('gives the labeller the page, every picture on it, the key it is scored under and the bytes on disk', () => {
    const label = shipped.labels.find((l) => l.expectedImages.length > 0)!;
    const row = rows.find((r) => r.labelId === label.id)!;
    const page = manifest.pages.find((p) => p.file === label.expectedFiles[0])!;

    expect(row.pages.map((p) => p.file)).toEqual(label.expectedFiles);
    expect(row.images.map((i) => i.file)).toEqual(page.images.map((i) => i.file));
    // The key the leg, the report and imageHit@K all address the image by —
    // the packet must not invent a second spelling of it.
    expect(row.images.map((i) => i.attachmentKey)).toEqual(page.images.map((i) => imageAttachmentKey(i.file)));
    // …and a path that resolves, or the labeller cannot look at the picture
    // the ADR says the label must be written from.
    for (const image of row.images) expect(existsSync(join(REPO_ROOT, image.path))).toBe(true);
    for (const pagePath of row.pages) expect(existsSync(join(REPO_ROOT, pagePath.path))).toBe(true);
    // What the label already says, unchanged and marked on the pictures.
    expect(row.expectedImages).toEqual(label.expectedImages);
    expect(row.images.filter((i) => i.expected).map((i) => i.file)).toEqual(label.expectedImages);
  });

  it('survives the round trip through a spreadsheet: commas and quotes in a German query', () => {
    const tricky = shipped.labels.find((l) => l.query.includes(','))!;
    const parsed = parseCsv(packetCsv(rows));
    const header = parsed[0]!;
    const body = parsed.slice(1);
    expect(body).toHaveLength(rows.length);
    const row = body.find((r) => r[header.indexOf('label_id')] === tricky.id)!;
    expect(row[header.indexOf('query')]).toBe(tricky.query);
    expect(row[header.indexOf('image_dependent')]).toBe('');
    expect(row[header.indexOf('class')]).toBe('');
  });

  it('emits one JSONL row per label, and the validator reads its own output back', () => {
    const lines = packetJsonl(rows).trimEnd().split('\n');
    expect(lines).toHaveLength(rows.length);
    // An untouched packet is a complete file with no decisions in it: every
    // label is present and every one is open.
    const back = parseDecisions(packetJsonl(rows));
    expect(back.problems).toEqual([]);
    expect(back.decisions).toHaveLength(rows.length);
    expect(back.decisions.every((d) => d.imageDependent === null && d.class === null)).toBe(true);
  });

  it('quotes the ADR rather than paraphrasing it, and states the counts the pass must reach', () => {
    const readme = packetReadme(rows, shipped, { csv: 'p.csv', jsonl: 'p.jsonl' });
    expect(readme).toContain('the fact is absent from the surrounding prose');
    expect(readme).toContain('the correct image answer is "none of them"');
    expect(readme).toContain(`**${ARM_SAMPLE.imageDependent} image-dependent labels**, hard floor **${ARM_SAMPLE.imageDependentFloor}**`);
    expect(readme).toContain(`**≤ ${ARM_SAMPLE.maxLabelsPerPage} image-dependent labels per page**`);
    expect(readme).toContain(`**${ARM_SAMPLE.imageNegative} image-negative labels**`);
    // The worked examples are invented, and say so: a real label used as an
    // example is a label pre-decided for the person about to decide it.
    expect(readme).toContain('NOT labels in the corpus');
  });
});

describe('the returned file (#1619)', () => {
  it('accepts a complete pass and reports only what the sample is still short of', () => {
    const fixture = syntheticFixture({ dependentCandidates: 260, negatives: ARM_SAMPLE.imageNegative, pages: 55 });
    const result = validateDecisions(fixture, decisionsFor(fixture, ARM_SAMPLE.imageDependent), CONTROLS_AT_O2);
    expect(result.problems).toEqual([]);
    expect(result.shortfalls).toEqual([]);
    expect(result.reducedPower).toBeNull();
    expect(result.imageDependent).toBe(ARM_SAMPLE.imageDependent);
    expect(result.decided).toBe(fixture.labels.length);
    expect(result.undecided).toBe(0);
  });

  it('names the distance on every count O2 fixes, rather than only failing', () => {
    const fixture = syntheticFixture({ dependentCandidates: 200, negatives: 24, pages: 40 });
    const result = validateDecisions(fixture, decisionsFor(fixture, 100), [
      { language: 'en', file: 'fixture.json', queries: 195 },
      { language: 'de', file: 'fixture-de.json', queries: ARM_SAMPLE.controlPerLanguage },
    ]);
    expect(result.problems).toEqual([]);
    const joined = result.shortfalls.join('\n');
    // 100 labels: 44 short of the floor, 90 short of the pre-registered N.
    expect(joined).toContain('100 image-dependent labels — 44 short of 144');
    expect(joined).toContain('90 short of 190');
    expect(joined).toContain('24 image-negative labels — 24 short of 48');
    expect(joined).toContain('image-dependent labels on 40 pages — 5 short of 45');
    expect(joined).toContain('en (fixture.json) is 195 queries, not O2\'s 197');
    // …and the control that IS at 197 is not reported as a shortfall.
    expect(joined).not.toContain('fixture-de.json');
  });

  it('separates the floor band from a refusal: 144–189 decides, and says so under REDUCED POWER', () => {
    const fixture = syntheticFixture({ dependentCandidates: 260, negatives: ARM_SAMPLE.imageNegative, pages: 55 });
    const result = validateDecisions(fixture, decisionsFor(fixture, 150), CONTROLS_AT_O2);
    expect(result.shortfalls).toEqual([]);
    expect(result.reducedPower).toContain('40 short of 190');
    expect(result.reducedPower).toContain('REDUCED POWER');
  });

  it('refuses an unknown, a duplicated and a missing label id, counting what is absent', () => {
    const fixture = syntheticFixture({ dependentCandidates: 10, negatives: 0, pages: 5 });
    const decisions: LabelDecision[] = [
      { labelId: 'syn-0', imageDependent: false, class: null, row: 2 },
      { labelId: 'syn-0', imageDependent: true, class: 'chart', row: 3 },
      { labelId: 'img-99-999', imageDependent: false, class: null, row: 4 },
    ];
    const problems = validateDecisions(fixture, decisions, CONTROLS_AT_O2).problems.join('\n');
    expect(problems).toContain('row 4: unknown label id "img-99-999"');
    expect(problems).toContain('label syn-0 appears twice: rows 2 and 3');
    expect(problems).toContain('9 of 10 labels have no row in the returned file');
  });

  it('refuses a value outside the two sets, and reads true/false in any casing', () => {
    const parsed = parseDecisions(
      'label_id,image_dependent,class\nsyn-0,TRUE,Chart\nsyn-1,maybe,\nsyn-2,false,meme\nsyn-3,,\n',
    );
    expect(parsed.decisions.map((d) => [d.labelId, d.imageDependent, d.class])).toEqual([
      ['syn-0', true, 'chart'],
      ['syn-3', null, null],
    ]);
    expect(parsed.problems).toEqual([
      'row 3 (syn-1): image_dependent is "maybe" — the allowed values are true, false, or empty for a label you have not decided yet',
      `row 4 (syn-2): class is "meme" — the allowed values are ${IMAGE_DEPENDENT_CLASSES.join(', ')}, or empty`,
    ]);
  });

  it('refuses a class without a true, a true without a class, and a true on a label that has no image to depend on', () => {
    const fixture = syntheticFixture({ dependentCandidates: 2, negatives: 1, pages: 2 });
    const problems = validateDecisions(
      fixture,
      [
        { labelId: 'syn-0', imageDependent: false, class: 'chart', row: 2 },
        { labelId: 'syn-1', imageDependent: true, class: null, row: 3 },
        { labelId: 'syn-neg-0', imageDependent: true, class: 'table', row: 4 },
      ],
      CONTROLS_AT_O2,
    ).problems.join('\n');
    expect(problems).toContain('row 2 (syn-0): class "chart" on a label marked image_dependent=false');
    expect(problems).toContain('row 3 (syn-1): image_dependent=true needs a class');
    expect(problems).toContain('row 4 (syn-neg-0): image_dependent=true on a label with no expected image');
  });

  it('refuses a sixth image-dependent label on one page, the cap the design effect is computed under', () => {
    const fixture = syntheticFixture({ dependentCandidates: 7, negatives: 0, pages: 1 });
    const result = validateDecisions(fixture, decisionsFor(fixture, 7), CONTROLS_AT_O2);
    expect(result.problems.join('\n')).toContain(
      `page page-0.md carries 7 image-dependent labels — 2 over O2/O3's cap of ${ARM_SAMPLE.maxLabelsPerPage}`,
    );
    // Exactly the cap passes: the refusal is "more than 5", never "5".
    const atCap = validateDecisions(fixture, decisionsFor(fixture, ARM_SAMPLE.maxLabelsPerPage), CONTROLS_AT_O2);
    expect(atCap.problems).toEqual([]);
    expect(atCap.maxLabelsPerPage).toBe(ARM_SAMPLE.maxLabelsPerPage);
  });

  it('reports a thin per-class slice against O15\'s floor', () => {
    const fixture = syntheticFixture({ dependentCandidates: 260, negatives: ARM_SAMPLE.imageNegative, pages: 55 });
    const decisions = decisionsFor(fixture, 40);
    const thin = validateDecisions(fixture, decisions, CONTROLS_AT_O2).shortfalls.join('\n');
    expect(thin).toContain(`O15 asks for ≥ ${MIN_ITEMS_PER_CLASS} image-dependent labels per class`);
    expect(thin).toContain('short of 10');
  });

  it('counts the pages and the negatives the way auditSample does, so it cannot pass a sample the gate refuses', () => {
    const fixture = syntheticFixture({ dependentCandidates: 260, negatives: ARM_SAMPLE.imageNegative, pages: 55 });
    const decisions = decisionsFor(fixture, ARM_SAMPLE.imageDependent);
    const result = validateDecisions(fixture, decisions, CONTROLS_AT_O2);
    const decided = parseWrittenFixture(applyDecisions(structuredClone(fixture), decisions));
    const audit = auditSample(decided, []);
    expect(audit.shortfalls).toEqual([]);
    expect(audit.powerMode).toBe('full');
    expect([audit.imageDependent, audit.imageNegative, audit.pages, audit.maxLabelsPerPage]).toEqual([
      result.imageDependent,
      result.imageNegative,
      result.pages,
      result.maxLabelsPerPage,
    ]);
  });

  it('reads the control query sets off the files the control runs will pair', () => {
    // Not a restatement of 197: the number comes off `fixture.json` and
    // `fixture-de.json`, so shrinking either one surfaces here rather than
    // three arm-runs later when `--unblind` refuses the controls.
    expect(controlQuerySets()).toEqual([
      { language: 'en', file: 'fixture.json', queries: ARM_SAMPLE.controlPerLanguage },
      { language: 'de', file: 'fixture-de.json', queries: ARM_SAMPLE.controlPerLanguage },
    ]);
  });
});

describe('writing the decisions back (#1619)', () => {
  it('keeps every existing field, adds only the two, and is byte-identical on a second run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'label-packet-'));
    try {
      const path = join(dir, 'fixture-de-images.json');
      const original = readFileSync(IMAGE_FIXTURE_PATH, 'utf8');
      writeFileSync(path, original);

      const decisions = decisionsFor(shipped, ARM_SAMPLE.imageDependent).filter((d) => d.imageDependent);
      const once = serializeFixture(applyDecisions(JSON.parse(readFileSync(path, 'utf8')), decisions));
      writeFileSync(path, once);
      const twice = serializeFixture(applyDecisions(JSON.parse(readFileSync(path, 'utf8')), decisions));
      expect(twice).toBe(once);

      const before = JSON.parse(original) as { labels: Array<Record<string, unknown>> };
      const after = JSON.parse(once) as { labels: Array<Record<string, unknown>> };
      expect(after.labels).toHaveLength(before.labels.length);
      for (const [index, label] of before.labels.entries()) {
        const written = after.labels[index]!;
        // Every field the fixture already carried, value for value — the write
        // goes through the RAW json for exactly this reason.
        for (const [key, value] of Object.entries(label)) expect(written[key]).toEqual(value);
        const added = Object.keys(written).filter((key) => !(key in label));
        expect(added.every((key) => key === 'imageDependent' || key === 'class')).toBe(true);
      }
      // …and the result still loads against the real corpus.
      const reloaded = loadImageFixture(path, IMAGE_CORPUS_DIR);
      expect(reloaded.labels.filter((l) => l.imageDependent === true)).toHaveLength(ARM_SAMPLE.imageDependent);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves an undecided label untouched rather than writing a default', () => {
    const fixture = syntheticFixture({ dependentCandidates: 3, negatives: 0, pages: 3 });
    const written = applyDecisions(structuredClone(fixture), [
      { labelId: 'syn-0', imageDependent: true, class: 'diagram', row: 2 },
      { labelId: 'syn-1', imageDependent: null, class: null, row: 3 },
    ]) as ImageFixture;
    expect(written.labels[0]).toMatchObject({ imageDependent: true, class: 'diagram' });
    expect('imageDependent' in written.labels[1]!).toBe(false);
    expect('imageDependent' in written.labels[2]!).toBe(false);
  });

  it('drops a class when a label is re-decided as not image-dependent', () => {
    const fixture = syntheticFixture({ dependentCandidates: 1, negatives: 0, pages: 1 });
    const first = applyDecisions(structuredClone(fixture), [
      { labelId: 'syn-0', imageDependent: true, class: 'screenshot', row: 2 },
    ]);
    const second = applyDecisions(first, [{ labelId: 'syn-0', imageDependent: false, class: null, row: 2 }]) as ImageFixture;
    expect(second.labels[0]).toMatchObject({ imageDependent: false });
    expect('class' in second.labels[0]!).toBe(false);
  });
});
