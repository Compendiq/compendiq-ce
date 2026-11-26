/**
 * An independent XML reading of a storage string, for tests (#1955).
 *
 * The production reader (`confluence-storage-reader.ts`) builds its own tree
 * from SAX events. This oracle hands the same string to JSDOM's XML parser
 * inside a root element that declares the Confluence namespaces, and answers
 * from the DOM that parser builds: a different tree builder, queried through
 * the DOM API with namespaces. Tests assert what was dispatched through it
 * with explicit expected values, so a defect of the production reader does not
 * vouch for itself.
 */
import he from 'he';
import { JSDOM } from 'jsdom';
import { CONFLUENCE_STORAGE_NAMESPACES, STORAGE_ENTITIES } from '../confluence-storage-reader.js';

const AC = CONFLUENCE_STORAGE_NAMESPACES.ac;
const RI = CONFLUENCE_STORAGE_NAMESPACES.ri;

/** The XHTML 1.0 names, with the values an HTML decoder gives them (not the production table). */
const ENTITY_DECLARATIONS = [...STORAGE_ENTITIES.keys()]
  .map((name) => `<!ENTITY ${name} "${he.decode(`&${name};`)}">`)
  .join('');

/** `storage` parsed as XML, or a thrown error when it is not well-formed. */
export function storageOracle(storage: string): Document {
  const xml = `<!DOCTYPE cq [${ENTITY_DECLARATIONS}]>`
    + `<cq xmlns:ac="${AC}" xmlns:ri="${RI}" xmlns:at="${CONFLUENCE_STORAGE_NAMESPACES.at}">${storage}</cq>`;
  return new JSDOM(xml, { contentType: 'application/xml' }).window.document;
}

/** Whether the oracle can read `storage` at all. */
export function oracleReads(storage: string): boolean {
  try {
    storageOracle(storage);
    return true;
  } catch {
    return false;
  }
}

function attributesOf(element: Element): Record<string, string> {
  const out: Record<string, string> = {};
  for (const attribute of element.attributes) {
    if (attribute.name === 'xmlns' || attribute.name.startsWith('xmlns:')) continue;
    out[attribute.name] = attribute.value;
  }
  return out;
}

export interface OracleUrlLink {
  /** `ri:value` of the link's `ri:url`. */
  value: string | null;
  /** The `ac:link`'s attributes. */
  link: Record<string, string>;
  /** The `ri:url`'s attributes besides `ri:value`. */
  resource: Record<string, string>;
  /** The link body: `plain:<text>`, `rich:<inner XML text content>` or `none`. */
  body: string;
  /** The text of the link body, whatever its kind. */
  text: string;
}

/**
 * Every link (`ac:link` in the Confluence namespace) with a `ri:url` resource
 * child, in document order: what Confluence would take for a URL link.
 */
export function oracleUrlLinks(storage: string): OracleUrlLink[] {
  const doc = storageOracle(storage);
  const out: OracleUrlLink[] = [];
  for (const link of doc.getElementsByTagNameNS(AC, 'link')) {
    const url = [...link.children].find((child) => child.namespaceURI === RI && child.localName === 'url');
    if (!url) continue;
    const plain = [...link.children].find((child) => child.namespaceURI === AC && child.localName === 'plain-text-link-body');
    const rich = [...link.children].find((child) => child.namespaceURI === AC && child.localName === 'link-body');
    const { 'ri:value': value, ...resource } = attributesOf(url);
    out.push({
      value: value ?? null,
      link: attributesOf(link),
      resource,
      body: plain ? `plain:${plain.textContent}` : rich ? `rich:${rich.textContent}` : 'none',
      text: (plain ?? rich)?.textContent ?? '',
    });
  }
  return out;
}

/** The elements with expanded name (`namespace`, `local`), in document order. */
export function oracleElements(storage: string, namespace: 'ac' | 'ri', local: string): Element[] {
  return [...storageOracle(storage).getElementsByTagNameNS(CONFLUENCE_STORAGE_NAMESPACES[namespace], local)];
}

/** The number of elements whose local name is `local`, whatever their namespace or case. */
export function oracleLocalNameCount(storage: string, local: string): number {
  return [...storageOracle(storage).getElementsByTagName('*')]
    .filter((element) => element.localName.toLowerCase() === local).length;
}
