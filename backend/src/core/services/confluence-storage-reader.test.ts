/**
 * #1955: the storage-format reader. A storage string is read the way an XML
 * consumer reads it, never the way the HTML document it was serialised from
 * looked: text of a raw-text element or a template is markup there.
 */
import { describe, it, expect } from 'vitest';
import he from 'he';
import {
  CONFLUENCE_STORAGE_NAMESPACES,
  ConfluenceStorageRefusedError,
  isStorageName,
  readConfluenceStorage,
  resemblesStorageName,
  scanStorageForStartTag,
  STORAGE_ENTITIES,
  STORAGE_READER_LIMITS,
  STORAGE_UNDECLARED_NAMESPACE,
  storageElements,
  storageText,
  type StorageElement,
  type StorageTree,
} from './confluence-storage-reader.js';
import { ORACLE_ENTITIES, oracleLocalNameCount, oracleReads, storageOracle } from './__fixtures__/storage-oracle.js';
import { STORAGE_READER_CORPUS } from './__fixtures__/storage-reader-corpus.js';
import { confluenceToHtml, htmlToConfluence } from './content-converter.js';

function read(storage: string): StorageTree {
  const result = readConfluenceStorage(storage);
  if (!result.ok) throw new Error(`not read: ${result.reason}`);
  return result.tree;
}

function reason(storage: string, limits = STORAGE_READER_LIMITS): string {
  const result = readConfluenceStorage(storage, limits);
  return result.ok ? 'ok' : result.reason;
}

function named(tree: StorageTree, name: string): StorageElement[] {
  return [...storageElements(tree)].filter((element) => element.name === name);
}

