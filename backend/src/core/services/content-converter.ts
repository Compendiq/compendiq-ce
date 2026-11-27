import { randomBytes } from 'node:crypto';
import { JSDOM, type VirtualConsole } from 'jsdom';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { Marked, Renderer, type Token, type Tokens } from 'marked';
import { parseFragment, type DefaultTreeAdapterTypes } from 'parse5';
import he from 'he';
import {
  getAttachmentImageSource,
  getLocalFilenameForImageSource,
} from './image-references.js';
import { isConfluenceTaskId, MAX_CONFLUENCE_TASK_ID } from './confluence-task-id.js';
import { logger } from '../utils/logger.js';
import {
  CONFLUENCE_LINK_KINDS_1748,
  confluenceLinkAnchor,
  confluenceLinkCarrier,
  confluenceLinkCarrierOf,
  confluenceLinkElement,
  enforceConfluenceUrlLinkOrigin,
  escapeConfluenceLinkAttributes,
  keepXmlLinkValues,
  materializeConfluenceUrlLinks,
  parseConfluenceLinkHref,
  refuseConfluenceStorage,
  storedLinkKeepsTarget,
} from './confluence-link.js';
import {
  ConfluenceStorageRefusedError,
  isStorageLimitStop,
  isStorageName,
  readConfluenceStorage,
  resemblesStorageName,
  STORAGE_READER_LIMITS,
  type StorageElement,
  type StorageReaderLimits,
  type StorageReadFailure,
  type StorageTree,
} from './confluence-storage-reader.js';
import {
  ALL_STORAGE_DERIVATION_FEATURES,
  assertStorageDerivationFeatures,
  derivationHas,
  type StorageDerivationFeatures,
} from './storage-derivation.js';

// SECURITY: All innerHTML usage below is in server-side JSDOM context (Node.js),
// NOT browser DOM. JSDOM is used purely as an HTML parser/transformer for
// Confluence XHTML <-> HTML conversion. Content originates from authenticated
// Confluence API responses and is sanitized by DOMPurify before browser display.
// Semgrep "insecure-document-method" findings are false positives here.

// JSDOM 28's HTML parser treats <![CDATA[...]]> as comments. Pre-process to
// convert CDATA sections into text that survives HTML parsing.
function stripCdata(xhtml: string): string {
  return xhtml.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, content) => {
    return content
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  });
}

// JSDOM parses with contentType 'text/html' (the namespaced XHTML we get from
// Confluence is not a valid XML document because of entity references and
// mixed-case elements). In HTML mode, self-closing syntax like
// `<ri:user ri:userkey="x" />` is NOT treated as self-closing — only the HTML
// void elements (br, img, hr, etc.) are. That means two adjacent
// `<ri:user ... />` tags NEST: the second becomes a child of the first, and
// text between them gets swallowed until the next matching close tag (often
// end-of-body). See PR #314 finding #1.
//
// Fix: rewrite `<tag ... />` into `<tag ...></tag>` for the Confluence
// namespaced elements that commonly appear in self-closing form and are NOT
// meant to contain children (ri:user, ri:page, ri:attachment, ri:url,
// ac:emoticon). This is narrow and surgical — it does not touch container
// elements like ac:structured-macro, ac:rich-text-body, etc.
//
// `ac:parameter` CAN legitimately hold children (the
// `<ac:parameter><ri:page/></ac:parameter>` that include / excerpt-include
// use), and it is in the list anyway (#1222 review) because a *value-less*
// parameter is empty, so an XML serializer may normalise it to `<ac:parameter
// ac:name="subtle"/>`. Unexpanded, that element swallows every following
// parameter AND the ac:rich-text-body as its own children: the macro's
// remaining parameters became grandchildren (invisible to a direct-child
// lookup) and an empty `title` parameter absorbed the body, titling the section
// with its own opening prose. A parameter that really does carry content is
// never written self-closing, so the rewrite cannot reach it. Expanding the tag
// is what lets the rest of this file treat "parameter" and "direct
// ac:parameter child" as the same thing.
//
// `ac:link` (#1748) is the same case: a link to an anchor on the page may be
// written body-less and self-closing, `<ac:link ac:anchor="x" />`, and
// unexpanded it swallowed the text after it. A link with a resource or a body
// has children and is never written self-closing.
const SELF_CLOSING_XHTML_TAGS = [
  'ri:user',
  'ri:page',
  'ri:attachment',
  'ri:url',
  'ac:emoticon',
  'ac:parameter',
  'ac:link',
];

function expandSelfClosingXhtmlTags(xhtml: string): string {
  let out = xhtml;
  for (const tag of SELF_CLOSING_XHTML_TAGS) {
    // Match <tag ... /> (with optional whitespace before />) and rewrite into
    // <tag ...></tag>. The attribute body is captured so attribute values
    // containing `>` (rare for these tags) don't trip us up — Confluence
    // attribute values are always quoted.
    const re = new RegExp(`<${tag}((?:\\s+[^>/]*)?)\\s*/>`, 'g');
    out = out.replace(re, `<${tag}$1></${tag}>`);
  }
  return out;
}

// JSDOM 28 does not support CSS selectors with escaped colons for namespaced
// elements (ac:structured-macro, ri:page, etc). getElementsByTagName works.
function byTag(root: Document | Element, tag: string): Element[] {
  return [...root.getElementsByTagName(tag)];
}

function getMacroName(el: Element): string {
  return el.getAttribute('ac:name') ?? el.getAttribute('data-macro-name') ?? '';
}

/**
 * Read one named parameter from a macro's DIRECT ac:parameter children (#1222).
 *
 * `ac:parameter` is a direct child of `ac:structured-macro` by storage-format
 * schema, so scoping the lookup loses nothing legitimate — but that guarantee
 * reaches the parsed DOM only because the tag is expanded out of self-closing
 * form first (SELF_CLOSING_XHTML_TAGS above). Unexpanded, one value-less
 * parameter makes every parameter after it a grandchild, invisible here.
 *
 * A descendant search (what this did before) let a macro read the first match
 * anywhere in its subtree — a NESTED macro's parameter — and the reverse pass
 * then persisted that value onto the outer macro as a parameter the Confluence
 * page never had. Nothing limits that to the handlers that render a body: any
 * macro whose source element contains another macro can be the victim, and
 * storage XHTML is API-writable, so the nesting is reachable even where
 * Confluence's own editor would not produce it. Every name resolved through
 * this helper is exposed — `title`, `language`, `colour`, `border`, `width`,
 * `key`, `diagramName`, `upload`/`old`, `depth`, `max`, `maxLevel`. Thefts
 * verified on dev: an untitled `expand` took a nested expand's `title`, or a
 * nested `status` badge's; `section` took a nested macro's `border`; `column`
 * took its `width`, which also landed in an inline flex style. Which macros
 * could donate a value was an accident of handler order, not a rule — a nested
 * `code` macro is already replaced by the time the expand branch looks, a
 * nested `status` macro is not.
 *
 * Keeps `textContent` semantics — an element-valued parameter contributes its
 * text — which is what separates this from `collectDirectTextParams` below,
 * where such a parameter is skipped instead.
 */
function getParamValue(macro: Element, name: string): string | null {
  for (const child of [...macro.children]) {
    if (child.tagName.toLowerCase() !== 'ac:parameter') continue;
    if (child.getAttribute('ac:name') === name) {
      return child.textContent;
    }
  }
  return null;
}

/**
 * Collect a macro's DIRECT ac:parameter children as a name → text map (#865).
 * Used to persist an unknown macro's arbitrary parameters generically so the
 * reverse pass can rebuild them. Only direct children are read (so params of a
 * nested macro inside the body aren't captured), and only text-valued params
 * with a name are kept — anonymous or element-valued params (e.g. the
 * `<ac:parameter><ri:page/></ac:parameter>` used by include) are skipped
 * because they can't be faithfully serialized to a JSON string.
 */
function collectDirectTextParams(macro: Element): Record<string, string> {
  const params: Record<string, string> = {};
  for (const child of [...macro.children]) {
    if (child.tagName.toLowerCase() !== 'ac:parameter') continue;
    const name = child.getAttribute('ac:name');
    if (!name) continue;
    if (child.children.length > 0) continue;
    params[name] = child.textContent ?? '';
  }
  return params;
}

/**
 * Macros that map onto `<details>` (#1129).
 *
 * `ui-expand` is Refined's "UI Expand" from the Refined Macro Toolkit — a
 * different macro from Atlassian's native `expand`, not a rename. Verified
 * against a Confluence DC 9.2.19 instance with the app installed: the key is
 * bare `ui-expand` (the `rw-ui-expands-macro` / `rw-expand` spellings in
 * Refined's own docs are their Cloud renderer's internals and never appear in
 * DC storage format), and the element shape is identical to the native macro —
 * a `title` parameter plus `ac:rich-text-body`, flat siblings rather than a
 * container macro. Which one produced a given `<details>` is carried on
 * `data-macro-name` (#1211) so write-back never coerces one into the other.
 */
const EXPAND_MACRO_NAMES = new Set(['expand', 'ui-expand']);

/**
 * …and of those, the ones with a default-open parameter (#1129). Only Refined's
 * macro has one; emitting `expanded` on a native `expand` would invent a
 * parameter Atlassian's macro does not define, on a page that never had it.
 * Membership also decides which macros treat the `open` attribute as the single
 * source of truth for that state, so the forward and reverse passes stay
 * symmetric: a name outside this set keeps any `expanded` parameter verbatim in
 * `data-macro-params` instead.
 */
const EXPANDED_PARAM_MACROS = new Set(['ui-expand']);

function countRawStructuredMacros(root: Element | DocumentFragment): number {
  let count = 0;
  const pending: Array<Element | DocumentFragment> = [root];

  while (pending.length > 0) {
    const parent = pending.pop()!;
    for (const child of parent.children) {
      const tagName = child.tagName.toLowerCase();
      if (tagName === 'ac:structured-macro') count += 1;

      // Template descendants live in a separate DocumentFragment and are not
      // returned by getElementsByTagName. Inspect that fragment explicitly
      // without relying on JSDOM's broken escaped-colon selectors.
      pending.push(
        tagName === 'template'
          ? (child as HTMLTemplateElement).content
          : child,
      );
    }
  }

  return count;
}

const PANEL_MACRO_NAMES: Record<string, true> = {
  panel: true,
  info: true,
  warning: true,
  note: true,
  tip: true,
};

// Keep this registry in lockstep with the dedicated structured-macro handlers
// below. It is not a long-tail inventory: it only prevents a fresh clone of a
// supported macro from being prematurely downgraded by the catch-all.
const DEDICATED_MACRO_NAMES: Record<string, true> = {
  code: true,
  ...PANEL_MACRO_NAMES,
  expand: true,
  'ui-expand': true,
  drawio: true,
  status: true,
  toc: true,
  jira: true,
  include: true,
  'excerpt-include': true,
  column: true,
  section: true,
  children: true,
  'ui-children': true,
  attachments: true,
  labels: true,
};

/**
 * Transfer innerHTML from a source element to a target element.
 * Server-side JSDOM only — used for Confluence macro conversion.
 */
// nosemgrep: javascript.browser.security.insecure-document-method.insecure-document-method
function transferInnerHtml(target: Element, source: Element | undefined | null, fallback = ''): void {
  target.innerHTML = source?.innerHTML ?? fallback;
}

/**
 * A code block's language is ONE class token, `language-<token>` (#1749).
 * Every reader takes the whole token: this reverse pass, the code-block parse
 * rule in collab-schema.ts and frontend TitledCodeBlock.ts share the `\S`
 * class, so `c#`, `objective-c` and `c++` survive (`\w` cut them at the first
 * `#`, `-` or `+`). TipTap's own CodeBlock `language` attribute and turndown's
 * fenced-code rule already read the whole token, and the forward pass writes
 * the class only for a value that is one such token.
 */
const CODE_LANGUAGE_CLASS = /language-(\S+)/;

/**
 * Re-emit the parameters a forward handler stashed in `data-macro-params`.
 * `emitted` names the parameters the caller already wrote from the macro's
 * canonical attributes (#1749): a carried copy of one of those is skipped, so
 * each parameter has one home and a canonical value the editor can change
 * always wins over a stale carried one.
 */
function appendSerializedMacroParams(
  macro: Element,
  rawParams: string | null,
  emitted?: ReadonlySet<string>,
): void {
  if (!rawParams) return;
  try {
    const params = JSON.parse(rawParams) as Record<string, unknown>;
    for (const [paramName, paramValue] of Object.entries(params)) {
      if (typeof paramValue !== 'string') continue;
      if (emitted?.has(paramName)) continue;
      const parameter = macro.ownerDocument.createElement('ac:parameter');
      parameter.setAttribute('ac:name', paramName);
      parameter.textContent = paramValue;
      macro.appendChild(parameter);
    }
  } catch {
    // A malformed data attribute must not prevent the macro itself from
    // surviving write-back. Its body and identity remain lossless.
  }
}

interface ConfluenceConversionPass {
  html: string;
  macrosBefore: number;
  macrosAfter: number;
}

/**
 * Convert repeated static-snapshot passes until every structured macro has a
 * concrete HTML representation. Replacing an outer macro reparses its body and
 * can clone raw nested macros after their handler's snapshot has gone stale.
 *
 * Each successful pass removes at least one outer wrapper while preserving its
 * descendants, so the raw macro count must strictly decrease. Refuse to return
 * partial HTML if that invariant ever fails: the loop is bounded by the input
 * macro count and a malformed/unhandled shape is never silently discarded.
 */
export function confluenceToHtml(storageXhtml: string, pageId?: string, spaceKey?: string): string {
  return confluenceToHtmlWith(storageXhtml, pageId, spaceKey, ALL_STORAGE_DERIVATION_FEATURES);
}

/**
 * {@link confluenceToHtml} with a stated set of storage-derivation features
 * (#1953): every forward conversion says which set it derives with. A
 * write-back that converts stored storage itself ({@link storedTasks}) passes
 * its own set, so a restore recovered with the features it was reserved with
 * reads the stored tasks as it read them then.
 */
function confluenceToHtmlWith(
  storageXhtml: string,
  pageId: string | undefined,
  spaceKey: string | undefined,
  features: StorageDerivationFeatures,
  witness?: EmittedLinkWitness,
  carriers?: CarrierMarkState,
): string {
  assertStorageDerivationFeatures(features);
  let input = storageXhtml;
  while (true) {
    // #1953: a marked conversion stops between passes at its pass count; nothing here bounds one pass.
    if (carriers) {
      if (carriers.passes >= carriers.limits.passes) throw new CarrierMarkStop('bound');
      carriers.passes += 1;
    }
    const pass = confluenceToHtmlPass(input, pageId, spaceKey, features, input === storageXhtml, witness, carriers);
    if (pass.macrosAfter === 0) return pass.html;
    if (pass.macrosAfter >= pass.macrosBefore) {
      throw new Error(
        `Confluence macro conversion made no progress (${pass.macrosBefore} raw macros remain)`,
      );
    }
    if (carriers && pass.html.length > carriers.limits.html) throw new CarrierMarkStop('bound');
    input = pass.html;
  }
}

// ---------------------------------------------------------------------------
// #1953: carrier marks for the recovery of pages synced before v0.10.0
// ---------------------------------------------------------------------------

/** The carrier kinds whose builders mark what they build from a proven storage source (#1953). */
export type CarrierMarkKind = 'macro.code' | 'macro.status' | 'macro.toc' | 'emoticon' | 'link';

/**
 * What a builder writes, as JSON, into the marker attribute of the element it built from a proven source (#1953).
 * `n` is the source's index among the elements of the storage reader's tree, in document order. A code block
 * also records its `language` parameter; a link the `<a>` the converter before #1748 wrote for it: its `href`
 * (`null`: no attribute), its text (`null` for a rich body, which stays markup) and its body element.
 */
export type CarrierMark =
  | { k: 'macro.code'; n: number; l: string }
  | { k: 'macro.status' | 'macro.toc' | 'emoticon'; n: number }
  | { k: 'link'; n: number; h: string | null; x: string | null; b: 'none' | 'plain' | 'rich' };

/** Limits of a marked conversion, each checked before the work it bounds (#1953). */
export interface CarrierConversionLimits {
  /** The most proven sources (stamps, and so marks). */
  readonly marks: number;
  /** The most conversion passes. */
  readonly passes: number;
  /** The longest HTML one pass hands to the next. */
  readonly html: number;
  /** The most events the reading agreement and the builders' source checks compare. */
  readonly work: number;
}

/** The result of {@link confluenceToHtmlWithCarrierMarks}: numbers and the marked HTML, never storage content. */
export type CarrierMarkedConversion =
  | {
    readonly ok: true;
    /** The forward conversion's HTML with the marks of every proven source a builder took a value from. */
    readonly html: string;
    /** How many attributes link builders could not carry (they log nothing here). */
    readonly droppedLinkAttributes: number;
    /** Per kind, the proven sources a builder rejected because an earlier step changed their subtree (AA3). */
    readonly unsupported: Readonly<Record<CarrierMarkKind, number>>;
    readonly passes: number;
    readonly work: number;
  }
  | { readonly ok: false; readonly reason: 'storage_reading_differs' | 'bound'; readonly passes: number; readonly work: number };

interface CarrierSource {
  readonly element: StorageElement;
  /** The number of events of its subtree, itself included. */
  readonly events: number;
}

interface CarrierMarkState {
  readonly marker: string;
  readonly root: StorageElement;
  readonly limits: CarrierConversionLimits;
  readonly sources: Map<number, CarrierSource>;
  readonly unsupported: Record<CarrierMarkKind, number>;
  work: number;
  passes: number;
  dropped: number;
}

/** A marked conversion stopped: the two readings differ, or a limit was reached. Caught by its entry point. */
class CarrierMarkStop extends Error {
  constructor(readonly reason: 'storage_reading_differs' | 'bound') {
    super(reason);
    this.name = 'CarrierMarkStop';
  }
}

function chargeCarrierWork(state: CarrierMarkState, units: number): void {
  state.work += units;
  if (state.work > state.limits.work) throw new CarrierMarkStop('bound');
}

const CARRIER_TEXT_NODE = 3;

/** A start event: the name as written (as the HTML parser keeps it) and the attributes, name-sorted. */
function carrierStartEvent(name: string, attributes: Iterable<{ name: string; value: string }>, skip: string | null): string {
  const pairs: Array<[string, string]> = [];
  for (const { name: attr, value } of attributes) if (attr !== skip) pairs.push([attr, value]);
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return `s${name}\u0000${JSON.stringify(pairs)}`;
}

/**
 * The events of the storage reader's reading of `children`: a start, the events of the children and an end per
 * element, and one text event per text between two tag events. The element of each start event comes with it.
 */
function* storageCarrierEvents(children: ReadonlyArray<StorageElement | string>): Generator<readonly [string, StorageElement | null]> {
  let text = '';
  for (const child of children) {
    if (typeof child === 'string') {
      text += child;
      continue;
    }
    if (text !== '') yield [`t${text}`, null];
    text = '';
    yield [carrierStartEvent(child.name, child.attributes, null), child];
    yield* storageCarrierEvents(child.children);
    yield [`e${child.name}`, null];
  }
  if (text !== '') yield [`t${text}`, null];
}

/**
 * The same events of the forward pass's HTML reading of `parent`'s children. Comments (and the processing
 * instructions the HTML parser reads as comments) are skipped and do not split a text. The attribute `skip` (an
 * unconsumed source stamp) is no attribute.
 */
function* domCarrierEvents(parent: ParentNode, skip: string | null): Generator<readonly [string, Element | null]> {
  let text = '';
  for (const child of parent.childNodes) {
    if (child.nodeType === CARRIER_TEXT_NODE) {
      text += (child as Text).data;
      continue;
    }
    if (child.nodeType !== ELEMENT_NODE) continue;
    const element = child as Element;
    if (text !== '') yield [`t${text}`, null];
    text = '';
    yield [carrierStartEvent(element.localName, element.attributes, skip), element];
    yield* domCarrierEvents(element, skip);
    yield [`e${element.localName}`, null];
  }
  if (text !== '') yield [`t${text}`, null];
}

/** Whether a storage element is a source a carrier builder may take values from (#1953 §3.3 item 2). */
function isCarrierSource(el: StorageElement): boolean {
  if (isStorageName(el, 'ac', 'emoticon') || isStorageName(el, 'ac', 'link')) return true;
  if (!isStorageName(el, 'ac', 'structured-macro')) return false;
  const names = el.attributes.filter((attr) => isStorageName(attr, 'ac', 'name'));
  return names.length === 1
    && ['code', 'status', 'toc'].includes(names[0]!.value)
    && !el.attributes.some((attr) => attr.name === 'data-macro-name');
}

/** The event count of every element's subtree, itself included, in one walk. */
function carrierSubtreeEvents(root: StorageElement, into: Map<StorageElement, number>): number {
  let events = 0;
  let text = false;
  for (const child of root.children) {
    if (typeof child === 'string') {
      text = true;
      continue;
    }
    if (text) events += 1;
    text = false;
    const own = carrierSubtreeEvents(child, into) + 2;
    into.set(child, own);
    events += own;
  }
  return text ? events + 1 : events;
}

/**
 * #1953 §3.3 items 1–2, at the start of the first pass, before any step changes the parsed document: the HTML
 * reading of the whole body and the storage reader's tree must give the same events, start, end and text, from the
 * first to the last; any difference and the page recovers nothing. Then every source is stamped with the marker
 * and its index, after the mark cap was charged.
 */
function stampCarrierSources(body: Element, state: CarrierMarkState): void {
  const xml = storageCarrierEvents(state.root.children);
  const html = domCarrierEvents(body, null);
  const pairs: Array<readonly [Element, StorageElement, number]> = [];
  let index = 0;
  while (true) {
    const a = xml.next();
    const b = html.next();
    if (a.done || b.done) {
      if (a.done && b.done) break;
      throw new CarrierMarkStop('storage_reading_differs');
    }
    chargeCarrierWork(state, 1);
    if (a.value[0] !== b.value[0]) throw new CarrierMarkStop('storage_reading_differs');
    const element = a.value[1];
    if (!element) continue;
    if (isCarrierSource(element)) pairs.push([b.value[1]!, element, index]);
    index += 1;
  }
  if (pairs.length > state.limits.marks) throw new CarrierMarkStop('bound');
  if (pairs.length === 0) return;
  const events = new Map<StorageElement, number>();
  chargeCarrierWork(state, carrierSubtreeEvents(state.root, events));
  for (const [element, source, n] of pairs) {
    element.setAttribute(state.marker, String(n));
    state.sources.set(n, { element: source, events: events.get(source)! });
  }
}

/**
 * #1953 §3.3 item 3: a builder that selected `el` takes its stamp first, before it reads anything else, so no
 * value it builds can hold a stamp. A stamped element is a source only while its subtree is still the one the
 * reader read (unconsumed stamps below it are no attributes); otherwise an earlier step changed a value the
 * builder would read, nothing is marked and the kind counts one rejection. Returns the source's index, else null.
 */
function takeCarrierSource(el: Element, state: CarrierMarkState | undefined, kind: CarrierMarkKind): number | null {
  if (!state) return null;
  const raw = el.getAttribute(state.marker);
  if (raw === null) return null;
  el.removeAttribute(state.marker);
  const source = /^\d+$/.test(raw) ? state.sources.get(Number(raw)) : undefined;
  if (!source) return null;
  chargeCarrierWork(state, source.events);
  const xml = storageCarrierEvents([source.element]);
  const dom = (function* own(): Generator<readonly [string, Element | null]> {
    yield [carrierStartEvent(el.localName, el.attributes, state.marker), el];
    yield* domCarrierEvents(el, state.marker);
    yield [`e${el.localName}`, null];
  })();
  let seen = 0;
  while (true) {
    const a = xml.next();
    const b = dom.next();
    if (a.done && b.done) return Number(raw);
    seen += 1;
    if (a.done || b.done || seen > source.events || a.value[0] !== b.value[0]) {
      state.unsupported[kind] += 1;
      return null;
    }
  }
}

function markCarrier(el: Element, state: CarrierMarkState, mark: CarrierMark): void {
  el.setAttribute(state.marker, JSON.stringify(mark));
}

/**
 * The `<a>` the converter before #1748 wrote for an `<ac:link>` (`0944ced5^:content-converter.ts:433-463`): the
 * first descendant `ri:page`, else `ri:attachment`, else no href; a rich body as markup (`x` null), else the plain
 * body's text, else the title, the filename or nothing. Pure; read before the link builder moves the body.
 */
function legacyLinkShape(link: Element): { h: string | null; x: string | null; b: 'none' | 'plain' | 'rich' } {
  const pageRef = byTag(link, 'ri:page')[0];
  const attachRef = byTag(link, 'ri:attachment')[0];
  const bodyEl = byTag(link, 'ac:link-body')[0] ?? byTag(link, 'ac:plain-text-link-body')[0];
  const rich = bodyEl?.tagName.toLowerCase() === 'ac:link-body';
  const b = !bodyEl ? 'none' : rich ? 'rich' : 'plain';
  if (pageRef) {
    const title = pageRef.getAttribute('ri:content-title') ?? '';
    return { h: `#confluence-page:${title}`, x: rich ? null : bodyEl?.textContent ?? title, b };
  }
  if (attachRef) {
    const filename = attachRef.getAttribute('ri:filename') ?? '';
    return { h: `#confluence-attachment:${filename}`, x: rich ? null : bodyEl?.textContent ?? filename, b };
  }
  return { h: null, x: rich ? null : bodyEl?.textContent ?? '', b };
}

/**
 * The forward conversion of `storage` with carrier marks (#1953 §3.3), for the carrier recovery of pages synced
 * before v0.10.0 only. `tree` is the storage reader's reading of the same string; `marker` the caller's attribute
 * name (`data-cq-` and 32 hexadecimal digits), which `storage` does not spell. With every feature, like
 * {@link confluenceToHtml}, which does none of this and whose output is unchanged. Throws what the ordinary
 * conversion throws (a conversion that makes no progress).
 */
export function confluenceToHtmlWithCarrierMarks(
  storage: string,
  pageId: string | undefined,
  spaceKey: string | undefined,
  options: { tree: StorageTree; marker: string; limits: CarrierConversionLimits },
): CarrierMarkedConversion {
  const state: CarrierMarkState = {
    marker: options.marker,
    root: options.tree.root,
    limits: options.limits,
    sources: new Map(),
    unsupported: { 'macro.code': 0, 'macro.status': 0, 'macro.toc': 0, emoticon: 0, link: 0 },
    work: 0,
    passes: 0,
    dropped: 0,
  };
  try {
    const html = confluenceToHtmlWith(storage, pageId, spaceKey, ALL_STORAGE_DERIVATION_FEATURES, undefined, state);
    return {
      ok: true,
      html,
      droppedLinkAttributes: state.dropped,
      unsupported: { ...state.unsupported },
      passes: state.passes,
      work: state.work,
    };
  } catch (error) {
    if (error instanceof CarrierMarkStop) return { ok: false, reason: error.reason, passes: state.passes, work: state.work };
    throw error;
  }
}

/** Options for {@link htmlToConfluence}. */
export interface HtmlToConfluenceOptions {
  /**
   * The page's current Confluence storage (`pages.body_storage`) when the HTML
   * is written back over an existing page (#1751). Its tasks are the ones
   * Confluence has: a task without an id of its own takes the id of the stored
   * task with the same text, a copy of a task does not take its id, and a new
   * task never gets a stored id.
   */
  previousStorage?: string | null;
  /**
   * The page was synced before task ids were carried (#1751): its stored body
   * holds tasks and none carries an id ({@link hasOnlyUncarriedTasks} of the
   * stored `body_html`; for a collaborative Save, a room without the carried-ids
   * flag). Only then do the tasks left after the exact-text match take the
   * stored tasks left over, in document order, when they are as many. Callers
   * decide it from the page's stored state, never from the HTML being written;
   * AI Improve apply never sets it.
   */
  legacyTasks?: boolean;
  /**
   * The storage-derivation features this write-back derives with (#1953;
   * storage-derivation.ts). Only a version restore states them: the set its
   * intent recorded, so its recovery writes what its reservation wrote. Every
   * other writer omits the option and derives with every registered feature.
   */
  derivationFeatures?: StorageDerivationFeatures;
  /**
   * The page's stored storage as evidence for its `ri:url` links (#1955): a
   * link to a value that is not a navigable URL is written only as an
   * occurrence this storage already holds. Omitted, `previousStorage` is the
   * evidence; a writer that keeps `previousStorage` for `assignTaskIds` alone
   * (collaborative Save, draft publish) passes the stored storage here. An
   * explicit `null` is no evidence, never a fallback to `previousStorage`.
   */
  linkOrigin?: string | null;
}

/**
 * Whether a page's stored HTML was converted before task ids were carried
 * (#1751): it holds task items and none carries a task id.
 */
export function hasOnlyUncarriedTasks(html: string | null | undefined): boolean {
  if (!html?.includes('taskItem')) return false;
  const doc = new JSDOM(`<body>${html}</body>`, { contentType: 'text/html' }).window.document;
  const items = [...doc.querySelectorAll('li[data-type="taskItem"]')];
  return items.length > 0 && items.every((li) => !isConfluenceTaskId(li.getAttribute('data-task-id') ?? ''));
}

/** A task item's own text, without its subtasks' text, whitespace collapsed (#1751). */
function taskText(li: Element): string {
  const content = taskItemContent(li).cloneNode(true) as Element;
  for (const nested of [...content.querySelectorAll('ul[data-type="taskList"]'), ...byTag(content, 'ac:task-list')]) {
    nested.remove();
  }
  return (content.textContent ?? '').replace(/\s+/g, ' ').trim();
}

interface StoredTasks {
  /** The stored tasks in document order, each id once (its first task). */
  tasks: Array<{ id: string; text: string }>;
  /** The own text of each stored id's task. */
  textById: Map<string, string>;
}

/**
 * The features a write-back derives with (#1953): the set its caller states,
 * else every registered one.
 */
function writeBackFeatures(options: HtmlToConfluenceOptions): StorageDerivationFeatures {
  if (options.derivationFeatures === undefined) return ALL_STORAGE_DERIVATION_FEATURES;
  assertStorageDerivationFeatures(options.derivationFeatures);
  return options.derivationFeatures;
}

/**
 * The tasks a storage body holds, as confluenceToHtml writes them: each id
 * once (its first task), in document order, with the task's own text (#1751).
 * The conversion derives with the write-back's own `features` (#1953).
 */
function storedTasks(storage: string | null | undefined, features: StorageDerivationFeatures): StoredTasks {
  const tasks: Array<{ id: string; text: string }> = [];
  const textById = new Map<string, string>();
  if (storage) {
    const html = confluenceToHtmlWith(storage, undefined, undefined, features);
    const doc = new JSDOM(`<body>${html}</body>`, { contentType: 'text/html' }).window.document;
    for (const li of doc.querySelectorAll('li[data-type="taskItem"][data-task-id]')) {
      const id = li.getAttribute('data-task-id')!;
      if (textById.has(id)) continue;
      const text = taskText(li);
      textById.set(id, text);
      tasks.push({ id, text });
    }
  }
  return { tasks, textById };
}

interface TaskIdAllocation {
  /** The task items of the document, in document order. */
  items: Element[];
  /** The id a task item is written with; an item not in `items` gets the next free id. */
  idFor: (li: Element) => string;
}

/**
 * Decide the `ac:task-id` of every task item before htmlToConfluence's
 * innermost-first loop writes them, in document order (#1751):
 *
 * 1. Keep: a task keeps the id it carries in `data-task-id`. When several tasks
 *    carry one id (a pasted or duplicated task), the first whose own text is
 *    the stored task's keeps it, else the first; the others are copies and new.
 *    On a legacy page, whose own tasks carry no id, a task without an id whose
 *    text is the stored task's goes before a carrier whose text is not. An
 *    `ac:task-id` that passes through as raw storage keeps its id first.
 * 2. Reconcile: a task that carries no id takes the id of the first stored task
 *    nothing claimed whose own text it repeats exactly. On a legacy page, the
 *    tasks left then take the stored tasks left, in document order, when they
 *    are as many: that first save edited tasks without adding or removing any.
 * 3. Mint: every other task gets the next free number above the highest id in
 *    the document and in the stored page, each checked against every id taken
 *    so far, so a task deleted in this write never lends its number. Past
 *    2^63 - 1 the smallest free number is used instead.
 *
 * The same input always gives the same ids: publishing a version restore
 * re-derives the storage and compares digests (page-put-intent-reconciler.ts).
 * An item the snapshot did not hold (a clone a re-parse made) is minted when
 * it is written.
 */
function allocateTaskIds(doc: Document, options: HtmlToConfluenceOptions): TaskIdAllocation {
  const taken = new Set(byTag(doc, 'ac:task-id').map((el) => (el.textContent ?? '').trim()));
  const items = [...doc.querySelectorAll('ul[data-type="taskList"] li[data-type="taskItem"]')];
  const features = writeBackFeatures(options);
  let storedCache: StoredTasks | undefined;
  const stored = (): StoredTasks => (storedCache ??= storedTasks(options.previousStorage, features));
  const texts = new Map<Element, string>();
  const textOf = (li: Element): string => {
    let text = texts.get(li);
    if (text === undefined) {
      text = taskText(li);
      texts.set(li, text);
    }
    return text;
  };
  const carriers = new Map<string, Element[]>();
  const uncarried: Element[] = [];
  for (const li of items) {
    const carried = li.getAttribute('data-task-id') ?? '';
    if (isConfluenceTaskId(carried)) carriers.set(carried, [...(carriers.get(carried) ?? []), li]);
    else uncarried.push(li);
  }
  let uncarriedTexts: Set<string> | undefined;

  const ids = new Map<Element, string>();
  for (const [id, list] of carriers) {
    if (taken.has(id)) continue;
    const text = list.length > 1 || options.legacyTasks ? stored().textById.get(id) : undefined;
    let keeper = text === undefined ? list[0] : list.find((li) => textOf(li) === text);
    if (!keeper) {
      uncarriedTexts ??= new Set(uncarried.map(textOf));
      if (!(options.legacyTasks && uncarriedTexts.has(text!))) keeper = list[0];
    }
    if (keeper) {
      taken.add(id);
      ids.set(keeper, id);
    }
  }

  if (uncarried.length > 0 && stored().tasks.length > 0) {
    const unclaimed = new Map<string, string[]>();
    for (const task of stored().tasks) {
      if (!taken.has(task.id)) unclaimed.set(task.text, [...(unclaimed.get(task.text) ?? []), task.id]);
    }
    for (const li of uncarried) {
      const id = unclaimed.get(textOf(li))?.shift();
      if (id === undefined) continue;
      taken.add(id);
      ids.set(li, id);
    }
    if (options.legacyTasks) {
      const unmatched = uncarried.filter((li) => !ids.has(li));
      const left = stored().tasks.filter((task) => !taken.has(task.id));
      if (unmatched.length === left.length) {
        unmatched.forEach((li, index) => {
          const { id } = left[index]!;
          taken.add(id);
          ids.set(li, id);
        });
      }
    }
  }

  let next: bigint | undefined;
  const mint = (): string => {
    const retired = stored().textById;
    if (next === undefined) {
      next = 1n;
      for (const id of [...taken, ...retired.keys()]) {
        if (isConfluenceTaskId(id) && BigInt(id) >= next) next = BigInt(id) + 1n;
      }
    }
    // No task id is above 2^63 - 1: count on from the smallest free number.
    if (next > MAX_CONFLUENCE_TASK_ID) next = 1n;
    while (taken.has(String(next)) || retired.has(String(next))) next += 1n;
    const id = String(next);
    taken.add(id);
    next += 1n;
    return id;
  };
  for (const li of items) {
    if (!ids.has(li)) ids.set(li, mint());
  }
  return { items, idFor: (li) => ids.get(li) ?? mint() };
}

/**
 * `html` with each task item's write-back id in `data-task-id`, and those ids
 * in document order: what htmlToConfluence(html, options) writes (#1751). A
 * writer that keeps its HTML instead of re-deriving it from the storage
 * Confluence returns (draft publish, a collaborative Save) stores these ids,
 * so the next write keeps them.
 */
export function assignTaskIds(
  html: string,
  options: HtmlToConfluenceOptions = {},
): { html: string; taskIds: string[] } {
  const doc = new JSDOM(`<body>${html}</body>`, { contentType: 'text/html' }).window.document;
  const { items, idFor } = allocateTaskIds(doc, options);
  let changed = false;
  const taskIds = items.map((li) => {
    const id = idFor(li);
    if (li.getAttribute('data-task-id') !== id) {
      li.setAttribute('data-task-id', id);
      changed = true;
    }
    return id;
  });
  // Unchanged HTML is returned as given, not re-serialized.
  return { html: changed ? doc.body.innerHTML : html, taskIds };
}

/**
 * The element that holds a task item's content (#1751). TipTap's TaskItem
 * renders `<li><label><input type="checkbox"><span></span></label><div>…</div></li>`
 * and parses the content from that div: the label is editor chrome, and copied
 * into `ac:task-body` it put a checkbox inside every task an editor save wrote
 * back. Any other shape (converter output, Markdown import, Notion import)
 * holds its content in the li itself.
 */
function taskItemContent(li: Element): Element {
  const label = li.children[0];
  const content = li.children[1];
  if (
    li.children.length === 2
    && label?.tagName === 'LABEL'
    && label.querySelector('input[type="checkbox"]') !== null
    && content?.tagName === 'DIV'
  ) {
    return content;
  }
  return li;
}

/** A step inside the forward pass: the parsed storage and the features the pass derives with. */
type ForwardDerivationStep = (doc: Document, features: StorageDerivationFeatures) => void;

