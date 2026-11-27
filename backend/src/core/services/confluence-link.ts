/**
 * Confluence links in body_html (#1748, #1955).
 *
 * `confluenceToHtml` turns an `<ac:link>` into an `<a>` whose href carries the
 * whole link, and `htmlToConfluence` rebuilds the `<ac:link>` from that href
 * alone. The href grammar (prefixes, parameters, caps, encoding, the legacy
 * reading, which `ri:url` values are navigable) is pure and lives in
 * `@compendiq/contracts` (`confluence-link-grammar.ts`), which the editor
 * schemas share; it is re-exported here. This module is the only one that
 * reads or builds link elements: the converter, `link-extractor.ts` and the
 * baseline manifest go through it.
 *
 * A `ri:url` link is the one kind whose `<a>` does not always carry the link
 * in its href (#1955): a navigable value is the real href and the carrier is
 * the `class` ({@link confluenceLinkCarrierOf}). Any other value stays an
 * inert `#confluence-url:` fragment, and such a link is written back to
 * Confluence only where the stored page already holds that very occurrence
 * (`confluence-url-origin.ts`).
 */
import {
  buildConfluenceLinkHref,
  CONFLUENCE_LINK_KINDS,
  CONFLUENCE_LINK_KINDS_1748,
  CONFLUENCE_LINK_LIMITS,
  CONFLUENCE_LINK_PRIMARY_ATTR,
  CONFLUENCE_LINK_RESOURCE_ELEMENT,
  confluenceLinkDisplayText,
  isConfluenceLinkContainerName,
  isConfluenceLinkLocalName,
  isConfluenceLinkValue,
  isConfluenceUrlClassCarrierFor,
  isNavigableConfluenceUrl,
  parseConfluenceLinkHref,
  type ConfluenceLinkAttr,
  type ConfluenceLinkKind,
  type ConfluenceLinkTarget,
} from '@compendiq/contracts';
import { randomBytes } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { logger } from '../utils/logger.js';
import {
  ConfluenceStorageRefusedError,
  readConfluenceStorage,
  resemblesStorageName,
  scanStorageForStartTag,
  storageElements,
  storageText,
  type ConfluenceStorageRefusal,
  type StorageElement,
  type StorageReadFailure,
} from './confluence-storage-reader.js';
import {
  analyseStorageLinks,
  isApprovedUrlLinkVerdict,
  judgeStorageUrlLinks,
  storageLinkShown,
  StorageLinkBudgetError,
  type StorageLinkAnalysis,
  type StorageUrlLinkVerdict,
} from './confluence-url-origin.js';
import { derivationHas, type StorageDerivationFeatures } from './storage-derivation.js';

export {
  analyseStorageLinks,
  isApprovedUrlLinkVerdict,
  judgeStorageUrlLinks,
  STORAGE_LINK_LIMITS,
  storageLinkShown,
  StorageLinkBudgetError,
  type StorageLinkAnalysis,
  type StorageLinkClaim,
  type StorageLinkLimits,
  type StorageUrlLink,
  type StorageUrlLinkVerdict,
} from './confluence-url-origin.js';

export {
  buildConfluenceLinkHref,
  CONFLUENCE_ATTACHMENT_HREF_PREFIX,
  CONFLUENCE_EMPTY_LINK_LABEL,
  CONFLUENCE_LINK_HREF_PREFIX,
  CONFLUENCE_LINK_KINDS,
  CONFLUENCE_LINK_KINDS_1748,
  CONFLUENCE_LINK_LIMITS,
  CONFLUENCE_LINK_PRIMARY_ATTR,
  CONFLUENCE_PAGE_HREF_PREFIX,
  confluenceLinkDisplayText,
  encodeConfluenceLinkValue,
  isConfluenceLinkValue,
  isConfluenceUrlClassCarrierFor,
  isNavigableConfluenceUrl,
  parseConfluenceLinkHref,
  type ConfluenceLinkKind,
  type ConfluenceLinkTarget,
} from '@compendiq/contracts';

/** The kind each resource element is the target of. */
const RESOURCE_KIND: ReadonlyMap<string, ConfluenceLinkKind> = new Map(
  Object.entries(CONFLUENCE_LINK_RESOURCE_ELEMENT).map(([kind, element]) => [element, kind as ConfluenceLinkKind]),
);

/**
 * The kinds a conversion reads and writes (#1953): all eight with the
 * `link-kinds` storage-derivation feature, the three of #1748 without it, so
 * a restore reserved before #1955 derives the storage it derived then.
 */
