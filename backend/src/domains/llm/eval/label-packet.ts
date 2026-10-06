/**
 * #1619 — ADR-027 O15's labelling packet, and the validator for the file that
 * comes back.
 *
 * O15 is a HUMAN deliverable and stays one. ADR-027's primary endpoint runs on
 * the IMAGE-DEPENDENT labels, and the classification is an independent pass by
 * a labeller who has seen neither the candidate's descriptions nor the
 * retrieval code. Nothing here decides a label: the packet is the 309 shipped
 * labels re-presented with everything the labeller needs in one place (the
 * query, the page, the page's pictures with the attachment key each is scored
 * under and the file each one is on disk), plus two EMPTY columns. The
 * validator refuses what comes back or writes it into the fixture — it never
 * fills a blank.
 *
 * Two files are emitted because the work has two shapes: a CSV for the
 * spreadsheet pass over 309 rows, and a JSONL carrying the same rows with the
 * per-image detail structured (a cell of `key=… path=…` triples is readable,
 * but it is not something a script should have to re-parse). The validator
 * accepts either back.
 *
 * `imageAttachmentKey` is imported rather than re-spelled: it is the one
 * mapping from a manifest path (`images/x__1.png`) to the key the leg, the
 * report and `imageHit@K` are all scored under, and its own comment says two
 * spellings of it would silently score zero. Importing it costs this module
 * the seeder's import graph and no database work — nothing here opens a
 * connection, and both scripts run with no `POSTGRES_URL` at all.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { IMAGE_CORPUS_DIR, type ImageCorpusManifest } from './corpus-images.js';
import {
  IMAGE_DEPENDENT_CLASSES,
  ImageFixtureSchema,
  type ImageFixture,
} from './fixture.js';
import { imageAttachmentKey } from './seed-images.js';
import { ARM_SAMPLE } from './arms.js';

export type ImageDependentClass = (typeof IMAGE_DEPENDENT_CLASSES)[number];

/** Repository root, so every path in the packet is one the owner can paste. */
export const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..', '..');

/**
 * O15's second rule: the per-class slice needs enough items to report on.
 * `class` is only asked for on an image-dependent label, so this is a floor on
 * the dependent set's composition, never on the fixture's.
 */
export const MIN_ITEMS_PER_CLASS = 10;

/**
 * The control query sets O2 sizes at 197 each. The file naming is
 * `run-retrieval-eval.ts`'s (`fixture.json` for EN, `fixture-<lang>.json`
 * otherwise) — the control runs pair exactly these labels, so a query set that
 * is not 197 long is a control `--unblind` will refuse, knowable before a
 * single control run is made.
 */
export const CONTROL_QUERY_SETS = [
  { language: 'en', file: 'fixture.json' },
  { language: 'de', file: 'fixture-de.json' },
] as const;

// ---------------------------------------------------------------------------
// The packet.
// ---------------------------------------------------------------------------

export interface PacketImage {
  /** Manifest-relative path, the spelling `expectedImages` uses. */
  file: string;
  /** What the leg, the report and `imageHit@K` address this image by. */
  attachmentKey: string;
  /** Repository-relative file on disk — the bytes the label must be written from. */
  path: string;
  caption: string;
  width: number;
  height: number;
  /** Whether this label already names the image in `expectedImages`. */
  expected: boolean;
}

export interface PacketPage {
  /** The fixture's page identity: the corpus filename in `expectedFiles`. */
  file: string;
  title: string;
  url: string;
  category: string;
  /** Repository-relative markdown on disk — the prose the decision is made against. */
  path: string;
}

export interface PacketRow {
  labelId: string;
  query: string;
  lang: 'de' | 'en';
  style: 'image' | 'image-negative';
  rationale: string;
  pages: PacketPage[];
  images: PacketImage[];
  /** Exactly what the shipped label says today, unchanged. */
  expectedImages: string[];
  /** The owner's first decision. Always empty in a generated packet. */
  imageDependent: '';
  /** The owner's second decision. Always empty in a generated packet. */
  class: '';
}

