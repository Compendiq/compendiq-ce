/**
 * Capture what reached an AI Improve prompt, and what its Accept applied, at
 * #1954 slice A for linked inline code.
 *
 * Coordinator decision D24: slice B (inline code that a link may hold) changes
 * nothing in what an AI Improve prompt holds or its Accept applies. This script
 * records slice A's output for the inputs D24 names, so the parity tests can
 * compare B against it:
 * - per input: the page HTML, the parent's Improve Markdown (layout tokens),
 *   the applied HTML of an unchanged Accept, and the plain Markdown a sub-page
 *   of the same prompt gets;
 * - one assembled prompt (assembleContextIfNeeded with sub-pages, as the Improve
 *   route calls it) over a real PostgreSQL: a parent and one child per input.
 *
 * It refuses to run anywhere but a checkout of slice A's head whose tracked
 * files (sources, manifests, lockfile) are unchanged; the untracked copy of this
 * script is allowed. It needs a test PostgreSQL in the environment (POSTGRES_*,
 * as for the backend tests) and empties its tables:
 *
 *   git worktree add --detach /tmp/compendiq-1954-a 42e0755328abd4fe41edea7bc0a82cb6b71a21ca
 *   cp backend/scripts/capture-improve-parity-1954.ts /tmp/compendiq-1954-a/backend/scripts/
 *   cd /tmp/compendiq-1954-a && npm ci && (cd packages/contracts && npm run build) && cd backend
 *   LOG_LEVEL=silent npx tsx scripts/capture-improve-parity-1954.ts \
 *     > <this worktree>/backend/src/core/services/__fixtures__/improve-parity-1954-a.ts
 *
 * The fixture is committed as captured; never regenerate it from a later commit.
 */

import { execFileSync } from 'node:child_process';
import {
  confluenceToHtml,
  extractLayoutSkeleton,
  htmlToMarkdown,
  markdownToHtml,
  protectMedia,
  restoreMedia,
} from '../src/core/services/content-converter.js';
import { query } from '../src/core/db/postgres.js';
import { assembleContextIfNeeded } from '../src/routes/llm/_helpers.js';
import { setupTestDb, teardownTestDb, truncateAllTables } from '../src/test-db-helper.js';

const SLICE_A = '42e0755328abd4fe41edea7bc0a82cb6b71a21ca';

const LINKS: Array<[string, string]> = [
  ['page', '<ri:page ri:content-title="Runbook" ri:space-key="OPS" />'],
  ['url', '<ri:url ri:value="https://example.com/z" />'],
];
const BODIES: Array<[string, string]> = [
  ['code', '<code>deploy()</code>'],
  ['mixed', 'run <code>deploy()</code> now'],
  ['backtick', 'pkg.<code>a`b &lt;em&gt;x&lt;/em&gt;</code>()'],
  ['backtick-placeholder', 'pkg.<code>a`b CQ_MEDIA_PLACEHOLDER_0</code>()'],
  ['placeholder', '<code>CQ_MEDIA_PLACEHOLDER_0</code>'],
  ['nbsp-whole', '<code>\u00a0a`b\u00a0</code>'],
  ['nbsp-inside', 'pkg.<code>\u00a0a`b\u00a0</code>()'],
];
const IMAGE = '<p>Diagram: <ac:image><ri:attachment ri:filename="z.png" /></ac:image></p>';

/** Every input D24 names, as Confluence storage. */
function cases(): Array<{ name: string; storage: string }> {
  const out: Array<{ name: string; storage: string }> = [];
  for (const [linkName, resource] of LINKS) {
    for (const [bodyName, body] of BODIES) {
      const link = `<ac:link>${resource}<ac:link-body>${body}</ac:link-body></ac:link>`;
      for (const image of [false, true]) {
        const prefix = image ? IMAGE : '';
        out.push({ name: `${linkName}/${bodyName}/${image ? 'image' : 'no-image'}`, storage: `${prefix}<p>Use ${link} now.</p>` });
        out.push({
          name: `${linkName}/${bodyName}/${image ? 'image' : 'no-image'}/table`,
          storage: `${prefix}<table><tbody><tr><td><p>Use ${link} now.</p></td></tr></tbody></table>`,
        });
      }
    }
  }
  return out;
}

