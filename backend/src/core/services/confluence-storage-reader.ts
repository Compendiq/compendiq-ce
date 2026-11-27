/**
 * The storage-format reader (#1955, epic #2027).
 *
 * `htmlToConfluence` builds storage by serialising an HTML document, and an
 * HTML document and the XHTML string it serialises to do not hold the same
 * elements: the text of a `<style>`, `<script>` or `<xmp>` and the content of
 * a `<template>` are written raw and are markup to an XML consumer. A policy
 * about what is written to Confluence is therefore decided on the string that
 * is written, read the way its consumer reads it. This module is that reading:
 * a streaming XML parse of a storage string into a small tree. It has no DOM
 * and no logger, knows nothing about links or macros, never produces the
 * string that is written, and never throws.
 *
 * Two questions are kept apart, and a caller must not answer one with the
 * other:
 *
 * - **Authority** ({@link isStorageName}): is this node exactly the storage
 *   name `ac:link`, written with its conventional prefix and bound to the
 *   Confluence namespace (implicitly, as in every storage fragment, or by an
 *   equivalent declaration)? Only such a node can be approved or serve as
 *   evidence.
 * - **Recognition** ({@link resemblesStorageName}): could some consumer read
 *   this node as `link`: another prefix, another case, a rebound prefix? Such
 *   a node is a candidate to refuse, never one to approve.
 */
import { SaxesParser } from 'saxes';

/** The namespaces Confluence binds for a storage fragment. */
export const CONFLUENCE_STORAGE_NAMESPACES = {
  ac: 'http://atlassian.com/content',
  ri: 'http://atlassian.com/resource/identifier',
  at: 'http://atlassian.com/template',
} as const;

export type ConfluenceStoragePrefix = keyof typeof CONFLUENCE_STORAGE_NAMESPACES;

/**
 * The namespace of a prefix the fragment does not declare and Confluence does
 * not bind, followed by the prefix: such a name is read as written and is the
 * name of nothing Confluence knows.
 */
export const STORAGE_UNDECLARED_NAMESPACE = 'urn:x-compendiq:undeclared-prefix:';

/** A name as the reader found it: as written, and what it expands to. */
export interface StorageName {
  /** The qualified name as written, case kept (`ac:link`). */
  readonly name: string;
  /** The prefix as written, `''` without one. */
  readonly prefix: string;
  /** The local part as written. */
  readonly local: string;
  /** The namespace the prefix is bound to where the name stands; `''` for none. */
  readonly uri: string;
}

export interface StorageAttribute extends StorageName {
  /** The value an XML consumer reads: references decoded, white space normalised. */
  readonly value: string;
}

/** One element of a storage string as an XML consumer reads it. */
export interface StorageElement extends StorageName {
  /** The attributes in source order, namespace declarations excluded. */
  readonly attributes: readonly StorageAttribute[];
  readonly parent: StorageElement | null;
  /** Elements and text in document order. CDATA is text; adjacent runs are one string. Comments and processing instructions are not kept. */
  readonly children: ReadonlyArray<StorageElement | string>;
  /**
   * Its start tag's range `[start, end)` in the string read (`[0, 0]` for the
   * synthetic root). A forward pass uses it to read a link's tag as XML does
   * (#1955, review r4 R21).
   */
  readonly tag: readonly [start: number, end: number];
}

export interface StorageTree {
  /** A synthetic element (name `''`) holding the fragment's top-level nodes. */
  readonly root: StorageElement;
  /** The number of elements, attributes and text runs read. */
  readonly nodes: number;
}

export interface StorageReaderLimits {
  /** The longest string read, in UTF-16 code units. */
  readonly length: number;
  /** The deepest element nesting. */
  readonly depth: number;
  /** The most elements, attributes and text runs. */
  readonly nodes: number;
}

/** A page body is far below every one of these; past one the string is not read further. */
export const STORAGE_READER_LIMITS: StorageReaderLimits = { length: 8_388_608, depth: 1_024, nodes: 1_000_000 };

/**
 * The reader stopped at one of its limits (coordinator decision D20): what it read before the stop was well-formed
 * (for `too-large`, nothing was read); the rest was not read, so it is not certified well-formed.
 */
export type StorageLimitStop = 'too-large' | 'too-deep' | 'too-many-nodes';

/** Why a string was not read: `not-well-formed` is known malformed; a {@link StorageLimitStop} is unread past a limit. */
export type StorageReadFailure = 'not-well-formed' | StorageLimitStop;

