/**
 * #1955 (decision D2): a `ri:url` link whose value is not a navigable URL is
 * written only as an occurrence the stored page already holds. The judgement
 * is made on two readings of the storage reader: what is written, and what is
 * stored. These cases pin which written link stands for which stored one.
 */
import { describe, it, expect, vi } from 'vitest';
import { readConfluenceStorage } from './confluence-storage-reader.js';
import {
  analyseStorageLinks,
  isApprovedUrlLinkVerdict,
  judgeStorageUrlLinks,
  STORAGE_LINK_LIMITS,
  StorageLinkBudgetError,
  type StorageLinkAnalysis,
  type StorageLinkLimits,
  type StorageUrlLinkVerdict,
} from './confluence-url-origin.js';

/** A URL link as write-back builds it. */
function link(body = '', value = '/rel/a', attributes = ''): string {
  return `<ac:link${attributes}><ri:url ri:value="${value}"></ri:url>${body}</ac:link>`;
}
const text = (value: string): string => `<ac:plain-text-link-body><![CDATA[${value}]]></ac:plain-text-link-body>`;
const image = (filename = 'i.png', owner = ''): string =>
  `<ac:link-body><ac:image><ri:attachment ri:filename="${filename}">${owner}</ri:attachment></ac:image></ac:link-body>`;
const pageLink = (body: string): string => `<ac:link><ri:page ri:content-title="Home"></ri:page>${body}</ac:link>`;
/** Enough unrelated text that two paragraphs around it do not see each other. */
const FILLER = `<p>${'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor. '.repeat(2)}</p>`;
const B = '/rel/b';

function analyse(storage: string, limits?: StorageLinkLimits): StorageLinkAnalysis {
  const read = readConfluenceStorage(storage);
  if (!read.ok) throw new Error(`not read: ${read.reason}`);
  return analyseStorageLinks(read.tree, limits);
}

function judge(stored: string | null, written: string): StorageUrlLinkVerdict[] {
  return judgeStorageUrlLinks(analyse(written), stored === null ? null : analyse(stored));
}

