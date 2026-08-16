/**
 * Assemble a translated corpus into the MANIFEST + fixture the eval loader
 * expects (#1114).
 *
 * The translation itself produces loose parts: one `.md` per page under
 * `corpus-<lang>/`, a file→title map, and an id→query map. This turns them
 * into `corpus-<lang>/MANIFEST.json` and `fixture-<lang>.json`, and refuses
 * to write either unless the whole set is consistent.
 *
 * The refusals are the point. A translated corpus fails QUIETLY: a missing
 * page is a missing distractor, a dropped label changes N, and a duplicated
 * query merges two test items — none of which throws anything, and all of
 * which change the number the eval prints. So every one of them is a hard
 * error here rather than a warning, and nothing is written when any fires.
 *
 * Usage:
 *   npx tsx scripts/assemble-translated-corpus.ts --lang de \
 *     --titles /tmp/titles-de.json --queries /tmp/queries-de.json
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { computeCorpusManifestSha } from '../src/domains/llm/eval/fixture.js';

const EVAL_DIR = join(import.meta.dirname, '..', 'src', 'domains', 'llm', 'eval');
const SOURCE_DIRS = ['corpus', 'corpus-synthetic'].map((d) => join(EVAL_DIR, d));

function arg(name: string, fallback?: string): string {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  if (eq) return eq;
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1]!;
  if (fallback !== undefined) return fallback;
  throw new Error(`missing --${name}`);
}

interface ManifestEntry { file: string; title: string; [k: string]: unknown }
interface FixtureLabel { id: string; query: string; expectedFiles: string[]; [k: string]: unknown }

const lang = arg('lang', 'de');
const outDir = join(EVAL_DIR, `corpus-${lang}`);
const titles = JSON.parse(readFileSync(arg('titles'), 'utf8')) as Record<string, string>;
const queries = JSON.parse(readFileSync(arg('queries'), 'utf8')) as Record<string, string>;

const problems: string[] = [];

// ── pages ────────────────────────────────────────────────────────────────────
const sourceEntries: ManifestEntry[] = SOURCE_DIRS.flatMap(
  (dir) => (JSON.parse(readFileSync(join(dir, 'MANIFEST.json'), 'utf8')) as { pages: ManifestEntry[] }).pages,
);

const pages: ManifestEntry[] = [];
for (const entry of sourceEntries) {
  const translated = join(outDir, entry.file);
  if (!existsSync(translated)) {
    problems.push(`page not translated: ${entry.file}`);
    continue;
  }
  if (!readFileSync(translated, 'utf8').trim()) {
    // Empty output is the reasoning-model failure; it must never reach a run.
    problems.push(`page translated to an EMPTY file: ${entry.file}`);
    continue;
  }
  const title = titles[entry.file];
  if (!title || !title.trim()) {
    problems.push(`no translated title for: ${entry.file}`);
    continue;
  }
  pages.push({ ...entry, title });
}

// A file on disk that no manifest lists would be seeded by nobody and is dead
// weight; the reverse (listed, absent) is caught above.
const listed = new Set(sourceEntries.map((e) => e.file));
for (const f of readdirSync(outDir)) {
  if (f.endsWith('.md') && !listed.has(f)) problems.push(`translated file not in any source manifest: ${f}`);
}

// ── labels ───────────────────────────────────────────────────────────────────
const srcFixture = JSON.parse(readFileSync(join(EVAL_DIR, 'fixture.json'), 'utf8')) as {
  labels: FixtureLabel[]; labeledBy?: string;
};

const labels: FixtureLabel[] = [];
const seen = new Map<string, string>();
for (const label of srcFixture.labels) {
  const q = queries[label.id];
  if (!q || !q.trim()) { problems.push(`no translated query for label: ${label.id}`); continue; }
  const key = q.trim().toLowerCase().replace(/\s+/g, ' ');
  const prev = seen.get(key);
  if (prev) {
    // Two distinct English queries collapsed onto one German string. The
    // fixture loader rejects this much later with no hint of the cause.
    problems.push(`labels ${prev} and ${label.id} translated to the same query: "${q}"`);
    continue;
  }
  seen.set(key, label.id);
  // expectedFiles / id / style carry across untouched: the German run scores
  // the SAME relevance judgements, so a difference is the language and not a
  // re-labelling.
  labels.push({ ...label, query: q, queryEn: label.query });
}

if (labels.length !== srcFixture.labels.length) {
  problems.push(`label count changed: ${srcFixture.labels.length} -> ${labels.length}; N is what the statistical gate is sized against`);
}

if (problems.length) {
  console.error(`Refusing to assemble — ${problems.length} problem(s):`);
  for (const p of problems.slice(0, 40)) console.error(`  ${p}`);
  if (problems.length > 40) console.error(`  … and ${problems.length - 40} more`);
  process.exit(1);
}

writeFileSync(
  join(outDir, 'MANIFEST.json'),
  JSON.stringify({
    generatedBy: `scripts/assemble-translated-corpus.ts --lang ${lang}`,
    purpose:
      `Translation of the English corpus, holding content constant so a model comparison varies only ` +
      `the language. A separate measurement from the English gate, never a variant of it.`,
    pages,
  }, null, 2) + '\n',
  'utf8',
);

writeFileSync(
  join(EVAL_DIR, `fixture-${lang}.json`),
  JSON.stringify({
    corpusManifestSha: computeCorpusManifestSha([outDir]),
    labeledBy: `${srcFixture.labeledBy ?? 'unknown'} + translation into ${lang}`,
    labels,
  }, null, 2) + '\n',
  'utf8',
);

console.log(`assembled ${pages.length} pages -> ${outDir}/MANIFEST.json`);
console.log(`assembled ${labels.length} labels -> fixture-${lang}.json`);
