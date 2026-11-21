import { describe, expect, it } from 'vitest';
import { parseArticlePdfFilename } from './article-pdf-download';

describe('article PDF download name', () => {
  it.each([
    ["filename=ascii.pdf; FILENAME*=UTF-8'ru'%D1%8F.pdf", 'я.pdf'],
    ["filename*=utf-8''a+b%20c.pdf; filename=ascii.pdf", 'a+b c.pdf'],
    ['name="irrelevant; filename=wrong.pdf"; filename=simple.PDF', 'simple.PDF'],
    ['filename="file; \\"quote\\".pdf"', 'file; "quote".pdf'],
    ["filename*=UTF-8''..%2Ffile%5Cname%07%7F%C2%85%E2%80%AE.pdf", 'filename.pdf'],
    ['filename="..\\\\a/b.pdf"', 'ab.pdf'],
  ])('reads %s', (parameters, expected) => {
    expect(parseArticlePdfFilename(`attachment; ${parameters}`)).toBe(expected);
  });

  it.each([
    null, '', 'attachment', 'inline; filename=foo.pdf',
    'attachment; filename="unfinished.pdf', 'attachment; filename=has space.pdf',
    'attachment; filename=ok.pdf, attachment; filename=other.pdf',
    'attachment; filename=a.pdf; FILENAME=b.pdf',
    "attachment; filename*=UTF-8''a.pdf; Filename*=UTF-8''b.pdf",
    "attachment; filename=ok.pdf; filename*0*=UTF-8''name",
    "attachment; filename=ok.pdf; filename*=ISO-8859-1''%E9.pdf",
    "attachment; filename=ok.pdf; filename*=UTF-8'en--US'b.pdf",
    "attachment; filename=ok.pdf; filename*=UTF-8''bad%2.pdf",
    "attachment; filename=ok.pdf; filename*=UTF-8''%FF.pdf",
    "attachment; filename=ok.pdf; filename*=UTF-8''a'b.pdf",
    "attachment; filename=ok.pdf; filename*=\"UTF-8''b.pdf\"",
    "attachment; filename=ok.pdf; filename*=UTF-8''file.pdf.exe",
    "attachment; filename=ok.pdf; filename*=UTF-8''%2F%00.pdf",
    'attachment; filename=""', 'attachment; filename="  ...pdf"',
  ])('rejects an absent, ambiguous or unusable header: %s', header => {
    expect(parseArticlePdfFilename(header)).toBeNull();
  });
});
