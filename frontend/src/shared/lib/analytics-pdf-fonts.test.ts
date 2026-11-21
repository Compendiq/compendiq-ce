import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { getDocumentProxy } from 'unpdf';
import { beforeEach, expect, it, vi } from 'vitest';
import type { PdfReportMeta } from './export-helpers';

const directory = resolve(import.meta.dirname, '../../../public/fonts/pdf');
const requests = vi.fn(async (url: string) => {
  if (!url.startsWith('/fonts/pdf/')) throw new Error(`Unexpected asset: ${url}`);
  return new Response(await readFile(resolve(directory, new URL(url, 'http://localhost').pathname.slice('/fonts/pdf/'.length))));
});
function requestedPaths() {
  return requests.mock.calls.map(([url]) => new URL(url, 'http://localhost').pathname);
}
let download: Blob | undefined;

beforeEach(() => {
  // Each test starts with a cold session; successive exports within it share only bytes.
  vi.resetModules();
  requests.mockClear();
  download = undefined;
  vi.stubGlobal('fetch', requests);
  URL.createObjectURL = vi.fn((blob: Blob) => { download = blob; return 'blob:analytics'; });
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});

async function print(rows: Record<string, unknown>[], meta: PdfReportMeta) {
  const { exportToPdf } = await import('./export-helpers');
  await exportToPdf('report.pdf', rows, meta);
  const pdf = await getDocumentProxy(new Uint8Array(await download!.arrayBuffer()));
  const pages: string[] = [];
  try {
    for (let i = 1; i <= pdf.numPages; i++) {
      const { items } = await (await pdf.getPage(i)).getTextContent({ disableNormalization: true });
      pages.push(items.map(item => 'str' in item ? item.str : '').join(''));
    }
  } finally { await pdf.destroy(); }
  return pages;
}

it('keeps Helvetica for NFC WinAnsi text, whitespace and the six visible KPIs', async () => {
  const { exportToPdf } = await import('./export-helpers');
  await exportToPdf('latin.pdf', [{ city: 'Cafe\u0301\u3000Zürich\n' }], {
    title: 'Coverage', kpis: [...Array(6).fill({ label: 'Rate', value: 1 }), { label: '中文', value: 'Ω' }],
  });
  expect(download).toBeDefined();
  expect(requests).not.toHaveBeenCalled();
});

it('extracts real words from title, metadata, KPIs, column names, cells and footer', async () => {
  const [cover, table] = await print([{ 'Ελλάδα': 'Привет', '日本語': '한국어', '中文': 'かな' }], {
    title: 'Отчёт', generatedBy: '日本', instanceUrl: 'https://δοκιμή',
    kpis: [{ label: 'Αθήνα', value: '도시', unit: '件' }],
  });
  for (const word of ['Отчёт', '日本', 'δοκιμή', 'Αθήνα', '도시', '件']) expect(cover).toContain(word);
  for (const word of ['Ελλάδα', 'Привет', '日本語', '한국어', '中文', 'かな']) expect(table).toContain(word);
  expect(table?.match(/Отчёт/g)).toHaveLength(2);
  expect(cover).not.toContain('Some characters');
  expect(table).not.toContain('?');
});

it('retries a missing required font without a partial download and caches it across documents', async () => {
  requests.mockResolvedValueOnce(new Response(null, { status: 404 }));
  await expect(print([{ city: 'Москва' }], { title: 'Cities' })).rejects.toThrow('NotoSans-Regular: HTTP 404');
  expect(download).toBeUndefined();
  for (const city of ['Москва', 'Пермь']) expect((await print([{ city }], { title: 'Cities' }))[1]).toContain(city);
  expect(requestedPaths()).toEqual(Array(2).fill('/fonts/pdf/NotoSans-Regular.ttf'));
});

it('uses the non-CJK shard for isolated symbols even after an export using the full source', async () => {
  const symbols = '✓→①Ⅷ';
  for (const city of [symbols, `東京${symbols}`, symbols]) {
    expect((await print([{ city }], { title: 'Cities' }))[1]).toContain(city);
  }
  expect(requestedPaths()).toEqual([
    '/fonts/pdf/NotoSansSC-Regular-nonCJK.ttf', '/fonts/pdf/NotoSansSC-Regular.ttf',
  ]);
});

it('truncates mixed-font runs at scalar boundaries and warns only for a printed replacement', async () => {
  const [cover, data] = await print([{ city: '東京Ω'.repeat(150) + '😀', neighbor: 'NEXT' }], { title: 'Cities' });
  expect(data).toMatch(/(?:東京Ω)+(?:東|東京)?…\s*NEXT/);
  expect(cover).not.toContain('Some characters');
});

it('discloses mapped but nonprinting controls only if they survive truncation', async () => {
  const controls = 'A\u202eB C\u0000D E\u200dF';
  const tail = 'To'.repeat(200);
  const [cover, table] = await print([{ query: controls + tail }], { title: 'Report' });
  expect(table).toMatch(/A\?B C\?D E\?FTo[^?]*…/);
  expect(cover).toContain('Some characters cannot be shown');

  const [clippedCover, clippedTable] = await print([{ query: tail + controls }], { title: 'Report' });
  expect(clippedTable).toMatch(/To[^?]*…/);
  expect(clippedTable).not.toContain('?');
  expect(clippedCover).not.toContain('Some characters cannot be shown');
  expect(requests).not.toHaveBeenCalled();
});

it.each(['NotoSans-Regular.ttf', 'NotoSans-Bold.ttf', 'NotoSansSC-Regular.ttf', 'NotoSansKR-Regular.ttf',
  'OFL-NotoSans.txt', 'OFL-NotoSansCJK.txt'])('ships the verified article asset %s unchanged', async name => {
  const digest = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex');
  const source = resolve(import.meta.dirname, '../../../../backend/src/core/services/fonts', name);
  expect(await digest(resolve(directory, name))).toBe(await digest(source));
});