function linkKinds(features: StorageDerivationFeatures | undefined): readonly ConfluenceLinkKind[] {
  return derivationHas(features, 'link-kinds') ? CONFLUENCE_LINK_KINDS : CONFLUENCE_LINK_KINDS_1748;
}

/**
 * `el`'s attributes in `prefix`'s namespace, in source order, except
 * `primary`: the ones a link carries, at most 16. An attribute in the
 * namespace that it cannot carry (a local name over 64 characters, a value
 * over 1,024 or holding a character XML forbids, one past the cap) goes to
 * `dropped` as `label` + its name. Attributes of other namespaces
 * (`xmlns:*`, unprefixed) are never carried.
 */
function carriedAttrs(el: Element, prefix: 'ac:' | 'ri:', primary: string | undefined, label: string, dropped: string[]): ConfluenceLinkAttr[] {
  const carried: ConfluenceLinkAttr[] = [];
  for (const { name, value } of el.attributes) {
    if (name === primary || !name.startsWith(prefix)) continue;
    if (carried.length < CONFLUENCE_LINK_LIMITS.attrs && isConfluenceLinkLocalName(name.slice(prefix.length)) && isConfluenceLinkValue(value)) {
      carried.push([name, value]);
    } else {
      dropped.push(label + name);
    }
  }
  return carried;
}

const BODY_ELEMENTS = ['ac:link-body', 'ac:plain-text-link-body'];

/** What an `<ac:link>` is as an `<a>`: its carrier, and the `<a>`'s attributes and content. */
interface BuiltLink {
  kind: ConfluenceLinkKind;
  value: string;
  /** The href that carries the whole link. */
  carrier: string;
  /** The body element, when the link has one that is not blank. */
  bodyEl: Element | null;
  /** Whether the link has a body element at all (blank or not). */
  hasBodyEl: boolean;
  /** The text an `<a>` without markup shows: the plain body, or the display text. */
  text: string;
  /** The names of the attributes the carrier does not hold. */
  dropped: string[];
}

/**
 * Read an `<ac:link>` (#1748, #1955), or null when it is none the href can
 * carry. The resource is the link's first direct `ri:*` child, so the
 * `ri:page` inside a link's `ri:attachment` is that attachment's container,
 * never the link's target. The body is the link's own child, or the
 * resource's when the resource's self-closing tag was not expanded (a `/` or
 * `>` in a value, or a resource element expandSelfClosingXhtmlTags does not
 * list) and it swallowed the body. A body with no element and only white
 * space is no body. Pure: nothing is logged and nothing is changed.
 */
function buildLink(acLink: Element, kinds: readonly ConfluenceLinkKind[]): BuiltLink | null {
  const resource = [...acLink.children].find((child) => child.tagName.toLowerCase().startsWith('ri:'));
  const kind = resource ? RESOURCE_KIND.get(resource.tagName.toLowerCase()) : 'anchor';
  if (!kind || !kinds.includes(kind)) return null;
  const value = (resource ?? acLink).getAttribute(CONFLUENCE_LINK_PRIMARY_ATTR[kind]);
  if (value === null || !isConfluenceLinkValue(value)) return null;

  const dropped: string[] = [];
  const link = carriedAttrs(acLink, 'ac:', kind === 'anchor' ? 'ac:anchor' : undefined, '', dropped);
  const resourceAttrs = resource ? carriedAttrs(resource, 'ri:', CONFLUENCE_LINK_PRIMARY_ATTR[kind], '', dropped) : [];
  let container: ConfluenceLinkTarget['container'] = null;
  const owner = kind === 'attachment'
    ? [...resource!.children].find((child) => child.tagName.toLowerCase().startsWith('ri:'))
    : undefined;
  if (owner) {
    const name = owner.tagName.toLowerCase().slice(3);
    if (isConfluenceLinkContainerName(name)) container = { name, attrs: carriedAttrs(owner, 'ri:', undefined, `${name}.`, dropped) };
    else dropped.push(owner.tagName.toLowerCase());
  }

  const found = [acLink, resource].flatMap((el) => (el ? [...el.children] : []))
    .find((child) => BODY_ELEMENTS.includes(child.tagName.toLowerCase()));
  const bodyEl = !found || (found.children.length === 0 && (found.textContent ?? '').trim() === '') ? null : found;
  const rich = bodyEl?.tagName.toLowerCase() === 'ac:link-body';
  const display = confluenceLinkDisplayText({ kind, value });
  const text = bodyEl && !rich ? bodyEl.textContent ?? '' : display;
  // The body's element: a #1748 kind says it only when the text cannot tell
  // (a rich body without markup, a plain body equal to the value); a #1955
  // kind says it for every explicit body, so no later projection of the text
  // (an editor collapsing white space onto the display text) loses it.
  let body: ConfluenceLinkTarget['body'] = null;
  if (bodyEl && !CONFLUENCE_LINK_KINDS_1748.includes(kind)) body = rich ? 'rich' : 'plain';
  else if (bodyEl && rich) body = bodyEl.children.length === 0 ? 'rich' : null;
  else if (bodyEl) body = text === value ? 'plain' : null;

  const carrier = buildConfluenceLinkHref({ kind, value, link, resource: resourceAttrs, container, body }, dropped);
  return { kind, value, carrier, bodyEl, hasBodyEl: Boolean(found), text, dropped };
}