describe('confluence-url-origin: what is a URL link in a storage string (#1955, W1)', () => {
  it('describes the link write-back builds: canonical, its value, its place, its body', () => {
    const [found, ...rest] = analyse(`<p>see ${link(text('the docs'), '/rel/a', ' ac:anchor="x"')} now</p>`).links;
    expect(rest).toEqual([]);
    expect(found).toMatchObject({
      canonical: true, value: '/rel/a', navigable: false, live: true, label: '', ordinal: 0,
      body: JSON.stringify(['the docs', []]), place: JSON.stringify(['', 'see', 'now']),
    });
    expect(found!.element.name).toBe('ac:link');
  });

  it('gives a link without a body its display text as body and label, and counts that text in the places around it', () => {
    const { links } = analyse(`<p>a ${link('', ' /rel/a ')} b ${link('', '')} c</p>`);
    expect(links.map((found) => [found.label, found.body, found.place])).toEqual([
      ['/rel/a', JSON.stringify(['/rel/a', []]), JSON.stringify(['', 'a', 'b(emptylink)c'])],
      ['(empty link)', JSON.stringify(['(empty link)', []]), JSON.stringify(['', 'a/rel/ab', 'c'])],
    ]);
  });

  it('takes a blank explicit body for no body, and an image-only body for a body', () => {
    const { links } = analyse(`<p>${link(text(' '))}${link('<ac:link-body></ac:link-body>')}${link(image())}</p>`);
    expect(links.map((found) => found.label)).toEqual(['/rel/a', '/rel/a', '']);
    expect(links[2]).toMatchObject({ canonical: true });
    expect(JSON.parse(links[2]!.body)[0]).toBe('');
  });

  it('tells a navigable value from every other, and a dormant context from live content', () => {
    const { links } = analyse(
      `<p>${link('', 'https://example.com/')}${link('', 'mailto:a@b.c')}${link('', 'HTTPS://example.com/')}`
      + `${link('', 'javascript:alert(1)')}</p><style>${link()}</style><template>${link()}</template><noscript>${link()}</noscript>`,
    );
    expect(links.map((found) => [found.navigable, found.live])).toEqual([
      [true, true], [true, true], [false, true], [false, true], [false, false], [false, false], [false, false],
    ]);
  });

  it.each([
    ['two url resources', '<ac:link><ri:url ri:value="https://ok.example/"></ri:url><ri:url ri:value="/rel/a"></ri:url></ac:link>'],
    ['a url beside another resource', '<ac:link><ri:url ri:value="/rel/a"></ri:url><ri:page ri:content-title="X"></ri:page></ac:link>'],
    ['a url as an attachment container', '<ac:link><ri:attachment ri:filename="a.pdf"><ri:url ri:value="/rel/a"></ri:url></ri:attachment></ac:link>'],
    ['a missing value', '<ac:link><ri:url></ri:url></ac:link>'],
    ['an unprefixed value attribute', '<ac:link><ri:url value="/rel/a"></ri:url></ac:link>'],
    ['an attribute the href grammar does not carry', '<ac:link title="t"><ri:url ri:value="/rel/a"></ri:url></ac:link>'],
    ['a stray element', '<ac:link><ri:url ri:value="/rel/a"></ri:url><b>x</b></ac:link>'],
    ['text of its own', '<ac:link>x<ri:url ri:value="/rel/a"></ri:url></ac:link>'],
    ['a child of the url', '<ac:link><ri:url ri:value="/rel/a"><b/></ri:url></ac:link>'],
    ['two bodies', `<ac:link><ri:url ri:value="/rel/a"></ri:url>${text('a')}${text('b')}</ac:link>`],
    ['a mention inside its body', '<ac:link><ri:url ri:value="/rel/a"></ri:url><ac:link-body>x<ac:link><ri:user ri:userkey="u"></ri:user></ac:link></ac:link-body></ac:link>'],
    ['an alias prefix', '<x:link xmlns:x="http://atlassian.com/content"><y:url xmlns:y="http://atlassian.com/resource/identifier" y:value="/rel/a"/></x:link>'],
    ['an upper-case name', '<AC:LINK><RI:URL RI:VALUE="/rel/a"/></AC:LINK>'],
    ['a rebound ac prefix', `<div xmlns:ac="urn:other">${link()}</div>`],
    ['a rebound ri prefix', `<div xmlns:ri="urn:other">${link()}</div>`],
    ['an unprefixed link in a default namespace', '<link xmlns="http://atlassian.com/content"><url xmlns="http://atlassian.com/resource/identifier" value="/rel/a"/></link>'],
    ['17 attributes on the link', `<ac:link ${Array.from({ length: 17 }, (_, i) => `ac:p${i}="v"`).join(' ')}><ri:url ri:value="/rel/a"></ri:url></ac:link>`],
    ['a value over 1,024 characters', `<ac:link><ri:url ri:value="/${'a'.repeat(1024)}"></ri:url></ac:link>`],
    ['attributes the href cap would drop', `<ac:link ${Array.from({ length: 16 }, (_, i) => `ac:p${i}="${'日'.repeat(1024)}"`).join(' ')}><ri:url ri:value="/rel/a"></ri:url></ac:link>`],
  ])('finds a link with %s and never takes it for the canonical shape', (_name, storage) => {
    const { links } = analyse(`<p>${storage}</p>`);
    expect(links.length).toBeGreaterThan(0);
    expect(links.some((found) => found.canonical)).toBe(false);
    // Not canonical on the written side: never written. Not canonical on the stored side: no evidence.
    expect(judge(`<p>${link()}</p>`, `<p>${storage}</p>`).some(isApprovedUrlLinkVerdict)).toBe(false);
    expect(judge(`<p>${storage}</p>`, `<p>${link()}</p>`).some(isApprovedUrlLinkVerdict)).toBe(false);
  });

  it('keeps the maximum the grammar carries canonical: 16 attributes besides the primary on each element', () => {
    const sixteen = (prefix: string): string => Array.from({ length: 16 }, (_, i) => `${prefix}:p${i}="v"`).join(' ');
    const storage = `<p><ac:link ${sixteen('ac')}><ri:url ri:value="/rel/a" ${sixteen('ri')}></ri:url>${text('x')}</ac:link></p>`;
    expect(analyse(storage).links[0]).toMatchObject({ canonical: true, value: '/rel/a' });
    expect(judge(storage, storage)).toEqual(['unchanged']);
  });

  it('takes an explicit declaration of the Confluence namespaces for the same link', () => {
    const declared = '<p><ac:link xmlns:ac="http://atlassian.com/content"><ri:url xmlns:ri="http://atlassian.com/resource/identifier" '
      + `ri:value="/rel/a"></ri:url>${text('x')}</ac:link></p>`;
    expect(analyse(declared).links[0]).toMatchObject({ canonical: true, value: '/rel/a' });
    expect(judge(declared, `<p>${link(text('x'))}</p>`)).toEqual(['unchanged']);
    expect(judge(`<p>${link(text('x'))}</p>`, declared)).toEqual(['unchanged']);
  });

  it('does not take an image URL, a body resource or a lookalike body for a link target', () => {
    const storage = '<p><ac:image><ri:url ri:value="/rel/a"></ri:url></ac:image>'
      + `${pageLink('<ac:link-body><ac:image><ri:url ri:value="/rel/a"></ri:url></ac:image></ac:link-body>')}</p>`;
    expect(analyse(storage).links).toEqual([]);
    // Neither is evidence for a link to the same value.
    expect(judge(storage, `<p>${link()}</p>`).some(isApprovedUrlLinkVerdict)).toBe(false);
    expect(judge(`<p>x <ac:image><ri:url ri:value="/rel/a"></ri:url></ac:image> y</p>`, `<p>z ${link()} w</p>`)).toEqual(['unproven']);
    // A body element of another vocabulary exempts nothing: the url inside it is found.
    const foreign = '<p><x:link xmlns:x="urn:x"><x:link-body><ri:url ri:value="/rel/a"></ri:url></x:link-body></x:link></p>';
    expect(analyse(foreign).links).toHaveLength(1);
    expect(analyse(foreign).links[0]!.canonical).toBe(false);
  });

  it('reads a target spelled with a disputed entity as the XHTML character, never as the HTML5 one', () => {
    const stored = `<p>${link(text('x'), '/rel/&lang;a&rang;')}</p>`;
    expect(analyse(stored).links[0]!.value).toBe('/rel/\u2329a\u232A');
    // What an HTML forward pass made of that value (U+27E8, U+27E9) is another target.
    expect(judge(stored, `<p>${link(text('x'), '/rel/\u27E8a\u27E9')}</p>`).some(isApprovedUrlLinkVerdict)).toBe(false);
    expect(judge(stored, `<p>${link(text('x'), '/rel/\u2329a\u232A')}</p>`)).toEqual(['unchanged']);
  });

  it('counts every link-like element and every anchor as something that points somewhere', () => {
    const analysis = analyse(`<p>${pageLink(text('home'))} <a href="https://example.com/">site</a> ${link(text('x'))} <a>no href</a></p>`);
    expect(analysis.linkLike).toBe(2);
    expect(analysis.claims.map((claim) => claim.target.split('|')[0])).toEqual(['link', 'a', 'url']);
    expect(analysis.links).toHaveLength(1);
    expect(analysis.links[0]!.ordinal).toBe(1);
  });
});

