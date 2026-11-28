import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, type Locator } from '@playwright/test';
import { authenticateContext, bearerHeaders, registerUser, uniqueUsername } from './helpers/auth';

// #1956: table cell alignment in a real browser. The read-mode viewer and the editor parse a stored page through
// the frontend schema with Chromium's own CSS parser, and render under the real `.prose .tiptap` stylesheet.
// The vectors are the fixture every other host reads (converter, collaborative schema, frontend unit tests).
const fixture: { vectors: Array<[string, string, string | null]> } = JSON.parse(readFileSync(
  join(__dirname, '../backend/src/core/services/__fixtures__/table-cell-align-vectors.json'), 'utf8',
));
const { vectors } = fixture;

const RENDERING_TABLE = '<table><tbody>'
  + '<tr><th align="left">L</th><th align="center">C</th><th align="right">R</th><th>N</th></tr>'
  + '<tr><td align="left">l</td><td align="center">c</td><td align="right">r</td><td>n</td></tr></tbody></table>';
const VECTOR_TABLE = `<table><tbody><tr><th>vector</th></tr>${
  vectors.map(([, attrs], index) => `<tr><td ${attrs}>v${index}</td></tr>`).join('')}</tbody></table>`;

type CellReading = { text: string; tag: string; align: string | null; textAlign: string };

async function readCells(root: Locator): Promise<CellReading[][]> {
  return root.evaluate((el) => Array.from(el.querySelectorAll('table')).map((table) =>
    Array.from(table.querySelectorAll('th, td')).map((cell) => ({
      text: cell.textContent?.trim() ?? '',
      tag: cell.tagName,
      align: cell.getAttribute('align'),
      textAlign: getComputedStyle(cell).textAlign,
    }))));
}

function expectAligned([rendering, vectorCells]: CellReading[][]): void {
  // Aligned header and body cells follow their attribute; an unaligned header keeps the prose `th` rule (left), an
  // unaligned body cell the browser default (start).
  expect(rendering!.map(({ text, align, textAlign }) => [text, align, textAlign])).toEqual([
    ['L', 'left', 'left'], ['C', 'center', 'center'], ['R', 'right', 'right'], ['N', null, 'left'],
    ['l', 'left', 'left'], ['c', 'center', 'center'], ['r', 'right', 'right'], ['n', null, 'start'],
  ]);
  const body = vectorCells!.filter((cell) => cell.tag === 'TD');
  expect(body.map(({ text, align, textAlign }) => [text, align, textAlign])).toEqual(
    vectors.map(([, , expected], index) => [`v${index}`, expected, expected ?? 'start']),
  );
}

test('table cell alignment reads every vector as the other hosts do and renders in read mode and the editor', async ({ page }) => {
  const session = await registerUser(page.request, uniqueUsername('e2e_cellalign'));
  await authenticateContext(page.context(), session);
  const spaceKey = `ALN${Date.now()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const space = await page.request.post('/api/spaces/local', {
    headers: bearerHeaders(session), data: { key: spaceKey, name: spaceKey },
  });
  expect(space.ok(), await space.text()).toBeTruthy();
  const created = await page.request.post('/api/pages', {
    headers: bearerHeaders(session),
    data: { title: 'Aligned table cells', bodyHtml: `${RENDERING_TABLE}${VECTOR_TABLE}`, spaceKey },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const { id } = await created.json();

  await page.goto(`/pages/${id}`);
  const viewer = page.locator('.prose .tiptap').first();
  await expect(viewer.locator('table')).toHaveCount(2);
  expectAligned(await readCells(viewer));

  await page.getByTestId('edit-page-btn').click();
  const editor = page.locator('.prose .tiptap[contenteditable="true"]');
  await expect(editor.locator('table')).toHaveCount(2);
  expectAligned(await readCells(editor));
});
