/**
 * #1619 — the O15 labelling packet (ADR-027 "Corpus and labels", O15).
 *
 *   npx tsx scripts/build-label-packet.ts --out-dir artifacts/
 *
 * Writes `label-packet.csv`, `label-packet.jsonl` and `label-packet.md`: every
 * one of the shipped image fixture's labels with the query, the page it is
 * labelled against, that page's pictures (each with the attachment key it is
 * scored under and the file it is on disk) and whatever `expectedImages`
 * already says — plus the two EMPTY columns the independent labelling pass
 * fills, `image_dependent` and `class`.
 *
 * **It writes no decision.** The gate's primary endpoint runs on the
 * image-dependent labels, and inventing one here would be the harness deciding
 * its own sample; the script asserts that every row it is about to write is
 * blank in both columns. The filled file goes back through
 * `scripts/validate-label-packet.ts`, which is the only thing that may put a
 * value into `fixture-de-images.json`.
 *
 * No database, no model, no network: it reads the fixture and the manifest and
 * writes three files.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertKnownFlags,
  flagValue,
  wantsHelp,
  LABEL_PACKET_KNOWN_FLAGS,
  LABEL_PACKET_USAGE,
  LABEL_PACKET_VALUELESS_FLAGS,
} from '../src/domains/llm/eval/cli-flags.js';
import { IMAGE_CORPUS_DIR, loadImageCorpusManifest } from '../src/domains/llm/eval/corpus-images.js';
import { loadImageFixture } from '../src/domains/llm/eval/fixture.js';
import {
  buildLabelPacket,
  packetCsv,
  packetJsonl,
  packetReadme,
} from '../src/domains/llm/eval/label-packet.js';

function main(): void {
  if (wantsHelp(process.argv.slice(2))) {
    console.log(LABEL_PACKET_USAGE);
    return;
  }
  assertKnownFlags(process.argv.slice(2), LABEL_PACKET_KNOWN_FLAGS, LABEL_PACKET_USAGE, LABEL_PACKET_VALUELESS_FLAGS);

  const outDir = flagValue(process.argv, 'out-dir') ?? '.';
  // `loadImageFixture` is the same loader the gate uses, so a packet can only
  // be written for a fixture that still matches the corpus it was labelled
  // against — the labeller must never be sent a page or an image that moved.
  const fixture = loadImageFixture();
  const manifest = loadImageCorpusManifest(IMAGE_CORPUS_DIR);
  const rows = buildLabelPacket(fixture, manifest);

  if (rows.length !== fixture.labels.length) {
    throw new Error(`packet covers ${rows.length} of ${fixture.labels.length} labels — it must cover every one`);
  }
  const prefilled = rows.filter((row) => row.imageDependent !== '' || row.class !== '');
  if (prefilled.length > 0) {
    throw new Error(
      `${prefilled.length} packet row(s) carry a decision (${prefilled.slice(0, 3).map((r) => r.labelId).join(', ')}) — ` +
        'the packet is the question, never the answer: O15 is an independent human pass',
    );
  }

  mkdirSync(outDir, { recursive: true });
  const files = {
    csv: join(outDir, 'label-packet.csv'),
    jsonl: join(outDir, 'label-packet.jsonl'),
    readme: join(outDir, 'label-packet.md'),
  };
  writeFileSync(files.csv, packetCsv(rows));
  writeFileSync(files.jsonl, packetJsonl(rows));
  writeFileSync(files.readme, packetReadme(rows, fixture, files));

  const negatives = fixture.labels.filter((label) => label.style === 'image-negative').length;
  const pages = new Set(fixture.labels.flatMap((label) => label.expectedFiles)).size;
  const images = new Set(rows.flatMap((row) => row.images.map((image) => image.file))).size;
  console.log(`packet: ${rows.length} labels (${negatives} image-negative), ${pages} pages, ${images} images`);
  console.log(`  ${files.csv}\n  ${files.jsonl}\n  ${files.readme}`);
  console.log('image_dependent and class are EMPTY on every row — O15 fills them, nothing here does.');
  console.log(`return it with: npx tsx scripts/validate-label-packet.ts --file ${files.csv} --write`);
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
}
