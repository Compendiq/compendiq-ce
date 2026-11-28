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
import { CONFLUENCE_STORAGE_NAMESPACES } from '../confluence-storage-reader.js';

const AC = CONFLUENCE_STORAGE_NAMESPACES.ac;
const RI = CONFLUENCE_STORAGE_NAMESPACES.ri;

/**
 * The 248 names XHTML 1.0 declares besides XML's five, written out here: the
 * oracle does not take its names from the reader it checks.
 */
const XHTML_ENTITY_NAMES = (
  ''
  + 'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute '
  + 'micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring '
  + 'AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml '
  + 'times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil '
  + 'egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash '
  + 'ugrave uacute ucirc uuml yacute thorn yuml fnof Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa '
  + 'Lambda Mu Nu Xi Omicron Pi Rho Sigma Tau Upsilon Phi Chi Psi Omega alpha beta gamma delta epsilon zeta eta '
  + 'theta iota kappa lambda mu nu xi omicron pi rho sigmaf sigma tau upsilon phi chi psi omega thetasym upsih '
  + 'piv bull hellip prime Prime oline frasl weierp image real trade alefsym larr uarr rarr darr harr crarr lArr '
  + 'uArr rArr dArr hArr forall part exist empty nabla isin notin ni prod sum minus lowast radic prop infin ang '
  + 'and or cap cup int there4 sim cong asymp ne equiv le ge sub sup nsub sube supe oplus otimes perp sdot lceil '
  + 'rceil lfloor rfloor lang rang loz spades clubs hearts diams OElig oelig Scaron scaron Yuml circ tilde ensp '
  + 'emsp thinsp zwnj zwj lrm rlm ndash mdash lsquo rsquo sbquo ldquo rdquo bdquo dagger Dagger permil lsaquo '
  + 'rsaquo euro '
).trim().split(' ');

/**
 * The two names HTML5 redefined. XHTML 1.0 (xhtml-symbol.ent) declares `lang`
 * as U+2329 and `rang` as U+232A; an HTML decoder gives U+27E8 and U+27E9.
 */
const XHTML_NOT_HTML5: ReadonlyMap<string, string> = new Map([['lang', '\u2329'], ['rang', '\u232a']]);

/**
 * The oracle's entity table, pinned independently of the production table:
 * its own list of names, the values of an HTML decoder (`he`), and the two
 * values where XHTML 1.0 differs from that decoder stated here.
 */
export const ORACLE_ENTITIES: ReadonlyMap<string, string> = new Map(
  XHTML_ENTITY_NAMES.map((name) => [name, XHTML_NOT_HTML5.get(name) ?? he.decode(`&${name};`)]),
);

const ENTITY_DECLARATIONS = [...ORACLE_ENTITIES]
  .map(([name, value]) => `<!ENTITY ${name} "${value}">`)
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