describe('confluence-storage-reader: reading (#1955)', () => {
  it('reads top-level text and several top-level elements, in document order', () => {
    const tree = read('a<p>b</p>c<p>d<b>e</b></p>');
    expect(tree.root.children.map((child) => (typeof child === 'string' ? child : child.name))).toEqual(['a', 'p', 'c', 'p']);
    expect([...storageElements(tree)].map((element) => element.name)).toEqual(['p', 'p', 'b']);
    expect(storageText(tree.root)).toBe('abcde');
    expect(read('').root.children).toEqual([]);
  });

  it('reads CDATA as text and joins a `]]>` split across two sections', () => {
    const tree = read('<ac:plain-text-body><![CDATA[<ac:link><ri:url ri:value="x"/></ac:link> a]]]]><![CDATA[>b]]></ac:plain-text-body>');
    expect([...storageElements(tree)].map((element) => element.name)).toEqual(['ac:plain-text-body']);
    expect(tree.root.children).toHaveLength(1);
    expect(storageText(tree.root)).toBe('<ac:link><ri:url ri:value="x"/></ac:link> a]]>b');
  });

  it('drops comments and processing instructions, whatever they hold', () => {
    const tree = read('<p>a<!-- <ri:url ri:value="x"/> > " -->b<?pi <ri:url/> ?>c</p>');
    expect([...storageElements(tree)].map((element) => element.name)).toEqual(['p']);
    expect(storageText(tree.root)).toBe('abc');
  });

  it('decodes numeric references and the XHTML 1.0 entities, in text and in attribute values', () => {
    const tree = read('<p title="a&nbsp;b &amp; &#x41;&#66;">&nbsp;&mdash;&rsquo;&copy;&euro;&lt;&gt;&quot;&apos;</p>');
    const p = named(tree, 'p')[0]!;
    expect(p.attributes).toEqual([{ name: 'title', prefix: '', local: 'title', uri: '', value: 'a\u00a0b & AB' }]);
    expect(storageText(p)).toBe('\u00a0\u2014\u2019\u00a9\u20ac<>"\'');
  });

  it('admits exactly the 248 XHTML 1.0 names with the code points that DTD declares', () => {
    expect(STORAGE_ENTITIES.size).toBe(248);
    const disputed = new Map([['lang', '\u2329'], ['rang', '\u232A']]);
    for (const [name, value] of STORAGE_ENTITIES) {
      // Every value but the two HTML5 redefined is what an HTML decoder gives the name.
      expect(value, name).toBe(disputed.get(name) ?? he.decode(`&${name};`));
      expect([...value], name).toHaveLength(1);
    }
    // HTML5 reads the two as mathematical angle brackets: not the same string, so never the same target.
    expect(he.decode('&lang;&rang;')).toBe('\u27E8\u27E9');
    expect(storageText(read('<p>&lang;&rang;</p>').root)).toBe('\u2329\u232A');
  });

  it.each([
    ['an entity XHTML 1.0 does not declare', '<p>&check;</p>'],
    ['an unknown entity', '<p>&bogus;</p>'],
    ['a raw < in an attribute value', '<p title="a<b">x</p>'],
    ['an unquoted attribute value', '<p title=a>x</p>'],
    ['an attribute without a value', '<input checked />'],
    ['a repeated attribute', '<p a="1" a="2">x</p>'],
    ['an element left open', '<p>a'],
    ['a void element left open', '<p>a<br>b</p>'],
    ['a stray end tag', 'a</p>'],
    ['mismatched tags', '<p><b>a</p></b>'],
    ['a comment holding --', '<p><!-- a -- b --></p>'],
    [']]> in text', '<p>a ]]> b</p>'],
    ['a character XML forbids', '<p>a\u0001b</p>'],
    ['a reference to a character XML forbids', '<p>a&#1;b</p>'],
    ['a document type declaration', '<!DOCTYPE x [<!ENTITY e "<ri:url/>">]><p>&e;</p>'],
    ['an XML declaration', '<?xml version="1.0"?><p>a</p>'],
    ['a name with two colons', '<a:b:c/>'],
    ['the same expanded attribute name twice', '<p xmlns:x="urn:u" xmlns:y="urn:u" x:a="1" y:a="2"/>'],
  ])('refuses %s as not well-formed', (_name, storage) => {
    expect(reason(storage)).toBe('not-well-formed');
  });

  it('applies XML attribute-value normalisation: a literal tab or line feed is a space, a referenced one is itself', () => {
    const url = named(read('<ri:url ri:value="a\tb\nc&#9;d&#10;e&#13;f  g"/>'), 'ri:url')[0]!;
    expect(url.attributes[0]!.value).toBe('a b c\td\ne\rf  g');
  });

  it('never throws, on any truncation of a storage string', () => {
    const storage = '<p title="a &amp; b">x<ac:link ac:anchor="q"><ri:url ri:value="/a&#9;b" />'
      + '<ac:plain-text-link-body><![CDATA[t]]></ac:plain-text-link-body></ac:link>&nbsp;<!-- c --></p>';
    for (let length = 0; length <= storage.length; length += 1) {
      expect(() => readConfluenceStorage(storage.slice(0, length))).not.toThrow();
      expect(() => scanStorageForStartTag(storage.slice(0, length), 'url')).not.toThrow();
    }
    expect(reason(storage)).toBe('ok');
  });
});

