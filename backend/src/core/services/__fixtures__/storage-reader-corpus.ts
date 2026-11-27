/**
 * The acceptance corpus of the storage-format reader (#1955): storage strings
 * with what `readConfluenceStorage` reads from them, as literals. It is the
 * shared contract of every consumer of the reader (#1958, #1953):
 * `confluence-storage-reader.test.ts` holds the reader to it and holds each
 * entry against an independent XML parser. Entries are appended, never edited.
 */
import type { StorageReadFailure } from '../confluence-storage-reader.js';

export interface StorageReaderCorpusEntry {
  readonly name: string;
  readonly storage: string;
  /** `ok`, or why the reader does not read the string. */
  readonly read: 'ok' | StorageReadFailure;
  /**
   * For a string that is read: every element in document order as
   * `{namespace URI}local`, `ac` / `ri` standing for the Confluence
   * namespaces of those prefixes and `{}` for no namespace.
   */
  readonly elements?: readonly string[];
  /** For a string that is read: the text an XML consumer reads from it. */
  readonly text?: string;
  /**
   * The string uses a prefix nothing declares and Confluence does not bind. A
   * strict XML parser refuses it; the reader reads it, in a namespace of its
   * own, so that such an element is still seen (and never taken for a
   * Confluence one).
   */
  readonly undeclaredPrefix?: true;
}

export const STORAGE_READER_CORPUS: readonly StorageReaderCorpusEntry[] = [
  // Storage as Confluence writes it.
  {
    name: 'page-link-entities-emoticon',
    storage: '<p>Intro &nbsp;&mdash; <ac:link ac:anchor="x"><ri:page ri:content-title="A &amp; B" ri:space-key="ENG" />'
      + '<ac:plain-text-link-body><![CDATA[t]]></ac:plain-text-link-body></ac:link> <ac:emoticon ac:name="tick" /><br /></p>',
    read: 'ok',
    elements: ['{}p', '{ac}link', '{ri}page', '{ac}plain-text-link-body', '{ac}emoticon', '{}br'],
    text: 'Intro \u00a0\u2014 t ',
  },
  {
    name: 'external-image',
    storage: '<ac:image ac:width="20"><ri:url ri:value="https://e.com/a.png?x=1&amp;y=2" /></ac:image>',
    read: 'ok',
    elements: ['{ac}image', '{ri}url'],
    text: '',
  },
  {
    name: 'code-macro-cdata-markup',
    storage: '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">xml</ac:parameter>'
      + '<ac:plain-text-body><![CDATA[<a href="x"><ac:link><ri:url ri:value="javascript:x" /></ac:link>]]></ac:plain-text-body></ac:structured-macro>',
    read: 'ok',
    elements: ['{ac}structured-macro', '{ac}parameter', '{ac}plain-text-body'],
    text: 'xml<a href="x"><ac:link><ri:url ri:value="javascript:x" /></ac:link>',
  },
  {
    name: 'task-with-url-link',
    storage: '<ac:task-list><ac:task><ac:task-id>1</ac:task-id><ac:task-status>incomplete</ac:task-status>'
      + '<ac:task-body>Read <ac:link><ri:url ri:value="/docs" /></ac:link></ac:task-body></ac:task></ac:task-list>',
    read: 'ok',
    elements: ['{ac}task-list', '{ac}task', '{ac}task-id', '{ac}task-status', '{ac}task-body', '{ac}link', '{ri}url'],
    text: '1incompleteRead ',
  },
  {
    name: 'table-with-attachment-link',
    storage: '<table><tbody><tr><th>H</th></tr><tr><td><ac:link><ri:attachment ri:filename="a b.pdf" /></ac:link></td></tr></tbody></table>',
    read: 'ok',
    elements: ['{}table', '{}tbody', '{}tr', '{}th', '{}tr', '{}td', '{ac}link', '{ri}attachment'],
    text: 'H',
  },
  // What an HTML serialiser writes and an HTML walk does not see: the content of a raw-text element or a
  // template is markup to an XML consumer.
  {
    name: 'link-in-style',
    storage: '<p>x</p><style><ac:link><ri:url ri:value="javascript:alert(1)"></ri:url></ac:link></style>',
    read: 'ok',
    elements: ['{}p', '{}style', '{ac}link', '{ri}url'],
    text: 'x',
  },
  {
    name: 'link-in-template',
    storage: '<template><p><ac:link><ri:url ri:value="/relative/t"></ri:url><ac:plain-text-link-body>t</ac:plain-text-link-body></ac:link></p></template>',
    read: 'ok',
    elements: ['{}template', '{}p', '{ac}link', '{ri}url', '{ac}plain-text-link-body'],
    text: 't',
  },
  // Data that only looks like a link.
  {
    name: 'link-as-escaped-text',
    storage: '<p>&lt;ac:link&gt;&lt;ri:url ri:value="javascript:alert(1)" /&gt;&lt;/ac:link&gt;</p>',
    read: 'ok',
    elements: ['{}p'],
    text: '<ac:link><ri:url ri:value="javascript:alert(1)" /></ac:link>',
  },
  {
    name: 'link-in-comment',
    storage: '<p>a<!-- <ac:link><ri:url ri:value="javascript:alert(1)" /></ac:link> -->b</p>',
    read: 'ok',
    elements: ['{}p'],
    text: 'ab',
  },
  // Names and namespaces: a qualified name is not an expanded name.
  {
    name: 'rebound-prefix',
    storage: '<ac:link xmlns:ri="urn:other"><ri:url ri:value="/x" /></ac:link>',
    read: 'ok',
    elements: ['{ac}link', '{urn:other}url'],
    text: '',
  },
  {
    name: 'alias-prefix',
    storage: '<x:link xmlns:x="http://atlassian.com/content" xmlns:y="http://atlassian.com/resource/identifier"><y:url y:value="/x" /></x:link>',
    read: 'ok',
    elements: ['{ac}link', '{ri}url'],
    text: '',
  },
  {
    name: 'upper-case-and-undeclared',
    storage: '<AC:LINK><RI:URL RI:VALUE="/x" /></AC:LINK><url href="/y">z</url>',
    read: 'ok',
    elements: ['{urn:x-compendiq:undeclared-prefix:AC}LINK', '{urn:x-compendiq:undeclared-prefix:RI}URL', '{}url'],
    text: 'z',
    undeclaredPrefix: true,
  },
  // Not XML: Confluence does not read these either.
  { name: 'raw-lt-in-attribute', storage: '<p title="a<b">x</p>', read: 'not-well-formed' },
  { name: 'unclosed-void-element', storage: '<p>a<br>b</p>', read: 'not-well-formed' },
  { name: 'unknown-entity', storage: '<p>&bogus;</p>', read: 'not-well-formed' },
  { name: 'double-hyphen-in-comment', storage: '<p><!-- a -- b --></p>', read: 'not-well-formed' },
  { name: 'unclosed-element', storage: '<p><ac:link><ri:url ri:value="/x" /></p>', read: 'not-well-formed' },
];