/** Whether a read failure is a stop at a limit rather than known malformed input. */
export function isStorageLimitStop(reason: StorageReadFailure): reason is StorageLimitStop {
  return reason !== 'not-well-formed';
}

export type StorageReadResult = { ok: true; tree: StorageTree } | { ok: false; reason: StorageReadFailure };

/** Why a storage string is not dispatched (#1955). #1958 adds its own reason. */
export type ConfluenceStorageRefusal = StorageReadFailure | 'unapproved-link' | 'changed-link-target';

const REFUSAL_MESSAGE: Readonly<Record<ConfluenceStorageRefusal, string>> = {
  'not-well-formed':
    'This page cannot be saved to Confluence: its content holds link markup that cannot be read as a Confluence document. Nothing was changed.',
  'too-large': 'This page cannot be saved to Confluence: its content is too large to be checked. Nothing was changed.',
  'too-deep': 'This page cannot be saved to Confluence: its content is nested too deeply to be checked. Nothing was changed.',
  'too-many-nodes': 'This page cannot be saved to Confluence: its content is too complex to be checked. Nothing was changed.',
  'unapproved-link':
    'This page cannot be saved to Confluence: its content holds a link to a non-web address in a place where it cannot be verified or removed. Nothing was changed.',
  'changed-link-target':
    'This page cannot be saved to Confluence: a link to a blog post, a space, a shortcut, a content entity or a web address would be saved with a different target than Confluence holds. Edit the link in Confluence, then sync the page. Nothing was changed.',
};

/**
 * A write to Confluence refused before any effect, because of the storage it
 * would send (#1955). The message names no content. `app.ts` answers it like a
 * page-write refusal: 422 with `reason`.
 */
export class ConfluenceStorageRefusedError extends Error {
  readonly statusCode = 422;
  readonly reason: ConfluenceStorageRefusal;

  constructor(reason: ConfluenceStorageRefusal) {
    super(REFUSAL_MESSAGE[reason]);
    this.name = 'ConfluenceStorageRefusedError';
    this.reason = reason;
  }
}

/**
 * The general entities of a storage string besides XML's own five: the 248
 * names of XHTML 1.0 (Latin-1, symbols, special) with the code points that
 * DTD declares. The values are pinned here, not taken from an HTML decoder:
 * HTML5 reads `&lang;` and `&rang;` as U+27E8 / U+27E9, XHTML 1.0 declares
 * U+2329 / U+232A, so a target spelled with one of them reads differently in
 * the two dialects and is never taken for the same string. Any other name is
 * not an entity here and makes the string not well-formed.
 */
const XHTML_ENTITY_CODE_POINTS: ReadonlyArray<readonly [name: string, codePoint: number]> = [
  // Latin-1: U+00A0 to U+00FF in order.
  ...('nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro '
    + 'para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil '
    + 'Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave '
    + 'Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml '
    + 'igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute '
    + 'thorn yuml').split(' ').map((name, index) => [name, 0xA0 + index] as const),
  // Symbols.
  ['fnof', 402],
  // Greek capitals U+0391 to U+03A9; U+03A2 is unassigned.
  ...('Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu Nu Xi Omicron Pi Rho').split(' ')
    .map((name, index) => [name, 0x391 + index] as const),
  ...('Sigma Tau Upsilon Phi Chi Psi Omega').split(' ').map((name, index) => [name, 0x3A3 + index] as const),
  // Greek small letters U+03B1 to U+03C9, final sigma included.
  ...('alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigmaf sigma tau upsilon '
    + 'phi chi psi omega').split(' ').map((name, index) => [name, 0x3B1 + index] as const),
  ['thetasym', 977], ['upsih', 978], ['piv', 982],
  ['bull', 8226], ['hellip', 8230], ['prime', 8242], ['Prime', 8243], ['oline', 8254], ['frasl', 8260],
  ['weierp', 8472], ['image', 8465], ['real', 8476], ['trade', 8482], ['alefsym', 8501],
  ['larr', 8592], ['uarr', 8593], ['rarr', 8594], ['darr', 8595], ['harr', 8596], ['crarr', 8629],
  ['lArr', 8656], ['uArr', 8657], ['rArr', 8658], ['dArr', 8659], ['hArr', 8660],
  ['forall', 8704], ['part', 8706], ['exist', 8707], ['empty', 8709], ['nabla', 8711], ['isin', 8712],
  ['notin', 8713], ['ni', 8715], ['prod', 8719], ['sum', 8721], ['minus', 8722], ['lowast', 8727],
  ['radic', 8730], ['prop', 8733], ['infin', 8734], ['ang', 8736], ['and', 8743], ['or', 8744],
  ['cap', 8745], ['cup', 8746], ['int', 8747], ['there4', 8756], ['sim', 8764], ['cong', 8773],
  ['asymp', 8776], ['ne', 8800], ['equiv', 8801], ['le', 8804], ['ge', 8805], ['sub', 8834], ['sup', 8835],
  ['nsub', 8836], ['sube', 8838], ['supe', 8839], ['oplus', 8853], ['otimes', 8855], ['perp', 8869],
  ['sdot', 8901], ['lceil', 8968], ['rceil', 8969], ['lfloor', 8970], ['rfloor', 8971],
  ['lang', 0x2329], ['rang', 0x232A], ['loz', 9674], ['spades', 9824], ['clubs', 9827], ['hearts', 9829],
  ['diams', 9830],
  // Special.
  ['OElig', 338], ['oelig', 339], ['Scaron', 352], ['scaron', 353], ['Yuml', 376], ['circ', 710], ['tilde', 732],
  ['ensp', 8194], ['emsp', 8195], ['thinsp', 8201], ['zwnj', 8204], ['zwj', 8205], ['lrm', 8206], ['rlm', 8207],
  ['ndash', 8211], ['mdash', 8212], ['lsquo', 8216], ['rsquo', 8217], ['sbquo', 8218], ['ldquo', 8220],
  ['rdquo', 8221], ['bdquo', 8222], ['dagger', 8224], ['Dagger', 8225], ['permil', 8240], ['lsaquo', 8249],
  ['rsaquo', 8250], ['euro', 8364],
];