describe('confluence-url-origin: which written link stands for which stored one (#1955, V2, W4)', () => {
  it.each<[string, string | null, string, StorageUrlLinkVerdict[]]>([
    ['a navigable link needs no stored one', null, `<p>${link(text('x'), 'https://example.com/')}</p>`, ['navigable']],
    ['a link with nothing stored', null, `<p>see ${link(text('foo'))} now</p>`, ['unproven']],
    ['a link on a page that stores none', '<p>see now</p>', `<p>see ${link(text('foo'))} now</p>`, ['unproven']],
    ['the stored link, unchanged in place', `<p>see ${link(text('foo'))} now</p>`, `<p>see ${link(text('foo'))} now</p>`, ['unchanged']],
    [
      'the stored link, moved with its body unchanged',
      `<p>see ${link(text('foo'))} now</p><p>other</p>`, `<p>see now</p><p>other ${link(text('foo'))}</p>`, ['unchanged'],
    ],
    ['the stored link, relabelled in place', `<p>see ${link(text('foo'))} now</p>`, `<p>see ${link(text('bar'))} now</p>`, ['edited']],
    ['a link without a body given a text in place', `<p>see ${link()} now</p>`, `<p>see ${link(text('click'))} now</p>`, ['edited']],
    [
      'the stored link, moved and relabelled at once',
      `<p>see ${link(text('foo'))} now</p><p>other</p>`, `<p>see now</p><p>other ${link(text('bar'))}</p>`, ['unproven'],
    ],
    ['another value in the stored place', `<p>see ${link(text('foo'))} now</p>`, `<p>see ${link(text('foo'), 'javascript:alert(1)')} now</p>`, ['retarget']],
    ['an added attribute', `<p>see ${link(text('foo'))} now</p>`, `<p>see ${link(text('foo'), '/rel/a', ' ac:anchor="x"')} now</p>`, ['retarget']],
    [
      'two stored, two written',
      `<p>a ${link(text('foo'))} b ${link(text('foo'))} c</p>`, `<p>a ${link(text('foo'))} b ${link(text('foo'))} c</p>`, ['unchanged', 'unchanged'],
    ],
    [
      'two stored, one of them relabelled in place',
      `<p>a ${link(text('foo'))} b</p>${FILLER}<p>c ${link(text('foo'))} d</p>`,
      `<p>a ${link(text('foo'))} b</p>${FILLER}<p>c ${link(text('bar'))} d</p>`,
      ['unchanged', 'edited'],
    ],
    [
      'two stored, one deleted',
      `<p>a ${link(text('foo'))} b</p>${FILLER}<p>c ${link(text('foo'))} d</p>`, `<p>a b</p>${FILLER}<p>c ${link(text('foo'))} d</p>`, ['unchanged'],
    ],
  ])('%s', (_name, stored, written, verdicts) => {
    expect(judge(stored, written)).toEqual(verdicts);
  });

  it('declines a retarget balanced by a deletion: the image link takes the removed text link\'s target (V2)', () => {
    const stored = `<p>one ${link(text('foo'))} two</p><p>three ${link(image(), B)} four</p>`;
    expect(judge(stored, `<p>one two</p><p>three ${link(image())} four</p>`)).toEqual(['retarget']);
    // The same on a page that holds nothing but the two links: no surrounding text tells the places apart.
    expect(judge(`<p>${link(text('foo'))}</p><p>${link(image(), B)}</p>`, `<p>${link(image())}</p>`)).toEqual(['retarget']);
    // And when the retargeted link was a link of another kind.
    expect(judge(`<p>${link(text('foo'))}</p><p>${pageLink(image())}</p>`, `<p>${link(image())}</p>`)).toEqual(['retarget']);
  });

  it('keeps the unchanged original and declines a copy of it with another body (V2)', () => {
    const stored = `<p>see ${link(text('foo'))} now</p>`;
    expect(judge(stored, `<p>see ${link(text('foo'))} now</p><p>${link(image())}</p>`)).toEqual(['unchanged', 'unproven']);
    expect(judge(stored, `<p>${link(image())}</p><p>see ${link(text('foo'))} now</p>`)).toEqual(['unproven', 'unchanged']);
  });

  it('declines identical copies it cannot tell apart, and keeps the one still in the stored place (Q10)', () => {
    const stored = `${FILLER}<p>see ${link(text('foo'))} now</p>${FILLER}`;
    const original = `<p>see ${link(text('foo'))} now</p>`;
    const copy = `<p>${link(text('foo'))}</p>`;
    // A copy right beside the original changes the original's own surroundings.
    expect(judge(stored, `${FILLER}<p>see ${link(text('foo'))}${link(text('foo'))} now</p>${FILLER}`)).toEqual(['ambiguous', 'ambiguous']);
    // A copy elsewhere, before or after: the original is the one in the stored place.
    expect(judge(stored, `${copy}${FILLER}${original}${FILLER}`)).toEqual(['ambiguous', 'pinned']);
    expect(judge(stored, `${FILLER}${original}${FILLER}${copy}`)).toEqual(['pinned', 'ambiguous']);
    expect(judge(stored, `${copy}${FILLER}${original}${FILLER}${copy}`)).toEqual(['ambiguous', 'pinned', 'ambiguous']);
    // Two copies and no link in the stored place.
    expect(judge(stored, `${copy}${FILLER}<p>see now</p>${FILLER}${copy}`)).toEqual(['ambiguous', 'ambiguous']);
  });

  it('never lets a native anchor that looks like a carrier take the stored link\'s place (W4)', () => {
    const lookalike = (body: string): string => `<p>n <a href="#confluence-url:%2Frel%2Fa">${body}</a> m</p>`;
    const genuine = `<p>g ${link(text('foo'))} h</p>`;
    // Both written as links: the genuine one is kept, the anchor's stays an anchor's.
    expect(judge(`${genuine}${FILLER}${lookalike('bar')}`, `${genuine}${FILLER}<p>n ${link(text('bar'))} m</p>`)).toEqual(['unchanged', 'retarget']);
    expect(judge(`${genuine}${FILLER}${lookalike('foo')}`, `${genuine}${FILLER}<p>n ${link(text('foo'))} m</p>`)).toEqual(['unchanged', 'retarget']);
    // The genuine link removed, the lookalike still there with the same body: it does not inherit the grant.
    expect(judge(`${genuine}${FILLER}${lookalike('foo')}`, `<p>g h</p>${FILLER}<p>n ${link(text('foo'))} m</p>`)).toEqual(['retarget']);
    // A page that only ever held the anchor.
    expect(judge(lookalike('foo'), `<p>n ${link(text('foo'))} m</p>`)).toEqual(['retarget']);
  });

  it('does not approve a same-label retarget as a moved link: two stored targets labelled alike (W4)', () => {
    const stored = `<p>alpha ${link(text('Read'))} beta</p>${FILLER}<p>gamma ${link(text('Read'), B)} delta</p>`;
    // The first removed, the second pointed at the first's target: its surroundings still name the second.
    expect(judge(stored, `<p>alpha beta</p>${FILLER}<p>gamma ${link(text('Read'))} delta</p>`)).toEqual(['retarget']);
    expect(judge(stored, `${FILLER}<p>gamma ${link(text('Read'))} delta</p>`)).toEqual(['retarget']);
    // Moved to a new place while the other target's link with that label is gone: either could be its source.
    expect(judge(stored, `<p>alpha beta</p>${FILLER}<p>gamma delta</p><p>new ${link(text('Read'))} place</p>`)).toEqual(['ambiguous']);
    // Moved to a new place while the other one is still where it was: only one source is left.
    expect(judge(stored, `<p>alpha beta</p>${FILLER}<p>gamma ${link(text('Read'), B)} delta</p><p>new ${link(text('Read'))} place</p>`))
      .toEqual(['unchanged', 'unchanged']);
    // Both unchanged.
    expect(judge(stored, stored)).toEqual(['unchanged', 'unchanged']);
  });

  it('keeps word boundaries in a body: `A B` is not `AB` (W4)', () => {
    const stored = `<p>alpha ${link(text('A B'))} beta</p>${FILLER}<p>gamma ${link(text('AB'), B)} delta</p>`;
    expect(judge(stored, `<p>alpha beta</p>${FILLER}<p>gamma ${link(text('AB'))} delta</p>`)).toEqual(['retarget']);
    expect(judge(stored, `<p>alpha beta</p>${FILLER}<p>gamma delta</p><p>new ${link(text('AB'))} place</p>`)).toEqual(['retarget']);
    // White space an editor collapses is not a word boundary gained or lost.
    expect(judge(stored, `<p>alpha ${link(text(' A   B '))} beta</p>${FILLER}<p>gamma ${link(text('AB'), B)} delta</p>`))
      .toEqual(['unchanged', 'unchanged']);
  });

  it('tells images apart by their owner, not by the filename alone (W4)', () => {
    const owned = (title: string): string => image('i.png', `<ri:page ri:content-title="${title}"></ri:page>`);
    const stored = `<p>one ${link(owned('P1'))} two</p>${FILLER}<p>three ${link(owned('P2'), B)} four</p>`;
    expect(judge(stored, `<p>one two</p>${FILLER}<p>five ${link(owned('P2'))} six</p>`)).toEqual(['retarget']);
    expect(judge(stored, `<p>one two</p>${FILLER}<p>three four</p><p>five ${link(owned('P1'))} six</p>`)).toEqual(['unchanged']);
    // The image's own display attributes are not its identity.
    const resized = owned('P1').replace('<ac:image>', '<ac:image ac:width="40">');
    expect(judge(stored, `<p>one ${link(resized)} two</p>${FILLER}<p>three ${link(owned('P2'), B)} four</p>`)).toEqual(['unchanged', 'unchanged']);
  });

  it('compares a target\'s attributes whatever their order (W4)', () => {
    const stored = `<p>see <ac:link ac:a="1" ac:b="2"><ri:url ri:value="/rel/a" ri:x="1" ri:y="2"></ri:url>${text('foo')}</ac:link> now</p>`;
    const reordered = `<p>see <ac:link ac:b="2" ac:a="1"><ri:url ri:y="2" ri:x="1" ri:value="/rel/a"></ri:url>${text('foo')}</ac:link> now</p>`;
    expect(judge(stored, reordered)).toEqual(['unchanged']);
    expect(judge(stored, reordered.replace('ri:y="2"', 'ri:y="3"'))).toEqual(['retarget']);
  });

  it('uses the task a link stands in as part of its place (W4)', () => {
    const task = (id: number, body: string): string =>
      `<ac:task><ac:task-id>${id}</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>${body}</ac:task-body></ac:task>`;
    const stored = `<ac:task-list>${task(1, `Read ${link(text('here'))}`)}${task(2, `Read ${link(text('there'), B)}`)}</ac:task-list>`;
    const [first, second] = analyse(stored).links;
    expect(JSON.parse(first!.place)[0]).toBe('task:1');
    expect(JSON.parse(second!.place)[0]).toBe('task:2');
    expect(judge(stored, stored)).toEqual(['unchanged', 'unchanged']);
    // The second task's link pointed at the first's target, the first's link removed.
    expect(judge(stored, `<ac:task-list>${task(1, 'Read here')}${task(2, `Read ${link(text('there'))}`)}</ac:task-list>`)).toEqual(['retarget']);
  });

  it('gives a split body at most one link: #1954-A\'s one link per piece never adds a resource', () => {
    const mixed = '<ac:link-body>foo<ac:image><ri:attachment ri:filename="i.png"></ri:attachment></ac:image></ac:link-body>';
    // The text piece is the stored link relabelled in place; the image piece is a second link to the same target.
    expect(judge(`<p>x ${link(mixed)} y</p>`, `<p>x ${link(text('foo'))} y</p>${link(image())}`)).toEqual(['edited', 'unproven']);
    // Two image pieces compete for the one stored place: neither is the stored link.
    const two = '<ac:link-body><ac:image><ri:attachment ri:filename="i.png"></ri:attachment></ac:image>'
      + '<ac:image><ri:attachment ri:filename="j.png"></ri:attachment></ac:image></ac:link-body>';
    expect(judge(`<p>x ${link(two)} y</p>`, `<p>x y</p>${link(image('i.png'))}${link(image('j.png'))}`)).toEqual(['unproven', 'unproven']);
    expect(judge(`<p>x ${link(image('i.png'))} y</p>`, `<p>x ${link(image('j.png'))}${link(image('k.png'))} y</p>`)).toEqual(['unproven', 'unproven']);
  });

  it('never lets a dormant stored fragment prove a live link, and lets it prove itself', () => {
    expect(judge(`<style>${link(text('foo'))}</style>`, `<p>${link(text('foo'))}</p>`).some(isApprovedUrlLinkVerdict)).toBe(false);
    expect(judge(`<p>${link(text('foo'))}</p>`, `<template>${link(text('foo'))}</template>`).some(isApprovedUrlLinkVerdict)).toBe(false);
    expect(judge(`<style>${link(text('foo'))}</style>`, `<style>${link(text('foo'))}</style>`)).toEqual(['unchanged']);
  });

  it('approves no more links to a target than are stored, whatever is written', () => {
    const stored = `<p>a ${link(text('foo'))} b</p>${FILLER}<p>c ${link(text('foo'))} d</p>`;
    const variants = [
      `<p>a ${link(text('foo'))} b</p>${FILLER}<p>c ${link(text('foo'))} d</p><p>${link(text('foo'))}</p>`,
      `<p>a ${link(text('x'))} b</p>${FILLER}<p>c ${link(text('y'))} d</p><p>${link(text('z'))}</p>`,
      `<p>${link(text('foo'))}${link(text('foo'))}${link(text('foo'))}${link(text('bar'))}</p>`,
      `<p>a ${link(text('foo'))} b ${link(text('bar'))}</p>${FILLER}<p>c ${link(text('foo'))} d ${link(image())}</p>`,
    ];
    for (const written of variants) {
      expect(judge(stored, written).filter(isApprovedUrlLinkVerdict).length).toBeLessThanOrEqual(2);
    }
  });

  it('gives the same verdicts to the same links in another document order', () => {
    const first = `<p>a ${link(text('foo'))} b</p>`;
    const stored = `${FILLER}${first}${FILLER}<p>c ${link(text('bar'), B)} d</p>${FILLER}`;
    const second = `<p>c ${link(text('baz'), B)} d</p>`;
    const extra = `<p>${link(text('foo'))}</p>`;
    const kept = `${FILLER}${first}${FILLER}${second}${FILLER}`;
    expect(judge(stored, `${kept}${extra}`)).toEqual(['pinned', 'edited', 'ambiguous']);
    expect(judge(stored, `${extra}${kept}`)).toEqual(['ambiguous', 'pinned', 'edited']);
  });
});