let forwardDerivationStepForTest: ForwardDerivationStep | undefined;

/**
 * Test seam (#1953). Runs `step` at the start of every forward pass, where a
 * feature's gated step runs, with the set that pass derives with. No forward
 * step is gated yet, so this is how a test sees which set reaches the pass a
 * write-back runs on `previousStorage`. `undefined` removes the step.
 */
export function _setForwardDerivationStepForTest(step: ForwardDerivationStep | undefined): void {
  forwardDerivationStepForTest = step;
}

/**
 * Run one static-snapshot conversion pass. A step gated on a
 * storage-derivation feature reads `derivationHas` on this pass's set
 * (#1953): the link kinds of #1955 are read only with `link-kinds`.
 */
function confluenceToHtmlPass(
  storageXhtml: string,
  pageId: string | undefined,
  spaceKey: string | undefined,
  features: StorageDerivationFeatures,
  firstPass: boolean,
  witness: EmittedLinkWitness | undefined,
  carriers?: CarrierMarkState,
): ConfluenceConversionPass {
  // #1955 (reviews r2 R12, r4 R21): with `link-kinds`, a link of a #1955 kind is read with the values XML reads.
  // Only the storage itself is spelled so; a later pass reads this pass's HTML, whose values were read here.
  // A witness (D20) has each stored link's start tag marked with its index in what the reader read. Owner decision
  // D21 (review r7, R28): the reader reads the stored string itself, before its CDATA is turned into text.
  const kept = firstPass && derivationHas(features, 'link-kinds') ? keepXmlLinkValues(storageXhtml, witness?.marker) : null;
  if (kept && witness) witness.links = kept.links;
  const preprocessed = expandSelfClosingXhtmlTags(stripCdata(kept ? kept.storage : storageXhtml));
  const dom = new JSDOM(`<body>${preprocessed}</body>`, { contentType: 'text/html' });
  const doc = dom.window.document;
  forwardDerivationStepForTest?.(doc, features);
  // #1953: a marked conversion proves its sources on the first parse, before any step below changes it.
  if (carriers && firstPass) stampCarrierSources(doc.body, carriers);
  const macrosAtPassStart = new Set(byTag(doc, 'ac:structured-macro'));
  const macrosBefore = countRawStructuredMacros(doc.body);

  // Process code blocks: ac:structured-macro[name=code] -> <pre><code>
  // #1749: `language` keeps its class and `title` the editor's existing
  // `data-title` on <pre>; every other direct text parameter (linenumbers,
  // collapse, firstline, theme, …) rides in `data-macro-params`, the #865
  // carrier. A canonical attribute is written only for a value it gives back
  // exactly (a non-empty title, a language that is one class token), and a
  // parameter leaves the carrier only when its attribute was written, so an
  // empty `language`/`title` stays carried: the #1227 rule for expand titles.
  for (const macro of byTag(doc, 'ac:structured-macro')) {
    if (getMacroName(macro) !== 'code') continue;
    const source = takeCarrierSource(macro, carriers, 'macro.code');
    const language = getParamValue(macro, 'language') ?? '';
    const title = getParamValue(macro, 'title') ?? '';
    const params = collectDirectTextParams(macro);
    const bodyEl = byTag(macro, 'ac:plain-text-body')[0];
    const code = bodyEl?.textContent ?? '';

    const pre = doc.createElement('pre');
    if (title !== '') {
      pre.setAttribute('data-title', title);
      delete params.title;
    }
    const codeEl = doc.createElement('code');
    if (/^\S+$/.test(language)) {
      codeEl.className = `language-${language}`;
      delete params.language;
    }
    if (Object.keys(params).length > 0) {
      pre.setAttribute('data-macro-params', JSON.stringify(params));
    }
    codeEl.textContent = code;
    pre.appendChild(codeEl);
    macro.replaceWith(pre);
    if (source !== null) markCarrier(pre, carriers!, { k: 'macro.code', n: source, l: language });
  }

  // Process task lists: ac:task-list -> <ul data-type="taskList">. The task's
  // own ac:task-id rides in data-task-id (#1751), so write-back keeps it; a
  // value that is not a Confluence task id is not carried and the task is new.
  for (const taskList of byTag(doc, 'ac:task-list')) {
    const ul = doc.createElement('ul');
    ul.setAttribute('data-type', 'taskList');

    for (const task of byTag(taskList, 'ac:task')) {
      const statusEl = byTag(task, 'ac:task-status')[0];
      const bodyEl = byTag(task, 'ac:task-body')[0];
      const checked = statusEl?.textContent === 'complete';
      // A direct child only (the #1222 rule): a subtask's id is not this task's.
      const taskId = [...task.children]
        .find((child) => child.tagName.toLowerCase() === 'ac:task-id')
        ?.textContent?.trim() ?? '';

      const li = doc.createElement('li');
      li.setAttribute('data-type', 'taskItem');
      li.setAttribute('data-checked', checked ? 'true' : 'false');
      if (isConfluenceTaskId(taskId)) li.setAttribute('data-task-id', taskId);
      transferInnerHtml(li, bodyEl);
      ul.appendChild(li);
    }

    taskList.replaceWith(ul);
  }

  // Process panels: native `panel` uses the existing info panel node for
  // display, but carries its original identity and arbitrary text parameters
  // so editor/write-back never coerces it permanently to `info` (#1438).
  for (const macro of byTag(doc, 'ac:structured-macro')) {
    const name = getMacroName(macro);
    if (!Object.hasOwn(PANEL_MACRO_NAMES, name)) continue;
    const bodyEl = byTag(macro, 'ac:rich-text-body')[0];
    const div = doc.createElement('div');
    div.className = `panel-${name === 'panel' ? 'info' : name}`;
    if (name === 'panel') {
      div.setAttribute('data-macro-name', name);
      const params = collectDirectTextParams(macro);
      if (Object.keys(params).length > 0) {
        div.setAttribute('data-macro-params', JSON.stringify(params));
      }
    }
    transferInnerHtml(div, bodyEl);
    macro.replaceWith(div);
  }

  // Process expand macros: ac:structured-macro[name=expand|ui-expand] -> <details>
  for (const macro of byTag(doc, 'ac:structured-macro')) {
    const macroName = getMacroName(macro);
    if (!EXPAND_MACRO_NAMES.has(macroName)) continue;
    // #1227: no `?? 'Click to expand'` default. Substituting one made absence
    // unrepresentable at the very first hop, and the reverse pass — which has
    // only the summary to go on — then wrote the substituted label back as a
    // real `title` parameter onto a customer page that never had one.
    // getParamValue returns the parameter's textContent, so the three storage
    // states arrive here already distinct: `null` (no parameter), `''`
    // (`<ac:parameter ac:name="title"/>`, a real empty title #1232 preserves)
    // and a string.
    const title = getParamValue(macro, 'title');
    const bodyEl = byTag(macro, 'ac:rich-text-body')[0];

    const details = doc.createElement('details');
    // #1211: stamp which macro produced this <details> so the reverse pass can
    // write back the right ac:name — since #1129 two macros map to this
    // element. Parameters other than `title` are persisted the same way the
    // #865 unknown-macro net does; `title` stays in <summary> only — one
    // source of truth per value, and the reverse pass rebuilds the parameter
    // from there.
    details.setAttribute('data-macro-name', macroName);
    const extraParams = collectDirectTextParams(macro);
    // …with one exception (#1227): an EMPTY title has no home in the summary,
    // because a blank summary is also what an absent title looks like. Keep
    // that one key so the two stay distinguishable; every non-empty title is
    // still deleted here and rebuilt from the summary, so a typed title never
    // has two homes to disagree.
    if (extraParams.title !== '') delete extraParams.title;
    // #1129: `expanded` gets the same one-value-one-home treatment as `title`.
    // It is read from the direct-children map because it has to be deleted from
    // that map anyway. The two sources are not interchangeable even now that
    // both are scoped to direct children (#1222): collectDirectTextParams skips
    // an unnamed or element-valued parameter, getParamValue reads its text.
    // Read `=== 'true'` rather than testing for presence: Confluence DC omits
    // the parameter entirely on a collapsed section and no `false` spelling was
    // observed, so presence-testing would misread a hand-authored
    // `expanded=false` as open.
    if (EXPANDED_PARAM_MACROS.has(macroName)) {
      if (extraParams.expanded === 'true') details.setAttribute('open', '');
      delete extraParams.expanded;
    }
    if (Object.keys(extraParams).length > 0) {
      details.setAttribute('data-macro-params', JSON.stringify(extraParams));
    }
    // The <summary> is appended unconditionally even when it is empty. The
    // TipTap `Details` node declares `content: 'detailsSummary block*'`, so a
    // summary-less <details> cannot parse as written: the body is lifted out
    // and left as a sibling of an emptied section, in the read view as much as
    // the editor. Every <details> this codebase produces carries a <summary>.
    const summary = doc.createElement('summary');
    summary.textContent = title ?? '';
    details.appendChild(summary);
    if (bodyEl) {
      // Move children directly to avoid nesting extra <div> on each round-trip
      const fragment = doc.createDocumentFragment();
      while (bodyEl.firstChild) {
        fragment.appendChild(bodyEl.firstChild);
      }
      details.appendChild(fragment);
    }
    macro.replaceWith(details);
  }

  // Process Confluence links: ac:link -> <a>
  for (const link of byTag(doc, 'ac:link')) {
    // #1953: the stamp is taken before anything of the link is read.
    const source = takeCarrierSource(link, carriers, 'link');
    // PR #314 finding #2: `<ac:link><ri:user .../></ac:link>` is the canonical
    // Confluence on-disk shape for a user mention — AND it is the shape
    // produced by our own `htmlToConfluence` reverse path. If we process this
    // `ac:link` as a generic link we emit `<a></a>` and the ri:user handler
    // below never sees the element (the replaceWith removed it). Detect the
    // nested ri:user and unwrap the link — leave the ri:user in place so the
    // dedicated ri:user handler further down converts it to a mention span.
    const userRef = byTag(link, 'ri:user')[0];
    if (userRef) {
      link.replaceWith(userRef);
      continue;
    }

    // #1748, #1955: a link to a page, an attachment, an anchor, a blog post,
    // a space, a shortcut, a content entity or a URL becomes an <a> that
    // carries the whole link (confluence-link.ts), since the editor keeps no
    // data-* attribute of a link.
    const legacy = source !== null ? legacyLinkShape(link) : null;
    const replacement = carriers
      ? confluenceLinkAnchor(link, features, (count) => { carriers.dropped += count; })
      : confluenceLinkAnchor(link, features);
    if (replacement) {
      if (witness) witnessEmittedLink(witness, link, replacement[0] as Element);
      if (legacy) markCarrier(replacement[0] as Element, carriers!, { k: 'link', n: source!, ...legacy });
      link.replaceWith(...replacement);
      continue;
    }

    // Any other link — another resource, or a primary value that is missing
    // or that no href can carry: its text only.
    const bodyEl = byTag(link, 'ac:link-body')[0] ?? byTag(link, 'ac:plain-text-link-body')[0];
    const a = doc.createElement('a');
    if (bodyEl && bodyEl.tagName.toLowerCase() === 'ac:link-body') {
      transferInnerHtml(a, bodyEl);
    } else {
      a.textContent = bodyEl?.textContent ?? '';
    }
    link.replaceWith(a);
  }

  // Process images: ac:image -> <img>
  for (const image of byTag(doc, 'ac:image')) {
    const attachRef = byTag(image, 'ri:attachment')[0];
    const urlRef = byTag(image, 'ri:url')[0];

    const img = doc.createElement('img');
    if (attachRef) {
      const source = getAttachmentImageSource(attachRef, spaceKey);
      if (!source) {
        image.replaceWith(img);
        continue;
      }
      const localFilename = getLocalFilenameForImageSource(source);
      if (pageId) {
        img.src = `/api/attachments/${pageId}/${encodeURIComponent(localFilename)}`;
      } else {
        img.src = `#attachment:${localFilename}`;
      }
      img.alt = source.attachmentFilename;
      img.setAttribute('data-confluence-image-source', 'attachment');
      img.setAttribute('data-confluence-filename', source.attachmentFilename);
      if (source.sourcePageTitle) {
        img.setAttribute('data-confluence-owner-page-title', source.sourcePageTitle);
      }
      if (source.sourceSpaceKey) {
        img.setAttribute('data-confluence-owner-space-key', source.sourceSpaceKey);
      }
    } else if (urlRef) {
      const url = urlRef.getAttribute('ri:value') ?? '';
      const localFilename = getLocalFilenameForImageSource({
        kind: 'external-url',
        url,
      });
      if (pageId) {
        img.src = `/api/attachments/${pageId}/${encodeURIComponent(localFilename)}`;
      } else {
        img.src = url;
      }
      img.setAttribute('data-confluence-image-source', 'external-url');
      img.setAttribute('data-confluence-url', url);
      img.alt = pathBasename(url) || 'External image';
    }
    const width = image.getAttribute('ac:width');
    if (width) img.width = parseInt(width, 10);
    image.replaceWith(img);
  }

  // Process draw.io macros -> <div class="confluence-drawio">
  for (const macro of byTag(doc, 'ac:structured-macro')) {
    if (getMacroName(macro) !== 'drawio') continue;
    const diagramName = getParamValue(macro, 'diagramName') ?? 'diagram';

    const div = doc.createElement('div');
    div.className = 'confluence-drawio';
    div.setAttribute('data-diagram-name', diagramName);

    // Conversion has no attachment bytes. Do not claim a raster exists until
    // the cache-aware publication path has verified it.
    if (pageId) {
      div.setAttribute('data-drawio-source', `/api/attachments/${encodeURIComponent(pageId)}/${encodeURIComponent(`${diagramName}.drawio`)}`);
    }
    const unavailable = doc.createElement('span');
    unavailable.className = 'drawio-preview-unavailable';
    unavailable.textContent = `Draw.io preview unavailable: ${diagramName}`;
    div.appendChild(unavailable);

    const link = doc.createElement('a');
    link.className = 'drawio-edit-link';
    link.textContent = 'Edit in Confluence';
    link.href = '#';
    link.setAttribute('data-drawio', 'true');
    div.appendChild(link);

    macro.replaceWith(div);
  }

  // Process status macros: ac:structured-macro[name=status] -> <span class="confluence-status">
  for (const macro of byTag(doc, 'ac:structured-macro')) {
    if (getMacroName(macro) !== 'status') continue;
    const source = takeCarrierSource(macro, carriers, 'macro.status');
    const colour = (getParamValue(macro, 'colour') ?? 'Grey').toLowerCase();
    const title = getParamValue(macro, 'title') ?? '';
    const span = doc.createElement('span');
    span.className = 'confluence-status';
    span.setAttribute('data-color', colour);
    // #1749: `colour` and `title` keep their homes; every other direct text
    // parameter (`subtle`, …) rides in `data-macro-params`.
    const params = collectDirectTextParams(macro);
    delete params.colour;
    delete params.title;
    if (Object.keys(params).length > 0) {
      span.setAttribute('data-macro-params', JSON.stringify(params));
    }
    span.textContent = title;
    macro.replaceWith(span);
    if (source !== null) markCarrier(span, carriers!, { k: 'macro.status', n: source });
  }

  // Process table of contents macro -> placeholder, preserving key params
  // (#300). Common TOC params — `maxLevel`, `minLevel`, `outline`, `style`,
  // `type` — are round-tripped as data attributes so htmlToConfluence can
  // rebuild the macro losslessly; every other direct text parameter
  // (`exclude`, `include`, `indent`, `separator`, `class`, …) rides in
  // `data-macro-params` (#1749).
  const tocParamNames = ['maxLevel', 'minLevel', 'outline', 'style', 'type', 'printable', 'absoluteUrl'];
  for (const macro of byTag(doc, 'ac:structured-macro')) {
    if (getMacroName(macro) !== 'toc') continue;
    const source = takeCarrierSource(macro, carriers, 'macro.toc');
    const div = doc.createElement('div');
    div.className = 'confluence-toc';
    div.textContent = '[Table of Contents]';
    const params = collectDirectTextParams(macro);
    for (const paramName of tocParamNames) {
      const val = getParamValue(macro, paramName);
      if (val !== null && val !== undefined) {
        div.setAttribute(`data-${paramName.toLowerCase()}`, val);
        delete params[paramName];
      }
    }
    if (Object.keys(params).length > 0) {
      div.setAttribute('data-macro-params', JSON.stringify(params));
    }
    macro.replaceWith(div);
    if (source !== null) markCarrier(div, carriers!, { k: 'macro.toc', n: source });
  }

  // Process JIRA issue macro -> link placeholder (#300). Preserves the
  // issue key + optional server-id + display mode so the reverse step can
  // rebuild the macro exactly. If the original macro lists multiple keys
  // (`ac:parameter[name=key]` with comma-separated values) we keep them
  // all in data-keys and show the first as the visible link text.
  for (const macro of byTag(doc, 'ac:structured-macro')) {
    if (getMacroName(macro) !== 'jira') continue;
    const issueKey = getParamValue(macro, 'key') ?? '';
    const serverId = getParamValue(macro, 'serverId');
    const server = getParamValue(macro, 'server');
    const columns = getParamValue(macro, 'columns');
    const displayMode = getParamValue(macro, 'display');
    const span = doc.createElement('span');
    span.className = 'confluence-jira-issue';
    span.setAttribute('data-key', issueKey);
    if (serverId) span.setAttribute('data-server-id', serverId);
    if (server) span.setAttribute('data-server', server);
    if (columns) span.setAttribute('data-columns', columns);
    if (displayMode) span.setAttribute('data-display', displayMode);
    // Visible label: [JIRA: KEY] — LLMs and Markdown can keep this text verbatim
    span.textContent = issueKey ? `[JIRA: ${issueKey}]` : '[JIRA]';
    macro.replaceWith(span);
  }

  // Process include-page / excerpt-include macros -> placeholder div (#300).
  // Stores the referenced page title + space key so the reverse step can
  // rebuild the `<ri:page>` link exactly. If the reference page no longer
  // exists on re-import, Confluence shows its own "missing page" message.
  for (const macro of byTag(doc, 'ac:structured-macro')) {
    const name = getMacroName(macro);
    if (name !== 'include' && name !== 'excerpt-include') continue;
    // Confluence stores the referenced page inside:
    //   <ac:parameter><ri:page ri:content-title="..." ri:space-key="..."/></ac:parameter>
    // The parameter name is often omitted so we walk `ri:page` directly.
    const riPage = byTag(macro, 'ri:page')[0];
    const pageTitle = riPage?.getAttribute('ri:content-title') ?? '';
    const spaceKey = riPage?.getAttribute('ri:space-key') ?? '';
    const div = doc.createElement('div');
    div.className = 'confluence-include-macro';
    div.setAttribute('data-macro-name', name);
    if (pageTitle) div.setAttribute('data-page-title', pageTitle);
    if (spaceKey) div.setAttribute('data-space-key', spaceKey);
    div.textContent = pageTitle
      ? `[${name === 'excerpt-include' ? 'Excerpt' : 'Include'}: ${pageTitle}]`
      : `[${name === 'excerpt-include' ? 'Excerpt' : 'Include'}]`;
    macro.replaceWith(div);
  }

  // Process column macros FIRST (inside-out: columns before sections)
  for (const macro of byTag(doc, 'ac:structured-macro')) {
    if (getMacroName(macro) !== 'column') continue;
    const width = getParamValue(macro, 'width');
    const bodyEl = byTag(macro, 'ac:rich-text-body')[0];
    const div = doc.createElement('div');
    div.className = 'confluence-column';
    if (width) {
      div.setAttribute('data-cell-width', width);
      // Only allow safe CSS width values (digits + unit) to prevent style injection
      const safeWidth = /^\d+(%|px|em|rem)$/.test(width) ? width : undefined;
      if (safeWidth) {
        div.setAttribute('style', `flex: 0 0 ${safeWidth}`);
      }
    }
    transferInnerHtml(div, bodyEl);
    macro.replaceWith(div);
  }

  // Process section macros AFTER columns (outside-in: sections wrap columns)
  for (const macro of byTag(doc, 'ac:structured-macro')) {
    if (getMacroName(macro) !== 'section') continue;
    const border = getParamValue(macro, 'border');
    const bodyEl = byTag(macro, 'ac:rich-text-body')[0];
    const div = doc.createElement('div');
    div.className = 'confluence-section';
    if (border) div.setAttribute('data-border', border);
    transferInnerHtml(div, bodyEl);
    macro.replaceWith(div);
  }

  // Process children / ui-children display macro -> placeholder div, preserving all params
  const childrenParamNames = ['sort', 'reverse', 'depth', 'first', 'page', 'style', 'excerptType', 'columns'];
  for (const macro of byTag(doc, 'ac:structured-macro')) {
    const macroName = getMacroName(macro);
    if (macroName !== 'children' && macroName !== 'ui-children') continue;
    const div = doc.createElement('div');
    div.className = 'confluence-children-macro';
    div.setAttribute('data-macro-name', macroName);
    div.textContent = '[Children pages listed here]';
    for (const paramName of childrenParamNames) {
      const val = getParamValue(macro, paramName);
      if (val !== null && val !== undefined) div.setAttribute(`data-${paramName}`, val);
    }
    macro.replaceWith(div);
  }

  // Process attachments macro -> placeholder div, preserving upload/old params
  for (const macro of byTag(doc, 'ac:structured-macro')) {
    if (getMacroName(macro) !== 'attachments') continue;
    const upload = getParamValue(macro, 'upload') ?? 'false';
    const old = getParamValue(macro, 'old') ?? 'false';
    const div = doc.createElement('div');
    div.className = 'confluence-attachments-macro';
    div.setAttribute('data-upload', upload);
    div.setAttribute('data-old', old);
    div.textContent = '[Attachments]';
    macro.replaceWith(div);
  }

  // Process layout macros: ac:layout / ac:layout-section / ac:layout-cell -> grid divs
  // Process inside-out: cells first, then sections, then layout wrapper.
  for (const cell of byTag(doc, 'ac:layout-cell')) {
    const div = doc.createElement('div');
    div.className = 'confluence-layout-cell';
    transferInnerHtml(div, cell);
    cell.replaceWith(div);
  }
  for (const section of byTag(doc, 'ac:layout-section')) {
    const layoutType = section.getAttribute('ac:type') ?? 'single';
    const div = doc.createElement('div');
    div.className = 'confluence-layout-section';
    div.setAttribute('data-layout-type', layoutType);
    transferInnerHtml(div, section);
    section.replaceWith(div);
  }
  for (const layout of byTag(doc, 'ac:layout')) {
    const div = doc.createElement('div');
    div.className = 'confluence-layout';
    transferInnerHtml(div, layout);
    layout.replaceWith(div);
  }

  // Labels macro (#348 → #765). Label *metadata* still comes exclusively from
  // expand=metadata.labels — never parse label names out of the body. But the
  // macro itself must round-trip: #348 dropped it outright, which was safe
  // when nothing pushed bodies back to Confluence. Now that AI-Improve apply
  // and editor saves DO push the converted body back, dropping the macro here
  // would permanently delete the in-body labels widget from the Confluence
  // page on the first write-back (#765). Keep it as a placeholder instead,
  // mirroring the toc/children pattern.
  const labelsParamNames = ['max', 'spaces', 'excludedLabels', 'showLabels'];
  for (const macro of byTag(doc, 'ac:structured-macro')) {
    if (getMacroName(macro) !== 'labels') continue;
    const div = doc.createElement('div');
    div.className = 'confluence-labels-macro';
    for (const paramName of labelsParamNames) {
      const val = getParamValue(macro, paramName);
      if (val !== null && val !== undefined) div.setAttribute(`data-${paramName.toLowerCase()}`, val);
    }
    div.textContent = '[Labels]';
    macro.replaceWith(div);
  }

  // Remaining unknown macros — preserve as a placeholder div so the reverse
  // pass (htmlToConfluence) can rebuild the ac:structured-macro on write-back.
  // Dropping the macro here (or emitting a plain <div>) would permanently
  // delete it from the Confluence page on the first editor save / AI-Improve
  // apply / draft publish / version restore — exactly the #765 hazard, now
  // fixed for ALL unhandled macros (excerpt, anchor, gallery, chart, …) (#865).
  for (const macro of byTag(doc, 'ac:structured-macro')) {
    const name = getMacroName(macro) || 'unknown';
    // Replacement reparses an outer body into fresh nodes. A fresh supported
    // clone must remain raw for its next dedicated pass; a fresh unknown clone
    // can safely take the lossless long-tail fallback immediately.
    if (!macrosAtPassStart.has(macro) && Object.hasOwn(DEDICATED_MACRO_NAMES, name)) continue;
    const bodyEl = byTag(macro, 'ac:rich-text-body')[0];

    const div = doc.createElement('div');
    div.className = 'confluence-macro-unknown';
    div.setAttribute('data-macro-name', name);
    // Persist the macro's parameters generically (arbitrary names) as a single
    // JSON attribute so a param-only macro doesn't round-trip as an empty shell.
    const params = collectDirectTextParams(macro);
    if (Object.keys(params).length > 0) {
      div.setAttribute('data-macro-params', JSON.stringify(params));
    }
    transferInnerHtml(div, bodyEl, `[Confluence macro: ${name}]`);
    macro.replaceWith(div);
  }

  // Preserve user mentions as <span class="confluence-user-mention"> (#300).
  // Confluence stores mentions as `<ri:user ri:username="alice"/>` OR
  // `<ri:user ri:userkey="<opaque>"/>` (for deleted / renamed accounts).
  // Previously stripped silently; now round-tripped so `htmlToConfluence`
  // can rebuild them.
  for (const el of byTag(doc, 'ri:user')) {
    const username = el.getAttribute('ri:username');
    const userkey = el.getAttribute('ri:userkey');
    const span = el.ownerDocument.createElement('span');
    span.className = 'confluence-user-mention';
    if (username) span.setAttribute('data-username', username);
    if (userkey) span.setAttribute('data-userkey', userkey);
    span.textContent = username ? `@${username}` : '@<user>';
    el.replaceWith(span);
  }

  // Emoticons -> <span class="confluence-emoticon"> (#1750): every attribute
  // rides in data-emoticon-attrs, the text is a display label
  // (emoticonPlaceholder). An emoticon whose self-closing tag the expansion
  // above could not match (an attribute value holding `/`) was parsed as an
  // open element and swallowed the content after it; that content moves back
  // out behind the placeholder instead of being deleted with the element.
  for (const el of byTag(doc, 'ac:emoticon')) {
    // #1953: the stamp is taken before emoticonPlaceholder copies the element's attributes.
    const source = takeCarrierSource(el, carriers, 'emoticon');
    const span = emoticonPlaceholder(el);
    if (source !== null) markCarrier(span, carriers!, { k: 'emoticon', n: source });
    el.replaceWith(span, ...el.childNodes);
  }

  const html = doc.body.innerHTML;
  const macrosAfter = countRawStructuredMacros(doc.body);
  return { html, macrosBefore, macrosAfter };
}

/**
 * Converts clean HTML back to Confluence storage format.
 * Reverses the conversions done by confluenceToHtml.
 */
