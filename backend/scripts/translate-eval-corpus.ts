/**
 * Translate the retrieval-eval corpus and fixture into another language
 * (#1114 / #1102) so the gate can be run against the language an instance
 * actually serves, rather than only against vendored English documentation.
 *
 * Why this exists
 * ---------------
 * Every retrieval number in epic #1100 was measured on English OSS docs. An
 * instance whose pages are German is a different retrieval problem: stemming
 * and compounding change the lexical leg, and an embedding model's ranking
 * against another model is not guaranteed to survive a language change. The
 * cheapest honest way to find out is to hold the CONTENT constant and vary
 * only the language — which is what this produces.
 *
 * What it guarantees
 * ------------------
 * 1. **Code is never translated.** These are framework docs; a translated
 *    identifier is a corrupted corpus, and it would corrupt it in a way that
 *    still looks like prose. Fenced blocks are split out and re-inserted
 *    verbatim, and the prompt forbids touching inline code and identifiers.
 * 2. **Titles are translated too.** `#1107`'s pin stage matches on titles and
 *    `#1110` weighed a title leg; a German corpus with English titles would
 *    quietly measure something else.
 * 3. **Resumable.** 277 files through a local model is long enough that it
 *    will be interrupted. Each output file is written as it completes and
 *    skipped on a re-run, so progress is never lost.
 * 4. **Structure preserved.** Front-matter keys, heading levels, list markers
 *    and link targets stay; only human-readable text changes.
 *
 * What it does NOT claim
 * ----------------------
 * The output is machine-translated and reads unlike native German. That is
 * acceptable for the question it is built to answer — a RELATIVE comparison
 * between two embedding models, where both read the identical text, so any
 * translation artifact is applied equally to both arms. It is NOT evidence
 * about absolute retrieval quality on real German pages; only a sample of the
 * real corpus can give that.
 *
 * Usage
 * -----
 *   TRANSLATE_BASE_URL=http://localhost:1234/v1 \
 *   TRANSLATE_MODEL=qwen/qwen3.5-9b \
 *   npx tsx scripts/translate-eval-corpus.ts --lang de
 *
 * Never run this while a retrieval eval is in flight: a local model server
 * typically loads one model at a time, and a competing load request cancels
 * the in-flight one — which silently kills the eval mid-corpus.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { splitFences, assertUsableTranslation } from '../src/domains/llm/eval/markdown-fences.js';
import { computeCorpusManifestSha } from '../src/domains/llm/eval/fixture.js';

const EVAL_DIR = join(import.meta.dirname, '..', 'src', 'domains', 'llm', 'eval');
const SOURCE_DIRS = [join(EVAL_DIR, 'corpus'), join(EVAL_DIR, 'corpus-synthetic')];

const BASE_URL = process.env.TRANSLATE_BASE_URL ?? 'http://localhost:1234/v1';
// An INSTRUCT model, deliberately. A reasoning model (qwen3.5 here) spends the
// token budget in `reasoning_content` and returns `content: ""` — which is a
// string, so it passes every type check and writes an EMPTY document. 275 blank
// files that still look like a clean run is the worst failure this script has,
// so the model default avoids it and `chat` refuses an empty result outright.
const MODEL = process.env.TRANSLATE_MODEL ?? 'gemma-4-e4b-it-mlx';
const LANG = (process.argv.find((a) => a.startsWith('--lang='))?.split('=')[1]
  ?? (process.argv.includes('--lang') ? process.argv[process.argv.indexOf('--lang') + 1] : undefined)
  ?? 'de');

const LANGUAGE_NAMES: Record<string, string> = { de: 'German', fr: 'French', es: 'Spanish' };
const LANGUAGE_NAME = LANGUAGE_NAMES[LANG] ?? LANG;

const OUT_DIR = join(EVAL_DIR, `corpus-${LANG}`);

/** Drop the internal `__dir` marker before an entry is written to the output manifest. */
function stripDir(entry: ManifestEntry): ManifestEntry {
  const copy = { ...entry } as Record<string, unknown>;
  delete copy.__dir;
  return copy as ManifestEntry;
}

interface ManifestEntry {
  file: string;
  title: string;
  [k: string]: unknown;
}