describe('confluence-url-origin: a second Save is the first again (#1955)', () => {
  /** What the first write leaves in storage: every declined link unwrapped to its body. */
  it.each<[string, string, string, string, StorageUrlLinkVerdict[]]>([
    [
      'an image copy beside the original, in a room that keeps both anchors',
      `<p>see ${link(text('foo'))} now</p>`,
      `<p>see ${link(text('foo'))} now</p><p>${link(image())}</p>`,
      `<p>see ${link(text('foo'))} now</p><p><ac:image><ri:attachment ri:filename="i.png"></ri:attachment></ac:image></p>`,
      ['unchanged', 'unproven'],
    ],
    [
      'a split text + image body',
      `<p>x ${link('<ac:link-body>foo<ac:image><ri:attachment ri:filename="i.png"></ri:attachment></ac:image></ac:link-body>')} y</p>`,
      `<p>x ${link(text('foo'))} y</p>${link(image())}`,
      `<p>x ${link(text('foo'))} y</p><ac:image><ri:attachment ri:filename="i.png"></ri:attachment></ac:image>`,
      ['unchanged', 'unproven'],
    ],
    [
      'a distant identical copy',
      `${FILLER}<p>see ${link(text('foo'))} now</p>${FILLER}`,
      `${FILLER}<p>see ${link(text('foo'))} now</p>${FILLER}<p>${link(text('foo'))}</p>`,
      `${FILLER}<p>see ${link(text('foo'))} now</p>${FILLER}<p>foo</p>`,
      ['pinned', 'ambiguous'],
    ],
  ])('%s', (_name, stored, room, afterFirstSave, secondVerdicts) => {
    const first = judge(stored, room);
    // What the first Save kept is what the second Save keeps, judged against what the first wrote.
    expect(judge(afterFirstSave, room).map(isApprovedUrlLinkVerdict)).toEqual(first.map(isApprovedUrlLinkVerdict));
    expect(judge(afterFirstSave, room)).toEqual(secondVerdicts);
    // And the storage the first Save wrote is itself the identity.
    expect(judge(afterFirstSave, afterFirstSave).every(isApprovedUrlLinkVerdict)).toBe(true);
  });
});

