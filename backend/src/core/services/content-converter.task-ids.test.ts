/**
 * #1751: a Confluence task keeps its `ac:task-id` through the editor and
 * write-back. The forward pass carries the id in `data-task-id`; `taskItem`
 * declares it as `taskId` in both TipTap schemas (collab-schema.ts and the
 * frontend ConfluenceTaskItem — the parity test is one-way, so the frontend
 * declaration is pinned by Editor.test.tsx and ArticleViewer.test.tsx). The
 * reverse pass keeps a carried id (of two carriers of one id, the one with the
 * stored task's text); a task without one takes the stored id of its exact text,
 * and on a page synced before ids were carried (`legacyTasks`) the rest pair
 * with the stored tasks left in order when they are as many. Every other task
 * gets the next free number above every id in the document and the stored page.
 * Ids are 64-bit. The same HTML always gets the same ids. A task body is the
 * task's content, without the editor's checkbox.
 */
import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import * as Y from 'yjs';
import { confluenceToHtml, htmlToConfluence } from './content-converter.js';
import { applyHtmlToYDoc, collabTaskItems, htmlToYDoc, markTaskIds, yDocToHtml } from './collab-schema.js';

const TASKS =
  '<ac:task-list>'
  + '<ac:task><ac:task-id>42</ac:task-id><ac:task-status>complete</ac:task-status>'
  + '<ac:task-body>Ship it</ac:task-body></ac:task>'
  + '<ac:task><ac:task-id>7</ac:task-id><ac:task-status>incomplete</ac:task-status>'
  + '<ac:task-body>Write <strong>docs</strong></ac:task-body></ac:task>'
  + '</ac:task-list>';
const PAGE = `<p>Intro</p>${TASKS}`;

/**
 * confluenceToHtml(PAGE), byte for byte: the node contract. The frontend
 * Editor and ArticleViewer tests (#1751) load this exact string.
 */
const PAGE_HTML =
  '<p>Intro</p>'
  + '<ul data-type="taskList">'
  + '<li data-type="taskItem" data-checked="true" data-task-id="42">Ship it</li>'
  + '<li data-type="taskItem" data-checked="false" data-task-id="7">Write <strong>docs</strong></li>'
  + '</ul>';

interface StoredTask {
  id: string;
  status: string;
  body: string;
}

/** Every `ac:task` in document order (a subtask after its parent): its own id, status and body. */
function tasks(xhtml: string): StoredTask[] {
  const doc = new JSDOM(`<body>${xhtml}</body>`).window.document;
  return [...doc.getElementsByTagName('ac:task')].map((task) => {
    const own = (tag: string) => [...task.children].find((child) => child.tagName.toLowerCase() === tag);
    return {
      id: own('ac:task-id')?.textContent ?? '',
      status: own('ac:task-status')?.textContent ?? '',
      body: own('ac:task-body')?.innerHTML ?? '',
    };
  });
}

function taskIds(xhtml: string): string[] {
  return tasks(xhtml).map((task) => task.id);
}

/** A task list in the shape the converter and the imports write: `data-task-id` only when given. */
function taskList(...items: Array<[id: string | null, text: string]>): string {
  const lis = items.map(([id, text]) => {
    const carried = id === null ? '' : ` data-task-id="${id}"`;
    return `<li data-type="taskItem" data-checked="false"${carried}><p>${text}</p></li>`;
  });
  return `<ul data-type="taskList">${lis.join('')}</ul>`;
}

/** A task list as Confluence stores it. */
function storageOf(...items: Array<[id: number, text: string]>): string {
  return `<ac:task-list>${items.map(([id, text]) => `<ac:task><ac:task-id>${id}</ac:task-id>`
    + `<ac:task-status>incomplete</ac:task-status><ac:task-body>${text}</ac:task-body></ac:task>`).join('')}</ac:task-list>`;
}

/** `id:text` of every written task. */
function pairs(xhtml: string): string[] {
  return tasks(xhtml).map((task) => `${task.id}:${task.body.replace(/<[^>]+>/g, '')}`);
}

