/**
 * Confluence links in body_html (#1748).
 *
 * `confluenceToHtml` turns an `<ac:link>` into an `<a>` whose href carries the
 * whole link, and `htmlToConfluence` rebuilds the `<ac:link>` from that href
 * alone. The href is the carrier because it is the only attribute of an `<a>`
 * that survives every hop: TipTap's Link mark (StarterKit, in both editor
 * schemas and in read mode) keeps `href`, `target`, `rel`, `class` and `title`
 * and drops every `data-*` attribute when the editor saves, while turndown,
 * marked and DOMPurify all keep a fragment href as written.
 *
 *   #confluence-page:<title>[?<params>]           <ri:page ri:content-title>
 *   #confluence-attachment:<filename>[?<params>]  <ri:attachment ri:filename>
 *   #confluence-anchor:<anchor>[?<params>]        <ac:link ac:anchor> with no resource
 *
 * Every value is UTF-8 percent-encoded down to the RFC 3986 unreserved set
 * (`A-Z a-z 0-9 - . _ ~`), so the href holds no space, quote, `<`, `&`, `#`,
 * `%`-literal, `(` or `)` of its own: it survives an HTML attribute, a
 * Markdown link destination and a `LIKE` pattern unchanged. `<params>` are
 * `name=value` pairs joined by `&`, in this order:
 *
 *   ac:*                every other ac:* attribute of the ac:link, in source order
 *   ri:*                every other ri:* attribute of the ri:page / ri:attachment, in source order
 *   <local>.ri:*        the ri:attachment's container element (`page.ri:space-key=ENG` is
 *                       `<ri:page ri:space-key="ENG"/>` inside the ri:attachment), in source order
 *   body=plain|rich     the link body's element, written only when the text cannot tell it
 *
 * An href written before #1748 (`#confluence-page:<title as written>`,
 * `#confluence-attachment:<filename as written>`) is still read: whatever does
 * not parse as the grammar above is that legacy shape. One that does parse
 * (a title made only of unreserved characters and `%XX`, or ending in a valid
 * `?name=value` list) is read as the grammar: every href written since #1748
 * is encoded, so the encoded reading wins.
 */
import { logger } from '../utils/logger.js';

/** A carried attribute: its name and value. */
type LinkAttr = readonly [name: string, value: string];

type ConfluenceLinkKind = 'page' | 'attachment' | 'anchor';

/** Everything a Confluence link href carries (#1748). */
interface ConfluenceLinkTarget {
  kind: ConfluenceLinkKind;
  /** `ri:content-title` (page), `ri:filename` (attachment) or `ac:anchor` (anchor). */
  value: string;
  /** The other `ac:*` attributes of the `ac:link`, in order. */
  link: LinkAttr[];
  /** The other `ri:*` attributes of the `ri:page` / `ri:attachment`, in order. */
  resource: LinkAttr[];
  /** The `ri:attachment`'s container element (`page` for `ri:page`) and its `ri:*` attributes. */
  container: { name: string; attrs: LinkAttr[] } | null;
  /** The body element when the link's text cannot tell it; null derives it from the text. */
  body: 'plain' | 'rich' | null;
  /** An href written before #1748: the value as written, nothing else carried. */
  legacy: boolean;
}

export const CONFLUENCE_PAGE_HREF_PREFIX = '#confluence-page:';
export const CONFLUENCE_ATTACHMENT_HREF_PREFIX = '#confluence-attachment:';
const CONFLUENCE_ANCHOR_HREF_PREFIX = '#confluence-anchor:';

const HREF_PREFIX: Readonly<Record<ConfluenceLinkKind, string>> = {
  page: CONFLUENCE_PAGE_HREF_PREFIX,
  attachment: CONFLUENCE_ATTACHMENT_HREF_PREFIX,
  anchor: CONFLUENCE_ANCHOR_HREF_PREFIX,
};

/** The attribute each kind keeps in the href's path, and so never as a parameter. */
const PRIMARY_ATTR: Readonly<Record<ConfluenceLinkKind, string>> = {
  page: 'ri:content-title',
  attachment: 'ri:filename',
  anchor: 'ac:anchor',
};

const RESOURCE_ELEMENT = { page: 'ri:page', attachment: 'ri:attachment' } as const;

