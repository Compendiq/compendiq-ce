import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb, teardownTestDb, isDbAvailable } from '../../test-db-helper.js';
import { query } from '../db/postgres.js';
import {
  escapeSnippetHtml,
  HEADLINE_ALT_OPTIONS_SQL,
  HEADLINE_OPTIONS_SQL,
  headlineNeedsAlternateSql,
  keywordHeadlineHtml,
  takeCodePoints,
} from './snippet-html.js';

const S = '\u0001';
const E = '\u0002';
const AS = '\u0003';
const AE = '\u0004';

describe('escapeSnippetHtml (#1964)', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeSnippetHtml(`a&b<c>d"e'f`)).toBe('a&amp;b&lt;c&gt;d&quot;e&#39;f');
  });

  it('escapes text that already looks like an entity, so it renders as written', () => {
    expect(escapeSnippetHtml('Use &lt;br&gt; &amp;')).toBe('Use &amp;lt;br&amp;gt; &amp;amp;');
  });

  it('leaves every other character untouched, control characters included', () => {
    const text = `Ünïcödé — 日本語 \u{1F600}\t\n\\%_${S}${E}${AS}${AE}`;
    expect(escapeSnippetHtml(text)).toBe(text);
  });
});

describe('takeCodePoints (#1964)', () => {
  it('counts a supplementary character as one, never returning half of it', () => {
    const text = `${'a'.repeat(299)}😀z`;
    expect(takeCodePoints(text, 300)).toBe(`${'a'.repeat(299)}😀`);
    expect(takeCodePoints(text, 299)).toBe('a'.repeat(299));
  });

  it('returns shorter text unchanged and counts a lone surrogate as one', () => {
    expect(takeCodePoints('abc', 300)).toBe('abc');
    expect(takeCodePoints('a\ud83dbc', 2)).toBe('a\ud83d');
  });
});

describe('keywordHeadlineHtml without an alternate headline (#1964)', () => {
  it('turns balanced primary selectors into marks and escapes every other run once', () => {
    expect(keywordHeadlineHtml(`Use &lt;${S}br${E}&gt; for a ${S}line${E} <mark>x</mark> "q"`, null)).toBe(
      'Use &amp;lt;<mark>br</mark>&amp;gt; for a <mark>line</mark> &lt;mark&gt;x&lt;/mark&gt; &quot;q&quot;',
    );
  });

  it('keeps the alternate selector characters as text', () => {
    expect(keywordHeadlineHtml(`${AS}a${AE} ${S}b${E}`, null)).toBe(`${AS}a${AE} <mark>b</mark>`);
  });

  it.each([
    ['a nested start', `${S}a${S}b${E}c${E}`],
    ['a stop with no open mark', `a${E} ${S}b${E}`],
    ['a mark still open at the end', `${S}a${E} <b> ${S}c`],
    ['a late nested start after a valid prefix', `${S}a${E} & ${S}b${S}c${E}`],
  ])('emits the whole headline escaped, with no mark, for %s', (_case, headline) => {
    expect(keywordHeadlineHtml(headline, null)).toBe(escapeSnippetHtml(headline));
    expect(keywordHeadlineHtml(headline, null)).not.toContain('<mark>');
  });
});

describe('keywordHeadlineHtml with an alternate headline (#1964)', () => {
  it('marks only positions holding a primary selector in one output and the alternate in the other', () => {
    // Authored U+0001/U+0002 are identical in both outputs, so they are text.
    const headline = `${S}x${E} ${S}needle${E} and ${AS}`;
    const alternate = `${S}x${E} ${AS}needle${AE} and ${AS}`;
    expect(keywordHeadlineHtml(headline, alternate)).toBe(`${S}x${E} <mark>needle</mark> and ${AS}`);
  });

  it.each([['0001', S], ['0002', E], ['0003', AS], ['0004', AE]])('keeps authored U+%s as text when both outputs hold it', (_code, control) => {
    const headline = `a${control}b ${S}c${E}`;
    const alternate = `a${control}b ${AS}c${AE}`;
    expect(keywordHeadlineHtml(headline, alternate)).toBe(`a${control}b <mark>c</mark>`);
  });

  it.each([
    ['unequal lengths', `${S}a${E} b`, `${AS}a${AE} bc`],
    ['a disagreement other than a selector pair', `${S}a${E} b`, `${AS}a${AE} c`],
    ['the alternate selector in the primary output', `${AS}a${AE}`, `${S}a${E}`],
    ['start and stop crossed between the outputs', `${S}a${E}`, `${AE}a${AS}`],
    // An already rendered valid prefix must be discarded, not kept.
    ['a malformed late disagreement after a valid prefix', `${S}a${E} <i> & b X`, `${AS}a${AE} <i> & b Y`],
    ['a late nested start after a valid prefix', `${S}a${E} ${S}b${S}c${E}`, `${AS}a${AE} ${AS}b${AS}c${AE}`],
    ['a mark still open at the end', `${S}a${E} ${S}b`, `${AS}a${AE} ${AS}b`],
  ])('emits the primary headline escaped, with no mark, for %s', (_case, headline, alternate) => {
    expect(keywordHeadlineHtml(headline, alternate)).toBe(escapeSnippetHtml(headline));
    expect(keywordHeadlineHtml(headline, alternate)).not.toContain('<mark>');
  });
});

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('headline SQL helpers in PostgreSQL (#1964)', () => {
  beforeAll(async () => {
    await setupTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  it('builds the option strings with the exact selector bytes', async () => {
    const result = await query<{ primary: string; alternate: string }>(
      `SELECT encode(convert_to(${HEADLINE_OPTIONS_SQL}, 'UTF8'), 'hex') AS primary,
              encode(convert_to(${HEADLINE_ALT_OPTIONS_SQL}, 'UTF8'), 'hex') AS alternate`,
    );
    const hex = (text: string) => Buffer.from(text, 'utf8').toString('hex');
    expect(result.rows[0]).toEqual({
      primary: hex(`MaxWords=30, MinWords=15, StartSel=${S}, StopSel=${E}`),
      alternate: hex(`MaxWords=30, MinWords=15, StartSel=${AS}, StopSel=${AE}`),
    });
  });

  it('asks for the alternate headline exactly when the text holds U+0001 or U+0002', async () => {
    const texts = ['plain', `a${S}b`, `a${E}b`, `a${AS}${AE}b`, ''];
    const result = await query<{ needs: boolean }>(
      `SELECT ${headlineNeedsAlternateSql('t.value')} AS needs
       FROM unnest($1::text[]) WITH ORDINALITY AS t(value, position)
       ORDER BY t.position`,
      [texts],
    );
    expect(result.rows.map((row) => row.needs)).toEqual([false, true, true, false, false]);
  });
});