describe('confluence-storage-reader: names and namespaces (W1)', () => {
  const { ac, ri } = CONFLUENCE_STORAGE_NAMESPACES;

  it('binds ac, ri and at as Confluence does when the fragment declares nothing', () => {
    const tree = read('<ac:link ac:anchor="x"><ri:url ri:value="/a"/></ac:link><at:var at:name="v"/>');
    const link = named(tree, 'ac:link')[0]!;
    const url = named(tree, 'ri:url')[0]!;
    expect(link).toMatchObject({ name: 'ac:link', prefix: 'ac', local: 'link', uri: ac });
    expect(link.attributes).toEqual([{ name: 'ac:anchor', prefix: 'ac', local: 'anchor', uri: ac, value: 'x' }]);
    expect(url.attributes).toEqual([{ name: 'ri:value', prefix: 'ri', local: 'value', uri: ri, value: '/a' }]);
    expect(isStorageName(link, 'ac', 'link')).toBe(true);
    expect(isStorageName(url, 'ri', 'url')).toBe(true);
    expect(isStorageName(url.attributes[0]!, 'ri', 'value')).toBe(true);
    expect(named(tree, 'at:var')[0]!.uri).toBe(CONFLUENCE_STORAGE_NAMESPACES.at);
  });

  it('takes an explicit declaration of the same namespaces for the same names, and keeps it out of the attributes', () => {
    const tree = read(`<ac:link xmlns:ac="${ac}"><ri:url xmlns:ri="${ri}" ri:value="/a"/></ac:link>`);
    const link = named(tree, 'ac:link')[0]!;
    const url = named(tree, 'ri:url')[0]!;
    expect(isStorageName(link, 'ac', 'link')).toBe(true);
    expect(isStorageName(url, 'ri', 'url')).toBe(true);
    expect(link.attributes).toEqual([]);
    expect(url.attributes.map((attribute) => attribute.name)).toEqual(['ri:value']);
  });

  it('tells a rebound prefix from the Confluence name: same qualified name, another namespace', () => {
    const tree = read(
      '<ac:link><ri:url ri:value="/outer"/></ac:link>'
      + '<div xmlns:ac="urn:other" xmlns:ri="urn:other-ri"><ac:link><ri:url ri:value="/inner"/></ac:link></div>',
    );
    const [outer, inner] = named(tree, 'ac:link');
    expect(outer!.name).toBe(inner!.name);
    expect(outer!.uri).toBe(ac);
    expect(inner!.uri).toBe('urn:other');
    expect(isStorageName(outer!, 'ac', 'link')).toBe(true);
    expect(isStorageName(inner!, 'ac', 'link')).toBe(false);
    expect(resemblesStorageName(inner!, 'link')).toBe(true);
    const innerUrl = named(tree, 'ri:url')[1]!;
    expect(isStorageName(innerUrl, 'ri', 'url')).toBe(false);
    expect(isStorageName(innerUrl.attributes[0]!, 'ri', 'value')).toBe(false);
    // The independent oracle agrees on the namespaces.
    const links = [...storageOracle(
      '<ac:link><ri:url ri:value="/outer"/></ac:link>'
      + '<div xmlns:ac="urn:other" xmlns:ri="urn:other-ri"><ac:link><ri:url ri:value="/inner"/></ac:link></div>',
    ).getElementsByTagName('ac:link')];
    expect(links.map((link) => link.namespaceURI)).toEqual([ac, 'urn:other']);
  });

  it('recognises an alias of the Confluence namespace and an upper-case name, and gives neither authority', () => {
    const tree = read(`<x:link xmlns:x="${ac}"><y:url xmlns:y="${ri}" y:value="/a"/></x:link><AC:LINK><RI:URL RI:VALUE="/b"/></AC:LINK>`);
    const [alias, aliasUrl, upper, upperUrl] = [...storageElements(tree)];
    expect(alias).toMatchObject({ name: 'x:link', uri: ac });
    expect(isStorageName(alias!, 'ac', 'link')).toBe(false);
    expect(resemblesStorageName(alias!, 'link')).toBe(true);
    expect(resemblesStorageName(aliasUrl!, 'url')).toBe(true);
    expect(upper).toMatchObject({ name: 'AC:LINK', uri: `${STORAGE_UNDECLARED_NAMESPACE}AC` });
    expect(isStorageName(upper!, 'ac', 'link')).toBe(false);
    expect(resemblesStorageName(upper!, 'link')).toBe(true);
    expect(resemblesStorageName(upperUrl!, 'url')).toBe(true);
  });

  it('reads an undeclared prefix as written and an unprefixed name in no namespace or the declared default', () => {
    const tree = read(`<foo:bar baz:q="1"/><link><url value="/a"/></link><link xmlns="${ac}"/>`);
    const [foo, bare, , defaulted] = [...storageElements(tree)];
    expect(foo).toMatchObject({ name: 'foo:bar', uri: `${STORAGE_UNDECLARED_NAMESPACE}foo` });
    expect(foo!.attributes[0]).toMatchObject({ name: 'baz:q', uri: `${STORAGE_UNDECLARED_NAMESPACE}baz` });
    expect(bare).toMatchObject({ name: 'link', prefix: '', uri: '' });
    expect(defaulted).toMatchObject({ name: 'link', prefix: '', uri: ac });
    expect(isStorageName(defaulted!, 'ac', 'link')).toBe(false);
    expect(resemblesStorageName(defaulted!, 'link')).toBe(true);
  });
});