describe('content-converter: #1751 Confluence task ids survive write-back', () => {
  describe('htmlToConfluence(confluenceToHtml(x))', () => {
    it('carries ac:task-id into data-task-id (the node contract)', () => {
      expect(confluenceToHtml(PAGE)).toBe(PAGE_HTML);
    });

    it('keeps <ac:task-id>42</ac:task-id> through repeated round trips', () => {
      let storage = PAGE;
      for (let round = 1; round <= 3; round += 1) {
        storage = htmlToConfluence(confluenceToHtml(storage));
        expect(tasks(storage), `round ${round}`).toEqual([
          { id: '42', status: 'complete', body: 'Ship it' },
          { id: '7', status: 'incomplete', body: 'Write <strong>docs</strong>' },
        ]);
      }
      expect(storage).toContain('<ac:task-id>42</ac:task-id>');
    });

    it('carries a task\'s own id, trimmed, and no value that is not a task id', () => {
      expect(confluenceToHtml(
        '<ac:task-list>'
        + '<ac:task><ac:task-id> 9 </ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>a</ac:task-body></ac:task>'
        + '<ac:task><ac:task-id>x1</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>b</ac:task-body></ac:task>'
        + '<ac:task><ac:task-status>incomplete</ac:task-status><ac:task-body>c</ac:task-body></ac:task>'
        + '</ac:task-list>',
      )).toBe(
        '<ul data-type="taskList">'
        + '<li data-type="taskItem" data-checked="false" data-task-id="9">a</li>'
        + '<li data-type="taskItem" data-checked="false">b</li>'
        + '<li data-type="taskItem" data-checked="false">c</li>'
        + '</ul>',
      );
    });

    it('does not give a task without its own ac:task-id the id of a subtask in its body', () => {
      const html = confluenceToHtml(
        '<ac:task-list><ac:task><ac:task-status>incomplete</ac:task-status><ac:task-body>parent'
        + '<ac:task-list><ac:task><ac:task-id>8</ac:task-id><ac:task-status>complete</ac:task-status>'
        + '<ac:task-body>subtask</ac:task-body></ac:task></ac:task-list>'
        + '</ac:task-body></ac:task></ac:task-list>',
      );
      const lis = new JSDOM(`<body>${html}</body>`).window.document.querySelectorAll('li[data-type="taskItem"]');
      // The forward pass still hoists the subtask beside its parent (#1220 note);
      // only the parent's own (absent) id is this test's concern.
      expect([...lis].map((li) => [li.firstChild?.textContent, li.getAttribute('data-task-id')]))
        .toEqual([['parent', null], ['subtask', '8']]);
    });
  });

  describe('new tasks', () => {
    it('gives N new tasks N distinct ids (6,000 in one list)', () => {
      // Each id used to be Math.floor(Math.random() * 1e6) with no check:
      // 6,000 draws repeat one with probability 1 - e^-18.
      const n = 6000;
      const items = Array.from({ length: n }, (_, i): [null, string] => [null, `task ${i}`]);
      const ids = taskIds(htmlToConfluence(taskList(...items)));
      expect(ids).toHaveLength(n);
      expect(new Set(ids).size).toBe(n);
    });

    it('numbers new tasks 1, 2, 3 in document order when the document holds no id', () => {
      expect(taskIds(htmlToConfluence(taskList([null, 'a'], [null, 'b'], [null, 'c'])))).toEqual(['1', '2', '3']);
    });

    it('mints above the highest id in the document, never an id a later task keeps', () => {
      expect(taskIds(htmlToConfluence(taskList([null, 'new'], ['42', 'kept'], [null, 'newer']))))
        .toEqual(['43', '42', '44']);
      // Exactly, past 2^53 too: ids are compared and counted as integers, not floats.
      expect(taskIds(htmlToConfluence(taskList(['9007199254740993', 'kept'], [null, 'new']))))
        .toEqual(['9007199254740993', '9007199254740994']);
    });

    it('mints the same ids for the same HTML', () => {
      // The restore reconciler re-derives the storage of the restored version
      // and compares its digest with the one the request stored
      // (page-put-intent-reconciler.ts), so a page's storage must not vary.
      const html = taskList([null, 'a'], ['7', 'b'], [null, 'c']);
      expect(htmlToConfluence(html)).toBe(htmlToConfluence(html));
    });
  });

  describe('duplicate ids', () => {
    it('keeps the first carrier of an id and counts a later copy as new', () => {
      expect(taskIds(htmlToConfluence(taskList(['42', 'original'], ['42', 'pasted copy'], ['7', 'other']))))
        .toEqual(['42', '43', '7']);
    });

    it('counts a carried value that is not a Confluence task id as new', () => {
      expect(taskIds(htmlToConfluence(taskList(['abc', 'a'], ['007', 'b'], ['', 'c'], ['-1', 'd'], ['5', 'e']))))
        .toEqual(['6', '7', '8', '9', '5']);
    });

    it('never keeps or mints an id that raw ac:task-id storage in the document uses', () => {
      // A raw ac:task-list can reach body_html (the forward pass leaves a
      // subtask nested in ac:task-body raw); its id is written back as is.
      const html =
        '<ul data-type="taskList">'
        + '<li data-type="taskItem" data-checked="false" data-task-id="5">parent'
        + '<ac:task-list><ac:task><ac:task-id>6</ac:task-id><ac:task-status>incomplete</ac:task-status>'
        + '<ac:task-body>raw</ac:task-body></ac:task></ac:task-list></li>'
        + '<li data-type="taskItem" data-checked="false" data-task-id="6"><p>copy of raw</p></li>'
        + '<li data-type="taskItem" data-checked="false"><p>new</p></li>'
        + '</ul>';
      expect(taskIds(htmlToConfluence(html))).toEqual(['5', '6', '7', '8']);
    });

    it('gives an id carried twice to the task with the stored task\'s text, so tasks pasted above keep none of the page\'s ids', () => {
      const storedA = storageOf([1, 'Deploy service'], [2, 'Notify ops']);
      // Page B's tasks 1 and 2 pasted at the top of page A, as the editor
      // serializes them: TipTap keeps data-task-id on paste.
      const pasted = yDocToHtml(htmlToYDoc(confluenceToHtml(storedA).replace(
        '<ul data-type="taskList">',
        `${confluenceToHtml(storageOf([1, 'Review checklist'], [2, 'Sign off']))}<ul data-type="taskList">`,
      )));
      expect(pairs(htmlToConfluence(pasted, { previousStorage: storedA })))
        .toEqual(['3:Review checklist', '4:Sign off', '1:Deploy service', '2:Notify ops']);
      // Page A's task 1 copied above itself and the copy reworded.
      const copied = taskList(['1', 'Deploy canary'], ['1', 'Deploy service'], ['2', 'Notify ops']);
      expect(pairs(htmlToConfluence(copied, { previousStorage: storedA })))
        .toEqual(['3:Deploy canary', '1:Deploy service', '2:Notify ops']);
    });

    it('keeps an id carried twice on its first carrier when no carrier has the stored task\'s text', () => {
      const storedA = storageOf([1, 'Deploy service']);
      expect(pairs(htmlToConfluence(taskList(['1', 'Deploy canary'], ['1', 'Deploy all']), { previousStorage: storedA })))
        .toEqual(['1:Deploy canary', '2:Deploy all']);
    });

    it('gives a page synced before ids were carried its own ids before tasks pasted above that carry them', () => {
      // Page A's own tasks carry no id yet; page B's tasks 1 and 2 are pasted above them.
      const storedA = storageOf([1, 'Deploy service'], [2, 'Notify ops']);
      const body = taskList(['1', 'Review checklist'], ['2', 'Sign off'], [null, 'Deploy service'], [null, 'Notify ops']);
      expect(pairs(htmlToConfluence(body, { previousStorage: storedA, legacyTasks: true })))
        .toEqual(['3:Review checklist', '4:Sign off', '1:Deploy service', '2:Notify ops']);
    });
  });

  describe('task ids are 64-bit', () => {
    const oneTask = (id: string) => '<ac:task-list><ac:task>'
      + `<ac:task-id>${id}</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>a</ac:task-body>`
      + '</ac:task></ac:task-list>';

    it('does not carry a value longer or larger than 2^63 - 1, and writes its task back as new', () => {
      for (const value of ['9223372036854775808', '12345678901234567890', '9'.repeat(100_000)]) {
        expect(confluenceToHtml(oneTask(value)), value.slice(0, 20)).not.toContain('data-task-id');
        expect(taskIds(htmlToConfluence(taskList([value, 'a'], [null, 'b']))), value.slice(0, 20)).toEqual(['1', '2']);
      }
      expect(confluenceToHtml(oneTask('9223372036854775807'))).toContain('data-task-id="9223372036854775807"');
    });

    it('mints from the smallest free number once the next one would pass 2^63 - 1', () => {
      expect(taskIds(htmlToConfluence(taskList(['9223372036854775807', 'a'], [null, 'b'], ['1', 'c'], [null, 'd']))))
        .toEqual(['9223372036854775807', '2', '1', '3']);
    });

    it('writes a body with one oversized carried value and 1,000 new tasks back in bounded time and size', () => {
      // A 100,000-digit value used to make every new task's id that long.
      const html = taskList(['9'.repeat(100_000), 'pasted'], ...Array.from({ length: 1000 }, (_, i): [null, string] => [null, `t${i}`]));
      const started = performance.now();
      const xhtml = htmlToConfluence(html);
      expect(performance.now() - started).toBeLessThan(5_000);
      expect(xhtml.length).toBeLessThan(html.length);
      expect(new Set(taskIds(xhtml)).size).toBe(1001);
    });
  });

  describe('collab TipTap schema', () => {
    it('keeps the id through the collab schema round trip (htmlToYDoc → yDocToHtml on getCollabSchema())', () => {
      const saved = new JSDOM(`<body>${yDocToHtml(htmlToYDoc(PAGE_HTML))}</body>`).window.document;
      expect([...saved.querySelectorAll('li[data-type="taskItem"]')].map((li) => li.getAttribute('data-task-id')))
        .toEqual(['42', '7']);
    });

    it('keeps the ids through a collab load, an unrelated edit and write-back', () => {
      const doc = htmlToYDoc(confluenceToHtml(PAGE));
      // Type into the first paragraph, as a co-editor would; no task is touched.
      const intro = doc.getXmlFragment('default').get(0);
      if (!(intro instanceof Y.XmlElement)) throw new Error('PAGE must open with a paragraph');
      const text = intro.get(0);
      if (!(text instanceof Y.XmlText)) throw new Error('the opening paragraph must hold text');
      text.insert(text.length, ' (edited)');

      const saved = yDocToHtml(doc);
      expect(saved).toContain('<p>Intro (edited)</p>');
      expect(tasks(htmlToConfluence(saved))).toEqual([
        { id: '42', status: 'complete', body: '<p>Ship it</p>' },
        { id: '7', status: 'incomplete', body: '<p>Write <strong>docs</strong></p>' },
      ]);
    });

    it('writes the task content into ac:task-body, not the editor checkbox', () => {
      // TaskItem serializes <li><label><input type="checkbox"><span></span></label><div>content</div></li>.
      const xhtml = htmlToConfluence(yDocToHtml(htmlToYDoc(PAGE_HTML)));
      expect(tasks(xhtml).map((task) => task.body)).toEqual(['<p>Ship it</p>', '<p>Write <strong>docs</strong></p>']);
      expect(xhtml).not.toContain('<input');
      expect(xhtml).not.toContain('<label');
    });

    it('writes a subtask saved by the editor as an ac:task-list inside its parent\'s body', () => {
      const editorHtml = yDocToHtml(htmlToYDoc(
        '<ul data-type="taskList"><li data-type="taskItem" data-checked="false" data-task-id="1"><p>outer</p>'
        + '<ul data-type="taskList"><li data-type="taskItem" data-checked="true" data-task-id="2"><p>inner</p></li></ul>'
        + '</li></ul>',
      ));
      expect(htmlToConfluence(editorHtml)).toBe(
        '<ac:task-list><ac:task><ac:task-id>1</ac:task-id><ac:task-status>incomplete</ac:task-status>'
        + '<ac:task-body><p>outer</p>'
        + '<ac:task-list><ac:task><ac:task-id>2</ac:task-id><ac:task-status>complete</ac:task-status>'
        + '<ac:task-body><p>inner</p></ac:task-body></ac:task></ac:task-list>'
        + '</ac:task-body></ac:task></ac:task-list>',
      );
    });

    it('records in the document that its tasks carry ids when it is seeded from HTML whose tasks carry them, and only then', () => {
      const carried = (doc: Y.Doc): unknown => doc.getMap('compendiq.meta').get('confluenceTaskIds');
      const seeded = new Y.Doc();
      applyHtmlToYDoc(seeded, PAGE_HTML);
      expect(carried(seeded)).toBe(true);
      const legacy = new Y.Doc();
      applyHtmlToYDoc(legacy, PAGE_HTML.replace(/ data-task-id="\d+"/g, ''));
      expect(carried(legacy)).toBeUndefined();
      // The marks of a settled commit set it in their own transaction.
      const origins: unknown[] = [];
      legacy.on('update', (_update: Uint8Array, origin: unknown) => { origins.push(origin); });
      const [ship] = collabTaskItems(legacy);
      expect(markTaskIds(legacy, [{ client: ship!.client, clock: ship!.clock, taskId: '42' }], 'marks')).toBe(1);
      expect(carried(legacy)).toBe(true);
      expect(origins).toEqual(['marks']);
    });
  });

  describe('a page whose stored storage has ids (previousStorage)', () => {
    // The storage Confluence has for the page (pages.body_storage). Pages
    // written back before #1751 hold random ids like these.
    const STORED =
      '<p>Intro</p><ac:task-list>'
      + '<ac:task><ac:task-id>794464</ac:task-id><ac:task-status>complete</ac:task-status>'
      + '<ac:task-body>Ship it</ac:task-body></ac:task>'
      + '<ac:task><ac:task-id>12</ac:task-id><ac:task-status>incomplete</ac:task-status>'
      + '<ac:task-body>Write <strong>docs</strong></ac:task-body></ac:task>'
      + '</ac:task-list>';
    // body_html converted before ids were carried: the same tasks, no data-task-id.
    const UNCARRIED =
      '<p>Intro</p><ul data-type="taskList">'
      + '<li data-type="taskItem" data-checked="true">Ship it</li>'
      + '<li data-type="taskItem" data-checked="false">Write <strong>docs</strong></li>'
      + '</ul>';

    it('gives tasks converted before ids were carried their Confluence ids back, through the editor too', () => {
      expect(taskIds(htmlToConfluence(UNCARRIED, { previousStorage: STORED }))).toEqual(['794464', '12']);
      const edited = yDocToHtml(htmlToYDoc(UNCARRIED.replace('<p>Intro</p>', '<p>Intro (edited)</p>')));
      expect(tasks(htmlToConfluence(edited, { previousStorage: STORED }))).toEqual([
        { id: '794464', status: 'complete', body: '<p>Ship it</p>' },
        { id: '12', status: 'incomplete', body: '<p>Write <strong>docs</strong></p>' },
      ]);
    });

    it('gives edited tasks their stored ids in order when that first save adds or removes no task', () => {
      const legacy = { previousStorage: STORED, legacyTasks: true };
      const changed = UNCARRIED.replace('>Ship it<', '>Ship it today<');
      expect(taskIds(htmlToConfluence(changed, legacy))).toEqual(['794464', '12']);
      const bothChanged = changed.replace('Write <strong>docs</strong>', 'Write the <strong>docs</strong>');
      expect(taskIds(htmlToConfluence(bothChanged, legacy))).toEqual(['794464', '12']);
    });

    it('mints ids above every stored one for edited tasks when that first save also adds or removes a task', () => {
      const legacy = { previousStorage: STORED, legacyTasks: true };
      const changed = UNCARRIED.replace('>Ship it<', '>Ship it today<');
      const added = changed.replace('</ul>', '<li data-type="taskItem" data-checked="false">New task</li></ul>');
      expect(taskIds(htmlToConfluence(added, legacy))).toEqual(['794465', '12', '794466']);
      const removed = changed.replace(/<li data-type="taskItem" data-checked="false">Write.*?<\/li>/, '');
      expect(taskIds(htmlToConfluence(removed, legacy))).toEqual(['794465']);
    });

    it('pairs nothing by position unless the page predates carried ids: AI Improve and pages that carry ids', () => {
      // Improve's tasks carry no id (htmlToMarkdown writes none), and neither do
      // tasks that replace every task of a page.
      const stored = { previousStorage: storageOf([1, 'Buy milk'], [2, 'Call Bob'], [3, 'Book flights']) };
      const idless = (...texts: string[]) => taskList(...texts.map((text): [null, string] => [null, text]));
      expect(taskIds(htmlToConfluence(idless('Buy milk', 'Phone Bob', 'Book flights'), stored)), 'reworded')
        .toEqual(['1', '4', '3']);
      expect(taskIds(htmlToConfluence(idless('Book flights', 'Buy milk', 'Call Bob'), stored)), 'reordered')
        .toEqual(['3', '1', '2']);
      expect(taskIds(htmlToConfluence(idless('Phone Bob', 'Purchase milk', 'Book flights'), stored)), 'reordered + reworded')
        .toEqual(['4', '5', '3']);
      expect(taskIds(htmlToConfluence(idless('Buy milk', 'Book flights', 'Pack bags'), stored)), 'one dropped, one added')
        .toEqual(['1', '3', '4']);
      expect(taskIds(htmlToConfluence(idless('One', 'Two', 'Three'), stored)), 'every task replaced')
        .toEqual(['4', '5', '6']);
    });

    it('never gives the id of a task deleted in this write to a new task', () => {
      const stored = '<ac:task-list>'
        + '<ac:task><ac:task-id>1</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>a</ac:task-body></ac:task>'
        + '<ac:task><ac:task-id>2</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>b</ac:task-body></ac:task>'
        + '<ac:task><ac:task-id>3</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>c</ac:task-body></ac:task>'
        + '</ac:task-list>';
      // Task 3 is deleted and a new task added in its place. The body carries
      // ids, so the new task is not paired with task 3 by position.
      expect(taskIds(htmlToConfluence(taskList(['1', 'a'], ['2', 'b'], [null, 'd']), { previousStorage: stored })))
        .toEqual(['1', '2', '4']);
    });

    it('gives a stored id neither to a copy nor to a task while its own carrier keeps it', () => {
      const stored = '<ac:task-list>'
        + '<ac:task><ac:task-id>5</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>x</ac:task-body></ac:task>'
        + '<ac:task><ac:task-id>6</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>y</ac:task-body></ac:task>'
        + '</ac:task-list>';
      // A pasted copy of task 5 is new, even though task 6 is unclaimed.
      expect(taskIds(htmlToConfluence(taskList(['5', 'x'], ['5', 'y']), { previousStorage: stored })))
        .toEqual(['5', '7']);
      // A task without an id whose text is task 5's does not take 5 from its carrier.
      expect(taskIds(htmlToConfluence(taskList([null, 'x'], ['5', 'x']), { previousStorage: stored })))
        .toEqual(['7', '5']);
    });

    it('pairs repeated texts with stored tasks in order', () => {
      const stored = '<ac:task-list>'
        + '<ac:task><ac:task-id>5</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>x</ac:task-body></ac:task>'
        + '<ac:task><ac:task-id>6</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>x</ac:task-body></ac:task>'
        + '</ac:task-list>';
      expect(taskIds(htmlToConfluence(taskList([null, 'x'], [null, 'x'], [null, 'x']), { previousStorage: stored })))
        .toEqual(['5', '6', '7']);
    });
  });

  describe('task lists that never went through the editor', () => {
    it('keeps the whole li as the body when it is not the editor checkbox shape', () => {
      // #1752's Markdown import and the Notion import write their content
      // straight into the li; a label without a checkbox is content too.
      const imported = '<ul data-type="taskList">\n<li data-type="taskItem" data-checked="true">done</li>\n'
        + '<li data-type="taskItem" data-checked="false"><label>Due:</label><div>Friday</div></li>\n</ul>\n';
      expect(tasks(htmlToConfluence(imported))).toEqual([
        { id: '1', status: 'complete', body: 'done' },
        { id: '2', status: 'incomplete', body: '<label>Due:</label><div>Friday</div>' },
      ]);
    });

    it('drops the checkbox an earlier save wrote into a task body', () => {
      const written =
        '<ac:task-list><ac:task><ac:task-id>4</ac:task-id><ac:task-status>complete</ac:task-status>'
        + '<ac:task-body><label><input type="checkbox" checked="checked" /><span></span></label>'
        + '<div><p>Ship it</p></div></ac:task-body></ac:task></ac:task-list>';
      expect(tasks(htmlToConfluence(confluenceToHtml(written)))).toEqual([
        { id: '4', status: 'complete', body: '<p>Ship it</p>' },
      ]);
    });
  });
});
