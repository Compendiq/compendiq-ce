/**
 * #1957: a Confluence subtask nests inside its parent task, once, at its own
 * depth — through the forward pass, both TipTap schemas (the backend collab
 * schema here; the frontend one in Editor.test.tsx and ArticleViewer.test.tsx)
 * and write-back. Task lists that are not in a task body stay flat, exactly as
 * before. Nesting deeper than MAX_TASK_LIST_NESTING (counted on the input,
 * editor lists and raw task lists alike) is converted exactly as before #1957,
 * on both passes. Literals and hashes marked "bff6d4ec" were captured at that
 * commit.
 */
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import * as Y from 'yjs';
import {
  _confluenceToHtmlWithForTest,
  MAX_TASK_LIST_NESTING,
  assignTaskIds,
  confluenceToHtml,
  htmlToConfluence,
  htmlToMarkdown,
  markdownToHtml,
  measureTaskListConversion,
} from './content-converter.js';
import { applyHtmlToYDoc, collabCarriesTaskIds, collabTaskItems, htmlToYDoc, markTaskIds, yDocToHtml } from './collab-schema.js';
import { ALL_STORAGE_DERIVATION_FEATURES, NO_STORAGE_DERIVATION_FEATURES } from './storage-derivation.js';
import { STORAGE_DERIVATION_BASE_CORPUS } from './__fixtures__/storage-derivation-base-corpus.js';
import {
  NESTED_TASK_LIST_EDITOR_HTML,
  NESTED_TASK_LIST_HTML,
  NESTED_TASK_LIST_LEGACY_HTML,
  NESTED_TASK_LIST_PAGE,
  POLLUTED_TASK_LIST_PAGE,
} from './__fixtures__/confluence-xhtml.js';

/**
 * Hashes of what bff6d4ec wrote for the 33-level inputs below, captured at
 * that commit (`$EPIC/evidence/1957/capture-r1.mts.txt`): beyond the limit,
 * #1957 converts exactly as the base did.
 */
const BASE = {
  forward33Macros: '0a912b4af28810936affdbc6d6582a2265f018724cc0ab4f056c57ff3876c426',
  forward33Plain: '52ef2667b202d2649ad40b51d95cfa7e30ef7ec0734406651e7fdf94622da12a',
  writeBack33: '7b9b4e30b75d2dabef8b1d56c12d119f83b5378d2f65b5c2f0c9a059890b0eb0',
  rawSublistWrite: 'da0748721b2dd7a429ffd19fe4ac34433ed4cc5b1cddd8b56a68be149c5f5f18',
  rawSublistForward: 'add2f2020a25a4c01b67a73b888883752b3e0d3341a4fcb16d1221c3c3879a23',
};

/**
 * What bff6d4ec wrote for the review-r2 inputs, captured at that commit
 * (`$EPIC/evidence/1957/capture-r2.mts.txt`).
 */
const BASE_R2 = {
  comment33ForwardSha: '2b5302eb304f8ee6f56823259312b094a99b327b4b0d29f3bfe9ddb88f5d88e3',
  mixedRawWriteSha: '40205edeb6c294cf5d367b0a6484525cf5294c65cc9f3dd904693a2bd4ade631',
  draftSentSha: '5a68727a9b4e101795eecc0b0a722cea2f1ff4bc56a97ee32d3e597375023982',
  draftIds: ['1', '134', ...Array.from({ length: 33 }, (_, index) => String(101 + index))],
};

/**
 * What bff6d4ec wrote for the review-r3 inputs, captured at that commit
 * (`$EPIC/evidence/1957/capture-r3.mts.txt`).
 */
const BASE_R3 = {
  shallowCodeForward: '2c1c13125136827c05ac1f24f5d283ec0c5dbde66e03b8db94d18f1764b522ce',
  toc32Forward: '21483a0f1398b5bb38055e5eb3a517f392c1d2479c3595e320c10beeda222cd0',
  panel32Forward: 'df7bebd4be8030a733097ce2ea409b65b05d67e4026948d1fcba11577d02cef1',
  tocWrite: 'bc932bcd18b3795e5e3e5012bdda7da1ca45a70fd6d3f7b19ceb1347506a5f5f',
  wrap33Write: 'ae5d0bed50f28a56827c14b9160801ae79e172503b610997f43e9dbf607eb6b6',
};

/**
 * What bff6d4ec wrote for the review-r4 inputs, captured at that commit
 * (`$EPIC/evidence/1957/capture-r4.mts.txt`).
 */
const BASE_R4 = {
  mixedForward: '16fea08ff469e879a3e09b4b0cec72547b9d859eb2a87e4a173e60126c0e13b0',
  codeBodyForward: '00b0f4d08be2b1b1c055f12eb5ff547250f8909a0bbe53aafee35a51ce6edd3d',
  wrappers33Forward: 'c8b402159953fe840e24b92d936a45b62348d07f940fbb3c11dcb6c497f4996c',
  previousMixedWrite: 'b556b9cadb417e2968c15213fd1b3810b84ad4cc33823cf83133b7f5bc9783cb',
};

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** `depth` editor task lists, each in the previous task's li; `innermost` ends the deepest task. */
function editorChain(depth: number, innermost = '', idBase = 0): string {
  let html = '';
  for (let level = depth; level >= 1; level -= 1) {
    html = `<ul data-type="taskList"><li data-type="taskItem" data-checked="false" data-task-id="${idBase + level}">`
      + `<p>t${level}</p>${level === depth ? innermost : ''}${html}</li></ul>`;
  }
  return html;
}

const STATUS = '<ac:structured-macro ac:name="status"><ac:parameter ac:name="colour">Green</ac:parameter>'
  + '<ac:parameter ac:name="title">DONE</ac:parameter></ac:structured-macro>';
const TOC = '<ac:structured-macro ac:name="toc"><ac:parameter ac:name="maxLevel">2</ac:parameter></ac:structured-macro>';

/** An `ac:task`; `id === null` writes none. */
function task(id: string | null, status: 'complete' | 'incomplete', body: string): string {
  return `<ac:task>${id === null ? '' : `<ac:task-id>${id}</ac:task-id>`}<ac:task-status>${status}</ac:task-status>`
    + `<ac:task-body>${body}</ac:task-body></ac:task>`;
}

function list(...tasks: string[]): string {
  return `<ac:task-list>${tasks.join('')}</ac:task-list>`;
}