describe('confluence-storage-reader: bounded work (W5)', () => {
  const limits = { length: 64, depth: 3, nodes: 6 };

  it('refuses a string over the length limit without parsing it', () => {
    expect(reason('<p>'.padEnd(65, 'x'), limits)).toBe('too-large');
    expect(reason(`<p>${'x'.repeat(57)}</p>`, limits)).toBe('ok');
  });

  it('refuses nesting past the depth limit', () => {
    expect(reason('<a><b><c>x</c></b></a>', limits)).toBe('ok');
    expect(reason('<a><b><c><d/></c></b></a>', limits)).toBe('too-deep');
  });

  it('charges elements, attributes and text runs to one node budget', () => {
    expect(reason('<a x="1" y="2">t</a><b/><c/>', limits)).toBe('ok'); // 1 + 2 + 1 + 1 + 1
    expect(reason('<a x="1" y="2">t</a><b/><c/>u', limits)).toBe('too-many-nodes');
    expect(reason('<a x="1" y="2" z="3"/><b/><c/><d/>', limits)).toBe('too-many-nodes');
  });

  it('stops reading at the first failure: nothing after it is parsed', () => {
    // 200,000 further elements would pass the node limit long before the end if they were read.
    const tail = '<x/>'.repeat(200_000);
    const started = performance.now();
    expect(reason(`<a><b><c><d/></c></b></a>${tail}`, { ...limits, length: 10_000_000 })).toBe('too-deep');
    expect(reason(`<p>a ]]> b</p>${tail}`)).toBe('not-well-formed');
    const cut = performance.now() - started;
    const whole = performance.now();
    expect(reason(tail)).toBe('ok');
    // Reading the whole tail takes clearly longer than failing at its start (two failed reads above).
    expect(cut).toBeLessThan((performance.now() - whole) * 2 + 50);
  });

  it('walks a tree at the depth limit without recursion', () => {
    const depth = STORAGE_READER_LIMITS.depth;
    const tree = read('<d>'.repeat(depth) + 'x' + '</d>'.repeat(depth));
    expect([...storageElements(tree)]).toHaveLength(depth);
    expect(storageText(tree.root)).toBe('x');
    expect(reason('<d>'.repeat(depth + 1) + '</d>'.repeat(depth + 1))).toBe('too-deep');
  });
});

describe('confluence-storage-reader: the lexical scan of a string it could not read (W2)', () => {
  it.each([
    ['prose that mentions the name', '<p title="a<b">field:url value, a &lt;url&gt; and 1 &lt; url &gt; 0</p>', 'no'],
    ['the name in a comment', '<p title="a<b">x</p><!-- <ri:url ri:value="/a"/> -->', 'no'],
    ['the name in a CDATA section', '<p title="a<b">x</p><ac:plain-text-body><![CDATA[<ri:url ri:value="/a"/>]]></ac:plain-text-body>', 'no'],
    ['the name in a quoted attribute value', '<p title="a<b" data-x="<ri:url ri:value=\'/a\'/>">x</p>', 'no'],
    ['the name in a single-quoted attribute value', "<p title=\"a<b\" data-x='<ri:url/>'>x</p>", 'no'],
    ['the name in a processing instruction', '<p title="a<b">x</p><?pi <ri:url/> ?>', 'no'],
    ['an end tag only', '<p title="a<b">x</p></ri:url>', 'no'],
    ['a longer name', '<p title="a<b">x</p><ri:urls/><curl/>', 'no'],
    ['a start tag of that name', '<p title="a<b">x</p><style><ac:link><ri:url ri:value="/a"/></ac:link></style>', 'yes'],
    ['an unprefixed start tag of that name', '<p title="a<b">x</p><url value="/a">', 'yes'],
    ['an upper-case start tag of that name', '<p title="a<b">x</p><RI:URL RI:VALUE="/a"/>', 'yes'],
    ['a start tag of that name before a line feed', '<p title="a<b">x</p><ri:url\nri:value="/a"/>', 'yes'],
    ['an unterminated comment', '<p title="a<b">x</p><!-- <ri:url/>', 'indeterminate'],
    ['an unterminated CDATA section', '<p title="a<b">x</p><![CDATA[ <ri:url/>', 'indeterminate'],
    ['an unterminated quoted value', '<p title="a<b>x</p><ri:url/>', 'indeterminate'],
    ['an unterminated tag', '<p title="a<b">x</p><div <ri:url/', 'indeterminate'],
    ['a declaration', '<!DOCTYPE x><p>y</p>', 'indeterminate'],
  ])('%s: %s → %s', (_name, storage, verdict) => {
    expect(scanStorageForStartTag(storage, 'url')).toBe(verdict);
  });

  it('finds the start tag the reader would have read, when the string is well-formed', () => {
    for (const storage of [
      '<p><ac:link><ri:url ri:value="/a"></ri:url></ac:link></p>',
      '<p>field:url value</p>',
      '<ac:image><ri:url ri:value="/a.png" /></ac:image>',
    ]) {
      const elements = [...storageElements(read(storage))].filter((element) => resemblesStorageName(element, 'url')).length;
      expect(scanStorageForStartTag(storage, 'url')).toBe(elements > 0 ? 'yes' : 'no');
    }
  });
});

