/**
 * The href grammar of Confluence links in body_html (#1748, #1955).
 *
 * `confluenceToHtml` turns an `<ac:link>` into an `<a>` whose href carries the
 * whole link, and `htmlToConfluence` rebuilds the `<ac:link>` from that href
 * alone. The href is the carrier because it is the only attribute of an `<a>`
 * that survives every hop: TipTap's Link mark (StarterKit, in both editor
 * schemas and in read mode) keeps `href`, `target`, `rel`, `class` and `title`
 * and drops every `data-*` attribute when the editor saves, while turndown,
 * marked and DOMPurify all keep a fragment href as written.
 *
 *   #confluence-page:<title>[?<params>]            <ri:page ri:content-title>
 *   #confluence-attachment:<filename>[?<params>]   <ri:attachment ri:filename>
 *   #confluence-anchor:<anchor>[?<params>]         <ac:link ac:anchor> with no resource
 *   #confluence-blog-post:<title>[?<params>]       <ri:blog-post ri:content-title>   (#1955)
 *   #confluence-space:<key>[?<params>]             <ri:space ri:space-key>           (#1955)
 *   #confluence-shortcut:<key>[?<params>]          <ri:shortcut ri:key>              (#1955)
 *   #confluence-content-entity:<id>[?<params>]     <ri:content-entity ri:content-id> (#1955)
 *   #confluence-url:<value>[?<params>]             <ri:url ri:value>                 (#1955)
 *
 * Every value is UTF-8 percent-encoded down to the RFC 3986 unreserved set
 * (`A-Z a-z 0-9 - . _ ~`), so the href holds no space, quote, `<`, `&`, `#`,
 * `%`-literal, `(` or `)` of its own: it survives an HTML attribute, a
 * Markdown link destination and a `LIKE` pattern unchanged. `<params>` are
 * `name=value` pairs joined by `&`, in this order:
 *
 *   ac:*                every other ac:* attribute of the ac:link, in source order
 *   ri:*                every other ri:* attribute of the resource element, in source order
 *   <local>.ri:*        the ri:attachment's container element (`page.ri:space-key=ENG` is
 *                       `<ri:page ri:space-key="ENG"/>` inside the ri:attachment), in source order
 *   body=plain|rich     the link body's element: written only when the text cannot tell it
 *                       for a page, attachment or anchor link, and for every explicit body of
 *                       the five #1955 kinds
 *
 * An href written before #1748 (`#confluence-page:<title as written>`,
 * `#confluence-attachment:<filename as written>`) is still read: whatever does
 * not parse as the grammar above is that legacy shape. One that does parse
 * (a title made only of unreserved characters and `%XX`, or ending in a valid
 * `?name=value` list) is read as the grammar: every href written since #1748
 * is encoded, so the encoded reading wins. No href of a #1955 kind predates
 * the grammar, so those are never read as the legacy shape.
 *
 * A `ri:url` whose value is a lowercase `http:`, `https:` or `mailto:` URL with
 * nothing hidden in it ({@link isNavigableConfluenceUrl}) is the one link whose
 * href is not its carrier: its `<a>` holds the URL as a real href and the
 * carrier as its `class` ({@link isConfluenceUrlClassCarrierFor}). Every other
 * `ri:url` value stays an inert `#confluence-url:` fragment.
 *
 * This module is strings and RegExps only (no DOM, logger or Node API): the
 * backend's `core/services/confluence-link.ts` and both editor schemas share
 * it, and `confluence-link.ts` stays the only module that reads or builds
 * link elements.
 */

export const CONFLUENCE_LINK_KINDS = [
  'page', 'attachment', 'anchor', 'blog-post', 'space', 'shortcut', 'content-entity', 'url',
] as const;

export type ConfluenceLinkKind = (typeof CONFLUENCE_LINK_KINDS)[number];

