import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb, teardownTestDb, isDbAvailable } from '../../test-db-helper.js';
import { query } from '../db/postgres.js';
import { escapeSnippetHtml, sqlEscapeSnippetHtml } from './snippet-html.js';

const CORPUS = [
  '',
  'plain text stays as it is',
  'Use <br> for a line break',
  'Use &lt;br&gt; for a line break',
  'Example: <script>alert("x")</script>',
  "It's a \"quote\" & an apostrophe's",
  '&amp;&amp;amp; <<>> \'\'""',
  'https://example.com/a?b=1&c=2#x',
  'Ünïcödé — 日本語 \u{1F600} <mark>literal</mark>',
  'tab\tnewline\nbackslash\\ percent% underscore_',
];

describe('escapeSnippetHtml (#1964)', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeSnippetHtml(`a&b<c>d"e'f`)).toBe('a&amp;b&lt;c&gt;d&quot;e&#39;f');
  });

  it('escapes text that already looks like an entity, so it renders as written', () => {
    expect(escapeSnippetHtml('Use &lt;br&gt; &amp;')).toBe('Use &amp;lt;br&amp;gt; &amp;amp;');
  });

  it('leaves every other character untouched', () => {
    expect(escapeSnippetHtml('Ünïcödé — 日本語 \u{1F600}\t\n\\%_')).toBe('Ünïcödé — 日本語 \u{1F600}\t\n\\%_');
  });
});

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('sqlEscapeSnippetHtml matches escapeSnippetHtml in PostgreSQL (#1964)', () => {
  beforeAll(async () => {
    await setupTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  it('produces the same string for every corpus entry', async () => {
    const result = await query<{ escaped: string }>(
      `SELECT ${sqlEscapeSnippetHtml('t.value')} AS escaped
       FROM unnest($1::text[]) WITH ORDINALITY AS t(value, position)
       ORDER BY t.position`,
      [CORPUS],
    );
    expect(result.rows.map((row) => row.escaped)).toEqual(CORPUS.map(escapeSnippetHtml));
  });
});