// Review r1, R1: a `no` lets a caller send a string nobody read, so it must hold for every start tag the
// reader could read and for every lexical context the scan did not account for.
describe('confluence-storage-reader: a negative scan is proof of absence (R1)', () => {
  // Neutral name: what the reader reads as an element named `record`, the scan never denies.
  it.each([
    ['a conventional prefix', '<x:record a="1" />'],
    ['a prefix of 300 characters', `<${'p'.repeat(300)}:record a="1" />`],
    ['a prefix of 70,000 characters', `<${'p'.repeat(70_000)}:record />`],
    ['a prefix holding U+1680, a name character JavaScript calls white space', '<a\u1680b:record a="1" />'],
    ['a prefix holding U+FEFF', '<a\uFEFFb:record />'],
    ['upper case before a tab', '<X:RECORD\ta="1"></X:RECORD>'],
    ['no prefix, after a quoted value holding the name', '<p title="record &gt;">t</p><record/>'],
  ])('answers yes for %s, which the reader reads', (_name, storage) => {
    expect([...storageElements(read(storage))].filter((element) => resemblesStorageName(element, 'record'))).toHaveLength(1);
    expect(scanStorageForStartTag(storage, 'record')).toBe('yes');
  });

  it.each([
    ['a name with two colons', '<a:b:record />', 'yes'],
    ['a name with a quote in it', '<a"b:record />', 'yes'],
    ['a `<` that opens no tag', '<p>1 < record > 0</p><x:other/>', 'indeterminate'],
    ['a `<` at the end', '<p>x</p><', 'indeterminate'],
    ['an attribute without a value', '<p hidden>x</p>', 'indeterminate'],
    ['an unquoted value', '<p a=b>x</p>', 'indeterminate'],
    ['a quote that opens no value', '<p a"b>x</p>', 'indeterminate'],
    ['a `<` in a start tag', '<p <x:other/>>y</p>', 'indeterminate'],
    ['a `<` in an end tag', '<p>x</p <y>', 'indeterminate'],
    ['a slash that ends no tag', '<p / a="1">x</p>', 'indeterminate'],
    ['a start tag the string ends in', '<p>x</p><x:other', 'indeterminate'],
  ])('accounts for every tag or says so: %s', (_name, storage, verdict) => {
    expect(readConfluenceStorage(storage).ok).toBe(false);
    expect(scanStorageForStartTag(storage, 'record')).toBe(verdict);
  });

  it('does not scan a string the reader refuses for its length', () => {
    const storage = `<p>${'x'.repeat(STORAGE_READER_LIMITS.length)}</p>`;
    expect(reason(storage)).toBe('too-large');
    expect(scanStorageForStartTag(storage, 'record')).toBe('indeterminate');
  });

  it('takes a number of steps that grows with the string, not with its square', () => {
    // 200,000 `<` with no name end after any of them: one step each, then the first anomaly ends the scan.
    expect(scanStorageForStartTag('<'.repeat(200_000), 'record')).toBe('indeterminate');
    expect(scanStorageForStartTag(`${'<a b="c">'.repeat(200_000)}`, 'record')).toBe('no');
  });
});