const SYSTEM_PROMPT =
  `You are a professional technical translator. Translate the user's Markdown from English into ${LANGUAGE_NAME}.\n\n` +
  'HARD RULES:\n' +
  '- Output ONLY the translated Markdown. No preamble, no explanation, no code fences around the whole answer.\n' +
  '- Preserve Markdown structure exactly: heading levels, list markers, tables, blockquotes, link syntax.\n' +
  '- NEVER translate: inline code in backticks, identifiers, function names, CLI flags, file paths, URLs, package names, environment variables.\n' +
  '- Keep established English technical loanwords that real technical writing keeps in this language (e.g. in German: Plugin, Request, Deployment, Cluster, Hook). Do not invent calques.\n' +
  '- Preserve YAML front-matter keys verbatim; translate only their human-readable values.\n' +
  '- Keep the text length broadly similar. Do not summarise, expand, or add notes.';

const QUERY_PROMPT =
  `Translate this search query from English into ${LANGUAGE_NAME}.\n\n` +
  'HARD RULES:\n' +
  '- Output ONLY the translated query. No quotes, no explanation, no trailing punctuation that was not there.\n' +
  '- It is a SEARCH QUERY, often an ungrammatical fragment. Keep it a fragment; do not turn it into a sentence.\n' +
  '- NEVER translate identifiers, function names, flags, package names or file paths — keep them exactly as written.\n' +
  '- Keep the technical loanwords a real user of this language would type.';

async function translateQuery(text: string): Promise<string> {
  return chat(QUERY_PROMPT, text);
}

async function translate(text: string): Promise<string> {
  return chat(SYSTEM_PROMPT, text);
}

/**
 * One chat completion, with a generous timeout and bounded retries.
 *
 * Both are load-bearing for a job this long. The FIRST request to a cold
 * server pays the model load — tens of seconds for a 9B — and Node's default
 * socket read timeout is shorter than that, so without an explicit signal the
 * run dies on file 1 with `ETIMEDOUT` and nothing translated. And a single
 * transient failure anywhere in ~1400 requests would otherwise discard hours
 * of completed work, since the corpus is only resumable at file granularity.
 */
const REQUEST_TIMEOUT_MS = Number(process.env.TRANSLATE_TIMEOUT_MS ?? 600_000);
const MAX_ATTEMPTS = Number(process.env.TRANSLATE_MAX_ATTEMPTS ?? 5);