/** The CSV header, and the columns the validator reads back. */
export const PACKET_COLUMNS = [
  'label_id',
  'query',
  'lang',
  'style',
  'page_files',
  'page_titles',
  'page_paths',
  'expected_images',
  'page_images',
  'rationale',
  'image_dependent',
  'class',
] as const;

/** The two the owner fills; everything else travels back unread. */
export const DECISION_COLUMNS = ['label_id', 'image_dependent', 'class'] as const;

/**
 * One row per label, in fixture order. Throws rather than skipping a label
 * whose page is not in the manifest: the packet's contract is that it covers
 * every label, and a packet of 308 rows is a labelling pass that silently
 * cannot reach O2's counts.
 */
export function buildLabelPacket(
  fixture: ImageFixture,
  manifest: ImageCorpusManifest,
  corpusDir: string = IMAGE_CORPUS_DIR,
): PacketRow[] {
  const pageOf = new Map(manifest.pages.map((page) => [page.file, page]));
  return fixture.labels.map((label) => {
    const pages: PacketPage[] = [];
    const images: PacketImage[] = [];
    for (const file of label.expectedFiles) {
      const page = pageOf.get(file);
      if (!page) {
        throw new Error(
          `label ${label.id} expects page ${file}, which is not in ${join(corpusDir, 'MANIFEST.json')} — ` +
            'the packet must cover every label, so this is refused rather than skipped',
        );
      }
      pages.push({
        file: page.file,
        title: page.title,
        url: page.url,
        category: page.category,
        path: relative(REPO_ROOT, join(corpusDir, page.file)),
      });
      for (const image of page.images) {
        images.push({
          file: image.file,
          attachmentKey: imageAttachmentKey(image.file),
          path: relative(REPO_ROOT, join(corpusDir, image.file)),
          caption: image.caption,
          width: image.width,
          height: image.height,
          expected: label.expectedImages.includes(image.file),
        });
      }
    }
    return {
      labelId: label.id,
      query: label.query,
      lang: label.lang,
      style: label.style,
      rationale: label.rationale,
      pages,
      images,
      expectedImages: [...label.expectedImages],
      imageDependent: '',
      class: '',
    };
  });
}