export function htmlToConfluence(html: string, options: HtmlToConfluenceOptions = {}): string {
  const dom = new JSDOM(`<body>${html}</body>`, { contentType: 'text/html' });
  const doc = dom.window.document;

  // Strip auto-generated index blocks before export to Confluence (#13)
  for (const div of doc.querySelectorAll('div.figure-index, div.table-index')) {
    div.remove();
  }

  // Convert code blocks back. #1749: the language class, the `data-title`
  // title, then whatever `data-macro-params` carries besides those two.
  for (const pre of doc.querySelectorAll('pre')) {
    const codeEl = pre.querySelector('code');
    if (!codeEl) continue;

    const language = (codeEl.className.match(CODE_LANGUAGE_CLASS) ?? [])[1] ?? '';
    const title = pre.getAttribute('data-title') ?? '';
    const code = codeEl.textContent ?? '';

    const macro = doc.createElement('ac:structured-macro');
    macro.setAttribute('ac:name', 'code');
    const emitted = new Set<string>();

    if (language) {
      const param = doc.createElement('ac:parameter');
      param.setAttribute('ac:name', 'language');
      param.textContent = language;
      macro.appendChild(param);
      emitted.add('language');
    }
    if (title) {
      const param = doc.createElement('ac:parameter');
      param.setAttribute('ac:name', 'title');
      param.textContent = title;
      macro.appendChild(param);
      emitted.add('title');
    }
    appendSerializedMacroParams(macro, pre.getAttribute('data-macro-params'), emitted);

    const body = doc.createElement('ac:plain-text-body');
    body.textContent = code;
    macro.appendChild(body);

    pre.replaceWith(macro);
  }

  // Convert task lists back — innermost-first (#1220). Every macro body below
  // is rebuilt by re-parsing the element's innerHTML (transferInnerHtml), which
  // produces FRESH nodes, while the querySelectorAll snapshot driving the loop
  // is static: converting an outer placeholder before a nested one of the same
  // class leaves the inner element behind in the discarded original subtree
  // (still in the snapshot, no longer in the document) while its live clone in
  // the new body was never in the snapshot at all. querySelectorAll returns
  // document order (outer before inner), so iterating it reversed converts each
  // inner element in place first and the outer's later re-parse copies an
  // already-converted, inert ac: element. Same fix shape as the <details> loop
  // below (#1216); see it for the reachability argument.
  //
  // Task lists corrupt rather than leak: the inner li query below is unscoped,
  // so an outer-first pass ALSO matched the nested items and hoisted them into
  // sibling ac:task elements — the subtask shipped twice, once as a literal
  // <ul> inside the outer task body and once as a sibling. Innermost-first the
  // nested <ul> is already an ac:task-list by the time the outer runs, so the
  // query no longer finds its items. The producer is the EDITOR, not the sync:
  // TipTap's TaskItem runs `nested: true` (Editor.tsx, ArticleViewer.tsx), so
  // Tab on a task creates exactly this HTML — which is what makes it the most
  // reachable shape of the set. A subtask coming *from* Confluence never
  // arrives here in this shape: the forward pass has the mirror-image
  // stale-snapshot bug and hands over an already-duplicated list (pre-existing,
  // unchanged by #1220, out of its scope).
  //
  // #1751: each task keeps its carried id, takes a stored one or gets the next
  // free one (allocateTaskIds, decided in document order before this loop), and
  // its body is the task's content without the editor's checkbox (taskItemContent).
  const { idFor: taskIdFor } = allocateTaskIds(doc, options);
  for (const ul of [...doc.querySelectorAll('ul[data-type="taskList"]')].reverse()) {
    const taskList = doc.createElement('ac:task-list');

    for (const li of ul.querySelectorAll('li[data-type="taskItem"]')) {
      const task = doc.createElement('ac:task');
      const taskId = doc.createElement('ac:task-id');
      taskId.textContent = taskIdFor(li);
      const taskStatus = doc.createElement('ac:task-status');
      taskStatus.textContent = li.getAttribute('data-checked') === 'true' ? 'complete' : 'incomplete';
      const taskBody = doc.createElement('ac:task-body');
      transferInnerHtml(taskBody, taskItemContent(li));

      task.appendChild(taskId);
      task.appendChild(taskStatus);
      task.appendChild(taskBody);
      taskList.appendChild(task);
    }

    ul.replaceWith(taskList);
  }

  // Convert panels back — innermost-first (#1220), per the stale-snapshot
  // reasoning on the task-list loop above; panel-in-panel is schema-legal in
  // the editor and reachable from improve-apply, which feeds model-produced
  // HTML through here with no tag allow-list. Cross-TYPE nesting (an info panel
  // around a warning one) has a second, independent guarantee: each type takes
  // its OWN fresh snapshot after the previous type's re-parses, so a clone an
  // earlier type created is still found by a later one. Collapsing the four
  // selectors into one (`.panel-info, .panel-warning, …`, deriving the type per
  // element) removes that guarantee and leaves this reversal as the only thing
  // keeping cross-type nesting intact — hence the regression pins in the tests.
  for (const panelType of ['info', 'warning', 'note', 'tip']) {
    for (const div of [...doc.querySelectorAll(`.panel-${panelType}`)].reverse()) {
      const macro = doc.createElement('ac:structured-macro');
      const macroName = div.getAttribute('data-macro-name') || panelType;
      macro.setAttribute('ac:name', macroName);
      appendSerializedMacroParams(macro, div.getAttribute('data-macro-params'));
      const body = doc.createElement('ac:rich-text-body');
      transferInnerHtml(body, div);
      macro.appendChild(body);
      div.replaceWith(macro);
    }
  }

  // Convert expand sections back — innermost-first. The snapshot below is
  // static while each macro body is rebuilt by re-parsing the element's
  // innerHTML (transferInnerHtml), so converting an outer <details> before a
  // nested one would copy the still-raw inner element into the new body — a
  // copy the snapshot never visits — and ship a literal HTML5 <details> to
  // Confluence inside the storage XHTML. querySelectorAll returns document
  // order (outer before inner), so iterating it reversed converts each inner
  // section in place first; the outer's later re-parse then copies an
  // already-converted, inert ac:structured-macro. Confluence supports
  // expand-inside-expand natively, so this nesting is reachable from sync.
  for (const details of [...doc.querySelectorAll('details')].reverse()) {
    // Direct child only: an unscoped querySelector('summary') would let a
    // summary-less outer section steal (and delete) a nested section's
    // summary as its own title.
    const summary = [...details.children].find(
      (el) => el.tagName.toLowerCase() === 'summary',
    );
    const macro = doc.createElement('ac:structured-macro');
    // #1211: carry the macro identity the forward pass stamped. Absent →
    // `expand` is safe: the native expand branch was the only producer of a
    // <details> when the stamp was introduced (so every stored body_html
    // predating it genuinely is one), and editor-created sections carry no attribute
    // either. An unrecognised value is passed through, never coerced —
    // coercion is precisely the silent-rewrite bug this exists to prevent,
    // and passthrough grants nothing new: the #865 unknown-macro net already
    // round-trips arbitrary data-macro-name values.
    const macroName = details.getAttribute('data-macro-name') || 'expand';
    macro.setAttribute('ac:name', macroName);

    // #1227: decide on the summary's TEXT, not on the summary's existence.
    // The forward pass now emits an empty <summary> for an untitled section
    // (it must emit one — see the schema note there), so "there is a summary"
    // no longer means "there is a title", and treating it as one fabricated a
    // `title` parameter on every untitled section that made the round-trip.
    // Trimmed, so a whitespace-only summary counts as untitled; the parameter
    // carries the UNtrimmed text, since a real title's own spacing is the
    // user's.
    const summaryText = summary?.textContent ?? '';
    const hasTitle = summaryText.trim() !== '';
    if (hasTitle) {
      const param = doc.createElement('ac:parameter');
      param.setAttribute('ac:name', 'title');
      param.textContent = summaryText;
      macro.appendChild(param);
    }
    // Removal is unconditional wherever a summary exists: <summary> is an
    // HTML5 element with no place in Confluence storage format, whether or not
    // it carried a title.
    summary?.remove();

    // #1129: rebuild the default-open parameter from the `open` attribute, its
    // single source of truth (the forward pass consumed the parameter into it).
    // Emitted only when open: Confluence DC omits `expanded` entirely on a
    // collapsed section rather than writing `expanded=false`, so emitting one
    // would hand every collapsed section a parameter it never had. Macros
    // outside EXPANDED_PARAM_MACROS get nothing — the editor forces every
    // <details> open in edit mode and its summary click handler writes the
    // attribute, so `open` on a native expand is reachable and must stay inert.
    if (EXPANDED_PARAM_MACROS.has(macroName) && details.hasAttribute('open')) {
      const param = doc.createElement('ac:parameter');
      param.setAttribute('ac:name', 'expanded');
      param.textContent = 'true';
      macro.appendChild(param);
    }

    // Any <summary> still in the subtree (wrapped in another element, or a
    // second sibling) is not this section's title per the direct-child rule
    // above — but it must not ship to Confluence as a literal HTML5 element
    // either. Improve-apply feeds model-produced markdown through this
    // function with no tag allow-list, so the shape is reachable without the
    // editor. Unwrap it: the text belongs to the body, only the tag is
    // invalid. Nested sections' summaries are already gone here — the loop
    // runs innermost-first, so they were consumed by their own iteration.
    for (const stray of details.querySelectorAll('summary')) {
      stray.replaceWith(...stray.childNodes);
    }

    // Re-emit parameters persisted by the forward pass (mirrors the
    // unknown-macro handler below). A `title` key is skipped when the summary
    // provided the parameter above — the summary is its source of truth. So is
    // an `expanded` key on a macro that keeps that state in `open` (#1129): the
    // forward pass never writes one, but a stale copy from hand-edited or
    // pre-#1129 HTML must not resurrect a section the user has since closed.
    //
    // #1227: the `title` key is consulted EXACTLY when the summary is blank —
    // which is why this is not the marker-attribute approach the issue rejected.
    // There, a declared attribute survived a text edit verbatim and discarded
    // the title the user had just typed; here the user's own text always wins,
    // and the marker is unreachable while any is present. And it is honoured
    // only for `''`, the one value the summary cannot carry: a stale non-empty
    // `title` in the map — hand-edited or legacy HTML — must not resurrect a
    // title the user has just cleared.
    const rawParams = details.getAttribute('data-macro-params');
    if (rawParams) {
      try {
        const params = JSON.parse(rawParams) as Record<string, unknown>;
        for (const [paramName, paramValue] of Object.entries(params)) {
          if (typeof paramValue !== 'string') continue;
          if (paramName === 'title' && (hasTitle || paramValue !== '')) continue;
          if (paramName === 'expanded' && EXPANDED_PARAM_MACROS.has(macroName)) continue;
          const p = doc.createElement('ac:parameter');
          p.setAttribute('ac:name', paramName);
          p.textContent = paramValue;
          macro.appendChild(p);
        }
      } catch {
        // Malformed params attribute — preserve the macro without them rather
        // than fail the whole write-back.
      }
    }

    const body = doc.createElement('ac:rich-text-body');
    transferInnerHtml(body, details);
    macro.appendChild(body);
    details.replaceWith(macro);
  }

  // Convert section divs back to ac:structured-macro[name=section] (sections
  // before columns), each snapshot innermost-first (#1220) per the stale-snapshot
  // reasoning on the task-list loop above. BOTH this loop and the columns loop
  // below must be reversed: `section > column > section > column` (schema-legal
  // in the editor) leaks the whole inner subtree if either one still runs
  // outside-in, because the outer section's re-parse clones the outer column,
  // which an outside-in columns loop then clones again.
  for (const div of [...doc.querySelectorAll('div.confluence-section')].reverse()) {
    const macro = doc.createElement('ac:structured-macro');
    macro.setAttribute('ac:name', 'section');
    const border = div.getAttribute('data-border');
    if (border) {
      const param = doc.createElement('ac:parameter');
      param.setAttribute('ac:name', 'border');
      param.textContent = border;
      macro.appendChild(param);
    }
    const body = doc.createElement('ac:rich-text-body');
    transferInnerHtml(body, div);
    macro.appendChild(body);
    div.replaceWith(macro);
  }

  // Convert column divs back to ac:structured-macro[name=column] (inside
  // sections), innermost-first (#1220) — the second half of the pair described
  // on the sections loop above.
  for (const div of [...doc.querySelectorAll('div.confluence-column')].reverse()) {
    const macro = doc.createElement('ac:structured-macro');
    macro.setAttribute('ac:name', 'column');
    // Prefer data-cell-width; fall back to extracting width from inline style
    let width = div.getAttribute('data-cell-width');
    if (!width) {
      const styleAttr = div.getAttribute('style') ?? '';
      const m = styleAttr.match(/flex:\s*0\s+0\s+(\S+)/);
      if (m) width = m[1] ?? null;
    }
    if (width) {
      const param = doc.createElement('ac:parameter');
      param.setAttribute('ac:name', 'width');
      param.textContent = width;
      macro.appendChild(param);
    }
    const body = doc.createElement('ac:rich-text-body');
    transferInnerHtml(body, div);
    macro.appendChild(body);
    div.replaceWith(macro);
  }

  // Convert children / ui-children macro placeholders back to ac:structured-macro
  const childrenRoundTripParams = ['sort', 'reverse', 'depth', 'first', 'page', 'style', 'excerptType', 'columns'];
  for (const div of doc.querySelectorAll('div.confluence-children-macro')) {
    const macro = doc.createElement('ac:structured-macro');
    const originalName = div.getAttribute('data-macro-name') || 'children';
    macro.setAttribute('ac:name', originalName);
    for (const paramName of childrenRoundTripParams) {
      const val = div.getAttribute(`data-${paramName}`);
      if (val !== null) {
        const p = doc.createElement('ac:parameter');
        p.setAttribute('ac:name', paramName);
        p.textContent = val;
        macro.appendChild(p);
      }
    }
    div.replaceWith(macro);
  }

  // Convert attachments macro placeholder back to ac:structured-macro[name=attachments]
  for (const div of doc.querySelectorAll('div.confluence-attachments-macro')) {
    const macro = doc.createElement('ac:structured-macro');
    macro.setAttribute('ac:name', 'attachments');
    const upload = div.getAttribute('data-upload');
    const old = div.getAttribute('data-old');
    if (upload && upload !== 'false') {
      const param = doc.createElement('ac:parameter');
      param.setAttribute('ac:name', 'upload');
      param.textContent = upload;
      macro.appendChild(param);
    }
    if (old && old !== 'false') {
      const param = doc.createElement('ac:parameter');
      param.setAttribute('ac:name', 'old');
      param.textContent = old;
      macro.appendChild(param);
    }
    div.replaceWith(macro);
  }

  // Convert labels macro placeholders back to ac:structured-macro[name=labels]
  // (#765) so write-back doesn't delete the widget from the Confluence page.
  for (const div of doc.querySelectorAll('div.confluence-labels-macro')) {
    const macro = doc.createElement('ac:structured-macro');
    macro.setAttribute('ac:name', 'labels');
    const labelsReverseParams: Record<string, string> = {
      'max': 'max',
      'spaces': 'spaces',
      'excludedlabels': 'excludedLabels',
      'showlabels': 'showLabels',
    };
    for (const [dataAttr, paramName] of Object.entries(labelsReverseParams)) {
      const val = div.getAttribute(`data-${dataAttr}`);
      if (val !== null) {
        const p = doc.createElement('ac:parameter');
        p.setAttribute('ac:name', paramName);
        p.textContent = val;
        macro.appendChild(p);
      }
    }
    div.replaceWith(macro);
  }

  // Convert unknown-macro placeholders back to their original
  // ac:structured-macro (#865) so write-back doesn't permanently delete the
  // macro from the Confluence page. Mirrors the #765 labels handler above.
  //
  // Innermost-first (#1220) per the stale-snapshot reasoning on the task-list
  // loop — the shape this matters most for, since a third-party macro whose
  // rich-text body holds another unrecognised macro is ordinary Confluence
  // content. Reverse order also feeds the isPlaceholderOnly check below a
  // truer reading: a nested macro is an inert ac: element by then, contributing
  // no text, where outside-in an outer macro containing only a body-less nested
  // one of the same name read as placeholder-only and dropped it entirely.
  for (const div of [...doc.querySelectorAll('div.confluence-macro-unknown')].reverse()) {
    const name = div.getAttribute('data-macro-name') || 'unknown';
    const macro = doc.createElement('ac:structured-macro');
    macro.setAttribute('ac:name', name);

    appendSerializedMacroParams(macro, div.getAttribute('data-macro-params'));

    // Restore the rich-text-body. The forward pass only writes the
    // `[Confluence macro: {name}]` placeholder (see the fallback in the
    // forward unknown-macro handler) when the source macro had NO
    // rich-text-body, so treat that exact text as a body-less macro and emit
    // it without a bogus body. The TipTap editor re-serializes the fabricated
    // placeholder wrapped in a single block (e.g. `<p>[Confluence macro:
    // anchor]</p>`), so match on the div's trimmed textContent rather than
    // requiring zero element children — otherwise the fabricated placeholder
    // string gets pushed upstream into Confluence as a real body. A div with
    // genuine content still round-trips to an ac:rich-text-body.
    const placeholder = `[Confluence macro: ${name}]`;
    const isPlaceholderOnly = (div.textContent ?? '').trim() === placeholder;
    if (!isPlaceholderOnly) {
      const body = doc.createElement('ac:rich-text-body');
      transferInnerHtml(body, div);
      macro.appendChild(body);
    }

    div.replaceWith(macro);
  }

  // Convert TOC placeholders back to ac:structured-macro[name=toc] (#300).
  // Mirrors the forward pass — the data-* attributes round-trip as macro
  // parameters. Confluence regenerates the visible table on import.
  for (const div of doc.querySelectorAll('div.confluence-toc')) {
    const macro = doc.createElement('ac:structured-macro');
    macro.setAttribute('ac:name', 'toc');
    const tocReverseParams: Record<string, string> = {
      'maxlevel': 'maxLevel',
      'minlevel': 'minLevel',
      'outline': 'outline',
      'style': 'style',
      'type': 'type',
      'printable': 'printable',
      'absoluteurl': 'absoluteUrl',
    };
    const emitted = new Set<string>();
    for (const [dataAttr, paramName] of Object.entries(tocReverseParams)) {
      const val = div.getAttribute(`data-${dataAttr}`);
      if (val !== null) {
        const p = doc.createElement('ac:parameter');
        p.setAttribute('ac:name', paramName);
        p.textContent = val;
        macro.appendChild(p);
        emitted.add(paramName);
      }
    }
    appendSerializedMacroParams(macro, div.getAttribute('data-macro-params'), emitted);
    div.replaceWith(macro);
  }

  // Convert JIRA issue placeholders back to ac:structured-macro[name=jira] (#300).
  for (const span of doc.querySelectorAll('span.confluence-jira-issue')) {
    const macro = doc.createElement('ac:structured-macro');
    macro.setAttribute('ac:name', 'jira');
    const paramPairs: Array<[string, string]> = [
      ['data-key', 'key'],
      ['data-server-id', 'serverId'],
      ['data-server', 'server'],
      ['data-columns', 'columns'],
      ['data-display', 'display'],
    ];
    for (const [dataAttr, paramName] of paramPairs) {
      const val = span.getAttribute(dataAttr);
      if (val) {
        const p = doc.createElement('ac:parameter');
        p.setAttribute('ac:name', paramName);
        p.textContent = val;
        macro.appendChild(p);
      }
    }
    span.replaceWith(macro);
  }

  // Convert include / excerpt-include placeholders back to ac:structured-macro (#300).
  for (const div of doc.querySelectorAll('div.confluence-include-macro')) {
    const macro = doc.createElement('ac:structured-macro');
    const originalName = div.getAttribute('data-macro-name') || 'include';
    macro.setAttribute('ac:name', originalName);
    const pageTitle = div.getAttribute('data-page-title');
    const spaceKey = div.getAttribute('data-space-key');
    // Confluence wraps the page reference inside <ac:parameter><ri:page …/></ac:parameter>.
    // The source form omits ac:name on this anonymous parameter — match that
    // exactly rather than emit ac:name="" (PR #314 finding #3).
    if (pageTitle) {
      const param = doc.createElement('ac:parameter');
      const riPage = doc.createElement('ri:page');
      riPage.setAttribute('ri:content-title', pageTitle);
      if (spaceKey) riPage.setAttribute('ri:space-key', spaceKey);
      param.appendChild(riPage);
      macro.appendChild(param);
    }
    div.replaceWith(macro);
  }

  // Convert user-mention spans back to <ri:user> (#300). Prefer username
  // since it's human-readable; fall back to the opaque userkey for
  // renamed / deleted accounts.
  for (const span of doc.querySelectorAll('span.confluence-user-mention')) {
    const username = span.getAttribute('data-username');
    const userkey = span.getAttribute('data-userkey');
    const riUser = doc.createElement('ri:user');
    if (username) riUser.setAttribute('ri:username', username);
    if (userkey) riUser.setAttribute('ri:userkey', userkey);
    // Mentions in Confluence are wrapped in `<ac:link>…</ac:link>` — wrap
    // here so they render correctly in the editor rather than as raw text.
    const acLink = doc.createElement('ac:link');
    acLink.appendChild(riUser);
    span.replaceWith(acLink);
  }

  // Convert status badges back to ac:structured-macro[name=status]. Both
  // canonical parameters are always written, so a carried copy never is (#1749).
  const statusCanonicalParams: ReadonlySet<string> = new Set(['colour', 'title']);
  for (const span of doc.querySelectorAll('span.confluence-status')) {
    const colour = span.getAttribute('data-color') ?? 'grey';
    const title = span.textContent ?? '';
    const macro = doc.createElement('ac:structured-macro');
    macro.setAttribute('ac:name', 'status');
    const colourParam = doc.createElement('ac:parameter');
    colourParam.setAttribute('ac:name', 'colour');
    colourParam.textContent = colour.charAt(0).toUpperCase() + colour.slice(1);
    const titleParam = doc.createElement('ac:parameter');
    titleParam.setAttribute('ac:name', 'title');
    titleParam.textContent = title;
    macro.appendChild(colourParam);
    macro.appendChild(titleParam);
    appendSerializedMacroParams(macro, span.getAttribute('data-macro-params'), statusCanonicalParams);
    span.replaceWith(macro);
  }

  // Convert layout divs back to ac:layout / ac:layout-section / ac:layout-cell
  // Process outside-in: layout wrapper first, then sections, then cells.
  // Deliberately NOT innermost-first like the loops above (#1220): these MOVE
  // the existing child nodes (`while (div.firstChild)`) instead of re-parsing
  // innerHTML, so a nested placeholder is carried over as the very node the
  // snapshot holds and stays reachable. No stale-snapshot exposure to fix here.
  for (const div of doc.querySelectorAll('div.confluence-layout')) {
    const layout = doc.createElement('ac:layout');
    while (div.firstChild) layout.appendChild(div.firstChild);
    div.replaceWith(layout);
  }
  for (const div of doc.querySelectorAll('div.confluence-layout-section')) {
    const layoutType = div.getAttribute('data-layout-type') ?? 'single';
    const section = doc.createElement('ac:layout-section');
    section.setAttribute('ac:type', layoutType);
    while (div.firstChild) section.appendChild(div.firstChild);
    div.replaceWith(section);
  }
  for (const div of doc.querySelectorAll('div.confluence-layout-cell')) {
    const cell = doc.createElement('ac:layout-cell');
    while (div.firstChild) cell.appendChild(div.firstChild);
    div.replaceWith(cell);
  }

  // Convert draw.io divs back to macro placeholders
  for (const div of doc.querySelectorAll('.confluence-drawio')) {
    const diagramName = div.getAttribute('data-diagram-name') ?? 'diagram';
    const macro = doc.createElement('ac:structured-macro');
    macro.setAttribute('ac:name', 'drawio');
    const param = doc.createElement('ac:parameter');
    param.setAttribute('ac:name', 'diagramName');
    param.textContent = diagramName;
    macro.appendChild(param);
    div.replaceWith(macro);
  }

  // Convert Confluence links back to ac:link (#1748). The href carries the
  // target, its attributes and when needed the body element
  // (confluence-link.ts); the body's nodes move, so the image loop below still
  // converts an image inside one. Runs after every loop that rebuilds a body
  // by re-parsing, so it sees each link where it finally sits. #1955: a
  // navigable ri:url is a real href with its carrier in the class.
  const linkKinds = derivationHas(options.derivationFeatures, 'link-kinds');
  const linkAnchors = linkKinds
    ? 'a[href^="#confluence-"], a[href][class^="#confluence-url:"]'
    : 'a[href^="#confluence-"]';
  const linkOrigin = options.linkOrigin === undefined ? options.previousStorage : options.linkOrigin;
  // One forward pass over the stored storage, when something needs it: the D19 check and the D21 fallback's `shown`.
  let stored: StoredLinkWitness | undefined;
  const storedLinks = (): StoredLinkWitness => (stored ??= witnessStoredLinks(linkOrigin!, writeBackFeatures(options)));
  /** The carriers of the outgoing links of the five #1955 kinds, checked at the end (D19). */
  const carriers: string[] = [];
  for (const a of doc.querySelectorAll(linkAnchors)) {
    const acLink = confluenceLinkElement(a, options.derivationFeatures);
    if (!acLink) continue;
    const carrier = linkKinds && linkOrigin ? confluenceLinkCarrierOf(a) : null;
    const kind = carrier === null ? undefined : parseConfluenceLinkHref(carrier)?.kind;
    if (carrier !== null && kind !== undefined && !CONFLUENCE_LINK_KINDS_1748.includes(kind)) carriers.push(carrier);
    a.replaceWith(acLink);
  }

  // Review r11, R34: the D19 check runs last (W5), so an error of a later step that is not a refusal (an
  // attachment `src` `decodeURIComponent` cannot read) never stands in for D19's typed refusal of the same write.
  let written: string;
  try {
    written = finishStorage(doc, linkOrigin, linkKinds, (element) => storedLinks().shown(element));
  } catch (error) {
    if (!(error instanceof ConfluenceStorageRefusedError)) for (const carrier of carriers) storedLinks().check(carrier);
    throw error;
  }
  // Owner decision D19, coordinator decision D20 (#1955, reviews r5 R24, r6 R25/R26): a link of a #1955 kind that
  // carries a carrier the forward pass emitted from a stored link is written with that link's XML target, or the
  // write is refused here, before any effect. It runs last so that every cheaper refusal, the work limit of the
  // `ri:url` judgement first, is decided before the forward pass over the stored storage runs (W5).
  for (const carrier of carriers) storedLinks().check(carrier);
  return written;
}

/**
 * The last steps of {@link htmlToConfluence}: attachment images and emoticons written back, then, with
 * `link-kinds`, the `ri:url` judgement on the serialised string.
 */
function finishStorage(
  doc: Document,
  linkOrigin: string | null | undefined,
  linkKinds: boolean,
  shown: (element: StorageElement) => boolean,
): string {
  // Convert images with attachment references back
  for (const img of doc.querySelectorAll('img[src^="/api/attachments/"]')) {
    const src = img.getAttribute('src') ?? '';
    const sourceType = img.getAttribute('data-confluence-image-source');
    if (sourceType === 'external-url') {
      const url = img.getAttribute('data-confluence-url') ?? '';
      const acImage = doc.createElement('ac:image');
      const riUrl = doc.createElement('ri:url');
      riUrl.setAttribute('ri:value', url);
      acImage.appendChild(riUrl);

      const width = img.getAttribute('width');
      if (width) acImage.setAttribute('ac:width', width);
      img.replaceWith(acImage);
      continue;
    }

    const filename = img.getAttribute('data-confluence-filename')
      ?? decodeURIComponent(src.split('/').pop() ?? '');

    const acImage = doc.createElement('ac:image');
    const riAttachment = doc.createElement('ri:attachment');
    riAttachment.setAttribute('ri:filename', filename);
    const ownerPageTitle = img.getAttribute('data-confluence-owner-page-title');
    const ownerSpaceKey = img.getAttribute('data-confluence-owner-space-key');
    if (ownerPageTitle) {
      const riPage = doc.createElement('ri:page');
      riPage.setAttribute('ri:content-title', ownerPageTitle);
      if (ownerSpaceKey) {
        riPage.setAttribute('ri:space-key', ownerSpaceKey);
      }
      riAttachment.appendChild(riPage);
    }
    acImage.appendChild(riAttachment);

    const width = img.getAttribute('width');
    if (width) acImage.setAttribute('ac:width', width);
    img.replaceWith(acImage);
  }

  // Convert emoticon placeholders back to ac:emoticon (#1750): every carried
  // attribute, in carried order; the label is display only. Runs after every
  // loop that rebuilds a body by re-parsing (task lists, panels, expands,
  // sections, columns, unknown macros), so it sees each emoticon where it
  // finally sits.
  for (const span of doc.querySelectorAll('span.confluence-emoticon')) {
    span.replaceWith(emoticonWriteBack(span));
  }

  // #1955: every ri:url link is judged on the string that is written, read as
  // XML (confluence-link.ts): a link to a value that is not a navigable URL
  // stays only where the stored page holds that occurrence, and a string that
  // would carry one past the check is refused. The check may change the
  // document and serialise it again; nothing follows it but the D19 check.
  if (!linkKinds) return serialiseStorage(doc);
  return enforceConfluenceUrlLinkOrigin(doc.body, () => serialiseStorage(doc), linkOrigin, shown);
}

/**
 * Coordinator decision D20, owner decision D21 (#1955, reviews r6 R25/R26, r7 R28/R29): what the forward pass
 * emitted for the stored links of the five #1955 kinds. `links` is what the storage reader read from the stored
 * string itself; each stored link's start tag carries the attribute `marker` with its index there, under a random
 * name. Each `<a>` the link loop emits carries `marker` with its index in `emissions`, so the completed result
 * tells which emitted links survived every later step and pass.
 */
interface EmittedLinkWitness {
  readonly marker: string;
  links: readonly StorageElement[] | StorageReadFailure;
  /**
   * Each emitted link of the five kinds: the carrier it was emitted with, whether that keeps its XML target, and
   * the stored link the reader read at its tag, if any.
   */
  readonly emissions: Array<{ carrier: string; faithful: boolean; stored: StorageElement | undefined }>;
}

/**
 * Record the link the forward pass emits as `a` for `acLink` and mark `a` (D20): faithful when the stored link the
 * reader read at that tag is written back by its carrier with its XML target (`storedLinkKeepsTarget`), else
 * unfaithful — an element the reader did not read as a link, and every link of storage the reader did not read,
 * has no XML target to keep. The three #1748 kinds are not recorded.
 */
function witnessEmittedLink(witness: EmittedLinkWitness, acLink: Element, a: Element): void {
  const built = confluenceLinkCarrier(acLink);
  if (!built || CONFLUENCE_LINK_KINDS_1748.includes(built.kind)) return;
  const { links } = witness;
  const index = acLink.getAttribute(witness.marker);
  const stored = typeof links === 'string' || index === null ? undefined : links[Number(index)];
  a.setAttribute(witness.marker, String(witness.emissions.length));
  witness.emissions.push({ carrier: built.carrier, faithful: stored !== undefined && storedLinkKeepsTarget(stored, built), stored });
}

/** What the forward pass over a page's stored storage tells a write-back about its stored links of the five kinds. */
interface StoredLinkWitness {
  /** Refuse the write when an outgoing link carrying `carrier` would change a stored link's XML target (D19). */
  check(carrier: string): void;
  /** Whether the stored link-like element reached the editor as a link (D21 fallback, review r8 R32). */
  shown(element: StorageElement): boolean;
}

/**
 * Owner decisions D19/D21, coordinator decision D20 (#1955): run the forward pass itself over the page's stored
 * storage, with the features of this write-back and a witness. Only an emitted link still in the completed result
 * is an occurrence. For `check`, it is faithful when it still carries the carrier it was emitted with and that
 * keeps its stored XML target. A carrier only faithful occurrences carry, or none (a new link, or a candidate the
 * pass discarded), passes. One an unfaithful occurrence carries is refused (`changed-link-target`, or the limit the
 * reader stopped at); when a faithful occurrence carries it too, which of them the outgoing link is cannot be told,
 * and it is refused alike, logged `ambiguous`. Storage the reader knows is not well-formed is not checked. `shown`
 * holds the stored links that have an occurrence (by their tag in the stored string): any other stored link, one
 * a macro discarded with its parameter for instance, never was a link in the editor and is no source.
 */
function witnessStoredLinks(storage: string, features: StorageDerivationFeatures): StoredLinkWitness {
  const marker = `data-cq-stored-link-${randomBytes(8).toString('hex')}`;
  const witness: EmittedLinkWitness = { marker, links: [], emissions: [] };
  const html = confluenceToHtmlWith(storage, undefined, undefined, features, witness);
  const { links } = witness;
  const occurrences = new Map<string, { faithful: boolean; unfaithful: boolean }>();
  const shown = new Set<number>();
  if (typeof links !== 'string' || isStorageLimitStop(links)) {
    const result = new JSDOM(`<body>${html}</body>`, { contentType: 'text/html' }).window.document;
    for (const a of result.querySelectorAll(`a[${marker}]`)) {
      const emission = witness.emissions[Number(a.getAttribute(marker))];
      const carrier = confluenceLinkCarrierOf(a);
      if (!emission || carrier === null) continue;
      if (emission.stored) shown.add(emission.stored.tag[0]);
      const verdict = occurrences.get(carrier) ?? { faithful: false, unfaithful: false };
      if (emission.faithful && emission.carrier === carrier) verdict.faithful = true;
      else verdict.unfaithful = true;
      occurrences.set(carrier, verdict);
    }
  }
  const reason = typeof links === 'string' ? links : 'changed-link-target';
  return {
    check: (carrier) => {
      const verdict = occurrences.get(carrier);
      if (verdict?.unfaithful) refuseConfluenceStorage(reason, verdict.faithful ? 'ambiguous' : undefined);
    },
    shown: (element) => shown.has(element.tag[0]),
  };
}

/**
 * The storage string of a document every reverse loop of htmlToConfluence has
 * run over: its HTML serialisation, made XHTML.
 */
function serialiseStorage(doc: Document): string {
  let result = doc.body.innerHTML;
  // #1748: escape `<`, `>`, tab, LF and CR in ac:link / ri:* attribute values,
  // before the void-element pass below can rewrite a `<br>` inside one.
  result = escapeConfluenceLinkAttributes(result);

  // Post-process (#1750): write each emoticon self-closed, as Confluence
  // stores it, so an unchanged one goes back byte for byte. JSDOM escapes `"`,
  // `&` and NBSP in attribute values but not `<` or `>`; XML forbids a raw `<`
  // there, so both are escaped here. A raw tab, line feed or carriage return
  // would become a space under XML attribute-value normalization, so each is
  // written as a character reference. Runs before the void-element pass,
  // which would otherwise rewrite a `<br>` inside a value.
  result = result.replace(
    /<ac:emoticon((?: [^\s="]+="[^"]*")*)><\/ac:emoticon>/g,
    (_, attrs: string) => `<ac:emoticon${attrs.replace(/[<>\t\n\r]/g, (ch) => EMOTICON_VALUE_ESCAPES[ch] ?? ch)} />`,
  );

  // Post-process: self-close void elements for XHTML compatibility.
  // JSDOM innerHTML uses HTML serialization (<br>, <img ...>) but Confluence
  // storage format requires valid XHTML (<br />, <img ... />).
  result = result.replace(
    /<(area|base|br|col|embed|hr|img|input|link|meta|source|track|wbr)(\s[^>]*)?\s*>/gi,
    '<$1$2 />',
  );

  // Post-process: wrap ac:plain-text-body content in CDATA sections.
  // Confluence requires CDATA inside <ac:plain-text-body> for code macros,
  // and writes a plain-text link body the same way (#1748).
  result = result.replace(
    /<(ac:plain-text-body|ac:plain-text-link-body)>([\s\S]*?)<\/\1>/g,
    (_, tag: string, content: string) => {
      // Unescape HTML entities back to raw text for CDATA
      const raw = he.decode(content);
      // #900: a literal ']]>' inside the content would prematurely close the
      // CDATA section, producing invalid XHTML. Split it across two adjacent
      // CDATA sections (the standard escape) so the terminator survives intact.
      const safe = raw.replace(/\]\]>/g, ']]]]><![CDATA[>');
      return `<${tag}><![CDATA[${safe}]]></${tag}>`;
    },
  );

  return result;
}

function pathBasename(urlString: string): string {
  try {
    const parsed = new URL(urlString);
    return parsed.pathname.split('/').pop() ?? '';
  } catch {
    return '';
  }
}

/**
 * Confluence emoticons (#1750). `<ac:emoticon/>` is an empty element whose
 * attributes are its whole identity, and they differ by Confluence version:
 * `ac:name` alone (`tick`, `warning`, `smile`, …); Confluence 7 and Cloud add
 * `ac:emoji-shortname`, `ac:emoji-id` and `ac:emoji-fallback` (Cloud writes
 * the shortname as the fallback, older versions the emoji itself); DC 8.5+
 * writes a CLDR `ac:name` plus `ac:emoji-id`, and some carry no `ac:name`. So
 * no attribute is assumed: the placeholder carries every attribute, in source
 * order, as one JSON object, and the reverse pass writes exactly those back.
 */
const EMOTICON_ATTRS = 'data-emoticon-attrs';

/** What the reverse pass writes for a character JSDOM leaves raw in an emoticon attribute value. */
const EMOTICON_VALUE_ESCAPES: Readonly<Record<string, string>> = {
  '<': '&lt;', '>': '&gt;', '\t': '&#9;', '\n': '&#10;', '\r': '&#13;',
};

/**
 * An attribute name the reverse pass can write: an ASCII XML QName. Storage is
 * XML, so every real attribute name passes; one that does not could be
 * neither set (JSDOM throws InvalidCharacterError) nor written well-formed.
 */
const XML_ATTRIBUTE_NAME = /^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?$/;

/** A label candidate longer than this many code points is skipped. */
const EMOTICON_LABEL_MAX = 64;

/**
 * A carried attribute name: an XML QName that declares no namespace. Storage
 * never declares one on an element, and `xmlns:ac` on an emoticon would rebind
 * its own prefix (`xmlns:ac=""` is a namespace error Confluence refuses).
 */
function isCarriedName(name: string): boolean {
  return XML_ATTRIBUTE_NAME.test(name) && !/^xmlns(?::|$)/i.test(name);
}

/** The longest carried attribute value; real ones are under 100 characters. */
const EMOTICON_VALUE_MAX = 1024;

/** Characters XML 1.0 forbids even escaped: a value holding one would make Confluence refuse the page. */
// eslint-disable-next-line no-control-regex -- matching the control characters XML forbids is the point
const XML_FORBIDDEN_CHAR = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|\p{Cs}/u;

/** A carried attribute value: at most EMOTICON_VALUE_MAX characters, none XML forbids. */
function isCarriedValue(value: string): boolean {
  return value.length <= EMOTICON_VALUE_MAX && !XML_FORBIDDEN_CHAR.test(value);
}

/** Characters a label or an accessible name never holds: controls, bidi overrides and isolates, `<` and `>`. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const EMOTICON_TEXT_EXCLUDED = /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069<>]|\p{Cs}/u;

/** `ac:emoji-fallback` / `ac:emoji-shortname` in shortname form: `:cross_mark:`. */
const EMOJI_SHORTNAME = /^:[^:\s]+:$/;

/**
 * The emoji each classic Confluence emoticon is shown as. `light-off` and the
 * red, green and blue stars have no standard emoji and fall back to
 * Confluence's own text form, `(name)`.
 */
const EMOTICON_GLYPHS: Record<string, string> = {
  smile: '\u{1F642}',
  sad: '\u{1F641}',
  cheeky: '\u{1F61B}',
  laugh: '\u{1F600}',
  wink: '\u{1F609}',
  'thumbs-up': '\u{1F44D}',
  'thumbs-down': '\u{1F44E}',
  information: '\u2139\uFE0F',
  tick: '\u2705',
  cross: '\u274C',
  warning: '\u26A0\uFE0F',
  plus: '\u2795',
  minus: '\u2796',
  question: '\u2753',
  'light-on': '\u{1F4A1}',
  'yellow-star': '\u2B50',
  heart: '\u2764\uFE0F',
};

/** `ac:emoji-id` as hyphen-joined hex code points (`1f4cb`, `31-20e3`) → the emoji; else undefined. */
function emojiFromCodePoints(id: string): string | undefined {
  if (!/^[0-9a-f]{1,6}(?:-[0-9a-f]{1,6}){0,15}$/i.test(id)) return undefined;
  const points = id.split('-').map((hex) => parseInt(hex, 16));
  const printable = (cp: number): boolean =>
    cp >= 0x20 && !(cp >= 0x7f && cp <= 0x9f) && !(cp >= 0xd800 && cp <= 0xdfff) && cp <= 0x10ffff;
  return points.every(printable) ? String.fromCodePoint(...points) : undefined;
}

/**
 * What an emoticon placeholder shows (#1750), the first that applies: the
 * emoji itself in `ac:emoji-fallback`; the code points of `ac:emoji-id`; the
 * classic `ac:name`'s emoji; Confluence's text forms — the shortname, then
 * `(name)` (the alt text Confluence gives its own emoticon images) — and
 * `(emoticon)` when nothing names it. Display only: the reverse pass ignores it.
 */
function emoticonLabel(attrs: Readonly<Record<string, string>>): string {
  const name = attrs['ac:name'];
  const fallback = attrs['ac:emoji-fallback'];
  const id = attrs['ac:emoji-id'];
  const candidates = [
    fallback !== undefined && !EMOJI_SHORTNAME.test(fallback) ? fallback : undefined,
    id !== undefined ? emojiFromCodePoints(id) : undefined,
    name !== undefined && Object.hasOwn(EMOTICON_GLYPHS, name) ? EMOTICON_GLYPHS[name] : undefined,
    attrs['ac:emoji-shortname'],
    fallback,
    name ? `(${name})` : undefined,
  ];
  return candidates.find(isEmoticonText) ?? '(emoticon)';
}

/**
 * A usable label or name: not blank, at most EMOTICON_LABEL_MAX code points,
 * no control or bidi-override character, and no `<` or `>` — both are
 * attribute values of the placeholder, which must hold no markup character
 * (see emoticonPlaceholder).
 */
function isEmoticonText(text: string | undefined): text is string {
  return text !== undefined
    && text.trim() !== ''
    && !EMOTICON_TEXT_EXCLUDED.test(text)
    && [...text].length <= EMOTICON_LABEL_MAX;
}

/**
 * The emoticon's accessible name (#1750): the shortname in words
 * (`:partying_face:` → `partying face`) — Confluence 7 and Cloud name every
 * non-classic emoji `blue-star` and keep its identity in the shortname — else
 * `ac:name` in words (`thumbs-up` → `thumbs up`), else `emoticon`.
 */
function emoticonName(attrs: Readonly<Record<string, string>>): string {
  const shortname = [attrs['ac:emoji-shortname'], attrs['ac:emoji-fallback']]
    .find((value) => value !== undefined && EMOJI_SHORTNAME.test(value));
  return [shortname?.slice(1, -1).replace(/_/g, ' '), attrs['ac:name']?.replace(/-/g, ' ')]
    .find(isEmoticonText) ?? 'emoticon';
}

/**
 * `<ac:emoticon …/>` → `<span class="confluence-emoticon" data-emoticon-attrs="{…}" data-emoticon-label="✅"
 * role="img" aria-label="tick"></span>` (#1750): empty, every value an attribute.
 * The carrier is always written, `{}` for an element without attributes, so
 * the reverse pass can tell a converted emoticon from a span it never made.
 * It is JSON with `<` and `>` written as `\u003c` / `\u003e`: it parses back
 * to the same values, and the placeholder's HTML then holds no `<` or `>`
 * outside its own tags — so no value can read as markup to a consumer that
 * scans the HTML as text (#1752's `<div` test on protected media, DOMPurify's
 * SAFE_FOR_XML attribute check in read mode).
 */
function emoticonPlaceholder(el: Element): Element {
  const pairs = [...el.attributes]
    .filter((attr) => isCarriedName(attr.name) && isCarriedValue(attr.value))
    .map((attr): [string, string] => [attr.name, attr.value]);
  // fromEntries defines own properties, so even a `__proto__` attribute is carried.
  const attrs: Record<string, string> = Object.fromEntries(pairs);
  const span = el.ownerDocument.createElement('span');
  span.className = 'confluence-emoticon';
  span.setAttribute(
    EMOTICON_ATTRS,
    JSON.stringify(attrs).replace(/[<>]/g, (ch) => (ch === '<' ? '\\u003c' : '\\u003e')),
  );
  // No text node: the label and the name are attributes, the glyph is drawn by
  // CSS (`.confluence-emoticon::before`) and read as `role="img"`. So the
  // emoticon adds nothing to body text, embedding input, Markdown outside
  // Improve or #1751's task text — all exactly what they were before #1750.
  span.setAttribute('data-emoticon-label', emoticonLabel(attrs));
  span.setAttribute('role', 'img');
  span.setAttribute('aria-label', emoticonName(attrs));
  return span;
}

/**
 * What a placeholder writes back (#1750): the `ac:emoticon` with every
 * carried attribute that has a string value and a writable name, in carried
 * order. A span whose carrier is missing or not a JSON object was not made by
 * the forward pass (hand-written or imported HTML): it writes its label
 * (`data-emoticon-label`, else its text) as text rather than invent an
 * emoticon with no identity, and the write-back does not fail. The label,
 * `role` and `aria-label` are display only.
 */
function emoticonWriteBack(span: Element): Node {
  let attrs: unknown = null;
  try {
    attrs = JSON.parse(span.getAttribute(EMOTICON_ATTRS) ?? 'null');
  } catch {
    // Not the forward pass's carrier: falls through to the label.
  }
  if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs)) {
    return span.ownerDocument.createTextNode(span.getAttribute('data-emoticon-label') ?? span.textContent ?? '');
  }
  const emoticon = span.ownerDocument.createElement('ac:emoticon');
  for (const [name, value] of Object.entries(attrs)) {
    if (typeof value === 'string' && isCarriedName(name) && isCarriedValue(value)) emoticon.setAttribute(name, value);
  }
  return emoticon;
}

export interface ProtectedMedia {
  token: string;
  html: string;
  /** #1958: the entry's subtree (root included) holds a `pre` with `data-title` or `data-macro-params`. */
  code?: true;
  /** #1958: the page's own text spells this token besides the one node protectMedia inserted. */
  literal?: true;
  /**
   * #1958 (review r1 CM-3): the original with every CR / CR LF in the text of
   * its `code` elements written as LF, when that differs from `html`. One HTML
   * parse of a spliced original reads them so; this is the only difference a
   * replayed original may show.
   */
  lineEndForm?: string;
}

/** What {@link protectMedia} returns. */
export interface ProtectedBody {
  /** The body with every protected node replaced by its token. */
  html: string;
  /** `CQ_MEDIA_PLACEHOLDER_<N>` entries: the same tokens and ordinals as before #1958. */
  media: ProtectedMedia[];
  /** #1958: frozen annotated code blocks, `CQ_CODE_PLACEHOLDER_<N>`, their own ordinal space. */
  frozenCode: ProtectedMedia[];
  /** #1958: the stored body holds a `pre` with `data-title` or `data-macro-params` anywhere. */
  carried: boolean;
}

const MEDIA_TOKEN_PREFIX = 'CQ_MEDIA_PLACEHOLDER_';
/** #1958: frozen annotated code blocks; never in the media ordinal space. */
const CODE_TOKEN_PREFIX = 'CQ_CODE_PLACEHOLDER_';
// #765: legacy section/column wrappers are NO LONGER opaque-protected here
// (with one exception — see below). #723 froze them whole (token swap), which
// preserved them but made the prose inside uneditable by the LLM. They now
// round-trip via layout boundary tokens in htmlToMarkdown/markdownToHtml (see
// LAYOUT_TOKEN_* below) so the inner content stays improvable. The labels
// macro placeholder IS opaque — it is atomic (no prose inside) so the token
// pattern fits it exactly.
const NATIVE_PANEL_SELECTOR = 'div.panel-info[data-macro-name="panel"]';