// Review r1, R2. A stored `<a href="#confluence-url:…">` is an ordinary anchor that body_html cannot tell
// from the carrier of a link: when one of the two goes, the one that stays is not known to be the link.
describe('confluence-url-origin: a stored lookalike never inherits a deleted link (R2)', () => {
  const genuine = link();
  const lookalike = '<a href="#confluence-url:%2Frel%2Fa">/rel/a</a>';
  /** What write-back builds from either anchor once only one is left. */
  const left = `<p>${link()}</p>`;

  it.each([
    ['the link first', `<p>${genuine}</p><p>${lookalike}</p>`],
    ['the lookalike first', `<p>${lookalike}</p><p>${genuine}</p>`],
  ])('declines the one left of two adjacent paragraphs, %s, on both Saves', (_order, stored) => {
    expect(judge(stored, left)).toEqual(['ambiguous']);
    // The first Save wrote text; the room keeps its anchor and the second Save has nothing stored.
    expect(judge('<p>/rel/a</p>', left)).toEqual(['unproven']);
  });

  it('declines the one left where both stood in the same surroundings', () => {
    const around = (inner: string): string => `${FILLER}<p>X ${inner} Y</p>`;
    const stored = `${around(genuine)}${around(lookalike)}${FILLER}`;
    // Either paragraph deleted: what is left stands in the stored place of both.
    expect(judge(stored, `${FILLER}${around(link())}${FILLER}`)).toEqual(['ambiguous']);
  });

  it('declines a link with a text of its own beside a lookalike with that text, as before', () => {
    const labelled = '<a href="#confluence-url:%2Frel%2Fa?body=plain">the docs</a>';
    expect(judge(`<p>${link(text('the docs'))}</p><p>${labelled}</p>`, `<p>${link(text('the docs'))}</p>`)).toEqual(['ambiguous']);
  });

  it('declines a link relabelled in place to the text of a stored anchor that points elsewhere', () => {
    const stored = `<p>See ${link(text('Guide'))} now</p>${FILLER}<p>${lookalike}</p>`;
    // The link lost its label, or the lookalike took its place: the same storage either way.
    expect(judge(stored, `<p>See ${link()} now</p>${FILLER}`)).toEqual(['retarget']);
  });

  it('keeps the link where nothing competes: moved, and in its own place beside a deleted lookalike', () => {
    expect(judge(`${FILLER}<p>a</p><p>${genuine}</p>`, `<p>${genuine}</p>${FILLER}<p>a</p>`)).toEqual(['unchanged']);
    expect(judge(`<p>a</p><p>${genuine}</p><p>${lookalike}</p>`, `<p>${genuine}</p><p>a</p><p>${lookalike}</p>`)).toEqual(['unchanged']);
    const far = `<p>See ${genuine} first</p>${FILLER}`;
    expect(judge(`${far}<p>${lookalike}</p>`, far)).toEqual(['unchanged']);
  });
});