function csvCell(value: string): string {
  return /["\n\r,]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** One CSV line: `csvCell`'s escaping applied cell by cell. */
function csvRow(cells: readonly string[]): string {
  return cells.map(csvCell).join(',');
}

export function packetCsv(rows: readonly PacketRow[]): string {
  const lines = [csvRow(PACKET_COLUMNS)];
  for (const row of rows) {
    lines.push(
      csvRow([
        row.labelId,
        row.query,
        row.lang,
        row.style,
        row.pages.map((p) => p.file).join(' ; '),
        row.pages.map((p) => p.title).join(' ; '),
        row.pages.map((p) => p.path).join(' ; '),
        row.expectedImages.join(' ; '),
        row.images
          .map((i) => `${i.attachmentKey} [${i.expected ? 'expected' : 'other'}] ${i.path}`)
          .join(' ; '),
        row.rationale,
        row.imageDependent,
        row.class,
      ]),
    );
  }
  return `${lines.join('\n')}\n`;
}

export function packetJsonl(rows: readonly PacketRow[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
}

/**
 * RFC-4180 enough for this packet: quoted cells, doubled quotes inside them,
 * embedded newlines and commas. Hand-written because the returned file is a
 * spreadsheet export of a file this repository generated, and a dependency
 * whose only job is to read back what we wrote is a dependency.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let started = false;
  const endCell = (): void => {
    row.push(cell);
    cell = '';
  };
  const endRow = (): void => {
    endCell();
    rows.push(row);
    row = [];
    started = false;
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell === '') {
      quoted = true;
      started = true;
    } else if (ch === ',') {
      endCell();
      started = true;
    } else if (ch === '\n') {
      endRow();
    } else if (ch === '\r') {
      // CRLF from a spreadsheet export; the \n does the work.
    } else {
      cell += ch;
      started = true;
    }
  }
  if (started || cell !== '' || row.length > 0) endRow();
  return rows;
}

// ---------------------------------------------------------------------------
// What comes back.
// ---------------------------------------------------------------------------

export interface LabelDecision {
  labelId: string;
  /** `null` is an untouched row — reported as missing, never guessed. */
  imageDependent: boolean | null;
  class: ImageDependentClass | null;
  /** 1-based line in the returned file, so a refusal names where to look. */
  row: number;
}

export interface ParsedDecisions {
  decisions: LabelDecision[];
  problems: string[];
  /**
   * Every label id the file names, INCLUDING the rows a value error rejected.
   * Without it a row refused for a misspelled class was also counted as a
   * label with no row at all — two refusals, one cause, and the second one
   * tells the labeller to go and write a row that is already there.
   */
  labelIdsSeen: string[];
}

function decisionFrom(
  labelId: string,
  dependentRaw: string,
  classRaw: string,
  row: number,
  problems: string[],
): LabelDecision | null {
  const id = labelId.trim();
  if (id === '') {
    problems.push(`row ${row}: no label_id`);
    return null;
  }
  const dependent = dependentRaw.trim().toLowerCase();
  const cls = classRaw.trim().toLowerCase();
  let imageDependent: boolean | null = null;
  if (dependent === 'true') imageDependent = true;
  else if (dependent === 'false') imageDependent = false;
  else if (dependent !== '') {
    problems.push(
      `row ${row} (${id}): image_dependent is "${dependentRaw.trim()}" — the allowed values are true, false, ` +
        'or empty for a label you have not decided yet',
    );
    return null;
  }
  let parsedClass: ImageDependentClass | null = null;
  if (cls !== '') {
    if (!(IMAGE_DEPENDENT_CLASSES as readonly string[]).includes(cls)) {
      problems.push(
        `row ${row} (${id}): class is "${classRaw.trim()}" — the allowed values are ` +
          `${IMAGE_DEPENDENT_CLASSES.join(', ')}, or empty`,
      );
      return null;
    }
    parsedClass = cls as ImageDependentClass;
  }
  return { labelId: id, imageDependent, class: parsedClass, row };
}

/**
 * Read the owner's file, in either shape the packet was written in. Detection
 * is on the first non-blank character rather than the extension, so a JSONL
 * saved as `.txt` still reads and a CSV renamed `.jsonl` fails on its header
 * rather than on every row.
 */
export function parseDecisions(text: string): ParsedDecisions {
  const problems: string[] = [];
  const decisions: LabelDecision[] = [];
  const labelIdsSeen: string[] = [];
  const firstChar = text.trimStart().slice(0, 1);
  if (firstChar === '{') {
    const lines = text.split('\n');
    for (const [index, line] of lines.entries()) {
      if (line.trim() === '') continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        problems.push(`row ${index + 1}: not JSON`);
        continue;
      }
      const id = parsed['labelId'] ?? parsed['label_id'];
      const dependent = parsed['imageDependent'] ?? parsed['image_dependent'] ?? '';
      const cls = parsed['class'] ?? '';
      if (typeof id !== 'string' || id.trim() === '') {
        problems.push(`row ${index + 1}: no labelId`);
        continue;
      }
      labelIdsSeen.push(id.trim());
      const dependentText =
        typeof dependent === 'boolean' ? String(dependent) : typeof dependent === 'string' ? dependent : 'not-a-value';
      const classText = typeof cls === 'string' ? cls : 'not-a-value';
      const decision = decisionFrom(id, dependentText, classText, index + 1, problems);
      if (decision) decisions.push(decision);
    }
    return { decisions, problems, labelIdsSeen };
  }

  const rows = parseCsv(text);
  const header = rows[0];
  if (!header) return { decisions, problems: ['the file is empty'], labelIdsSeen };
  const index = new Map(header.map((name, i) => [name.trim().toLowerCase(), i]));
  const missingColumns = DECISION_COLUMNS.filter((name) => !index.has(name));
  if (missingColumns.length > 0) {
    return {
      decisions,
      labelIdsSeen,
      problems: [
        `the header is missing ${missingColumns.join(', ')} — the returned file must keep the packet's ` +
          `columns (${DECISION_COLUMNS.join(', ')} are the ones that are read)`,
      ],
    };
  }
  const idAt = index.get('label_id')!;
  const dependentAt = index.get('image_dependent')!;
  const classAt = index.get('class')!;
  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i]!;
    if (row.every((cell) => cell.trim() === '')) continue;
    const id = (row[idAt] ?? '').trim();
    if (id !== '') labelIdsSeen.push(id);
    const decision = decisionFrom(id, row[dependentAt] ?? '', row[classAt] ?? '', i + 1, problems);
    if (decision) decisions.push(decision);
  }
  return { decisions, problems, labelIdsSeen };
}