/** The kinds #1748 carries; only these read an href written before the grammar. */
export const CONFLUENCE_LINK_KINDS_1748: readonly ConfluenceLinkKind[] = ['page', 'attachment', 'anchor'];

/** A carried attribute: its name and value. */
export type ConfluenceLinkAttr = readonly [name: string, value: string];

/** Everything a Confluence link href carries (#1748, #1955). */
export interface ConfluenceLinkTarget {
  kind: ConfluenceLinkKind;
  /** The kind's primary attribute ({@link CONFLUENCE_LINK_PRIMARY_ATTR}). */
  value: string;
  /** The other `ac:*` attributes of the `ac:link`, in order. */
  link: ConfluenceLinkAttr[];
  /** The other `ri:*` attributes of the resource element, in order. */
  resource: ConfluenceLinkAttr[];
  /** The `ri:attachment`'s container element (`page` for `ri:page`) and its `ri:*` attributes. */
  container: { name: string; attrs: ConfluenceLinkAttr[] } | null;
  /** The body element when the href says it; null derives it from the text. */
  body: 'plain' | 'rich' | null;
  /** An href written before #1748: the value as written, nothing else carried. */
  legacy: boolean;
}

export const CONFLUENCE_PAGE_HREF_PREFIX = '#confluence-page:';
export const CONFLUENCE_ATTACHMENT_HREF_PREFIX = '#confluence-attachment:';

export const CONFLUENCE_LINK_HREF_PREFIX: Readonly<Record<ConfluenceLinkKind, string>> = {
  page: CONFLUENCE_PAGE_HREF_PREFIX,
  attachment: CONFLUENCE_ATTACHMENT_HREF_PREFIX,
  anchor: '#confluence-anchor:',
  'blog-post': '#confluence-blog-post:',
  space: '#confluence-space:',
  shortcut: '#confluence-shortcut:',
  'content-entity': '#confluence-content-entity:',
  url: '#confluence-url:',
};

/** The attribute each kind keeps in the href's path, and so never as a parameter. */
export const CONFLUENCE_LINK_PRIMARY_ATTR: Readonly<Record<ConfluenceLinkKind, string>> = {
  page: 'ri:content-title',
  attachment: 'ri:filename',
  anchor: 'ac:anchor',
  'blog-post': 'ri:content-title',
  space: 'ri:space-key',
  shortcut: 'ri:key',
  'content-entity': 'ri:content-id',
  url: 'ri:value',
};

/** The resource element of each kind; an anchor link has none. */
export const CONFLUENCE_LINK_RESOURCE_ELEMENT: Readonly<Record<Exclude<ConfluenceLinkKind, 'anchor'>, string>> = {
  page: 'ri:page',
  attachment: 'ri:attachment',
  'blog-post': 'ri:blog-post',
  space: 'ri:space',
  shortcut: 'ri:shortcut',
  'content-entity': 'ri:content-entity',
  url: 'ri:url',
};

export const CONFLUENCE_LINK_LIMITS = {
  /** The longest carried value; Confluence caps titles and filenames at 255 characters. */
  value: 1024,
  /** The most attributes carried for one element (ac:link, resource, container); real ones have at most four. */
  attrs: 16,
  /** The longest href; a real one stays under 8,000 characters even with 255-character CJK values. */
  href: 16_384,
  /** The longest local part of a carried attribute name (`space-key` in `ri:space-key`). */
  localName: 64,
  /** The longest container element name (`page` in `ri:page`, `blog-post`, …). */
  containerName: 32,
} as const;

/** What a body-less #1955 link shows when its primary value is empty or only white space. */
export const CONFLUENCE_EMPTY_LINK_LABEL = '(empty link)';

/** Characters XML 1.0 forbids even escaped: a value holding one would make Confluence refuse the page. */
// eslint-disable-next-line no-control-regex -- matching the control characters XML forbids is the point
const LINK_XML_FORBIDDEN_CHAR = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|\p{Cs}/u;