// Review r2, R11. A link of another kind without a body shows what the forward pass shows for it (a title, a
// key, a value): that text is its body and part of the places around it, as an explicit body would be. A link
// whose shown text is not known (a mention, an unknown resource) is never taken for empty: it stands in the
// places around it, and its absence from what is written leaves a moved link with no other proof ambiguous.
describe('confluence-url-origin: every link shows what the forward pass shows (R11)', () => {
  const genuine = link();
  const pageBare = '<ac:link><ri:page ri:content-title="/rel/a"></ri:page></ac:link>';
  const pageLabelled = `<ac:link><ri:page ri:content-title="Home"></ri:page>${text('/rel/a')}</ac:link>`;
  const spaceBare = '<ac:link><ri:space ri:space-key="/rel/a"></ri:space></ac:link>';
  const anchorBare = '<ac:link ac:anchor="/rel/a"></ac:link>';
  const mention = '<ac:link><ri:user ri:userkey="u-1"></ri:user></ac:link>';
  const left = `<p>${link()}</p>`;

  it('gives a body-less link of every kind the text it shows as its body, as an explicit body would', () => {
    const { claims } = analyse(`<p>${pageBare}</p><p>${pageLabelled}</p><p>${spaceBare}</p><p>${anchorBare}</p>`);
    expect(claims.map((claim) => claim.body)).toEqual(Array(4).fill(JSON.stringify(['/rel/a', []])));
  });

  it.each([
    ['a body-less page link', pageBare],
    ['a labelled page link', pageLabelled],
    ['a body-less space link', spaceBare],
    ['a body-less anchor link', anchorBare],
  ])('declines the one left of a URL link and %s showing the same text, in either order, on both Saves', (_name, other) => {
    for (const stored of [`<p>${genuine}</p><p>${other}</p>`, `<p>${other}</p><p>${genuine}</p>`]) {
      expect(judge(stored, left)).toEqual(['ambiguous']);
      // Nothing deleted: the original is kept.
      expect(judge(stored, stored)).toEqual(['unchanged']);
    }
    // The first Save wrote text; the second has nothing stored.
    expect(judge('<p>/rel/a</p>', left)).toEqual(['unproven']);
  });

  it('declines a link relabelled in place to the text a body-less page link elsewhere shows', () => {
    const stored = `<p>See ${link(text('Guide'))} now</p>${FILLER}<p>${pageBare}</p>`;
    expect(judge(stored, `<p>See ${link()} now</p>${FILLER}`)).toEqual(['retarget']);
    expect(judge(stored, `<p>See ${link(text('Guidance'))} now</p>${FILLER}<p>${pageBare}</p>`)).toEqual(['edited']);
  });

  it('never takes a link whose shown text is not known for one that shows nothing', () => {
    expect(analyse(`<p>${mention}</p>`).claims.map((claim) => claim.body)).toEqual(['']);
    const stored = `<p>${genuine}</p><p>${mention}</p>`;
    expect(judge(stored, left)).toEqual(['ambiguous']);
    // While it is still written in its own place, nothing changes (coordinator decision D20, review r6 R27).
    expect(judge(stored, stored)).toEqual(['unchanged']);
    // Moved, it is released by nothing: its own place no longer holds it.
    expect(judge(`${FILLER}<p>a</p><p>${genuine}</p><p>${mention}</p>`, `<p>${genuine}</p>${FILLER}<p>a</p><p>${mention}</p>`))
      .toEqual(['ambiguous']);
  });
});