/**
 * The `href` and `class` an element that carries the link `carrier` holds
 * (#1955), or null when `carrier` is no link href. A `ri:url` with a
 * navigable value is a real link: the URL is the href and the carrier is the
 * class. Every other link is its carrier, with no class.
 */
export function confluenceLinkHrefAttributes(carrier: string): { href: string; className: string | null } | null {
  const link = parseConfluenceLinkHref(carrier);
  if (!link) return null;
  return link.kind === 'url' && !link.legacy && isNavigableConfluenceUrl(link.value)
    ? { href: link.value, className: carrier }
    : { href: carrier, className: null };
}

/**
 * The link href an element carries (#1955), or null when it carries none:
 * its `href` when that is a link href, else its `class` when the class is the
 * carrier of the element's own navigable URL
 * ({@link isConfluenceUrlClassCarrierFor}). Reads `href` and `class` only.
 */
export function confluenceLinkCarrierOf(el: Element): string | null {
  const href = el.getAttribute('href') ?? '';
  if (parseConfluenceLinkHref(href)) return href;
  const className = el.getAttribute('class');
  return className !== null && isConfluenceUrlClassCarrierFor(href, className) ? className : null;
}

/** What a stored `<ac:link>` is in body_html (#1955): for #1953's recovery of a link written before its carrier. */
export interface ConfluenceLinkCarrier {
  kind: ConfluenceLinkKind;
  /** The href that carries the whole link. */
  carrier: string;
  /** The `<a>`'s href: the carrier, or the URL of a navigable `ri:url`. */
  href: string;
  /** The `<a>`'s class: the carrier of a navigable `ri:url`, else null. */
  className: string | null;
  /** The kind's primary value. */
  value: string;
  /** The plain body; with a rich body or none, what the link shows without a body. */
  text: string;
  /** The names of the attributes the carrier does not hold. */
  dropped: readonly string[];
}

/**
 * The carrier of a stored `<ac:link>`, or null when it has none (#1955). Pure:
 * the same reading {@link confluenceLinkAnchor} makes, with nothing logged and
 * nothing changed. `acLink` is an element of the document the forward pass
 * reads (CDATA as text, self-closing tags expanded), not of a bare HTML parse
 * of the storage, where a CDATA body is a comment.
 */
export function confluenceLinkCarrier(acLink: Element): ConfluenceLinkCarrier | null {
  const built = buildLink(acLink, CONFLUENCE_LINK_KINDS);
  if (!built) return null;
  const { href, className } = confluenceLinkHrefAttributes(built.carrier)!;
  return { kind: built.kind, carrier: built.carrier, href, className, value: built.value, text: built.text, dropped: built.dropped };
}

/**
 * What replaces an `<ac:link>` the href can carry — its `<a>`, then whatever
 * a self-closing link swallowed — else null (#1748, #1955). The text is the
 * link body — rich content as markup, plain text as text — or, with no body,
 * what Confluence shows instead: the title, the filename, the anchor, or for
 * a #1955 kind the display text of its value. Anything else inside the link
 * (white space, a stray element) is dropped with the `ac:link`, as before
 * #1748 — except in an anchor link without a body, whose content can only be
 * what its unexpanded self-closing tag swallowed: that moves back out behind
 * the `<a>`. An attribute the href cannot carry, and an attachment's
 * container whose name is over 32 characters, is logged, never dropped
 * silently. `features` are the storage-derivation features of the conversion
 * (#1953): without `link-kinds` only a page, an attachment and an anchor are
 * read.
 */
