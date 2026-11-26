/**
 * Confluence links in body_html (#1748).
 *
 * `confluenceToHtml` turns an `<ac:link>` into an `<a>` whose href carries the
 * whole link, and `htmlToConfluence` rebuilds the `<ac:link>` from that href
 * alone. The href grammar (prefixes, parameters, caps, encoding, the legacy
 * reading) is pure and lives in `@compendiq/contracts`
 * (`confluence-link-grammar.ts`), which the editor schemas share; it is
 * re-exported here. This module is the only one that reads or builds link
 * elements: the converter, `link-extractor.ts` and the baseline manifest go
 * through it.
 */
import {
  buildConfluenceLinkHref,
  CONFLUENCE_LINK_KINDS_1748,
  CONFLUENCE_LINK_LIMITS,
  CONFLUENCE_LINK_PRIMARY_ATTR,
  CONFLUENCE_LINK_RESOURCE_ELEMENT,
  isConfluenceLinkContainerName,
  isConfluenceLinkLocalName,
  isConfluenceLinkValue,
  parseConfluenceLinkHref as parseLinkHref,
  type ConfluenceLinkAttr,
  type ConfluenceLinkKind,
  type ConfluenceLinkTarget,
} from '@compendiq/contracts';
import { logger } from '../utils/logger.js';

export {
  CONFLUENCE_ATTACHMENT_HREF_PREFIX,
  CONFLUENCE_PAGE_HREF_PREFIX,
  encodeConfluenceLinkValue,
} from '@compendiq/contracts';

/** What a Confluence link href carries, or null when `href` is none (#1748): the shared grammar. */
export function parseConfluenceLinkHref(href: string): ConfluenceLinkTarget | null {
  return parseLinkHref(href, { kinds: CONFLUENCE_LINK_KINDS_1748 });
}

/**
 * `el`'s attributes in `prefix`'s namespace, in source order, except
 * `primary`: the ones a link carries, at most LINK_ATTRS_MAX. An attribute in
 * the namespace that it cannot carry (a local name over LINK_LOCAL_NAME_MAX
 * characters, a value over LINK_VALUE_MAX or holding a character XML forbids,
 * one past the cap) goes to `dropped` as `label` + its name. Attributes of
 * other namespaces (`xmlns:*`, unprefixed) are never carried.
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
  a.setAttribute('href', buildConfluenceLinkHref({ kind, value, link, resource: resourceAttrs, container, body }, dropped));
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
