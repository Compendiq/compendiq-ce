/**
 * #1954: the collab schema's linked image. A Confluence link whose body is an
 * image rides on the block image node as `href` (and, for a navigable `ri:url`,
 * #1955's class carrier as `linkClass`), and comes back as the wrapper `<a>`.
 */
import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import * as Y from 'yjs';
import { encodeConfluenceLinkValue, isConfluenceUrlClassCarrierFor } from '@compendiq/contracts';
import { htmlToYDoc, markAttachmentImages, yDocToHtml } from './collab-schema.js';
import { confluenceLinkCarrierOf } from './confluence-link.js';

const IMG = '<img src="/api/attachments/1/a.png" alt="a.png">';
const roundTrip = (html: string): string => yDocToHtml(htmlToYDoc(html));

/** The only image element of a collaborative document. */
function imageElement(doc: Y.Doc): Y.XmlElement {
  const images = [...doc.getXmlFragment('default').createTreeWalker((t) => t instanceof Y.XmlElement && t.nodeName === 'image')];
  expect(images).toHaveLength(1);
  return images[0] as Y.XmlElement;
}

/** The wrapper anchor of the only image in `html`, or null. */
function wrapper(html: string): Element | null {
  const img = new JSDOM(html).window.document.querySelector('img');
  return img?.closest('a') ?? null;
}

const carrierOf = (url: string, params = ''): string => `#confluence-url:${encodeConfluenceLinkValue(url)}${params}`;