/** The entities the reader admits besides XML's five, by name. */
export const STORAGE_ENTITIES: ReadonlyMap<string, string> = new Map(
  XHTML_ENTITY_CODE_POINTS.map(([name, codePoint]) => [name, String.fromCodePoint(codePoint)]),
);

/** How much of the string the parser takes before the reader looks whether to go on. */
const READ_CHUNK = 65_536;

/** Thrown inside a parser event to stop the parser where it is; never leaves {@link readConfluenceStorage}. */
const READ_ABORTED = Symbol('storage read aborted');

interface MutableElement extends StorageName {
  attributes: StorageAttribute[];
  parent: MutableElement | null;
  children: Array<MutableElement | string>;
  tag: readonly [number, number];
}

/**
 * `storage` as an XML consumer reads it, or why it cannot be read. The string
 * is taken exactly as it is: nothing is prepended, appended or rewritten, and
 * the result is never serialised back.
 *
 * Well-formed for the reader is well-formed XML 1.0 content (balanced tags,
 * quoted and unique attributes, no raw `<` in a value, legal characters, no
 * `--` in a comment, no `]]>` in text) with namespaces: the prefixes `ac`,
 * `ri` and `at` are bound as Confluence binds them unless the fragment
 * declares otherwise, every other undeclared prefix is read as written
 * ({@link STORAGE_UNDECLARED_NAMESPACE}), and a declaration in the fragment
 * binds as XML says. The general entities are XML's five and
 * {@link STORAGE_ENTITIES}. A document type declaration or an XML declaration
 * is a failure, so the string can define no entity of its own. Reading stops
 * at the first failure and at the first limit passed.
 */