export function confluenceLinkAnchor(acLink: Element, features?: StorageDerivationFeatures): Node[] | null {
  const built = buildLink(acLink, linkKinds(features));
  if (!built) return null;
  const a = acLink.ownerDocument.createElement('a');
  if (built.bodyEl?.tagName.toLowerCase() === 'ac:link-body') {
    // Server-side JSDOM only (see the SECURITY note in content-converter.ts).
    // nosemgrep: javascript.browser.security.insecure-document-method.insecure-document-method
    a.innerHTML = built.bodyEl.innerHTML;
  } else {
    a.textContent = built.text;
  }
  const { href, className } = confluenceLinkHrefAttributes(built.carrier)!;
  a.setAttribute('href', href);
  if (className !== null) a.setAttribute('class', className);
  a.setAttribute('data-confluence-link', built.kind);
  if (built.dropped.length > 0) {
    logger.warn(
      { attributes: built.dropped.slice(0, 10).map((name) => name.slice(0, 80)), count: built.dropped.length },
      'Confluence link attributes not carried (#1748)',
    );
  }
  return built.kind === 'anchor' && !built.hasBodyEl ? [a, ...acLink.childNodes] : [a];
}

/**
 * The `<ac:link>` an `<a>` that carries a Confluence link stands for, else
 * null (#1748, #1955). The body follows the `<a>`'s content: markup is an
 * `ac:link-body` (its nodes move, so a placeholder inside is still converted
 * where it now sits), text is an `ac:plain-text-link-body` — or no body at all
 * when the text is what the link shows without one — unless the carrier's
 * `body` says which. `features` as in {@link confluenceLinkAnchor}: without
 * `link-kinds` only the href is read, for the three #1748 kinds.
 */
export function confluenceLinkElement(a: Element, features?: StorageDerivationFeatures): Element | null {
  const carrier = derivationHas(features, 'link-kinds') ? confluenceLinkCarrierOf(a) : a.getAttribute('href');
  const link = parseConfluenceLinkHref(carrier ?? '', { kinds: linkKinds(features) });
  if (!link) return null;
  const doc = a.ownerDocument;
  const acLink = doc.createElement('ac:link');
  if (link.kind === 'anchor') acLink.setAttribute('ac:anchor', link.value);
  for (const [name, value] of link.link) acLink.setAttribute(name, value);
  if (link.kind !== 'anchor') {
    const resource = doc.createElement(CONFLUENCE_LINK_RESOURCE_ELEMENT[link.kind]);
    resource.setAttribute(CONFLUENCE_LINK_PRIMARY_ATTR[link.kind], link.value);
    for (const [name, value] of link.resource) resource.setAttribute(name, value);
    if (link.container) {
      const owner = doc.createElement(`ri:${link.container.name}`);
      for (const [name, value] of link.container.attrs) owner.setAttribute(name, value);
      resource.appendChild(owner);
    }
    acLink.appendChild(resource);
  }
  if (a.children.length > 0) {
    const body = doc.createElement('ac:link-body');
    while (a.firstChild) body.appendChild(a.firstChild);
    acLink.appendChild(body);
  } else {
    const text = a.textContent ?? '';
    const kind = link.body ?? (text === '' || text === confluenceLinkDisplayText(link) ? null : 'plain');
    if (kind) {
      const body = doc.createElement(kind === 'rich' ? 'ac:link-body' : 'ac:plain-text-link-body');
      body.textContent = text;
      acLink.appendChild(body);
    }
  }
  return acLink;
}

/** The resource elements of the five #1955 kinds: none of them names an attachment. */
const NON_FILE_RESOURCES: ReadonlySet<string> = new Set(
  CONFLUENCE_LINK_KINDS.filter((kind) => !CONFLUENCE_LINK_KINDS_1748.includes(kind))
    .map((kind) => CONFLUENCE_LINK_RESOURCE_ELEMENT[kind as Exclude<ConfluenceLinkKind, 'anchor'>]),
);

/**
 * Whether `el`, an element of stored storage, is the target of a link to a
 * blog post, a space, a shortcut, a content entity or a URL (#1955): one of
 * those five resource elements, directly inside an `ac:link`, as the link's
 * resource (its first `ri:*` child, as {@link confluenceLinkAnchor} reads it).
 * Such a target names no attachment, whatever attribute it carries. The same
 * element anywhere else (under an `ac:image`, in a macro parameter) is not a
 * link's target and this is false.
 */
export function isConfluenceLinkTargetWithoutFile(el: Element): boolean {
  const parent = el.parentElement;
  if (!NON_FILE_RESOURCES.has(el.tagName.toLowerCase()) || parent?.tagName.toLowerCase() !== 'ac:link') return false;
  return [...parent.children].find((child) => child.tagName.toLowerCase().startsWith('ri:')) === el;
}