describe('collab schema: a linked image (#1954)', () => {
  describe('the link survives the room', () => {
    it.each([
      ['a paragraph', `<p><a href="#confluence-page:X">${IMG}</a></p>`],
      ['a figure', `<figure><a href="#confluence-page:X">${IMG}</a><figcaption>Cap</figcaption></figure>`],
      ['a list item', `<ul><li><p>x <a href="#confluence-page:X">${IMG}</a></p></li></ul>`],
      ['a table cell', `<table><tbody><tr><td><p><a href="#confluence-page:X">${IMG}</a></p></td></tr></tbody></table>`],
    ])('inside %s, and a second load and save is byte-identical', (_where, html) => {
      const once = roundTrip(html);
      expect(wrapper(once)?.getAttribute('href')).toBe('#confluence-page:X');
      expect(roundTrip(once)).toBe(once);
    });

    it('stores the link on the image node, not on any mark', () => {
      const doc = htmlToYDoc(`<p><a href="#confluence-page:X">${IMG}</a></p>`);
      expect(imageElement(doc).getAttribute('href')).toBe('#confluence-page:X');
      expect(imageElement(doc).getAttribute('linkClass')).toBeUndefined();
    });

    it('renders the same <a> start tag for an image link and a text link with the same href and class', () => {
      for (const [href, className] of [['#confluence-page:X', null], ['https://example.com/z', carrierOf('https://example.com/z')]] as const) {
        const attrs = `href="${href}"${className ? ` class="${className}"` : ''}`;
        const html = roundTrip(`<p><a ${attrs}>t</a></p><p><a ${attrs}>${IMG}</a></p>`);
        const tags = html.match(/<a [^>]*>/g)!;
        expect(tags).toHaveLength(2);
        expect(tags[1]).toBe(tags[0]);
      }
    });

    it('keeps the link when a Confluence commit marks the image as uploaded (#1764)', () => {
      const doc = htmlToYDoc(`<p><a href="#confluence-page:X">${IMG}</a></p>`);
      expect(markAttachmentImages(doc, [{ src: '/api/attachments/1/a.png', filename: 'a.png' }], 'test')).toBe(1);
      const html = yDocToHtml(doc);
      expect(wrapper(html)?.getAttribute('href')).toBe('#confluence-page:X');
      expect(html).toContain('data-confluence-filename="a.png"');
    });
  });

  describe('the href policy is the Link mark\'s', () => {
    it.each([
      'javascript:alert(1)',
      'JAVASCRIPT:alert(1)',
      'java\tscript:alert(1)',
      ' java\nscript:alert(1)',
      'data:text/html,<b>x</b>',
      'vbscript:msgbox(1)',
      `#confluence-page:${'a'.repeat(16_400)}`,
    ])('drops the link of %j when the HTML is parsed', (href) => {
      const html = roundTrip(`<p><a href="${href.replace(/"/g, '&quot;')}">${IMG}</a></p>`);
      expect(wrapper(html)).toBeNull();
      expect(html).toContain('<img src="/api/attachments/1/a.png"');
    });

    it.each([
      ['an unsafe href', 'javascript:alert(1)'],
      ['an href over 16,384 characters', `#confluence-page:${'a'.repeat(16_400)}`],
      ['an empty href', ''],
    ])('renders no <a> for %s written straight into the Yjs image element', (_case, href) => {
      const doc = htmlToYDoc(`<p>${IMG}</p>`);
      imageElement(doc).setAttribute('href', href);
      expect(wrapper(yDocToHtml(doc))).toBeNull();
    });
  });

  describe('the class carrier of a navigable ri:url (contract X1)', () => {
    const web = 'https://example.com/a?b=1&c=2';
    // [case, href, class, admitted]: one matrix for the predicate, the image node and #1955's reader of a text link.
    const matrix: Array<[string, string, string, boolean]> = [
      ['the carrier of its own https URL', web, carrierOf(web, '?body=rich'), true],
      ['the carrier of its own mailto URL', 'mailto:a@example.com', carrierOf('mailto:a@example.com'), true],
      ['a carrier with link attributes', 'https://example.com/z', carrierOf('https://example.com/z', '?ac:anchor=top&body=rich'), true],
      ['the carrier of another URL', 'https://example.com/z', carrierOf('https://example.com/other'), false],
      ['the bare prefix', 'https://example.com/z', '#confluence-url:', false],
      ['a carrier written before the grammar', 'https://example.com/z', '#confluence-url:https://example.com/z', false],
      ['a repeated parameter', 'https://example.com/z', carrierOf('https://example.com/z', '?body=rich&body=rich'), false],
      ['an unknown parameter', 'https://example.com/z', carrierOf('https://example.com/z', '?foo=1'), false],
      ['two class tokens', 'https://example.com/z', `x ${carrierOf('https://example.com/z')}`, false],
      ['a class over 16,384 characters', 'https://example.com/z', carrierOf('https://example.com/z', `?ac:x=${'a'.repeat(16_400)}`), false],
      ['the carrier of an ftp URL', 'ftp://example.com/z', carrierOf('ftp://example.com/z'), false],
      ['the carrier of an upper-case scheme', 'HTTPS://example.com/z', carrierOf('HTTPS://example.com/z'), false],
    ];

    it.each(matrix)('%s: the image, the predicate and a text link agree', (_case, href, className, admitted) => {
      expect(isConfluenceUrlClassCarrierFor(href, className)).toBe(admitted);
      const attrs = `href="${href.replace(/&/g, '&amp;')}" class="${className.replace(/&/g, '&amp;')}"`;
      const text = new JSDOM(`<a ${attrs}>t</a>`).window.document.querySelector('a')!;
      expect(confluenceLinkCarrierOf(text) === className).toBe(admitted);

      const doc = htmlToYDoc(`<p><a ${attrs}>${IMG}</a></p>`);
      expect(imageElement(doc).getAttribute('linkClass') ?? null).toBe(admitted ? className : null);
      expect(wrapper(yDocToHtml(doc))?.getAttribute('class') ?? null).toBe(admitted ? className : null);
    });

    it.each([
      ['a class whose URL is not the href', 'https://example.com/z', carrierOf('https://example.com/other')],
      ['the bare prefix', 'https://example.com/z', '#confluence-url:'],
      ['a carrier written before the grammar', 'https://example.com/z', '#confluence-url:https://example.com/z'],
      ['an unknown parameter', 'https://example.com/z', carrierOf('https://example.com/z', '?foo=1')],
      ['two class tokens', 'https://example.com/z', `x ${carrierOf('https://example.com/z')}`],
      ['a class over 16,384 characters', 'https://example.com/z', carrierOf('https://example.com/z', `?ac:x=${'a'.repeat(16_400)}`)],
      ['a class on an ftp href', 'ftp://example.com/z', carrierOf('ftp://example.com/z')],
      ['a class on a carrier href', '#confluence-url:%2Fdocs', carrierOf('https://example.com/z')],
    ])('never renders %s written straight into the Yjs image element', (_case, href, className) => {
      const doc = htmlToYDoc(`<p>${IMG}</p>`);
      imageElement(doc).setAttribute('href', href);
      imageElement(doc).setAttribute('linkClass', className);
      const anchor = wrapper(yDocToHtml(doc));
      expect(anchor?.getAttribute('href')).toBe(href);
      expect(anchor?.hasAttribute('class')).toBe(false);
    });

    it('renders no class for a carrier written into the Yjs image element without an href', () => {
      const doc = htmlToYDoc(`<p>${IMG}</p>`);
      imageElement(doc).setAttribute('linkClass', carrierOf('https://example.com/z'));
      expect(wrapper(yDocToHtml(doc))).toBeNull();
    });
  });
});