const MEDIA_SELECTOR = [
  'img',
  'div.confluence-drawio',
  'div.confluence-mermaid',
  'div.mermaid',
  'div.confluence-labels-macro',
  // #865: freeze unknown-macro placeholders whole so the AI-Improve
  // markdown round-trip can't flatten them into prose (which htmlToConfluence
  // would then rebuild nothing from). Inner prose becomes non-improvable —
  // the same preserve-over-improve tradeoff already accepted for labels/drawio.
  'div.confluence-macro-unknown',
  // #1438: a native panel reuses the visual info-panel node, but its macro
  // identity and arbitrary parameters have no Markdown representation.
  // Freeze the whole node so Improve cannot coerce it to an `info` macro.
  NATIVE_PANEL_SELECTOR,
  // #901: freeze atomic macro placeholders — toc / children / attachments /
  // include (block) and jira / status / user-mention (inline). Like labels and
  // unknown-macro they carry NO LLM-editable prose (only a synthetic visible
  // label such as [Table of Contents] / [JIRA: PROJ-42] / @alice). Without the
  // freeze, the AI-Improve HTML→Markdown→HTML round-trip flattens that label
  // into prose and htmlToConfluence rebuilds nothing, permanently deleting the
  // macro on write-back. The now-redundant turndown flatten rules stay as
  // fallbacks for non-Improve flows where protectMedia is not run.
  'div.confluence-toc',
  'div.confluence-children-macro',
  'div.confluence-attachments-macro',
  'div.confluence-include-macro',
  'span.confluence-jira-issue',
  'span.confluence-status',
  'span.confluence-user-mention',
  // #1750: emoticons — inline atoms with no prose, frozen like the #901
  // inline placeholders above. Their frozen HTML is one <span>, never a div.
  'span.confluence-emoticon',
  // #1221: expand sections. Stage 1 froze every `<details>` here — `details`
  // has no turndown rule, so the Improve round-trip flattened the section into
  // bare paragraphs, the #1211 `data-macro-name` stamp was lost, and
  // htmlToConfluence rebuilt no macro at all, permanently deleting it from the
  // Confluence page on apply. Stage 2 keeps that freeze only where a boundary
  // token cannot survive (see isFrozenExpand); everywhere else the section
  // round-trips as [[[EXPAND …]]] tokens and its body stays improvable.
  'details',
].join(',');

// #765 review follow-up: legacy section/column wrappers nested inside
// markdown-constrained containers (table cells, list items, blockquotes,
// panels — which turndown renders as blockquotes) CANNOT use boundary tokens.
// markdownToHtml's token normalization forces every token onto its own
// paragraph, which rips it out of the containing construct (e.g. splits a GFM
// table row, emptying the table and leaking cells as literal `| … |` text).
// These nested wrappers keep the pre-#765 opaque freeze; boundary tokens are
// used only for non-nested legacy sections/columns.
const LEGACY_WRAPPER_SELECTOR = 'div.confluence-section, div.confluence-column';
const CONSTRAINED_ANCESTOR_SELECTOR =
  'td, th, li, blockquote, div.panel-info, div.panel-warning, div.panel-note, div.panel-tip';

function isLegacyWrapper(el: Element): boolean {
  return el.classList.contains('confluence-section') || el.classList.contains('confluence-column');
}

function isFrozenLegacyWrapper(el: Element): boolean {
  return isLegacyWrapper(el) && el.parentElement?.closest(CONSTRAINED_ANCESTOR_SELECTOR) != null;
}

const EXPAND_SELECTOR = 'details';

function isExpandSection(el: Element): boolean {
  return el.nodeName === 'DETAILS';
}

function isConstrainedPosition(el: Element): boolean {
  return el.parentElement?.closest(CONSTRAINED_ANCESTOR_SELECTOR) != null;
}

/** Subtrees that travel as one opaque media token, so they emit no tokens. */
const OPAQUE_SUBTREE_SELECTOR = [
  'div.confluence-drawio',
  'div.confluence-mermaid',
  'div.mermaid',
  'div.confluence-macro-unknown',
  NATIVE_PANEL_SELECTOR,
].join(',');

/** Layout-token kinds enclosing `el`, outermost first — the open-time stack. */
function enclosingLayoutKinds(el: Element): string[] {
  const stack: string[] = [];
  for (let p = el.parentElement; p; p = p.parentElement) {
    const wrapper = layoutWrapperKind(p);
    if (wrapper) stack.unshift(wrapper.kind);
  }
  return stack;
}

/**
 * Would this expand, and everything it contains, produce a token sequence
 * `rebuildLayoutStructure` accepts?
 *
 * #1221 review. The first cut of this guard hand-listed the wrapper classes
 * known to be invalid inside an expand, and missed `div.confluence-column` —
 * Confluence's Column macro is not schema-bound to Section, so `expand >
 * column` is real content, and it emits `[[[EXPAND]]] [[[COLUMN]]]` which
 * layoutOpenAllowed rejects (a COLUMN may only open inside a SECTION). The
 * rebuild's all-or-nothing drop-guard then stripped EVERY token and the macro
 * was deleted from the page — on a model echo with zero mangling. The mirror
 * case, an expand sitting directly inside `div.confluence-layout` (where an
 * EXPAND may not open), failed the same way.
 *
 * So the question is no longer answered by a list that has to be kept in sync
 * by hand: it is answered by the SAME predicate that will judge the sequence
 * later. A shape this cannot prove tokenizable keeps the stage-1 opaque
 * freeze — its body is not improvable, but it survives, which is the trade
 * this whole issue exists to make.
 */
function expandTokenizesCleanly(el: Element): boolean {
  const stack = enclosingLayoutKinds(el);
  if (!layoutOpenAllowed('EXPAND', stack)) return false;

  stack.push('EXPAND');
  const visit = (node: Element): boolean => {
    for (const child of Array.from(node.children)) {
      // A nested expand is never walked, whatever its verdict turns out to be.
      // Frozen, it travels as one opaque token and emits nothing. Unfrozen, its
      // OWN expandTokenizesCleanly already validated both its position (against
      // this very stack, via enclosingLayoutKinds) and its whole subtree — so
      // re-checking here can only repeat that work.
      //
      // It is also the difference between linear and exponential. Calling
      // isFrozenExpand(child) here walked the child's subtree once inside that
      // call and again on the way down, i.e. T(n) = 2·T(n-1): a chain of nested
      // sections took 12s at depth 18 and ~56s at depth 20, synchronously, on
      // the Improve and apply request paths.
      if (isExpandSection(child)) continue;
      if (isFrozenLegacyWrapper(child)) continue;
      if (child.matches(OPAQUE_SUBTREE_SELECTOR)) continue;

      const wrapper = layoutWrapperKind(child);
      if (!wrapper) {
        if (!visit(child)) return false;
        continue;
      }
      if (!layoutOpenAllowed(wrapper.kind, stack)) return false;
      stack.push(wrapper.kind);
      const ok = visit(child);
      stack.pop();
      if (!ok) return false;
    }
    return true;
  };
  return visit(el);
}

/**
 * #1221 stage 2: an expand section freezes for exactly the reason a legacy
 * section/column does — a boundary token inside a markdown-constrained
 * container is ripped out of that construct by markdownToHtml's token
 * normalization. `details` is deliberately NOT part of
 * CONSTRAINED_ANCESTOR_SELECTOR: an expand's own body is ordinary markdown
 * once its boundary is a token, so nesting inside one constrains nothing.
 */
function isFrozenExpand(el: Element): boolean {
  if (!isExpandSection(el)) return false;
  if (isConstrainedPosition(el)) return true;
  return !expandTokenizesCleanly(el);
}

/** Does any `<details>` ancestor of `el` travel as one opaque capture? */
function hasFrozenExpandAncestor(el: Element): boolean {
  for (
    let ancestor = el.parentElement?.closest(EXPAND_SELECTOR) ?? null;
    ancestor;
    ancestor = ancestor.parentElement?.closest(EXPAND_SELECTOR) ?? null
  ) {
    if (isFrozenExpand(ancestor)) return true;
  }
  return false;
}

/** The expand's title element — direct child only, mirroring htmlToConfluence. */
function firstDirectSummary(el: Element): Element | null {
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeName === 'SUMMARY') return child as Element;
  }
  return null;
}

/**
 * Fallback macro identity for a `<details>` carrying no `data-macro-name`.
 * Same value and same reasoning as htmlToConfluence's reverse pass: sections
 * predating the #1211 stamp, and editor-created ones, genuinely are native
 * expands.
 */
const DEFAULT_EXPAND_MACRO_NAME = 'expand';

/**
 * #1221 stage 2: percent-encode a token attribute value.
 *
 * The token grammar allows `[ \t][^\]\n]*`, so `]`, newline and the separating
 * space must be encoded — but that is only the floor. Once encoded the value
 * also passes through marked's markdown parse and HTML escaping untouched,
 * which matters because the skeleton-less paths read it back out of marked's
 * HTML with a plain regex: unencoded, `&` would return as `&amp;` and `_foo_`
 * as `<em>foo</em>`. So everything outside `[A-Za-z0-9-]` is encoded:
 * encodeURIComponent handles UTF-8 (surrogate pairs included) and the follow-up
 * pass removes the characters it leaves unescaped. `-` is kept because it is
 * inert mid-line and keeps `name=ui-expand` readable.
 *
 * What this does NOT survive is what happens BEFORE it: turndown collapses
 * whitespace in the DOM, so a tab or a double space in a summary reaches this
 * function already normalised to one space. Harmless on the Improve path —
 * extractLayoutSkeleton reads the untouched DOM and the rebuild re-emits from
 * the skeleton, so the literal whitespace is what lands in storage — but it is
 * not a byte-for-byte guarantee, and a future skeleton-less path must not
 * assume one.
 */
function encodeTokenValue(value: string): string {
  return encodeURIComponent(value).replace(
    /[_.!~*'()]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
  );
}

/**
 * Inverse of encodeTokenValue. Falls back to the raw text on malformed input:
 * with a #781 skeleton every attrs string is canonical (written from the
 * skeleton), but the skeleton-less paths read whatever the model echoed, and a
 * stray `%` there must not throw.
 */
function decodeTokenValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function escapeHtmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeHtmlAttr(value: string): string {
  return escapeHtmlText(value).replace(/"/g, '&quot;');
}

/**
 * Canonical `EXPAND` token attrs for a `<details>`: the macro identity, open
 * state, summary and remaining parameters — everything the reverse pass needs
 * and none of it improvable. htmlToMarkdown and extractLayoutSkeleton both
 * derive them from here, though the two do not always agree byte-for-byte:
 * turndown has already collapsed whitespace in the DOM it hands the token rule,
 * while extractLayoutSkeleton reads the untouched one. That is safe only
 * because alignment matches on kind and direction alone and the rebuild always
 * re-emits the SKELETON's spelling — the more faithful of the two. Any future
 * attrs-sensitive alignment would have to reconcile them first.
 *
 * The summary rides opaquely and is deliberately NOT improvable: titles are
 * short, rarely the thing needing a rewrite, and a second boundary pair around
 * them would add three lines per section to the prompt and one more way into
 * the 422 path.
 */
function expandTokenAttrs(el: Element): string {
  const summary = firstDirectSummary(el);
  const name = el.getAttribute('data-macro-name') || DEFAULT_EXPAND_MACRO_NAME;
  const open = el.hasAttribute('open') ? '1' : '0';
  const params = el.getAttribute('data-macro-params') ?? '';
  const attrs = [`name=${encodeTokenValue(name)}`, `open=${open}`];
  // PRESENCE of the key records whether the HTML had a <summary> at all — no
  // more than that since #1227. The absent-vs-explicitly-empty title
  // distinction Confluence storage draws now rides in `params`
  // (`{"title":""}`), because a blank summary is what BOTH states look like.
  // The guard stays anyway: this function also runs over HTML that never came
  // from confluenceToHtml, and the rebuild is happy to be told there was none.
  if (summary) attrs.push(`title=${encodeTokenValue(summary.textContent ?? '')}`);
  attrs.push(`params=${encodeTokenValue(params)}`);
  return attrs.join(' ');
}

interface ExpandTokenAttrs { name: string; open: boolean; title: string | null; params: string; }

function parseExpandTokenAttrs(attrs: string): ExpandTokenAttrs {
  const parsed: ExpandTokenAttrs = { name: DEFAULT_EXPAND_MACRO_NAME, open: false, title: null, params: '' };
  for (const part of attrs.split(/[ \t]+/)) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const raw = part.slice(eq + 1);
    switch (part.slice(0, eq)) {
      case 'name': {
        const name = decodeTokenValue(raw);
        if (name) parsed.name = name;
        break;
      }
      case 'open': parsed.open = raw === '1'; break;
      case 'title': parsed.title = decodeTokenValue(raw); break;
      case 'params': parsed.params = decodeTokenValue(raw); break;
    }
  }
  return parsed;
}

/**
 * data-macro-params is a JSON object written by the forward pass. A value that
 * does not parse as one came from a model-invented token (the skeleton-guided
 * paths always supply the page's own attrs), so it is dropped rather than
 * persisted — htmlToConfluence would ignore it anyway.
 */
function isMacroParamsObject(raw: string): boolean {
  if (!raw) return false;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

/**
 * #723: Replace rich/media nodes with opaque text tokens before the lossy
 * HTML→Markdown→HTML round-trip used by AI Improve. Document order makes the
 * tokens deterministic, so the same source HTML re-protected at Accept time
 * yields the same tokens — no need to persist the map.
 *
 * #1958: an annotated code block that cannot travel as a CODE-META token
 * (classifyCodeBlock `frozen`), and every token block past the first
 * CODE_META_TOKENS_MAX, is frozen too, in its OWN token namespace
 * (`CQ_CODE_PLACEHOLDER_<N>`, `frozenCode`): the media entries, their tokens
 * and their ordinals are exactly what the release before #1958 wrote, so a
 * suggestion it generated names the same media (review r1 CM-1). A frozen
 * block holding a media node is not frozen (its media keeps its ordinal).
 * Three facts are reported, each read from this DOM: an entry's `code` (its
 * subtree holds an annotated `pre`), its `literal` (the page spells its token
 * itself) and `carried` (the stored body holds an annotated `pre` anywhere,
 * before any replacement).
 */
export function protectMedia(html: string): ProtectedBody {
  const dom = new JSDOM(`<body>${html}</body>`);
  const doc = dom.window.document;
  const media: ProtectedMedia[] = [];
  // Outermost-first: a div.confluence-drawio contains an <img>; protect the
  // wrapper and skip its descendants. Same for frozen legacy section/column
  // wrappers (#765 review), which may contain media or further nested columns.
  const nodes = Array.from(doc.body.querySelectorAll(`${MEDIA_SELECTOR},${LEGACY_WRAPPER_SELECTOR}`))
    .filter((n) => {
      // Legacy section/column wrappers freeze ONLY when nested inside a
      // markdown-constrained container; elsewhere they use boundary tokens.
      if (isLegacyWrapper(n) && !isFrozenLegacyWrapper(n)) return false;
      // #1221 stage 2: expand sections follow the same rule — a constrained one
      // freezes, everywhere else it round-trips as [[[EXPAND …]]] tokens.
      if (isExpandSection(n) && !isFrozenExpand(n)) return false;
      // Descendants of an already-frozen node travel inside it.
      if (n.parentElement?.closest(OPAQUE_SUBTREE_SELECTOR)) return false;
      // Skip descendants of a frozen wrapper — it is protected whole. If the
      // nearest wrapper ancestor is not frozen, no farther one can be either
      // (frozenness propagates downward: a frozen ancestor's constrained
      // container is an ancestor of every nested wrapper too).
      const wrapperAncestor = n.parentElement?.closest(LEGACY_WRAPPER_SELECTOR);
      if (wrapperAncestor && isFrozenLegacyWrapper(wrapperAncestor)) return false;
      // Same test for expands, and it must be the FROZEN-ness that decides, not
      // the mere presence of a `<details>` ancestor: media inside an
      // unconstrained expand now needs its own token, because that section's
      // body travels as markdown rather than inside one opaque capture.
      //
      // Unlike legacy wrappers this must check EVERY `<details>` ancestor, not
      // just the nearest. The downward-propagation argument above holds only
      // for frozen-by-position; an expand can also freeze because its own
      // token shape is invalid (expandTokenizesCleanly), and that reason is not
      // inherited — so a frozen outer section can hold an unfrozen inner one.
      // Testing only the nearest gave media inside it a second, orphaned token
      // that the apply drop-guard could re-append as a duplicate.
      if (hasFrozenExpandAncestor(n)) return false;
      return true;
    });
  const carried = doc.body.querySelector(ANNOTATED_CODE_BLOCK_SELECTOR) !== null;
  const frozen = carried ? frozenCodeBlocks(doc.body, nodes) : [];
  /** The placeholder text nodes inserted below: generator output, never an authored spelling. */
  const synthesized = new Set<Node>();
  for (const node of nodes) {
    const token = `${MEDIA_TOKEN_PREFIX}${media.length}`;
    const entry: ProtectedMedia = { token, html: (node as Element).outerHTML };
    if (carried && holdsAnnotatedCodeBlock(node as Element)) {
      entry.code = true;
      const lineEnds = codeTextLineEndForm(node as Element);
      if (lineEnds !== null) entry.lineEndForm = lineEnds;
    }
    media.push(entry);
    const placeholder = doc.createTextNode(` ${token} `);
    synthesized.add(placeholder);
    node.replaceWith(placeholder);
  }
  const frozenCode: ProtectedMedia[] = frozen.map((pre, index) => {
    const entry: ProtectedMedia = { token: `${CODE_TOKEN_PREFIX}${index}`, html: pre.outerHTML, code: true };
    const lineEnds = codeTextLineEndForm(pre);
    if (lineEnds !== null) entry.lineEndForm = lineEnds;
    const placeholder = doc.createTextNode(` ${entry.token} `);
    synthesized.add(placeholder);
    pre.replaceWith(placeholder);
    return entry;
  });
  if (media.length > 0 || frozenCode.length > 0) {
    // #1958 (review r4 CM4-2): each authored text node on its own, as the replay sees text runs; never the
    // flattened body text, whose node joins would hide a spelling standing alone in its own paragraph.
    const texts: string[] = [];
    const walker = doc.createTreeWalker(doc.body, dom.window.NodeFilter.SHOW_TEXT);
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      if (!synthesized.has(text)) texts.push(text.nodeValue ?? '');
    }
    markLiteralTokens(texts, MEDIA_TOKEN_PREFIX, media);
    markLiteralTokens(texts, CODE_TOKEN_PREFIX, frozenCode, true);
  }
  return { html: doc.body.innerHTML, media, frozenCode, carried };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** An element a media token stands in: what a consumer needs to decide whether a token there may be replaced. */
export interface MediaTokenContext {
  /** The element's tag name, lower case. */
  readonly tagName: string;
  /** Its attributes as the HTML parser read them (`class`, a marker attribute, …). */
  readonly attributes: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  /** The element's range in the string, or null for one the parser supplied itself (`tbody`). */
  readonly start: number | null;
  readonly end: number | null;
  /** The enclosing element; null at the top. A `template`'s content has that template as parent. */
  readonly parent: MediaTokenContext | null;
}

/** One place of a string where a media token stands as content, and what replaces it. */
export interface MediaTokenPlacement {
  /** The media entry's token (its unescaped spelling). */
  readonly token: string;
  /** The range of the original string that the entry's HTML replaces. */
  readonly start: number;
  readonly end: number;
  /** The range is a whole `<p>TOKEN</p>`, not the bare token. */
  readonly wrapped: boolean;
  /** The element holding the replaced range, with its ancestors. */
  readonly context: MediaTokenContext | null;
}

/** Elements whose text the HTML tokenizer never reads as content. */
const MEDIA_OPAQUE_PARENTS = new Set([
  'script', 'style', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'plaintext', 'textarea', 'title',
]);

type Html5Node = DefaultTreeAdapterTypes.Node;

/** A range of the source string. */
interface SourceRange {
  start: number;
  end: number;
}

/**
 * The children the tree builder did not leave where their source stands
 * (#1955): a child whose source lies outside `bounds`, the content of the
 * nearest ancestor with a source range, and children whose ranges are not in
 * source order one after the other. Of two that overlap, the one inside the
 * other was moved (an element or text foster-parented out of a table, in
 * front of it); when neither holds the other (misnested formatting rebuilt
 * around a block), both are uncertain. Nothing under such a child is where
 * the tree says it is. One pass: every child is compared with the kept
 * children before it, and each of those is given up at most once.
 */
function displacedChildren(children: readonly Html5Node[], bounds: SourceRange | null): Set<Html5Node> {
  const displaced = new Set<Html5Node>();
  const kept: Array<SourceRange & { node: Html5Node }> = [];
  for (const node of children) {
    const location = node.sourceCodeLocation;
    if (!location) continue;
    const item = { node, start: location.startOffset, end: location.endOffset };
    if (bounds && (item.start < bounds.start || item.end > bounds.end)) {
      displaced.add(node);
      continue;
    }
    let keep = true;
    while (kept.length > 0) {
      const last = kept[kept.length - 1]!;
      if (item.start >= last.end) break;
      if (last.start >= item.start && last.end <= item.end) {
        // `last` was moved out of `item`, in front of it.
        displaced.add(last.node);
        kept.pop();
        continue;
      }
      keep = false;
      displaced.add(node);
      if (item.start >= last.start && item.end <= last.end) break;
      displaced.add(last.node);
      kept.pop();
    }
    if (keep) kept.push(item);
  }
  return displaced;
}

/** The namespace of HTML elements; anything else (SVG, MathML) is foreign content. */
const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

/**
 * Where the tree builder dropped a start tag (#1955, review r2 R14): the
 * offsets of every stretch of `html` that no node accounts for (no start or
 * end tag of an element, no text, no comment) and that holds a start tag. A
 * start tag the tree builder ignores (a cell outside a table, a `div` in a
 * `select`) has no node, so whatever it was written to hold stands in the
 * tree under something else. An ignored end tag closes nothing and is not
 * counted. Review r3, R18: a text node whose source holds `<` is text the tree
 * builder joined across markup it dropped; it accounts for none of its
 * source, so a start tag in it counts. Sorted.
 */
function ignoredStartTags(html: string, root: Html5Node): number[] {
  const covered: Array<readonly [number, number]> = [];
  const pending: Html5Node[] = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if ('tagName' in node) {
      const { startTag, endTag } = node.sourceCodeLocation ?? {};
      if (startTag) covered.push([startTag.startOffset, startTag.endOffset]);
      if (endTag) covered.push([endTag.startOffset, endTag.endOffset]);
    } else if (node.sourceCodeLocation) {
      const { startOffset, endOffset } = node.sourceCodeLocation;
      if (node.nodeName !== '#text' || !html.slice(startOffset, endOffset).includes('<')) covered.push([startOffset, endOffset]);
    }
    if ('content' in node) pending.push(node.content);
    if ('childNodes' in node) pending.push(...node.childNodes);
  }
  covered.sort((a, b) => a[0] - b[0]);
  const ignored: number[] = [];
  let at = 0;
  // What no node accounts for after the last one is a tag the string ends in: it holds nothing.
  for (const [start, end] of covered) {
    if (start > at && /<[A-Za-z]/.test(html.slice(at, start))) ignored.push(at);
    at = Math.max(at, end);
  }
  return ignored;
}

/** How many of the sorted `offsets` lie in `[start, end)`. */
function countWithin(offsets: readonly number[], start: number, end: number): number {
  const firstAtOrAfter = (value: number): number => {
    let low = 0;
    let high = offsets.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (offsets[middle]! < value) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  return firstAtOrAfter(end) - firstAtOrAfter(start);
}

/**
 * Where the tokens of `media` stand as content in `html` (#1955), in source
 * order. The HTML tokenizer decides, not a scan for `<` and `>`: a placement
 * is a token spelling (raw, or turndown-escaped with `\_`) inside the source
 * range of one text node, or the whole `<p>TOKEN</p>` of an attribute-less
 * paragraph that holds nothing else. Offsets are offsets of `html` itself.
 *
 * A spelling anywhere else is no placement: in an attribute value, a comment
 * (with `>` or an unmatched quote inside), a tag name, the text of a
 * `script`, `style`, `textarea` or `title`, text the tree builder joined
 * across markup, and anything the tree builder moved, with all it holds: text
 * or an element directly inside a table (foster-parented in front of it) and
 * misnested formatting it rebuilt. There the tree and the source disagree
 * about the place. Review r2, R14: nor anywhere a reparse would not keep what
 * is spliced in where the placement says: in a `select` (it drops every
 * element inserted into it), in SVG or MathML (an inserted image leaves it),
 * and under an element whose own content holds a start tag the tree builder
 * ignored (what that tag held stands under another element in the tree).
 * Placements never overlap. Each carries the element it stands in with that
 * element's attributes and ancestors, so a consumer can refuse the ones in a
 * code sample or a discarded container without parsing the string a second
 * way.
 */
export function locateMediaTokens(html: string, media: readonly ProtectedMedia[]): MediaTokenPlacement[] {
  const tokenOf = new Map<string, string>();
  const alternatives: string[] = [];
  for (const { token } of media) {
    for (const spelling of [token, token.replace(/_/g, '\\_')]) {
      tokenOf.set(spelling, token);
      // The bare form ends on a non-digit so token N never matches token N0…N9.
      alternatives.push(`${escapeRegExp(spelling)}(?![0-9])`);
    }
  }
  if (alternatives.length === 0 || !new RegExp(alternatives.join('|')).test(html)) return [];
  const spellings = new RegExp(alternatives.join('|'), 'g');

  const placements: MediaTokenPlacement[] = [];
  const root = parseFragment(html, { sourceCodeLocationInfo: true });
  const ignored = ignoredStartTags(html, root);
  const pending: Array<{ node: Html5Node; context: MediaTokenContext | null; bounds: SourceRange | null }> = [
    { node: root, context: null, bounds: null },
  ];
  while (pending.length > 0) {
    const { node, context, bounds } = pending.pop()!;
    if (!('childNodes' in node)) continue;
    let own = context;
    let content = bounds;
    if ('tagName' in node) {
      // Nothing spliced into a `select` or into foreign content stays where it was put.
      if (node.namespaceURI !== HTML_NAMESPACE || node.tagName === 'select') continue;
      const location = node.sourceCodeLocation;
      own = {
        tagName: node.tagName, attributes: node.attrs, parent: context,
        start: location?.startOffset ?? null, end: location?.endOffset ?? null,
      };
      // What the element holds stands between its tags; an element the parser supplied has its parent's bounds.
      if (location) {
        content = { start: location.startTag?.endOffset ?? location.startOffset, end: location.endTag?.startOffset ?? location.endOffset };
      }
    }
    // A template's children are its content fragment.
    const children = 'content' in node ? node.content.childNodes : node.childNodes;
    if (ignored.length > 0) {
      // A start tag the tree builder ignored stands in this element's own content, not in one of its children.
      const range = content ?? { start: 0, end: html.length };
      let inChildren = 0;
      // Only an element child is visited as a container of its own; what lies in a text child is this element's.
      for (const child of children) {
        const location = 'tagName' in child ? child.sourceCodeLocation : null;
        if (location) inChildren += countWithin(ignored, location.startOffset, location.endOffset);
      }
      if (countWithin(ignored, range.start, range.end) > inChildren) continue;
    }
    // A child the tree builder moved is not at the place its ancestors name, and neither is anything in it.
    const displaced = displacedChildren(children, content);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index]!;
      if (displaced.has(child)) continue;
      if (child.nodeName !== '#text') {
        pending.push({ node: child, context: own, bounds: content });
        continue;
      }
      const location = child.sourceCodeLocation;
      if (!location || (own && MEDIA_OPAQUE_PARENTS.has(own.tagName))) continue;
      const source = html.slice(location.startOffset, location.endOffset);
      // One run of text: a range that holds markup is text the tree builder joined across it.
      if (source.includes('<')) continue;
      // `<p>TOKEN</p>`: Markdown wrapped the lone token in a paragraph, which goes with it.
      const paragraph = 'tagName' in node && node.tagName === 'p' && children.length === 1 && node.attrs.length === 0
        ? node.sourceCodeLocation
        : null;
      const wrapped = paragraph?.endTag
        ? /^<p>\s*([\s\S]*?)\s*<\/p>$/.exec(html.slice(paragraph.startOffset, paragraph.endOffset))?.[1]
        : undefined;
      if (wrapped !== undefined && tokenOf.has(wrapped)) {
        placements.push({
          token: tokenOf.get(wrapped)!, start: paragraph!.startOffset, end: paragraph!.endOffset, wrapped: true, context,
        });
        continue;
      }
      for (const match of source.matchAll(spellings)) {
        const start = location.startOffset + match.index;
        placements.push({ token: tokenOf.get(match[0])!, start, end: start + match[0].length, wrapped: false, context: own });
      }
    }
  }
  return placements.sort((a, b) => a.start - b.start);
}

/**
 * Re-inject protected media. Replaces `<p>TOKEN</p>` (markdown wrapped the lone
 * token in a paragraph) and bare TOKEN occurrences with the original HTML.
 * Also handles the turndown-escaped form (underscores escaped as \_) so that
 * tokens survive a full htmlToMarkdown→markdownToHtml round-trip.
 *
 * #1955: only a token that stands as content is replaced ({@link
 * locateMediaTokens}). A spelling in an attribute value (a link's href or
 * class), a comment, a tag name or raw text stays as written, so restoring
 * media can never rewrite an attribute. `accept` lets a caller refuse further
 * placements by the element they stand in; the default takes every one.
 *
 * #723 correctness:
 * - One pass over the original string, replaced ranges spliced in source
 *   order: an original holding `$`, `$&`, `$1` (legitimate in Confluence
 *   attachment URLs / encoded query strings) is injected verbatim, and
 *   already-injected media is never re-scanned, so an earlier entry whose
 *   original HTML literally contains a *later* token (e.g. in an `alt` /
 *   `data-diagram-name`) cannot be corrupted by a subsequent replacement.
 * - `<p>TOKEN</p>` is consumed with its paragraph. A `(?![0-9])` boundary on
 *   the bare form stops `..._1` from matching the prefix of `..._10`.
 */
export function restoreMedia(
  html: string,
  media: ProtectedMedia[],
  options: { accept?: (placement: MediaTokenPlacement) => boolean } = {},
): string {
  if (media.length === 0) return html;
  const placements = locateMediaTokens(html, media);
  if (placements.length === 0) return html;
  const originals = new Map(media.map((entry) => [entry.token, entry.html] as const));
  return splicePlacements(html, placements, (placement) =>
    (options.accept && !options.accept(placement) ? null : originals.get(placement.token)!));
}

/**
 * The one splice of located media tokens (#1955 restoreMedia, #1958 replay):
 * placements in source order, each replaced by what `replacementOf` returns
 * (null keeps the spelling as written). One pass over the original string, so
 * inserted HTML is never rescanned and `$` sequences stay verbatim.
 */
export function splicePlacements(
  html: string,
  placements: readonly MediaTokenPlacement[],
  replacementOf: (placement: MediaTokenPlacement, index: number) => string | null,
): string {
  const parts: string[] = [];
  let at = 0;
  for (let index = 0; index < placements.length; index += 1) {
    const placement = placements[index]!;
    if (placement.start < at) continue;
    const replacement = replacementOf(placement, index);
    if (replacement === null) continue;
    parts.push(html.slice(at, placement.start), replacement);
    at = placement.end;
  }
  parts.push(html.slice(at));
  return parts.join('');
}

// ---------------------------------------------------------------------------
// #1958: code-block title and options through AI Improve.
//
// Markdown has no carrier for a code macro's `title` and other parameters
// (`data-title` / `data-macro-params` on the <pre>). On the Improve path
// (`layoutTokens`) an annotated block that can travel is written as a fence
// with one echo token on the line directly above it:
//
//   [[[CODE-META n=0 title=Startup.cs params=%7B%22linenumbers%22...]]]
//   ```csharp
//   ...
//   ```
//
// On Accept the token is bound to the pre-Improve body only on exact identity
// (language + the exact text the fence lexes to, in equal per-key groups); a
// bound block gets the STORED values back, never the echoed ones. Annotated
// blocks that cannot travel are frozen as media entries. The HTML stage
// (finalizeCodeMetadata) is not the authority: the written storage (or, for a
// standalone page, its publication projections) is read as XML and every code
// macro must be in the writer's shape and accounted for by the page, else the
// Accept is refused before any effect.
// ---------------------------------------------------------------------------

export const CODE_META_TITLE_MAX = 1024;
export const CODE_META_VALUE_MAX = 1024;
export const CODE_META_KEY_MAX = 64;
export const CODE_META_PARAMS_MAX_ENTRIES = 16;
/** UTF-8 bytes of the `data-macro-params` JSON, checked before it is parsed. */
export const CODE_META_PARAMS_MAX_BYTES = 4096;
/** UTF-16 units of a token's attributes (`n=… title=… params=…`). */
export const CODE_META_ATTRS_MAX = 16_384;
/** Token blocks per page; the rest are frozen. */
export const CODE_META_TOKENS_MAX = 1000;
/** Replay budget: FACTOR × the page's frozen HTML + SLACK UTF-16 units. */
export const MEDIA_REPLAY_FACTOR = 2;
export const MEDIA_REPLAY_SLACK = 65_536;
/** Work units of one storage judgement (elements, attributes, compared characters). */
export const CODE_MACRO_WORK = 8_000_000;