/** A start tag may hold a link of one of the five kinds: only then is the string read. */
const NON_FILE_RESOURCE_TAG = /<ri:(?:space|blog-post|shortcut|content-entity|url)\b/i;

/**
 * What an HTML parser reads otherwise than XML in an attribute value: the
 * two entity names whose XHTML 1.0 value is not their HTML5 one, a numeric
 * reference HTML maps (C1: windows-1252), and literal TAB, LF, CR and CR LF,
 * which XML reads as one space.
 */
const HTML_READS_OTHERWISE = /&(?:lang|rang);|&#(?:[0-9]+|x[0-9a-fA-F]+);|\r\n|[\t\n\r]/g;

function asXmlReadsIt(spelling: string): string {
  if (spelling === '&lang;') return '&#9001;';
  if (spelling === '&rang;') return '&#9002;';
  if (!spelling.startsWith('&#')) return ' ';
  const code = spelling[2] === 'x' ? Number.parseInt(spelling.slice(3, -1), 16) : Number(spelling.slice(2, -1));
  return code >= 0x80 && code <= 0x9f ? String.fromCharCode(code) : spelling;
}

/** What {@link keepXmlLinkValues} returns. */
export interface XmlLinkValues {
  /** The string with the tags spelled (and marked). */
  readonly storage: string;
  /**
   * The links of the five kinds the reader holds, in document order: a
   * mark's value is an index here. Why the string could not be read when it
   * could not (then nothing is spelled).
   */
  readonly links: readonly StorageElement[] | StorageReadFailure;
}

/**
 * `storage` (CDATA already turned into text) with the start tag of every link
 * to a blog post, a space, a shortcut, a content entity or a URL, and of its
 * resource (its first `ri:*` child), spelled so that an HTML parser reads
 * each attribute value as XML reads it (#1955, reviews r2 R12, r4 R21):
 * `&lang;`/`&rang;` as the references of U+2329/U+232A, a C1 numeric
 * reference as its character, and a literal TAB, LF or CR as a space. XML
 * reads the result as it read `storage`. The tags are those the storage
 * reader finds, by their ranges in the string, so a comment, a processing
 * instruction or raw text is never taken for one. Nothing else is touched:
 * text, bodies, other elements, and the three #1748 kinds, which the base
 * commit read with the HTML values. A string the reader cannot read (not
 * XML, or past a limit) is returned as it came. With `marker`, each such
 * link's start tag also gets the attribute `marker` holding its index in
 * `links`, right after its name (owner decision D19, coordinator decision
 * D20: the forward pass a write-back runs over the stored storage tells, where
 * it emits a carrier, which stored link that carrier is read from).
 */
export function keepXmlLinkValues(storage: string, marker?: string): XmlLinkValues {
  if (!NON_FILE_RESOURCE_TAG.test(storage)) return { storage, links: [] };
  const read = readConfluenceStorage(storage);
  if (!read.ok) return { storage, links: read.reason };
  const links: StorageElement[] = [];
  const tags: Array<{ range: readonly [number, number]; mark: string; at: number }> = [];
  for (const element of storageElements(read.tree)) {
    if (element.name.toLowerCase() !== 'ac:link') continue;
    const resource = element.children
      .find((child): child is StorageElement => typeof child !== 'string' && child.name.toLowerCase().startsWith('ri:'));
    if (!resource || !NON_FILE_RESOURCES.has(resource.name.toLowerCase())) continue;
    tags.push({ range: element.tag, mark: marker ? ` ${marker}="${links.length}"` : '', at: 1 + element.name.length });
    tags.push({ range: resource.tag, mark: '', at: 0 });
    links.push(element);
  }
  tags.sort((a, b) => a.range[0] - b.range[0]);
  let out = '';
  let at = 0;
  for (const { range: [start, end], mark, at: name } of tags) {
    const tag = storage.slice(start, end);
    out += storage.slice(at, start) + (tag.slice(0, name) + mark + tag.slice(name)).replace(HTML_READS_OTHERWISE, asXmlReadsIt);
    at = end;
  }
  return { storage: out + storage.slice(at), links };
}

/** A target as a comparable record: the resource and every attribute of the link and of the resource, sorted. */
function targetRecord(resource: string, link: ReadonlyArray<readonly [string, string]>, own: ReadonlyArray<readonly [string, string]>): string {
  const sorted = (list: ReadonlyArray<readonly [string, string]>): Array<readonly [string, string]> =>
    [...list].sort(([a], [b]) => Number(a > b) - Number(a < b));
  return JSON.stringify([resource, sorted(link), sorted(own)]);
}

