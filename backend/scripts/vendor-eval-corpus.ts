/**
 * #1102 — refresh the vendored eval corpus.
 *
 * The corpus is COMMITTED, not fetched at eval time: the harness has to run
 * in CI without network access, and a corpus that can shift underneath the
 * fixture would silently invalidate every labelled `query → page` pair. This
 * script exists to make the vendoring reproducible and auditable, not because
 * it runs often — expect it once per corpus refresh, followed by a re-label.
 *
 * Sources are MIT-licensed documentation for this repo's own stack, which is
 * the closest public analogue to a technical knowledge base. See
 * corpus/LICENSE-ATTRIBUTION.md for the notices this obliges us to carry.
 *
 * Usage — FULL clones, not --depth 1 (review r2): reproducing the corpus means
 * checking out the commit recorded in MANIFEST.json, and a shallow clone cannot
 * reach an older commit once upstream has moved.
 *   git clone https://github.com/fastify/fastify.git   /tmp/corpus-src/fastify
 *   git clone https://github.com/vitest-dev/vitest.git /tmp/corpus-src/vitest
 *   git clone https://github.com/vitejs/vite.git       /tmp/corpus-src/vite
 *   npx tsx scripts/vendor-eval-corpus.ts /tmp/corpus-src          # reproduce the pins
 *   npx tsx scripts/vendor-eval-corpus.ts /tmp/corpus-src --update # move to HEAD (obliges a re-label)
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

interface Source {
  /** Directory name under the clone root, and the corpus filename prefix. */
  name: string;
  repo: string;
  /** Doc subtree to take, relative to the clone root. */
  docs: string;
  /** Subdirectories of `docs` to skip — assets, translations, changelogs. */
  skip: string[];
}

const SOURCES: Source[] = [
  { name: 'fastify', repo: 'https://github.com/fastify/fastify', docs: 'docs', skip: ['public'] },
  { name: 'vitest', repo: 'https://github.com/vitest-dev/vitest', docs: 'docs', skip: ['public', 'blog', '.vitepress'] },
  { name: 'vite', repo: 'https://github.com/vitejs/vite', docs: 'docs', skip: ['public', 'blog', '.vitepress'] },
];

const OUT_DIR = resolve(import.meta.dirname, '../src/domains/llm/eval/corpus');
const ATTRIBUTION_FILE = 'LICENSE-ATTRIBUTION.md';
/** Below this a "page" is a stub (a redirect or a nav index) and only adds noise. */
const MIN_CHARS = 500;

function walk(dir: string, skip: string[], root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = relative(root, full);
    if (skip.some((s) => rel === s || rel.startsWith(`${s}/`))) continue;
    if (statSync(full).isDirectory()) out.push(...walk(full, skip, root));
    else if (entry.endsWith('.md')) out.push(full);
  }
  return out;
}

/**
 * VitePress front matter is site configuration, not content — leaving it in
 * would put YAML keys into the embedding text. The `title:` key is worth
 * keeping, because it is often the only place the human-readable title lives.
 */
function stripFrontMatter(md: string): { title: string | null; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md);
  if (!match) return { title: null, body: md };
  const title = /^title:\s*(.+)$/m.exec(match[1] ?? '')?.[1]?.trim().replace(/^["']|["']$/g, '') ?? null;
  return { title, body: md.slice(match[0].length) };
}

function firstHeading(md: string): string | null {
  return /^#\s+(.+)$/m.exec(md)?.[1]?.trim() ?? null;
}

const cloneRoot = process.argv[2];
if (!cloneRoot) {
  console.error('usage: vendor-eval-corpus.ts <clone-root>');
  process.exit(1);
}

// Honour the recorded pins when a manifest is already present, so a refresh
// REPRODUCES the corpus instead of silently taking whatever the default branch
// happens to be today (review r1 — the attribution claimed reproducibility the
// script did not deliver). Pass --update to deliberately move to the clones'
// current HEADs, which then obliges a re-label.
//
// Read BEFORE the wipe below (review r2): the manifest lives inside OUT_DIR,
// so reading it afterwards found nothing, every pin was undefined, and the
// checkout was dead code while three documents claimed otherwise.
const pinnedCommits = new Map<string, string>();
if (!process.argv.includes('--update') && existsSync(join(OUT_DIR, 'MANIFEST.json'))) {
  const previous = JSON.parse(readFileSync(join(OUT_DIR, 'MANIFEST.json'), 'utf8')) as { pages: Array<{ source: string; commit: string }> };
  for (const page of previous.pages) pinnedCommits.set(page.source, page.commit);
}

if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

const manifest: Array<{ file: string; title: string; source: string; repo: string; commit: string; path: string; license: string }> = [];

const notices: string[] = [];

for (const source of SOURCES) {
  const root = join(cloneRoot, source.name);
  const pin = pinnedCommits.get(source.name);
  if (pin) {
    // Fails loudly on a shallow clone that lacks the pinned commit, which is
    // better than vendoring a different corpus under the same manifest.
    execFileSync('git', ['-C', root, 'checkout', '--quiet', pin], { stdio: 'inherit' });
  }
  const commit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  notices.push(`\n---\n\n## ${source.name} — ${source.repo}\n\n\`\`\`\n${readFileSync(join(root, 'LICENSE'), 'utf8').trim()}\n\`\`\`\n`);
  const docsRoot = join(root, source.docs);

  for (const file of walk(docsRoot, source.skip, docsRoot).sort()) {
    const raw = readFileSync(file, 'utf8');
    const { title: fmTitle, body } = stripFrontMatter(raw);
    if (body.trim().length < MIN_CHARS) continue;

    const relPath = relative(root, file);
    const title = fmTitle ?? firstHeading(body) ?? relPath;
    // Flat filenames: the corpus is a bag of pages, and a nested tree would
    // imply a hierarchy the fixture does not model.
    const name = `${source.name}__${relative(docsRoot, file).replace(/[/\\]/g, '__')}`;
    writeFileSync(join(OUT_DIR, name), body.trimStart());
    manifest.push({ file: name, title, source: source.name, repo: source.repo, commit, path: relPath, license: 'MIT' });
  }
}

writeFileSync(join(OUT_DIR, 'MANIFEST.json'), `${JSON.stringify({ generatedBy: 'scripts/vendor-eval-corpus.ts', pages: manifest }, null, 2)}\n`);

// Regenerated, never assumed to survive: this script wipes OUT_DIR, and the
// attribution lives inside it. Leaving it to a committed file meant the
// documented refresh silently deleted the MIT notices the corpus is obliged
// to carry (review r1).
writeFileSync(
  join(OUT_DIR, ATTRIBUTION_FILE),
  `# Vendored eval corpus — third-party notices

The markdown files in this directory are **verbatim copies of third-party
documentation**, vendored for #1102's retrieval eval harness. They are test
fixtures: nothing here is Compendiq's own documentation, and nothing here ships
in the product.

They are committed rather than fetched because the harness must run in CI
without network access, and because a corpus that could shift underneath the
fixture would silently invalidate every labelled \`query → page\` pair. Each
page's upstream repository, path and **pinned commit** are recorded in
\`MANIFEST.json\`, and \`backend/scripts/vendor-eval-corpus.ts\` checks those
commits out on a re-run, so it reproduces this directory rather than tracking
the default branch. Pass \`--update\` to move to current HEADs — which obliges
a re-label, because the fixture records the manifest hash it was written
against.

All three sources are MIT licensed. Their notices follow in full, as the
licence requires.
${notices.join('')}`,
);
console.log(`vendored ${manifest.length} pages from ${SOURCES.length} sources`);
