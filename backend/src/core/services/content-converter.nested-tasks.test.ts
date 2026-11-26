/**
 * #1957: a Confluence subtask nests inside its parent task, once, at its own
 * depth — through the forward pass, both TipTap schemas (the backend collab
 * schema here; the frontend one in Editor.test.tsx and ArticleViewer.test.tsx)
 * and write-back. Task lists that are not in a task body stay flat, exactly as
 * before. Nesting deeper than MAX_TASK_LIST_NESTING is refused, never
 * flattened, and only where the HTML is kept: write-back reads stored tasks at
 * any depth. Literals marked "bff6d4ec" were captured at that commit.
 */
import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import * as Y from 'yjs';
import {
  ConfluenceTaskNestingError,
  MAX_TASK_LIST_NESTING,
  assignTaskIds,
  confluenceToHtml,
  htmlToConfluence,
  measureTaskListConversion,
} from './content-converter.js';
import { applyHtmlToYDoc, collabCarriesTaskIds, collabTaskItems, htmlToYDoc, markTaskIds, yDocToHtml } from './collab-schema.js';
import { NO_STORAGE_DERIVATION_FEATURES } from './storage-derivation.js';
import {
  NESTED_TASK_LIST_EDITOR_HTML,
  NESTED_TASK_LIST_HTML,
  NESTED_TASK_LIST_LEGACY_HTML,
  NESTED_TASK_LIST_PAGE,
  POLLUTED_TASK_LIST_PAGE,
} from './__fixtures__/confluence-xhtml.js';

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

    it('refuses one level more with a typed error, not a flattened page', () => {
      const storage = chain(MAX_TASK_LIST_NESTING + 1);
      expect(() => confluenceToHtml(storage)).toThrow(ConfluenceTaskNestingError);
      expect(() => confluenceToHtml(storage)).toThrow(`nest ${MAX_TASK_LIST_NESTING + 1} levels deep`);
      // The limit counts subtask lists, not lists placed in lists, which stay flat.
      expect(items(confluenceToHtml(siblingChain(MAX_TASK_LIST_NESTING + 50))).every((item) => item.depth === 1)).toBe(true);
    });

    it('refuses to write editor HTML nested one level more, so Confluence never holds a page sync would refuse', () => {
      let html = '';
      for (let level = MAX_TASK_LIST_NESTING + 1; level >= 1; level -= 1) {
        html = `<ul data-type="taskList"><li data-type="taskItem" data-checked="false" data-task-id="${level}"><p>t${level}</p>${html}</li></ul>`;
      }
      expect(() => htmlToConfluence(html)).toThrow(ConfluenceTaskNestingError);
      expect(new ConfluenceTaskNestingError(MAX_TASK_LIST_NESTING + 1).statusCode).toBe(422);
      const atLimit = html.replace(/<ul data-type="taskList"><li[^>]*data-task-id="1"><p>t1<\/p>(.*)<\/li><\/ul>$/, '$1');
      expect(storedTasks(htmlToConfluence(atLimit))).toHaveLength(MAX_TASK_LIST_NESTING);
      // A restore reserved before nested-tasks wrote such HTML and still derives it.
      expect(storedTasks(htmlToConfluence(html, { derivationFeatures: NO_STORAGE_DERIVATION_FEATURES }))).toHaveLength(MAX_TASK_LIST_NESTING + 1);
    });

    it('does linear work however deep the tasks nest: each element indexed once, each node moved once', () => {
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

    it('reads the stored tasks of deeper storage on write-back, so a page that saved before still saves', () => {
      const depth = MAX_TASK_LIST_NESTING * 4;
      const storage = chain(depth, (level) => `t${level}`);
      const target = `<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>t${depth}</p></li></ul>`;
      expect(storedTasks(htmlToConfluence(target, { previousStorage: storage })).map((t) => t.id)).toEqual([String(depth)]);
    });

    it('reads them with the loop before #1957 for a restore reserved without nested-tasks, which never refuses', () => {
      const depth = MAX_TASK_LIST_NESTING + 1;
      const storage = chain(depth, (level) => `t${level}`);
      const target = `<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>t${depth}</p></li></ul>`;
      expect(storedTasks(htmlToConfluence(target, {
        previousStorage: storage,
        derivationFeatures: NO_STORAGE_DERIVATION_FEATURES,
      })).map((t) => t.id)).toEqual([String(depth)]);
    });
  });

  describe('collab TipTap schema and a collaborative round trip', () => {
    it('keeps a nested task list with a subtask macro through the collab schema', () => {
      expect(yDocToHtml(htmlToYDoc(NESTED_TASK_LIST_HTML))).toBe(NESTED_TASK_LIST_EDITOR_HTML);
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
