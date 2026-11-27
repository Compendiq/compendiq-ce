/**
 * Capture what the AI Improve chain produced at #1954 slice A for linked inline code.
 *
 * Coordinator decision D24: slice B (inline code that a link may hold) changes
 * nothing on the AI Improve chain, so for every input it must produce slice A's
 * Markdown and applied HTML. This script records slice A's output for the
 * inputs D24 names, so the parity test can compare B against it.
 *
 * It refuses to run anywhere but a clean checkout of slice A's head:
 *
 *   git worktree add /tmp/compendiq-1954-a 42e0755328abd4fe41edea7bc0a82cb6b71a21ca
 *   cp backend/scripts/capture-improve-parity-1954.ts /tmp/compendiq-1954-a/backend/scripts/
 *   cd /tmp/compendiq-1954-a && npm ci && cd backend
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

async function main(): Promise<void> {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain', '--', 'backend/src', 'packages'], { encoding: 'utf8' }).trim();
  if (head !== SLICE_A || dirty) {
    throw new Error(`capture only on a clean ${SLICE_A} checkout (HEAD ${head}${dirty ? ', dirty' : ''})`);
  }
  const captured: Record<string, { html: string; markdown: string; applied: string }> = {};
  for (const { name, storage } of cases()) {
    // The Improve route's steps: the page's HTML, protected, as Markdown with layout tokens; the model echoes it;
    // Accept re-protects the same HTML, converts the Markdown back and restores the media.
    const html = confluenceToHtml(storage, '55');
    const { html: protectedHtml, media } = protectMedia(html);
    const markdown = htmlToMarkdown(protectedHtml, { layoutTokens: true });
    const back = await markdownToHtml(markdown, { layoutSkeleton: extractLayoutSkeleton(protectedHtml), protectedMedia: media });
    captured[name] = { html, markdown, applied: restoreMedia(back, media) };
  }
  process.stdout.write([
    '/**',
    ` * The AI Improve chain's output at #1954 slice A (${SLICE_A}), captured by`,
    ' * backend/scripts/capture-improve-parity-1954.ts. Never regenerate from a later commit (D24).',
    ' */',
    `export const IMPROVE_PARITY_COMMIT = '${SLICE_A}';`,
    '',
    `export const IMPROVE_PARITY_STORAGE: Record<string, string> = ${JSON.stringify(Object.fromEntries(cases().map((c) => [c.name, c.storage])), null, 2)};`,
    '',
    `export const IMPROVE_PARITY_AT_A: Record<string, { html: string; markdown: string; applied: string }> = ${JSON.stringify(captured, null, 2)};`,
    '',
  ].join('\n'));
}

await main();