export function readConfluenceStorage(
  storage: string,
  limits: StorageReaderLimits = STORAGE_READER_LIMITS,
): StorageReadResult {
  if (storage.length > limits.length) return { ok: false, reason: 'too-large' };
  const root: MutableElement = { name: '', prefix: '', local: '', uri: '', attributes: [], parent: null, children: [], tag: [0, 0] };
  let current = root;
  let depth = 0;
  let nodes = 0;
  let failure: StorageReadFailure | null = null;
  // The first refusal ends the read: the parser gets no further input and hands over no further event.
  const fail = (reason: StorageReadFailure): never => {
    failure ??= reason;
    throw READ_ABORTED;
  };

  try {
    const parser = new SaxesParser({
      xmlns: true,
      fragment: true,
      position: false,
      resolvePrefix: (prefix: string): string => {
        // No prefix and no default declared: no namespace.
        if (prefix === '') return '';
        return Object.hasOwn(CONFLUENCE_STORAGE_NAMESPACES, prefix)
          ? CONFLUENCE_STORAGE_NAMESPACES[prefix as ConfluenceStoragePrefix]
          : STORAGE_UNDECLARED_NAMESPACE + prefix;
      },
    });
    for (const [name, value] of STORAGE_ENTITIES) parser.ENTITIES[name] = value;
    parser.on('error', () => fail('not-well-formed'));
    parser.on('doctype', () => fail('not-well-formed'));
    parser.on('xmldecl', () => fail('not-well-formed'));
    // The tag and each of its attributes are charged at their own events, before the parser reads the next
    // attribute: a refusal leaves the rest of the tag unread (review r2, R13).
    parser.on('opentagstart', () => {
      if (depth + 1 > limits.depth) fail('too-deep');
      if (++nodes > limits.nodes) fail('too-many-nodes');
    });
    // Every attribute as written, namespace declarations included.
    parser.on('attribute', () => {
      if (++nodes > limits.nodes) fail('too-many-nodes');
    });
    parser.on('opentag', (tag) => {
      depth += 1;
      const written = Object.values(tag.attributes);
      const attributes: StorageAttribute[] = [];
      for (const attribute of written) {
        // A namespace declaration binds names; it is not an attribute of the element.
        if (attribute.prefix === 'xmlns' || attribute.name === 'xmlns') continue;
        attributes.push({
          name: attribute.name, prefix: attribute.prefix, local: attribute.local, uri: attribute.uri, value: attribute.value,
        });
      }
      // The parser stands just past the tag's `>`. No `<` can stand inside a well-formed start tag, so its last
      // `<` before that point opens it.
      const end = parser.position;
      const element: MutableElement = {
        name: tag.name, prefix: tag.prefix, local: tag.local, uri: tag.uri, attributes, parent: current, children: [],
        tag: [storage.lastIndexOf('<', end - 1), end],
      };
      current.children.push(element);
      current = element;
    });
    parser.on('closetag', () => {
      depth -= 1;
      current = current.parent ?? root;
    });
    const text = (data: string): void => {
      if (data === '') return;
      const last = current.children.length - 1;
      const previous = current.children[last];
      if (typeof previous === 'string') {
        current.children[last] = previous + data;
        return;
      }
      if (++nodes > limits.nodes) fail('too-many-nodes');
      current.children.push(data);
    };
    parser.on('text', text);
    parser.on('cdata', text);

    for (let at = 0; at < storage.length; at += READ_CHUNK) parser.write(storage.slice(at, at + READ_CHUNK));
    parser.close();
  } catch (error) {
    if (error !== READ_ABORTED) failure ??= 'not-well-formed';
  }
  return failure ? { ok: false, reason: failure } : { ok: true, tree: { root, nodes } };
}

/**
 * Authority: `node` is exactly the storage name `prefix:local`, written with
 * its conventional prefix and bound to the Confluence namespace of that
 * prefix. An alias (`x:link` bound to the same namespace) and a rebound prefix
 * (`ac:link` under `xmlns:ac="urn:other"`) are both refused: one reading or
 * the other would not take them for the name.
 */
export function isStorageName(node: StorageName, prefix: ConfluenceStoragePrefix, local: string): boolean {
  return node.prefix === prefix && node.local === local && node.uri === CONFLUENCE_STORAGE_NAMESPACES[prefix];
}

/**
 * Recognition only: some consumer could read `node` as `local` (lower case),
 * whatever its prefix, case or binding. Use it to find what must be refused or
 * approved elsewhere, never to approve.
 */
export function resemblesStorageName(node: StorageName, local: string): boolean {
  return node.local.toLowerCase() === local;
}

/** The elements of `tree` in document order (the synthetic root excluded). */
export function* storageElements(tree: StorageTree): Generator<StorageElement> {
  const pending: StorageElement[] = [tree.root];
  while (pending.length > 0) {
    const element = pending.pop()!;
    if (element !== tree.root) yield element;
    for (let index = element.children.length - 1; index >= 0; index -= 1) {
      const child = element.children[index]!;
      if (typeof child !== 'string') pending.push(child);
    }
  }
}

/** The text of `element` and its descendants, in document order. */
export function storageText(element: StorageElement): string {
  let text = '';
  const pending: Array<StorageElement | string> = [element];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (typeof node === 'string') {
      text += node;
      continue;
    }
    for (let index = node.children.length - 1; index >= 0; index -= 1) pending.push(node.children[index]!);
  }
  return text;
}