/**
 * Owner decision D19 (review r5, R24): whether a link that carries `built`
 * (the forward pass's reading of the stored link `stored`) is written back
 * with the XML target `stored` holds: its resource, its primary value, its
 * section and every other carried attribute. The attributes the carrier
 * cannot hold by the grammar (`built.dropped`, logged by #1748) and those of
 * no `ac:`/`ri:` name are not part of the comparison.
 */
export function storedLinkKeepsTarget(stored: StorageElement, built: ConfluenceLinkCarrier): boolean {
  const target = parseConfluenceLinkHref(built.carrier);
  if (!target || target.kind === 'anchor') return false;
  const resource = stored.children
    .find((child): child is StorageElement => typeof child !== 'string' && child.name.toLowerCase().startsWith('ri:'));
  if (!resource) return false;
  const dropped = new Set(built.dropped);
  const own = (element: StorageElement, prefix: string): Array<readonly [string, string]> => element.attributes
    .filter(({ name }) => name.toLowerCase().startsWith(prefix) && !dropped.has(name.toLowerCase()))
    .map(({ name, value }) => [name, value] as const);
  const written = targetRecord(
    CONFLUENCE_LINK_RESOURCE_ELEMENT[target.kind],
    target.link,
    [[CONFLUENCE_LINK_PRIMARY_ATTR[target.kind], target.value], ...target.resource],
  );
  return written === targetRecord(resource.name.toLowerCase(), own(stored, 'ac:'), own(resource, 'ri:'));
}

/**
 * Refuse a storage before dispatch (#1955): logged here, once, with its reason only, and with `detail` when a
 * D19 refusal is for a carrier a faithful stored link also has (`ambiguous`); `app.ts` answers 422.
 */
export function refuseConfluenceStorage(reason: ConfluenceStorageRefusal, detail?: 'ambiguous'): never {
  logger.warn(detail ? { reason, detail } : { reason }, 'Confluence storage refused before dispatch (#1955)');
  throw new ConfluenceStorageRefusedError(reason);
}

/** The string every `ri:url` carrier starts with. */
const URL_CARRIER_PREFIX = '#confluence-url:';

/**
 * `html` with every `<a>` whose href is the carrier of a navigable `ri:url`
 * turned into the real link (#1955): the URL as href, the carrier as class.
 * Markdown keeps only a link's destination, so the Improve chain writes the
 * carrier there and this restores the pair after `marked`. Only parsed `<a>`
 * elements are touched and the attributes are set through the DOM, so a value
 * holding a quote, `&` or markup is serialised in context; carrier text in
 * prose, code or another attribute stays what it is. An `<a>` that already
 * has a class, and a carrier whose value is not navigable, are left alone.
 * The string is returned as it came unless an anchor changed.
 */
export function materializeConfluenceUrlLinks(html: string): string {
  if (!html.includes(URL_CARRIER_PREFIX)) return html;
  const doc = new JSDOM(`<body>${html}</body>`, { contentType: 'text/html' }).window.document;
  let changed = false;
  for (const a of doc.querySelectorAll(`a[href^="${URL_CARRIER_PREFIX}"]:not([class])`)) {
    const attributes = confluenceLinkHrefAttributes(a.getAttribute('href')!);
    if (!attributes || attributes.className === null) continue;
    a.setAttribute('href', attributes.href);
    a.setAttribute('class', attributes.className);
    changed = true;
  }
  return changed ? doc.body.innerHTML : html;
}

/**
 * What any XML reading needs to find an element whose local name is `url`:
 * `<`, the rest of a name (no `<`, no `>`, no `/`, no XML white space: a
 * prefix may hold any other character and be of any length), `url` in any
 * case, then the end of the name. A string without this holds no such
 * element whatever reads it, so it needs no reading. A match proves nothing:
 * prose, a comment and a code sample match too.
 */
const URL_START_TAG = /<[^<> \t\r\n/]*url[ \t\r\n\f/>]/i;

/** The link-like elements under `root`, template contents included, in document order. */
function linkLikeElements(root: ParentNode): Element[] {
  const found: Element[] = [];
  const pending: ParentNode[] = [root];
  while (pending.length > 0) {
    const parent = pending.pop()!;
    const children = [...parent.children];
    for (let index = children.length - 1; index >= 0; index -= 1) pending.push(children[index]!);
    if (!('tagName' in parent)) continue;
    const element = parent as Element;
    const name = element.tagName.toLowerCase();
    if (name.slice(name.indexOf(':') + 1) === 'link') found.push(element);
    // A template's content is a fragment of its own, and it is serialised.
    if (name === 'template') pending.push((element as HTMLTemplateElement).content);
  }
  return found;
}

