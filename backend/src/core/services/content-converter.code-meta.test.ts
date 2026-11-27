/**
 * #1958: a code block's title and options (`data-title` / `data-macro-params`)
 * survive AI Improve through the CODE-META echo token, bound to the
 * pre-Improve body on exact identity only, and the written storage is the
 * authority: every code macro in it must be in the writer's shape and
 * accounted for by the page.
 *
 * `improveChain` runs the Accept order of llm-conversations.ts without a model
 * call. Storage assertions read the string through the independent XML oracle
 * (`__fixtures__/storage-oracle.ts`), never through the reader under test.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
import { Marked } from 'marked';
import {
  admitLegacyCodeMetadata,
  assertCodeMacroStorage as assertCodeMacroStorageUnderTest,
  assertLocalCodeMacroProjections,
  beginCodeMetaAccept,
  codeBlockElements,
  CODE_META_ATTRS_MAX,
  CODE_META_PARAMS_MAX_BYTES,
  CODE_META_PARAMS_MAX_ENTRIES,
  CODE_META_TITLE_MAX,
  CODE_META_VALUE_MAX,
  confluenceToHtml,
  encodeCodeMetaAttrs,
  extractCodeMetaSkeleton,
  extractLayoutSkeleton,
  finalizeCodeMetadata,
  htmlToConfluence,
  htmlToMarkdown,
  htmlToText,
  ImproveCodePlacementError,
  ImproveReplayBudgetError,
  ImproveReplayError,
  ImproveSuggestionFormatError,
  isCodeMetaTitle,
  isDroppingContext,
  judgeCodeMacros,
  markdownToHtml,
  parseCodeMacroParams,
  parseCodeMetaAttrs,
  projectSourceCodeText,
  protectMedia,
  readCodeMacroInventory,
  replayProtectedMedia,
  restoreMedia,
  type CodeMacroAllowance,
  type FinalizedCodeMetadata,
  type HtmlToConfluenceOptions,
  type ImproveSuggestionProvenance,
} from './content-converter.js';
import { ConfluenceStorageRefusedError, readConfluenceStorage, STORAGE_READER_LIMITS } from './confluence-storage-reader.js';
import { oracleElements } from './__fixtures__/storage-oracle.js';
import { oracleCodeMacros, oracleCodeMacroVerdict } from './__fixtures__/code-macro-oracle.js';
import { collabExtensions, htmlToYDoc, yDocToHtml } from './collab-schema.js';
import { generateJSON } from '@tiptap/html';

/**
 * #1958 r1 CM-8, r2 CM2-7: every storage string this file judges is also judged by the independent XML oracle,
 * right here, with the same units and options: the verdict and the full records must agree. No shared state, so
 * any test run alone or in any order still compares its own storage.
 */
function expectOracleAgreement(storage: string, units: readonly string[], options: HtmlToConfluenceOptions): void {
  const oracle = oracleCodeMacros(storage);
  if (!oracle.ok && oracle.reason === 'unreadable') {
    // A string the oracle cannot read: the production judgement refuses it whenever it may hold a macro.
    if (/<[^<> \t\r\n/]*macro[ \t\r\n\f/>]/i.test(storage)) expect(refusal(() => readCodeMacroInventory(storage)), storage).not.toBeNull();
    return;
  }
  const production = ((): { records: string[]; bareKeys: string[] } | string => {
    try {
      return readCodeMacroInventory(storage);
    } catch (error) {
      if (error instanceof ConfluenceStorageRefusedError) return error.reason;
      throw error;
    }
  })();
  if (oracle.ok) expect(production, storage).toEqual({ records: oracle.records, bareKeys: oracle.bareKeys });
  else expect(production, storage).toBe(oracle.reason);
  const reference = units.length === 0 ? '' : htmlToConfluence(units.join('\n'), options);
  const allowance = allowanceOf('');
  (allowance.units as string[]).push(...units);
  const verdict = refusal(() => assertCodeMacroStorageUnderTest(storage, allowance, options)) ?? 'pass';
  expect(verdict, storage).toBe(oracleCodeMacroVerdict(storage, reference));
}

function assertCodeMacroStorage(storage: string, allowance: CodeMacroAllowance, options: HtmlToConfluenceOptions = {}): void {
  expectOracleAgreement(storage, [...allowance.units], options);
  assertCodeMacroStorageUnderTest(storage, allowance, options);
}

const LINENUMBERS = '{&quot;linenumbers&quot;:&quot;true&quot;}';
const TITLED = ` data-title="Startup.cs" data-macro-params="${LINENUMBERS}"`;
const pre = (code: string, attrs = '', lang = 'js'): string =>
  `<pre${attrs}><code${lang ? ` class="language-${lang}"` : ''}>${code}</code></pre>`;
/** A titled token block: a faithful echo keeps its CODE-META line, the structural evidence of the #1958 path (D25 1(a)). */
const ANCHOR = pre('anchor()', ' data-title="Anchor"');

interface OracleMacro {
  language: string | null;
  title: string | null;
  params: Record<string, string>;
  code: string | null;
}

/** Every code macro of `storage` in document order, read by the independent XML oracle. */
function codeMacros(storage: string): OracleMacro[] {
  return oracleElements(storage, 'ac', 'structured-macro')
    .filter((macro) => macro.getAttribute('ac:name') === 'code')
    .map((macro) => {
      const result: OracleMacro = { language: null, title: null, params: {}, code: null };
      for (const child of Array.from(macro.children)) {
        if (child.localName === 'plain-text-body') result.code = child.textContent;
        if (child.localName !== 'parameter') continue;
        const name = child.getAttribute('ac:name')!;
        if (name === 'language') result.language = child.textContent;
        else if (name === 'title') result.title = child.textContent;
        else result.params[name] = child.textContent ?? '';
      }
      return result;
    });
}

interface Chain extends FinalizedCodeMetadata {
  markdown: string;
  storage: string;
  dropped: number;
}

/**
 * The Accept of llm-conversations.ts on `bodyHtml`, with `edit` standing in for the model. `provenance` is what
 * the route reads from the matched row (D26): by default a row the #1958 generator wrote.
 */
async function improveChain(
  bodyHtml: string,
  edit: (markdown: string) => string = (markdown) => markdown,
  options: { witnesses?: boolean; previousStorage?: string | null; replayBudget?: number; provenance?: ImproveSuggestionProvenance } = {},
): Promise<Chain> {
  const protectedBody = protectMedia(bodyHtml);
  const markdown = htmlToMarkdown(protectedBody.html, { layoutTokens: true });
  const codeMeta = beginCodeMetaAccept(protectedBody, { witnesses: options.witnesses, provenance: options.provenance ?? 'code-meta' });
  const rebuilt = await markdownToHtml(edit(markdown), {
    layoutSkeleton: extractLayoutSkeleton(protectedBody.html), protectedMedia: protectedBody.media, codeMeta,
  });
  const replay = replayProtectedMedia(rebuilt, codeMeta, { replayBudget: options.replayBudget });
  const finalized = finalizeCodeMetadata(replay.html, codeMeta);
  const storage = htmlToConfluence(finalized.html, { previousStorage: options.previousStorage });
  assertCodeMacroStorage(storage, finalized.allowance, { previousStorage: options.previousStorage });
  return { ...finalized, markdown, storage, dropped: replay.dropped };
}

/** What the #1955 head did on Accept: restoreMedia plus the `includes` drop guard. */
async function headChain(bodyHtml: string, edit: (markdown: string) => string = (markdown) => markdown): Promise<string> {
  const { html, media } = protectMedia(bodyHtml);
  let out = restoreMedia(
    await markdownToHtml(edit(htmlToMarkdown(html, { layoutTokens: true })), {
      layoutSkeleton: extractLayoutSkeleton(html), protectedMedia: media,
    }),
    media,
  );
  const dropped = media.filter((entry) => !out.includes(entry.html));
  if (dropped.length > 0) out += dropped.map((entry) => entry.html).join('\n');
  return out;
}

/** An allowance whose trusted units are exactly `units` (as finalizeCodeMetadata would build them). */
function allowanceOf(html: string): CodeMacroAllowance {
  const protectedBody = protectMedia('');
  const codeMeta = beginCodeMetaAccept(protectedBody);
  const finalized = finalizeCodeMetadata('', codeMeta);
  (finalized.allowance.units as string[]).push(...(html ? [html] : []));
  return finalized.allowance;
}

function refusal(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    if (error instanceof ConfluenceStorageRefusedError) return error.reason;
    throw error;
  }
}

async function asyncRefusal(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    if (error instanceof ConfluenceStorageRefusedError) return error.reason;
    throw error;
  }
}

function judge(storage: string, allowance: CodeMacroAllowance, work?: number): string | null {
  if (work === undefined) expectOracleAgreement(storage, [...allowance.units], {});
  const read = readConfluenceStorage(storage);
  if (!read.ok) return read.reason;
  return refusal(() => judgeCodeMacros(read.tree, allowance, {}, work));
}

const M = (inner: string, open = '<ac:structured-macro ac:name="code">', close = '</ac:structured-macro>'): string =>
  `${open}${inner}${close}`;
const BODY = (code: string): string => `<ac:plain-text-body><![CDATA[${code}]]></ac:plain-text-body>`;
const PARAM = (name: string, value: string): string => `<ac:parameter ac:name="${name}">${value}</ac:parameter>`;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('#1958 token grammar, validation and bounds', () => {
  it('validates options as a bounded JSON object of direct string values (criterion 3)', () => {
    expect(parseCodeMacroParams('{"linenumbers":"true","theme":"Midnight"}')).toEqual({ linenumbers: 'true', theme: 'Midnight' });
    expect(parseCodeMacroParams('{}')).toEqual({});
    for (const tampered of [
      'not json', '[]', '"x"', 'null', '1', '{"a":{"b":"c"}}', '{"a":["b"]}', '{"a":1}', '{"a":null}', '{"a":true}',
      '{"1a":"x"}', '{"constructor":"x"}', '{"prototype":"x"}', '{"__proto__":"x"}', '{"a b":"x"}',
      `{"${'k'.repeat(65)}":"x"}`, `{"a":"${'v'.repeat(CODE_META_VALUE_MAX + 1)}"}`, '{"a":"\\u0001"}', '{"a":"\\ud800"}',
      JSON.stringify(Object.fromEntries(Array.from({ length: CODE_META_PARAMS_MAX_ENTRIES + 1 }, (_, i) => [`k${i}`, 'v']))),
      JSON.stringify({ a: 'é'.repeat(CODE_META_PARAMS_MAX_BYTES / 2) }),
    ]) {
      expect(parseCodeMacroParams(tampered), tampered).toBeNull();
    }
    expect(parseCodeMacroParams(`{"${'k'.repeat(64)}":"${'v'.repeat(CODE_META_VALUE_MAX)}"}`)).not.toBeNull();
    expect(isCodeMetaTitle('t'.repeat(CODE_META_TITLE_MAX))).toBe(true);
    expect(isCodeMetaTitle('t'.repeat(CODE_META_TITLE_MAX + 1))).toBe(false);
    expect(isCodeMetaTitle('a\u0000b')).toBe(false);
  });

  it('encodes one canonical attribute string and parses nothing else (M6)', () => {
    const attrs = encodeCodeMetaAttrs(7, 'Start up.cs', '{"a":"b"}');
    expect(attrs).toBe('n=7 title=Start%20up%2Ecs params=%7B%22a%22%3A%22b%22%7D');
    expect(parseCodeMetaAttrs(attrs)).toEqual({ n: 7, title: 'Start up.cs', params: '{"a":"b"}' });
    expect(parseCodeMetaAttrs('n=0')).toEqual({ n: 0, title: null, params: null });
    expect(parseCodeMetaAttrs('n=0 title=')).toEqual({ n: 0, title: '', params: null });
    for (const tampered of [
      'n=00', 'n=1000', 'n=-1', 'n=1 params=%7B%7D title=x', 'n=1  title=x', 'n=1 title=%2ecs', 'n=1 title=a.b',
      'n=1 title=%E0%A4%A', 'n=1 title=x extra=y', ' n=1', `n=1 title=${'a'.repeat(CODE_META_ATTRS_MAX)}`,
    ]) {
      expect(parseCodeMetaAttrs(tampered), tampered).toBeNull();
    }
  });

  it('projects stored code to the exact text its fence lexes to', () => {
    expect(projectSourceCodeText('x', 'js')).toBe('x');
    // turndown strips one final LF and marked re-adds it on render: both lex to `x` (V3).
    expect(projectSourceCodeText('x\n', 'js')).toBe('x');
    expect(projectSourceCodeText('x\n\n', 'js')).toBe('x\n');
    expect(projectSourceCodeText('```\ninner\n```', 'md')).toBe('```\ninner\n```');
    expect(projectSourceCodeText('a\r\nb', 'js')).toBeNull();
  });
});