/**
 * `depth` tasks, each nested in the previous one's body, each body holding
 * inline text, an inline status macro and a block toc macro.
 */
function chain(depth: number, body = (level: number) => `t${level} ${STATUS}${TOC}`): string {
  let storage = '';
  for (let level = depth; level >= 1; level -= 1) {
    storage = list(task(String(level), level % 2 === 0 ? 'complete' : 'incomplete', `${body(level)}${storage}`));
  }
  return storage;
}

/** `depth` task lists each placed directly in the previous list, after its task. */
function siblingChain(depth: number): string {
  let storage = '';
  for (let level = depth; level >= 1; level -= 1) {
    storage = `<ac:task-list>${task(String(level), 'incomplete', `t${level}`)}${storage}</ac:task-list>`;
  }
  return storage;
}

interface Item {
  id: string | null;
  checked: string | null;
  /** Task lists around the item: 1 for a top-level task. */
  depth: number;
  /** The item's own text, without its subtasks'. */
  text: string;
}

/** Every task item of `html` in document order. */
function items(html: string): Item[] {
  const doc = new JSDOM(`<body>${html}</body>`).window.document;
  return [...doc.querySelectorAll('li[data-type="taskItem"]')].map((li) => {
    let depth = 0;
    for (let el: Element | null = li; el; el = el.parentElement) {
      if (el.matches('ul[data-type="taskList"]')) depth += 1;
    }
    const own = li.cloneNode(true) as Element;
    for (const nested of own.querySelectorAll('ul[data-type="taskList"], label')) nested.remove();
    return {
      id: li.getAttribute('data-task-id'),
      checked: li.getAttribute('data-checked'),
      depth,
      text: (own.textContent ?? '').replace(/\s+/g, ' ').trim(),
    };
  });
}

interface StoredTask {
  id: string;
  status: string;
  depth: number;
  body: string;
}

/** Every `ac:task` of `xhtml` in document order: its own id, status, depth and body without subtasks. */
function storedTasks(xhtml: string): StoredTask[] {
  const doc = new JSDOM(`<body>${xhtml}</body>`).window.document;
  return [...doc.getElementsByTagName('ac:task')].map((el) => {
    const own = (tag: string) => [...el.children].find((child) => child.localName === tag);
    let depth = 0;
    for (let up: Element | null = el; up; up = up.parentElement) {
      if (up.localName === 'ac:task-list') depth += 1;
    }
    const body = own('ac:task-body')?.cloneNode(true) as Element | undefined;
    for (const nested of body ? [...body.getElementsByTagName('ac:task-list')] : []) nested.remove();
    return {
      id: own('ac:task-id')?.textContent ?? '',
      status: own('ac:task-status')?.textContent ?? '',
      depth,
      body: body?.innerHTML ?? '',
    };
  });
}