/** A carried value: at most the value cap, no character XML forbids. */
export function isConfluenceLinkValue(value: string): boolean {
  return value.length <= CONFLUENCE_LINK_LIMITS.value && !LINK_XML_FORBIDDEN_CHAR.test(value);
}

/**
 * The local part of a carried attribute name: an ASCII XML NCName of at most
 * the local-name cap. A carried name is `ac:` + this on the ac:link and `ri:`
 * + this on a resource element, so `xmlns` / `xmlns:*` is never carried and a
 * name never needs encoding in the href.
 */
const LOCAL = `[A-Za-z_][\\w.-]{0,${CONFLUENCE_LINK_LIMITS.localName - 1}}`;
/** A container element's local name, at most the container-name cap. */
const CONTAINER = `[a-z][a-z0-9-]{0,${CONFLUENCE_LINK_LIMITS.containerName - 1}}`;
const LOCAL_NAME = new RegExp(`^${LOCAL}$`);
const CONTAINER_NAME = new RegExp(`^${CONTAINER}$`);
const AC_PARAM = new RegExp(`^ac:${LOCAL}$`);
const RI_PARAM = new RegExp(`^ri:${LOCAL}$`);
/** A container parameter: the container's local name, `.`, its `ri:*` attribute. */
const CONTAINER_PARAM = new RegExp(`^(${CONTAINER})\\.(ri:${LOCAL})$`);
const PARAM_NAME = new RegExp(`^(?:body|ac:${LOCAL}|ri:${LOCAL}|${CONTAINER}\\.ri:${LOCAL})$`);

/** Whether `local` is the local part of an attribute name a link can carry. */
export function isConfluenceLinkLocalName(local: string): boolean {
  return LOCAL_NAME.test(local);
}

/** Whether `name` is a container element's local name a link can carry. */
export function isConfluenceLinkContainerName(name: string): boolean {
  return CONTAINER_NAME.test(name);
}

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
    return isConfluenceLinkValue(value) ? value : null;
  } catch {
    return null;
  }
}

function is1748Kind(kind: ConfluenceLinkKind): boolean {
  return CONFLUENCE_LINK_KINDS_1748.includes(kind);
}

/**
 * The href that carries `link` (#1748). A parameter that would take the href
 * past the href cap is not written; its name goes to `dropped`. For the five
 * #1955 kinds the `body` parameter is reserved first: an authored body's kind
 * is never the parameter that gives way to an optional attribute.
 */
export function buildConfluenceLinkHref(link: Omit<ConfluenceLinkTarget, 'legacy'>, dropped: string[]): string {
  const params: ConfluenceLinkAttr[] = [
    ...link.link,
    ...link.resource,
    ...(link.container?.attrs.map(([name, value]): ConfluenceLinkAttr => [`${link.container!.name}.${name}`, value]) ?? []),
  ];
  const reserveBody = link.body !== null && !is1748Kind(link.kind);
  // `?body=plain` / `&body=rich`: one separator, the name, `=`, the value.
  const max = CONFLUENCE_LINK_LIMITS.href - (reserveBody ? `?body=${link.body}`.length : 0);
  let href = `${CONFLUENCE_LINK_HREF_PREFIX[link.kind]}${encodeConfluenceLinkValue(link.value)}`;
  let separator = '?';
  for (const [name, value] of params) {
    const param = `${separator}${name}=${encodeConfluenceLinkValue(value)}`;
    if (href.length + param.length > max) {
      dropped.push(name);
      continue;
    }
    href += param;
    separator = '&';
  }
  if (link.body) {
    const param = `${separator}body=${link.body}`;
    if (!reserveBody && href.length + param.length > CONFLUENCE_LINK_LIMITS.href) dropped.push('body');
    else href += param;
  }
  return href;
}