describe('#1958 emission and classification', () => {
  it('writes the token on the line directly above the fence; plain blocks keep turndown\'s bytes', () => {
    const html = `<p>Intro</p>${pre('const a = 1;', TITLED)}${pre('plain();')}`;
    expect(htmlToMarkdown(protectMedia(html).html, { layoutTokens: true })).toBe(
      'Intro\n\n[[[CODE-META n=0 title=Startup%2Ecs params=%7B%22linenumbers%22%3A%22true%22%7D]]]\n```js\nconst a = 1;\n```\n\n```js\nplain();\n```',
    );
    // Only the Improve conversion carries tokens.
    expect(htmlToMarkdown(html)).not.toContain('CODE-META');
    const plain = `<p>Intro</p>${pre('plain();')}`;
    expect(htmlToMarkdown(plain, { layoutTokens: true })).toBe(htmlToMarkdown(plain));
  });

  it.each([
    ['in a table cell', `<table><tbody><tr><td>${pre('x', TITLED)}</td></tr></tbody></table>`],
    ['draw.io', pre('name', TITLED, 'drawio')],
    ['empty', pre('', TITLED)],
    ['spaces', pre('   ', TITLED)],
    ['line feeds', pre('\n\n', TITLED)],
    ['no-break space', pre('\u00a0', TITLED)],
    ['an oversize title', pre('x', ` data-title="${'t'.repeat(CODE_META_TITLE_MAX + 1)}"`)],
    ['invalid options', pre('x', ' data-macro-params="{&quot;a&quot;:1}"')],
    ['a placeholder in its title', pre('x', ' data-title="CQ_MEDIA_PLACEHOLDER_0"')],
    ['element children', '<pre data-title="T"><code class="language-js"><span>x</span></code></pre>'],
    ['a lossy projection', pre('a&#13;b', TITLED)],
  ])('freezes an annotated block %s as one code entry; its macro keeps title and options', async (_name, html) => {
    const protectedBody = protectMedia(`<p>a</p>${html}`);
    expect(protectedBody.carried).toBe(true);
    // CM-1: never in the media ordinal space.
    expect(protectedBody.media).toEqual([]);
    expect(protectedBody.frozenCode).toHaveLength(1);
    expect(protectedBody.frozenCode[0]).toMatchObject({ token: 'CQ_CODE_PLACEHOLDER_0', code: true });
    expect(protectedBody.html).not.toContain('<pre');
    const chain = await improveChain(`<p>a</p>${html}`);
    expect(codeMacros(chain.storage)).toEqual(codeMacros(htmlToConfluence(`<p>a</p>${html}`)));
    expect(chain.html).not.toContain('data-cq-');
  });

  it('keeps a blank annotated block frozen and numbers the next token block 0 (V5)', async () => {
    const html = `${pre('\n', ' data-title="Blank"')}${pre('real();', TITLED)}`;
    const chain = await improveChain(html);
    expect(chain.markdown).toContain('[[[CODE-META n=0 title=Startup%2Ecs');
    expect(codeMacros(chain.storage)).toEqual([
      { language: 'js', title: 'Blank', params: {}, code: '\n' },
      { language: 'js', title: 'Startup.cs', params: { linenumbers: 'true' }, code: 'real();' },
    ]);
  });

  it('freezes token blocks past the first 1,000', () => {
    const html = Array.from({ length: 1001 }, (_, i) => pre(`x${i}`, ' data-title="T"')).join('');
    const protectedBody = protectMedia(html);
    expect(protectedBody.media).toEqual([]);
    expect(protectedBody.frozenCode).toHaveLength(1);
    expect(protectedBody.frozenCode[0]!.html).toContain('x1000');
    expect(htmlToMarkdown(protectedBody.html, { layoutTokens: true })).toContain('[[[CODE-META n=999 title=T]]]');
  });

  it('projects once per code block, and not at all for a page without an annotated block', () => {
    const lexer = vi.spyOn(Marked.prototype, 'lexer');
    extractCodeMetaSkeleton(`${pre('a();')}${pre('b();')}`);
    expect(lexer).not.toHaveBeenCalled();
    extractCodeMetaSkeleton(`${pre('a();', TITLED)}${pre('b();')}${pre('c();')}`);
    expect(lexer).toHaveBeenCalledTimes(3);
  });
});