const ANNOTATED_CODE_BLOCK_SELECTOR = 'pre[data-title], pre[data-macro-params]';
const CODE_META_PARAM_KEY = new RegExp(`^[A-Za-z][A-Za-z0-9_.-]{0,${CODE_META_KEY_MAX - 1}}$`);
const PLACEHOLDER_SPELLING = /CQ(?:_|\\_)(?:MEDIA|CODE)(?:_|\\_)PLACEHOLDER/;
const CODE_META_ATTRS = /^n=(0|[1-9]\d{0,2})(?: title=([A-Za-z0-9%-]*))?(?: params=([A-Za-z0-9%-]*))?$/;
const CODE_META_TOKEN_LINE = /^\[\[\[CODE-META ([^\]\n]*)\]\]\]$/;
const CODE_META_MARKDOWN_HINT = /\[\[\[[ \t]*\/?[ \t]*CODE[-_ ]?META/i;

/** The emitted Markdown starts with a CODE-META line (only the Improve conversion writes one unescaped). */
function startsWithCodeMeta(markdown: string): boolean {
  return markdown.startsWith('[[[CODE-META ');
}
const FENCE_MARKER = 'data-cq-code-fence';
const REPLAY_MARKER = 'data-cq-code-replay';
const ELEMENT_NODE = 1;

/**
 * `data-macro-params` of a code block, validated both ways (#1958, issue
 * criterion 3): a plain JSON object of at most CODE_META_PARAMS_MAX_ENTRIES
 * own keys (`^[A-Za-z][A-Za-z0-9_.-]{0,63}$`, never `constructor` or
 * `prototype`), every value a string of at most CODE_META_VALUE_MAX characters
 * that XML can hold, the whole at most CODE_META_PARAMS_MAX_BYTES UTF-8 bytes.
 * Anything else is null.
 */
export function parseCodeMacroParams(raw: string): Record<string, string> | null {
  if (raw.length > CODE_META_PARAMS_MAX_BYTES || Buffer.byteLength(raw, 'utf8') > CODE_META_PARAMS_MAX_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const entries = Object.entries(parsed);
  if (entries.length > CODE_META_PARAMS_MAX_ENTRIES) return null;
  for (const [key, value] of entries) {
    if (!CODE_META_PARAM_KEY.test(key) || key === 'constructor' || key === 'prototype') return null;
    if (typeof value !== 'string' || value.length > CODE_META_VALUE_MAX || XML_FORBIDDEN_CHAR.test(value)) return null;
  }
  return parsed as Record<string, string>;
}

/** A code block title the token may carry: at most CODE_META_TITLE_MAX characters XML can hold. */
export function isCodeMetaTitle(title: string): boolean {
  return title.length <= CODE_META_TITLE_MAX && !XML_FORBIDDEN_CHAR.test(title);
}

/** The one canonical token attribute string: `n=<ordinal>[ title=…][ params=…]`. */
export function encodeCodeMetaAttrs(n: number, title: string | null, params: string | null): string {
  let attrs = `n=${n}`;
  if (title !== null) attrs += ` title=${encodeTokenValue(title)}`;
  if (params !== null) attrs += ` params=${encodeTokenValue(params)}`;
  return attrs;
}

/** Decodes a token value only when it is the canonical encoding of what it decodes to. */
function decodeCanonicalTokenValue(encoded: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    return null;
  }
  return encodeTokenValue(decoded) === encoded ? decoded : null;
}

export interface CodeMetaAttrs {
  readonly n: number;
  readonly title: string | null;
  readonly params: string | null;
}

/** The strict inverse of {@link encodeCodeMetaAttrs}; null for anything it would not write. */
export function parseCodeMetaAttrs(attrs: string): CodeMetaAttrs | null {
  if (attrs.length > CODE_META_ATTRS_MAX) return null;
  const match = CODE_META_ATTRS.exec(attrs);
  if (!match) return null;
  const title = match[2] === undefined ? null : decodeCanonicalTokenValue(match[2]);
  const params = match[3] === undefined ? null : decodeCanonicalTokenValue(match[3]);
  if ((match[2] !== undefined && title === null) || (match[3] !== undefined && params === null)) return null;
  return { n: Number(match[1]), title, params };
}

/** Turndown's fenced-code algorithm (`codeBlockStyle: 'fenced'`), shared by the emitter and the projection. */
function fenceFor(code: string, language: string): string {
  let size = 3;
  for (const match of code.matchAll(/^`{3,}/gm)) {
    if (match[0].length >= size) size = match[0].length + 1;
  }
  const fence = '`'.repeat(size);
  return `${fence}${language}\n${code.replace(/\n$/, '')}\n${fence}`;
}

/** The exact text the Markdown lexer gives a fence: identity on both sides is this text, never rendered bytes. */
export type LexerCodeText = string & { readonly __lexerCodeText: unique symbol };

/** Echo side: the lexer's own text of a fenced code token. */
export function lexerCodeTextOf(token: Tokens.Code): LexerCodeText {
  return token.text as LexerCodeText;
}

/** One block's identity: its language and its lexer text. */
export function codeBlockIdentityKey(language: string, text: LexerCodeText): string {
  return `${language}\u0000${text}`;
}

/** The first word of a fence's info string, as marked writes it into the class. */
function fenceLanguage(lang: string | undefined): string {
  return /^\S*/.exec(lang ?? '')?.[0] ?? '';
}

/**
 * Source side: what the fence of a stored block lexes to, with the Marked
 * configuration of markdownToHtml. Null when the text holds a CR or the fence
 * does not lex to exactly one fenced code token of that language (lossy).
 */
export function projectSourceCodeText(raw: string, language: string): LexerCodeText | null {
  if (raw.includes('\r')) return null;
  const blocks = EDITOR_MARKED.lexer(fenceFor(raw, language)).filter((token) => token.type !== 'space');
  const token = blocks.length === 1 ? blocks[0]! : null;
  if (token?.type !== 'code' || token.codeBlockStyle === 'indented') return null;
  if (fenceLanguage(token.lang as string | undefined) !== language) return null;
  return lexerCodeTextOf(token as Tokens.Code);
}

/** The `code` element a `pre` holds as its only child node, itself without element children; else null. */
function onlyCodeChild(pre: Element): Element | null {
  if (pre.childNodes.length !== 1) return null;
  const code = pre.firstChild as Element | null;
  if (!code || code.nodeType !== ELEMENT_NODE || code.nodeName !== 'CODE') return null;
  for (let index = 0; index < code.childNodes.length; index += 1) {
    if (code.childNodes[index]!.nodeType === ELEMENT_NODE) return null;
  }
  return code;
}

function codeLanguageOf(code: Element): string {
  return (code.getAttribute('class') ?? '').match(CODE_LANGUAGE_CLASS)?.[1] ?? '';
}

/**
 * The `pre` elements of `root` that stand inside a `td` / `th`, in one
 * iterative walk (works on JSDOM and on turndown's DOM).
 */
function preInTableCells(root: Node): Set<Node> {
  const inCell = new Set<Node>();
  const pending: Array<{ node: Node; cell: boolean }> = [{ node: root, cell: false }];
  while (pending.length > 0) {
    const { node, cell } = pending.pop()!;
    if (cell && node.nodeName === 'PRE') inCell.add(node);
    const below = cell || node.nodeName === 'TD' || node.nodeName === 'TH';
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === ELEMENT_NODE) pending.push({ node: child, cell: below });
    }
  }
  return inCell;
}

function isAnnotatedCodeBlock(pre: Element): boolean {
  return pre.hasAttribute('data-title') || pre.hasAttribute('data-macro-params');
}

/**
 * #1958: how an Improve carries a `pre`. `plain`: no metadata, turndown's own
 * fence. `token`: annotated and representable: one `code` child without
 * element children, outside a table cell, not draw.io, non-blank code, title
 * and options within the bounds, no placeholder spelling, a lossless
 * projection. `frozen`: annotated otherwise (travels as a media entry).
 * Works on JSDOM and on turndown's own DOM.
 */
function classifyCodeBlock(
  pre: Element,
  inCell: ReadonlySet<Node>,
  projections?: Map<Element, LexerCodeText>,
): 'plain' | 'token' | 'frozen' {
  const title = pre.getAttribute('data-title');
  const params = pre.getAttribute('data-macro-params');
  if (title === null && params === null) return 'plain';
  const code = onlyCodeChild(pre);
  if (!code || inCell.has(pre)) return 'frozen';
  const language = codeLanguageOf(code);
  const text = code.textContent ?? '';
  if (language === 'drawio' || /^\s*$/.test(text) || PLACEHOLDER_SPELLING.test(text)) return 'frozen';
  if (title !== null && (!isCodeMetaTitle(title) || PLACEHOLDER_SPELLING.test(title))) return 'frozen';
  if (params !== null && (parseCodeMacroParams(params) === null || PLACEHOLDER_SPELLING.test(params))) return 'frozen';
  if (encodeCodeMetaAttrs(CODE_META_TOKENS_MAX - 1, title, params).length > CODE_META_ATTRS_MAX) return 'frozen';
  const projected = projectSourceCodeText(text, language);
  if (projected === null) return 'frozen';
  projections?.set(pre, projected);
  return 'token';
}

/** The `token` blocks of a (protected) DOM in document order, at most CODE_META_TOKENS_MAX: ordinal = index. */
function codeMetaTokenBlocks(
  root: Node & { querySelectorAll(selector: string): ArrayLike<Element> },
  projections?: Map<Element, LexerCodeText>,
): Element[] {
  const blocks: Element[] = [];
  const pres = root.querySelectorAll('pre');
  const inCell = pres.length > 0 ? preInTableCells(root) : new Set<Node>();
  for (let index = 0; index < pres.length && blocks.length < CODE_META_TOKENS_MAX; index += 1) {
    if (classifyCodeBlock(pres[index]!, inCell, projections) === 'token') blocks.push(pres[index]!);
  }
  return blocks;
}

/**
 * protectMedia's code freeze, in one walk in document order: every `frozen`
 * block, and every `token` block past the first CODE_META_TOKENS_MAX. A block
 * inside a media node travels with it; a block holding a media node is not
 * frozen, so that node keeps the media ordinal it had before #1958.
 */
function frozenCodeBlocks(body: Element, media: readonly Element[]): Element[] {
  const mediaNodes = new Set<Element>(media);
  const holdsMedia = new Set<Element>();
  for (const node of media) {
    for (let el = node.parentElement; el && !holdsMedia.has(el); el = el.parentElement) holdsMedia.add(el);
  }
  const inCell = preInTableCells(body);
  const frozen: Element[] = [];
  let tokens = 0;
  const pending: Array<{ el: Element; skip: boolean }> = [{ el: body, skip: false }];
  while (pending.length > 0) {
    const { el, skip } = pending.pop()!;
    let below = skip || mediaNodes.has(el);
    if (!below && el.tagName === 'PRE') {
      const kind = classifyCodeBlock(el, inCell);
      if (kind === 'token') tokens += 1;
      if ((kind === 'frozen' || (kind === 'token' && tokens > CODE_META_TOKENS_MAX)) && !holdsMedia.has(el)) {
        frozen.push(el);
        below = true;
      }
    }
    for (let child = el.lastElementChild; child; child = child.previousElementSibling) {
      pending.push({ el: child, skip: below });
    }
  }
  return frozen;
}

function holdsAnnotatedCodeBlock(el: Element): boolean {
  return el.matches(ANNOTATED_CODE_BLOCK_SELECTOR) || el.querySelector(ANNOTATED_CODE_BLOCK_SELECTOR) !== null;
}

/**
 * `el`'s outerHTML with CR / CR LF in the text of its `code` elements as LF;
 * null when that changes nothing. One walk of the copy (review r2 CM2-8): a
 * text node is normalised when it has a `code` ancestor, each node once.
 */
function codeTextLineEndForm(el: Element): string | null {
  if (!el.outerHTML.includes('\r')) return null;
  const copy = el.cloneNode(true) as Element;
  let changed = false;
  const pending: Array<{ node: Node; insideCode: boolean }> = [{ node: copy, insideCode: false }];
  while (pending.length > 0) {
    const { node, insideCode } = pending.pop()!;
    if (insideCode && node.nodeType === 3 && node.nodeValue?.includes('\r')) {
      node.nodeValue = node.nodeValue.replace(/\r\n?/g, '\n');
      changed = true;
    }
    const below = insideCode || node.nodeName === 'CODE';
    for (let child = node.firstChild; child; child = child.nextSibling) pending.push({ node: child, insideCode: below });
  }
  return changed ? copy.outerHTML : null;
}

/**
 * #1958 (X4, review r4 CM4-2): an entry is `literal` when an authored text
 * node of the protected body (never a placeholder protectMedia inserted)
 * spells its token, either spelling, digit boundary: the page itself writes
 * the token, so no spelling of it can be told for a placement. Each node is
 * scanned on its own, as the replay reads a text run; for code entries
 * (`identifier`) a spelling inside a longer identifier within that node
 * (`CQ_CODE_PLACEHOLDER_0_COUNT`) is not one, as in the replay
 * (isIdentifierPart). A token whose node ends where an identifier goes on in
 * the next one (`CQ_CODE_PLACEHOLDER_0<!---->_COUNT`) counts: refusal, never a guess.
 */
function markLiteralTokens(texts: readonly string[], prefix: string, entries: ProtectedMedia[], identifier = false): void {
  if (entries.length === 0) return;
  const counts = new Map<string, number>();
  const spelled = `(?:${escapeRegExp(prefix)}|${escapeRegExp(prefix.replace(/_/g, '\\_'))})(\\d+)`;
  const spelling = new RegExp(identifier ? `(?<![A-Za-z0-9_])${spelled}(?![A-Za-z0-9_]|\\\\_)` : spelled, 'g');
  for (const text of texts) {
    for (const match of text.matchAll(spelling)) {
      counts.set(match[1]!, (counts.get(match[1]!) ?? 0) + 1);
    }
  }
  for (let index = 0; index < entries.length; index += 1) {
    if ((counts.get(String(index)) ?? 0) > 0) entries[index]!.literal = true;
  }
}

/** One `pre` of the pre-Improve (protected) body whose only child is `code`, in document order. */
export interface CodeMetaSkeletonBlock {
  /** {@link codeBlockIdentityKey}, or a key nothing matches when the projection is lossy. */
  readonly key: string;
  /** The stored code text, as the DOM holds it. */
  readonly original: string;
  readonly language: string;
  /** The block's token ordinal; null for a plain block. */
  readonly token: number | null;
  readonly title: string | null;
  readonly params: string | null;
}

/**
 * Every `pre` of `protectedHtml` whose only child is `code` (draw.io fences
 * excluded), with its identity key. Empty, without any projection, when the
 * body has no token block.
 */
export function extractCodeMetaSkeleton(protectedHtml: string): CodeMetaSkeletonBlock[] {
  if (!/<pre[\s>]/i.test(protectedHtml)) return [];
  const doc = new JSDOM(`<body>${protectedHtml}</body>`).window.document;
  const projections = new Map<Element, LexerCodeText>();
  const tokens = codeMetaTokenBlocks(doc.body, projections);
  if (tokens.length === 0) return [];
  const ordinal = new Map(tokens.map((pre, n) => [pre, n] as const));
  const blocks: CodeMetaSkeletonBlock[] = [];
  for (const pre of doc.body.querySelectorAll('pre')) {
    if (pre.childNodes.length !== 1 || pre.firstChild?.nodeName !== 'CODE') continue;
    const code = pre.firstChild as Element;
    const language = codeLanguageOf(code);
    if (language === 'drawio') continue;
    const original = code.textContent ?? '';
    const n = ordinal.get(pre) ?? null;
    const projected = projections.get(pre) ?? projectSourceCodeText(original, language);
    blocks.push({
      key: projected === null ? `\u0001${blocks.length}` : codeBlockIdentityKey(language, projected),
      original,
      language,
      token: n,
      title: n === null ? null : pre.getAttribute('data-title'),
      params: n === null ? null : pre.getAttribute('data-macro-params'),
    });
  }
  return blocks;
}

/** What markdownToHtml recorded for one fenced code token of the echo (draw.io and indented code excluded). */
export interface CodeMetaFence {
  /** The lexer's text: the witness of an unchanged plain fence. */
  readonly text: LexerCodeText;
  readonly language: string;
  /** The skeleton block it is bound to, or null. */
  readonly bound: number | null;
  /** The class marked writes on its `code`, or null. */
  readonly className: string | null;
}

/** Counts only (#1958 log): never content. */
export interface CodeMetaReport {
  bound: number;
  orphan: number;
  malformed: number;
  invalid: number;
  duplicate: number;
  mismatch: number;
  debris: number;
  stripped: number;
  forged: number;
  twins: number;
  appended: number;
  screened: number;
  literal: number;
}

/** Route-local state of one Accept; never serialised, logged or stored. */
export interface CodeMetaAccept {
  /** The stored body holds an annotated `pre` anywhere (#1953 admits nothing then). */
  readonly carried: boolean;
  readonly witnesses: boolean;
  readonly skeleton: readonly CodeMetaSkeletonBlock[];
  /** 128 random bits, created at Accept, after the model's text exists. */
  readonly nonce: string;
  /** The media entries, then the frozen code entries (`CQ_CODE_PLACEHOLDER_<N>`); replay indexes this list. */
  readonly entries: readonly ProtectedMedia[];
  /** How many of `entries` are frozen code entries (at the end). */
  readonly frozenCode: number;
  /**
   * D26 item 2, fixed at the start of the Accept from the suggestion's provenance: `meta`, the #1958 path (a row
   * the #1958 generator wrote, or Markdown no stored row matches); `base`, the Accept of the release before #1958
   * for a pre-#1958 row on a page without annotated code.
   */
  readonly mode: 'meta' | 'base';
  /** Filled by markdownToHtml, in document order. */
  readonly fences: CodeMetaFence[];
  /** Entry indices of the code-carrying originals inserted with a marker. */
  readonly replayed: Set<number>;
  readonly report: CodeMetaReport;
}

/** `llm_improvements.improve_protocol` the #1958 generator writes on every row it stores (migration 161). */
export const IMPROVE_CODE_META_PROTOCOL = 1;

/**
 * Where an applied suggestion comes from (D26 item 2), decided by the route
 * from the stored row its exact text matches, never from the text itself:
 * `code-meta`, a row with {@link IMPROVE_CODE_META_PROTOCOL}; `legacy`, a row
 * written before #1958 (no protocol); `unmatched`, no row (a direct or
 * user-edited Apply).
 */
export type ImproveSuggestionProvenance = 'code-meta' | 'legacy' | 'unmatched';

/**
 * Starts one Accept's code-metadata state from protectMedia's whole return
 * value. `witnesses` asks finalizeCodeMetadata for the lexer text of every
 * unchanged plain fence (#1953). `provenance` (default `unmatched`) fixes the
 * mode; a `legacy` suggestion for a page holding annotated code throws
 * ImproveSuggestionFormatError before anything is parsed (D26 item 2(b)).
 */
export function beginCodeMetaAccept(
  protectedBody: ProtectedBody,
  options: { witnesses?: boolean; provenance?: ImproveSuggestionProvenance } = {},
): CodeMetaAccept {
  const legacy = options.provenance === 'legacy';
  if (legacy && (protectedBody.carried || protectedBody.frozenCode.length > 0)) throw new ImproveSuggestionFormatError();
  return {
    carried: protectedBody.carried,
    witnesses: options.witnesses === true,
    skeleton: extractCodeMetaSkeleton(protectedBody.html),
    nonce: randomBytes(16).toString('hex'),
    entries: [...protectedBody.media, ...protectedBody.frozenCode],
    frozenCode: protectedBody.frozenCode.length,
    mode: legacy ? 'base' : 'meta',
    fences: [],
    replayed: new Set(),
    report: {
      bound: 0, orphan: 0, malformed: 0, invalid: 0, duplicate: 0, mismatch: 0, debris: 0,
      stripped: 0, forged: 0, twins: 0, appended: 0, screened: 0, literal: 0,
    },
  };
}

function needsCodeMetaAnalysis(accept: CodeMetaAccept, markdown: string): boolean {
  return accept.witnesses || accept.skeleton.some((block) => block.token !== null) || CODE_META_MARKDOWN_HINT.test(markdown);
}

const CODE_RENDERER = new Renderer();

/** marked's escaping of code text (`escape(text, true)`). */
function escapeCodeText(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

/** marked's own `<pre><code…>` opening for a fence of `lang`, with the marker on the `pre`. */
function markedFenceOpen(lang: string | undefined, marker: string): string {
  const empty = CODE_RENDERER.code({ type: 'code', raw: '', text: '', lang, escaped: false } as Tokens.Code);
  const open = empty.slice(0, empty.indexOf('>', '<pre><code'.length) + 1);
  return open.replace('<pre>', `<pre ${FENCE_MARKER}="${marker}">`);
}

interface EchoToken {
  readonly attrs: CodeMetaAttrs | null;
  adjacent: boolean;
}

const CODE_META_INLINE_LOOKALIKE = /\[\[\[[ \t]*\/?[ \t]*CODE[-_ ]?META\b[^\]\n]*\]\]\]/gi;

/**
 * A token spelling inside a line of prose, a heading or a table cell (a
 * panel's `**INFO**: ` prefix, a model that merged lines or made the token a
 * heading) binds nothing and is removed, so no token text reaches the page.
 * An escaped spelling the page writes itself is an escape token, never one
 * text run, and stays; a code span is not a text token and stays too.
 */
function stripInlineCodeMetaLookalikes(inline: Token[] | undefined, report: CodeMetaReport): void {
  for (const token of inline ?? []) {
    if (token.type === 'text') {
      const text = token as Tokens.Text;
      const found = text.text.match(CODE_META_INLINE_LOOKALIKE)?.length ?? 0;
      if (found > 0) {
        report.debris += found;
        text.text = text.text.replace(CODE_META_INLINE_LOOKALIKE, '');
        text.raw = text.raw.replace(CODE_META_INLINE_LOOKALIKE, '');
      }
    }
    if ('tokens' in token && Array.isArray(token.tokens)) stripInlineCodeMetaLookalikes(token.tokens as Token[], report);
  }
}

/**
 * #1958 (review r2 CM2-5): how many token spellings `text` holds when it holds
 * nothing else but white space; 0 otherwise. Each run is matched on its own
 * (`[^\]\n]*` never crosses a `]`), so prose between two runs is never taken
 * for one long token.
 */
function debrisOnlyRuns(text: string): number {
  const runs = text.match(CODE_META_INLINE_LOOKALIKE)?.length ?? 0;
  return runs > 0 && text.replace(CODE_META_INLINE_LOOKALIKE, '').trim() === '' ? runs : 0;
}

/**
 * #1958: the echo analysis on marked's lexer tokens (after layout recovery):
 * standalone tokens, adjacency, validity, duplicates (G0), equal per-key
 * groups (G1–G3); bound fences render the stored text (G4) with a marker;
 * token and lookalike lines are removed. Fills `accept.fences`. Linear in the
 * number of tokens (review r1 CM-6): positions are recorded once, groups are
 * appended to, and each token list is filtered once. With `full` false (the
 * base path of D25 1(b)) no token is read, removed or bound: fences are only
 * recorded (and marked for witnesses), so the rendered bytes are marked's own.
 */
function analyseCodeMetaEcho(tokens: Token[], accept: CodeMetaAccept, full: boolean): void {
  const report = accept.report;
  const echo = new Map<Token, EchoToken>();
  const removals = new Map<Token[], Set<Token>>();
  const remove = (array: Token[], token: Token): void => {
    const set = removals.get(array);
    if (set) set.add(token);
    else removals.set(array, new Set([token]));
  };
  const fences: Array<{ array: Token[]; at: number; token: Tokens.Code; key: string; language: string; meta: EchoToken | null }> = [];
  const walk = (array: Token[]): void => {
    for (let index = 0; index < array.length; index += 1) {
      const token = array[index]!;
      if (!full && (token.type === 'paragraph' || token.type === 'text' || token.type === 'heading' || token.type === 'table')) {
        continue;
      }
      if (token.type === 'paragraph' || token.type === 'text') {
        const line = (token as Tokens.Paragraph).text;
        const match = CODE_META_TOKEN_LINE.exec(line);
        if (match) {
          echo.set(token, { attrs: parseCodeMetaAttrs(match[1]!), adjacent: false });
          remove(array, token);
        } else if (debrisOnlyRuns(line) > 0) {
          report.debris += debrisOnlyRuns(line);
          remove(array, token);
        } else if (line.includes('[[[')) {
          stripInlineCodeMetaLookalikes((token as Tokens.Paragraph).tokens, report);
        }
        continue;
      }
      if (token.type === 'heading') {
        // CM-7: a heading never carries metadata; a token made a heading is debris.
        const heading = token as Tokens.Heading;
        if (debrisOnlyRuns(heading.text) > 0) {
          report.debris += debrisOnlyRuns(heading.text);
          remove(array, token);
        } else if (heading.text.includes('[[[')) {
          stripInlineCodeMetaLookalikes(heading.tokens, report);
        }
        continue;
      }
      if (token.type === 'table') {
        const table = token as Tokens.Table;
        for (const cell of table.header) stripInlineCodeMetaLookalikes(cell.tokens, report);
        for (const row of table.rows) for (const cell of row) stripInlineCodeMetaLookalikes(cell.tokens, report);
        continue;
      }
      if (token.type === 'code' && (token as Tokens.Code).codeBlockStyle !== 'indented') {
        const code = token as Tokens.Code;
        const language = fenceLanguage(code.lang);
        if (language === 'drawio') continue;
        const meta = index > 0 ? echo.get(array[index - 1]!) ?? null : null;
        if (meta) meta.adjacent = true;
        fences.push({ array, at: index, token: code, key: codeBlockIdentityKey(language, lexerCodeTextOf(code)), language, meta });
        continue;
      }
      if (token.type === 'blockquote') walk((token as Tokens.Blockquote).tokens);
      else if (token.type === 'list') for (const item of (token as Tokens.List).items) walk(item.tokens);
    }
  };
  walk(tokens);

  // G0 and validity: canonical, bounded, and naming a token block with identical stored values.
  const ordinalCount = new Map<number, number>();
  for (const { attrs } of echo.values()) if (attrs) ordinalCount.set(attrs.n, (ordinalCount.get(attrs.n) ?? 0) + 1);
  const blockOf = new Map<number, number>();
  accept.skeleton.forEach((block, index) => {
    if (block.token !== null) blockOf.set(block.token, index);
  });
  const validOrdinal = (meta: EchoToken | null): number | null => {
    const attrs = meta?.attrs;
    if (!attrs || (ordinalCount.get(attrs.n) ?? 0) > 1) return null;
    if (attrs.title !== null && !isCodeMetaTitle(attrs.title)) return null;
    if (attrs.params !== null && parseCodeMacroParams(attrs.params) === null) return null;
    const index = blockOf.get(attrs.n);
    const block = index === undefined ? undefined : accept.skeleton[index];
    if (!block || block.title !== attrs.title || block.params !== attrs.params) return null;
    return attrs.n;
  };
  for (const meta of echo.values()) {
    if (!meta.adjacent) report.orphan += 1;
    else if (!meta.attrs) report.malformed += 1;
    else if ((ordinalCount.get(meta.attrs.n) ?? 0) > 1) report.duplicate += 1;
    else if (validOrdinal(meta) === null) report.invalid += 1;
  }

  // G1–G3: a group of equal fences takes its tokens only when it equals the skeleton's group element for element.
  const appendTo = <V>(groups: Map<string, V[]>, key: string, value: V): void => {
    const group = groups.get(key);
    if (group) group.push(value);
    else groups.set(key, [value]);
  };
  const expected = new Map<string, Array<number | null>>();
  for (const block of accept.skeleton) appendTo(expected, block.key, block.token);
  const echoed = new Map<string, Array<number | null>>();
  const ordinals = fences.map((fence) => validOrdinal(fence.meta));
  fences.forEach((fence, index) => appendTo(echoed, fence.key, ordinals[index]!));
  const settled = new Set<string>();
  for (const [key, got] of echoed) {
    const want = expected.get(key) ?? [];
    if (want.length === got.length && want.every((value, index) => value === got[index])) settled.add(key);
    else report.mismatch += got.filter((value) => value !== null).length;
  }

  fences.forEach((fence, index) => {
    const n = settled.has(fence.key) ? ordinals[index]! : null;
    const bound = n === null ? null : blockOf.get(n)!;
    const className = fence.language === '' ? null : `language-${fence.language}`;
    const j = accept.fences.push({ text: lexerCodeTextOf(fence.token), language: fence.language, bound, className }) - 1;
    const marker = `${accept.nonce}-${j}`;
    let html: string | null = null;
    if (bound !== null) {
      html = `${markedFenceOpen(fence.token.lang, marker)}${escapeCodeText(accept.skeleton[bound]!.original)}</code></pre>\n`;
    } else if (accept.witnesses) {
      html = CODE_RENDERER.code(fence.token).replace('<pre>', `<pre ${FENCE_MARKER}="${marker}">`);
    }
    if (html === null) return;
    // Token lists are not changed before this point, so the recorded position still names the fence.
    fence.array[fence.at] = { type: 'html', block: true, pre: false, raw: fence.token.raw, text: html } as Tokens.HTML;
  });
  for (const [array, removed] of removals) {
    let kept = 0;
    for (const token of array) if (!removed.has(token)) array[kept++] = token;
    array.length = kept;
  }
}

/** An element of a placement's context chain, or of an element's ancestor chain. */
interface ContextElement {
  readonly tagName: string;
  readonly attributes: ReadonlyArray<{ readonly name: string; readonly value: string }>;
}

function attributeOf(el: ContextElement, name: string): string | null {
  return el.attributes.find((attribute) => attribute.name === name)?.value ?? null;
}

function hasClass(el: ContextElement, ...names: string[]): boolean {
  const classes = (attributeOf(el, 'class') ?? '').split(/\s+/);
  return names.some((name) => classes.includes(name));
}

const DROPPING_DIV_CLASSES = [
  'figure-index', 'table-index', 'confluence-toc', 'confluence-children-macro', 'confluence-attachments-macro',
  'confluence-labels-macro', 'confluence-include-macro',
];
const DROPPING_SPAN_CLASSES = ['confluence-jira-issue', 'confluence-user-mention', 'confluence-status', 'confluence-emoticon'];

/** One element (with its parent) is a container whose children htmlToConfluence removes or flattens. */
function isDroppingElement(el: ContextElement, parent: ContextElement | undefined): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag === 'summary' || tag === 'template' || hasClass(el, 'confluence-drawio')) return true;
  if (tag === 'div' && hasClass(el, ...DROPPING_DIV_CLASSES)) return true;
  if (tag === 'span' && hasClass(el, ...DROPPING_SPAN_CLASSES)) return true;
  return tag === 'li' && attributeOf(el, 'data-type') !== 'taskItem'
    && parent?.tagName.toLowerCase() === 'ul' && attributeOf(parent, 'data-type') === 'taskList';
}

/**
 * #1958: does the chain (innermost first) hold a container whose children
 * htmlToConfluence removes or flattens? Index blocks, atomic macro
 * placeholders, draw.io, a summary, a template, and a plain item of a task
 * list (only task items are rebuilt).
 */
export function isDroppingContext(chain: Iterable<ContextElement>): boolean {
  const elements = [...chain];
  return elements.some((el, index) => isDroppingElement(el, elements[index + 1]));
}

/** Where a code-carrying original may be spliced and still parse as one subtree in place. */
const CODE_REPLAY_CONTEXT: Readonly<Record<string, true>> = {
  p: true, div: true, li: true, ul: true, ol: true, blockquote: true, table: true, thead: true, tbody: true,
  tfoot: true, tr: true, td: true, th: true, details: true, section: true, article: true, span: true,
  h1: true, h2: true, h3: true, h4: true, h5: true, h6: true,
};

interface ContextFlags {
  /** The chain holds `pre` or `code`. */
  readonly code: boolean;
  readonly dropping: boolean;
  /** The chain holds an element outside CODE_REPLAY_CONTEXT. */
  readonly unsafe: boolean;
}

const TOP_CONTEXT: ContextFlags = { code: false, dropping: false, unsafe: false };

/**
 * The screens of a placement's context chain, each element computed once
 * (review r1 CM-6): flags are inherited from the parent, so the work is
 * linear in the number of distinct context elements, not placements × depth.
 */
function contextFlags(context: MediaTokenContext | null, cache: Map<MediaTokenContext, ContextFlags>): ContextFlags {
  if (!context) return TOP_CONTEXT;
  const missing: MediaTokenContext[] = [];
  let base = TOP_CONTEXT;
  for (let el: MediaTokenContext | null = context; el; el = el.parent) {
    const known = cache.get(el);
    if (known) {
      base = known;
      break;
    }
    missing.push(el);
  }
  for (let index = missing.length - 1; index >= 0; index -= 1) {
    const el = missing[index]!;
    base = {
      code: base.code || el.tagName === 'pre' || el.tagName === 'code',
      dropping: base.dropping || isDroppingElement(el, el.parent ?? undefined),
      unsafe: base.unsafe || CODE_REPLAY_CONTEXT[el.tagName] !== true,
    };
    cache.set(el, base);
  }
  return base;
}

/** The replay plan exceeded its budget: nothing was built (#1958). */
export class ImproveReplayBudgetError extends Error {
  constructor() {
    super('The AI response repeats this page\'s protected content too often to be applied. The page is unchanged — run AI Improve again.');
    this.name = 'ImproveReplayBudgetError';
  }
}

/** A protected original did not come back intact (#1958): the Accept is refused, never downgraded. */
export class ImproveReplayError extends Error {
  constructor() {
    super('The AI response could not be applied without changing protected content on this page. The page is unchanged — run AI Improve again.');
    this.name = 'ImproveReplayError';
  }
}

/**
 * #1958 (coordinator decision D26 item 2(b)): the suggestion is bound to a
 * stored Improve row written before #1958 (no `improve_protocol`), and the
 * page holds annotated code. That release wrote such blocks as editable
 * Markdown without their title and options, so the suggestion cannot be
 * applied without losing them or duplicating a frozen block. Refused before
 * anything is built or written.
 */
export class ImproveSuggestionFormatError extends Error {
  constructor() {
    super('This AI suggestion was made before an update and cannot keep the code block titles and options of this page. The page is unchanged — run AI Improve again.');
    this.name = 'ImproveSuggestionFormatError';
  }
}

/**
 * #1958 (D26 item 3): on the #1958 path a frozen or code-carrying original has
 * no single placement it can take: the suggestion dropped, repeated or moved
 * its placeholder into code, or the page itself spells that placeholder.
 * Appending it could duplicate the block, so the Accept is refused instead.
 */
export class ImproveCodePlacementError extends Error {
  constructor() {
    super('This AI suggestion dropped, repeated or moved a protected code block of this page, so it cannot be applied without losing or duplicating it. The page is unchanged — run AI Improve again, or edit the page directly (a page that spells CQ_CODE_PLACEHOLDER_<number> in its own text cannot take such a suggestion until that text is changed).');
    this.name = 'ImproveCodePlacementError';
  }
}

/** A code entry's spelling inside a longer identifier (`CQ_CODE_PLACEHOLDER_0_COUNT`, `xCQ_CODE_PLACEHOLDER_0`). */
function isIdentifierPart(html: string, placement: MediaTokenPlacement): boolean {
  if (placement.wrapped) return false;
  return /[A-Za-z0-9_]/.test(html[placement.start - 1] ?? '')
    || /[A-Za-z0-9_]/.test(html[placement.end] ?? '') || html.startsWith('\\_', placement.end);
}

/**
 * #1958: re-inject protected media and frozen code blocks, by the mode
 * beginCodeMetaAccept took from the suggestion's provenance (D26 item 2).
 *
 * `base` (a pre-#1958 row on a page without annotated code): what the
 * release before #1958 wrote, restoreMedia at every placement and the
 * `includes` drop guard. Such a page has no code-carrying entry.
 *
 * `meta` (a #1958 row, or Markdown no row matches): one locator pass; every
 * placement screened before counting: a spelling in `pre`/`code`, of an entry
 * the page spells itself (`literal`), or of a code entry inside a longer
 * identifier, stays as written; one in a container the reverse pass drops, or
 * a code-carrying entry's one in a context that does not keep a block intact,
 * is removed. An entry without code goes to every viable placement and is
 * appended once when it has none; a code-carrying entry needs exactly one
 * viable placement, where it goes marked, else ImproveCodePlacementError
 * (D26 item 3: refusal, never a duplicate). Media entries keep the tokens and
 * ordinals of the release before #1958; frozen code entries have their own.
 *
 * Both: the work is charged against the budget before anything is built (on
 * `base` an upper bound: every placement plus every entry without one), then
 * one splice.
 */
export function replayProtectedMedia(
  html: string,
  codeMeta: CodeMetaAccept,
  options: { replayBudget?: number } = {},
): { html: string; dropped: number } {
  const entries = codeMeta.entries;
  if (entries.length === 0) return { html, dropped: 0 };
  const placements = locateMediaTokens(html, entries);
  const entryOf = new Map(entries.map((entry, index) => [entry.token, index] as const));
  const budget = options.replayBudget
    ?? MEDIA_REPLAY_FACTOR * entries.reduce((sum, entry) => sum + entry.html.length, 0) + MEDIA_REPLAY_SLACK;
  const report = codeMeta.report;
  if (codeMeta.mode === 'base') {
    const placed = new Set(placements.map((placement) => entryOf.get(placement.token)!));
    const cost = placements.reduce((sum, placement) => sum + entries[entryOf.get(placement.token)!]!.html.length, 0)
      + entries.reduce((sum, entry, k) => sum + (placed.has(k) ? 0 : entry.html.length + 1), 0);
    if (cost > budget) throw new ImproveReplayBudgetError();
    const spliced = splicePlacements(html, placements, (placement) => entries[entryOf.get(placement.token)!]!.html);
    const appended = entries.filter((entry) => !spliced.includes(entry.html));
    report.appended += appended.length;
    return {
      html: appended.length > 0 ? spliced + appended.map((entry) => entry.html).join('\n') : spliced,
      dropped: appended.length,
    };
  }
  const cache = new Map<MediaTokenContext, ContextFlags>();
  const verdicts = placements.map((placement): 'keep' | 'remove' | 'viable' => {
    const k = entryOf.get(placement.token)!;
    const entry = entries[k]!;
    const flags = contextFlags(placement.context, cache);
    if (entry.literal || flags.code) return 'keep';
    if (k >= entries.length - codeMeta.frozenCode && isIdentifierPart(html, placement)) return 'keep';
    if (flags.dropping) return 'remove';
    if (entry.code && flags.unsafe) return 'remove';
    return 'viable';
  });
  const viable = entries.map(() => 0);
  placements.forEach((placement, index) => {
    if (verdicts[index] === 'viable') viable[entryOf.get(placement.token)!]! += 1;
  });
  if (entries.some((entry, k) => entry.code && viable[k] !== 1)) throw new ImproveCodePlacementError();
  const markerText = (k: number): string => ` ${REPLAY_MARKER}="${codeMeta.nonce}-${k}"`;
  const lengthOf = (k: number): number => entries[k]!.html.length + (entries[k]!.code ? markerText(k).length : 0);
  const appended = entries.flatMap((_entry, k) => (viable[k] === 0 ? [k] : []));

  // Budget from the plan's lengths alone (marker text included), before any replacement string is built.
  let cost = appended.reduce((sum, k) => sum + lengthOf(k) + 1, 0);
  placements.forEach((placement, index) => {
    if (verdicts[index] === 'viable') cost += lengthOf(entryOf.get(placement.token)!);
  });
  if (cost > budget) throw new ImproveReplayBudgetError();

  const marked = entries.map((entry, k) => {
    if (!entry.code) return entry.html;
    const at = entry.html.search(/[\s/>]/);
    return `${entry.html.slice(0, at)}${markerText(k)}${entry.html.slice(at)}`;
  });
  report.screened += verdicts.filter((verdict) => verdict === 'remove').length;
  report.literal += verdicts.filter((verdict) => verdict === 'keep').length;
  report.appended += appended.length;
  entries.forEach((entry, k) => {
    if (entry.code) codeMeta.replayed.add(k);
  });
  const spliced = splicePlacements(html, placements, (placement, index) => {
    if (verdicts[index] === 'keep') return null;
    if (verdicts[index] === 'remove') return '';
    return marked[entryOf.get(placement.token)!]!;
  });
  return {
    html: appended.length > 0 ? spliced + appended.map((k) => marked[k]!).join('\n') : spliced,
    dropped: appended.length,
  };
}

/** Every `pre` with a direct `code` child, in document order: the ordinals of witnesses and #1953 ops. */
export function codeBlockElements(root: ParentNode): Element[] {
  return Array.from(root.querySelectorAll('pre')).filter((pre) =>
    Array.from(pre.children).some((child) => child.tagName === 'CODE'));
}

/**
 * The key a `pre` has as an effective code block (what htmlToConfluence turns
 * into a code macro: a `pre` with a descendant `code`): the language the
 * writer emits (the class, else a carried `language` parameter) and the code
 * text with XML line ends.
 */
function effectiveCodeBlockKey(pre: Element, code: Element): string {
  let language = (code.className.match(CODE_LANGUAGE_CLASS) ?? [])[1] ?? '';
  if (!language) {
    try {
      const carried: unknown = JSON.parse(pre.getAttribute('data-macro-params') ?? '');
      if (carried && typeof carried === 'object' && 'language' in carried && typeof carried.language === 'string') {
        language = carried.language;
      }
    } catch {
      // No carried language.
    }
  }
  return JSON.stringify([language, (code.textContent ?? '').replace(/\r\n?/g, '\n')]);
}

/** Facts of one HTML document, each read in a single walk (review r1 CM-6). */
interface DomFacts {
  /** Elements under a `div.figure-index` / `div.table-index` (htmlToConfluence removes those). */
  readonly inIndex: ReadonlySet<Element>;
  /** Elements that are, or stand under, a container htmlToConfluence drops or flattens. */
  readonly dropping: ReadonlySet<Element>;
  /** Elements that are, or stand under, a verified replayed original. */
  readonly trusted: ReadonlySet<Element>;
}

/** {@link isDroppingElement} on a DOM element. */
function isDroppingDomElement(el: Element): boolean {
  const tag = el.tagName;
  if (tag === 'SUMMARY' || tag === 'TEMPLATE' || el.classList.contains('confluence-drawio')) return true;
  if (tag === 'DIV' && DROPPING_DIV_CLASSES.some((name) => el.classList.contains(name))) return true;
  if (tag === 'SPAN' && DROPPING_SPAN_CLASSES.some((name) => el.classList.contains(name))) return true;
  const parent = el.parentElement;
  return tag === 'LI' && el.getAttribute('data-type') !== 'taskItem'
    && parent?.tagName === 'UL' && parent.getAttribute('data-type') === 'taskList';
}

function domFacts(body: Element, roots: ReadonlySet<Element>): DomFacts {
  const inIndex = new Set<Element>();
  const dropping = new Set<Element>();
  const trusted = new Set<Element>();
  const pending: Array<{ el: Element; index: boolean; drop: boolean; trust: boolean }> = [];
  for (let child = body.lastElementChild; child; child = child.previousElementSibling) {
    pending.push({ el: child, index: false, drop: false, trust: false });
  }
  while (pending.length > 0) {
    const { el, index, drop, trust } = pending.pop()!;
    if (index) inIndex.add(el);
    const ownDrop = drop || isDroppingDomElement(el);
    const ownTrust = trust || roots.has(el);
    if (ownDrop) dropping.add(el);
    if (ownTrust) trusted.add(el);
    const below = index || (el.tagName === 'DIV' && (el.classList.contains('figure-index') || el.classList.contains('table-index')));
    for (let child = el.lastElementChild; child; child = child.previousElementSibling) {
      pending.push({ el: child, index: below, drop: ownDrop, trust: ownTrust });
    }
  }
  return { inIndex, dropping, trusted };
}

/** Every effective code block outside the index blocks htmlToConfluence removes, with its key. */
function effectiveCodeBlocks(body: Element, facts: DomFacts): Array<{ pre: Element; key: string }> {
  const blocks: Array<{ pre: Element; key: string }> = [];
  for (const pre of body.querySelectorAll('pre')) {
    const code = pre.querySelector('code');
    if (!code || facts.inIndex.has(pre)) continue;
    blocks.push({ pre, key: effectiveCodeBlockKey(pre, code) });
  }
  return blocks;
}

/**
 * The placeholders whose `data-macro-name` htmlToConfluence writes as the
 * macro's `ac:name`: panels, expands, children, unknown and include macros.
 * A `data-macro-name` on any other element is an inert annotation (review r1
 * CM-5): the writer reads nothing from it.
 */
const NAMED_MACRO_PLACEHOLDER_SELECTOR = [
  '.panel-info', '.panel-warning', '.panel-note', '.panel-tip', 'details',
  'div.confluence-children-macro', 'div.confluence-macro-unknown', 'div.confluence-include-macro',
].join(', ');

/**
 * Y2: model-owned markup that names a code macro outside a fence or a plain
 * `pre`: a placeholder the writer turns into a macro named by its
 * `data-macro-name` with the value `code`, or raw macro markup
 * (`*:structured-macro` / `*:macro`) with a name-like attribute `code`.
 */
function isCodeNamedMarkup(el: Element): boolean {
  const name = el.getAttribute('data-macro-name');
  if (name !== null && name.trim().toLowerCase() === 'code' && el.matches(NAMED_MACRO_PLACEHOLDER_SELECTOR)) return true;
  const tag = el.tagName.toLowerCase();
  const local = tag.slice(tag.lastIndexOf(':') + 1);
  if (local !== 'structured-macro' && local !== 'macro') return false;
  return Array.from(el.attributes).some((attribute) =>
    attribute.name.slice(attribute.name.lastIndexOf(':') + 1).toLowerCase() === 'name'
    && attribute.value.trim().toLowerCase() === 'code');
}

function parseBody(html: string): Document {
  return new JSDOM(`<body>${html}</body>`, { contentType: 'text/html' }).window.document;
}

/** The element's outerHTML with one attribute left out, the element itself untouched. */
function outerHtmlWithout(el: Element, attribute: string): string {
  const copy = el.cloneNode(true) as Element;
  copy.removeAttribute(attribute);
  return copy.outerHTML;
}

/** Elements carrying `attribute="<nonce>-<i>"` exactly once, by `i`, for the indices `known` accepts. */
function authenticMarkers(doc: Document, attribute: string, nonce: string, known: (index: number) => boolean): Map<number, Element> {
  const pattern = new RegExp(`^${nonce}-(0|[1-9]\\d*)$`);
  const byValue = new Map<string, Element[]>();
  for (const el of doc.body.querySelectorAll(`[${attribute}]`)) {
    const value = el.getAttribute(attribute)!;
    const elements = byValue.get(value);
    if (elements) elements.push(el);
    else byValue.set(value, [el]);
  }
  const authentic = new Map<number, Element>();
  for (const [value, elements] of byValue) {
    const match = pattern.exec(value);
    if (match && elements.length === 1 && known(Number(match[1]))) authentic.set(Number(match[1]), elements[0]!);
  }
  return authentic;
}

/** One effective code block of the returned HTML, by ordinal of {@link codeBlockElements}. */
interface CodeBlockRecord {
  readonly key: string;
  readonly witness: LexerCodeText | null;
  readonly annotated: boolean;
  readonly className: string | null;
  readonly text: string;
}

/**
 * What the storage judgement may approve (#1958, design §3.5.1): the trusted
 * units (bound blocks, verified code-carrying originals, from #1953-2 on the
 * admitted legacy blocks) and the facts #1953's admission needs. Opaque.
 */
export interface CodeMacroAllowance {
  readonly carried: boolean;
  readonly units: readonly string[];
  readonly blocks: readonly CodeBlockRecord[];
}

interface CodeMacroAllowanceState extends CodeMacroAllowance {
  readonly units: string[];
  readonly keyCount: ReadonlyMap<string, number>;
  readonly references: Map<string, CodeMacroInventory>;
  /** admitLegacyCodeMetadata ran on this allowance. */
  admitted: boolean;
}

function allowanceState(allowance: CodeMacroAllowance): CodeMacroAllowanceState {
  return allowance as CodeMacroAllowanceState;
}

/** What {@link finalizeCodeMetadata} returns. */
export interface FinalizedCodeMetadata {
  /** The HTML to store or convert, markers removed. */
  readonly html: string;
  /** One entry per {@link codeBlockElements} element of `html`; empty unless witnesses were asked for. */
  readonly witnesses: ReadonlyArray<LexerCodeText | null>;
  readonly allowance: CodeMacroAllowance;
  readonly report: CodeMetaReport;
}

/**
 * #1958 HTML stage, after media replay: authenticate markers, verify replayed
 * originals, strip metadata from every model-owned `pre`, bind verified
 * fences to their stored values, apply the twin rule, then read every fact
 * from the document the returned string parses to and remove the markers.
 * Throws ImproveReplayError (an original not intact), or
 * ConfluenceStorageRefusedError('unapproved-code-macro') for model-owned
 * markup naming a code macro, before any of it reaches a writer.
 */
export function finalizeCodeMetadata(html: string, codeMeta: CodeMetaAccept): FinalizedCodeMetadata {
  const report = codeMeta.report;
  const { nonce, fences, skeleton } = codeMeta;
  let doc = parseBody(html);

  // 1–2. Authentic markers; every marked original verified before anything changes: exactly as written,
  // or with nothing but the CR / CR LF of its code text read as LF (review r1 CM-3). Anything else refuses.
  const fenceMarkers = authenticMarkers(doc, FENCE_MARKER, nonce, (j) => j < fences.length);
  const replayMarkers = authenticMarkers(doc, REPLAY_MARKER, nonce, (k) => codeMeta.replayed.has(k));
  for (const k of codeMeta.replayed) {
    const root = replayMarkers.get(k);
    const entry = codeMeta.entries[k]!;
    const marked = root ? outerHtmlWithout(root, REPLAY_MARKER) : null;
    if (marked === null || (marked !== entry.html && marked !== entry.lineEndForm)) throw new ImproveReplayError();
  }
  const trusted = new Set(replayMarkers.values());
  const facts = domFacts(doc.body, trusted);
  const fenceElements = new Set(fenceMarkers.values());
  const authentic = (el: Element, name: string): boolean =>
    (name === FENCE_MARKER && fenceElements.has(el)) || (name === REPLAY_MARKER && trusted.has(el));

  // Y2, then 3: model-owned markup.
  let changed = false;
  for (const el of doc.body.querySelectorAll('*')) {
    if (facts.trusted.has(el)) continue;
    if (isCodeNamedMarkup(el)) throw new ConfluenceStorageRefusedError('unapproved-code-macro');
    for (const { name } of Array.from(el.attributes)) {
      if (name.startsWith('data-cq-') && !authentic(el, name)) {
        el.removeAttribute(name);
        report.forged += 1;
        changed = true;
      }
    }
    if (el.tagName === 'PRE' && isAnnotatedCodeBlock(el)) {
      el.removeAttribute('data-title');
      el.removeAttribute('data-macro-params');
      report.stripped += 1;
      changed = true;
    }
  }

  // 4. Bind: the marked fence still in the exact shape marked rendered, outside every dropping container.
  const boundFences = new Map<number, Element>();
  for (const [j, pre] of fenceMarkers) {
    const fence = fences[j]!;
    if (fence.bound === null) continue;
    const block = skeleton[fence.bound]!;
    const code = onlyCodeChild(pre);
    if (pre.attributes.length !== 1 || !code || code.getAttribute('class') !== fence.className
      || code.attributes.length !== (fence.className === null ? 0 : 1) || code.textContent !== block.original
      || facts.dropping.has(pre)) continue;
    if (block.title !== null) pre.setAttribute('data-title', block.title);
    if (block.params !== null) pre.setAttribute('data-macro-params', block.params);
    boundFences.set(j, pre);
    report.bound += 1;
    changed = true;
  }

  // 5. Twin rule: equal effective blocks keep metadata only when all carry identical metadata.
  const groups = new Map<string, Element[]>();
  for (const { pre, key } of effectiveCodeBlocks(doc.body, facts)) {
    const members = groups.get(key);
    if (members) members.push(pre);
    else groups.set(key, [pre]);
  }
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const metadata = (pre: Element): string => JSON.stringify([pre.getAttribute('data-title'), pre.getAttribute('data-macro-params')]);
    const first = metadata(members[0]!);
    if (members.every((pre) => metadata(pre) === first)) continue;
    for (const pre of members) {
      if (!isAnnotatedCodeBlock(pre)) continue;
      pre.removeAttribute('data-title');
      pre.removeAttribute('data-macro-params');
      report.twins += 1;
      changed = true;
    }
  }
  for (const [j, pre] of boundFences) if (!isAnnotatedCodeBlock(pre)) boundFences.delete(j);
  // Y3: what each trusted root must read after the intentional changes above.
  const expectedRoots = new Map([...replayMarkers].map(([k, root]) => [k, outerHtmlWithout(root, REPLAY_MARKER)] as const));

  // 6. One re-serialisation; every fact below is read from the document the returned string parses to.
  let out = html;
  let finalFences = fenceMarkers;
  let finalRoots = replayMarkers;
  if (changed) {
    out = doc.body.innerHTML;
    doc = parseBody(out);
    finalFences = authenticMarkers(doc, FENCE_MARKER, nonce, (j) => fenceMarkers.has(j));
    finalRoots = authenticMarkers(doc, REPLAY_MARKER, nonce, (k) => replayMarkers.has(k));
    if (finalFences.size !== fenceMarkers.size || finalRoots.size !== replayMarkers.size) throw new ImproveReplayError();
    for (const [k, root] of finalRoots) {
      if (outerHtmlWithout(root, REPLAY_MARKER) !== expectedRoots.get(k)) throw new ImproveReplayError();
    }
    for (const j of boundFences.keys()) {
      const pre = finalFences.get(j)!;
      if (!onlyCodeChild(pre) || !isAnnotatedCodeBlock(pre)) throw new ImproveReplayError();
    }
  }

  // 7. Facts, then the markers' exact text removed in one pass.
  const roots = new Set(finalRoots.values());
  const finalFacts = changed ? domFacts(doc.body, roots) : facts;
  const boundElements = new Set([...boundFences.keys()].map((j) => finalFences.get(j)!));
  const witnessOf = new Map<Element, LexerCodeText>();
  for (const [j, pre] of finalFences) {
    const fence = fences[j]!;
    const code = onlyCodeChild(pre);
    if (fence.bound !== null || pre.attributes.length !== 1 || !code || finalFacts.trusted.has(pre)
      || code.getAttribute('class') !== fence.className || code.attributes.length !== (fence.className === null ? 0 : 1)
      || code.textContent !== `${fence.text.replace(/\n$/, '')}\n`
      || finalFacts.dropping.has(pre)) continue;
    witnessOf.set(pre, fence.text);
  }
  const keyCount = new Map<string, number>();
  for (const { key } of effectiveCodeBlocks(doc.body, finalFacts)) keyCount.set(key, (keyCount.get(key) ?? 0) + 1);
  const blocks = codeBlockElements(doc.body).map((pre): CodeBlockRecord => {
    const code = pre.querySelector('code')!;
    return {
      key: effectiveCodeBlockKey(pre, code),
      witness: codeMeta.witnesses ? witnessOf.get(pre) ?? null : null,
      annotated: isAnnotatedCodeBlock(pre),
      className: code.getAttribute('class'),
      text: code.textContent ?? '',
    };
  });
  const units = [
    ...[...boundElements].map((pre) => outerHtmlWithout(pre, FENCE_MARKER)),
    ...[...roots].map((root) => outerHtmlWithout(root, REPLAY_MARKER)),
  ];
  out = removeMarkerTexts(out, nonce, [
    ...[...finalFences.keys()].map((j) => ` ${FENCE_MARKER}="${nonce}-${j}"`),
    ...[...finalRoots.keys()].map((k) => ` ${REPLAY_MARKER}="${nonce}-${k}"`),
  ]);
  const allowance: CodeMacroAllowanceState = {
    carried: codeMeta.carried, units, blocks, keyCount, references: new Map(), admitted: false,
  };
  return { html: out, witnesses: codeMeta.witnesses ? blocks.map((block) => block.witness) : [], allowance, report };
}