export interface ControlQuerySet {
  language: string;
  file: string;
  queries: number;
}

/**
 * How long each control query set actually is. Read off the fixture files, not
 * asserted: O2 sizes the controls at 197 per language, and `auditSample`
 * re-checks it at `--unblind` against the reports the control runs produce.
 */
export function controlQuerySets(dir: string = import.meta.dirname): ControlQuerySet[] {
  return CONTROL_QUERY_SETS.map(({ language, file }) => {
    const path = join(dir, file);
    if (!existsSync(path)) return { language, file, queries: 0 };
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { labels?: unknown[] };
    return { language, file, queries: Array.isArray(parsed.labels) ? parsed.labels.length : 0 };
  });
}

export interface PacketValidation {
  /**
   * Everything that makes the returned FILE unusable: a row that names no
   * label, a value outside the allowed set, a contradiction, a label with no
   * row. Non-empty means nothing is written.
   */
  problems: string[];
  /**
   * Everything O2 asks for that the sample does not reach. The file is fine
   * and can be written; the GATE still decides nothing until these are closed,
   * and each one says by how much.
   */
  shortfalls: string[];
  /** Kept apart from `shortfalls`: the sample decides, at less than 0.90. */
  reducedPower: string | null;
  decided: number;
  undecided: number;
  imageDependent: number;
  imageNegative: number;
  pages: number;
  maxLabelsPerPage: number;
  perClass: Record<string, number>;
  /**
   * The image-dependent set by language. O2 asks for EN:DE ≈ 1:2 — an
   * approximation, so it is reported and never refused: a labelling pass held
   * to a ratio nobody can state exactly would be refused for arithmetic.
   */
  perLanguage: Record<string, number>;
  controls: ControlQuerySet[];
}

function distance(actual: number, target: number): string {
  return `${target - actual} short of ${target}`;
}

/**
 * Hold the returned decisions to O2, O3 and O15 — and say by how much each one
 * misses, because "refused" alone does not tell a labelling pass whether it is
 * six labels from deciding or sixty.
 *
 * The per-page count is taken over `expectedFiles[0]`, which is what
 * `auditSample` counts: the two must agree, or this validator accepts a file
 * the gate then refuses.
 */