async function chat(system: string, text: string): Promise<string> {
  if (!text.trim()) return text;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: text },
          ],
          temperature: 0.2,
          max_tokens: 8192,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`translate HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const out = body.choices?.[0]?.message?.content;
      if (typeof out !== 'string') throw new Error('translate: no content in response');
      assertUsableTranslation(text, out);
      // Some models wrap the whole answer in a fence despite the instruction.
      return out.replace(/^\s*```(?:markdown|md)?\n([\s\S]*)\n```\s*$/, '$1');
    } catch (err) {
      lastErr = err;
      if (attempt === MAX_ATTEMPTS) break;
      const backoffMs = 2000 * attempt;
      console.warn(`    attempt ${attempt}/${MAX_ATTEMPTS} failed (${err instanceof Error ? err.message : String(err)}); retrying in ${backoffMs}ms`);
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  throw lastErr;
}

/** Translate one document, leaving every fenced code block untouched. */
async function translateDoc(md: string): Promise<string> {
  const parts = splitFences(md);
  const out: string[] = [];
  for (const part of parts) {
    out.push(part.code ? part.text : await translate(part.text));
  }
  return out.join('\n');
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const entries: ManifestEntry[] = [];
  for (const dir of SOURCE_DIRS) {
    const manifest = JSON.parse(readFileSync(join(dir, 'MANIFEST.json'), 'utf8')) as { pages: ManifestEntry[] };
    for (const page of manifest.pages) entries.push({ ...page, __dir: dir } as ManifestEntry);
  }

  // Fail loudly if the manifests and the disk disagree, for the same reason
  // `corpusFilesOnDisk` exists: a page translated but not listed (or listed
  // but not translated) silently changes the corpus the labels were written
  // against.
  const onDisk = new Set(
    SOURCE_DIRS.flatMap((d) => readdirSync(d).filter((f) => f.endsWith('.md') && f !== 'README.md' && f !== 'LICENSE-ATTRIBUTION.md')),
  );
  const listed = new Set(entries.map((e) => e.file));
  const missing = [...onDisk].filter((f) => !listed.has(f));
  if (missing.length) throw new Error(`On disk but not in any MANIFEST: ${missing.join(', ')}`);

  console.log(`translating ${entries.length} pages -> ${LANGUAGE_NAME} (${OUT_DIR})`);
  console.log(`model: ${MODEL} @ ${BASE_URL}\n`);

  const outPages: ManifestEntry[] = [];
  let done = 0;

  for (const entry of entries) {
    const srcDir = entry.__dir as string;
    const outFile = join(OUT_DIR, entry.file);
    const titleCache = join(OUT_DIR, `.titles.json`);

    const titles: Record<string, string> = existsSync(titleCache)
      ? JSON.parse(readFileSync(titleCache, 'utf8'))
      : {};

    if (existsSync(outFile) && titles[entry.file]) {
      done += 1;
      outPages.push({ ...stripDir(entry), title: titles[entry.file]! });
      continue;
    }

    const src = readFileSync(join(srcDir, entry.file), 'utf8');
    try {
      const translated = await translateDoc(src);
      const title = (await translate(entry.title)).trim().replace(/^#+\s*/, '');
      writeFileSync(outFile, translated, 'utf8');
      titles[entry.file] = title;
      writeFileSync(titleCache, JSON.stringify(titles, null, 2), 'utf8');
      outPages.push({ ...stripDir(entry), title });
      done += 1;
      console.log(`  [${done}/${entries.length}] ${entry.file}`);
    } catch (err) {
      console.error(`  FAILED ${entry.file}: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  writeFileSync(
    join(OUT_DIR, 'MANIFEST.json'),
    JSON.stringify(
      {
        generatedBy: `scripts/translate-eval-corpus.ts --lang ${LANG} (model: ${MODEL})`,
        purpose:
          `Machine translation of the English corpus into ${LANGUAGE_NAME}, holding content constant so a ` +
          'model comparison varies only the language. NOT evidence about absolute quality on real pages.',
        pages: outPages,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  console.log(`\ndone: ${done} pages -> ${OUT_DIR}`);

  // ── the fixture ────────────────────────────────────────────────────────────
  //
  // The labels are the experiment. `expectedFiles`, `id` and `style` are
  // carried across UNCHANGED — only the human-readable query text is
  // translated — so the German run scores the same 197 relevance judgements
  // against the same documents, and any difference is the language rather
  // than a re-labelling. `corpusManifestSha` is recomputed from the German
  // manifest, which is what stops this fixture being run against the English
  // corpus (and vice versa).
  const fixtureSrc = JSON.parse(
    readFileSync(join(EVAL_DIR, 'fixture.json'), 'utf8'),
  ) as { labels: Array<{ id: string; query: string; [k: string]: unknown }>; [k: string]: unknown };

  const outFixture = join(EVAL_DIR, `fixture-${LANG}.json`);
  const cachePath = join(OUT_DIR, '.queries.json');
  const cache: Record<string, string> = existsSync(cachePath)
    ? JSON.parse(readFileSync(cachePath, 'utf8'))
    : {};

  console.log(`\ntranslating ${fixtureSrc.labels.length} queries…`);
  const labels: Array<Record<string, unknown>> = [];
  for (const [i, label] of fixtureSrc.labels.entries()) {
    if (!cache[label.id]) {
      // Queries are short and fragment-like ("fastify decorateRequest this
      // arrow function"). Translating them with the document prompt produces
      // sentences; they must stay the way a user types them.
      cache[label.id] = (await translateQuery(label.query)).trim();
      writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf8');
      if ((i + 1) % 20 === 0) console.log(`  [${i + 1}/${fixtureSrc.labels.length}]`);
    }
    labels.push({ ...label, query: cache[label.id]!, queryEn: label.query });
  }

  // Duplicate detection is the fixture loader's job, but a translator can
  // collapse two distinct English queries onto one German string, and that
  // failure arrives as a confusing loader error much later.
  const seen = new Map<string, string>();
  const collisions: string[] = [];
  for (const l of labels) {
    const key = String(l.query).trim().toLowerCase().replace(/\s+/g, ' ');
    const prev = seen.get(key);
    if (prev) collisions.push(`${prev} + ${l.id} -> "${l.query}"`);
    else seen.set(key, String(l.id));
  }
  if (collisions.length) {
    throw new Error(
      `Translation collapsed distinct queries onto the same text; edit ${cachePath} and re-run:\n  ` +
      collisions.join('\n  '),
    );
  }

  writeFileSync(
    outFixture,
    JSON.stringify(
      {
        corpusManifestSha: computeCorpusManifestSha([OUT_DIR]),
        labeledBy: `${fixtureSrc.labeledBy ?? 'unknown'} + machine translation (${MODEL}) into ${LANGUAGE_NAME}`,
        labels,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  console.log(`fixture -> ${outFixture}`);
}

// Importable for tests without running the translation.
if (process.argv[1] && process.argv[1].endsWith('translate-eval-corpus.ts')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