/**
 * Removes each of `texts` (authentic marker attributes, values `[0-9a-f-]`)
 * from `html` in one pass; each must occur exactly once (review r1 CM-6:
 * not one split and join of the whole string per marker).
 */
function removeMarkerTexts(html: string, nonce: string, texts: readonly string[]): string {
  if (texts.length === 0) return html;
  const seen = new Map<string, number>(texts.map((text) => [text, 0] as const));
  const out = html.replace(new RegExp(` (?:${FENCE_MARKER}|${REPLAY_MARKER})="${nonce}-\\d+"`, 'g'), (text) => {
    const count = seen.get(text);
    if (count === undefined) return text;
    seen.set(text, count + 1);
    return '';
  });
  for (const count of seen.values()) if (count !== 1) throw new ImproveReplayError();
  return out;
}

/** One #1953 legacy operation: metadata for the block at `ordinal` of {@link codeBlockElements}. */
export interface LegacyCodeMetadataOp {
  ordinal: number;
  title: string | null;
  macroParams: string | null;
}

/**
 * #1953-2's third source of code metadata (design §4). An op is admitted only
 * when the page is not carried; its ordinal is a safe in-range integer no
 * earlier op named; `title` and `macroParams` are each a string or null, not
 * both null; the block has a witness (an unchanged plain fence), was not
 * annotated, and no other effective code block has its key. The admitted
 * unit is built from this block's record and the op's values. Returns the
 * number admitted; the storage judgement then accounts for exactly these.
 */
export function admitLegacyCodeMetadata(allowance: CodeMacroAllowance, ops: ReadonlyArray<LegacyCodeMetadataOp>): number {
  const state = allowanceState(allowance);
  // Once per finalized allowance (review r1): a second call would admit against units it already changed.
  if (state.admitted) throw new Error('admitLegacyCodeMetadata: already called for this allowance');
  state.admitted = true;
  if (state.carried) return 0;
  const named = new Set<number>();
  let admitted = 0;
  const doc = parseBody('');
  for (const op of ops) {
    if (!Number.isSafeInteger(op.ordinal) || op.ordinal < 0 || op.ordinal >= state.blocks.length) continue;
    if (named.has(op.ordinal)) continue;
    named.add(op.ordinal);
    const { title, macroParams } = op;
    if (!(typeof title === 'string' || title === null) || !(typeof macroParams === 'string' || macroParams === null)) continue;
    if (title === null && macroParams === null) continue;
    const block = state.blocks[op.ordinal]!;
    if (block.witness === null || block.annotated || (state.keyCount.get(block.key) ?? 0) !== 1) continue;
    const pre = doc.createElement('pre');
    if (title !== null) pre.setAttribute('data-title', title);
    if (macroParams !== null) pre.setAttribute('data-macro-params', macroParams);
    const code = doc.createElement('code');
    if (block.className !== null) code.setAttribute('class', block.className);
    code.textContent = block.text;
    pre.appendChild(code);
    state.units.push(pre.outerHTML);
    admitted += 1;
  }
  return admitted;
}

// --- storage stage -----------------------------------------------------------

/** Elements whose content an HTML consumer keeps as text or inert: a code macro there is never the writer's. */
const STORAGE_INERT_LOCALS = [
  'style', 'script', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'plaintext', 'textarea', 'title', 'template',
];

/**
 * Y1: a sound over-approximation of "this string may hold a start tag whose
 * local name is `macro` or `structured-macro`", with no assumption about the
 * prefix (any run of characters an XML name may hold, non-ASCII included).
 */
const CODE_MACRO_START_TAG = /<[^<> \t\r\n/]*macro[ \t\r\n\f/>]/i;

interface CodeMacroInventory {
  /** The record of every annotated canonical code macro, sorted: [parameters, body] as JSON. */
  readonly records: readonly string[];
  /** The keys of those records. */
  readonly recordKeys: ReadonlySet<string>;
  readonly bareKeys: readonly string[];
}

function refuseCodeMacro(): never {
  throw new ConfluenceStorageRefusedError('unapproved-code-macro');
}

/**
 * One bounded walk of a storage reading (design §3.5.1): every element that
 * resembles a code macro must be the writer's exact canonical shape in the
 * Confluence namespace outside every inert context; all macros with one key
 * (language, body) must carry identical records, bare and annotated being
 * different (Y1). Every element, attribute and compared character is charged
 * to `work` first. Throws the refusal.
 */
function inventoryCodeMacros(tree: StorageTree, work: number): CodeMacroInventory {
  let budget = work;
  const charge = (units: number): void => {
    budget -= units;
    if (budget < 0) refuseCodeMacro();
  };
  const textOnly = (el: StorageElement): string | null => {
    let text = '';
    for (const child of el.children) {
      if (typeof child !== 'string') return null;
      charge(child.length);
      text += child;
    }
    return text;
  };
  // Review r1 CM-6: an element costs its local name and every attribute's local name and value, which the
  // candidate test lower-cases, trims and compares, before any of that is inspected.
  const chargeElement = (el: StorageElement): void => {
    let units = 1 + el.local.length;
    for (const attribute of el.attributes) units += 1 + attribute.local.length + attribute.value.length;
    charge(units);
  };
  const records: string[] = [];
  const recordKeys = new Set<string>();
  const bareKeys: string[] = [];
  const recordByKey = new Map<string, string>();
  const pending: Array<{ el: StorageElement; inert: boolean }> = [{ el: tree.root, inert: false }];
  while (pending.length > 0) {
    const { el, inert } = pending.pop()!;
    chargeElement(el);
    const isRoot = el === tree.root;
    const candidate = !isRoot
      && (resemblesStorageName(el, 'structured-macro') || resemblesStorageName(el, 'macro'))
      && el.attributes.some((attribute) =>
        resemblesStorageName(attribute, 'name') && attribute.value.trim().toLowerCase() === 'code');
    if (candidate) {
      const name = el.attributes[0];
      if (inert || !isStorageName(el, 'ac', 'structured-macro') || el.attributes.length !== 1
        || !isStorageName(name!, 'ac', 'name') || name!.value !== 'code') refuseCodeMacro();
      const parameters: Array<[string, string]> = [];
      let body: string | null = null;
      for (const child of el.children) {
        if (typeof child === 'string' || body !== null) refuseCodeMacro();
        chargeElement(child);
        const text = textOnly(child);
        if (text === null) refuseCodeMacro();
        if (isStorageName(child, 'ac', 'parameter') && child.attributes.length === 1
          && isStorageName(child.attributes[0]!, 'ac', 'name')) {
          parameters.push([child.attributes[0]!.value, text]);
        } else if (isStorageName(child, 'ac', 'plain-text-body') && child.attributes.length === 0) {
          body = text;
        } else {
          refuseCodeMacro();
        }
      }
      if (body === null) refuseCodeMacro();
      const key = JSON.stringify([parameters.find(([parameter]) => parameter === 'language')?.[1] ?? '', body]);
      const record = JSON.stringify([parameters, body]);
      // The record and its key are built from charged text; comparing them costs their length once more.
      charge(record.length + key.length);
      const prior = recordByKey.get(key);
      if (prior !== undefined && prior !== record) refuseCodeMacro();
      recordByKey.set(key, record);
      const bare = parameters.length === 0 || (parameters.length === 1 && parameters[0]![0] === 'language');
      if (bare) {
        bareKeys.push(key);
      } else {
        records.push(record);
        recordKeys.add(key);
      }
      // A canonical code macro holds only text below its children.
      continue;
    }
    const below = inert || (!isRoot && STORAGE_INERT_LOCALS.some((local) => resemblesStorageName(el, local)));
    for (let index = el.children.length - 1; index >= 0; index -= 1) {
      const child = el.children[index]!;
      if (typeof child !== 'string') pending.push({ el: child, inert: below });
    }
  }
  return { records: records.sort(), recordKeys, bareKeys };
}

/**
 * The storage judgement's own reading of `storage` (review r1 CM-8: the
 * differential against the independent XML oracle compares this record for
 * record). `records`: every annotated canonical code macro as
 * `[[[name, text]…], body]` JSON, sorted; `bareKeys`: `[language, body]` JSON
 * of every bare one, in document order. Throws the refusal the judgement
 * would throw (read failure or `unapproved-code-macro`). Reads only.
 */
export function readCodeMacroInventory(storage: string, work: number = CODE_MACRO_WORK): { records: string[]; bareKeys: string[] } {
  const read = readConfluenceStorage(storage);
  if (!read.ok) throw new ConfluenceStorageRefusedError(read.reason);
  const inventory = inventoryCodeMacros(read.tree, work);
  return { records: [...inventory.records], bareKeys: [...inventory.bareKeys] };
}

const EMPTY_CODE_MACRO_INVENTORY: CodeMacroInventory = { records: [], recordKeys: new Set(), bareKeys: [] };

/** What the trusted units carry, converted with the same writer options and read by the same reader; cached per options. */
function referenceInventory(allowance: CodeMacroAllowance, options: HtmlToConfluenceOptions): CodeMacroInventory {
  const state = allowanceState(allowance);
  if (state.units.length === 0) return EMPTY_CODE_MACRO_INVENTORY;
  const cacheKey = JSON.stringify([
    state.units.length, options.previousStorage, options.linkOrigin === undefined ? '\u0000' : options.linkOrigin,
    options.legacyTasks === true, options.derivationFeatures ? [...options.derivationFeatures].sort() : null,
  ]);
  const cached = state.references.get(cacheKey);
  if (cached) return cached;
  const read = readConfluenceStorage(htmlToConfluence(state.units.join('\n'), options));
  if (!read.ok) refuseCodeMacro();
  const inventory = inventoryCodeMacros(read.tree, CODE_MACRO_WORK);
  state.references.set(cacheKey, inventory);
  return inventory;
}

/**
 * #1958 storage rule on one reading (design §3.5.1, Y1): (i) every code macro
 * candidate canonical, one record per key; (ii) the multiset of annotated
 * records equals the one the trusted units yield under the same writer
 * options; (iii) no bare macro shares the key of an approved record. Throws
 * ConfluenceStorageRefusedError('unapproved-code-macro').
 */
export function judgeCodeMacros(
  tree: StorageTree,
  allowance: CodeMacroAllowance,
  options: HtmlToConfluenceOptions = {},
  work: number = CODE_MACRO_WORK,
): void {
  const written = inventoryCodeMacros(tree, work);
  const reference = referenceInventory(allowance, options);
  if (written.records.length !== reference.records.length
    || written.records.some((record, index) => record !== reference.records[index])) refuseCodeMacro();
  if (written.bareKeys.some((key) => reference.recordKeys.has(key))) refuseCodeMacro();
}

/**
 * Remote exit: judges the exact storage `updatePage` receives, after
 * htmlToConfluence (its link stage included) and before the intent. A string
 * that cannot hold a macro start tag in any reading is not read: it passes
 * exactly when the units carry no record. Otherwise a read failure refuses.
 */
export function assertCodeMacroStorage(
  storage: string,
  allowance: CodeMacroAllowance,
  options: HtmlToConfluenceOptions = {},
): void {
  if (!CODE_MACRO_START_TAG.test(storage)) {
    if (referenceInventory(allowance, options).records.length > 0) refuseCodeMacro();
    return;
  }
  const read = readConfluenceStorage(storage);
  if (!read.ok) throw new ConfluenceStorageRefusedError(read.reason);
  judgeCodeMacros(read.tree, allowance, options);
}

/**
 * Local (standalone) exit, before the write transaction (X2, Q8 as ruled): no
 * fast path. P1 is the stored HTML converted as a version restore converts
 * it; P2 the HTML after the one re-serialisation relocation applies before
 * converting without stored storage. P2 is skipped only when both its input
 * and its options equal P1's. Every read failure, conversion refusal and rule
 * violation refuses.
 */
export function assertLocalCodeMacroProjections(
  html: string,
  allowance: CodeMacroAllowance,
  row: { body_storage: string | null },
  limits: StorageReaderLimits = STORAGE_READER_LIMITS,
): void {
  const judge = (storage: string, options: HtmlToConfluenceOptions): void => {
    const read = readConfluenceStorage(storage, limits);
    if (!read.ok) throw new ConfluenceStorageRefusedError(read.reason);
    judgeCodeMacros(read.tree, allowance, options);
  };
  const p1Options: HtmlToConfluenceOptions = { previousStorage: row.body_storage };
  judge(htmlToConfluence(html, p1Options), p1Options);
  const reserialised = parseBody(html).body.innerHTML;
  if (reserialised !== html || row.body_storage !== null) judge(htmlToConfluence(reserialised), {});
}

export interface HtmlToMarkdownOptions {
  /**
   * #765: emit [[[LAYOUT…]]] / [[[SECTION…]]] / [[[COLUMN…]]] boundary tokens
   * around layout containers so markdownToHtml() can rebuild them after the
   * AI-Improve round-trip. ONLY the Improve route's main-page conversion sets
   * this — every other flow (quality scoring, auto-tagging, diagram context,
   * version-compare summaries, sub-page context, imports) keeps the default
   * flattened output so raw tokens never leak into prompts or user-visible
   * text. Sub-page context in particular must stay token-free: truncated
   * sub-page token sequences can be echoed by the model into the parent
   * page's output and build layout that never existed on the parent.
   */
  layoutTokens?: boolean;
}

/**
 * Converts HTML to Markdown (for LLM consumption).
 */
export function htmlToMarkdown(html: string, options?: HtmlToMarkdownOptions): string {
  const layoutTokens = options?.layoutTokens === true;
  const turndownService = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  });
  turndownService.use(gfm);

  // Custom rule for task list items
  turndownService.addRule('taskListItem', {
    filter: (node) => node.nodeName === 'LI' && node.getAttribute('data-type') === 'taskItem',
    replacement: (content, node) => {
      const checked = (node as HTMLElement).getAttribute('data-checked') === 'true';
      const body = content.trim();
      // #1958 (review r1 CM-4, r2 CM2-4): an item that opens with a CODE-META line keeps its whole body inside
      // the item: the token stays on the marker line and every following line is indented to the item's content
      // column, so the fence (and what follows it) stays in this task item, directly below its token. Every other
      // item is written exactly as before.
      if (startsWithCodeMeta(body)) {
        return `${checked ? '- [x]' : '- [ ]'} ${body.replace(/\n(?!\n)/g, '\n  ')}\n`;
      }
      return `${checked ? '- [x]' : '- [ ]'} ${body}\n`;
    },
  });

  // Custom rule for status badges
  turndownService.addRule('confluenceStatus', {
    filter: (node) => node.nodeName === 'SPAN' && node.classList.contains('confluence-status'),
    replacement: (_content, node) => {
      const title = (node as HTMLElement).textContent?.trim() ?? '';
      return title ? `[STATUS: ${title}]` : '';
    },
  });

  if (layoutTokens) {
    // #1958: an annotated code block that can travel (classifyCodeBlock
    // `token`) is written as its fence with the CODE-META echo token on the
    // line directly above it. `n` is the block's index among the token blocks
    // of this DOM in document order, the list the Accept's skeleton reads too;
    // nothing counts emissions. Plain blocks keep turndown's own rule.
    let codeMetaOrdinals: Map<Node, number> | null = null;
    const codeMetaOrdinal = (node: Node): number | undefined => {
      if (!codeMetaOrdinals) {
        let root: Node = node;
        while (root.parentNode) root = root.parentNode;
        // turndown's own DOM (domino): a document node with querySelectorAll.
        const blocks = codeMetaTokenBlocks(root as Node & { querySelectorAll(selector: string): ArrayLike<Element> });
        codeMetaOrdinals = new Map(blocks.map((pre, n) => [pre as Node, n] as const));
      }
      return codeMetaOrdinals.get(node);
    };
    turndownService.addRule('codeBlockMeta', {
      filter: (node) => node.nodeName === 'PRE' && isAnnotatedCodeBlock(node) && codeMetaOrdinal(node) !== undefined,
      replacement: (_content, node) => {
        const pre = node as Element;
        const code = pre.firstChild as Element;
        const attrs = encodeCodeMetaAttrs(
          codeMetaOrdinal(pre)!, pre.getAttribute('data-title'), pre.getAttribute('data-macro-params'),
        );
        return `\n\n[[[CODE-META ${attrs}]]]\n${fenceFor(code.textContent ?? '', codeLanguageOf(code))}\n\n`;
      },
    });

    // #1955: Markdown keeps only a link's destination, so a navigable ri:url
    // (a real href with its carrier in the class) writes the carrier there
    // and markdownToHtml restores the pair (materializeConfluenceUrlLinks).
    // Improve only: every other caller (embeddings, diffs, tagging, quality,
    // sub-page context) keeps the real URL it gets from the stock link rule.
    turndownService.addRule('confluenceUrlLink', {
      filter: (node) =>
        node.nodeName === 'A' && !(node.getAttribute('href') ?? '').startsWith('#') && confluenceLinkCarrierOf(node) !== null,
      replacement: (content, node) => {
        const title = ((node as Element).getAttribute('title') ?? '').replace(/(\n+\s*)+/g, '\n');
        return `[${content}](${confluenceLinkCarrierOf(node as Element)}${title ? ` "${title.replace(/"/g, '\\"')}"` : ''})`;
      },
    });

    // #765: layout containers — emit boundary tokens as standalone lines so the
    // wrapper structure survives the markdown round-trip while the prose inside
    // stays editable by the LLM. markdownToHtml() rebuilds the divs from the
    // tokens (with a drop-guard if the LLM mangled them). Opt-in: ONLY the
    // AI-Improve main-page conversion sets `layoutTokens` (see
    // HtmlToMarkdownOptions) — everywhere else the rules below flatten instead.
    turndownService.addRule('confluenceLayout', {
      filter: (node) =>
        node.nodeName === 'DIV' && node.classList.contains('confluence-layout'),
      replacement: (content) => `\n\n[[[LAYOUT]]]\n\n${content.trim()}\n\n[[[/LAYOUT]]]\n\n`,
    });

    turndownService.addRule('confluenceLayoutSection', {
      filter: (node) =>
        node.nodeName === 'DIV' && node.classList.contains('confluence-layout-section'),
      replacement: (content, node) => {
        const raw = (node as HTMLElement).getAttribute('data-layout-type') ?? 'single';
        // Confluence layout types are lowercase identifiers (single, two_equal,
        // three_with_sidebars, …) — anything else would break the token line.
        const layoutType = /^[a-z_]+$/.test(raw) ? raw : 'single';
        return `\n\n[[[LAYOUT-SECTION ${layoutType}]]]\n\n${content.trim()}\n\n[[[/LAYOUT-SECTION]]]\n\n`;
      },
    });

    turndownService.addRule('confluenceLayoutCell', {
      filter: (node) =>
        node.nodeName === 'DIV' && node.classList.contains('confluence-layout-cell'),
      replacement: (content) => `\n\n[[[LAYOUT-CELL]]]\n\n${content.trim()}\n\n[[[/LAYOUT-CELL]]]\n\n`,
    });

    // #765: legacy section/column containers — same boundary-token treatment.
    // (When nested inside a constrained container these never reach turndown:
    // protectMedia froze them opaquely first.)
    turndownService.addRule('confluenceSection', {
      filter: (node) =>
        node.nodeName === 'DIV' && node.classList.contains('confluence-section'),
      replacement: (content, node) => {
        const border = (node as HTMLElement).getAttribute('data-border');
        const attrs = border === 'true' || border === 'false' ? ` border=${border}` : '';
        return `\n\n[[[SECTION${attrs}]]]\n\n${content.trim()}\n\n[[[/SECTION]]]\n\n`;
      },
    });

    turndownService.addRule('confluenceColumn', {
      filter: (node) =>
        node.nodeName === 'DIV' && node.classList.contains('confluence-column'),
      replacement: (content, node) => {
        const el = node as HTMLElement;
        // Prefer data-cell-width; fall back to the inline flex style (mirrors
        // htmlToConfluence). Only token-safe width values are carried.
        let width = el.getAttribute('data-cell-width');
        if (!width) {
          const m = (el.getAttribute('style') ?? '').match(/flex:\s*0\s+0\s+(\S+)/);
          if (m) width = m[1] ?? null;
        }
        const attrs = width && /^[\d.]+(%|px|em|rem)?$/.test(width) ? ` width=${width}` : '';
        return `\n\n[[[COLUMN${attrs}]]]\n\n${content.trim()}\n\n[[[/COLUMN]]]\n\n`;
      },
    });

    // #1221 stage 2: expand sections — same boundary-token treatment, so the
    // body prose inside a collapsible section is editable again. The title is
    // NOT: it rides percent-encoded in the token's `title` attr, so the summary
    // must be dropped from the converted content or it would be emitted twice
    // (once opaquely, once as prose the model would then rewrite into a body
    // paragraph). Only the FIRST direct-child summary is the section's title —
    // htmlToConfluence applies exactly that rule, and unwraps any other.
    // (A constrained expand never reaches turndown: protectMedia froze it.)
    turndownService.addRule('confluenceExpandSummary', {
      filter: (node) =>
        node.nodeName === 'SUMMARY' &&
        node.parentNode?.nodeName === 'DETAILS' &&
        firstDirectSummary(node.parentNode as Element) === (node as Element),
      replacement: () => '',
    });

    turndownService.addRule('confluenceExpand', {
      filter: (node) => node.nodeName === 'DETAILS',
      replacement: (content, node) =>
        `\n\n[[[EXPAND ${expandTokenAttrs(node as Element)}]]]\n\n${content.trim()}\n\n[[[/EXPAND]]]\n\n`,
    });
  } else {
    // Default (all non-Improve flows): pre-#765 flattened output — wrapper
    // structure is dropped, only the inner content survives. Modern
    // div.confluence-layout* wrappers need no rule: turndown's default DIV
    // handling already passes their content through.
    turndownService.addRule('confluenceSection', {
      filter: (node) =>
        node.nodeName === 'DIV' && node.classList.contains('confluence-section'),
      replacement: (content) => `\n${content.trim()}\n\n`,
    });

    turndownService.addRule('confluenceColumn', {
      filter: (node) =>
        node.nodeName === 'DIV' && node.classList.contains('confluence-column'),
      replacement: (content) => `\n${content.trim()}\n`,
    });
  }

  // Custom rule for the labels macro placeholder (#765). Only reached by
  // non-Improve flows (quality/auto-tag/diagram context) — the Improve path
  // opaque-protects the div via protectMedia before turndown runs.
  turndownService.addRule('confluenceLabels', {
    filter: (node) =>
      node.nodeName === 'DIV' && node.classList.contains('confluence-labels-macro'),
    replacement: () => '\n[Labels]\n\n',
  });

  // Custom rule for children macro placeholder
  turndownService.addRule('confluenceChildren', {
    filter: (node) =>
      node.nodeName === 'DIV' && node.classList.contains('confluence-children-macro'),
    replacement: () => '\n[Children pages]\n\n',
  });

  // Custom rule for attachments macro placeholder
  turndownService.addRule('confluenceAttachments', {
    filter: (node) =>
      node.nodeName === 'DIV' && node.classList.contains('confluence-attachments-macro'),
    replacement: () => '\n[Attachments]\n\n',
  });

  // Custom rule for panels
  turndownService.addRule('panel', {
    filter: (node) => {
      return node.nodeName === 'DIV' && /^panel-(info|warning|note|tip)$/.test(node.className);
    },
    replacement: (content, node) => {
      const type = (node as HTMLElement).className.replace('panel-', '').toUpperCase();
      const body = content.trim();
      // #1958 (review r1 CM-4, r2 CM2-4): a panel that opens with a CODE-META line quotes every line of its body,
      // so the token and its fence stay inside the quote the panel becomes; every other panel is unchanged.
      if (startsWithCodeMeta(body)) {
        return `\n> **${type}**:\n>\n${body.split('\n').map((line) => (line === '' ? '>' : `> ${line}`)).join('\n')}\n\n`;
      }
      return `\n> **${type}**: ${body}\n\n`;
    },
  });

  // Keep the editable source and preview identity through Markdown consumers.
  turndownService.addRule('confluenceDrawio', {
    filter: (node) => node.nodeName === 'DIV' && node.classList.contains('confluence-drawio'),
    replacement: (_content, node) => {
      const div = node as HTMLElement;
      const name = div.getAttribute('data-diagram-name') ?? 'diagram';
      const image = div.querySelector('img');
      const source = div.getAttribute('data-drawio-source');
      const xml = div.getAttribute('data-drawio-xml');
      const link = div.querySelector('a.drawio-edit-link');
      const metadata = { name, source, xml, src: image?.getAttribute('src') ?? null,
        alt: image?.getAttribute('alt') ?? null, href: link?.getAttribute('href') ?? null };
      const payload = source || xml || image || link ? JSON.stringify(metadata) : name;
      return `\n\n\`\`\`drawio\n${payload}\n\`\`\`\n\n`;
    },
  });

  return turndownService.turndown(html);
}