describe('confluence-storage-reader: against the independent oracle (#1955)', () => {
  const STORAGE = [
    '<p>Intro &nbsp;&mdash; <ac:link ac:anchor="x"><ri:page ri:content-title="A &amp; B" ri:space-key="ENG" />'
      + '<ac:plain-text-link-body><![CDATA[t]]></ac:plain-text-link-body></ac:link> <ac:emoticon ac:name="tick" /><br /></p>',
    '<ac:image ac:width="20"><ri:url ri:value="https://e.com/a.png?x=1&amp;y=2" /></ac:image>',
    '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">xml</ac:parameter>'
      + '<ac:plain-text-body><![CDATA[<a href="x">]]></ac:plain-text-body></ac:structured-macro>',
    '<ac:task-list><ac:task><ac:task-id>1</ac:task-id><ac:task-status>incomplete</ac:task-status>'
      + '<ac:task-body>Read <ac:link><ri:url ri:value="/docs" /></ac:link></ac:task-body></ac:task></ac:task-list>',
    '<table><tbody><tr><th>H</th></tr><tr><td><ac:link><ri:attachment ri:filename="a b.pdf" /></ac:link></td></tr></tbody></table>',
  ];

  it('lists the same elements, in the same order, for storage as Confluence writes it and as write-back writes it', () => {
    for (const storage of [...STORAGE, STORAGE.join(''), ...STORAGE.map((s) => htmlToConfluence(confluenceToHtml(s)))]) {
      const mine = [...storageElements(read(storage))].map((element) => `${element.uri}|${element.local}`);
      const theirs = [...storageOracle(storage).documentElement.getElementsByTagName('*')]
        .map((element) => `${element.namespaceURI ?? ''}|${element.localName}`);
      expect(mine).toEqual(theirs);
      expect(mine.length).toBeGreaterThan(0);
    }
  });

  it('sees the markup an HTML walk does not: raw-text and template content of the written string (V1)', () => {
    const link = '<ac:link><ri:url ri:value="/relative/a"></ri:url><ac:plain-text-link-body>x</ac:plain-text-link-body></ac:link>';
    for (const container of ['style', 'script', 'xmp', 'iframe', 'noembed', 'noframes', 'template']) {
      // With no feature in force the write-back serialises as it did before #1955.
      const storage = htmlToConfluence(`<${container}>${link}</${container}>`, { derivationFeatures: new Set() });
      expect(storage, container).toContain(`<${container}><ac:link><ri:url`);
      const urls = [...storageElements(read(storage))].filter((element) => isStorageName(element, 'ri', 'url'));
      expect(urls, container).toHaveLength(1);
      expect(oracleLocalNameCount(storage, 'url'), container).toBe(1);
    }
    for (const data of [
      `<textarea>${link}</textarea>`,
      `<p>${link.replace(/</g, '&lt;')}</p>`,
      `<!-- ${link} -->`,
      `<pre><code>${link.replace(/</g, '&lt;')}</code></pre>`,
    ]) {
      const storage = htmlToConfluence(data, { derivationFeatures: new Set() });
      expect([...storageElements(read(storage))].filter((element) => resemblesStorageName(element, 'url'))).toHaveLength(0);
      expect(oracleLocalNameCount(storage, 'url')).toBe(0);
    }
  });

  it('agrees with the oracle on what is not well-formed', () => {
    for (const storage of ['<p title="a<b">x</p>', '<p>a<br>b</p>', '<p>&bogus;</p>', '<p><!-- a -- b --></p>']) {
      expect(reason(storage)).toBe('not-well-formed');
      expect(oracleReads(storage)).toBe(false);
    }
  });
});

