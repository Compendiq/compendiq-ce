/**
 * Capture a collaborative document under the editor schema as it was before #1954.
 *
 * #1954 changes the collaborative schema (an `href` on the image node, a Code
 * mark that coexists with Link, links joined across line breaks on the way out
 * of Yjs). Room snapshots persisted before that change must still load. This
 * script writes the fixture that proves it: a full `Y.encodeStateAsUpdate` of a
 * document seeded and then edited with the schema of `bff6d4ec`, together with
 * the HTML that schema produced from it.
 *
 * It refuses to run anywhere but a clean `bff6d4ec` checkout, because the bytes
 * it captures are only evidence when the old schema produced them:
 *
 *   git worktree add /tmp/compendiq-1954-base bff6d4ec9ec3ca08642e347d19eef51059a5a4bf
 *   cp backend/scripts/capture-collab-schema-fixture-1954.ts /tmp/compendiq-1954-base/backend/scripts/
 *   cd /tmp/compendiq-1954-base && npm ci && cd backend
 *   LOG_LEVEL=silent npx tsx scripts/capture-collab-schema-fixture-1954.ts \
 *     > <this worktree>/backend/src/core/services/__fixtures__/collab-pre-1954.ts
 *
 * The fixture is committed as captured; never regenerate it from a later commit.
 */

import { execFileSync } from 'node:child_process';
import * as Y from 'yjs';
import { applyHtmlToYDoc, yDocToHtml } from '../src/core/services/collab-schema.js';
import { confluenceToHtml } from '../src/core/services/content-converter.js';

const BASE_COMMIT = 'bff6d4ec9ec3ca08642e347d19eef51059a5a4bf';
const SCHEMA_PATH = 'backend/src/core/services/collab-schema.ts';

/** Everything #1954 touches, plus the structures a room snapshot routinely holds. */
const SOURCE_STORAGE = [
  '<p>Intro paragraph.</p>',
  // A link whose body is an image (the image is lifted out, the link is lost under the old schema).
  '<p>See <ac:link><ri:page ri:content-title="Shared Assets" /><ac:link-body><ac:image><ri:attachment ri:filename="thumbnail.png" /></ac:image></ac:link-body></ac:link> here.</p>',
  // A plain attachment image and an external image.
  '<p><ac:image ac:width="200"><ri:attachment ri:filename="diagram.png" /></ac:image></p>',
  '<p><ac:image><ri:url ri:value="https://example.com/logo.png" /></ac:image></p>',
  // A link mixing an image and text.
  '<p><ac:link><ri:page ri:content-title="Gallery" /><ac:link-body>before <ac:image><ri:attachment ri:filename="g.png" /></ac:image> after</ac:link-body></ac:link></p>',
  // A page link with a plain body, a code-bodied link and a mixed code link.
  '<p>Read <ac:link><ri:page ri:content-title="Runbook" ri:space-key="OPS" /><ac:plain-text-link-body><![CDATA[the runbook]]></ac:plain-text-link-body></ac:link>.</p>',
  '<p>Call <ac:link><ri:page ri:content-title="Runbook" ri:space-key="OPS" /><ac:link-body><code>deploy()</code></ac:link-body></ac:link> first.</p>',
  '<p>Then <ac:link><ri:page ri:content-title="Runbook" ri:space-key="OPS" /><ac:link-body>run <code>deploy()</code> now</ac:link-body></ac:link>.</p>',
  // A link around a line break, and a plain line break.
  '<p>Go <ac:link><ri:page ri:content-title="Runbook" ri:space-key="OPS" /><ac:link-body>line one<br />line two</ac:link-body></ac:link> there.</p>',
  '<p>first line<br />second line</p>',
  // Inline code, bold and a comment mark.
  '<p>Plain <code>inline()</code>, <strong>bold</strong> and <em>emphasis</em>.</p>',
  // A table with a header row.
  '<table><tbody><tr><th><p>Name</p></th><th><p>Value</p></th></tr><tr><td><p>a</p></td><td><p><code>1</code></p></td></tr></tbody></table>',
  // A task list with Confluence task ids.
  '<ac:task-list><ac:task><ac:task-id>7</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>Check the runbook</ac:task-body></ac:task>'
  + '<ac:task><ac:task-id>8</ac:task-id><ac:task-status>complete</ac:task-status><ac:task-body>Ship it</ac:task-body></ac:task></ac:task-list>',
].join('');

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

const head = git('rev-parse', 'HEAD');
if (head !== BASE_COMMIT) {
  throw new Error(`refusing to capture: HEAD is ${head}, not ${BASE_COMMIT}`);
}
if (git('status', '--porcelain', '--', '../src', '../package.json').length > 0) {
  throw new Error('refusing to capture: backend sources differ from the commit');
}
const collabSchemaBlob = git('rev-parse', `HEAD:${SCHEMA_PATH}`);

// A comment mark is editor HTML only (Confluence storage has none): add one to the seed.
const sourceHtml = confluenceToHtml(SOURCE_STORAGE, '55').replace(
  '<strong>bold</strong>',
  '<mark data-comment-id="c-1954" class="comment-mark"><strong>bold</strong></mark>',
);

const doc = new Y.Doc();
applyHtmlToYDoc(doc, sourceHtml);
// One edit as a co-editor makes it: text typed at the end of the first paragraph.
const intro = doc.getXmlFragment('default').get(0);
if (!(intro instanceof Y.XmlElement)) throw new Error('the seed must open with a paragraph');
const text = intro.get(0);
if (!(text instanceof Y.XmlText)) throw new Error('the opening paragraph must hold text');
text.insert(text.length, ' Edited in a room.');

const fixture = {
  capturedAtCommit: head,
  collabSchemaBlob,
  sourceHtml,
  docStateBase64: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64'),
  htmlAtCapture: yDocToHtml(doc),
};

process.stdout.write(
  '/**\n'
  + ' * A collaborative document captured with the editor schema of bff6d4ec, before #1954\n'
  + ' * (produced by backend/scripts/capture-collab-schema-fixture-1954.ts; never regenerate).\n'
  + ' * `htmlAtCapture` is what yDocToHtml returned for it under that schema.\n'
  + ' */\n'
  + `export const COLLAB_PRE_1954 = ${JSON.stringify(fixture, null, 2)} as const;\n`,
);