// ---------------------------------------------------------------------------
// #765: Confluence layout boundary tokens.
//
// Row/column structure (modern `ac:layout` grids and legacy section/column
// macros) has no Markdown representation, so the AI-Improve round-trip
// (htmlToMarkdown → LLM → markdownToHtml) used to flatten it. Unlike media
// (#723's opaque CQ_MEDIA_PLACEHOLDER swap), layout cells contain prose the
// LLM must still be able to edit — so htmlToMarkdown, when called with
// `{ layoutTokens: true }` (Improve main-page conversion ONLY), emits
// BOUNDARY tokens as standalone lines around the (still editable) cell
// content:
//
//   [[[LAYOUT]]] … [[[/LAYOUT]]]
//   [[[LAYOUT-SECTION two_equal]]] … [[[/LAYOUT-SECTION]]]
//   [[[LAYOUT-CELL]]] … [[[/LAYOUT-CELL]]]
//   [[[SECTION border=true]]] … [[[/SECTION]]]    (legacy ac:section macro)
//   [[[COLUMN width=50%]]] … [[[/COLUMN]]]        (legacy ac:column macro)
//
// markdownToHtml() rebuilds the corresponding div.confluence-* wrappers from
// the tokens, which htmlToConfluence then maps losslessly back to ac:layout*
// / section / column. Drop-guard: if the LLM mangled the tokens (unbalanced
// or invalid nesting), ALL tokens are stripped instead — content degrades to
// the pre-#765 flattened form, but the page is never corrupted and raw
// [[[…]]] text never reaches the saved page.
// ---------------------------------------------------------------------------

// Longest-first so LAYOUT never shadows LAYOUT-SECTION / LAYOUT-CELL.
// EXPAND (#1221 stage 2) shares no prefix with any of the others.
const LAYOUT_TOKEN_KINDS = 'LAYOUT-SECTION|LAYOUT-CELL|LAYOUT|SECTION|COLUMN|EXPAND';
const LAYOUT_TOKEN_BARE = String.raw`\[\[\[\/?(?:${LAYOUT_TOKEN_KINDS})(?:[ \t][^\]\n]*)?\]\]\]`;
const LAYOUT_TOKEN_CAPTURE = String.raw`\[\[\[(\/?)(${LAYOUT_TOKEN_KINDS})((?:[ \t][^\]\n]*)?)\]\]\]`;

interface LayoutToken { isClose: boolean; kind: string; attrs: string; }

// Fresh instance per use — global regexes are stateful via lastIndex.
function layoutTokenRegex(): RegExp {
  // Paragraph-wrapped form first so the lone wrapping <p> is consumed too.
  return new RegExp(`<p>\\s*${LAYOUT_TOKEN_CAPTURE}\\s*</p>|${LAYOUT_TOKEN_CAPTURE}`, 'g');
}

function parseLayoutToken(m: RegExpMatchArray): LayoutToken {
  return {
    isClose: (m[1] ?? m[4]) === '/',
    kind: (m[2] ?? m[5])!,
    attrs: (m[3] ?? m[6] ?? '').trim(),
  };
}

/**
 * Where each token kind may open, mirroring what htmlToConfluence can emit as
 * valid Confluence storage (ac:layout-section only directly inside ac:layout,
 * ac:layout-cell only inside a section, legacy column only inside a legacy
 * section, layouts only at top level). Anything else means the LLM rearranged
 * the tokens — flatten instead of risking invalid storage format.
 */
function layoutOpenAllowed(kind: string, stack: string[]): boolean {
  const top = stack[stack.length - 1];
  switch (kind) {
    case 'LAYOUT': return stack.length === 0;
    case 'LAYOUT-SECTION': return top === 'LAYOUT';
    case 'LAYOUT-CELL': return top === 'LAYOUT-SECTION';
    // #1221: Confluence permits a legacy section inside an expand body.
    case 'SECTION': return top === undefined || top === 'LAYOUT-CELL' || top === 'COLUMN' || top === 'EXPAND';
    case 'COLUMN': return top === 'SECTION';
    // #1221: an expand may sit at top level or anywhere prose may — including
    // inside another expand, which Confluence supports natively.
    case 'EXPAND':
      return top === undefined || top === 'LAYOUT-CELL' || top === 'SECTION' || top === 'COLUMN' || top === 'EXPAND';
    default: return false;
  }
}

function layoutOpenTag(kind: string, attrs: string): string {
  switch (kind) {
    case 'LAYOUT':
      return '<div class="confluence-layout">';
    case 'LAYOUT-SECTION': {
      const layoutType = /^[a-z_]+$/.test(attrs) ? attrs : 'single';
      return `<div class="confluence-layout-section" data-layout-type="${layoutType}">`;
    }
    case 'LAYOUT-CELL':
      return '<div class="confluence-layout-cell">';
    case 'SECTION': {
      const m = attrs.match(/^border=(true|false)$/);
      return m ? `<div class="confluence-section" data-border="${m[1]}">` : '<div class="confluence-section">';
    }
    case 'COLUMN': {
      const m = attrs.match(/^width=([\d.]+(?:%|px|em|rem)?)$/);
      if (!m) return '<div class="confluence-column">';
      const width = m[1]!;
      // Same safe-width rule as confluenceToHtml: only digits + unit get a style.
      const style = /^\d+(%|px|em|rem)$/.test(width) ? ` style="flex: 0 0 ${width}"` : '';
      return `<div class="confluence-column" data-cell-width="${width}"${style}>`;
    }
    case 'EXPAND': {
      // #1221 stage 2. Attribute order mirrors confluenceToHtml's forward pass
      // so a section that made the round-trip untouched serializes identically.
      // Every value is HTML-escaped: percent-encoding protects the TOKEN
      // grammar, escaping protects the HTML — a token echoed by a model can
      // carry raw `<script>` in its attrs.
      const { name, open, title, params } = parseExpandTokenAttrs(attrs);
      let tag = `<details data-macro-name="${escapeHtmlAttr(name)}"`;
      if (open) tag += ' open';
      if (isMacroParamsObject(params)) tag += ` data-macro-params="${escapeHtmlAttr(params)}"`;
      tag += '>';
      // #1227: always a summary, including for a token that carries no `title`
      // attribute at all. A blank one no longer costs anything — htmlToConfluence
      // now decides on the summary's text rather than its existence, so it emits
      // no `title` parameter for one — while a summary-LESS <details> is not
      // parseable by the TipTap schema (`content: 'detailsSummary block*'`) and
      // ejects its own body out of the section. That was reachable from here:
      // a model echoing `[[[EXPAND name=expand open=0 params=]]]` reaches this
      // rebuild through Improve-apply.
      return `${tag}<summary>${escapeHtmlText(title ?? '')}</summary>`;
    }
    // Unreachable: kinds are constrained by LAYOUT_TOKEN_KINDS in the regex.
    default:
      return '<div>';
  }
}

/** #1221: close tags stopped being uniform once EXPAND rebuilt a `<details>`. */
function layoutCloseTag(kind: string): string {
  return kind === 'EXPAND' ? '</details>' : '</div>';
}

/**
 * Rebuild div.confluence-layout* / -section / -column wrappers from boundary
 * tokens in marked's HTML output. All-or-nothing: the token sequence is
 * validated for balance + nesting first, so a single mangled token can never
 * produce unbalanced divs — instead every token is stripped (graceful
 * flatten) while the prose is kept.
 */
/** Balance + nesting check shared by the rebuild and the skeleton path. */
function layoutSequenceValid(tokens: { isClose: boolean; kind: string }[]): boolean {
  const stack: string[] = [];
  for (const t of tokens) {
    if (!t.isClose) {
      if (!layoutOpenAllowed(t.kind, stack)) return false;
      stack.push(t.kind);
    } else if (stack.pop() !== t.kind) {
      return false;
    }
  }
  return stack.length === 0;
}

function rebuildLayoutStructure(html: string): string {
  const tokens = [...html.matchAll(layoutTokenRegex())].map(parseLayoutToken);
  if (tokens.length === 0) return html;

  const valid = layoutSequenceValid(tokens);

  let i = 0;
  return html.replace(layoutTokenRegex(), () => {
    const t = tokens[i++]!;
    if (!valid) return ''; // drop-guard: strip the token, keep the prose
    return t.isClose ? layoutCloseTag(t.kind) : layoutOpenTag(t.kind, t.attrs);
  });
}

// ---------------------------------------------------------------------------
// #1221 review: token PROVENANCE on the skeleton path.
//
// The rebuild above re-discovers tokens in marked's HTML with a regex, which
// silently equates "text that looks like a token" with "a token this pipeline
// emitted". Those are not the same set, and the gap deletes pages:
//
//   turndown escapes literal `[[[EXPAND …]]]` prose to `\[\[\[…\]\]\]`, so the
//   markdown-side strict scan (and therefore all of #781's verification) does
//   not see it and reports the echo clean. marked then UN-escapes it, the
//   regex above re-discovers three opens against one close, the sequence fails
//   validation, and the all-or-nothing drop-guard strips EVERY token — the
//   page's real expand macro included. HTTP 200, page written, macro gone.
//   A balanced literal pair went the other way and FABRICATED a macro out of
//   the user's sentence.
//
// The fix is to stop re-discovering. When a skeleton is known, recovery has
// already produced a token stream verified against it, so those exact tokens
// are replaced by opaque sentinels BEFORE marked runs and consumed by identity
// afterwards. Bracket text that was never a token stays prose all the way
// through — it cannot join the balance count, cannot be stripped, and reaches
// the saved page verbatim. That also retires the backstop strip on this path,
// which was eating token-shaped text out of expand titles, macro parameters
// and the model's own commentary.
//
// Sentinels are plain alphanumerics: markdown cannot escape them, marked
// cannot emphasise or link them, and a collision with page text is excluded by
// construction (the prefix grows until it does not occur in the input).
// ---------------------------------------------------------------------------

const LAYOUT_SENTINEL_BASE = 'CQLAYOUTTOKEN';

function layoutSentinelPrefix(markdown: string): string {
  let prefix = LAYOUT_SENTINEL_BASE;
  while (markdown.includes(prefix)) prefix = `X${prefix}`;
  return prefix;
}

/** `…0E`, `…1E` — the trailing marker stops token 1 matching token 10's prefix. */
function layoutSentinel(prefix: string, index: number): string {
  return `${prefix}${index}E`;
}

/**
 * Swap each canonical token (outside code constructs — literal token text in a
 * fenced block is data) for its sentinel, in document order. The caller has
 * already verified this stream against the skeleton, so sentinel N is
 * skeleton[N].
 */
function sentinelizeLayoutTokens(markdown: string, prefix: string): { markdown: string; tokens: LayoutToken[] } {
  const tokens: LayoutToken[] = [];
  // A list marker immediately before a token is consumed with it: the token
  // becomes its own paragraph, so leaving the `-` behind emits an empty list
  // item. Safe to strip because only a token this pipeline is about to
  // sentinelize can match here — a literal one in page prose reaches this
  // point still turndown-escaped, which LAYOUT_TOKEN_CAPTURE does not match.
  const tokenWithListMarker = new RegExp(
    String.raw`(?:(?:^|\n)[ \t]*(?:[-*+]|\d+[.)])[ \t]+)?` + LAYOUT_TOKEN_CAPTURE,
    'g',
  );
  const out = transformOutsideMarkdownCode(markdown, (segment) =>
    segment.replace(tokenWithListMarker, (...args: unknown[]) => {
      const m = args.slice(0, 4) as [string, string, string, string | undefined];
      tokens.push({ isClose: m[1] === '/', kind: m[2], attrs: (m[3] ?? '').trim() });
      return `\n\n${layoutSentinel(prefix, tokens.length - 1)}\n\n`;
    }),
  );
  return { markdown: out, tokens };
}

/**
 * Consume the sentinels marked wrapped in paragraphs.
 *
 * #1232 round 2: renders each token's OWN payload, not `skeleton[index]`. The
 * recovered stream is a permutation of the skeleton whenever the model
 * reordered sections, so indexing the skeleton here would put the first
 * section's title on whichever body came first.
 */
function rebuildLayoutFromSentinels(html: string, prefix: string, tokens: LayoutToken[]): string {
  const pattern = new RegExp(`<p>\\s*${prefix}(\\d+)E\\s*</p>|${prefix}(\\d+)E`, 'g');
  return html.replace(pattern, (matched, wrapped: string | undefined, bare: string | undefined) => {
    const token = tokens[Number(wrapped ?? bare)];
    if (!token) return matched;
    return token.isClose ? layoutCloseTag(token.kind) : layoutOpenTag(token.kind, token.attrs);
  });
}

// #765 review follow-up: literal token text inside code is DATA, not
// structure (e.g. documentation about the token syntax itself). Rebuilding
// or stripping it would mutate code content, and a stray token-shaped string
// in a code block could poison the all-or-nothing validation for the real
// tokens. Both the markdown normalization and the HTML rebuild/backstop
// therefore skip code regions.

// Markdown code constructs: fenced blocks (``` / ~~~, unterminated fences run
// to end-of-input, matching marked) and inline code spans.
const MARKDOWN_CODE_SEGMENT =
  /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|``[^`][\s\S]*?``|`[^`\n]*`)/g;

/** Apply `transform` to every part of `markdown` that is NOT a code construct. */
function transformOutsideMarkdownCode(markdown: string, transform: (segment: string) => string): string {
  // split() with a capturing group keeps the separators at odd indexes.
  return markdown
    .split(MARKDOWN_CODE_SEGMENT)
    .map((segment, i) => (i % 2 === 1 ? segment : transform(segment)))
    .join('');
}

/** Apply `transform` to every part of `html` outside <pre>/<code> elements. */
function transformOutsideHtmlCode(html: string, transform: (segment: string) => string): string {
  const regions: string[] = [];
  // <pre> first so a whole <pre><code>…</code></pre> block masks as one unit.
  // NUL-delimited placeholders cannot collide with marked's HTML output.
  const masked = html.replace(/<pre[\s>][\s\S]*?<\/pre\s*>|<code[\s>][\s\S]*?<\/code\s*>/gi, (m) => {
    regions.push(m);
    return `\u0000CQ_CODE_REGION_${regions.length - 1}\u0000`;
  });
  // eslint-disable-next-line no-control-regex -- NUL delimiter is intentional: it cannot occur in marked HTML output
  return transform(masked).replace(/\u0000CQ_CODE_REGION_(\d+)\u0000/g, (m, i) => regions[Number(i)] ?? m);
}

// ---------------------------------------------------------------------------
// #781: skeleton-guided recovery of LLM-mangled layout tokens.
//
// #774's all-or-nothing drop-guard silently flattened the layout whenever a
// real model mangled a single [[[…]]] token — which local models do routinely
// (case changes, merged lines, dropped closes, dropped section args, code
// fences around tokens, translations). The fix exploits the one thing the
// LLM cannot corrupt: the system KNOWS the expected token skeleton, because
// it generated it from the original document. Recovery therefore never
// trusts the LLM's echo — it ALIGNS whatever came back against the known
// skeleton:
//
//   1. extractLayoutSkeleton() derives the expected open/close token sequence
//      (with section types / column widths) from the page's own body HTML —
//      deterministic, like #723's media tokens, so nothing is persisted.
//   2. Strictness ladder (#785 review): candidates are first scanned with
//      scanStrictLayoutTokenSpans() (canonical spellings only) — when the
//      echo's real tokens are intact, token lookalikes in user prose (e.g.
//      a literal "[[[layout]]]") survive as prose. Only when the strict scan
//      cannot align the FULL skeleton does scanLooseLayoutTokens() run,
//      recognizing realistic mangled spellings (outside code constructs).
//   3. alignLayoutTokens() greedily maps them, in order, onto the skeleton.
//      Close tokens and pure container opens (LAYOUT, LAYOUT-SECTION) are
//      re-derivable, so they may be dropped; every PROSE-BEARING open
//      (LAYOUT-CELL / COLUMN / SECTION) must be found — otherwise cell
//      boundaries are genuinely lost (e.g. the model merged two cells).
//   4. reconstructLayoutMarkdown() rewrites the markdown with CANONICAL
//      tokens from the skeleton (types/widths always from the skeleton,
//      never from the echo), strips unmatched token debris, and keeps prose
//      out of slots where the storage format allows none.
//   5. The result is verified token-for-token against the skeleton before
//      use. Any residual mismatch — and any unrecoverable mangling — throws
//      LayoutRecoveryError so the caller can reject the apply instead of
//      silently flattening the page. Exception (#785 review): a skeleton
//      with exactly ONE prose-bearing slot is unambiguous even when every
//      token was dropped — wrapProseInSingleSlot() places all prose in it.
//   6. Anchor split (last resort, MULTI-slot): when the model dropped every
//      token but each cell's LEADING PROSE (captured as `anchor` on the
//      skeleton by extractLayoutSkeleton) survives uniquely and in order,
//      splitProseByAnchors() re-slots the prose deterministically.
//      All-or-nothing: any missing, duplicated, or out-of-order anchor —
//      or unrecognized token-shaped remnants — falls through to the error.
// ---------------------------------------------------------------------------

export interface LayoutSkeletonToken {
  kind: string;
  isClose: boolean;
  attrs: string;
  /**
   * Leading text of a prose-bearing open (first non-empty block of the cell,
   * whitespace-collapsed, capped). Used by the anchor-based last-resort
   * recovery: when the model dropped EVERY token, the cells' leading prose
   * usually survives the rewrite and marks where each cell's content starts.
   * Absent on close tokens, pure containers, and empty cells.
   */
  anchor?: string;
}

export class LayoutRecoveryError extends Error {
  constructor(
    public readonly details: { expectedTokens: number; recoveredTokens: number },
  ) {
    super('AI output lost the page layout: boundary tokens could not be recovered');
    this.name = 'LayoutRecoveryError';
  }
}

const LAYOUT_SECTION_TYPE_RE = /^[a-z_]+$/;
const COLUMN_WIDTH_RE = /^[\d.]+(%|px|em|rem)?$/;

/** Token kind + canonical attrs for a layout wrapper element (else null). */
function layoutWrapperKind(el: Element): { kind: string; attrs: string } | null {
  // #1221 stage 2: every `<details>` is an expand macro — `data-macro-name` is
  // only the identity STAMP, and a section predating it (or created in the
  // editor) carries none. Requiring the attribute here would leave those
  // sections without a token AND without the freeze, i.e. back to the silent
  // macro deletion this issue is about.
  if (isExpandSection(el)) return { kind: 'EXPAND', attrs: expandTokenAttrs(el) };
  const cls = el.classList;
  if (cls.contains('confluence-layout')) return { kind: 'LAYOUT', attrs: '' };
  if (cls.contains('confluence-layout-section')) {
    const raw = el.getAttribute('data-layout-type') ?? 'single';
    return { kind: 'LAYOUT-SECTION', attrs: LAYOUT_SECTION_TYPE_RE.test(raw) ? raw : 'single' };
  }
  if (cls.contains('confluence-layout-cell')) return { kind: 'LAYOUT-CELL', attrs: '' };
  if (cls.contains('confluence-section')) {
    const border = el.getAttribute('data-border');
    return { kind: 'SECTION', attrs: border === 'true' || border === 'false' ? `border=${border}` : '' };
  }
  if (cls.contains('confluence-column')) {
    let width = el.getAttribute('data-cell-width');
    if (!width) {
      const m = (el.getAttribute('style') ?? '').match(/flex:\s*0\s+0\s+(\S+)/);
      if (m) width = m[1] ?? null;
    }
    return { kind: 'COLUMN', attrs: width && COLUMN_WIDTH_RE.test(width) ? `width=${width}` : '' };
  }
  return null;
}

/** Max anchor length: long enough to be unique, short enough to survive edits. */
const ANCHOR_MAX_CHARS = 80;

/**
 * Text of `node` as the model will see it in the markdown.
 *
 * #1221: every `<summary>` is an expand's TITLE — it rides inside that
 * section's own EXPAND token and never reaches the markdown. Anchoring on one
 * would search the model's prose for text the model was never shown. Nested
 * summaries count as much as the element's own: a cell whose first child is an
 * expand, or an expand wrapping another, would otherwise anchor on a title.
 */
function markdownVisibleText(node: Node): string {
  if (node.nodeType === 3 /* TEXT_NODE */) return node.textContent ?? '';
  if (node.nodeType !== 1 /* ELEMENT_NODE */) return '';
  if (node.nodeName === 'SUMMARY') return '';
  let text = '';
  for (const child of Array.from(node.childNodes)) text += markdownVisibleText(child);
  return text;
}

/** First non-empty block text of a cell — the anchor for token-free recovery. */
function leadingAnchorText(el: Element): string | undefined {
  const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType !== 1 /* ELEMENT_NODE */) continue;
    const t = collapse(markdownVisibleText(child));
    if (t) return t.slice(0, ANCHOR_MAX_CHARS);
  }
  const own = collapse(markdownVisibleText(el));
  return own ? own.slice(0, ANCHOR_MAX_CHARS) : undefined;
}

/**
 * Derive the expected layout-token skeleton from body HTML. Mirrors the
 * token emission rules of htmlToMarkdown({ layoutTokens: true }) exactly:
 * same kinds, same attrs validation, and frozen legacy wrappers (nested in
 * markdown-constrained containers — see protectMedia) are skipped because
 * they travel opaquely, never as boundary tokens.
 */
export function extractLayoutSkeleton(html: string): LayoutSkeletonToken[] {
  const dom = new JSDOM(`<body>${html}</body>`);
  const tokens: LayoutSkeletonToken[] = [];
  const visit = (el: Element): void => {
    if (isFrozenLegacyWrapper(el)) return; // opaque-protected whole — no tokens
    const wrapper = layoutWrapperKind(el);
    if (wrapper) {
      const open: LayoutSkeletonToken = { kind: wrapper.kind, isClose: false, attrs: wrapper.attrs };
      if (PROSE_BEARING_KINDS.has(wrapper.kind)) {
        const anchor = leadingAnchorText(el);
        if (anchor) open.anchor = anchor;
      }
      tokens.push(open);
    }
    for (const child of Array.from(el.children)) visit(child);
    // Close tokens carry no attrs (matching their canonical [[[/KIND]]] form).
    if (wrapper) tokens.push({ kind: wrapper.kind, isClose: true, attrs: '' });
  };
  for (const child of Array.from(dom.window.document.body.children)) visit(child);
  return tokens;
}

// Tolerant recognition of mangled token spellings: 2–4 bracket runs (incl.
// markdown-escaped \[), optional emphasis wrappers, `/` or `\` closes,
// hyphen→underscore/space kind variants, arbitrary junk attrs, lower/mixed
// case. Prose collisions (e.g. "[[Section 2]]" wiki-style links) are kept
// out by requiring EXACTLY three brackets for case-insensitive matches —
// other bracket counts only count when the kind is spelled all-uppercase.
// #1221 stage 2: EXPAND joins the tolerant set for the same reason the other
// prose-bearing kinds are in it. Left out, a routinely-mangled spelling (a
// lower-cased close, a fenced token) would make the most common macro on a
// page the ONLY kind the loose pass cannot rescue, turning ordinary local-model
// churn into a 422.
const LAYOUT_KIND_LOOSE = 'LAYOUT[-_ ]SECTION|LAYOUT[-_ ]CELL|LAYOUT|SECTION|COLUMN|EXPAND';
const LAYOUT_TOKEN_LOOSE_SRC =
  String.raw`(?:\*{1,2}|_{1,2})?` +
  String.raw`((?:\\?\[){2,4})` +
  String.raw`[ \t]*([/\\])?[ \t]*` +
  String.raw`(${LAYOUT_KIND_LOOSE})` +
  String.raw`((?:[^\]\n\\]|\\[^\]\n])*)` +
  String.raw`(?:\\?\]){2,4}` +
  String.raw`(?:\*{1,2}|_{1,2})?`;

/**
 * `attrs` is the token's own payload as the model echoed it. It is what makes
 * alignment able to follow IDENTITY rather than position (#1232 round 2) — a
 * reordered expand must take its title with it. Empty when the spelling was
 * too mangled to read one.
 */
interface ScannedLayoutToken { start: number; end: number; kind: string; isClose: boolean; attrs: string; }

/** Kind + direction + payload — what makes two tokens the same section. */
function tokenIdentity(t: { kind: string; isClose: boolean; attrs: string }): string {
  return `${t.isClose ? '/' : ''}${t.kind}|${t.attrs}`;
}

/**
 * Canonical shape of a token stream: the nesting tree, with each level's
 * siblings sorted so their ORDER does not matter but their PARENT does.
 * Returns null when the stream is unbalanced.
 *
 * #1232 round 3. Comparing multisets alone accepted any re-nesting of the same
 * tokens — including a section the reader could see being moved INSIDE a
 * collapsed one. Content is not lost that way, but it disappears behind a
 * toggle, which is the harm that made the token-free recovery paths refuse.
 * Sorting siblings is exactly the licence the fast path is meant to grant:
 * reordering is allowed, re-parenting is not.
 */
function canonicalTokenShape(tokens: { kind: string; isClose: boolean; attrs: string }[]): string | null {
  interface Node { kind: string; identity: string; children: Node[] }
  const roots: Node[] = [];
  const stack: Node[] = [];
  for (const t of tokens) {
    if (!t.isClose) {
      const node: Node = { kind: t.kind, identity: tokenIdentity(t), children: [] };
      (stack[stack.length - 1]?.children ?? roots).push(node);
      stack.push(node);
    } else {
      // Closes carry no payload, so only the kind can be matched here.
      const open = stack.pop();
      if (!open || open.kind !== t.kind) return null;
    }
  }
  if (stack.length > 0) return null;
  const render = (nodes: Node[]): string =>
    nodes.map((n) => `${n.identity}(${render(n.children)})`).sort().join(',');
  return render(roots);
}

function sameTokenShape(
  found: { kind: string; isClose: boolean; attrs: string }[],
  skeleton: LayoutSkeletonToken[],
): boolean {
  if (found.length !== skeleton.length) return false;
  const a = canonicalTokenShape(found);
  return a !== null && a === canonicalTokenShape(skeleton);
}