export function validateDecisions(
  fixture: ImageFixture,
  decisions: readonly LabelDecision[],
  controls: readonly ControlQuerySet[] = controlQuerySets(),
  /**
   * Every id the FILE named, rejected rows included (`parseDecisions`'
   * `labelIdsSeen`). Defaults to the accepted decisions, which is right for a
   * caller that built them in memory and wrong only for a file whose row was
   * refused for a bad value: that label has a row, and telling the labeller
   * to write one is a second refusal with the same cause.
   */
  presentIds: readonly string[] = decisions.map((d) => d.labelId),
): PacketValidation {
  const problems: string[] = [];
  const shortfalls: string[] = [];
  const labelById = new Map(fixture.labels.map((label) => [label.id, label]));

  const seen = new Map<string, LabelDecision>();
  const accepted = new Map<string, LabelDecision>();
  for (const decision of decisions) {
    const label = labelById.get(decision.labelId);
    if (!label) {
      problems.push(
        `row ${decision.row}: unknown label id "${decision.labelId}" — it is not one of the ` +
          `${fixture.labels.length} labels in fixture-de-images.json`,
      );
      continue;
    }
    const first = seen.get(decision.labelId);
    if (first) {
      problems.push(`label ${decision.labelId} appears twice: rows ${first.row} and ${decision.row}`);
      continue;
    }
    seen.set(decision.labelId, decision);
    if (decision.imageDependent === null) {
      if (decision.class !== null) {
        problems.push(
          `row ${decision.row} (${decision.labelId}): class "${decision.class}" with no image_dependent value — ` +
            'a class describes an image-dependent label, so decide that first',
        );
      }
      continue;
    }
    if (decision.imageDependent && decision.class === null) {
      problems.push(
        `row ${decision.row} (${decision.labelId}): image_dependent=true needs a class ` +
          `(${IMAGE_DEPENDENT_CLASSES.join(', ')}) — O15 reports a per-class slice`,
      );
      continue;
    }
    if (!decision.imageDependent && decision.class !== null) {
      problems.push(
        `row ${decision.row} (${decision.labelId}): class "${decision.class}" on a label marked ` +
          'image_dependent=false — the class is the content shape of an image-dependent label',
      );
      continue;
    }
    if (decision.imageDependent && label.expectedImages.length === 0) {
      problems.push(
        `row ${decision.row} (${decision.labelId}): image_dependent=true on a label with no expected image ` +
          `(style ${label.style}) — the primary endpoint asks whether image evidence changes the answer, and ` +
          'a label whose correct image answer is "none" can never be answered from one',
      );
      continue;
    }
    accepted.set(decision.labelId, decision);
  }

  const named = new Set(presentIds);
  const missing = fixture.labels.filter((label) => !named.has(label.id)).map((label) => label.id);
  if (missing.length > 0) {
    problems.push(
      `${missing.length} of ${fixture.labels.length} labels have no row in the returned file: ` +
        `${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''}`,
    );
  }
  const undecided = [...seen.values()].filter((d) => d.imageDependent === null).map((d) => d.labelId);
  if (undecided.length > 0) {
    problems.push(
      `${undecided.length} of ${fixture.labels.length} labels carry no image_dependent value: ` +
        `${undecided.slice(0, 5).join(', ')}${undecided.length > 5 ? ', …' : ''}`,
    );
  }

  const dependent = [...accepted.values()].filter((d) => d.imageDependent);
  const perPage = new Map<string, number>();
  for (const decision of dependent) {
    const page = labelById.get(decision.labelId)!.expectedFiles[0]!;
    perPage.set(page, (perPage.get(page) ?? 0) + 1);
  }
  const over = [...perPage.entries()].filter(([, n]) => n > ARM_SAMPLE.maxLabelsPerPage);
  for (const [page, n] of over) {
    problems.push(
      `page ${page} carries ${n} image-dependent labels — ${n - ARM_SAMPLE.maxLabelsPerPage} over O2/O3's cap ` +
        `of ${ARM_SAMPLE.maxLabelsPerPage}, the m the design effect (${ARM_SAMPLE.primaryDesignEffect}) is computed under`,
    );
  }

  const perClass: Record<string, number> = Object.fromEntries(IMAGE_DEPENDENT_CLASSES.map((c) => [c, 0]));
  for (const decision of dependent) perClass[decision.class!] = (perClass[decision.class!] ?? 0) + 1;

  const perLanguage: Record<string, number> = { de: 0, en: 0 };
  for (const decision of dependent) {
    const lang = labelById.get(decision.labelId)!.lang;
    perLanguage[lang] = (perLanguage[lang] ?? 0) + 1;
  }

  const imageNegative = fixture.labels.filter((label) => label.style === 'image-negative').length;
  const pages = perPage.size;
  const maxLabelsPerPage = [...perPage.values()].reduce((a, b) => Math.max(a, b), 0);

  let reducedPower: string | null = null;
  if (dependent.length < ARM_SAMPLE.imageDependentFloor) {
    shortfalls.push(
      `${dependent.length} image-dependent labels — ${distance(dependent.length, ARM_SAMPLE.imageDependentFloor)} ` +
        `(O2's hard floor) and ${distance(dependent.length, ARM_SAMPLE.imageDependent)} (O2's pre-registered N). ` +
        'Below the floor the gate decides nothing at all.',
    );
  } else if (dependent.length < ARM_SAMPLE.imageDependent) {
    reducedPower =
      `${dependent.length} image-dependent labels is at or above O2's hard floor of ${ARM_SAMPLE.imageDependentFloor} ` +
      `and ${distance(dependent.length, ARM_SAMPLE.imageDependent)}: the gate DECIDES and every figure is labelled ` +
      'REDUCED POWER.';
  }
  if (imageNegative < ARM_SAMPLE.imageNegative) {
    shortfalls.push(
      `${imageNegative} image-negative labels — ${distance(imageNegative, ARM_SAMPLE.imageNegative)} (O2). These are ` +
        'the fixture\'s `style` field, not a column in this packet: closing this needs new image-negative ' +
        'questions written against the corpus, which is the other half of O15.',
    );
  }
  if (pages < ARM_SAMPLE.minPages) {
    shortfalls.push(
      `image-dependent labels on ${pages} pages — ${distance(pages, ARM_SAMPLE.minPages)} (O2: ≥ ${ARM_SAMPLE.minPages})`,
    );
  }
  for (const control of controls) {
    if (control.queries !== ARM_SAMPLE.controlPerLanguage) {
      shortfalls.push(
        `control query set ${control.language} (${control.file}) is ${control.queries} queries, not ` +
          `O2's ${ARM_SAMPLE.controlPerLanguage} — every control report the gate reads pairs this set`,
      );
    }
  }
  const thinClasses = Object.entries(perClass).filter(([, n]) => n < MIN_ITEMS_PER_CLASS);
  if (dependent.length > 0 && thinClasses.length > 0) {
    shortfalls.push(
      `O15 asks for ≥ ${MIN_ITEMS_PER_CLASS} image-dependent labels per class; thin: ` +
        thinClasses.map(([c, n]) => `${c} ${n} (${distance(n, MIN_ITEMS_PER_CLASS)})`).join(', '),
    );
  }

  return {
    problems,
    shortfalls,
    reducedPower,
    decided: accepted.size,
    undecided: undecided.length + missing.length,
    imageDependent: dependent.length,
    imageNegative,
    pages,
    maxLabelsPerPage,
    perClass,
    perLanguage,
    controls: [...controls],
  };
}