/**
 * What a Confluence link href carries, or null when `href` is none (#1748).
 * An href of a page or an attachment that does not parse as the grammar is
 * read as the shape written before #1748 — the title or filename as written,
 * nothing else — and an href that parses but breaks a rule (longer than the
 * href cap, a value that does not decode or that XML cannot hold, a repeated,
 * misplaced or unknown parameter, more than the attribute cap for one
 * element) is none. `kinds` restricts the kinds read; an href of another kind
 * is none.
 */
export function parseConfluenceLinkHref(
  href: string,
  options: { kinds?: readonly ConfluenceLinkKind[] } = {},
): ConfluenceLinkTarget | null {
  const kind = (options.kinds ?? CONFLUENCE_LINK_KINDS).find((k) => href.startsWith(CONFLUENCE_LINK_HREF_PREFIX[k]));
  if (!kind || href.length > CONFLUENCE_LINK_LIMITS.href) return null;
  const rest = href.slice(CONFLUENCE_LINK_HREF_PREFIX[kind].length);
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
    if ((kind !== 'page' && kind !== 'attachment') || !isConfluenceLinkValue(rest)) return null;
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
    if (decoded === null || seen.has(name) || name === CONFLUENCE_LINK_PRIMARY_ATTR[kind]) return null;
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
  const tooMany = [link.link, link.resource, link.container?.attrs ?? []]
    .some((attrs) => attrs.length > CONFLUENCE_LINK_LIMITS.attrs);
  return tooMany ? null : link;
}

/**
 * What a link shows when it has no body (#1955). A page, an attachment and an
 * anchor show their value as written (#1748). The five #1955 kinds show the
 * value with every run of white space collapsed to one space and the ends
 * trimmed, or {@link CONFLUENCE_EMPTY_LINK_LABEL} when nothing is left: text
 * that is only white space does not survive an editor, and a link without
 * text is no link there. The label is display only; the resource keeps the
 * value the href carries.
 */
export function confluenceLinkDisplayText(link: Pick<ConfluenceLinkTarget, 'kind' | 'value'>): string {
  if (is1748Kind(link.kind)) return link.value;
  const text = link.value.replace(/\s+/gu, ' ').trim();
  return text === '' ? CONFLUENCE_EMPTY_LINK_LABEL : text;
}

/** Lowercase http, https or mailto at index 0, and no white space, control or format character after it. */
const NAVIGABLE_URL = /^(?:https?|mailto):[^\s\p{Cc}\p{Cf}]*$/u;

/**
 * Whether a `ri:url` value is written as a real href (#1955): a lowercase
 * `http:`, `https:` or `mailto:` URL with nothing hidden in it. The literal
 * scheme at index 0 is the safety property: browsers, DOMPurify and TipTap
 * strip leading control characters and spaces and delete TAB, LF and CR
 * before they read a scheme, so with `h` or `m` first and none of those
 * anywhere every parser reads exactly one of the three schemes. Any other
 * value (another case, another scheme, relative, empty, white space or an
 * invisible character anywhere) stays an inert `#confluence-url:` carrier.
 */
export function isNavigableConfluenceUrl(value: string): boolean {
  return isConfluenceLinkValue(value) && NAVIGABLE_URL.test(value);
}

/**
 * Whether an element whose link target is `href` may keep `className` as that
 * link's carrier (#1955): `href` is a navigable URL, `className` is one class
 * token within the href cap, it parses as a non-legacy `url` carrier inside
 * every grammar cap, and the value it carries is exactly `href`. The
 * `#confluence-url:` prefix alone is never enough. One function for the
 * converter, both editor schemas and the image node of #1954.
 */
export function isConfluenceUrlClassCarrierFor(href: string, className: string): boolean {
  if (!isNavigableConfluenceUrl(href)) return false;
  if (className.length > CONFLUENCE_LINK_LIMITS.href || /[\t\n\f\r ]/.test(className)) return false;
  const link = parseConfluenceLinkHref(className, { kinds: ['url'] });
  return link !== null && !link.legacy && link.value === href;
}