// Review r3, R16. A label is compared in the text the editor shows. A page link without a body shows its title
// with white space collapsed, and with the HTML reading of `&lang;`/`&rang;` that the XML reading cannot see: such a
// title is a rival of unknown text, never one known to differ.
describe('confluence-url-origin: a title is compared as the editor shows it (R16)', () => {
  const guide = (shown: string): string => `<ac:link><ri:url ri:value="/guide"></ri:url>${text(shown)}</ac:link>`;
  const page = (title: string, body = ''): string => `<ac:link><ri:page ri:content-title="${title}"></ri:page>${body}</ac:link>`;

  it.each([
    ['white space the editor collapses', 'Ops  guide', 'Ops guide'],
    ['a disputed entity name', 'Ops&lang;guide', 'Ops\u27E8guide'],
  ])('gives the URL link left of two the same verdict whether the page link with %s shows its title or a body', (_name, title, shown) => {
    for (const other of [page(title), page(title, text(shown))]) {
      for (const stored of [`<p>${guide(shown)}</p><p>${other}</p>`, `<p>${other}</p><p>${guide(shown)}</p>`]) {
        expect(judge(stored, `<p>${guide(shown)}</p>`)).toEqual(['ambiguous']);
        expect(judge(stored, stored)).toEqual(['unchanged']);
      }
    }
  });

  it('takes a title for its collapsed text, or for unknown text where the HTML reading may differ', () => {
    expect(analyse(`<p>${page('Ops \t guide')}</p>`).claims[0]!.body).toBe(JSON.stringify(['Ops guide', []]));
    for (const title of ['Ops&lang;guide', 'Ops&rang;', 'Ops&#9001;guide', 'Ops&#128;']) {
      expect(analyse(`<p>${page(title)}</p>`).claims[0]!.body).toBe('');
    }
  });
});

// Review r1, R6. No cap of this module takes a link away: what cannot be judged within the work limit is refused.
describe('confluence-url-origin: a long or rich body is evidence like any other (R6)', () => {
  it.each([4_096, 4_097, 100_000])('keeps an unchanged link whose plain body has %i characters', (length) => {
    const storage = `<p>see ${link(text('x'.repeat(length)))} now</p>`;
    expect(analyse(storage).links[0]!.body).toBe(JSON.stringify(['x'.repeat(length), []]));
    expect(judge(storage, storage)).toEqual(['unchanged']);
    expect(judge(storage, `<p>see ${link(text(`${'x'.repeat(length - 1)}y`))} now</p><p>z</p>`)).toEqual(['unproven']);
  });

  it('keeps an unchanged link around forty images, and around an image with long attributes', () => {
    const picture = (name: string): string => `<ac:image ac:alt="${name}"><ri:attachment ri:filename="${name}.png"></ri:attachment></ac:image>`;
    const gallery = `<p>${link(`<ac:link-body>${Array.from({ length: 40 }, (_, index) => picture(`i${index}`)).join('')}</ac:link-body>`)}</p>`;
    expect(judge(gallery, gallery)).toEqual(['unchanged']);
    const described = `<p>${link(`<ac:link-body>${picture('d'.repeat(6_000))}</ac:link-body>`)}</p>`;
    expect(judge(described, described)).toEqual(['unchanged']);
    // The fortieth image and the last character of the long name are part of what is compared: in place the
    // link is the stored one with another body, moved as well it is no link the page holds.
    const otherGallery = gallery.replace('i39.png', 'other.png');
    const otherDescribed = described.replace(`${'d'.repeat(6_000)}.png`, `${'d'.repeat(5_999)}e.png`);
    expect(judge(gallery, otherGallery)).toEqual(['edited']);
    expect(judge(described, otherDescribed)).toEqual(['edited']);
    expect(judge(gallery, `<p>z</p>${otherGallery}`)).toEqual(['unproven']);
    expect(judge(described, `<p>z</p>${otherDescribed}`)).toEqual(['unproven']);
  });
});