/**
 * Write the decisions into the fixture's own JSON, on the RAW parsed object
 * rather than the schema-parsed one: `ImageFixtureLabelSchema` is not
 * `.strict()`, so a round trip through it would silently drop any field the
 * schema does not name. Every existing key keeps its place and its value; the
 * two decision keys are added once and overwritten thereafter, which is what
 * makes re-running the validator on an already-written fixture a no-op.
 */
export function applyDecisions(raw: unknown, decisions: readonly LabelDecision[]): unknown {
  const fixture = raw as { labels: Array<Record<string, unknown>> };
  const byId = new Map(decisions.map((d) => [d.labelId, d]));
  for (const label of fixture.labels) {
    const decision = byId.get(label['id'] as string);
    if (!decision || decision.imageDependent === null) continue;
    label['imageDependent'] = decision.imageDependent;
    if (decision.class === null) delete label['class'];
    else label['class'] = decision.class;
  }
  return fixture;
}

/** The fixture file's own formatting, which a round trip reproduces byte for byte. */
export function serializeFixture(raw: unknown): string {
  return `${JSON.stringify(raw, null, 2)}\n`;
}

/** Parse the written result, so the caller can hand it to `auditSample`. */
export function parseWrittenFixture(raw: unknown): ImageFixture {
  return ImageFixtureSchema.parse(raw);
}