describe('content-converter: #1957 nested subtasks on sync-in', () => {
  describe('forward pass', () => {
    it('converts a subtask in ac:task-body to one nested list inside its parent, each task once', () => {
      const html = confluenceToHtml(NESTED_TASK_LIST_PAGE);
      expect(html).toBe(NESTED_TASK_LIST_HTML);
      expect(html).not.toContain('ac:');
      expect(items(html)).toEqual([
        { id: '11', checked: 'false', depth: 1, text: 'Release' },
        { id: '12', checked: 'true', depth: 2, text: 'Write notes DONE[Table of Contents]' },
        { id: '13', checked: 'false', depth: 2, text: 'Tag build' },
        { id: '14', checked: 'false', depth: 3, text: 'Push tag' },
        { id: '15', checked: 'false', depth: 1, text: 'Announce' },
      ]);
    });

    it('round trips nested tasks byte for byte at every depth, with several subtasks per parent', () => {
      expect(htmlToConfluence(confluenceToHtml(NESTED_TASK_LIST_PAGE))).toBe(NESTED_TASK_LIST_PAGE);
      const three = list(
        task('1', 'incomplete', `a${list(task('2', 'incomplete', `b${list(task('3', 'complete', 'c'))}`), task('4', 'complete', 'b2'))}`),
        task('5', 'incomplete', 'z'),
      );
      expect(htmlToConfluence(confluenceToHtml(three))).toBe(three);
    });

    it('keeps a subtask apart from a parent without an id of its own, and mints the parent above every id', () => {
      const storage = list(task(null, 'incomplete', `parent${list(task('8', 'complete', 'subtask'))}`));
      const html = confluenceToHtml(storage);
      expect(items(html)).toEqual([
        { id: null, checked: 'false', depth: 1, text: 'parent' },
        { id: '8', checked: 'true', depth: 2, text: 'subtask' },
      ]);
      expect(storedTasks(htmlToConfluence(html, { previousStorage: storage })).map(({ id, depth }) => [id, depth]))
        .toEqual([['9', 1], ['8', 2]]);
    });

    it('carries no subtask id that is not a Confluence task id, at any depth', () => {
      for (const value of ['x1', '007', '-1', '9223372036854775808']) {
        const storage = list(task('1', 'incomplete', `a${list(task('2', 'incomplete', `b${list(task(value, 'complete', 'c'))}`))}`));
        const deepest = items(confluenceToHtml(storage))[2]!;
        expect(deepest, value).toEqual({ id: null, checked: 'true', depth: 3, text: 'c' });
        expect(storedTasks(htmlToConfluence(confluenceToHtml(storage))).map((t) => t.id), value).toEqual(['1', '2', '3']);
      }
    });

    it('keeps a page whose storage an earlier save already polluted as it is: its duplicate is a real task', () => {
      expect(items(confluenceToHtml(POLLUTED_TASK_LIST_PAGE))).toEqual([
        { id: '1', checked: 'false', depth: 1, text: 'parent' },
        { id: '2', checked: 'true', depth: 2, text: 'sub' },
        { id: '3', checked: 'true', depth: 1, text: 'sub' },
      ]);
      expect(htmlToConfluence(confluenceToHtml(POLLUTED_TASK_LIST_PAGE))).toBe(POLLUTED_TASK_LIST_PAGE);
    });
  });

  describe('task lists that are not in a task body stay flat, byte for byte as before (bff6d4ec)', () => {
    const cases: Array<[name: string, storage: string, html: string]> = [
      [
        'a list placed directly in a list, after a task',
        list(task('1', 'incomplete', 'parent'), list(task('2', 'complete', `sub ${STATUS}`)), task('3', 'incomplete', 'next')),
        '<ul data-type="taskList"><li data-type="taskItem" data-checked="false" data-task-id="1">parent</li><li data-type="taskItem" data-checked="true" data-task-id="2">sub <span class="confluence-status" data-color="green">DONE</span></li><li data-type="taskItem" data-checked="false" data-task-id="3">next</li></ul>',
      ],
      [
        'a list placed directly in a list, before every task',
        list(list(task('2', 'complete', 'sub')), task('3', 'incomplete', 'next')),
        '<ul data-type="taskList"><li data-type="taskItem" data-checked="true" data-task-id="2">sub</li><li data-type="taskItem" data-checked="false" data-task-id="3">next</li></ul>',
      ],
      [
        'lists placed in lists two levels deep, with a block macro',
        list(task('1', 'incomplete', 'a'), list(task('2', 'complete', 'b'), list(task('3', 'complete', `c${TOC}`))), task('4', 'incomplete', 'd')),
        '<ul data-type="taskList"><li data-type="taskItem" data-checked="false" data-task-id="1">a</li><li data-type="taskItem" data-checked="true" data-task-id="2">b</li><li data-type="taskItem" data-checked="true" data-task-id="3">c<div class="confluence-toc" data-maxlevel="2">[Table of Contents]</div></li><li data-type="taskItem" data-checked="false" data-task-id="4">d</li></ul>',
      ],
      [
        'a task wrapped in another element',
        list(`<div>${task('1', 'incomplete', 'wrapped')}</div>`, task('2', 'incomplete', 'plain')),
        '<ul data-type="taskList"><li data-type="taskItem" data-checked="false" data-task-id="1">wrapped</li><li data-type="taskItem" data-checked="false" data-task-id="2">plain</li></ul>',
      ],
      [
        'a list in a task but outside its body',
        list(`<ac:task><ac:task-id>1</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>p</ac:task-body>${list(task('2', 'complete', 's'))}</ac:task>`),
        '<ul data-type="taskList"><li data-type="taskItem" data-checked="false" data-task-id="1">p</li><li data-type="taskItem" data-checked="true" data-task-id="2">s</li></ul>',
      ],
      [
        'tasks holding links, emoticons, tables, panels and macros',
        list(
          task('1', 'complete', `a <ac:link><ri:page ri:content-title="P" /></ac:link> <ac:emoticon ac:name="smile" /> ${TOC}`),
          task('2', 'incomplete', '<p>x</p><table><tbody><tr><td>c</td></tr></tbody></table>'),
          task('3', 'incomplete', `<ac:structured-macro ac:name="info"><ac:rich-text-body><p>panel ${STATUS}</p></ac:rich-text-body></ac:structured-macro>`),
        ),
        '<ul data-type="taskList"><li data-type="taskItem" data-checked="true" data-task-id="1">a <a href="#confluence-page:P" data-confluence-link="page">P</a> <span class="confluence-emoticon" data-emoticon-attrs="{&quot;ac:name&quot;:&quot;smile&quot;}" data-emoticon-label="🙂" role="img" aria-label="smile"></span> <div class="confluence-toc" data-maxlevel="2">[Table of Contents]</div></li><li data-type="taskItem" data-checked="false" data-task-id="2"><p>x</p><table><tbody><tr><td>c</td></tr></tbody></table></li><li data-type="taskItem" data-checked="false" data-task-id="3"><div class="panel-info"><p>panel <span class="confluence-status" data-color="green">DONE</span></p></div></li></ul>',
      ],
    ];
    for (const [name, storage, html] of cases) {
      it(name, () => {
        expect(confluenceToHtml(storage)).toBe(html);
      });
    }

    it('keeps every task of storage no editor writes, in source order', () => {
      // A list before the task's own body (bff6d4ec gave the outer task the
      // nested task's text) and a task in a body without a list.
      const listFirst = list(`<ac:task><ac:task-id>1</ac:task-id><ac:task-status>incomplete</ac:task-status>${list(task('2', 'complete', 'n'))}<ac:task-body>own</ac:task-body></ac:task>`);
      expect(items(confluenceToHtml(listFirst))).toEqual([
        { id: '1', checked: 'false', depth: 1, text: 'own' },
        { id: '2', checked: 'true', depth: 1, text: 'n' },
      ]);
      const stray = list(task('1', 'incomplete', `p${task('2', 'complete', 's')}`));
      expect(items(confluenceToHtml(stray)).map(({ id, depth, text }) => [id, depth, text]))
        .toEqual([['1', 1, 'p2complete'], ['2', 1, 's']]);
    });
  });

  describe('task ids (#1751) on nested tasks', () => {
    it('mints no id on an unchanged nested round trip, through the editor too', () => {
      const ids = storedTasks(NESTED_TASK_LIST_PAGE).map((t) => t.id);
      expect(storedTasks(htmlToConfluence(NESTED_TASK_LIST_HTML, { previousStorage: NESTED_TASK_LIST_PAGE })).map((t) => t.id)).toEqual(ids);
      expect(storedTasks(htmlToConfluence(NESTED_TASK_LIST_EDITOR_HTML, { previousStorage: NESTED_TASK_LIST_PAGE })).map((t) => t.id)).toEqual(ids);
    });

    it('gives an id-less subtask the stored id of its own text, not its parent\'s', () => {
      const target = '<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>Release</p>'
        + '<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>Push tag</p></li></ul></li></ul>';
      expect(storedTasks(htmlToConfluence(target, { previousStorage: NESTED_TASK_LIST_PAGE })).map(({ id, depth }) => [id, depth]))
        .toEqual([['11', 1], ['14', 2]]);
    });

    it('pairs the edited tasks of a nested page synced before ids were carried in order, and mints above when one was added', () => {
      const edited = (...texts: string[]) => {
        const [a, b, c] = texts;
        const extra = texts[3] === undefined ? '' : `<li data-type="taskItem" data-checked="false"><p>${texts[3]}</p></li>`;
        return `<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>${a}</p><ul data-type="taskList">`
          + `<li data-type="taskItem" data-checked="true"><p>${b}</p></li>${extra}</ul></li>`
          + `<li data-type="taskItem" data-checked="false"><p>${c}</p></li></ul>`;
      };
      const stored = list(task('1', 'incomplete', `Parent${list(task('2', 'complete', 'Child'))}`), task('3', 'incomplete', 'Sibling'));
      expect(storedTasks(htmlToConfluence(edited('Parent!', 'Child!', 'Sibling!'), { previousStorage: stored, legacyTasks: true })).map((t) => t.id))
        .toEqual(['1', '2', '3']);
      expect(storedTasks(htmlToConfluence(edited('Parent!', 'Child!', 'Sibling!', 'New'), { previousStorage: stored, legacyTasks: true })).map((t) => t.id))
        .toEqual(['4', '5', '6', '7']);
    });

    it('writes the body_html of a page synced before #1957 back as before (bff6d4ec)', () => {
      expect(htmlToConfluence(NESTED_TASK_LIST_LEGACY_HTML, { previousStorage: NESTED_TASK_LIST_PAGE })).toBe(
        '<p>Release checklist</p><ac:task-list><ac:task><ac:task-id>11</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>Release<ac:task-list><ac:task><ac:task-id>12</ac:task-id><ac:task-status>complete</ac:task-status><ac:task-body>Write notes <ac:structured-macro ac:name="status"><ac:parameter ac:name="colour">Green</ac:parameter><ac:parameter ac:name="title">DONE</ac:parameter></ac:structured-macro><ac:structured-macro ac:name="toc"><ac:parameter ac:name="maxLevel">2</ac:parameter></ac:structured-macro></ac:task-body></ac:task><ac:task><ac:task-id>13</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>Tag build<ac:task-list><ac:task><ac:task-id>14</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>Push tag</ac:task-body></ac:task></ac:task-list></ac:task-body></ac:task></ac:task-list></ac:task-body></ac:task><ac:task><ac:task-id>16</ac:task-id><ac:task-status>complete</ac:task-status><ac:task-body>Write notes <ac:structured-macro ac:name="status"><ac:parameter ac:name="colour">Green</ac:parameter><ac:parameter ac:name="title">DONE</ac:parameter></ac:structured-macro><ac:structured-macro ac:name="toc"><ac:parameter ac:name="maxLevel">2</ac:parameter></ac:structured-macro></ac:task-body></ac:task><ac:task><ac:task-id>17</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>Tag build<ac:task-list><ac:task><ac:task-id>14</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>Push tag</ac:task-body></ac:task></ac:task-list></ac:task-body></ac:task><ac:task><ac:task-id>18</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>Push tag</ac:task-body></ac:task><ac:task><ac:task-id>15</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>Announce</ac:task-body></ac:task></ac:task-list>',
      );
    });

    it('gives the unchanged tasks of a nested page their ids and statuses back after a Markdown cycle, which flattens them', async () => {
      // Turndown writes `- [ ]` without nesting or ids (pre-existing; not part of #1957).
      const back = await markdownToHtml(htmlToMarkdown(NESTED_TASK_LIST_HTML));
      const written = storedTasks(htmlToConfluence(back, { previousStorage: NESTED_TASK_LIST_PAGE }));
      const byText = new Map(written.map(({ id, status, body }) => [body.replace(/<[^>]+>/g, ''), [id, status]]));
      expect(['Release', 'Tag build', 'Push tag', 'Announce'].map((text) => byText.get(text))).toEqual([
        ['11', 'incomplete'],
        ['13', 'incomplete'],
        ['14', 'incomplete'],
        ['15', 'incomplete'],
      ]);
    });
  });

  describe(`the nesting limit (${MAX_TASK_LIST_NESTING} levels)`, () => {
    it('converts tasks nested exactly to the limit, with block and inline contents, and writes every one back', () => {
      const storage = chain(MAX_TASK_LIST_NESTING);
      const html = confluenceToHtml(storage);
      const converted = items(html);
      expect(converted).toHaveLength(MAX_TASK_LIST_NESTING);
      converted.forEach((item, index) => {
        expect(item).toEqual({
          id: String(index + 1),
          checked: index % 2 === 1 ? 'true' : 'false',
          depth: index + 1,
          text: `t${index + 1} DONE[Table of Contents]`,
        });
      });
      expect(htmlToConfluence(html)).toBe(storage);
    });

    it('converts one level more exactly as before #1957, without an error (bff6d4ec)', () => {
      const html = confluenceToHtml(chain(MAX_TASK_LIST_NESTING + 1));
      expect(sha256(html)).toBe(BASE.forward33Macros);
      // The pre-#1957 shape: the subtask list stays raw inside its parent and is listed again beside it.
      expect(html).toContain('<ac:task-list>');
      expect(sha256(confluenceToHtml(chain(MAX_TASK_LIST_NESTING + 1, (level) => `t${level}`)))).toBe(BASE.forward33Plain);
      // Lists placed in lists stay flat at any depth.
      expect(items(confluenceToHtml(siblingChain(MAX_TASK_LIST_NESTING + 50))).every((item) => item.depth === 1)).toBe(true);
    });

    it('indexes the page for placing tasks in one walk', () => {
      // One visit per element; placement only, the limit is decided syntactically.
      for (const depth of [1, 10, MAX_TASK_LIST_NESTING, MAX_TASK_LIST_NESTING + 1]) {
        expect(measureTaskListConversion(chain(depth, (level) => `t${level}`)), `depth ${depth}`)
          .toEqual({ depth, visited: 5 * depth, moved: 3 * depth - 1 });
      }
      // A task list shown as code is text, not nesting.
      const code = `<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[${'<ac:task-list>'.repeat(40)}]]></ac:plain-text-body></ac:structured-macro>`;
      expect(items(confluenceToHtml(`${code}${chain(2)}`)).map(({ id, depth }) => [id, depth])).toEqual([['1', 1], ['2', 2]]);
    });

    it('writes editor HTML nested one level more exactly as before #1957 (bff6d4ec)', () => {
      const html = editorChain(MAX_TASK_LIST_NESTING + 1);
      const previousStorage = chain(MAX_TASK_LIST_NESTING + 1, (level) => `t${level}`);
      expect(sha256(htmlToConfluence(html, { previousStorage }))).toBe(BASE.writeBack33);
      expect(htmlToConfluence(html, { previousStorage }))
        .toBe(htmlToConfluence(html, { previousStorage, derivationFeatures: NO_STORAGE_DERIVATION_FEATURES }));
      expect(storedTasks(htmlToConfluence(editorChain(MAX_TASK_LIST_NESTING)))).toHaveLength(MAX_TASK_LIST_NESTING);
    });

    it('counts a raw subtask list an old body still holds, and reads its storage back as before (bff6d4ec)', () => {
      // 32 editor levels whose deepest task keeps the raw list a body synced before #1957 held.
      const html = editorChain(MAX_TASK_LIST_NESTING, '<ac:task-list><ac:task><ac:task-id>33</ac:task-id>'
        + '<ac:task-status>incomplete</ac:task-status><ac:task-body>raw</ac:task-body></ac:task></ac:task-list>');
      const storage = htmlToConfluence(html);
      expect(sha256(storage)).toBe(BASE.rawSublistWrite);
      expect(sha256(confluenceToHtml(storage))).toBe(BASE.rawSublistForward);
    });

    it('builds each task once: one destination per task and body node (a move count, not runtime)', () => {
      // Counted work, not time: JSDOM's own parse of a deep page is superlinear.
      let previous = { visited: 0, moved: 0 };
      for (const depth of [10, 20, MAX_TASK_LIST_NESTING, MAX_TASK_LIST_NESTING + 1, 100, 200]) {
        const work = measureTaskListConversion(chain(depth));
        // Per level: ac:task-list, ac:task, -id, -status, -body and the two
        // macros with their three parameters; moved: the text, both macros
        // and the subtask list into the li, then the li into its list.
        expect(work, `depth ${depth}`).toEqual({ depth, visited: 10 * depth, moved: 5 * depth - 1 });
        expect(work.visited).toBeGreaterThan(previous.visited);
        expect(work.moved).toBeGreaterThan(previous.moved);
        previous = work;
      }
      // Lists placed in lists join their kept list without regrouping: one move per body node and per task.
      expect(measureTaskListConversion(siblingChain(200))).toEqual({ depth: 1, visited: 1000, moved: 400 });
    });

    it('reads the stored tasks of deeper storage on write-back as before, so a page that saved before still saves', () => {
      const depth = MAX_TASK_LIST_NESTING + 1;
      const storage = chain(depth, (level) => `t${level}`);
      const target = `<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>t${depth}</p></li></ul>`;
      expect(storedTasks(htmlToConfluence(target, { previousStorage: storage })).map((t) => t.id)).toEqual([String(depth)]);
      expect(storedTasks(htmlToConfluence(target, {
        previousStorage: storage,
        derivationFeatures: NO_STORAGE_DERIVATION_FEATURES,
      })).map((t) => t.id)).toEqual([String(depth)]);
    });
  });

  describe('one limit decision per document, shared by every writer (review r2, decision D13a)', () => {
    const entry = STORAGE_DERIVATION_BASE_CORPUS.find((candidate) => candidate.name === 'tasks-list-before-own-body')!;
    const previousStorage = entry.previousStorage!;
    const RAW_133 = '<ac:task-list><ac:task><ac:task-id>133</ac:task-id><ac:task-status>incomplete</ac:task-status>'
      + '<ac:task-body>raw</ac:task-body></ac:task></ac:task-list>';
    /** ids written for the corpus entry's two id-less tasks `n` and `own`. */
    const ownIds = (storage: string) => storedTasks(storage).filter((t) => t.depth === 1).slice(0, 2).map((t) => t.id);

    it('reads a task-list spelling inside a comment as text: 32 real levels still nest', () => {
      const storage = chain(MAX_TASK_LIST_NESTING, (level) => (level === 1 ? 't1<!-- <ac:task-list> -->' : `t${level}`));
      const html = confluenceToHtml(storage);
      expect(items(html).map(({ id, depth }) => [id, depth]))
        .toEqual(Array.from({ length: MAX_TASK_LIST_NESTING }, (_, index) => [String(index + 1), index + 1]));
      expect(new JSDOM(`<body>${html}</body>`).window.document.getElementsByTagName('ac:task-list')).toHaveLength(0);
    });

    it('reads a closing spelling inside a comment as text: 33 real levels convert as before (bff6d4ec)', () => {
      const storage = chain(MAX_TASK_LIST_NESTING + 1, (level) => (level === 1 ? 't1<!-- </ac:task-list> -->' : `t${level}`));
      expect(sha256(confluenceToHtml(storage))).toBe(BASE_R2.comment33ForwardSha);
    });

    it('counts lists placed directly in a list: a subtask beside 33 of them converts as before #1957 (D13b, bff6d4ec)', () => {
      const beside = (wrappers: number) => list(
        task('1', 'incomplete', `parent${list(task('2', 'incomplete', 'child'))}`),
        `${'<ac:task-list>'.repeat(wrappers)}${'</ac:task-list>'.repeat(wrappers)}`,
      );
      expect(sha256(confluenceToHtml(beside(MAX_TASK_LIST_NESTING + 1)))).toBe(BASE_R4.wrappers33Forward);
      // Within the limit the wrappers stay flat and the real subtask nests.
      expect(items(confluenceToHtml(beside(MAX_TASK_LIST_NESTING - 1))).map(({ id, depth }) => [id, depth])).toEqual([['1', 1], ['2', 2]]);
    });

    it('does not count a subtree write-back removes: an index of 33 levels leaves the profile alone', () => {
      const plain = htmlToConfluence(entry.targetHtml, { previousStorage });
      const indexed = htmlToConfluence(
        `${entry.targetHtml}<div class="figure-index">${editorChain(MAX_TASK_LIST_NESTING + 1)}</div>`,
        { previousStorage },
      );
      expect(indexed).toBe(plain);
      // The control: the two profiles write different ids for this target.
      expect(ownIds(plain)).toEqual(['2', '1']);
      expect(ownIds(htmlToConfluence(entry.targetHtml, { previousStorage, derivationFeatures: NO_STORAGE_DERIVATION_FEATURES })))
        .toEqual(['1', '3']);
    });

    it('counts editor and raw lists together: 32 editor levels and a raw one write the ids of before #1957 (bff6d4ec)', () => {
      const deep = htmlToConfluence(`${entry.targetHtml}${editorChain(MAX_TASK_LIST_NESTING, RAW_133, 100)}`, { previousStorage });
      expect(sha256(deep)).toBe(BASE_R2.mixedRawWriteSha);
      expect(ownIds(deep)).toEqual(['1', '134']);
      // Without the raw list the page is within the limit and gets the #1957 ids.
      expect(ownIds(htmlToConfluence(`${entry.targetHtml}${editorChain(MAX_TASK_LIST_NESTING, '', 100)}`, { previousStorage })))
        .toEqual(['2', '1']);
    });

    it('decides once for assignTaskIds and htmlToConfluence: a 33-level draft gets the ids of before #1957 (bff6d4ec)', () => {
      const draft = `${entry.targetHtml}${editorChain(MAX_TASK_LIST_NESTING + 1, '', 100)}`;
      const assigned = assignTaskIds(draft, { previousStorage, legacyTasks: false });
      expect(assigned.taskIds).toEqual(BASE_R2.draftIds);
      expect(sha256(htmlToConfluence(assigned.html))).toBe(BASE_R2.draftSentSha);
      expect(storedTasks(htmlToConfluence(draft, { previousStorage })).map((t) => t.id)).toEqual(BASE_R2.draftIds);
    });
  });

  describe('the limit is syntactic: it may overcount, never undercount (review r3, decision D13b)', () => {
    const entry = STORAGE_DERIVATION_BASE_CORPUS.find((candidate) => candidate.name === 'tasks-list-before-own-body')!;
    const opts = { previousStorage: entry.previousStorage!, legacyTasks: false };
    const BASE_OPTS = { ...opts, derivationFeatures: NO_STORAGE_DERIVATION_FEATURES };
    const plain = (id: string, body: string) => task(id, 'incomplete', body);
    /** `depth` tasks, each in the previous one's body; `innermost` ends the deepest body (as captured at bff6d4ec). */
    const deep = (depth: number, innermost = '') => {
      let storage = '';
      for (let level = depth; level >= 1; level -= 1) {
        storage = list(plain(String(level), `t${level}${level === depth ? innermost : ''}${storage}`));
      }
      return storage;
    };
    const macro = (name: string, rich: string) => `<ac:structured-macro ac:name="${name}"><ac:rich-text-body>${rich}</ac:rich-text-body></ac:structured-macro>`;
    const code = (inner: string) => '<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[documented text]]></ac:plain-text-body>'
      + `${inner}</ac:structured-macro>`;
    /** `depth` editor lists, each directly in the previous ul after its li. */
    const wrappers = (depth: number, idBase: number) => {
      let html = '';
      for (let level = depth; level >= 1; level -= 1) {
        html = `<ul data-type="taskList"><li data-type="taskItem" data-checked="false" data-task-id="${idBase + level}"><p>w${level}</p></li>${html}</ul>`;
      }
      return html;
    };
    const editorTask = (id: number, text: string) => `<ul data-type="taskList"><li data-type="taskItem" data-checked="false" data-task-id="${id}"><p>${text}</p></li></ul>`;
    const ownIds = (storage: string) => storedTasks(storage).filter((t) => t.depth === 1).slice(0, 2).map((t) => t.id);
    /** Task-list nesting by ancestry: editor and raw lists, outside the indexes write-back removes. */
    const syntacticDepth = (html: string) => {
      let deepest = 0;
      const doc = new JSDOM(`<body>${html}</body>`).window.document;
      for (const el of doc.body.getElementsByTagName('*')) {
        if (el.localName !== 'ac:task-list' && !el.matches('ul[data-type="taskList"]')) continue;
        if (el.closest('div.figure-index, div.table-index')) continue;
        let depth = 0;
        for (let up: Element | null = el; up; up = up.parentElement) {
          if (up.localName === 'ac:task-list' || up.matches('ul[data-type="taskList"]')) depth += 1;
        }
        deepest = Math.max(deepest, depth);
      }
      return deepest;
    };
    const storageDepth = (storage: string) => Math.max(0, ...storedTasks(storage).map((t) => t.depth));

    it('never brings back a task the code step discards (bff6d4ec)', () => {
      const storage = list(plain('1', 'keep'), code(list(plain('2', 'discard'))));
      const html = confluenceToHtml(storage);
      expect(sha256(html)).toBe(BASE_R3.shallowCodeForward);
      expect(items(html).map(({ id, text }) => [id, text])).toEqual([['1', 'keep']]);
    });

    it('counts a list a macro discards or keeps alike: 32 levels and one more in a toc or a panel convert as before (bff6d4ec)', () => {
      expect(sha256(confluenceToHtml(deep(MAX_TASK_LIST_NESTING, macro('toc', list(plain('33', 'in toc')))))))
        .toBe(BASE_R3.toc32Forward);
      expect(sha256(confluenceToHtml(deep(MAX_TASK_LIST_NESTING, macro('info', list(plain('33', 'in panel')))))))
        .toBe(BASE_R3.panel32Forward);
    });

    it('writes a page with one more level in a toc placeholder exactly as before #1957, ids included (bff6d4ec)', () => {
      const toc = `<div class="confluence-toc">${editorTask(133, 'in toc')}</div>`;
      const written = htmlToConfluence(`${entry.targetHtml}${editorChain(MAX_TASK_LIST_NESTING, toc, 100)}`, opts);
      expect(sha256(written)).toBe(BASE_R3.tocWrite);
      expect(ownIds(written)).toEqual(['1', '134']);
      // Within the limit, the #1957 profile gives the same two tasks other ids.
      expect(ownIds(htmlToConfluence(`${entry.targetHtml}${editorChain(MAX_TASK_LIST_NESTING, '', 100)}`, opts))).toEqual(['2', '1']);
    });

    it('counts lists placed directly in a list on write-back: 33 of them write as before #1957 (bff6d4ec)', () => {
      const written = htmlToConfluence(`${entry.targetHtml}${wrappers(MAX_TASK_LIST_NESTING + 1, 100)}`, opts);
      expect(sha256(written)).toBe(BASE_R3.wrap33Write);
      expect(ownIds(written)).toEqual(['1', '134']);
      expect(ownIds(htmlToConfluence(`${entry.targetHtml}${wrappers(MAX_TASK_LIST_NESTING, 100)}`, opts))).toEqual(['2', '1']);
    });

    it('decides write-back on syntactic depth: past 32 the base output, within it no deeper output than counted', () => {
      const shapes: Record<string, (depth: number) => string> = {
        chain: (depth) => editorChain(depth, '', 100),
        toc: (depth) => editorChain(depth - 1, `<div class="confluence-toc">${editorTask(200, 'toc')}</div>`, 100),
        panel: (depth) => editorChain(depth - 1, `<div class="panel-info">${editorTask(200, 'panel')}</div>`, 100),
        expand: (depth) => editorChain(depth - 1, `<details data-macro-name="expand"><summary></summary>${editorTask(200, 'expand')}</details>`, 100),
        code: (depth) => editorChain(depth - 1, `<pre><code>${editorTask(200, 'code')}</code></pre>`, 100),
        raw: (depth) => editorChain(depth - 1, list(plain('200', 'raw')), 100),
        wrappers: (depth) => wrappers(depth, 100),
        comment: (depth) => editorChain(depth, '<!-- <ul data-type="taskList"><ul data-type="taskList"> -->', 100),
        index: (depth) => `${editorChain(2, '', 300)}<div class="figure-index">${editorChain(depth, '', 100)}</div>`,
      };
      for (const [name, shape] of Object.entries(shapes)) {
        for (const depth of [MAX_TASK_LIST_NESTING, MAX_TASK_LIST_NESTING + 1]) {
          const html = `${entry.targetHtml}${shape(depth)}`;
          const counted = syntacticDepth(html);
          const written = htmlToConfluence(html, opts);
          const label = `${name} ${depth} (counted ${counted})`;
          if (counted > MAX_TASK_LIST_NESTING) {
            expect(written, label).toBe(htmlToConfluence(html, BASE_OPTS));
            expect(assignTaskIds(html, opts).taskIds, label).toEqual(assignTaskIds(html, BASE_OPTS).taskIds);
          } else {
            expect(storageDepth(written), label).toBeLessThanOrEqual(counted);
          }
        }
      }
    }, 300_000);

    /**
     * Forward fixtures with their syntactic nesting stated by the builder (task
     * lists by ancestry, editor and raw, empty ones included; D13b), not by
     * the converter. `depth` is the deepest list.
     */
    const forwardFixtures = (depth: number): Record<string, string> => ({
      chain: deep(depth),
      toc: deep(depth - 1, macro('toc', list(plain('200', 'toc')))),
      panel: deep(depth - 1, macro('info', list(plain('200', 'panel')))),
      code: deep(depth - 1, code(list(plain('200', 'code')))),
      comment: deep(depth, '<!-- <ac:task-list><ac:task-list> -->'),
      empty: deep(depth - 1, '<ac:task-list></ac:task-list>'),
      wrappers: list(plain('500', 'p'), `${'<ac:task-list>'.repeat(depth - 1)}${'</ac:task-list>'.repeat(depth - 1)}`),
      mixed: `<ul data-type="taskList"><li data-type="taskItem" data-checked="false" data-task-id="500"><p>e</p>${deep(depth - 1)}</li></ul>`,
      codeBody: '<ac:task-list><ac:task><ac:task-id>500</ac:task-id><ac:task-status>incomplete</ac:task-status>'
        + `${code('<ac:task-body>stray</ac:task-body>')}<ac:task-body>real${deep(depth - 1)}</ac:task-body></ac:task></ac:task-list>`,
    });
    /** Deepest editor-list nesting of `html`, empty lists included. */
    const htmlListDepth = (html: string) => {
      let deepest = 0;
      const doc = new JSDOM(`<body>${html}</body>`).window.document;
      for (const ul of doc.querySelectorAll('ul[data-type="taskList"]')) {
        let depth = 0;
        for (let up: Element | null = ul; up; up = up.parentElement) if (up.matches('ul[data-type="taskList"]')) depth += 1;
        deepest = Math.max(deepest, depth);
      }
      return deepest;
    };
    /** Where `convert` breaks D13b on the fixtures at 32 and 33 levels. */
    const forwardViolations = (convert: (storage: string) => string): string[] => {
      const violations: string[] = [];
      for (const depth of [MAX_TASK_LIST_NESTING, MAX_TASK_LIST_NESTING + 1]) {
        for (const [name, storage] of Object.entries(forwardFixtures(depth))) {
          const html = convert(storage);
          if (depth > MAX_TASK_LIST_NESTING) {
            if (html !== _confluenceToHtmlWithForTest(storage, NO_STORAGE_DERIVATION_FEATURES)) violations.push(`${name} ${depth}: not the base output`);
          } else if (htmlListDepth(html) > depth || new JSDOM(`<body>${html}</body>`).window.document.getElementsByTagName('ac:task-list').length > 0) {
            violations.push(`${name} ${depth}: not converted within the limit`);
          }
        }
      }
      return violations;
    };

    it('decides the forward pass on the syntactic depth: past 32 the base output, within it no deeper output', () => {
      expect(forwardViolations((storage) => confluenceToHtml(storage))).toEqual([]);
    }, 300_000);

    it('catches a converter that undercounts by one, everywhere or only for a code macro (review r4 mutations)', () => {
      const onePastTheLimit = (storage: string) => _confluenceToHtmlWithForTest(storage, ALL_STORAGE_DERIVATION_FEATURES, MAX_TASK_LIST_NESTING + 1);
      expect(forwardViolations(onePastTheLimit)).toEqual(expect.arrayContaining(['chain 33: not the base output']));
      const code33 = forwardFixtures(MAX_TASK_LIST_NESTING + 1).code;
      const selective = (storage: string) => (storage === code33 ? onePastTheLimit(storage) : confluenceToHtml(storage));
      expect(forwardViolations(selective)).toEqual(['code 33: not the base output']);
    }, 300_000);
  });

  describe('the forward limit counts editor and raw lists by ancestry (review r4, decision D13b)', () => {
    const entry = STORAGE_DERIVATION_BASE_CORPUS.find((candidate) => candidate.name === 'tasks-list-before-own-body')!;
    /** `depth` raw levels with ids idBase+1…idBase+depth, as captured at bff6d4ec. */
    const raw = (depth: number, idBase: number) => {
      let storage = '';
      for (let level = depth; level >= 1; level -= 1) storage = list(task(String(idBase + level), 'incomplete', `t${idBase + level}${storage}`));
      return storage;
    };
    /** One editor task enclosing 32 raw levels: 33 syntactically, 32 by subtask ownership. */
    const mixed = `<ul data-type="taskList"><li data-type="taskItem" data-checked="false" data-task-id="100"><p>e</p>${raw(32, 100)}</li></ul>`;

    it('converts an editor task enclosing 32 raw levels as before #1957 (bff6d4ec)', () => {
      expect(sha256(confluenceToHtml(mixed))).toBe(BASE_R4.mixedForward);
    });

    it('converts a task whose code macro holds a stray body before its 32-level body as before #1957 (bff6d4ec)', () => {
      const storage = '<ac:task-list><ac:task><ac:task-id>1</ac:task-id><ac:task-status>incomplete</ac:task-status>'
        + '<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[x]]></ac:plain-text-body><ac:task-body>stray</ac:task-body>'
        + `</ac:structured-macro><ac:task-body>real${raw(32, 1)}</ac:task-body></ac:task></ac:task-list>`;
      expect(sha256(confluenceToHtml(storage))).toBe(BASE_R4.codeBodyForward);
    });

    it('reads stored tasks nested 33 deep in mixed form as before #1957: write-back keeps the ids of then (bff6d4ec)', () => {
      const written = htmlToConfluence(entry.targetHtml, { previousStorage: `${entry.previousStorage}${mixed}` });
      expect(sha256(written)).toBe(BASE_R4.previousMixedWrite);
      expect(storedTasks(written).map((t) => t.id)).toEqual(['1', '133']);
    });
  });

  describe('collab TipTap schema and a collaborative round trip', () => {
    it('keeps a nested task list with a subtask macro through the collab schema', () => {
      expect(yDocToHtml(htmlToYDoc(NESTED_TASK_LIST_HTML))).toBe(NESTED_TASK_LIST_EDITOR_HTML);
    });

    it('keeps script and event-handler canaries out of a nested task, while its content and nesting stay', () => {
      // The same input and expectation as the frontend's Editor and ArticleViewer cases (#1957 M3).
      const html = '<ul data-type="taskList"><li data-type="taskItem" data-checked="false" data-task-id="1">parent'
        + '<ul data-type="taskList"><li data-type="taskItem" data-checked="true" data-task-id="2">safe '
        + '<img src="https://example.com/a.png" onerror="alert(1)"><script>alert(2)</script>'
        + '<a href="javascript:alert(3)">link</a> <span onmouseover="alert(4)">hover</span>'
        + '<div class="confluence-toc" data-maxlevel="2" onclick="alert(5)">[Table of Contents]</div></li></ul></li></ul>';
      const saved = yDocToHtml(htmlToYDoc(html));
      for (const canary of ['onerror', '<script', 'javascript:', 'onmouseover', 'onclick', 'alert(']) {
        expect(saved, canary).not.toContain(canary);
      }
      expect(items(saved).map(({ id, checked, depth }) => [id, checked, depth])).toEqual([['1', 'false', 1], ['2', 'true', 2]]);
      const doc = new JSDOM(`<body>${saved}</body>`).window.document;
      const sub = doc.querySelector('li[data-task-id="2"]')!;
      expect(sub.textContent).toContain('safe');
      expect(sub.textContent).toContain('link');
      expect(sub.textContent).toContain('hover');
      expect(sub.querySelector('.confluence-toc')).not.toBeNull();
      expect(sub.querySelector('img')?.getAttribute('src')).toBe('https://example.com/a.png');
    });

    it('writes every id, status, body and macro back once at its depth after an unrelated edit', () => {
      const doc = new Y.Doc();
      applyHtmlToYDoc(doc, NESTED_TASK_LIST_HTML);
      expect(collabCarriesTaskIds(doc)).toBe(true);
      const intro = doc.getXmlFragment('default').get(0);
      if (!(intro instanceof Y.XmlElement)) throw new Error('the page must open with a paragraph');
      const text = intro.get(0);
      if (!(text instanceof Y.XmlText)) throw new Error('the opening paragraph must hold text');
      text.insert(text.length, ' (edited)');

      const saved = yDocToHtml(doc);
      const assigned = assignTaskIds(saved, { previousStorage: NESTED_TASK_LIST_PAGE });
      expect(collabTaskItems(doc).map((item) => item.taskId)).toEqual(assigned.taskIds);
      expect(storedTasks(htmlToConfluence(assigned.html))).toEqual([
        { id: '11', status: 'incomplete', depth: 1, body: '<p>Release</p>' },
        { id: '12', status: 'complete', depth: 2, body: `<p>Write notes ${STATUS}</p>${TOC}` },
        { id: '13', status: 'incomplete', depth: 2, body: '<p>Tag build</p>' },
        { id: '14', status: 'incomplete', depth: 3, body: '<p>Push tag</p>' },
        { id: '15', status: 'incomplete', depth: 1, body: '<p>Announce</p>' },
      ]);
      expect(htmlToConfluence(assigned.html)).toContain('<p>Release checklist (edited)</p>');
    });

    it('marks a depth-3 task item by its Yjs identity', () => {
      const doc = htmlToYDoc(NESTED_TASK_LIST_HTML.replace(' data-task-id="14"', ''));
      const item = collabTaskItems(doc)[3]!;
      expect(item.taskId).toBeNull();
      expect(markTaskIds(doc, [{ client: item.client, clock: item.clock, taskId: '14' }], 'test')).toBe(1);
      expect(items(yDocToHtml(doc))[3]).toEqual({ id: '14', checked: 'false', depth: 3, text: 'Push tag' });
    });

    it('keeps the text and the block macro of a flat task, which the stock rule cut to the macro', () => {
      const html = confluenceToHtml(list(task('1', 'incomplete', `text ${STATUS}${TOC}`)));
      expect(htmlToConfluence(yDocToHtml(htmlToYDoc(html)))).toBe(
        list(task('1', 'incomplete', `<p>text ${STATUS}</p>${TOC}`)),
      );
    });

    it('keeps a task body that opens with a block in its task, after an empty first paragraph', () => {
      for (const [opening, written] of [
        [TOC, TOC],
        ['<pre><code>x</code></pre>', '<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[x]]></ac:plain-text-body></ac:structured-macro>'],
        [list(task('2', 'complete', 'sub')), list(task('2', 'complete', '<p>sub</p>'))],
      ] as const) {
        const html = confluenceToHtml(list(task('1', 'incomplete', `${opening}after`)));
        const saved = yDocToHtml(htmlToYDoc(html));
        expect(items(saved)[0], opening).toMatchObject({ id: '1', depth: 1 });
        expect(htmlToConfluence(saved), opening).toBe(list(task('1', 'incomplete', `<p></p>${written}<p>after</p>`)));
      }
    });

    it(`keeps ${MAX_TASK_LIST_NESTING} levels and every id through the collab schema and write-back`, () => {
      const storage = chain(MAX_TASK_LIST_NESTING);
      const saved = yDocToHtml(htmlToYDoc(confluenceToHtml(storage)));
      expect(items(saved).map(({ id, depth }) => [id, depth]))
        .toEqual(Array.from({ length: MAX_TASK_LIST_NESTING }, (_, index) => [String(index + 1), index + 1]));
      expect(storedTasks(htmlToConfluence(saved, { previousStorage: storage })).map(({ id, status, depth }) => [id, status, depth]))
        .toEqual(storedTasks(storage).map(({ id, status, depth }) => [id, status, depth]));
    });
  });
});