/** The longest carried value; Confluence caps titles and filenames at 255 characters. */
const LINK_VALUE_MAX = 1024;
/** The most attributes carried for one element (ac:link, resource, container); real ones have at most four. */
const LINK_ATTRS_MAX = 16;
/** The longest href; a real one stays under 8,000 characters even with 255-character CJK values. */
const LINK_HREF_MAX = 16_384;
/** The longest local part of a carried attribute name (`space-key` in `ri:space-key`). */
const LINK_LOCAL_NAME_MAX = 64;
/** The longest container element name (`page` in `ri:page`, `blog-post`, …). */
const LINK_CONTAINER_NAME_MAX = 32;

/** Characters XML 1.0 forbids even escaped: a value holding one would make Confluence refuse the page. */
// eslint-disable-next-line no-control-regex -- matching the control characters XML forbids is the point
const LINK_XML_FORBIDDEN_CHAR = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|\p{Cs}/u;

/** A carried value: at most LINK_VALUE_MAX characters, none XML forbids. */
function isLinkValue(value: string): boolean {
  return value.length <= LINK_VALUE_MAX && !LINK_XML_FORBIDDEN_CHAR.test(value);
}

/**
 * The local part of a carried attribute name: an ASCII XML NCName of at most
 * LINK_LOCAL_NAME_MAX characters. A carried name is `ac:` + this on the
 * ac:link and `ri:` + this on a resource element, so `xmlns` / `xmlns:*` is
 * never carried and a name never needs encoding in the href.
 */
const LOCAL = `[A-Za-z_][\\w.-]{0,${LINK_LOCAL_NAME_MAX - 1}}`;
/** A container element's local name, at most LINK_CONTAINER_NAME_MAX characters. */
const CONTAINER = `[a-z][a-z0-9-]{0,${LINK_CONTAINER_NAME_MAX - 1}}`;
const LOCAL_NAME = new RegExp(`^${LOCAL}$`);
const CONTAINER_NAME = new RegExp(`^${CONTAINER}$`);
const AC_PARAM = new RegExp(`^ac:${LOCAL}$`);
const RI_PARAM = new RegExp(`^ri:${LOCAL}$`);
/** A container parameter: the container's local name, `.`, its `ri:*` attribute. */
const CONTAINER_PARAM = new RegExp(`^(${CONTAINER})\\.(ri:${LOCAL})$`);
const PARAM_NAME = new RegExp(`^(?:body|ac:${LOCAL}|ri:${LOCAL}|${CONTAINER}\\.ri:${LOCAL})$`);

/** A percent-encoded value: unreserved characters and `%XX` escapes only. */
const ENCODED_VALUE = /^(?:[A-Za-z0-9\-._~]|%[0-9A-Fa-f]{2})*$/;