// ---------------------------------------------------------------------------
// The header the packet ships with.
// ---------------------------------------------------------------------------

/**
 * ADR-027's own words for the two classes, quoted rather than paraphrased: the
 * labeller is deciding against the ADR, and a paraphrase in the packet is a
 * second definition that nobody reconciled with the first.
 */
export const ADR_IMAGE_DEPENDENT_QUOTE =
  'An independent labelling pass (a labeller who has seen neither the candidate\'s descriptions nor the ' +
  'retrieval code) classifies each existing label as **image-dependent** (the fact is absent from the ' +
  'surrounding prose) or not, and adds EN/DE image-dependent items across the classes the epic names — ' +
  'screenshots/error codes, charts/units, tables, directional and nearly identical diagrams, unreadable text, ' +
  'decorative images — plus new image-negative questions, until the counts under "Owner decisions" (O2, ' +
  'confirmed) are met. Labels are written from the source image, never from any model description, and never ' +
  'appear in any prompt.';

export const ADR_IMAGE_NEGATIVE_QUOTE =
  'Safety | image-negative **leakage@1** (a negative question answered from an image chunk) | paired | B vs A | ' +
  'McNemar exact against the margin';

/** The fixture schema's own sentence for what an `image-negative` label IS. */
export const FIXTURE_IMAGE_NEGATIVE_QUOTE =
  'EMPTY is legal and meaningful: an `image-negative` label is a page whose *text* is about the subject while ' +
  'none of its pictures show it, so the correct image answer is "none of them". Those labels are what keeps ' +
  '`imageHit@K` honest — without them a leg that returns an image for every query scores the same as one that ' +
  'returns the right image.';