/** The assembled prompt's pages: the parent is the reviewer's case, one child per input that holds the image. */
const ASSEMBLED_PARENT = 'page/backtick/no-image';
const assembledChildren = (): string[] => cases().map((c) => c.name).filter((name) => name.includes('/image'));

function refuseUnlessSliceA(): void {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  // Tracked files only, index and worktree, across the whole repository (sources, manifests, lockfile).
  const changed = execFileSync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim();
  if (head !== SLICE_A || changed) {
    throw new Error(`capture only on an unchanged ${SLICE_A} checkout (HEAD ${head}${changed ? `, changed:\n${changed}` : ''})`);
  }
}

async function captureAssembled(htmlOf: (name: string) => string): Promise<{ markdown: string; multiPageSuffix: string }> {
  await setupTestDb();
  try {
    await truncateAllTables();
    const user = await query<{ id: string }>(
      "INSERT INTO users (username, email, password_hash, role) VALUES ('parity-1954', 'parity@test', 'x', 'user') RETURNING id",
    );
    const caller = user.rows[0]!.id;
    const insert = async (title: string, parentId: string | null, html: string): Promise<number> => {
      const page = await query<{ id: number }>(
        `INSERT INTO pages (title, source, visibility, space_key, confluence_id, parent_id,
                            body_text, body_storage, body_html, embedding_dirty, created_by_user_id)
         VALUES ($1, 'standalone', 'shared', NULL, NULL, $2, $1, '', $3, FALSE, $4) RETURNING id`,
        [title, parentId, html, caller],
      );
      return page.rows[0]!.id;
    };
    const parent = await insert('Parent', null, htmlOf(ASSEMBLED_PARENT));
    for (const [index, name] of assembledChildren().entries()) {
      await insert(`Child ${String(index + 1).padStart(2, '0')} ${name}`, String(parent), htmlOf(name));
    }
    const assembled = await assembleContextIfNeeded(caller, String(parent), htmlOf(ASSEMBLED_PARENT), true, {
      protectMedia: true, layoutTokens: true,
    });
    await truncateAllTables();
    return { markdown: assembled.markdown, multiPageSuffix: assembled.multiPageSuffix };
  } finally {
    await teardownTestDb();
  }
}

async function main(): Promise<void> {
  refuseUnlessSliceA();
  const captured: Record<string, { html: string; markdown: string; applied: string; plain: string }> = {};
  for (const { name, storage } of cases()) {
    // The Improve route's steps: the page's HTML, protected, as Markdown with layout tokens; the model echoes it;
    // Accept re-protects the same HTML, converts the Markdown back and restores the media. A sub-page of the same
    // prompt is converted without options.
    const html = confluenceToHtml(storage, '55');
    const { html: protectedHtml, media } = protectMedia(html);
    const markdown = htmlToMarkdown(protectedHtml, { layoutTokens: true });
    const back = await markdownToHtml(markdown, { layoutSkeleton: extractLayoutSkeleton(protectedHtml), protectedMedia: media });
    captured[name] = { html, markdown, applied: restoreMedia(back, media), plain: htmlToMarkdown(html) };
  }
  const assembled = await captureAssembled((name) => captured[name]!.html);
  process.stdout.write([
    '/**',
    ` * What reached an AI Improve prompt, and what its Accept applied, at #1954 slice A (${SLICE_A}),`,
    ' * captured by backend/scripts/capture-improve-parity-1954.ts. Never regenerate from a later commit (D24).',
    ' */',
    `export const IMPROVE_PARITY_COMMIT = '${SLICE_A}';`,
    '',
    `export const IMPROVE_PARITY_STORAGE: Record<string, string> = ${JSON.stringify(Object.fromEntries(cases().map((c) => [c.name, c.storage])), null, 2)};`,
    '',
    `export const IMPROVE_PARITY_AT_A: Record<string, { html: string; markdown: string; applied: string; plain: string }> = ${JSON.stringify(captured, null, 2)};`,
    '',
    '/** One Improve prompt with sub-pages: the parent case and one child per case, in insertion order. */',
    `export const IMPROVE_PARITY_ASSEMBLED_AT_A = ${JSON.stringify({ parent: ASSEMBLED_PARENT, children: assembledChildren(), ...assembled }, null, 2)};`,
    '',
  ].join('\n'));
}

await main();