describe('confluence-url-origin: bounded work (W5)', () => {
  const tight = (over: Partial<StorageLinkLimits>): StorageLinkLimits => ({ ...STORAGE_LINK_LIMITS, ...over });

  it('stops an analysis past its work limit, on wide, deep and repeated input', () => {
    const wide = `<p>${link(text('x')).repeat(50)}</p>`;
    const deep = `${'<ac:link><ac:link-body>'.repeat(40)}${link()}${'</ac:link-body></ac:link>'.repeat(40)}`;
    const images = `<p>${link(`<ac:link-body>${'<ac:image><ri:attachment ri:filename="i.png"></ri:attachment></ac:image>'.repeat(20)}</ac:link-body>`)}</p>`;
    for (const storage of [wide, deep, images]) {
      expect(() => analyse(storage, tight({ work: 60 }))).toThrow(StorageLinkBudgetError);
      expect(() => analyse(storage)).not.toThrow();
    }
  });

  it('charges a judgement to the same kind of limit, and it grows with the links, not with their square', () => {
    const many = (count: number, value: (index: number) => string): string =>
      `<p>${Array.from({ length: count }, (_, index) => `w${index} ${link(text(`t${index}`), value(index))}`).join(' ')}</p>`;
    const distinct = analyse(many(400, (index) => `/rel/${index}`));
    const repeated = analyse(many(400, () => '/rel/0'));
    expect(() => judgeStorageUrlLinks(distinct, distinct, tight({ work: 100 }))).toThrow(StorageLinkBudgetError);
    // 400 links against 400: a budget of a few steps per link is enough for either shape.
    expect(judgeStorageUrlLinks(distinct, distinct, tight({ work: 400 * 12 })).every((verdict) => verdict === 'unchanged')).toBe(true);
    expect(judgeStorageUrlLinks(repeated, repeated, tight({ work: 400 * 12 })).every((verdict) => verdict === 'unchanged')).toBe(true);
    expect(judgeStorageUrlLinks(repeated, distinct, tight({ work: 400 * 12 })).filter(isApprovedUrlLinkVerdict)).toHaveLength(1);
  });

  // Review r1, R5: every case below is a count of charged steps, never a verdict, a length or a duration.
  it('charges what it is about to keep before it keeps it: bodies of nested links', () => {
    // 40 links in each other's bodies around 2,000 characters: 40 bodies of 2,000 characters each.
    const depth = 40;
    const nested = `${'<ac:link><ri:url ri:value="/rel/a"></ri:url><ac:link-body>'.repeat(depth)}${'x'.repeat(2_000)}${'</ac:link-body></ac:link>'.repeat(depth)}`;
    expect(() => analyse(nested, tight({ work: 40_000 }))).toThrow(StorageLinkBudgetError);
    expect(() => analyse(nested, tight({ work: 120_000 }))).not.toThrow();
    // One link around the same text costs the text once.
    expect(() => analyse(link(`<ac:link-body>${'x'.repeat(2_000)}</ac:link-body>`), tight({ work: 3_000 }))).not.toThrow();
  });

  it('charges what it is about to keep before it keeps it: media of nested links', () => {
    const images = '<ac:image><ri:attachment ri:filename="a-file-name-of-some-length.png"></ri:attachment></ac:image>'.repeat(25);
    const depth = 30;
    const nested = `${'<ac:link><ri:url ri:value="/rel/a"></ri:url><ac:link-body>'.repeat(depth)}${images}${'</ac:link-body></ac:link>'.repeat(depth)}`;
    // 25 descriptions of about 100 characters, kept by each of 30 links: about 75,000 characters.
    expect(() => analyse(nested, tight({ work: 30_000 }))).toThrow(StorageLinkBudgetError);
    expect(() => analyse(nested, tight({ work: 300_000 }))).not.toThrow();
  });

  it('describes no image that no link holds', () => {
    const images = '<ac:image ac:alt="an alternative text of some length"><ri:attachment ri:filename="i.png"></ri:attachment></ac:image>'.repeat(1_000);
    // 1 + 2,000 elements, one step each; a description of each image would cost its attributes as well.
    expect(() => analyse(`<p>${images}</p>`, tight({ work: 2_100 }))).not.toThrow();
  });

  it('charges the attribute values of what it describes', () => {
    const odd = `<ac:link ac:x="${'v'.repeat(20_000)}"><ri:url ri:value="/rel/a"></ri:url><span>x</span></ac:link>`;
    expect(() => analyse(odd, tight({ work: 5_000 }))).toThrow(StorageLinkBudgetError);
    expect(() => analyse(odd, tight({ work: 50_000 }))).not.toThrow();
  });

  it('describes the element below a link once per link that is not the exact shape, each node at its cost', () => {
    // 20 malformed links in each other's stray content around 500 elements: 20 descriptions of up to 500 elements.
    const depth = 20;
    const nested = `${'<ac:link><ri:url ri:value="/rel/a"></ri:url><span>'.repeat(depth)}${'<i></i>'.repeat(500)}${'</span></ac:link>'.repeat(depth)}`;
    expect(() => analyse(nested, tight({ work: 20_000 }))).toThrow(StorageLinkBudgetError);
    expect(() => analyse(nested, tight({ work: 2_000_000 }))).not.toThrow();
  });

  it('judges links that share one body and differ in target in steps that grow with their number', () => {
    const count = 400;
    const page = (label: (index: number) => string): string =>
      `<p>${Array.from({ length: count }, (_, index) => `${label(index)} ${link(text('same'), `/rel/${index}`)}`).join(' ')}</p>`;
    // Every link moved (another word before it): each is compared with the stored links of its body.
    const stored = analyse(page((index) => `w${index}`));
    const moved = analyse(page((index) => `v${index}`));
    const verdicts = judgeStorageUrlLinks(moved, stored, tight({ work: count * 20 }));
    expect(verdicts).toHaveLength(count);
    expect(verdicts.every((verdict) => verdict === 'unchanged')).toBe(true);
    // With one of the 400 targets gone from what is written, every moved link could be that one retargeted.
    const fewer = analyse(page((index) => `v${index}`).replace(link(text('same'), '/rel/7'), 'gone'));
    expect(judgeStorageUrlLinks(fewer, stored, tight({ work: count * 20 })).every((verdict) => verdict === 'ambiguous')).toBe(true);
  });

  it('describes nested links without reading an inner body once per ancestor', () => {
    // 30 links nested in each other's bodies around one text: the text is taken once, each body is a range of it.
    const depth = 30;
    const nested = `${`<ac:link><ri:url ri:value="/rel/a"></ri:url><ac:link-body>`.repeat(depth)}core${'</ac:link-body></ac:link>'.repeat(depth)}`;
    const analysis = analyse(`<p>${nested}</p>`, tight({ work: 2_000 }));
    expect(analysis.links).toHaveLength(depth);
    expect(new Set(analysis.links.map((found) => found.body))).toEqual(new Set([JSON.stringify(['core', []])]));
  });

  // Review r2, R13: work done where it is done, counted as the elements every array membership test of an
  // analysis compares (`includes`, `indexOf`). It grows with a link's children, not with their square.
  it('tells a link\'s bodies from its other children in one pass over them', () => {
    const compared = (bodies: number): number => {
      const read = readConfluenceStorage(link(text('b').repeat(bodies)));
      if (!read.ok) throw new Error(read.reason);
      const spies = [vi.spyOn(Array.prototype, 'includes'), vi.spyOn(Array.prototype, 'indexOf')];
      try {
        analyseStorageLinks(read.tree);
        return spies.reduce((sum, spy) => sum + spy.mock.contexts.reduce((n: number, list) => n + (list as unknown[]).length, 0), 0);
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    };
    // At e084eeae: 36, 136 and 528 comparisons for 8, 16 and 32 bodies.
    for (const bodies of [8, 16, 32, 128]) expect(compared(bodies)).toBeLessThanOrEqual(4 * bodies + 16);
  });
});