/** What ends a tag name in any reading of a string: XML white space, form feed, `/`, `>`, or the next `<`. */
const TAG_NAME_END = /[ \t\r\n\f/><]/g;
const NOT_XML_SPACE = /[^ \t\r\n]/g;
const ATTRIBUTE_NAME_END = /[ \t\r\n=<>/"']/g;

/**
 * Whether `storage` holds a start tag whose name ends in `local` (lower case)
 * after its last colon, for a string the reader could not read. Lexical only,
 * and bounded: one pass, no step repeated, and a string past the reader's
 * length limit is not scanned at all.
 *
 * `no` is proof of absence: the whole string was accounted for as comments,
 * CDATA sections, processing instructions, end tags and start tags with
 * quoted attribute values, and no start tag has that name, whatever its
 * length and whatever characters its prefix holds. `yes` is a start tag of
 * that name. `indeterminate` is everything else: something opened is never
 * closed, a `<` opens no tag, a tag is not written as XML writes one, or the
 * string is too long to scan. Then what is markup cannot be told and nothing
 * may be concluded. This never approves anything: a caller may only use `no`
 * to leave a string it cannot read as it was, and must refuse on the other
 * two.
 */
export function scanStorageForStartTag(storage: string, local: string): 'no' | 'yes' | 'indeterminate' {
  if (storage.length > STORAGE_READER_LIMITS.length) return 'indeterminate';
  /** The index of the first character at or after `from` that `pattern` matches, or the end of the string. */
  const find = (pattern: RegExp, from: number): number => {
    pattern.lastIndex = from;
    return pattern.exec(storage)?.index ?? storage.length;
  };
  let at = 0;
  for (;;) {
    const open = storage.indexOf('<', at);
    if (open < 0) return 'no';
    const closes = (opener: string, closer: string): number | null => {
      if (!storage.startsWith(opener, open)) return null;
      const end = storage.indexOf(closer, open + opener.length);
      return end < 0 ? -1 : end + closer.length;
    };
    const skipped = closes('<!--', '-->') ?? closes('<![CDATA[', ']]>') ?? closes('<?', '?>');
    if (skipped !== null) {
      if (skipped < 0) return 'indeterminate';
      at = skipped;
      continue;
    }
    // A declaration (`<!DOCTYPE`, `<!ENTITY`): what follows it depends on a reading this scan does not make.
    if (storage.startsWith('<!', open)) return 'indeterminate';
    if (storage.startsWith('</', open)) {
      const end = storage.indexOf('>', open + 2);
      const next = storage.indexOf('<', open + 2);
      if (end < 0 || (next >= 0 && next < end)) return 'indeterminate';
      at = end + 1;
      continue;
    }
    const nameEnd = find(TAG_NAME_END, open + 1);
    // No name (`a < b`), or a name the string or another `<` cuts short: not a tag XML writes.
    if (nameEnd === open + 1 || nameEnd === storage.length || storage[nameEnd] === '<') return 'indeterminate';
    // The name's last `local.length` characters, when they are the whole name or follow a colon. (No
    // character but an ASCII letter lower-cases to one of `a`-`z` other than U+212A to `k`, so a local
    // name that lower-cases to `local` has its length.)
    const localStart = nameEnd - local.length;
    if (
      (localStart === open + 1 || (localStart > open + 1 && storage[localStart - 1] === ':'))
      && storage.slice(localStart, nameEnd).toLowerCase() === local
    ) return 'yes';
    // The rest of the tag, as XML writes it: `name="value"` or `name='value'`, then `>` or `/>`.
    at = nameEnd;
    for (;;) {
      at = find(NOT_XML_SPACE, at);
      if (storage[at] === '>') break;
      if (storage[at] === '/') {
        if (storage[at + 1] !== '>') return 'indeterminate';
        at += 1;
        break;
      }
      const attributeEnd = find(ATTRIBUTE_NAME_END, at);
      if (attributeEnd === at) return 'indeterminate';
      const equals = find(NOT_XML_SPACE, attributeEnd);
      if (storage[equals] !== '=') return 'indeterminate';
      const quote = find(NOT_XML_SPACE, equals + 1);
      if (storage[quote] !== '"' && storage[quote] !== "'") return 'indeterminate';
      const valueEnd = storage.indexOf(storage[quote]!, quote + 1);
      if (valueEnd < 0) return 'indeterminate';
      at = valueEnd + 1;
    }
    at += 1;
  }
}
