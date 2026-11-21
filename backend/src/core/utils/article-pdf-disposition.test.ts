import { describe, expect, it } from 'vitest';
import { articlePdfDisposition } from './article-pdf-disposition.js';

describe('single-article PDF Content-Disposition', () => {
  it.each([
    ['Установка', 'установка', 'article-42'],
    ['手順書', '手順書', 'article-42'],
    ['Руководство v2', 'руководство-v2', 'v2'],
    ['Guía: instalación', 'guía-instalación', 'guia-instalacion'],
    ['Re\u0301sume\u0301', 'résumé', 'resume'],
    ['हिन्दी', 'हिन्दी', 'article-42'],
    ['Résumé_Я手.01', 'résumé_я手.01', 'resume_.01'],
    [' .  ...🎉   . ', 'article-42', 'article-42'],
    [' ..A\r\nB\0/\\:*?"<>|;C\u202E\'(D)* .. ', 'abcd', 'abcd'],
    ['Hello World! @#$% Test', 'hello-world-test', 'hello-world-test'],
    ['First\u2028second', 'first-second', 'first-second'],
    ['手'.repeat(100), '手'.repeat(50), 'article-42'],
    ['a'.repeat(149) + '𠮷', 'a'.repeat(149), 'a'.repeat(149)],
    ['a'.repeat(149) + '.x', 'a'.repeat(149), 'a'.repeat(149)],
    ['Ⅷ'.repeat(51), 'ⅷ'.repeat(50), 'viii'.repeat(37) + 'vi'],
    ['手.é.手', '手.é.手', 'e'],
  ])('formats %s as one ASCII header value', (title, unicode, ascii) => {
    expect(articlePdfDisposition(title, 42)).toBe(
      `attachment; filename="${ascii}.pdf"; filename*=UTF-8''${encodeURIComponent(unicode)}.pdf`,
    );
  });
});