export function packetReadme(rows: readonly PacketRow[], fixture: ImageFixture, files: { csv: string; jsonl: string }): string {
  const negatives = fixture.labels.filter((l) => l.style === 'image-negative').length;
  const pages = new Set(fixture.labels.flatMap((l) => l.expectedFiles)).size;
  return `# O15 labelling packet — ADR-027's image-dependent classification (#1619)

Generated by \`backend/scripts/build-label-packet.ts\` from
\`backend/src/domains/llm/eval/fixture-de-images.json\` (corpus manifest
\`${fixture.corpusManifestSha.slice(0, 16)}…\`). **No value in it is a label**: the two
decision columns are empty in every one of the ${rows.length} rows, and the harness
never fills one.

- \`${files.csv}\` — one row per label, for the spreadsheet pass.
- \`${files.jsonl}\` — the same rows with the per-image detail structured.

Paths are relative to the repository root (\`${REPO_ROOT}\`).

## What you are being asked for

Two decisions per label, and nothing else:

| column | values | when |
|---|---|---|
| \`image_dependent\` | \`true\` / \`false\` | every row |
| \`class\` | ${IMAGE_DEPENDENT_CLASSES.join(' / ')} | only when \`image_dependent\` is \`true\` |

Leave both blank on a row you have not decided; the validator reports how many
are still open and refuses to write a partial pass into the fixture.

## The definitions, in ADR-027's words

**Image-dependent** — ADR-027, "Measurement plan → Corpus and labels":

> ${ADR_IMAGE_DEPENDENT_QUOTE}

**Image-negative** — ADR-027's endpoint table (the safety endpoint these labels
exist for):

> ${ADR_IMAGE_NEGATIVE_QUOTE}

…and what the fixture schema means by the \`image-negative\` style
(\`eval/fixture.ts\`, \`expectedImages\`):

> ${FIXTURE_IMAGE_NEGATIVE_QUOTE}

The ${negatives} \`image-negative\` labels already carry that style in the fixture;
this pass does not re-decide it, and the validator refuses
\`image_dependent=true\` on any label with no expected image — a question whose
correct image answer is "none of them" cannot be one the image evidence
answers.

## A worked example of each

Both are invented for this page and are NOT labels in the corpus, so that
reading them cannot pre-decide a real row.

**Image-dependent = true, class \`chart\`.** Page text: "Die Messreihe wurde
1998 abgeschlossen." Figure: a line chart whose y-axis is labelled
\`Durchfluss (m³/s)\`. Query: *"In welcher Einheit ist der Durchfluss
aufgetragen?"* The unit appears only on the axis of the picture, so a
text-only arm cannot answer it from the prose → \`true\`, \`chart\`.

**Image-dependent = false.** Same page, query: *"Wann wurde die Messreihe
abgeschlossen?"* The prose says 1998. The picture may also show it, but the
fact is in the text, so the image changes nothing → \`false\`, no class.

**Image-negative (already styled in the fixture).** Page text describes the
railway station's 1902 reception building; every picture on the page is of
the modern platforms. Query: *"Wie sah das Empfangsgebäude von 1902 aus?"* The
correct image answer is "none of them" — such a label ships as
\`style: image-negative\` with an empty \`expectedImages\`, and it must stay
\`image_dependent=false\`.

## The counts your pass has to reach (ADR-027 O2/O3/O15)

- **${ARM_SAMPLE.imageDependent} image-dependent labels**, hard floor **${ARM_SAMPLE.imageDependentFloor}**. Below the floor the gate
  decides nothing; ${ARM_SAMPLE.imageDependentFloor}–${ARM_SAMPLE.imageDependent - 1} decides and is labelled REDUCED POWER.
- **≤ ${ARM_SAMPLE.maxLabelsPerPage} image-dependent labels per page** and **≥ ${ARM_SAMPLE.minPages} distinct pages** — the m and ρ the
  design effect (${ARM_SAMPLE.primaryDesignEffect}) is computed under. The fixture carries ${pages} pages with 2–7 labels
  each, so the cap binds: on a 7-label page at most ${ARM_SAMPLE.maxLabelsPerPage} may be image-dependent.
- **≥ ${MIN_ITEMS_PER_CLASS} per class** (O15), over the ${IMAGE_DEPENDENT_CLASSES.length} classes above.
- **${ARM_SAMPLE.imageNegative} image-negative labels** (O2). The fixture has ${negatives}; the remaining ${ARM_SAMPLE.imageNegative - negatives} are new
  questions, which this packet does not collect.
- EN:DE ≈ 1:2 across the image-dependent set (O2, approximate — reported, not refused).

## Returning it

Fill the two columns, keep \`label_id\`, and hand the file back as CSV or JSONL:

\`\`\`bash
cd backend
npx tsx scripts/validate-label-packet.ts --file <your file>          # report only
npx tsx scripts/validate-label-packet.ts --file <your file> --write  # write it into the fixture
\`\`\`

The validator refuses unknown, duplicated and missing label ids, values
outside the sets above, a class without a \`true\`, a \`true\` without a class and
a \`true\` on a label with no expected image; it then reports every O2 count
with the distance still to go, and \`--write\` records the decisions in
\`fixture-de-images.json\` and prints what the gate would decide with them.
`;
}
