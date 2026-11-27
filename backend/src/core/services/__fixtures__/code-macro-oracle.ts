/**
 * An independent reading of the #1958 storage rule, for tests (review r1 CM-8).
 *
 * The production judgement (`readCodeMacroInventory` / `judgeCodeMacros` in
 * content-converter.ts) walks the SAX tree of `confluence-storage-reader.ts`.
 * This oracle reads the same string with JSDOM's XML parser
 * (`storageOracle`) and applies the rule of design §3.5.1 through the
 * namespace-aware DOM API: a different parser, a different tree and its own
 * walk. A differential test holds the two to the same verdict and the same
 * records, so a defect of either does not vouch for itself.
 */
import { CONFLUENCE_STORAGE_NAMESPACES } from '../confluence-storage-reader.js';
import { storageOracle } from './storage-oracle.js';

const AC = CONFLUENCE_STORAGE_NAMESPACES.ac;
const INERT = ['style', 'script', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'plaintext', 'textarea', 'title', 'template'];
const TEXT_NODE = 3;
const CDATA_NODE = 4;
const ELEMENT_NODE = 1;

/** XML's namespace for `xmlns` / `xmlns:*` declarations; an ordinary attribute that only starts with `xmlns` is not one. */
const XMLNS = 'http://www.w3.org/2000/xmlns/';

function isNamespaceDeclaration(attribute: Attr): boolean {
  return attribute.namespaceURI === XMLNS;
}

export type OracleCodeMacros =
  | { readonly ok: true; readonly records: string[]; readonly bareKeys: string[] }
  | { readonly ok: false; readonly reason: 'unreadable' | 'unapproved-code-macro' };

function isAc(node: { namespaceURI: string | null; prefix: string | null; localName: string }, local: string): boolean {
  return node.namespaceURI === AC && node.prefix === 'ac' && node.localName === local;
}

/** The text of an element that holds text (and CDATA) only; null when it holds an element. */
function textOnly(element: Element): string | null {
  let text = '';
  for (const node of Array.from(element.childNodes)) {
    if (node.nodeType === ELEMENT_NODE) return null;
    if (node.nodeType === TEXT_NODE || node.nodeType === CDATA_NODE) text += node.nodeValue ?? '';
  }
  return text;
}

/** The oracle's records and bare keys of `storage`, in the production record format. */
export function oracleCodeMacros(storage: string): OracleCodeMacros {
  let doc: Document;
  try {
    doc = storageOracle(storage);
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  const refuse: OracleCodeMacros = { ok: false, reason: 'unapproved-code-macro' };
  const records: string[] = [];
  const bareKeys: string[] = [];
  const recordByKey = new Map<string, string>();
  for (const element of Array.from(doc.documentElement.getElementsByTagName('*'))) {
    const local = element.localName.toLowerCase();
    if (local !== 'structured-macro' && local !== 'macro') continue;
    const named = Array.from(element.attributes).some((attribute) =>
      !isNamespaceDeclaration(attribute) && attribute.localName.toLowerCase() === 'name'
      && attribute.value.trim().toLowerCase() === 'code');
    if (!named) continue;
    // Inside another canonical code macro's text only an element would make it a candidate; that refuses below anyway.
    for (let ancestor = element.parentElement; ancestor && ancestor !== doc.documentElement; ancestor = ancestor.parentElement) {
      if (INERT.includes(ancestor.localName.toLowerCase())) return refuse;
    }
    const attributes = Array.from(element.attributes).filter((attribute) => !isNamespaceDeclaration(attribute));
    if (!isAc(element, 'structured-macro') || attributes.length !== 1 || !isAc(attributes[0]!, 'name')
      || attributes[0]!.value !== 'code') return refuse;
    const parameters: Array<[string, string]> = [];
    let body: string | null = null;
    for (const node of Array.from(element.childNodes)) {
      if (node.nodeType === TEXT_NODE || node.nodeType === CDATA_NODE) return refuse;
      if (node.nodeType !== ELEMENT_NODE) continue;
      const child = node as Element;
      if (body !== null) return refuse;
      const text = textOnly(child);
      if (text === null) return refuse;
      const childAttributes = Array.from(child.attributes).filter((attribute) => !isNamespaceDeclaration(attribute));
      if (isAc(child, 'parameter') && childAttributes.length === 1 && isAc(childAttributes[0]!, 'name')) {
        parameters.push([childAttributes[0]!.value, text]);
      } else if (isAc(child, 'plain-text-body') && childAttributes.length === 0) {
        body = text;
      } else {
        return refuse;
      }
    }
    if (body === null) return refuse;
    const key = JSON.stringify([parameters.find(([name]) => name === 'language')?.[1] ?? '', body]);
    const record = JSON.stringify([parameters, body]);
    const prior = recordByKey.get(key);
    if (prior !== undefined && prior !== record) return refuse;
    recordByKey.set(key, record);
    if (parameters.length === 0 || (parameters.length === 1 && parameters[0]![0] === 'language')) bareKeys.push(key);
    else records.push(record);
  }
  return { ok: true, records: records.sort(), bareKeys };
}

/**
 * The oracle's verdict on `storage` given the records the trusted units
 * yield (`reference`, read by this oracle too): rules (i)–(iii).
 */
export function oracleCodeMacroVerdict(storage: string, reference: string): 'pass' | 'unreadable' | 'unapproved-code-macro' {
  const written = oracleCodeMacros(storage);
  if (!written.ok) return written.reason;
  const allowed = oracleCodeMacros(reference);
  if (!allowed.ok) return 'unapproved-code-macro';
  if (written.records.length !== allowed.records.length
    || written.records.some((record, index) => record !== allowed.records[index])) return 'unapproved-code-macro';
  const approvedKeys = new Set(allowed.records.map((record) => {
    const [parameters, body] = JSON.parse(record) as [Array<[string, string]>, string];
    return JSON.stringify([parameters.find(([name]) => name === 'language')?.[1] ?? '', body]);
  }));
  return written.bareKeys.some((key) => approvedKeys.has(key)) ? 'unapproved-code-macro' : 'pass';
}