describe('#1958 identity through the chain (criteria 1, 2, 4)', () => {
  const PAGE = `<p>Intro</p>${pre('const a = 1;', TITLED)}<p>Mid</p>${pre('graph TD\n  A --&gt; B', ' data-title="Flow"', 'mermaid')}`;

  it('keeps title and options on an unchanged echo, mermaid included, with stored bytes and edited prose', async () => {
    const chain = await improveChain(PAGE, (markdown) => markdown.replace('Intro', 'Introduction'));
    expect(chain.html).toBe(
      `<p>Introduction</p>\n${pre('const a = 1;', TITLED)}\n<p>Mid</p>\n${pre('graph TD\n  A --&gt; B', ' data-title="Flow"', 'mermaid')}\n`,
    );
    expect(codeMacros(chain.storage)).toEqual([
      { language: 'js', title: 'Startup.cs', params: { linenumbers: 'true' }, code: 'const a = 1;' },
      { language: 'mermaid', title: 'Flow', params: {}, code: 'graph TD\n  A --> B' },
    ]);
    expect(chain.report).toMatchObject({ bound: 2, stripped: 0, twins: 0 });
  });

  it('keeps the metadata of a block in a list item and in a quote', async () => {
    const html = `<ul><li><p>step</p>${pre('npm ci', ' data-title="Install"', 'sh')}</li></ul>`
      + `<blockquote>${pre('quoted();', TITLED)}</blockquote>`;
    const chain = await improveChain(html);
    expect(codeMacros(chain.storage)).toEqual([
      { language: 'sh', title: 'Install', params: {}, code: 'npm ci' },
      { language: 'js', title: 'Startup.cs', params: { linenumbers: 'true' }, code: 'quoted();' },
    ]);
  });

  it.each([
    ['first in an info panel', `<div class="panel-info">${pre('x()', TITLED)}<p>after</p></div>`],
    ['after a paragraph in a panel', `<div class="panel-warning"><p>before</p>${pre('x()', TITLED)}</div>`],
    ['first in an unchecked task item', `<ul data-type="taskList"><li data-type="taskItem" data-checked="false">${pre('x()', TITLED)}</li></ul>`],
    ['first in a checked task item', `<ul data-type="taskList"><li data-type="taskItem" data-checked="true">${pre('x()', TITLED)}</li></ul>`],
    ['after a paragraph in a task item', `<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>a</p>${pre('x()', TITLED)}</li></ul>`],
    ['first in an ordinary list item', `<ul><li>${pre('x()', TITLED)}</li></ul>`],
  ])('keeps title and options of a block %s on a faithful echo (review r1 CM-4)', async (_name, html) => {
    const chain = await improveChain(html);
    // The token line stands directly above its fence (a list or task marker, or a quote prefix, may open the lines).
    expect(chain.markdown).toMatch(/^(?:-\s+(?:\[[ x]\]\s+)?)?(?:>\s*)?\[\[\[CODE-META n=0 [^\n]*\]\]\]\n[>\s]*```js$/m);
    expect(codeMacros(chain.storage)).toEqual([{ language: 'js', title: 'Startup.cs', params: { linenumbers: 'true' }, code: 'x()' }]);
    expect(chain.report).toMatchObject({ bound: 1, orphan: 0, debris: 0 });
    expect(chain.storage).not.toContain('CODE-META');
  });

  it.each([
    ['unchecked', 'false', 'incomplete'],
    ['checked', 'true', 'complete'],
  ])('keeps an %s task item that opens with a titled block around that block, and what follows (r2 CM2-4)', async (_name, checked, status) => {
    const html = `<ul data-type="taskList"><li data-type="taskItem" data-checked="${checked}">${pre('run()\n\n  x', TITLED)}<p>after</p></li>`
      + '<li data-type="taskItem" data-checked="false"><p>next</p></li></ul><p>tail</p>';
    const chain = await improveChain(html);
    expect(chain.storage).toMatch(new RegExp(
      `^<ac:task-list><ac:task><ac:task-id>1</ac:task-id><ac:task-status>${status}</ac:task-status><ac:task-body>`
      + '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">js</ac:parameter><ac:parameter ac:name="title">Startup\\.cs</ac:parameter>'
      + '<ac:parameter ac:name="linenumbers">true</ac:parameter><ac:plain-text-body><!\\[CDATA\\[run\\(\\)\n\n  x\\]\\]></ac:plain-text-body></ac:structured-macro>\n'
      + '<p>after</p>\n</ac:task-body></ac:task><ac:task><ac:task-id>2</ac:task-id><ac:task-status>incomplete</ac:task-status>'
      + '<ac:task-body><p>next</p>\n</ac:task-body></ac:task></ac:task-list>\n<p>tail</p>\n$',
    ));
  });

  it('keeps a panel that opens with a titled block around that block and what follows (r2 CM2-4)', async () => {
    const chain = await improveChain(`<div class="panel-info">${pre('x()', TITLED)}<p>after</p></div><p>tail</p>`);
    expect(chain.storage).toBe('<blockquote>\n<p><strong>INFO</strong>:</p>\n'
      + '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">js</ac:parameter><ac:parameter ac:name="title">Startup.cs</ac:parameter>'
      + '<ac:parameter ac:name="linenumbers">true</ac:parameter><ac:plain-text-body><![CDATA[x()]]></ac:plain-text-body></ac:structured-macro>\n'
      + '<p>after</p>\n</blockquote>\n<p>tail</p>\n');
  });

  it('writes a panel or task item that does not open with a token block exactly as before', () => {
    for (const html of [
      `<div class="panel-info">${pre('x()')}</div>`, '<div class="panel-note"><p>[[[CODE-META n=0]]]</p></div>',
      `<ul data-type="taskList"><li data-type="taskItem" data-checked="false">${pre('x()')}</li></ul>`,
    ]) {
      expect(htmlToMarkdown(html, { layoutTokens: true }), html).toBe(htmlToMarkdown(html));
    }
  });

  it('saves edited code as written, without metadata (S5)', async () => {
    const chain = await improveChain(PAGE, (markdown) => markdown.replace('const a = 1;', 'const a = 2;'));
    expect(codeMacros(chain.storage)[0]).toEqual({ language: 'js', title: null, params: {}, code: 'const a = 2;\n' });
    expect(codeMacros(chain.storage)[1]!.title).toBe('Flow');
  });

  it('saves a terminal blank line added to the code, without metadata', async () => {
    const chain = await improveChain(PAGE, (markdown) => markdown.replace('const a = 1;\n```', 'const a = 1;\n\n```'));
    expect(codeMacros(chain.storage)[0]).toMatchObject({ title: null, code: 'const a = 1;\n' });
  });

  it('keeps metadata with blocks the model reordered together with their tokens', async () => {
    const chain = await improveChain(PAGE, (markdown) => {
      const [intro, first, mid, second] = markdown.split('\n\n');
      return [intro, mid, second, first].join('\n\n');
    });
    expect(codeMacros(chain.storage).map((macro) => [macro.title, macro.code])).toEqual([
      ['Flow', 'graph TD\n  A --> B'], ['Startup.cs', 'const a = 1;'],
    ]);
  });

  it('keeps the other block when one is deleted', async () => {
    const chain = await improveChain(PAGE, (markdown) => markdown.replace(/\[\[\[CODE-META n=0[^\n]*\n```js\nconst a = 1;\n```/, ''));
    expect(codeMacros(chain.storage).map((macro) => macro.title)).toEqual(['Flow']);
  });

  it('attaches nothing to a group the model duplicated, added to, or copied a token into (G0, G2)', async () => {
    const block = /(\[\[\[CODE-META n=0[^\n]*\n```js\nconst a = 1;\n```)/;
    const copied = await improveChain(PAGE, (markdown) => markdown.replace(block, '$1\n\n$1'));
    expect(codeMacros(copied.storage).filter((macro) => macro.language === 'js').map((macro) => macro.title)).toEqual([null, null]);
    expect(copied.report.duplicate).toBe(2);
    const added = await improveChain(PAGE, (markdown) => `${markdown}\n\n\`\`\`js\nconst a = 1;\n\`\`\``);
    expect(codeMacros(added.storage).filter((macro) => macro.language === 'js').map((macro) => macro.title)).toEqual([null, null]);
  });

  it('attaches nothing for a dropped, invented, swapped or language-changed token (G3)', async () => {
    const dropped = await improveChain(PAGE, (markdown) => markdown.replace(/\[\[\[CODE-META n=0[^\n]*\n/, ''));
    expect(codeMacros(dropped.storage)[0]!.title).toBeNull();

    const invented = await improveChain(`${pre('plain();')}`, (markdown) => `[[[CODE-META n=0 title=Evil]]]\n${markdown}`);
    expect(codeMacros(invented.storage)).toEqual([{ language: 'js', title: null, params: {}, code: 'plain();\n' }]);
    expect(invented.storage).not.toContain('CODE-META');

    const swapped = await improveChain(PAGE, (markdown) => markdown
      .replace('[[[CODE-META n=0', '[[[CODE-META n=X').replace('[[[CODE-META n=1', '[[[CODE-META n=0').replace('n=X', 'n=1'));
    expect(codeMacros(swapped.storage).map((macro) => macro.title)).toEqual([null, null]);

    const language = await improveChain(PAGE, (markdown) => markdown.replace('```js', '```ts'));
    expect(codeMacros(language.storage)[0]).toMatchObject({ language: 'ts', title: null });
  });

  it('drops a tampered or malicious echoed value instead of persisting it (criterion 3)', async () => {
    const original = /n=0 title=Startup%2Ecs params=%7B%22linenumbers%22%3A%22true%22%7D/;
    for (const forged of [
      'n=0 title=Other params=%7B%22linenumbers%22%3A%22true%22%7D',
      'n=0 title=Startup%2Ecs params=%7B%22linenumbers%22%3A%22false%22%7D',
      'n=0 title=Startup%2Ecs params=%7B%22a%22%3A%7B%22b%22%3A%22c%22%7D%7D',
      `n=0 title=Startup%2Ecs params=${encodeURIComponent(JSON.stringify({ x: 'v'.repeat(5000) }))}`,
      'n=0 title=Startup%2Ecs params=%5B%5D',
      'n=0 title=%3Cscript%3E params=%7B%22linenumbers%22%3A%22true%22%7D',
      'n=0 title=Startup%2Ecs',
    ]) {
      const chain = await improveChain(PAGE, (markdown) => markdown.replace(original, forged));
      expect(codeMacros(chain.storage)[0], forged).toEqual({ language: 'js', title: null, params: {}, code: 'const a = 1;\n' });
      expect(chain.storage).not.toMatch(/script|CODE-META/);
    }
  });

  it('binds nothing across a blank line and removes the orphaned token', async () => {
    const chain = await improveChain(PAGE, (markdown) => markdown.replace(/(\[\[\[CODE-META n=0[^\n]*)\n/, '$1\n\n'));
    expect(codeMacros(chain.storage)[0]!.title).toBeNull();
    expect(chain.report.orphan).toBe(1);
    expect(chain.html).not.toContain('CODE-META');
  });

  it('keeps an escaped token the page itself spells as text', async () => {
    const chain = await improveChain('<p>Write [[[CODE-META n=0]]] to …</p>');
    expect(chain.html).toContain('[[[CODE-META n=0]]]');
  });
});

describe('#1958 X1: twins and the final key (D11)', () => {
  it('a: a bound title beside a model-added fence that renders the same code leaves both plain', async () => {
    const chain = await improveChain(pre('x\n', ' data-title="T"'), (markdown) => `${markdown}\n\n\`\`\`js\nx\n\n\`\`\``);
    expect(codeMacros(chain.storage)).toEqual([
      { language: 'js', title: null, params: {}, code: 'x\n' },
      { language: 'js', title: null, params: {}, code: 'x\n' },
    ]);
    expect(chain.report.twins).toBe(1);
  });

  it('b: the token moved to that other fence binds nothing', async () => {
    const chain = await improveChain(pre('x\n', ' data-title="T"'), (markdown) =>
      markdown.replace('```js\nx\n```', '```js\nx\n```\n\n[[[CODE-META n=0 title=T]]]\n```js\nx\n\n```').replace(/^\[\[\[CODE-META n=0 title=T\]\]\]\n/, ''));
    expect(codeMacros(chain.storage).map((macro) => macro.title)).toEqual([null, null]);
  });

  it('c: equal blocks keep metadata only when all carry identical metadata', async () => {
    const differing = await improveChain(`${pre('x', ' data-title="A"')}${pre('x', ' data-title="B"')}`);
    expect(codeMacros(differing.storage).map((macro) => macro.title)).toEqual([null, null]);
    const identical = await improveChain(`${pre('x', TITLED)}${pre('x', TITLED)}`);
    expect(codeMacros(identical.storage).map((macro) => [macro.title, macro.params])).toEqual([
      ['Startup.cs', { linenumbers: 'true' }], ['Startup.cs', { linenumbers: 'true' }],
    ]);
  });

  it('d: a frozen annotated block with an editable twin loses its metadata and the Accept succeeds', async () => {
    // marked renders a fence `x` as `x\n`: the frozen block stored as `x\n` is its twin.
    const html = `<table><tbody><tr><td>${pre('x\n', TITLED)}</td></tr></tbody></table>${pre('x')}`;
    const chain = await improveChain(html);
    expect(codeMacros(chain.storage)).toEqual([
      { language: 'js', title: null, params: {}, code: 'x\n' },
      { language: 'js', title: null, params: {}, code: 'x\n' },
    ]);
    expect(chain.html).not.toContain('data-cq-');
  });

  it('e: the storage rule refuses a title sitting on the twin of its block, in both orders', async () => {
    const { allowance } = await improveChain(pre('x\n', ' data-title="T"'));
    const titled = M(PARAM('language', 'js') + PARAM('title', 'T') + BODY('x\n'));
    const bare = M(PARAM('language', 'js') + BODY('x\n'));
    expect(judge(`${bare}${titled}`, allowance)).toBe('unapproved-code-macro');
    expect(judge(`${titled}${bare}`, allowance)).toBe('unapproved-code-macro');
    expect(judge(titled, allowance)).toBeNull();
  });

  it('f: a unit lost in a dropping container and an equal macro made by the CDATA pass is refused; Q14 limits', async () => {
    const comment = '<!-- <ac:plain-text-body>&#45;&#45;&gt;&lt;ac:structured-macro ac:name="code"&gt;&lt;ac:parameter ac:name="language"&gt;js&lt;/ac:parameter&gt;&lt;ac:parameter ac:name="title"&gt;T&lt;/ac:parameter&gt;&lt;ac:plain-text-body&gt;&lt;![CDATA[x</ac:plain-text-body></ac:structured-macro> -->';
    const unit = pre('x', ' data-title="T"');
    expect(await asyncRefusal(() => improveChain(unit, (markdown) =>
      `<div class="figure-index">\n\n${markdown}\n\n</div>\n\n${comment}`))).toBe('unapproved-code-macro');
    // The same storage with the unit kept: one macro with that language and code and exactly the stored metadata passes (Q14).
    const allowance = allowanceOf(unit);
    const moved = htmlToConfluence(`<div class="figure-index">${unit}</div><p>a</p>${comment}`);
    expect(codeMacros(moved)).toEqual([{ language: 'js', title: 'T', params: {}, code: 'x' }]);
    expect(refusal(() => assertCodeMacroStorage(moved, allowance))).toBeNull();
    const twin = htmlToConfluence(`<div class="figure-index">${unit}</div>${pre('x')}${comment}`);
    expect(refusal(() => assertCodeMacroStorage(twin, allowance))).toBe('unapproved-code-macro');
  });

  it('g: blocks stored as `x` and `x\\n` with different titles keep theirs', async () => {
    const chain = await improveChain(`${pre('x', ' data-title="A"')}${pre('x\n', ' data-title="B"')}`);
    expect(codeMacros(chain.storage)).toEqual([
      { language: 'js', title: 'A', params: {}, code: 'x' },
      { language: 'js', title: 'B', params: {}, code: 'x\n' },
    ]);
  });

  it('Y1: refuses mixed records under one XML key, also when the units carry both', () => {
    const a = M(PARAM('language', 'js') + PARAM('title', 'A') + BODY('x'));
    const b = M(PARAM('language', 'js') + PARAM('title', 'B') + BODY('x'));
    const bare = M(PARAM('language', 'js') + BODY('x'));
    const both = allowanceOf(`${pre('x', ' data-title="A"')}\n${pre('x', ' data-title="B"')}`);
    expect(judge(`${a}${b}`, both)).toBe('unapproved-code-macro');
    expect(judge(`${b}${a}`, both)).toBe('unapproved-code-macro');
    expect(judge(`${a}${bare}`, allowanceOf(pre('x', ' data-title="A"')))).toBe('unapproved-code-macro');
    // Identical annotated duplicates pass.
    expect(judge(`${a}${a}`, allowanceOf(`${pre('x', ' data-title="A"')}\n${pre('x', ' data-title="A"')}`))).toBeNull();
  });

  it('Y1: keys that converge only in the writer and reader are one key (carried language, XML line ends)', async () => {
    // The class and a carried `language` parameter both become the macro's language.
    const html = `${pre('x', ' data-title="A"')}${pre('x', ' data-title="B" data-macro-params="{&quot;language&quot;:&quot;js&quot;}"', '')}`;
    const chain = await improveChain(html);
    // The carried `language` leaves with the stripped options; the content stays.
    expect(codeMacros(chain.storage).map((macro) => [macro.language, macro.title])).toEqual([['js', null], [null, null]]);
    // Given to the storage rule directly, the pair is refused.
    expect(judge(htmlToConfluence(html), allowanceOf(html))).toBe('unapproved-code-macro');
    // XML normalises CR LF inside CDATA: two bodies that differ only there are one key.
    const crlf = M(PARAM('language', 'js') + PARAM('title', 'A') + BODY('x\r\ny'));
    const lf = M(PARAM('language', 'js') + PARAM('title', 'B') + BODY('x\ny'));
    expect(judge(`${crlf}${lf}`, allowanceOf(`${pre('x\ny', ' data-title="A"')}\n${pre('x\ny', ' data-title="B"')}`)))
      .toBe('unapproved-code-macro');
  });
});

describe('#1958 X3: the storage rule\'s shape, namespace and bounds', () => {
  const empty = allowanceOf('');
  it.each([
    ['rebound ac prefix', `<div xmlns:ac="urn:other">${M(BODY('x'))}</div>`],
    ['alias prefix bound to the Confluence namespace', '<x:structured-macro xmlns:x="http://atlassian.com/content" x:name="code"><x:plain-text-body>x</x:plain-text-body></x:structured-macro>'],
    ['a second name-like attribute', '<ac:structured-macro ac:name="info" x:name="code" xmlns:x="urn:x"><ac:plain-text-body>x</ac:plain-text-body></ac:structured-macro>'],
    ['upper-case element', '<AC:STRUCTURED-MACRO xmlns:AC="http://atlassian.com/content" AC:NAME="code"><ac:plain-text-body>x</ac:plain-text-body></AC:STRUCTURED-MACRO>'],
    ['name " Code "', M(BODY('x'), '<ac:structured-macro ac:name=" Code ">')],
    ['an extra attribute', M(BODY('x'), '<ac:structured-macro ac:name="code" ac:macro-id="1">')],
    ['an element in a parameter', M(`<ac:parameter ac:name="language">js<b>x</b></ac:parameter>${BODY('x')}`)],
    ['an element in the body', M('<ac:plain-text-body>x<ac:parameter ac:name="title">T</ac:parameter></ac:plain-text-body>')],
    ['a parameter after the body', M(BODY('x') + PARAM('language', 'js'))],
    ['a rich body', M('<ac:rich-text-body><p>x</p></ac:rich-text-body>')],
    ['white space between children', M(` ${BODY('x')}`)],
    ['no body', M(PARAM('language', 'js'))],
    ['the old ac:macro', `<ac:macro ac:name="code">${BODY('x')}</ac:macro>`],
    ['inside style', `<style>${M(BODY('x'))}</style>`],
    ['inside template', `<template>${M(BODY('x'))}</template>`],
    ['a non-ASCII prefix (no assumption about the prefix alphabet)', '<a\u1680b:structured-macro xmlns:a\u1680b="urn:z" a\u1680b:name="code"><ac:plain-text-body>x</ac:plain-text-body></a\u1680b:structured-macro>'],
  ])('refuses %s', (_name, storage) => {
    expect(refusal(() => assertCodeMacroStorage(storage, empty))).toBe('unapproved-code-macro');
  });

  it('reads a non-ASCII QName the old prefix probe would have skipped (Y1)', () => {
    const storage = '<p>a</p><a\u1680b:structured-macro xmlns:a\u1680b="urn:z" a\u1680b:name="code"><ac:plain-text-body>x</ac:plain-text-body></a\u1680b:structured-macro>';
    expect(/<(?:[^\s<>/"'=:]*:)?(?:structured-)?macro[\s/>]/i.test(storage)).toBe(false);
    expect(refusal(() => assertCodeMacroStorage(storage, empty))).toBe('unapproved-code-macro');
  });

  it.each([
    ['the writer shape with a CDATA body', M(PARAM('language', 'js') + BODY('x'))],
    ['a bare macro inside another macro\'s rich body', `<ac:structured-macro ac:name="info"><ac:rich-text-body>${M(BODY('x'))}</ac:rich-text-body></ac:structured-macro>`],
    ['a body split around ]]>', M(PARAM('language', 'js') + '<ac:plain-text-body><![CDATA[a]]]]><![CDATA[>b]]></ac:plain-text-body>')],
    ['escaped prose', '<p>&lt;ac:structured-macro ac:name="code"&gt;</p>'],
    ['a fence whose text is macro markup', M(BODY('<ac:structured-macro ac:name="code"><ac:parameter ac:name="title">T</ac:parameter></ac:structured-macro>'))],
    ['no macro at all and not well-formed (remote base case)', '<p title="a<b">x</p>'],
  ])('passes %s', (_name, storage) => {
    expect(refusal(() => assertCodeMacroStorage(storage, empty))).toBeNull();
  });

  it('refuses an unreadable string that may hold a macro start tag on the remote exit', () => {
    expect(refusal(() => assertCodeMacroStorage(`<p title="a<b">x</p>${M(BODY('x'))}`, empty))).toBe('not-well-formed');
  });

  it('charges every element, attribute and compared character before a record is built', () => {
    const big = M(PARAM('title', 'T'.repeat(5000)) + BODY('x'));
    expect(judge(big, allowanceOf(pre('x', ` data-title="${'T'.repeat(5000)}"`, '')), 100)).toBe('unapproved-code-macro');
    expect(judge(big, allowanceOf(pre('x', ` data-title="${'T'.repeat(5000)}"`, '')))).toBeNull();
  });

  it('refuses a unit that does not reach the storage, and a record nothing accounts for', async () => {
    const { allowance, storage } = await improveChain(pre('x', ' data-title="T"'));
    expect(refusal(() => assertCodeMacroStorage('<p>gone</p>', allowance))).toBe('unapproved-code-macro');
    expect(refusal(() => assertCodeMacroStorage(storage.replace('>T<', '>U<'), allowance))).toBe('unapproved-code-macro');
    expect(refusal(() => assertCodeMacroStorage(`${storage}${storage}`, allowance))).toBe('unapproved-code-macro');
  });
});

describe('#1958 trust: model-written markup', () => {
  it('strips metadata from every raw model `pre`, whatever token stands beside it', async () => {
    for (const raw of [
      `<pre data-title="Evil" data-macro-params="{&quot;a&quot;:&quot;b&quot;}"><code class="language-js">raw()</code></pre>`,
      `<div><PRE DATA-TITLE="Evil"><code>raw()</code></PRE></div>`,
      `<p>inline <pre data-macro-params="{&quot;a&quot;:&quot;b&quot;}"><code>raw()</code></pre></p>`,
    ]) {
      for (const token of ['', '[[[CODE-META n=7 title=Evil]]]\n', '[[[CODE-META n=1 title=Startup%2Ecs params=%7B%22linenumbers%22%3A%22true%22%7D]]]\n']) {
        const chain = await improveChain(pre('kept();', TITLED), (markdown) => `${markdown}\n\n${token}${raw}\n`);
        expect(codeMacros(chain.storage), raw + token).toEqual([
          { language: 'js', title: 'Startup.cs', params: { linenumbers: 'true' }, code: 'kept();' },
          expect.objectContaining({ title: null, params: {} }),
        ]);
        expect(chain.report.stripped).toBeGreaterThan(0);
      }
    }
  });

  it('removes forged and copied markers; a copied fence marker binds nothing', async () => {
    const forged = await improveChain(pre('x', TITLED), (markdown) => `${markdown}\n\n<p data-cq-code-fence="0-0" data-cq-code-replay="x">p</p>`);
    expect(forged.html).not.toContain('data-cq-');
    expect(forged.report.forged).toBe(2);

    const protectedBody = protectMedia(pre('x', TITLED));
    const codeMeta = beginCodeMetaAccept(protectedBody);
    const rebuilt = await markdownToHtml(htmlToMarkdown(protectedBody.html, { layoutTokens: true }), { codeMeta });
    const copied = finalizeCodeMetadata(`${rebuilt}${rebuilt}`, codeMeta);
    expect(copied.html).not.toContain('data-cq-');
    expect(copied.html).not.toContain('data-title');
  });

  it.each([
    ['a panel', '<div class="panel-info" data-macro-name="code" data-macro-params="{&quot;title&quot;:&quot;x&quot;}"><p>a</p></div>'],
    ['details', '<details data-macro-name="code"><summary>s</summary><p>a</p></details>'],
    ['children', '<div class="confluence-children-macro" data-macro-name="code">[Children]</div>'],
    ['unknown', '<div class="confluence-macro-unknown" data-macro-name=" Code ">x</div>'],
    ['include', '<div class="confluence-include-macro" data-macro-name="code" data-page-title="P">x</div>'],
    ['raw canonical bare macro', '<div><ac:structured-macro ac:name="code"><ac:plain-text-body>x</ac:plain-text-body></ac:structured-macro></div>'],
    ['raw legacy macro', '<div><ac:macro ac:name="code"><ac:plain-text-body>x</ac:plain-text-body></ac:macro></div>'],
  ])('refuses a code-named %s before conversion (R2, Y2)', async (_name, markup) => {
    expect(await asyncRefusal(() => improveChain('<p>a</p>', (markdown) => `${markdown}\n\n${markup}\n`))).toBe('unapproved-code-macro');
  });

  it('refuses a model code placeholder with a large parameter object before its values reach the serializer (Y2)', async () => {
    const params = JSON.stringify(Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`p${i}`, 'v'.repeat(50)])));
    const parse = vi.spyOn(JSON, 'parse');
    const markup = `<div class="confluence-macro-unknown" data-macro-name="code" data-macro-params="${params.replace(/"/g, '&quot;')}">x</div>`;
    expect(await asyncRefusal(() => improveChain('<p>a</p>', (markdown) => `${markdown}\n\n${markup}\n`))).toBe('unapproved-code-macro');
    expect(parse.mock.calls.some(([value]) => value === params)).toBe(false);
  });

  it.each([
    ['style', '<div><style><ac:structured-macro ac:name="code"><ac:plain-text-body>x</ac:plain-text-body></ac:structured-macro></style></div>'],
    ['script', '<div><script><ac:structured-macro ac:name="code"><ac:plain-text-body>x</ac:plain-text-body></ac:structured-macro></script></div>'],
    ['iframe', '<div><iframe><ac:structured-macro ac:name="code"><ac:plain-text-body>x</ac:plain-text-body></ac:structured-macro></iframe></div>'],
    ['noframes', '<div><noframes><ac:structured-macro ac:name="code"><ac:plain-text-body>x</ac:plain-text-body></ac:structured-macro></noframes></div>'],
    ['xmp', '<div><xmp><ac:structured-macro ac:name="code"><ac:plain-text-body>x</ac:plain-text-body></ac:structured-macro></xmp></div>'],
    ['noembed', '<div><noembed><ac:structured-macro ac:name="code"><ac:plain-text-body>x</ac:plain-text-body></ac:structured-macro></noembed></div>'],
    ['template', '<div><template><ac:structured-macro ac:name="code"><ac:plain-text-body>x</ac:plain-text-body></ac:structured-macro></template></div>'],
    ['a comment the CDATA pass opens', '<!-- <ac:plain-text-body>&#45;&#45;&gt;&lt;ac:structured-macro ac:name="code"&gt;&lt;ac:parameter ac:name="title"&gt;T&lt;/ac:parameter&gt;&lt;ac:plain-text-body&gt;&lt;![CDATA[x</ac:plain-text-body></ac:structured-macro> -->'],
  ])('refuses macro text the HTML stage cannot address, in %s, on the written storage', async (_name, markup) => {
    expect(await asyncRefusal(() => improveChain('<p>a</p>', (markdown) => `${markdown}\n\n${markup}\n`))).toBe('unapproved-code-macro');
  });

  it.each([
    ['escaped prose', '<p>&lt;ac:structured-macro ac:name="code"&gt;</p>'],
    ['textarea', '<textarea><ac:structured-macro ac:name="code"></textarea>'],
    ['raw macro markup Markdown writes as text', '<ac:structured-macro ac:name="code"><ac:plain-text-body>x</ac:plain-text-body></ac:structured-macro>'],
    ['a comment without the pass', '<!-- <ac:structured-macro ac:name="code"> -->'],
    ['a fence showing macro syntax', '```xml\n<ac:structured-macro ac:name="code"><ac:parameter ac:name="title">T</ac:parameter></ac:structured-macro>\n```'],
  ])('keeps %s as data', async (_name, markup) => {
    const chain = await improveChain('<p>a</p>', (markdown) => `${markdown}\n\n${markup}\n`);
    expect(codeMacros(chain.storage).every((macro) => macro.title === null)).toBe(true);
  });

  it('R3: a page whose own body yields a code macro outside the writer\'s shape cannot Accept, on either exit', async () => {
    const legacy = '<p>a</p><div class="confluence-macro-unknown" data-macro-name="code"><p>rich body</p></div>';
    expect(await asyncRefusal(() => improveChain(legacy))).toBe('unapproved-code-macro');
    // The storage it would yield, judged directly on both exits.
    const empty = allowanceOf('');
    const storage = htmlToConfluence(legacy);
    expect(refusal(() => assertCodeMacroStorage(storage, empty))).toBe('unapproved-code-macro');
    expect(refusal(() => assertLocalCodeMacroProjections(legacy, empty, { body_storage: null }))).toBe('unapproved-code-macro');
    // An ordinary page with a bare code macro passes both.
    const ordinary = await improveChain(`<p>a</p>${pre('x()')}`);
    expect(refusal(() => assertLocalCodeMacroProjections(ordinary.html, ordinary.allowance, { body_storage: null }))).toBeNull();
  });

  it('keeps a page without annotated blocks byte-identical to the #1955 head and refuses a forged macro there', async () => {
    const page = `<p>Plain</p>${pre('plain();')}<img src="/a.png" alt="a"><p>more</p>`;
    const edit = (markdown: string): string => markdown.replace('Plain', 'Clear');
    expect((await improveChain(page, edit)).html).toBe(await headChain(page, edit));
    expect(await asyncRefusal(() => improveChain(page, (markdown) =>
      `${markdown}\n\n<div><ac:structured-macro ac:name="code"><ac:parameter ac:name="title">T</ac:parameter><ac:plain-text-body>x</ac:plain-text-body></ac:structured-macro></div>\n`)))
      .toBe('unapproved-code-macro');
  });
});

describe('#1958 media replay (V4, X4, X5)', () => {
  const IMAGE = '<img src="/api/attachments/1/a.png" alt="a">';

  it('places an image at its token and refuses a frozen code block the model dropped, instead of appending it (D26 item 3)', async () => {
    const cell = (code: string): string => `<table><tbody><tr><td>${pre(code, TITLED)}</td></tr></tbody></table>`;
    const html = `<p>x</p>${IMAGE}${cell('kept()')}${cell('frozen()')}`;
    await expect(improveChain(html, (markdown) => markdown.replace(/<table><tbody><tr><td>CQ_CODE_PLACEHOLDER_1<\/td><\/tr><\/tbody><\/table>/, '')))
      .rejects.toBeInstanceOf(ImproveCodePlacementError);
    const chain = await improveChain(html);
    expect(chain.html.match(/<img/g)).toHaveLength(1);
    expect(codeMacros(chain.storage).map((macro) => [macro.title, macro.code])).toEqual([
      ['Startup.cs', 'kept()'], ['Startup.cs', 'frozen()'],
    ]);
  });

  it('uses the one viable placement and removes the spelling in a discarded container (mixed)', async () => {
    const html = `<table><tbody><tr><td>${pre('frozen()', TITLED)}</td></tr></tbody></table>`;
    const chain = await improveChain(html, (markdown) => `${markdown}\n\n<div class="figure-index">CQ_CODE_PLACEHOLDER_0</div>\n`);
    expect(chain.html.match(/<table/g)).toHaveLength(1);
    expect(chain.html).not.toContain('CQ_CODE');
    expect(chain.report.screened).toBe(1);
    expect(codeMacros(chain.storage)).toHaveLength(1);
  });

  // These pin the #1958 path, so each page also holds a token block whose CODE-META line the echo keeps (D25 1(a)).
  it('appends an image whose only spelling is in a discarded container, and it reaches storage', async () => {
    const chain = await improveChain(`<p>x</p>${IMAGE}${ANCHOR}`, (markdown) =>
      markdown.replace('CQ\\_MEDIA\\_PLACEHOLDER\\_0', '<div class="table-index">CQ_MEDIA_PLACEHOLDER_0</div>'));
    expect(chain.dropped).toBe(1);
    expect(oracleElements(chain.storage, 'ac', 'image').length + (chain.storage.match(/<img /g)?.length ?? 0)).toBe(1);
  });

  it('refuses a frozen code block the model duplicated, never writing a copy (D26 item 3)', async () => {
    const frozen = `<div class="confluence-macro-unknown" data-macro-name="foo">${pre('frozen()', TITLED)}<p>opaque &amp; owned</p></div>`;
    await expect(improveChain(`<p>x</p>${frozen}${ANCHOR}`, (markdown) => `${markdown}\n\nCQ\\_MEDIA\\_PLACEHOLDER\\_0`))
      .rejects.toBeInstanceOf(ImproveCodePlacementError);
  });

  it('refuses a code-carrying spelling left only in an unsafe parse context (D26 item 3)', async () => {
    for (const unsafe of ['**CQ_CODE_PLACEHOLDER_0**', '[CQ_CODE_PLACEHOLDER_0](https://x.test)']) {
      const html = `<table><tbody><tr><td>${pre('frozen()', TITLED)}</td></tr></tbody></table>`;
      await expect(improveChain(html, (markdown) => markdown.replace(/<table>.*<\/table>/, unsafe)), unsafe)
        .rejects.toBeInstanceOf(ImproveCodePlacementError);
    }
  });

  it('never replaces a spelling the page itself writes, in code, prose or a link (literal)', async () => {
    const html = `${IMAGE}${pre('use CQ_MEDIA_PLACEHOLDER_0 here', TITLED)}<p>see <code>CQ_MEDIA_PLACEHOLDER_0</code>, CQ_MEDIA_PLACEHOLDER_0 and <a href="https://x.test">CQ_MEDIA_PLACEHOLDER_0</a></p>`;
    const protectedBody = protectMedia(html);
    expect(protectedBody.media[0]).toMatchObject({ literal: true });
    const chain = await improveChain(html);
    expect(chain.html.match(/<img/g)).toHaveLength(1);
    expect(chain.html.trimEnd().endsWith(IMAGE.replace('>', '>'))).toBe(true);
    expect(chain.html).toContain('<code>CQ_MEDIA_PLACEHOLDER_0</code>');
    expect(chain.html).toContain('<a href="https://x.test">CQ_MEDIA_PLACEHOLDER_0</a>');
    expect(codeMacros(chain.storage)[0]).toEqual({
      language: 'js', title: 'Startup.cs', params: { linenumbers: 'true' }, code: 'use CQ_MEDIA_PLACEHOLDER_0 here',
    });
  });

  it('keeps a token the model back-ticked as code and appends the image once', async () => {
    const chain = await improveChain(`<p>x</p>${IMAGE}${ANCHOR}`, (markdown) => markdown.replace('CQ\\_MEDIA\\_PLACEHOLDER\\_0', '`CQ_MEDIA_PLACEHOLDER_0`'));
    expect(chain.html).toContain('<code>CQ_MEDIA_PLACEHOLDER_0</code>');
    expect(chain.html.match(/<img/g)).toHaveLength(1);
  });

  it('recognises every container the reverse pass drops', () => {
    const el = (tagName: string, attributes: Record<string, string> = {}) => ({
      tagName, attributes: Object.entries(attributes).map(([name, value]) => ({ name, value })),
    });
    for (const chain of [
      [el('div', { class: 'figure-index' })], [el('div', { class: 'x table-index' })], [el('summary')], [el('template')],
      [el('div', { class: 'confluence-toc' })], [el('div', { class: 'confluence-children-macro' })],
      [el('div', { class: 'confluence-attachments-macro' })], [el('div', { class: 'confluence-labels-macro' })],
      [el('div', { class: 'confluence-include-macro' })], [el('p'), el('div', { class: 'confluence-drawio' })],
      [el('span', { class: 'confluence-jira-issue' })], [el('span', { class: 'confluence-user-mention' })],
      [el('span', { class: 'confluence-status' })], [el('span', { class: 'confluence-emoticon' })],
      [el('li'), el('ul', { 'data-type': 'taskList' })],
    ]) {
      expect(isDroppingContext(chain), JSON.stringify(chain)).toBe(true);
    }
    expect(isDroppingContext([el('li', { 'data-type': 'taskItem' }), el('ul', { 'data-type': 'taskList' })])).toBe(false);
    expect(isDroppingContext([el('p'), el('div', { class: 'panel-info' })])).toBe(false);
  });

  it('refuses a marked original that does not come back intact', async () => {
    const html = `<table><tbody><tr><td>${pre('frozen()', TITLED)}</td></tr></tbody></table>`;
    const protectedBody = protectMedia(html);
    const codeMeta = beginCodeMetaAccept(protectedBody);
    const rebuilt = await markdownToHtml(htmlToMarkdown(protectedBody.html, { layoutTokens: true }), { protectedMedia: protectedBody.media, codeMeta });
    const replay = replayProtectedMedia(rebuilt, codeMeta);
    expect(() => finalizeCodeMetadata(replay.html.replace('frozen()', 'altered()'), codeMeta)).toThrow(ImproveReplayError);
    expect(() => finalizeCodeMetadata(replay.html.replace(/ data-cq-code-replay="[^"]*"/, ''), codeMeta)).toThrow(ImproveReplayError);
  });

  it('refuses a replay plan over its budget before building anything', async () => {
    await expect(improveChain(`<p>x</p><img src="/a.png" alt="${'a'.repeat(80)}">`, (markdown) => `${markdown}\n\n${markdown}`, { replayBudget: 64 }))
      .rejects.toBeInstanceOf(ImproveReplayBudgetError);
  });
});

describe('#1958 Y3: one finalized replay identity, no marker leakage', () => {
  it('verifies an ordinary frozen block through replay, finalize and exact storage', async () => {
    const html = `<p>a</p><table><tbody><tr><td>${pre('frozen()', TITLED)}</td></tr></tbody></table>${pre('bound()', ' data-title="B"')}`;
    const chain = await improveChain(html);
    expect(chain.storage).toBe(
      '<p>a</p>\n<table><tbody><tr><td><ac:structured-macro ac:name="code"><ac:parameter ac:name="language">js</ac:parameter>'
      + '<ac:parameter ac:name="title">Startup.cs</ac:parameter><ac:parameter ac:name="linenumbers">true</ac:parameter>'
      + '<ac:plain-text-body><![CDATA[frozen()]]></ac:plain-text-body></ac:structured-macro></td></tr></tbody></table>\n\n'
      + '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">js</ac:parameter>'
      + '<ac:parameter ac:name="title">B</ac:parameter><ac:plain-text-body><![CDATA[bound()]]></ac:plain-text-body></ac:structured-macro>\n',
    );
    for (const text of [chain.html, chain.storage, htmlToText(chain.html)]) expect(text).not.toContain('data-cq-');
  });

  it('accounts a twin-stripped frozen block by its post-strip unit', async () => {
    const html = `<table><tbody><tr><td>${pre('same()', TITLED)}</td></tr></tbody></table><p>b</p>${pre('same()', ' data-title="Other"')}`;
    const chain = await improveChain(html);
    expect(chain.storage).toBe(
      '<table><tbody><tr><td><ac:structured-macro ac:name="code"><ac:parameter ac:name="language">js</ac:parameter>'
      + '<ac:plain-text-body><![CDATA[same()]]></ac:plain-text-body></ac:structured-macro></td></tr></tbody></table>\n\n<p>b</p>\n'
      + '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">js</ac:parameter>'
      + '<ac:plain-text-body><![CDATA[same()]]></ac:plain-text-body></ac:structured-macro>\n',
    );
    expect(chain.html).not.toContain('data-cq-');
    expect(chain.allowance.units).toHaveLength(1);
  });
});

describe('#1958 witnesses and #1953 admission (V3, V7, X6)', () => {
  it('gives one witness per codeBlockElements entry, a string only for an unchanged plain fence', async () => {
    const html = `${pre('plain()')}${pre('bound()', TITLED)}<p>x</p>`;
    const chain = await improveChain(html, (markdown) => `${markdown}\n\n<pre><span><code>nested()</code></span></pre>\n\n<pre><code>raw()</code></pre>\n\n<div class="figure-index">\n\n\`\`\`js\nmoved()\n\`\`\`\n\n</div>\n\n    indented()\n`, { witnesses: true });
    const elements = codeBlockElements(new JSDOM(`<body>${chain.html}</body>`).window.document.body);
    expect(chain.witnesses).toHaveLength(elements.length);
    expect(elements.map((el) => el.textContent)).toEqual(['plain()\n', 'bound()', 'raw()', 'moved()\n', 'indented()\n']);
    expect(chain.witnesses).toEqual(['plain()', null, null, null, null]);
    const off = await improveChain(html);
    expect(off.witnesses).toEqual([]);
  });

  it('admits a legacy op on a witnessed block of an uncarried page; the storage rule accounts for exactly it', async () => {
    const earlier = '<pre><span><code class="language-js">earlier()</code></span></pre>';
    const chain = await improveChain(pre('legacy()'), (markdown) => `${earlier}\n\n${markdown}`, { witnesses: true });
    // The earlier block has no direct `code` child: it is no ordinal, and does not shift the admitted one.
    expect(chain.witnesses).toEqual(['legacy()']);
    expect(admitLegacyCodeMetadata(chain.allowance, [{ ordinal: 0, title: 'Legacy', macroParams: '{"collapse":"true"}' }])).toBe(1);
    const doc = new JSDOM(`<body>${chain.html}</body>`).window.document;
    const target = codeBlockElements(doc.body)[0]!;
    target.setAttribute('data-title', 'Legacy');
    target.setAttribute('data-macro-params', '{"collapse":"true"}');
    const storage = htmlToConfluence(doc.body.innerHTML);
    expect(refusal(() => assertCodeMacroStorage(storage, chain.allowance))).toBeNull();
    expect(codeMacros(storage)[1]).toEqual({ language: 'js', title: 'Legacy', params: { collapse: 'true' }, code: 'legacy()\n' });
    // A write that names other values than the op admitted is refused.
    target.setAttribute('data-title', 'Other');
    expect(refusal(() => assertCodeMacroStorage(htmlToConfluence(doc.body.innerHTML), chain.allowance))).toBe('unapproved-code-macro');
  });

  it('admits nothing on a carried page, also when its only annotated block is frozen', async () => {
    for (const html of [
      `${pre('legacy()')}<table><tbody><tr><td>${pre('f()', TITLED)}</td></tr></tbody></table>`,
      `${pre('legacy()')}${pre('\n', ' data-title="blank"')}`,
    ]) {
      const chain = await improveChain(html, (markdown) => markdown, { witnesses: true });
      expect(chain.allowance.carried).toBe(true);
      expect(admitLegacyCodeMetadata(chain.allowance, [{ ordinal: 0, title: 'L', macroParams: null }])).toBe(0);
    }
  });

  it('admits no op without a witness, on a twin, repeated or out of range', async () => {
    const chain = await improveChain(`${pre('a()')}${pre('twin()')}${pre('twin()')}`, (markdown) =>
      markdown.replace('```js\na()\n```', '<pre><code class="language-js">a()</code></pre>'), { witnesses: true });
    expect(chain.witnesses).toEqual([null, 'twin()', 'twin()']);
    const ops = [
      { ordinal: 0, title: 'no witness', macroParams: null },
      { ordinal: 1, title: 'twin', macroParams: null },
      { ordinal: -1, title: 'x', macroParams: null },
      { ordinal: 0.5, title: 'x', macroParams: null },
      { ordinal: 3, title: 'x', macroParams: null },
      { ordinal: 2, title: null, macroParams: null },
      { ordinal: 2, title: undefined as unknown as string, macroParams: null },
    ];
    expect(admitLegacyCodeMetadata(chain.allowance, ops)).toBe(0);
    // A repeated ordinal: only the first op that names it counts.
    const single = await improveChain(pre('p()'), (markdown) => markdown, { witnesses: true });
    expect(admitLegacyCodeMetadata(single.allowance, [
      { ordinal: 0, title: 'P', macroParams: null },
      { ordinal: 0, title: 'repeated', macroParams: null },
    ])).toBe(1);
  });
});

describe('#1958 local exit (X2, Q8 as ruled)', () => {
  it('refuses a projection that is not readable, with or without code', async () => {
    const chain = await improveChain('<p>a</p>', (markdown) => `${markdown}\n\n<p title="a<b">t</p>\n`);
    expect(refusal(() => assertLocalCodeMacroProjections(chain.html, chain.allowance, { body_storage: null }))).toBe('not-well-formed');
  });

  it('refuses with the reader\'s limit reason', async () => {
    const chain = await improveChain(`<p>a</p>${pre('x', TITLED)}`);
    expect(refusal(() => assertLocalCodeMacroProjections(chain.html, chain.allowance, { body_storage: null },
      { ...STORAGE_READER_LIMITS, length: 8 }))).toBe('too-large');
    expect(refusal(() => assertLocalCodeMacroProjections(chain.html, chain.allowance, { body_storage: null },
      { ...STORAGE_READER_LIMITS, nodes: 3 }))).toBe('too-many-nodes');
    expect(refusal(() => assertLocalCodeMacroProjections(chain.html, chain.allowance, { body_storage: '' }))).toBeNull();
  });

  it('judges P1 alike under the restore and writer options that do not touch code macros', async () => {
    for (const html of [
      `<p>a</p>${pre('x', TITLED)}<ul data-type="taskList"><li data-type="taskItem" data-checked="false">t</li></ul>`,
      `${pre('graph TD', ' data-title="F"', 'mermaid')}<p><a href="#confluence-url:%2Frel?body=plain">rel</a></p>`,
    ]) {
      const chain = await improveChain(html);
      for (const options of [{}, { legacyTasks: true }, { linkOrigin: null }, { derivationFeatures: new Set<never>() }]) {
        const read = readConfluenceStorage(htmlToConfluence(chain.html, options));
        if (!read.ok) throw new Error(read.reason);
        expect(refusal(() => judgeCodeMacros(read.tree, chain.allowance, options))).toBeNull();
      }
    }
  });

  it('keeps the metadata through the relocation arm\'s re-serialisation', async () => {
    const chain = await improveChain(`<p>a "b" 'c'</p>${pre('x &amp; y', TITLED)}`);
    // What the stored body may also look like: marked-style references a re-serialisation writes as characters.
    const stored = chain.html.replace('"b" \'c\'', '&quot;b&quot; &#39;c&#39;');
    const reserialised = new JSDOM(`<body>${stored}</body>`).window.document.body.innerHTML;
    expect(reserialised).not.toBe(stored);
    expect(codeMacros(htmlToConfluence(reserialised))).toEqual(codeMacros(chain.storage));
    expect(refusal(() => assertLocalCodeMacroProjections(stored, chain.allowance, { body_storage: null }))).toBeNull();
  });
});

describe('#1958 schemas parse the exact Accept shape', () => {
  it('keeps title and options of a bound block and a mermaid block through the collab schema', async () => {
    const chain = await improveChain(`${pre('x();', TITLED)}${pre('graph TD', ` data-title="Flow" data-macro-params="${LINENUMBERS}"`, 'mermaid')}`);
    expect(generateJSON(chain.html, collabExtensions()).content?.map((node) => node.type)).toEqual(['codeBlock', 'mermaidBlock']);
    expect(codeMacros(htmlToConfluence(yDocToHtml(htmlToYDoc(chain.html))))).toEqual(codeMacros(chain.storage));
  });
});

describe('#1958 the forward pass is unchanged', () => {
  it('derives the same HTML for a stored code macro', () => {
    expect(confluenceToHtml('<ac:structured-macro ac:name="code"><ac:parameter ac:name="title">T</ac:parameter><ac:plain-text-body><![CDATA[x]]></ac:plain-text-body></ac:structured-macro>'))
      .toBe('<pre data-title="T"><code>x</code></pre>');
  });
});

// ---------------------------------------------------------------------------
// PR review r1 (CM-1…CM-8), coordinator ruling D23.
// ---------------------------------------------------------------------------

/** The reviewer's page: a titled sample in a table cell, then a diagram image. */
const CM1_PAGE = '<table><tbody><tr><td><pre data-title="Sample"><code class="language-js">const x = 1;</code></pre></td></tr></tbody></table>'
  + '<p>Diagram follows</p><img src="/api/attachments/1/d.png" alt="d"><p>End</p>';
/** Generated by the release before #1958 (`a06f304c`, htmlToMarkdown(protectMedia(CM1_PAGE).html, { layoutTokens: true })). */
const CM1_BASE_SUGGESTION = '<table><tbody><tr><td><pre data-title="Sample"><code class="language-js">const x = 1;</code></pre></td></tr></tbody></table>'
  + '\n\nDiagram follows\n\nCQ\\_MEDIA\\_PLACEHOLDER\\_0\n\nEnd';
/** A page whose only annotated block travels as a token, and its suggestion from `a06f304c`. */
const TOKEN_PAGE = '<p>Intro</p><pre data-title="Startup.cs" data-macro-params="{&quot;linenumbers&quot;:&quot;true&quot;}"><code class="language-js">const a = 1;</code></pre>'
  + '<p>Diagram follows</p><img src="/api/attachments/1/d.png" alt="d"><p>End</p>';
const TOKEN_PAGE_BASE_SUGGESTION = 'Intro\n\n```js\nconst a = 1;\n```\n\nDiagram follows\n\nCQ\\_MEDIA\\_PLACEHOLDER\\_0\n\nEnd';

describe('#1958 r1 CM-1: media ordinals are the ones the previous release wrote', () => {
  it('keeps every media token and its HTML as before; frozen code has its own namespace', () => {
    const protectedBody = protectMedia(CM1_PAGE);
    expect(protectedBody.media).toEqual([{ token: 'CQ_MEDIA_PLACEHOLDER_0', html: '<img src="/api/attachments/1/d.png" alt="d">' }]);
    expect(protectedBody.frozenCode.map((entry) => entry.token)).toEqual(['CQ_CODE_PLACEHOLDER_0']);
    expect(protectedBody.html).toBe('<table><tbody><tr><td> CQ_CODE_PLACEHOLDER_0 </td></tr></tbody></table>'
      + '<p>Diagram follows</p> CQ_MEDIA_PLACEHOLDER_0 <p>End</p>');
  });

  it('does not freeze an annotated block that holds media, so that medium keeps its ordinal', () => {
    const html = '<pre data-title="Pic"><code class="language-js">a<img src="/api/attachments/1/x.png" alt="x">b</code></pre>'
      + '<img src="/api/attachments/1/d.png" alt="d">';
    const protectedBody = protectMedia(html);
    // Exactly what a06f304c wrote.
    expect(protectedBody.media.map((entry) => entry.token)).toEqual(['CQ_MEDIA_PLACEHOLDER_0', 'CQ_MEDIA_PLACEHOLDER_1']);
    expect(protectedBody.html).toBe('<pre data-title="Pic"><code class="language-js">a CQ_MEDIA_PLACEHOLDER_0 b</code></pre> CQ_MEDIA_PLACEHOLDER_1 ');
    expect(protectedBody.frozenCode).toEqual([]);
    expect(htmlToMarkdown(protectedBody.html, { layoutTokens: true })).toBe('```js\na CQ_MEDIA_PLACEHOLDER_0 b\n```\n\nCQ\\_MEDIA\\_PLACEHOLDER\\_1');
  });

  it('refuses a stored suggestion of the previous release for a page with frozen code, before anything is built (D26 2(b))', async () => {
    await expect(improveChain(CM1_PAGE, () => CM1_BASE_SUGGESTION, { provenance: 'legacy' })).rejects.toBeInstanceOf(ImproveSuggestionFormatError);
    // The same Markdown with no stored row takes the #1958 path, which cannot place the frozen block.
    await expect(improveChain(CM1_PAGE, () => CM1_BASE_SUGGESTION, { provenance: 'unmatched' })).rejects.toBeInstanceOf(ImproveCodePlacementError);
  });

  it('refuses a stored suggestion of the previous release for a page with annotated code that is not frozen (D26 2(b))', async () => {
    await expect(improveChain(TOKEN_PAGE, () => TOKEN_PAGE_BASE_SUGGESTION, { provenance: 'legacy' }))
      .rejects.toBeInstanceOf(ImproveSuggestionFormatError);
  });

  it('refuses a frozen block the model dropped even when another code carrier is present (D26 item 3)', async () => {
    const html = `${CM1_PAGE}${pre('bound()', ' data-title="B"')}`;
    await expect(improveChain(html, (markdown) => markdown.replace(/<table>.*<\/table>/, ''))).rejects.toBeInstanceOf(ImproveCodePlacementError);
  });
});

/** Pages and suggestions generated on a06f304c (disposable worktree), with that release's Accept result. */
const IMG = (name: string): string => `<img src="/api/attachments/1/${name}.png" alt="${name}">`;
const LN = ' data-macro-params="{&quot;linenumbers&quot;:&quot;true&quot;}"';
const HISTORICAL = {
  // Pages without annotated code: the base path.
  imageInCodePlain: {
    page: `<pre><code class="language-js">a${IMG('x')}b</code></pre><p>Then</p>${IMG('d')}<p>End</p>`,
    suggestion: '```js\na CQ_MEDIA_PLACEHOLDER_0 b\n```\n\nThen\n\nCQ\\_MEDIA\\_PLACEHOLDER\\_1\n\nEnd',
    base: `<pre><code class="language-js">a ${IMG('x')} b\n</code></pre>\n<p>Then</p>\n${IMG('d')}\n<p>End</p>\n`,
  },
  mentionPlain: {
    page: `<p>Inspect <code>CQ_CODE_PLACEHOLDER_COUNT</code> in diagnostics.</p><pre><code class="language-js">const x = 1;</code></pre><p>Diagram follows</p>${IMG('d')}<p>End</p>`,
    suggestion: 'Inspect `CQ_CODE_PLACEHOLDER_COUNT` in diagnostics.\n\n```js\nconst x = 1;\n```\n\nDiagram follows\n\nCQ\\_MEDIA\\_PLACEHOLDER\\_0\n\nEnd',
    base: '<p>Inspect <code>CQ_CODE_PLACEHOLDER_COUNT</code> in diagnostics.</p>\n<pre><code class="language-js">const x = 1;\n</code></pre>\n'
      + `<p>Diagram follows</p>\n${IMG('d')}\n<p>End</p>\n`,
  },
  // Pages with annotated code: review r2 CM2-1/CM2-2 and r3 CM3-1…CM3-4.
  mentionFrozen: {
    page: '<table><tbody><tr><td><pre data-title="Sample"><code class="language-js">const x = 1;</code></pre></td></tr></tbody></table>'
      + `<p>Inspect <code>CQ_CODE_PLACEHOLDER_COUNT</code> in diagnostics.</p><p>Diagram follows</p>${IMG('d')}<p>End</p>`,
    suggestion: '<table><tbody><tr><td><pre data-title="Sample"><code class="language-js">const x = 1;</code></pre></td></tr></tbody></table>'
      + '\n\nInspect `CQ_CODE_PLACEHOLDER_COUNT` in diagnostics.\n\nDiagram follows\n\nCQ\\_MEDIA\\_PLACEHOLDER\\_0\n\nEnd',
  },
  imageInAnnotatedCode: {
    page: `<pre data-title="Pic"><code class="language-js">a${IMG('x')}b</code></pre><p>Then</p>${IMG('d')}<p>End</p>`,
    suggestion: '```js\na CQ_MEDIA_PLACEHOLDER_0 b\n```\n\nThen\n\nCQ\\_MEDIA\\_PLACEHOLDER\\_1\n\nEnd',
  },
  drawio: {
    page: `<p>Flow</p><pre data-title="Flow"><code class="language-drawio">Build CQ_CODE_PLACEHOLDER_0 chart</code></pre>${IMG('d')}`,
    suggestion: 'Flow\n\n```drawio\nBuild CQ_CODE_PLACEHOLDER_0 chart\n```\n\nCQ\\_MEDIA\\_PLACEHOLDER\\_0',
  },
  identifier: {
    page: `<table><tbody><tr><td><pre data-title="Sample"${LN}><code class="language-js">const n = CQ_CODE_PLACEHOLDER_0_COUNT;</code></pre></td></tr></tbody></table><p>Notes</p>`,
    suggestion: `<table><tbody><tr><td><pre data-title="Sample"${LN}><code class="language-js">const n = CQ_CODE_PLACEHOLDER_0_COUNT;</code></pre></td></tr></tbody></table>`
      + '\n\nNotes\n\nUse CQ_CODE_PLACEHOLDER_0_COUNT to size the buffer.',
  },
  bold: {
    page: '<table><tbody><tr><td><pre data-title="Sample"><code class="language-js">x()</code></pre></td></tr></tbody></table><p>See <strong>CQ_CODE_PLACEHOLDER_0</strong> here.</p>',
    suggestion: '<table><tbody><tr><td><pre data-title="Sample"><code class="language-js">x()</code></pre></td></tr></tbody></table>\n\nSee **CQ\\_CODE\\_PLACEHOLDER\\_0** here.',
  },
  rawCellImage: {
    page: `<table><tbody><tr><td><pre data-title="How to wire"${LN}><code class="language-js">a${IMG('x')}b</code></pre></td></tr></tbody></table><p>End</p>`,
    suggestion: `<table><tbody><tr><td><pre data-title="How to wire"${LN}><code class="language-js">a CQ_MEDIA_PLACEHOLDER_0 b</code></pre></td></tr></tbody></table>\n\nEnd`,
  },
  mixedMacro: {
    page: '<div class="confluence-macro-unknown" data-macro-name="foo"><pre data-title="Titled"><code class="language-js">run()</code></pre><pre><code class="language-js">run()</code></pre></div><p>End</p>',
    suggestion: 'CQ\\_MEDIA\\_PLACEHOLDER\\_0\n\nEnd',
  },
};

describe('#1958 r3 (D26): the suggestion\'s provenance decides the path, never its text', () => {
  it('(b) refuses every stored suggestion of the previous release for a page with annotated code (r2 CM2-1/2, r3 CM3-1…4)', async () => {
    for (const [name, { page, suggestion }] of Object.entries(HISTORICAL).filter(([name]) => !name.endsWith('Plain'))) {
      expect(protectMedia(page).carried, name).toBe(true);
      await expect(improveChain(page, () => suggestion, { provenance: 'legacy' }), name).rejects.toBeInstanceOf(ImproveSuggestionFormatError);
    }
  });

  it('(b) applies a stored suggestion of the previous release on a page without annotated code exactly as a06f304c did', async () => {
    for (const { page, suggestion, base } of [HISTORICAL.imageInCodePlain, HISTORICAL.mentionPlain]) {
      const chain = await improveChain(page, () => suggestion, { provenance: 'legacy' });
      expect(chain.html, suggestion).toBe(base);
      expect(chain.html, suggestion).toBe(await headChain(page, () => suggestion));
    }
  });

  it('(b) keeps the trust boundary: injected code metadata is stripped and a code-named placeholder refused', async () => {
    const { page, suggestion, base } = HISTORICAL.imageInCodePlain;
    const injected = await improveChain(page, () => `${suggestion}\n\n<pre data-title="Evil" data-macro-params="{&quot;a&quot;:&quot;b&quot;}"><code>raw()</code></pre>\n`, { provenance: 'legacy' });
    expect(injected.html).toBe(`${base}<pre><code>raw()</code></pre>\n`);
    expect(injected.report.stripped).toBe(1);
    expect(await asyncRefusal(() => improveChain(page, () => `${suggestion}\n\n<div class="confluence-macro-unknown" data-macro-name="code">x</div>\n`, { provenance: 'legacy' })))
      .toBe('unapproved-code-macro');
  });

  it('(c) takes unmatched Markdown down the #1958 path: the historical cases refuse or keep text, never duplicate', async () => {
    // No code-carrying original can be placed exactly once: refused.
    for (const name of ['mentionFrozen', 'drawio', 'bold', 'identifier'] as const) {
      const { page, suggestion } = HISTORICAL[name];
      await expect(improveChain(page, () => suggestion, { provenance: 'unmatched' }), name).rejects.toBeInstanceOf(ImproveCodePlacementError);
    }
    // The image goes to its token inside the raw pre; the model's pre is not an original, so it loses its metadata.
    const raw = await improveChain(HISTORICAL.rawCellImage.page, () => HISTORICAL.rawCellImage.suggestion, { provenance: 'unmatched' });
    expect(raw.html).not.toMatch(/data-title|data-macro-params/);
    // The macro holding a titled and a bare twin comes back once, verified; R1 then drops the title of both twins.
    const mixed = await improveChain(HISTORICAL.mixedMacro.page, () => HISTORICAL.mixedMacro.suggestion, { provenance: 'unmatched' });
    expect(mixed.html.match(/confluence-macro-unknown/g)).toHaveLength(1);
    expect(mixed.report.twins).toBe(1);
    expect(codeMacros(mixed.storage).map((macro) => macro.title)).toEqual([null, null]);
  });

  it('(a) a #1958 suggestion on the same pages keeps the blocks; a spelling inside a longer identifier is text', async () => {
    const drawio = await improveChain(HISTORICAL.drawio.page);
    expect(drawio.html).toContain('data-title="Flow"');
    const identifier = await improveChain(HISTORICAL.identifier.page, (markdown) => `${markdown}\n\nUse CQ_CODE_PLACEHOLDER_0_COUNT to size the buffer.`);
    expect(identifier.html).toContain('Use CQ_CODE_PLACEHOLDER_0_COUNT to size the buffer.');
    expect(codeMacros(identifier.storage).map((macro) => [macro.title, macro.params])).toEqual([['Sample', { linenumbers: 'true' }]]);
    expect(protectMedia(`${HISTORICAL.identifier.page}<p>See CQ_CODE_PLACEHOLDER_0_COUNT</p>`).frozenCode[0]!.literal).toBeUndefined();
  });

  it('(a) a placement the page itself spells never authorizes replay: the collision is refused (CM3-2 control)', async () => {
    const { page } = HISTORICAL.bold;
    expect(protectMedia(page).frozenCode[0]).toMatchObject({ literal: true });
    await expect(improveChain(page)).rejects.toBeInstanceOf(ImproveCodePlacementError);
  });

  it('(a)/(c) bind only exact-grammar CODE-META lines standing alone directly above a fence', async () => {
    const page = `<p>Intro</p>${pre('x()', ' data-title="T"')}${IMG('d')}`;
    for (const [name, edit] of [
      ['inside code', (md: string) => `\`\`\`text\n[[[CODE-META n=0 title=T]]]\n\`\`\`\n\n${md.replace(/\[\[\[CODE-META[^\n]*\n/, '')}`],
      ['inside other text', (md: string) => md.replace(/(\[\[\[CODE-META[^\n]*)\n/, 'See $1\n')],
      ['away from a fence', (md: string) => md.replace(/(\[\[\[CODE-META[^\n]*)\n/, '$1\n\n')],
      ['not the grammar', (md: string) => md.replace('[[[CODE-META n=0', '[[[CODE-META n=00')],
    ] as const) {
      const chain = await improveChain(page, edit, { provenance: 'unmatched' });
      expect(chain.report.bound, name).toBe(0);
      expect(chain.html, name).not.toContain('data-title');
    }
    const faithful = await improveChain(page, undefined, { provenance: 'unmatched' });
    expect(faithful.report.bound).toBe(1);
  });

  it('charges the replay plan, marker text included, before anything is built (CM3-5)', async () => {
    // Base path: the upper bound (every placement, every entry without one) is charged first.
    const { page, suggestion } = HISTORICAL.imageInCodePlain;
    const sizes = protectMedia(page).media.reduce((sum, entry) => sum + entry.html.length, 0);
    await expect(improveChain(page, () => suggestion, { provenance: 'legacy', replayBudget: sizes - 1 })).rejects.toBeInstanceOf(ImproveReplayBudgetError);
    expect((await improveChain(page, () => suggestion, { provenance: 'legacy', replayBudget: sizes })).html).toBe(HISTORICAL.imageInCodePlain.base);
    // #1958 path: a code-carrying original's marker is part of the charge.
    const frozen = `<table><tbody><tr><td>${pre('frozen()', TITLED)}</td></tr></tbody></table>`;
    const original = protectMedia(frozen).frozenCode[0]!.html.length;
    await expect(improveChain(frozen, undefined, { replayBudget: original })).rejects.toBeInstanceOf(ImproveReplayBudgetError);
  });
});

describe('#1958 r1 CM-3: a replayed original is compared exactly', () => {
  it('refuses an original one HTML parse cannot give back (a line feed before its code), on an unchanged echo', async () => {
    await expect(improveChain('<p>a</p><pre data-title="Guide">\n\n<code>x</code></pre>')).rejects.toBeInstanceOf(ImproveReplayError);
  });

  it('refuses a CR outside code text (an attribute value): only code text may read CR as LF', async () => {
    await expect(improveChain('<p>a</p><pre data-title="Gu&#13;ide"><code>x<b>y</b></code></pre>')).rejects.toBeInstanceOf(ImproveReplayError);
  });

  it('accepts a CR in the code text and returns the original bytes', async () => {
    const chain = await improveChain('<p>a</p><pre data-title="Guide"><code>x<b>y&#13;z</b></code></pre>');
    expect(chain.html).toBe('<p>a</p>\n<pre data-title="Guide"><code>x<b>y\rz</b></code></pre>\n');
    expect(protectMedia('<pre data-title="G"><code>x<b>y&#13;z</b></code></pre>').frozenCode[0]!.lineEndForm)
      .toBe('<pre data-title="G"><code>x<b>y\nz</b></code></pre>');
  });

  it('normalises the code text of nested code once, and only code text (r2 CM2-8)', () => {
    expect(protectMedia('<pre data-title="G"><code>a&#13;<code>b&#13;&#10;c</code></code><span>d&#13;</span></pre>').frozenCode[0]!.lineEndForm)
      .toBe('<pre data-title="G"><code>a\n<code>b\nc</code></code><span>d\r</span></pre>');
  });
});

describe('#1958 r1 CM-5: only writer-recognised placeholders name a code macro', () => {
  it.each([
    '<p data-macro-name="code">Manual</p>', '<div data-macro-name="code"><p>Manual</p></div>', '<span data-macro-name=" CODE ">Manual</span>',
  ])('keeps the inert annotation %s and writes no macro for it', async (markup) => {
    const chain = await improveChain('<p>a</p>', (markdown) => `${markdown}\n\n${markup}\n`);
    expect(chain.storage).toContain('Manual');
    expect(codeMacros(chain.storage)).toEqual([]);
  });
});

describe('#1958 r1 CM-6: bounded work', () => {
  it('charges an inspected name and value before comparing it', () => {
    const benign = `<ac:structured-macro ac:name="${'n'.repeat(260)}"><ac:rich-text-body><p>x</p></ac:rich-text-body></ac:structured-macro>`;
    expect(refusal(() => readCodeMacroInventory(benign, 10))).toBe('unapproved-code-macro');
    expect(readCodeMacroInventory(benign)).toEqual({ records: [], bareKeys: [] });
    // A parameter name is charged as well as its text.
    const named = M(PARAM('p'.repeat(200), 'v') + BODY('x'));
    expect(refusal(() => readCodeMacroInventory(named, 150))).toBe('unapproved-code-macro');
    expect(readCodeMacroInventory(named).records).toHaveLength(1);
  });

  it('analyses the echo without per-token rescans of the token lists', async () => {
    const counts = async (blocks: number): Promise<{ splice: number; indexOf: number }> => {
      const page = Array.from({ length: blocks }, (_, i) => pre(`x${i}()`, ` data-title="T${i}"`)).join('');
      const protectedBody = protectMedia(page);
      const markdown = `${htmlToMarkdown(protectedBody.html, { layoutTokens: true })}\n\n${'[[[CODE-META junk]]]\n\n'.repeat(blocks)}`;
      const codeMeta = beginCodeMetaAccept(protectedBody, { witnesses: true });
      const splice = vi.spyOn(Array.prototype, 'splice');
      const indexOf = vi.spyOn(Array.prototype, 'indexOf');
      await markdownToHtml(markdown, { codeMeta });
      const result = { splice: splice.mock.calls.length, indexOf: indexOf.mock.calls.length };
      splice.mockRestore();
      indexOf.mockRestore();
      return result;
    };
    const small = await counts(10);
    const large = await counts(300);
    expect(large.splice - small.splice).toBeLessThan(10);
    expect(large.indexOf - small.indexOf).toBeLessThan(50);
  });
});

describe('#1958 r1 CM-7: carrier debris in headings and tables', () => {
  it('removes a token the model made a heading; the block is saved without metadata', async () => {
    const page = `<p>Report</p>${pre('daily()', ' data-title="Daily Report"')}${ANCHOR}`;
    const chain = await improveChain(page, (markdown) => markdown.replace('[[[CODE-META n=0', '## [[[CODE-META n=0'));
    expect(chain.html).not.toContain('CODE-META');
    expect(chain.html).not.toContain('<h2');
    expect(codeMacros(chain.storage).map((macro) => [macro.title, macro.code])).toEqual([[null, 'daily()\n'], ['Anchor', 'anchor()']]);
  });

  it('removes each token run on its own and keeps the heading or paragraph text between them (r2 CM2-5)', async () => {
    const page = `<p>Report</p>${pre('daily()', ' data-title="Sample"')}${ANCHOR}`;
    const chain = await improveChain(page, (markdown) => `## [[[CODE-META n=0 title=Sample]]] Release prerequisites [[[CODE-META n=1 title=Sample]]]\n\n`
      + `[[[CODE-META n=0 title=Sample]]] Install first [[[CODE-META n=1 title=Sample]]]\n\n${markdown.replace(/\[\[\[CODE-META[^\n]*\n/, '')}`);
    expect(chain.html).toMatch(/<h2>\s*Release prerequisites\s*<\/h2>/);
    expect(chain.html).toMatch(/<p>\s*Install first\s*<\/p>/);
    expect(chain.html).not.toContain('CODE-META');
    // Nothing binds from a heading or prose.
    expect(codeMacros(chain.storage).map((macro) => macro.title)).toEqual([null, 'Anchor']);
    expect(chain.report.debris).toBe(4);
  });

  it('keeps an authored escaped spelling and a code span in a paragraph of token runs', async () => {
    const chain = await improveChain(`<p>a</p>${ANCHOR}`, (markdown) => `${markdown}\n\n[[[CODE-META n=0]]] \\[\\[\\[CODE-META n=9\\]\\]\\] \`[[[CODE-META n=8]]]\`\n`);
    expect(chain.html).toContain('[[[CODE-META n=9]]]');
    expect(chain.html).toContain('<code>[[[CODE-META n=8]]]</code>');
  });

  it('strips a token spelling from heading and table text and keeps authored escapes and code spans', async () => {
    const chain = await improveChain(`<p>a</p>${ANCHOR}`, (markdown) => `${markdown}\n\n## Intro [[[CODE-META n=0]]] text\n\n`
      + '| a | b |\n|---|---|\n| [[[CODE-META n=1]]] x | `[[[CODE-META n=2]]]` |\n\n'
      + '## \\[\\[\\[CODE-META n=3\\]\\]\\] authored\n');
    expect(chain.html).toContain('<h2>Intro  text</h2>');
    expect(chain.html).toContain('<td> x</td>');
    expect(chain.html).toContain('<code>[[[CODE-META n=2]]]</code>');
    expect(chain.html).toContain('[[[CODE-META n=3]]] authored');
    expect(chain.report.debris).toBe(2);
  });
});

describe('#1958 r1 CM-8: projections and the independent differential', () => {
  it('refuses a body whose second projection alone makes a titled block a twin (P2-only)', async () => {
    const page = '<table><tbody><tr><td><pre data-title="Title"><code class="language-js">sample</code></pre></td></tr></tbody></table>';
    const chain = await improveChain(page, (markdown) => `${markdown}\n\n<pre><code class="language-js"><textarea>\n\nsample</textarea></code></pre>\n`);
    // P1 (and the remote exit) keep the bodies distinct …
    expect(codeMacros(chain.storage).map((macro) => macro.code)).toEqual(['sample', '\nsample']);
    // … one HTML re-serialisation (relocation) does not.
    const reserialised = new JSDOM(`<body>${chain.html}</body>`).window.document.body.innerHTML;
    expect(codeMacros(htmlToConfluence(reserialised)).map((macro) => macro.code)).toEqual(['sample', 'sample']);
    expect(refusal(() => assertLocalCodeMacroProjections(chain.html, chain.allowance, { body_storage: null }))).toBe('unapproved-code-macro');
  });

  it('agrees with the independent XML oracle on an explicit corpus, verdict and records (r2 CM2-6, CM2-7)', () => {
    const bare = M(PARAM('language', 'js') + BODY('sample'));
    const titled = M(PARAM('language', 'js') + PARAM('title', 'T') + BODY('sample'));
    const corpus: Array<[string, string[]]> = [
      [bare, []],
      [titled, [pre('sample', ' data-title="T"')]],
      [titled, []],
      [`${titled}${bare}`, [pre('sample', ' data-title="T"')]],
      // An ordinary attribute whose name only starts with `xmlns`, on the macro and on a child: not a declaration.
      [M(PARAM('language', 'js') + BODY('sample'), '<ac:structured-macro ac:name="code" xmlnsNotes="release">'), []],
      [M('<ac:parameter ac:name="language" xmlnsNotes="r">js</ac:parameter>' + BODY('sample')), []],
      // A genuine namespace declaration is not an attribute of the element in either reading.
      [M(PARAM('language', 'js') + BODY('sample'), '<ac:structured-macro xmlns:x="urn:x" ac:name="code">'), []],
      [`<div xmlns:ac="urn:other">${bare}</div>`, []],
      [`<style>${bare}</style>`, []],
      [M(BODY('x') + PARAM('language', 'js')), []],
      ['<p>no macro</p>', []],
    ];
    for (const [storage, units] of corpus) expectOracleAgreement(storage, units, {});
    // The ordinary `xmlns*` attribute refuses in both readings; the declaration passes in both.
    expect(oracleCodeMacros(corpus[4]![0])).toEqual({ ok: false, reason: 'unapproved-code-macro' });
    expect(oracleCodeMacros(corpus[5]![0])).toEqual({ ok: false, reason: 'unapproved-code-macro' });
    expect(oracleCodeMacros(corpus[6]![0])).toMatchObject({ ok: true });
  });
});

describe('#1958 r1: admission runs once per finalized allowance', () => {
  it('refuses a second call', async () => {
    const chain = await improveChain(pre('p()'), (markdown) => markdown, { witnesses: true });
    expect(admitLegacyCodeMetadata(chain.allowance, [])).toBe(0);
    expect(() => admitLegacyCodeMetadata(chain.allowance, [{ ordinal: 0, title: 'T', macroParams: null }])).toThrow(/already called/);
  });
});