/** Scan markdown (outside code constructs) for mangled-token candidates. */
function scanLooseLayoutTokens(markdown: string): ScannedLayoutToken[] {
  const tokens: ScannedLayoutToken[] = [];
  let offset = 0;
  for (const [i, part] of markdown.split(MARKDOWN_CODE_SEGMENT).entries()) {
    if (i % 2 === 0) {
      for (const m of part.matchAll(new RegExp(LAYOUT_TOKEN_LOOSE_SRC, 'gi'))) {
        const brackets = (m[1]!.match(/\[/g) ?? []).length;
        const rawKind = m[3]!;
        // Non-3-bracket spellings must be all-uppercase to count as tokens.
        if (brackets !== 3 && rawKind !== rawKind.toUpperCase()) continue;
        tokens.push({
          start: offset + m.index,
          end: offset + m.index + m[0].length,
          kind: rawKind.toUpperCase().replace(/[_ ]/g, '-'),
          isClose: m[2] !== undefined,
          // Mangled spellings carry mangled payloads; read it anyway so an
          // identity contradiction can still be detected, never trusted.
          attrs: (m[4] ?? '').trim(),
        });
      }
    }
    offset += part.length;
  }
  return tokens;
}

// #785 review (strictness ladder): canonical-spelling-only spans — exactly
// `[[[`, optional `/`, UPPERCASE kind, optional attrs, `]]]`. The lookarounds
// reject tokens touching emphasis/bracket/escape decoration (e.g.
// **[[[LAYOUT-CELL]]]** or [[[[/LAYOUT]]]]): a decorated token counts as
// MANGLED — handled by the loose pass, which consumes the decoration too —
// instead of leaving the stray `**` / `[` behind as prose.
const LAYOUT_TOKEN_STRICT_SPAN_SRC = String.raw`(?<![*_\[\\])${LAYOUT_TOKEN_CAPTURE}(?![*_\]])`;

/**
 * Position-aware STRICT scan (outside code constructs): canonical token
 * spellings only. Same shape as scanLooseLayoutTokens so both can feed
 * alignLayoutTokens — see the strictness ladder in recoverLayoutMarkdown.
 */
function scanStrictLayoutTokenSpans(markdown: string): ScannedLayoutToken[] {
  const tokens: ScannedLayoutToken[] = [];
  let offset = 0;
  for (const [i, part] of markdown.split(MARKDOWN_CODE_SEGMENT).entries()) {
    if (i % 2 === 0) {
      for (const m of part.matchAll(new RegExp(LAYOUT_TOKEN_STRICT_SPAN_SRC, 'g'))) {
        tokens.push({
          start: offset + m.index,
          end: offset + m.index + m[0].length,
          kind: m[2]!,
          isClose: m[1] === '/',
          attrs: (m[3] ?? '').trim(),
        });
      }
    }
    offset += part.length;
  }
  return tokens;
}

/** Does this line consist of exactly one loose token? */
function isLooseTokenLine(line: string): boolean {
  return new RegExp(`^(?:${LAYOUT_TOKEN_LOOSE_SRC})$`, 'i').test(line);
}

/**
 * Unwrap code constructs whose ENTIRE content is layout-token lines — the
 * "model fenced the tokens" failure mode. Genuine token documentation in
 * code blocks always carries surrounding prose lines and is left alone; and
 * candidate selection (below) prefers the un-unwrapped markdown whenever it
 * aligns equally well, so code-as-data is only consumed when the alternative
 * is losing the layout.
 */
function unwrapTokenOnlyCode(markdown: string): string {
  return markdown.replace(MARKDOWN_CODE_SEGMENT, (seg) => {
    let inner: string | undefined;
    let m = seg.match(/^(?:```|~~~)[^\n]*\n([\s\S]*?)(?:```|~~~)?\s*$/);
    if (m) inner = m[1];
    else if ((m = seg.match(/^``([\s\S]+)``$/) ?? seg.match(/^`([^`\n]+)`$/))) inner = m[1];
    if (inner === undefined) return seg;
    const lines = inner.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    if (lines.length === 0 || !lines.every(isLooseTokenLine)) return seg;
    return `\n\n${lines.join('\n\n')}\n\n`;
  });
}

/** Unwrap a single code fence spanning the whole document, if present. */
function unwrapFullDocumentFence(markdown: string): string | null {
  const m = markdown.trim().match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
  return m ? m[1]! : null;
}

// Opens that carry prose: if one of these cannot be aligned, a cell boundary
// is genuinely lost and recovery must fail. LAYOUT / LAYOUT-SECTION opens
// are pure containers (the storage format puts nothing between them and
// their first child), so their positions are re-derivable from neighbors.
const PROSE_BEARING_KINDS = new Set(['LAYOUT-CELL', 'COLUMN', 'SECTION', 'EXPAND']);

/**
 * Greedy in-order alignment of scanned tokens onto the skeleton.
 *
 * #1232 round 2 added two rejections, because this function decides WHERE a
 * section boundary lands and both failures put a real macro's identity on the
 * wrong body at HTTP 200:
 *
 * - `surplus` counts echo tokens that matched nothing. They used to be
 *   stripped as debris, which quietly let a token-shaped fragment ANCHOR the
 *   alignment: an escape-stripped prose literal (models drop backslashes when
 *   echoing) took the skeleton's first slot, and the real section's boundary
 *   moved to the prose. On a non-empty skeleton the caller now refuses.
 * - `identityConflict` is true when a matched echo token's own payload names a
 *   DIFFERENT section of the same kind. Position said one thing and the token
 *   said another, so positional assignment would swap two titles. A payload
 *   that names no skeleton section at all is not a conflict — that is the
 *   model editing a title, where the skeleton is meant to win.
 */
function alignLayoutTokens(
  found: ScannedLayoutToken[],
  skeleton: LayoutSkeletonToken[],
): { matched: number[]; ok: boolean; matchedCount: number; surplus: number; identityConflict: boolean } {
  const matched: number[] = new Array<number>(skeleton.length).fill(-1);
  let s = 0;
  let surplus = 0;
  for (let f = 0; f < found.length; f++) {
    let k = s;
    while (k < skeleton.length && !(skeleton[k]!.kind === found[f]!.kind && skeleton[k]!.isClose === found[f]!.isClose)) k++;
    if (k < skeleton.length) {
      matched[k] = f;
      s = k + 1;
    } else {
      surplus++;
    }
  }
  const identityConflict = matched.some((f, i) => {
    if (f === -1) return false;
    const echoed = found[f]!;
    const target = skeleton[i]!;
    if (!echoed.attrs || echoed.attrs === target.attrs) return false;
    return skeleton.some(
      (other, j) =>
        j !== i && other.kind === target.kind && other.isClose === target.isClose && other.attrs === echoed.attrs,
    );
  });
  const ok = skeleton.every((t, i) => matched[i] !== -1 || t.isClose || !PROSE_BEARING_KINDS.has(t.kind));
  return { matched, ok, matchedCount: matched.filter((f) => f !== -1).length, surplus, identityConflict };
}

function canonicalLayoutToken(t: LayoutSkeletonToken): string {
  return t.isClose ? `[[[/${t.kind}]]]` : `[[[${t.kind}${t.attrs ? ` ${t.attrs}` : ''}]]]`;
}

/** Prose may live at top level and inside cells/columns/sections/expands. */
function proseAllowedIn(stack: string[]): boolean {
  const top = stack[stack.length - 1];
  return (
    top === undefined || top === 'LAYOUT-CELL' || top === 'COLUMN' || top === 'SECTION' || top === 'EXPAND'
  );
}

/**
 * Rewrite the markdown with canonical skeleton tokens at the aligned
 * positions. Dropped tokens are re-inserted just before the next aligned
 * anchor (or at the end); unmatched token debris is stripped; prose that
 * would land in a slot the storage format forbids (e.g. between two cells,
 * directly inside a section) is deferred into the next valid slot.
 */
function reconstructLayoutMarkdown(
  markdown: string,
  found: ScannedLayoutToken[],
  matched: number[],
  skeleton: LayoutSkeletonToken[],
): string {
  const matchedFound = new Set(matched.filter((f) => f !== -1));
  const debris = found.filter((_, i) => !matchedFound.has(i));
  const sliceWithoutDebris = (from: number, to: number): string => {
    let out = '';
    let pos = from;
    for (const d of debris) {
      if (d.end <= from || d.start >= to) continue;
      out += markdown.slice(pos, Math.max(d.start, from));
      pos = Math.min(d.end, to);
    }
    return out + markdown.slice(pos, to);
  };

  const out: string[] = [];
  const stack: string[] = [];
  let pendingText = '';
  let pendingDropped: LayoutSkeletonToken[] = [];
  let cursor = 0;

  const placeText = (raw: string): void => {
    const seg = raw
      .replace(/^\n+|\n+$/g, '') // outer newlines only — keep code indentation
      // A list marker left dangling at the end of a segment is the remains of a
      // token the model wrote on a list line; keeping it emits an empty list
      // item next to the rebuilt wrapper (#1232 round 3).
      .replace(/(?:^|\n)[ \t]*(?:[-*+]|\d+[.)])[ \t]*$/, '');
    if (seg.trim().length === 0) return;
    if (proseAllowedIn(stack)) out.push(`\n\n${seg}\n\n`);
    else pendingText += (pendingText ? '\n\n' : '') + seg;
  };
  const placeToken = (t: LayoutSkeletonToken): void => {
    out.push(`\n\n${canonicalLayoutToken(t)}\n\n`);
    if (t.isClose) stack.pop();
    else stack.push(t.kind);
    if (pendingText && proseAllowedIn(stack)) {
      out.push(`\n\n${pendingText}\n\n`);
      pendingText = '';
    }
  };

  for (let i = 0; i < skeleton.length; i++) {
    const f = matched[i]!;
    if (f === -1) {
      pendingDropped.push(skeleton[i]!);
      continue;
    }
    const tok = found[f]!;
    placeText(sliceWithoutDebris(cursor, tok.start));
    cursor = tok.end;
    for (const d of pendingDropped) placeToken(d);
    pendingDropped = [];
    placeToken(skeleton[i]!);
  }
  placeText(sliceWithoutDebris(cursor, markdown.length));
  for (const d of pendingDropped) placeToken(d);
  if (pendingText) out.push(`\n\n${pendingText}\n\n`);
  return out.join('');
}

/** Strict token sequence (outside code constructs) of a markdown string. */
function scanStrictLayoutTokens(markdown: string): LayoutToken[] {
  const tokens: LayoutToken[] = [];
  for (const [i, part] of markdown.split(MARKDOWN_CODE_SEGMENT).entries()) {
    if (i % 2 !== 0) continue;
    for (const m of part.matchAll(new RegExp(LAYOUT_TOKEN_CAPTURE, 'g'))) {
      tokens.push({ isClose: m[1] === '/', kind: m[2]!, attrs: (m[3] ?? '').trim() });
    }
  }
  return tokens;
}

/** Fail-closed verification: strict token sequence equals the skeleton. */
function matchesSkeleton(markdown: string, skeleton: LayoutSkeletonToken[]): boolean {
  const strict = scanStrictLayoutTokens(markdown);
  return (
    strict.length === skeleton.length &&
    strict.every(
      (t, i) => t.kind === skeleton[i]!.kind && t.isClose === skeleton[i]!.isClose && t.attrs === skeleton[i]!.attrs,
    )
  );
}

/**
 * Last-resort recovery for skeletons with exactly ONE prose-bearing slot
 * (#785 review): even when alignment found nothing — the model dropped
 * every token — there is no ambiguity about where the prose belongs. Emit
 * the skeleton's canonical tokens in order and place ALL (debris-stripped)
 * prose inside that single slot. Multi-slot skeletons stay unrecoverable:
 * assigning prose to one of several cells would be a guess.
 *
 * Built explicitly rather than via reconstructLayoutMarkdown: its
 * trailing-dropped-token path appends unmatched tokens AFTER the prose,
 * which would leave the prose at top level and the rebuilt layout empty.
 */
function wrapProseInSingleSlot(markdown: string, skeleton: LayoutSkeletonToken[]): string {
  // Alignment already failed, so every token-shaped fragment is debris.
  const debris = scanLooseLayoutTokens(markdown);
  let prose = '';
  let pos = 0;
  for (const d of debris) {
    prose += markdown.slice(pos, d.start);
    pos = d.end;
  }
  prose += markdown.slice(pos);
  prose = prose.replace(/^\n+|\n+$/g, '');

  const out: string[] = [];
  for (const t of skeleton) {
    out.push(`\n\n${canonicalLayoutToken(t)}\n\n`);
    if (!t.isClose && PROSE_BEARING_KINDS.has(t.kind)) out.push(`\n\n${prose}\n\n`);
  }
  return out.join('');
}

/**
 * True when the markdown still carries layout-token text the #781 recovery
 * could work with — canonical or realistically mangled spellings, outside
 * code constructs. Used by the Improve route's cache guard: a response whose
 * input had tokens but whose output has NONE must not be cached, or every
 * "run AI Improve again" retry within the cache TTL would replay the same
 * token-less output and the apply would keep failing.
 */
export function hasRecoverableLayoutTokens(markdown: string): boolean {
  return scanLooseLayoutTokens(markdown).length > 0;
}

/**
 * #1958 (review r4 CM4-4): can an Improve output still place every frozen
 * code block the input Markdown carried? Each `CQ_CODE_PLACEHOLDER_<N>` the
 * input spells outside Markdown code (either spelling, identifier
 * boundaries, as the Accept reads it) must be spelled there exactly once in
 * the input and exactly once in the output. An output that fails can only
 * be refused on Accept (ImproveCodePlacementError), so the generator never
 * caches it and "run AI Improve again" reaches the provider anew. A pass is
 * no promise the Accept succeeds (the placement's context still decides).
 */
export function placesFrozenCodeTokens(input: string, output: string): boolean {
  const spelling = new RegExp(
    `(?<![A-Za-z0-9_])(?:${escapeRegExp(CODE_TOKEN_PREFIX)}|${escapeRegExp(CODE_TOKEN_PREFIX.replace(/_/g, '\\_'))})(\\d+)(?![A-Za-z0-9_]|\\\\_)`,
    'g',
  );
  const count = (markdown: string): Map<string, number> => {
    const counts = new Map<string, number>();
    transformOutsideMarkdownCode(markdown, (segment) => {
      for (const match of segment.matchAll(spelling)) counts.set(match[1]!, (counts.get(match[1]!) ?? 0) + 1);
      return segment;
    });
    return counts;
  };
  const expected = count(input);
  if (expected.size === 0) return true;
  const found = count(output);
  for (const [ordinal, times] of expected) {
    if (times !== 1 || found.get(ordinal) !== 1) return false;
  }
  return true;
}

/**
 * Lowercase + strip markdown decoration/escapes + collapse whitespace, with a
 * map from each normalized char back to its original index. Both anchors and
 * the model's prose are normalized with this before matching, so case fixes,
 * dropped emphasis, and whitespace churn don't break anchor recovery.
 */
function normalizeWithMap(s: string): { norm: string; map: number[] } {
  let norm = '';
  const map: number[] = [];
  let lastWasSpace = true; // swallow leading whitespace
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '\\' && i + 1 < s.length && /[\\`*_{}[\]()#+\-.!>]/.test(s[i + 1]!)) continue;
    if (/[*_~`#>]/.test(ch)) continue;
    if (/\s/.test(ch)) {
      if (!lastWasSpace) {
        norm += ' ';
        map.push(i);
        lastWasSpace = true;
      }
      continue;
    }
    norm += ch.toLowerCase();
    map.push(i);
    lastWasSpace = false;
  }
  while (norm.endsWith(' ')) {
    norm = norm.slice(0, -1);
    map.pop();
  }
  return { norm, map };
}

/**
 * Last-resort recovery for MULTI-slot skeletons when the model dropped every
 * token: split the (debris-stripped) prose at each cell's surviving anchor —
 * the leading text captured into the skeleton by extractLayoutSkeleton.
 * Strictly conservative, all-or-nothing:
 *   - every prose-bearing slot must have an anchor (empty cells → bail);
 *   - every anchor must match exactly once, in skeleton order (a later
 *     duplicate or swapped cells → bail);
 * On any doubt returns null so the caller rejects instead of mis-assigning
 * prose to cells. Prose before the first anchor stays at top level (it was
 * outside the layout); prose after the last anchor belongs to the last cell.
 */
function splitProseByAnchors(markdown: string, skeleton: LayoutSkeletonToken[]): string | null {
  // Alignment already failed, so every token-shaped fragment is debris.
  const debris = scanLooseLayoutTokens(markdown);
  let prose = '';
  let pos = 0;
  for (const d of debris) {
    prose += markdown.slice(pos, d.start);
    pos = d.end;
  }
  prose += markdown.slice(pos);
  prose = prose.replace(/^\n+|\n+$/g, '');

  // Unrecognized token-shaped remnants (e.g. a translated "[[[SPALTE]]]")
  // survive debris-stripping; splitting around them would persist raw
  // bracket text into the page. Reject — the echo is mangled, not dropped.
  if (/\[\[\[|\]\]\]/.test(prose)) return null;

  const slots = skeleton.filter((t) => !t.isClose && PROSE_BEARING_KINDS.has(t.kind));
  const anchors = slots.map((t) => normalizeWithMap(t.anchor ?? '').norm);
  if (anchors.some((a) => a.length < 3)) return null;

  const { norm, map } = normalizeWithMap(prose);
  const normStarts: number[] = [];
  let from = 0;
  for (const a of anchors) {
    const idx = norm.indexOf(a, from);
    if (idx === -1) return null; // anchor edited away → unrecoverable
    if (norm.indexOf(a, idx + 1) !== -1) return null; // recurs later → ambiguous
    normStarts.push(idx);
    from = idx + a.length;
  }

  const origStarts = normStarts.map((n) => {
    let s = map[n]!;
    // Pull adjacent emphasis decoration into the segment so a **bold** anchor
    // keeps its opening marks instead of leaking them into the prior segment.
    while (s > 0 && /[*_~]/.test(prose[s - 1]!)) s--;
    return s;
  });

  const pre = prose.slice(0, origStarts[0]!).replace(/^\n+|\n+$/g, '');
  const segments = origStarts.map((s, i) =>
    prose
      .slice(s, i + 1 < origStarts.length ? origStarts[i + 1]! : prose.length)
      .replace(/^\n+|\n+$/g, ''),
  );

  const out: string[] = [];
  if (pre.trim()) out.push(`\n\n${pre}\n\n`);
  let slotIdx = 0;
  for (const t of skeleton) {
    out.push(`\n\n${canonicalLayoutToken(t)}\n\n`);
    if (!t.isClose && PROSE_BEARING_KINDS.has(t.kind)) {
      const seg = segments[slotIdx++]!;
      if (seg.trim()) out.push(`\n\n${seg}\n\n`);
    }
  }
  return out.join('');
}

/**
 * Recover the LLM's (possibly mangled) layout tokens against the known
 * skeleton and return canonical markdown, or throw LayoutRecoveryError.
 * Strictness ladder (#785 review): candidates are evaluated with the strict
 * canonical scan first — only when that cannot align the FULL skeleton does
 * the tolerant loose scan run, so token lookalikes in user prose survive
 * intact echoes. Fail-closed: the reconstruction is verified token-for-token
 * against the skeleton before it is accepted, so no edge case can silently
 * flatten. Note: alignment is greedy and in-order — it guards layout
 * STRUCTURE, not prose-to-cell assignment; a model that swaps two cells'
 * content yields the swapped prose inside the preserved structure.
 */
function recoverLayoutMarkdown(markdown: string, skeleton: LayoutSkeletonToken[]): string {
  const rawFound = scanLooseLayoutTokens(markdown);
  // Fast path: layout-free page and a clean echo — nothing to do.
  if (skeleton.length === 0 && rawFound.length === 0) return markdown;

  // #1232 round 2: IDENTITY fast path. When the echo's canonical tokens carry
  // the skeleton's own payloads in the skeleton's own nesting SHAPE — only the
  // order of siblings differing — nothing was mangled: every token sits beside
  // its own prose. Rebuilding from the ECHO's token order instead of the
  // skeleton's is what stops a reordered section's title being pinned onto the
  // body that happened to come first. Duplicate identities are by definition
  // indistinguishable, so however they pair up is the same document.
  //
  // The rebuild still runs through reconstructLayoutMarkdown (#1232 round 3):
  // returning the echo verbatim skipped its prose-placement rules, so a
  // sentence the model added BETWEEN two cells was saved as a direct child of
  // ac:layout-section — a shape the storage format forbids. Identity comes from
  // the echo; where prose may legally sit does not.
  const strictSpans = scanStrictLayoutTokenSpans(markdown);
  if (skeleton.length > 0 && sameTokenShape(strictSpans, skeleton) && layoutSequenceValid(strictSpans)) {
    const echoSkeleton: LayoutSkeletonToken[] = strictSpans.map((t) => ({
      kind: t.kind,
      isClose: t.isClose,
      attrs: t.attrs,
    }));
    const rebuilt = reconstructLayoutMarkdown(
      markdown,
      strictSpans,
      echoSkeleton.map((_, i) => i),
      echoSkeleton,
    );
    if (matchesSkeleton(rebuilt, echoSkeleton)) return rebuilt;
  }

  const candidates: string[] = [markdown];
  const unwrappedCode = unwrapTokenOnlyCode(markdown);
  if (unwrappedCode !== markdown) candidates.push(unwrappedCode);
  const unfenced = unwrapFullDocumentFence(markdown);
  if (unfenced !== null) {
    candidates.push(unfenced);
    const unfencedUnwrapped = unwrapTokenOnlyCode(unfenced);
    if (unfencedUnwrapped !== unfenced) candidates.push(unfencedUnwrapped);
  }

  // Evaluate every candidate with the given scanner; prefer the one aligning
  // the most skeleton tokens, tie-broken toward the LEAST-transformed
  // markdown so code-as-data is only consumed when it rescues the layout.
  // Attempts aligning fewer than `minMatched` skeleton tokens are rejected.
  const tryRecover = (
    scan: (md: string) => ScannedLayoutToken[],
    minMatched: number,
  ): { rebuilt: string | null; bestMatched: number } => {
    const attempts = candidates
      .map((candidate, order) => {
        const found = scan(candidate);
        return { candidate, found, order, ...alignLayoutTokens(found, skeleton) };
      })
      .sort((a, b) => b.matchedCount - a.matchedCount || a.order - b.order);
    for (const attempt of attempts) {
      if (!attempt.ok || attempt.matchedCount < minMatched) continue;
      // #1232 round 2: never let an unreconciled token anchor the alignment,
      // and never assign a token to a slot its own payload contradicts. Both
      // are silent identity corruption on the persisting path; refusing is
      // what the caller turns into a 422.
      if (skeleton.length > 0 && attempt.surplus > 0) continue;
      if (attempt.identityConflict) continue;
      const rebuilt = reconstructLayoutMarkdown(attempt.candidate, attempt.found, attempt.matched, skeleton);
      if (matchesSkeleton(rebuilt, skeleton)) return { rebuilt, bestMatched: attempt.matchedCount };
    }
    return { rebuilt: null, bestMatched: attempts[0]?.matchedCount ?? 0 };
  };

  // Strict pass: when some candidate's CANONICAL tokens already cover the
  // whole skeleton, the echo is intact — tolerant matching would only
  // consume prose lookalikes (e.g. a literal "[[[layout]]]" in cell text)
  // as token debris. Requiring the FULL skeleton (not just prose-bearing
  // opens) matters: a partially-strict echo means something WAS mangled,
  // and accepting it here would leave the mangled token behind as prose.
  const strictPass = tryRecover(scanStrictLayoutTokenSpans, skeleton.length);
  if (strictPass.rebuilt !== null) return strictPass.rebuilt;

  // Loose pass: the echo is mangled — tolerant matching rescues it,
  // accepting that lookalikes may now be consumed as debris.
  const loosePass = tryRecover(scanLooseLayoutTokens, 0);
  if (loosePass.rebuilt !== null) return loosePass.rebuilt;

  const proseSlots = skeleton.filter((t) => !t.isClose && PROSE_BEARING_KINDS.has(t.kind));

  // #1221 review: BOTH last-resort paths below rest on the same premise — that
  // a prose-bearing slot PARTITIONS the document, so prose that lost its
  // boundary tokens must belong to some slot. That holds for the kinds they
  // were designed for: a single-cell layout wraps the whole body, and a
  // multi-cell layout's cells tile it. It is false for an EXPAND, which is a
  // page FRAGMENT with ordinary sibling prose around it. Applying the premise
  // there moved a page's heading and every surrounding paragraph INSIDE the
  // collapsed section (single-slot), or pulled the prose sitting BETWEEN two
  // sections into the preceding one (anchor split) — content still present,
  // but hidden behind a toggle and pushed to Confluence at HTTP 200.
  //
  // There is no safe guess to make: the machinery has no representation for
  // "prose that belongs outside every slot". So a skeleton containing an
  // EXPAND open falls straight through to LayoutRecoveryError → 422, which is
  // the outcome the user can actually recover from.
  const hasExpandSlot = skeleton.some((t) => !t.isClose && t.kind === 'EXPAND');

  // #1232 round 2: both paths below strip every token-shaped fragment as
  // debris and re-slot the remaining prose. With a surplus token in the echo
  // that fragment may be the page's OWN prose, so stripping it deletes user
  // text and the re-slotting is anchored on a document that no longer matches
  // what the model returned. Refuse instead.
  const hasSurplus = alignLayoutTokens(rawFound, skeleton).surplus > 0;

  // Single-slot wrap (#785 review): with exactly one prose-bearing open the
  // assignment is unambiguous even when nothing aligned at all.
  if (!hasExpandSlot && !hasSurplus && proseSlots.length === 1) {
    const wrapped = wrapProseInSingleSlot(markdown, skeleton);
    if (matchesSkeleton(wrapped, skeleton)) return wrapped;
  }

  // Anchor split: multi-slot skeleton, every token dropped, but each cell's
  // leading prose survived the rewrite — split at the anchors instead of
  // rejecting. All-or-nothing; any ambiguity falls through to the error.
  if (!hasExpandSlot && !hasSurplus && proseSlots.length > 1) {
    const split = splitProseByAnchors(markdown, skeleton);
    if (split !== null && matchesSkeleton(split, skeleton)) return split;
  }

  throw new LayoutRecoveryError({
    expectedTokens: skeleton.length,
    recoveredTokens: loosePass.bestMatched,
  });
}

/**
 * #1752: a `<div>` start tag. The HTML tokenizer ends a tag name at
 * whitespace, `/` or `>`, so `<div/>` opens a div too (the slash is ignored).
 */
const DIV_START_TAG = /<div[\s/>]/i;

/**
 * #1752: either spelling (turndown escapes `_`) of every protectMedia token
 * whose original HTML holds a `<div>` — the tokens the caller's restoreMedia
 * turns back into a div. `_1` never matches `_10`. Null when there are none,
 * or when nothing will restore the tokens (no media given).
 */
function blockMediaTokenPattern(media: readonly ProtectedMedia[] | undefined): RegExp | null {
  const spellings = (media ?? [])
    .filter((entry) => DIV_START_TAG.test(entry.html))
    .flatMap(({ token }) => [token, token.replace(/_/g, '\\_')])
    .map(escapeRegExp);
  return spellings.length > 0 ? new RegExp(`(?:${spellings.join('|')})(?![0-9])`) : null;
}

/**
 * #1752: does this rendered task-item body hold a `<div>`, or something that
 * becomes one — a draw.io fence (markdownToHtml turns it into
 * `div.confluence-drawio` after parsing) or a block-media token
 * (blockMediaTokenPattern)? TipTap's TaskItem parses its content from the
 * first descendant `div` (`contentElement` in @tiptap/extension-list
 * task-item.ts), so a task item holding one would lose all content outside
 * that div in the editor. Inline placeholders (image, mention, status, Jira)
 * hold no div, so their task items stay tasks.
 */
function breaksTaskItemParse(body: string, blockMediaToken: RegExp | null): boolean {
  return DIV_START_TAG.test(body)
    || body.includes('<code class="language-drawio">')
    || (blockMediaToken !== null && blockMediaToken.test(body));
}

/**
 * #1752: the Markdown parser behind markdownToHtml — marked's defaults (GFM
 * on), except for lists that contain GFM task items.
 *
 * marked renders `- [x] done` as `<li><input checked="" disabled=""
 * type="checkbox"> done</li>`. Neither TipTap schema parses that as a task:
 * both read a task only as `ul[data-type="taskList"] >
 * li[data-type="taskItem"][data-checked]` (TaskList/TaskItem in
 * collab-schema.ts, Editor.tsx, ArticleViewer.tsx). So the checked state was
 * lost on import, and on AI Improve Accept, whose htmlToMarkdown writes task
 * items as `- [x]` / `- [ ]`, the `<input>` elements reached the stored body
 * while the task list did not.
 *
 * Task items are emitted as that markup, in runs. A TaskList holds task items
 * only, and htmlToConfluence rebuilds `ac:task-list` from
 * `li[data-type="taskItem"]` alone, so a plain item inside one would vanish on
 * write-back. A task item whose body would break the TaskItem parse
 * (breaksTaskItemParse) stays a plain item instead, with the author's
 * `[x]`/`[ ]` kept as text: its content and its state both survive. A plain
 * run of an ordered list keeps its number via `start`; a task run has no
 * numbering in either schema or in `ac:task-list`. No task id is emitted,
 * because every converted task is new. Each item body is rendered exactly
 * once. A list without a task item returns `false`: marked's own rendering,
 * byte for byte.
 */
function createEditorMarked(blockMediaToken: RegExp | null): Marked {
  return new Marked({
    renderer: {
      list(token) {
        if (!token.items.some((item) => item.task)) return false;
        const items = token.items.map((item) => {
          const body = this.parser.parse(item.tokens, item.loose);
          if (item.task && !breaksTaskItemParse(body, blockMediaToken)) {
            return {
              task: true,
              html: `<li data-type="taskItem" data-checked="${item.checked ? 'true' : 'false'}">${body}</li>\n`,
            };
          }
          if (!item.task) return { task: false, html: `<li>${body}</li>\n` };
          const marker = item.checked ? '[x] ' : '[ ] ';
          const kept = body.startsWith('<p>') ? `<p>${marker}${body.slice(3)}` : `${marker}${body}`;
          return { task: false, html: `<li>${kept}</li>\n` };
        });
        let html = '';
        let index = 0;
        while (index < items.length) {
          const runStart = index;
          const task = items[runStart]!.task;
          while (index < items.length && items[index]!.task === task) index += 1;
          const lis = items.slice(runStart, index).map((item) => item.html).join('');
          if (task) {
            html += `<ul data-type="taskList">\n${lis}</ul>\n`;
          } else if (typeof token.start === 'number') {
            const start = token.start + runStart;
            html += `<ol${start === 1 ? '' : ` start="${start}"`}>\n${lis}</ol>\n`;
          } else {
            html += `<ul>\n${lis}</ul>\n`;
          }
        }
        return html;
      },
    },
  });
}

/** #1752: the parser for every call with no block media to restore. */
const EDITOR_MARKED = createEditorMarked(null);

export interface MarkdownToHtmlOptions {
  /**
   * #781: the expected layout-token skeleton of the document being edited
   * (from extractLayoutSkeleton on the page's CURRENT body HTML). When set,
   * mangled tokens in the markdown are recovered against it — and when
   * recovery is impossible, LayoutRecoveryError is thrown instead of
   * silently flattening. When omitted, the legacy #774 all-or-nothing
   * drop-guard applies (markdown imports, no expected structure).
   */
  layoutSkeleton?: LayoutSkeletonToken[];
  /**
   * #1752: the protectMedia map the caller restores into the result (AI
   * Improve Accept). A task item holding a token whose original HTML has a
   * `<div>` stays a plain item: restoreMedia would put that div inside it, and
   * TipTap's TaskItem would parse only the div. Without it the tokens are
   * plain text, because nothing restores them (import, eval seeders).
   */
  protectedMedia?: readonly ProtectedMedia[];
  /**
   * #1958: the Accept's code-metadata state (beginCodeMetaAccept). When the
   * page has a token block, witnesses are asked for, or the Markdown holds a
   * CODE-META lookalike, the echo is analysed on the lexer tokens: bound
   * fences render the stored code with a marker, token lines are removed, and
   * `codeMeta.fences` is filled. Otherwise the parse is unchanged.
   */
  codeMeta?: CodeMetaAccept;
}

/**
 * Converts Markdown to HTML (for LLM output -> editor). GFM task items become
 * the editor's task markup (see createEditorMarked, #1752).
 */
export async function markdownToHtml(markdown: string, options?: MarkdownToHtmlOptions): Promise<string> {
  const skeleton = options?.layoutSkeleton;

  // #1221 review: on the persisting path the sequence is the PAGE's own, so an
  // invalid one means the stored document has a nesting the storage format
  // forbids (the freeze normally keeps those opaque — see expandTokenizesCleanly).
  // Fail closed. The alternative the rebuild uses elsewhere, stripping every
  // token and saving the flattened body, is exactly the silent macro loss this
  // envelope exists to prevent, and here it would be triggered by the page
  // rather than by anything the model did. Checked before recovery runs: the
  // verdict cannot change and the work would be wasted (#1232 round 2).
  if (skeleton && skeleton.length > 0 && !layoutSequenceValid(skeleton)) {
    throw new LayoutRecoveryError({ expectedTokens: skeleton.length, recoveredTokens: 0 });
  }

  // #781: with a known skeleton, align the LLM's echo against it first —
  // throws LayoutRecoveryError when the layout is unrecoverable.
  const input = skeleton ? recoverLayoutMarkdown(markdown, skeleton) : markdown;

  // #1221 review: replace the verified tokens with opaque sentinels so the
  // HTML-side rebuild consumes THEM rather than re-discovering bracket runs
  // that marked un-escaped out of ordinary prose.
  const sentinelPrefix = skeleton ? layoutSentinelPrefix(input) : '';
  let prepared = input;
  let sentinelTokens: LayoutToken[] = [];
  if (skeleton) {
    const sentinelled = sentinelizeLayoutTokens(input, sentinelPrefix);
    // The recovered stream is a permutation of the skeleton (the model may have
    // reordered sections), so it is checked for COUNT and for its own validity
    // rather than against the skeleton's order.
    if (sentinelled.tokens.length !== skeleton.length || !layoutSequenceValid(sentinelled.tokens)) {
      throw new LayoutRecoveryError({
        expectedTokens: skeleton.length,
        recoveredTokens: sentinelled.tokens.length,
      });
    }
    prepared = sentinelled.markdown;
    sentinelTokens = sentinelled.tokens;
  }

  // #765: force every layout boundary token onto its own paragraph so marked
  // wraps it in a lone <p>, even when the LLM merged adjacent token lines or
  // pulled a token into surrounding prose. Code constructs are skipped —
  // literal token text in a fenced block must survive verbatim. (Sentinelised
  // input has none left; this is the no-skeleton path's normalization.)
  const tokenLine = new RegExp(`[ \\t]*(${LAYOUT_TOKEN_BARE})[ \\t]*`, 'g');
  const normalized = transformOutsideMarkdownCode(prepared, (segment) =>
    segment.replace(tokenLine, '\n\n$1\n\n'),
  );

  const blockMediaToken = blockMediaTokenPattern(options?.protectedMedia);
  const parser = blockMediaToken ? createEditorMarked(blockMediaToken) : EDITOR_MARKED;
  let html: string;
  const codeMeta = options?.codeMeta;
  if (codeMeta && needsCodeMetaAnalysis(codeMeta, markdown)) {
    const tokens = parser.lexer(normalized);
    // D26: the #1958 analysis runs in full on the #1958 path; on the base path only fences are recorded (#1953).
    analyseCodeMetaEcho(tokens, codeMeta, codeMeta.mode === 'meta');
    html = parser.parser(tokens);
  } else {
    html = await parser.parse(normalized) as string;
  }

  // Older authored fences contain just a name; exported wrappers also carry
  // their source and preview attributes in a single JSON line.
  html = html.replace(
    /<pre><code class="language-drawio">([\s\S]*?)\n?<\/code><\/pre>/g,
    (_m, encoded) => {
      const text = new JSDOM(`<body>${encoded}</body>`).window.document.body.textContent?.trim() ?? '';
      let metadata: { name: string; source?: string | null; xml?: string | null; src?: string | null; alt?: string | null; href?: string | null } = { name: text };
      try {
        const parsed: unknown = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && 'name' in parsed && typeof parsed.name === 'string') {
          metadata = parsed as typeof metadata;
        }
      } catch {
        // A plain diagram name remains a valid authored fence.
      }
      const doc = new JSDOM('<body></body>').window.document;
      const div = doc.createElement('div');
      div.className = 'confluence-drawio';
      div.setAttribute('data-diagram-name', metadata.name);
      if (typeof metadata.source === 'string') div.setAttribute('data-drawio-source', metadata.source);
      if (typeof metadata.xml === 'string') div.setAttribute('data-drawio-xml', metadata.xml);
      if (typeof metadata.src === 'string') {
        const image = doc.createElement('img');
        image.setAttribute('src', metadata.src);
        if (typeof metadata.alt === 'string') image.setAttribute('alt', metadata.alt);
        div.appendChild(image);
      } else {
        const message = doc.createElement('span');
        message.className = 'drawio-preview-unavailable';
        message.textContent = `Draw.io preview unavailable: ${metadata.name}`;
        div.appendChild(message);
      }
      if (typeof metadata.href === 'string') {
        const link = doc.createElement('a');
        link.className = 'drawio-edit-link';
        link.href = metadata.href;
        link.textContent = 'Edit in Confluence';
        div.appendChild(link);
      }
      return div.outerHTML;
    },
  );

  if (skeleton) {
    // Sentinels can only exist outside code constructs (sentinelizeLayoutTokens
    // skips them), so no masking is needed. Nothing else is touched: any
    // remaining [[[…]]] text is prose the strictness ladder deliberately kept,
    // and it now reaches the page verbatim instead of being stripped.
    return materializeConfluenceUrlLinks(rebuildLayoutFromSentinels(html, sentinelPrefix, sentinelTokens));
  }

  html = transformOutsideHtmlCode(html, (segment) => {
    // #765: rebuild layout/section/column wrappers from boundary tokens.
    let out = rebuildLayoutStructure(segment);

    // #765 drop-guard backstop: strip any token-shaped remnant that failed
    // structural matching (e.g. the LLM lower-cased a marker) — raw [[[…]]]
    // text must never reach the saved page. Skeleton-guided callers never get
    // here: their tokens are consumed by identity above, so nothing has to be
    // guessed at from the text.
    out = out.replace(
      new RegExp(`<p>\\s*${LAYOUT_TOKEN_BARE}\\s*</p>|${LAYOUT_TOKEN_BARE}`, 'gi'),
      '',
    );
    return out;
  });

  // #1955: a link whose destination is the carrier of a navigable ri:url
  // becomes the real link again, on parsed anchors only.
  return materializeConfluenceUrlLinks(html);
}

/**
 * The page's text as the reader sees it, before any whitespace handling: the
 * HTML parser's `body.textContent`. Every character reference is decoded once
 * by the parser and nothing decodes it again (#1735). `virtualConsole` lets a
 * caller that parses untrusted stored HTML keep JSDOM diagnostics (for example
 * a CSS `@import` it cannot parse) out of the process console; omitted, the
 * JSDOM default applies.
 */
export function htmlTextContent(html: string, virtualConsole?: VirtualConsole): string {
  const dom = new JSDOM(`<body>${html}</body>`, {
    contentType: 'text/html',
    ...(virtualConsole ? { virtualConsole } : {}),
  });
  return dom.window.document.body.textContent ?? '';
}

/** Whitespace runs (including `&nbsp;`) collapse to one space; the result is trimmed. */
export function collapseBodyText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Strips all HTML tags, returning plain text (for full-text search — and, until
 * #1265, the embedding input; see htmlToEmbeddingText for why that moved).
 *
 * The HTML parser decodes every character reference once, so `textContent`
 * is already the text the reader sees. Never decode it again: a documented
 * example written as `&amp;lt;br&amp;gt;` must store `&lt;br&gt;`, not `<br>`
 * (#1735). Whitespace runs (including `&nbsp;`) collapse to one space and the
 * result is trimmed — `embedding-chunking.test.ts` depends on that. The
 * `body_text` backfill (#1965) classifies stored rows with the same two halves.
 */
export function htmlToText(html: string): string {
  return collapseBodyText(htmlTextContent(html));
}

/**
 * Structure-preserving text for the embedding pipeline (#1265).
 *
 * `chunkText` (embedding-service) splits on Markdown atx headings
 * (`^#{1,6}\s`) and blank-line paragraph boundaries — but `htmlToText`'s
 * final `replace(/\s+/g, ' ')` collapses every newline, so neither splitter
 * could ever match its output: every page ≤ CHUNK_HARD_LIMIT embedded as one
 * chunk, longer pages split at arbitrary word boundaries with no overlap, and
 * `section_title` metadata always equalled the page title. The
 * structure-aware chunking was dead code from the day it shipped.
 *
 * This routes the embedding input through `htmlToMarkdown` instead — per
 * ADR-003, Markdown is already the canonical LLM-facing form of page content
 * (auto-tagger, quality worker, and subpage context all convert the same
 * way), and the converter is configured with `headingStyle: 'atx'`, which is
 * exactly the shape `chunkText`'s heading split expects. Consequences, all
 * deliberate:
 * - stored `chunk_text` (and so RAG context handed to the chat model) is
 *   Markdown-shaped — better for the LLM, mildly syntax-flavoured in any UI
 *   excerpt that renders a vector chunk verbatim. (Known exception: a table
 *   nested inside a table stays raw HTML — the gfm turndown plugin bails on
 *   nesting. It is still text; nothing downstream parses chunk_text.);
 * - `body_text` (FTS, snippets, the coverage probe's length check) stays
 *   `htmlToText` — this function changes only what gets chunked + embedded;
 * - changed chunk text means existing embeddings describe text that is no
 *   longer produced: taking this live on real data means **re-running
 *   embedPage per page** — `UPDATE pages SET embedding_dirty = TRUE` and let
 *   the worker re-chunk (per-page transactional delete+insert; search stays
 *   warm throughout). #1116's shadow path is NOT sufficient on its own: it
 *   re-embeds the *stored* `chunk_text` into the shadow column and never
 *   re-chunks, so it would faithfully preserve the pre-#1265 blobs.
 *
 * `data:` URI destinations are stripped (`(data:uri-omitted`): DOMPurify
 * permits `data:` on <img>, so one Markdown import carrying a 120 KB base64
 * image would otherwise become ~19 pure-base64 chunks — junk vectors, junk
 * provider payloads, and page_embeddings bloat. The alt text survives; only
 * the payload goes.
 *
 * Falls back to `htmlToText` if the Markdown conversion throws (measured
 * trigger: ~2,000-deep tag nesting overflows the recursion in turndown) — a
 * page that defeats the converter must still embed as a flat blob (the
 * pre-#1265 behaviour) rather than not at all.
 */
export function htmlToEmbeddingText(
  html: string,
  logContext: Record<string, unknown> = {},
): string {
  try {
    const md = htmlToMarkdown(flattenTableCellsForEmbedding(html)).trim();
    return md.replace(/\(\s*data:[^)\s]{40,}/g, '(data:uri-omitted');
  } catch (err) {
    // logContext exists so this warn can carry the pageId — the fallback
    // silently flips a page to a different text shape, and a context-free
    // warning left no way to enumerate affected pages once logs rotate.
    logger.warn(
      { err, ...logContext },
      'htmlToMarkdown failed for embedding input — falling back to plain text',
    );
    return htmlToText(html);
  }
}

/**
 * Collapse each table cell's block content to plain inline text before the
 * Markdown conversion (#1265 verification, finding 2). Confluence wraps cell
 * content in `<p>`, and turndown-gfm emits those paragraph breaks as blank
 * lines INSIDE the pipe row — which the fence-aware paragraph splitter then
 * reads as boundaries, tearing large tables mid-cell and stranding the
 * header row. With single-line cells every row is one line, the whole table
 * is one paragraph block, and the header travels with its rows. Inline marks
 * inside cells are flattened to text — cells are data; their emphasis is not
 * retrieval signal.
 */
function flattenTableCellsForEmbedding(html: string): string {
  if (!/<t[dh][\s>]/i.test(html)) return html;
  const dom = new JSDOM(`<body>${html}</body>`, { contentType: 'text/html' });
  const doc = dom.window.document;
  for (const cell of Array.from(doc.querySelectorAll('td, th'))) {
    // Skip cells that contain a nested table — the gfm plugin bails on those
    // and keeps raw HTML; flattening would silently delete the inner table.
    if (cell.querySelector('table')) continue;
    // An <img> has no textContent — replace it with its alt text first, or a
    // diagram-in-a-table cell (a common KB shape) embeds as EMPTY and loses
    // the only retrievable signal it has (#1266 review r2, N-1).
    for (const img of Array.from(cell.querySelectorAll('img'))) {
      img.replaceWith(doc.createTextNode(img.getAttribute('alt') ?? ''));
    }
    const text = (cell.textContent ?? '').replace(/\s+/g, ' ').trim();
    cell.textContent = text;
  }
  return doc.body.innerHTML;
}

/**
 * Flatten Markdown-shaped chunk text into a plain-prose excerpt for search
 * snippets (#1265). Vector-sourced results carry Markdown `chunk_text` now,
 * while keyword-fallback rows carry plain `body_text` — without this, one
 * result list mixed the two shapes, and an image-led chunk's first 300 chars
 * were mostly `![name](/api/attachments/…)` syntax. Images collapse to their
 * alt text, links to their label, fence/heading markers drop, and the common
 * backslash escapes unescape (`2\*3` → `2*3`). Idempotent on plain text.
 * A display affordance, not a renderer — never used on the LLM-facing path,
 * which keeps the full Markdown deliberately.
 */
export function markdownToSnippetText(md: string): string {
  return (
    md
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/^\s{0,3}(?:`{3,}|~{3,}).*$/gm, '')
      .replace(/^#{1,6}\s+/gm, '')
      // Blockquote markers (panels render as "> **INFO:** …") and thematic
      // breaks are chrome, not prose.
      .replace(/^\s{0,3}>\s?/gm, '')
      .replace(/^\s{0,3}((\*\s*){3,}|-{3,}|_{3,})\s*$/gm, '')
      // Emphasis pairs: turndown escapes LITERAL asterisks/underscores, so an
      // unescaped pair here is real formatting — safe to strip. The guards
      // keep this from eating identifiers on PLAIN-text inputs (keyword rows
      // pass through here too): no opener straight after a word character or
      // backslash (`snake_case_name` never opens), no closer straight before
      // one.
      .replace(/(?<![\\\w])(\*\*|__)(.+?)(?<!\\)\1(?!\w)/g, '$2')
      .replace(/(?<![\\\w])([*_])([^*_\n]+?)(?<!\\)\1(?!\w)/g, '$2')
      // turndown backslash-escapes far more than the bracket set — the
      // numbered-heading case ("1\. Introduction") is ubiquitous, and a
      // literal backslash doubles ("C:\\Users").
      .replace(/\\([\\*_[\]#|`~.>+()!-])/g, '$1')
      .replace(/\s+/g, ' ')
      .trim()
  );
}