/** `value` UTF-8 percent-encoded down to the RFC 3986 unreserved set (#1748). */
export function encodeConfluenceLinkValue(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

function decodeLinkValue(encoded: string): string | null {
  try {
    const value = decodeURIComponent(encoded);
    return isLinkValue(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * The href that carries `link` (#1748). A parameter that would take the href
 * past LINK_HREF_MAX is not written; its name goes to `dropped`.
 */
function confluenceLinkHref(link: Omit<ConfluenceLinkTarget, 'legacy'>, dropped: string[]): string {
  const params: LinkAttr[] = [
    ...link.link,
    ...link.resource,
    ...(link.container?.attrs.map(([name, value]): LinkAttr => [`${link.container!.name}.${name}`, value]) ?? []),
    ...(link.body ? [['body', link.body] as const] : []),
  ];
  let href = `${HREF_PREFIX[link.kind]}${encodeConfluenceLinkValue(link.value)}`;
  let separator = '?';
  for (const [name, value] of params) {
    const param = `${separator}${name}=${encodeConfluenceLinkValue(value)}`;
    if (href.length + param.length > LINK_HREF_MAX) {
      dropped.push(name);
      continue;
    }
    href += param;
    separator = '&';
  }
  return href;
}

/**
 * What a Confluence link href carries, or null when `href` is none (#1748).
 * An href that does not parse as the grammar is read as the shape written
 * before #1748 — the title or filename as written, nothing else — and an
 * href that parses but breaks a rule (longer than LINK_HREF_MAX, a value that
 * does not decode or that XML cannot hold, a repeated, misplaced or unknown
 * parameter, more than LINK_ATTRS_MAX attributes for one element) is none.
 */
export function parseConfluenceLinkHref(href: string): ConfluenceLinkTarget | null {
  const kind = (Object.keys(HREF_PREFIX) as ConfluenceLinkKind[]).find((k) => href.startsWith(HREF_PREFIX[k]));
  if (!kind || href.length > LINK_HREF_MAX) return null;
  const rest = href.slice(HREF_PREFIX[kind].length);
  const queryAt = rest.indexOf('?');
  const path = queryAt < 0 ? rest : rest.slice(0, queryAt);
  const pairs = queryAt < 0
    ? []
    : rest.slice(queryAt + 1).split('&').map((param) => {
      const eq = param.indexOf('=');
      return eq < 0 ? null : [param.slice(0, eq), param.slice(eq + 1)] as const;
    });
  const grammar = ENCODED_VALUE.test(path)
    && pairs.every((pair) => pair !== null && PARAM_NAME.test(pair[0]) && ENCODED_VALUE.test(pair[1]));
  if (!grammar) {
    if (kind === 'anchor' || !isLinkValue(rest)) return null;
    return { kind, value: rest, link: [], resource: [], container: null, body: null, legacy: true };
  }

  const value = decodeLinkValue(path);
  if (value === null) return null;
  const link: ConfluenceLinkTarget = {
    kind, value, link: [], resource: [], container: null, body: null, legacy: false,
  };
  const seen = new Set<string>();
  for (const pair of pairs) {
    const [name, encoded] = pair!;
    const decoded = decodeLinkValue(encoded);
    if (decoded === null || seen.has(name) || name === PRIMARY_ATTR[kind]) return null;
    seen.add(name);
    if (name === 'body') {
      if (decoded !== 'plain' && decoded !== 'rich') return null;
      link.body = decoded;
    } else if (AC_PARAM.test(name)) {
      link.link.push([name, decoded]);
    } else if (RI_PARAM.test(name)) {
      if (kind === 'anchor') return null;
      link.resource.push([name, decoded]);
    } else {
      const [, container, attr] = CONTAINER_PARAM.exec(name)!;
      if (kind !== 'attachment' || (link.container && link.container.name !== container)) return null;
      link.container ??= { name: container!, attrs: [] };
      link.container.attrs.push([attr!, decoded]);
    }
  }
  const tooMany = [link.link, link.resource, link.container?.attrs ?? []].some((attrs) => attrs.length > LINK_ATTRS_MAX);
  return tooMany ? null : link;
}

/**
 * `el`'s attributes in `prefix`'s namespace, in source order, except
 * `primary`: the ones a link carries, at most LINK_ATTRS_MAX. An attribute in
 * the namespace that it cannot carry (a local name over LINK_LOCAL_NAME_MAX
 * characters, a value over LINK_VALUE_MAX or holding a character XML forbids,
 * one past the cap) goes to `dropped` as `label` + its name. Attributes of
 * other namespaces (`xmlns:*`, unprefixed) are never carried.
 */
function carriedAttrs(el: Element, prefix: 'ac:' | 'ri:', primary: string | undefined, label: string, dropped: string[]): LinkAttr[] {
  const carried: LinkAttr[] = [];
  for (const { name, value } of el.attributes) {
    if (name === primary || !name.startsWith(prefix)) continue;
    if (carried.length < LINK_ATTRS_MAX && LOCAL_NAME.test(name.slice(prefix.length)) && isLinkValue(value)) {
      carried.push([name, value]);
    } else {
      dropped.push(label + name);
    }
  }
  return carried;
}

const BODY_ELEMENTS = ['ac:link-body', 'ac:plain-text-link-body'];

/**
 * What replaces an `<ac:link>` to a page, an attachment or an anchor on this
 * page — its `<a>`, then whatever a self-closing link swallowed — else null
 * (#1748). The resource is the link's first direct `ri:*` child, so the
 * `ri:page` inside a link's `ri:attachment` is that attachment's container,
 * never the link's target. The text is the link body — rich content as markup,
 * plain text as text — or, with no body, what Confluence shows instead: the
 * title, the filename or the anchor. The body is the link's own child, or the
 * resource's when the resource's self-closing tag held a `/` or `>` in a value
 * (expandSelfClosingXhtmlTags cannot match it) and it swallowed the body.
 * Anything else inside the link (whitespace, a stray element) is dropped with
 * the `ac:link`, as before #1748 — except in an anchor link without a body,
 * whose content can only be what its unexpanded self-closing tag swallowed:
 * that moves back out behind the `<a>`. An attribute the href cannot carry,
 * and an attachment's container whose name is over LINK_CONTAINER_NAME_MAX
 * characters, is logged, never dropped silently.
 */
export function confluenceLinkAnchor(acLink: Element): Node[] | null {
  const resource = [...acLink.children].find((child) => child.tagName.toLowerCase().startsWith('ri:'));
  let kind: ConfluenceLinkKind;
  if (!resource) {
    kind = 'anchor';
  } else if (resource.tagName.toLowerCase() === 'ri:page') {
    kind = 'page';
  } else if (resource.tagName.toLowerCase() === 'ri:attachment') {
    kind = 'attachment';
  } else {
    return null;
  }
  const value = (resource ?? acLink).getAttribute(PRIMARY_ATTR[kind]);
  if (value === null || !isLinkValue(value)) return null;

  const dropped: string[] = [];
  const link = carriedAttrs(acLink, 'ac:', kind === 'anchor' ? 'ac:anchor' : undefined, '', dropped);
  const resourceAttrs = resource ? carriedAttrs(resource, 'ri:', PRIMARY_ATTR[kind], '', dropped) : [];
  let container: ConfluenceLinkTarget['container'] = null;
  const owner = kind === 'attachment'
    ? [...resource!.children].find((child) => child.tagName.toLowerCase().startsWith('ri:'))
    : undefined;
  if (owner) {
    const name = owner.tagName.toLowerCase().slice(3);
    if (CONTAINER_NAME.test(name)) container = { name, attrs: carriedAttrs(owner, 'ri:', undefined, `${name}.`, dropped) };
    else dropped.push(owner.tagName.toLowerCase());
  }

  const a = acLink.ownerDocument.createElement('a');
  const bodyEl = [acLink, resource].flatMap((el) => (el ? [...el.children] : []))
    .find((child) => BODY_ELEMENTS.includes(child.tagName.toLowerCase()));
  let body: ConfluenceLinkTarget['body'] = null;
  if (!bodyEl || (bodyEl.children.length === 0 && (bodyEl.textContent ?? '').trim() === '')) {
    a.textContent = value;
  } else if (bodyEl.tagName.toLowerCase() === 'ac:link-body') {
    // Server-side JSDOM only (see the SECURITY note in content-converter.ts).
    // nosemgrep: javascript.browser.security.insecure-document-method.insecure-document-method
    a.innerHTML = bodyEl.innerHTML;
    if (a.children.length === 0) body = 'rich';
  } else {
    a.textContent = bodyEl.textContent ?? '';
    if (a.textContent === value) body = 'plain';
  }
  a.setAttribute('href', confluenceLinkHref({ kind, value, link, resource: resourceAttrs, container, body }, dropped));
  a.setAttribute('data-confluence-link', kind);
  if (dropped.length > 0) {
    logger.warn(
      { attributes: dropped.slice(0, 10).map((name) => name.slice(0, 80)), count: dropped.length },
      'Confluence link attributes not carried (#1748)',
    );
  }
  return kind === 'anchor' && !bodyEl ? [a, ...acLink.childNodes] : [a];
}

/**
 * The `<ac:link>` an `<a>` with a Confluence link href stands for, else null
 * (#1748). The body follows the `<a>`'s content: markup is an `ac:link-body`
 * (its nodes move, so a placeholder inside is still converted where it now
 * sits), text is an `ac:plain-text-link-body` — or no body at all when the text
 * is what Confluence shows without one — unless the href's `body` says which.
 */
export function confluenceLinkElement(a: Element): Element | null {
  const link = parseConfluenceLinkHref(a.getAttribute('href') ?? '');
  if (!link) return null;
  const doc = a.ownerDocument;
  const acLink = doc.createElement('ac:link');
  if (link.kind === 'anchor') acLink.setAttribute('ac:anchor', link.value);
  for (const [name, value] of link.link) acLink.setAttribute(name, value);
  if (link.kind !== 'anchor') {
    const resource = doc.createElement(RESOURCE_ELEMENT[link.kind]);
    resource.setAttribute(PRIMARY_ATTR[link.kind], link.value);
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
    const kind = link.body ?? (text === '' || text === link.value ? null : 'plain');
    if (kind) {
      const body = doc.createElement(kind === 'rich' ? 'ac:link-body' : 'ac:plain-text-link-body');
      body.textContent = text;
      acLink.appendChild(body);
    }
  }
  return acLink;
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