/**
 * Take the link away from what it shows (#1955, `storageLinkShown`):
 * `element` is replaced by its display text, or by the content of its bodies.
 * `bodies` are the bodies an XML reader finds in the link: a rich body leaves
 * its nodes, a plain body the text that reader reads from it, which is not
 * the document's text of the element when the body holds markup (the
 * serialisation writes a plain body as CDATA). False when the document does
 * not hold those bodies in that order: then nothing is changed.
 */
function unwrapUrlLink(element: Element, shown: { label: string } | { bodies: StorageElement[] }): boolean {
  const doc = element.ownerDocument;
  if ('label' in shown) {
    element.replaceWith(doc.createTextNode(shown.label));
    return true;
  }
  const { bodies } = shown;
  const own = element.tagName.toLowerCase() === 'ac:link'
    ? [...element.children].filter((child) => BODY_ELEMENTS.includes(child.tagName.toLowerCase()))
    : [];
  if (own.length !== bodies.length || own.some((child, index) => child.tagName.toLowerCase() !== bodies[index]!.name)) return false;
  const replacement: Node[] = [];
  own.forEach((child, index) => {
    if (bodies[index]!.local === 'link-body') replacement.push(...child.childNodes);
    else replacement.push(doc.createTextNode(storageText(bodies[index]!)));
  });
  element.replaceWith(...replacement);
  return true;
}

/**
 * The storage `serialise()` writes for `body`, with every `ri:url` link in it
 * judged on that very string (#1955, decision D2): what this returns is what
 * may be sent to Confluence.
 *
 * The string is read with the storage reader, not walked as HTML, because the
 * two do not hold the same elements: raw text and template content of the
 * document are markup in the string. Every link holding a `ri:url` must be a
 * navigable one or stand for one occurrence of `evidence`, the page's stored
 * storage (`confluence-url-origin.ts`). A link that does neither is unwrapped
 * in the document — what it shows stays, without the link — and the string is
 * serialised and read again; the second reading is the one trusted, and the
 * first string is never returned after a repair.
 *
 * Throws {@link ConfluenceStorageRefusedError}:
 * - when the string may hold a `url` element and cannot be read (not
 *   well-formed for the reader, or past a limit). A string the reader cannot
 *   read is left as it was only when the lexical scan accounts for all of it
 *   and finds no start tag named `url`;
 * - when the links cannot be judged within the work limit, in the string or
 *   in `evidence`: a link is never dropped because judging it was costly;
 * - when a link that may not be written cannot be taken away without loss:
 *   it is not an element of the document, it may show something outside its
 *   bodies, the text shown differs after the repair, or it is still there.
 *
 * A refusal is logged here, once, with its reason only.
 */