describe('confluence-storage-reader: the acceptance corpus (#1955)', () => {
  const expanded = (uri: string | null, local: string): string => {
    const prefix = (['ac', 'ri'] as const).find((candidate) => CONFLUENCE_STORAGE_NAMESPACES[candidate] === uri);
    return `{${prefix ?? uri ?? ''}}${local}`;
  };

  it.each(STORAGE_READER_CORPUS.map((entry) => [entry.name, entry] as const))('reads %s as the corpus states, and as an XML parser does', (_name, entry) => {
    const result = readConfluenceStorage(entry.storage);
    expect(result.ok ? 'ok' : result.reason).toBe(entry.read);
    expect(oracleReads(entry.storage)).toBe(entry.read === 'ok' && !entry.undeclaredPrefix);
    if (!result.ok) return;
    const elements = [...storageElements(result.tree)];
    expect(elements.map((element) => expanded(element.uri, element.local))).toEqual(entry.elements);
    expect(storageText(result.tree.root)).toBe(entry.text);
    if (entry.attributes) {
      expect(elements.flatMap((element) => element.attributes.map((attribute) => `${expanded(attribute.uri, attribute.local)}=${attribute.value}`)))
        .toEqual(entry.attributes);
    }
    if (entry.urls) {
      // Recognition and authority, each against its own literal.
      expect(elements.filter((element) => resemblesStorageName(element, 'url'))).toHaveLength(entry.urls.resembling);
      expect(elements.filter((element) => isStorageName(element, 'ri', 'url'))).toHaveLength(entry.urls.storage);
    }
    if (entry.undeclaredPrefix) return;
    const oracle = storageOracle(entry.storage).documentElement;
    const oracleElements = [...oracle.getElementsByTagName('*')];
    expect(oracleElements.map((element) => expanded(element.namespaceURI, element.localName))).toEqual(entry.elements);
    expect(oracle.textContent).toBe(entry.text);
    if (entry.attributes) {
      expect(oracleElements.flatMap((element) => [...element.attributes]
        .filter((attribute) => attribute.name !== 'xmlns' && attribute.prefix !== 'xmlns')
        .map((attribute) => `${expanded(attribute.namespaceURI, attribute.localName)}=${attribute.value}`)))
        .toEqual(entry.attributes);
    }
    if (entry.urls) expect(oracleLocalNameCount(entry.storage, 'url')).toBe(entry.urls.resembling);
  });

  // Review r1, R8: the oracle's entity values are its own, and they are the XHTML 1.0 ones.
  it('is held against an oracle whose entity table is pinned on its own, and agrees with it name by name', () => {
    expect(new Map(ORACLE_ENTITIES)).toEqual(new Map(STORAGE_ENTITIES));
    expect(ORACLE_ENTITIES.get('lang')).toBe('\u2329');
    expect(ORACLE_ENTITIES.get('rang')).toBe('\u232a');
    const title = storageOracle('<p title="&lang;&rang;">x</p>').documentElement.firstElementChild!.getAttribute('title');
    expect(title).toBe('\u2329\u232a');
    expect(read('<p title="&lang;&rang;">x</p>').root.children[0]).toMatchObject({ attributes: [{ name: 'title', value: '\u2329\u232a' }] });
  });

  it('holds unique names', () => {
    expect(new Set(STORAGE_READER_CORPUS.map((entry) => entry.name)).size).toBe(STORAGE_READER_CORPUS.length);
  });
});

describe('ConfluenceStorageRefusedError (#1955)', () => {
  it('carries a 422, its reason and a message that names no content', () => {
    for (const refusal of ['not-well-formed', 'too-large', 'too-deep', 'too-many-nodes', 'unapproved-link'] as const) {
      const error = new ConfluenceStorageRefusedError(refusal);
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('ConfluenceStorageRefusedError');
      expect(error.statusCode).toBe(422);
      expect(error.reason).toBe(refusal);
      expect(error.message).toMatch(/^This page cannot be saved to Confluence: .*Nothing was changed\.$/);
    }
  });
});