export function enforceConfluenceUrlLinkOrigin(
  body: ParentNode,
  serialise: () => string,
  evidence: string | null | undefined,
): string {
  const first = serialise();
  if (!URL_START_TAG.test(first)) return first;
  const refuse = refuseConfluenceStorage;
  let storedCache: StorageLinkAnalysis | null | undefined;
  const stored = (): StorageLinkAnalysis | null => {
    if (storedCache !== undefined) return storedCache;
    storedCache = null;
    const read = evidence ? readConfluenceStorage(evidence) : null;
    if (read?.ok) {
      try {
        storedCache = analyseStorageLinks(read.tree);
      } catch (error) {
        if (!(error instanceof StorageLinkBudgetError)) throw error;
        return refuse('too-many-nodes');
      }
    } else if (read && read.reason !== 'not-well-formed') {
      // Past a limit the evidence is there and cannot be used: writing without it would drop links unseen.
      return refuse(read.reason);
    }
    // Stored storage that is not XML proves nothing: every candidate is declined.
    return storedCache;
  };
  const judge = (storage: string): { analysis: StorageLinkAnalysis; verdicts: StorageUrlLinkVerdict[] } | null => {
    const read = readConfluenceStorage(storage);
    if (!read.ok) {
      // Unreadable: when the scan accounts for the whole string and finds no `url` start tag there is
      // nothing to judge; with one, or when that cannot be told, the string may hold a link nobody checked.
      if (scanStorageForStartTag(storage, 'url') === 'no') return null;
      return refuse(read.reason);
    }
    try {
      const analysis = analyseStorageLinks(read.tree);
      const needsEvidence = analysis.links.some((link) => !link.navigable);
      return { analysis, verdicts: judgeStorageUrlLinks(analysis, needsEvidence ? stored() : null) };
    } catch (error) {
      if (!(error instanceof StorageLinkBudgetError)) throw error;
      return refuse('too-many-nodes');
    }
  };
  const declinedOf = (verdicts: readonly StorageUrlLinkVerdict[]): number[] =>
    verdicts.flatMap((verdict, index) => (isApprovedUrlLinkVerdict(verdict) ? [] : [index]));

  const judged = judge(first);
  if (!judged) return first;
  const declined = declinedOf(judged.verdicts);
  if (declined.length === 0) return first;

  // Find each declined link in the document. Positions in two lists prove nothing, so every link-like
  // element is marked with an attribute nobody can have written, the document is serialised once more
  // and read: an attribute only adds to a start tag, so that reading has the elements of the first in
  // the same order, and the mark on a link names its element.
  const marker = `data-cq-link-${randomBytes(16).toString('hex')}`;
  const elements = linkLikeElements(body);
  elements.forEach((element, index) => element.setAttribute(marker, String(index)));
  let marked: string;
  try {
    marked = serialise();
  } finally {
    for (const element of elements) element.removeAttribute(marker);
  }
  const markedRead = readConfluenceStorage(marked);
  if (!markedRead.ok) return refuse('unapproved-link');
  const markedLinks = [...storageElements(markedRead.tree)].filter((element) => resemblesStorageName(element, 'link'));
  if (markedLinks.length !== judged.analysis.linkLike) return refuse('unapproved-link');
  const unwrap: Array<{ element: Element; shown: NonNullable<ReturnType<typeof storageLinkShown>> }> = [];
  for (const index of declined) {
    const link = judged.analysis.links[index]!;
    const twin = markedLinks[link.ordinal]!;
    const mark = twin.attributes.find((attribute) => attribute.name === marker);
    const element = mark ? elements[Number(mark.value)] : undefined;
    // Not an element of the document (raw text read as markup), so it cannot be taken out of it.
    if (twin.name !== link.element.name || !element) return refuse('unapproved-link');
    // What it shows is not known: taking it away could drop that unseen.
    const shown = storageLinkShown(link);
    if (!shown) return refuse('unapproved-link');
    unwrap.push({ element, shown });
  }
  // Innermost first: an outer link's body may hold an inner one.
  for (const { element, shown } of unwrap.reverse()) {
    if (!unwrapUrlLink(element, shown)) return refuse('unapproved-link');
  }

  const second = serialise();
  const rejudged = judge(second);
  // The second reading must hold no declined link, and show exactly the text the first one showed.
  if (!rejudged || declinedOf(rejudged.verdicts).length > 0 || rejudged.analysis.text !== judged.analysis.text) {
    return refuse('unapproved-link');
  }
  const counts = { unproven: 0, ambiguous: 0, retarget: 0 };
  for (const index of declined) counts[judged.verdicts[index] as keyof typeof counts] += 1;
  logger.warn(counts, 'Confluence URL links without a stored origin written as text (#1955)');
  return second;
}

/** What the reverse pass writes for a character JSDOM leaves raw in an attribute value, and for its `&nbsp;`. */
const LINK_VALUE_ESCAPES: Readonly<Record<string, string>> = {
  '<': '&lt;', '>': '&gt;', '\t': '&#9;', '\n': '&#10;', '\r': '&#13;', '&nbsp;': '&#160;',
};

/** The start tag of an `ac:link` or of any `ri:*` resource element, as JSDOM serializes it. */
const LINK_START_TAG = /<(ac:link|ri:[a-z][a-z0-9-]*)((?: [^\s="]+="[^"]*")+)>/g;

/**
 * `xhtml` with `<`, `>`, tab, line feed and carriage return escaped, and
 * `&nbsp;` written `&#160;`, in the attribute values of every `ac:link` and
 * `ri:*` start tag (#1748). JSDOM escapes only `"`, `&` and NBSP (as the HTML
 * entity `&nbsp;`, which XML does not predefine) there; XML forbids a raw `<`,
 * and attribute-value normalization would turn a raw tab, line feed or
 * carriage return into a space. Must run before the void-element pass, which
 * would otherwise rewrite a `<br>` inside a value.
 */
export function escapeConfluenceLinkAttributes(xhtml: string): string {
  return xhtml.replace(
    LINK_START_TAG,
    (_, tag: string, attrs: string) => `<${tag}${attrs.replace(/[<>\t\n\r]|&nbsp;/g, (m) => LINK_VALUE_ESCAPES[m] ?? m)}>`,
  );
}
