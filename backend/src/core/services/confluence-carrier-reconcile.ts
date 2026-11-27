/**
 * Carrier recovery for pages synced before v0.10.0 (#1953, PR 1: the matcher; epic #2027 design revision 7 with
 * review r7 conditions AA1–AA3).
 *
 * A page synced before #1748/#1749/#1750 holds a `body_html` without macro parameters, emoticons and link targets,
 * while its `body_storage` still holds them. {@link reconcileConfluenceCarriers} attaches a carrier from the stored
 * storage to the HTML a writer means to write only under a three-way proof:
 *
 * 1. the source is an element the storage reader (#1955) reads as the macro, emoticon or link, in storage the
 *    forward pass reads identically, start, end and text, over the whole body; the builder that took a value from
 *    it read the subtree the reader read (`confluenceToHtmlWithCarrierMarks`);
 * 2. the unit of the stored HTML `L` equals the unit of the legacy projection π(C) of the marked conversion `C`;
 * 3. the unit of the target `T` equals that unit of `L`;
 * 4. the unit holds the same position under the same complete child sequences of every container from the body
 *    down, on all three sides (empty paragraphs included; the editor's one trailing empty paragraph after a body
 *    that ends in another block excepted, AA1), its key is unique in each document, and the target element holds
 *    no carrier of its own (veto).
 *
 * Anything else abstains and is counted. The function is pure: no clock, randomness, I/O or logging; the marker
 * name is the caller's. Every byte of `T` outside the spliced ranges is returned unchanged. It never throws.
 * Nothing calls it in this slice; the writers and the room seed are wired in #1953-2.
 */
import { JSDOM } from 'jsdom';
import {
  codeBlockElements,
  codeBlockIdentityKey,
  confluenceToHtmlWithCarrierMarks,
  projectSourceCodeText,
  type CarrierMark,
  type CarrierMarkedConversion,
  type CarrierMarkKind,
  type LegacyCodeMetadataOp,
  type LexerCodeText,
} from './content-converter.js';
import {
  CONFLUENCE_LINK_KINDS_1748,
  CONFLUENCE_LINK_LIMITS,
  confluenceLinkCarrierOf,
  confluenceLinkDisplayText,
  confluenceLinkHrefAttributes,
  parseConfluenceLinkHref,
  type ConfluenceLinkTarget,
} from './confluence-link.js';
import { readConfluenceStorage, resemblesStorageName, type StorageElement } from './confluence-storage-reader.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type CarrierKindId = CarrierMarkKind;

export type CarrierSkipReason =
  | 'carried'
  | 'unsupported'
  | 'not_unique'
  | 'changed'
  | 'container'
  | 'ambiguous'
  | 'boundary'
  | 'range'
  | 'no_element'
  | 'no_witness'
  | 'empty_block'
  | 'unlocatable'
  | 'error';

export type CarrierOutcome =
  | 'none'
  | 'evaluated'
  | 'recovered'
  | 'bound'
  | 'storage_unreadable'
  | 'storage_reading_differs'
  | 'storage_unconvertible'
  | 'failed';

/** Deterministic work counters (numbers only): what the early exits are asserted with. */
export interface CarrierWork {
  /** Nodes the storage reader read. */
  nodes: number;
  /** Conversion passes of the marked conversion. */
  passes: number;
  /** Units of the legacy projection π(C). */
  projectedUnits: number;
  /** Unit keys built over the three documents. */
  keyUnits: number;
  /** Work charged for splices. */
  spliceUnits: number;
  /** Work charged for finding the run that contains a rewritten start tag (zero when no run is rewritten). */
  containment: number;
}

/**
 * What a reconcile did, names and numbers only. Kind counts are reported only for `recovered` (recovered and
 * skipped) and `evaluated` (skipped only: records were evaluated and nothing was applied, Z6/AA3).
 */
export interface CarrierReport {
  outcome: CarrierOutcome;
  recovered: Partial<Record<CarrierKindId, number>>;
  skipped: Partial<Record<CarrierKindId, Partial<Record<CarrierSkipReason, number>>>>;
  /** One entry per applied code operation; returned to the Improve writer, never logged. */
  codeOps: LegacyCodeMetadataOp[];
  droppedLinkAttributes: number;
  work: CarrierWork;
}

/** Limits, each checked before the work it bounds (design §3.6). Tests inject small ones. */
export interface CarrierBudget {
  /** Stage 0: the longest `L`, `S` and `T`, in UTF-16 code units. */
  length: number;
  /** Stage 1: the storage reader's depth and node limits. */
  readerDepth: number;
  readerNodes: number;
  /** Stage 2: macro nesting depth and macro count. */
  macroDepth: number;
  macros: number;
  /** Stages 3–4: proven sources (marks) and conversion passes. */
  marks: number;
  passes: number;
  /** Stage 5: the work counter's limit is this factor times the summed lengths of `L`, the projection and `T`. */
  workFactor: number;
  unitsPerDocument: number;
  signature: number;
  inlineDepth: number;
  frameDepth: number;
  tableCells: number;
}

export const CARRIER_RECONCILE_MAX_UNITS = 2_097_152;

export const DEFAULT_CARRIER_BUDGET: Readonly<CarrierBudget> = {
  length: CARRIER_RECONCILE_MAX_UNITS,
  readerDepth: 256,
  readerNodes: 262_144,
  macroDepth: 32,
  macros: 5_000,
  marks: 10_000,
  passes: 34,
  workFactor: 4,
  unitsPerDocument: 50_000,
  signature: 4_096,
  inlineDepth: 32,
  frameDepth: 64,
  tableCells: 4_096,
};

/** A marked element of a legacy kind whose carried values passed their closed checks. */
export interface CarrierRecord {
  readonly kind: CarrierKindId;
  /** The attributes the operation writes to the target element, in the builder's order. */
  readonly attributes: ReadonlyArray<readonly [name: string, value: string]>;
  /** A link's carried label that replaces its legacy text (no body, and the legacy text differs). */
  readonly label: string | null;
}

/** One carrier kind of the registry (D8): a gate, a veto and the closed reading of a marked element. */
export interface CarrierKind {
  readonly id: CarrierKindId;
  /**
   * Substring test, no parse: whether storage may hold a source of this kind. A false answer must prove absence,
   * so it tests an element name, which XML spells literally (no reference can stand in it), never a value.
   */
  storageMayCarry(storage: string): boolean;
  /** Page-level gate: the stored body already holds a carrier of this kind, so the kind is not legacy here. */
  storedHoldsCarrier(stored: Document): boolean;
  /** Veto: the target element already carries a value of this kind. */
  targetHoldsCarrier(el: Element): boolean;
  /** The record of a marked element: its carried values, `unsupported` when a check fails, null when it is none. */
  record(marked: Element, payload: CarrierMark): CarrierRecord | 'unsupported' | null;
}

export interface ReconcileCarrierOptions {
  /** The attribute name of the marks: `data-cq-` + 32 lower-case hexadecimal digits, drawn by the caller (Z3). */
  marker: string;
  /** As the row was converted (image `src`). */
  confluenceId?: string;
  spaceKey?: string;
  /** Improve only: #1958's witnesses, one per element of `codeBlockElements` of the body of `T`. */
  codeWitnesses?: ReadonlyArray<LexerCodeText | null>;
  /** Tests: another registry. */
  registry?: readonly CarrierKind[];
  /** Tests: small limits. */
  budget?: Partial<CarrierBudget>;
}

// ---------------------------------------------------------------------------
// Closed checks of carried values
// ---------------------------------------------------------------------------

const CODE_TITLE_MAX = 1_024;
const MACRO_PARAMS_MAX = 16_384;
const MACRO_PARAMS_ENTRIES_MAX = 64;
const MACRO_PARAMS_KEY_MAX = 256;
const MARKER_NAME = /^data-cq-[0-9a-f]{32}$/;
const EMOTICON_ATTRIBUTES = ['class', 'data-emoticon-attrs', 'data-emoticon-label', 'role', 'aria-label'] as const;

/** A `data-macro-params` value the legacy path may carry: a plain object of string values, bounded. */
function isCarriedMacroParams(raw: string): boolean {
  if (raw.length > MACRO_PARAMS_MAX) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false;
  const entries = Object.entries(parsed);
  return entries.length <= MACRO_PARAMS_ENTRIES_MAX
    && entries.every(([key, value]) => key.length <= MACRO_PARAMS_KEY_MAX && typeof value === 'string');
}

function hasClass(el: Element, name: string): boolean {
  return (el.getAttribute('class') ?? '').split(/[\t\n\f\r ]+/).includes(name);
}

/** A link carrier with a parameter, an anchor, or a #1955 kind: what a carried link is. */
function carriesLinkValue(el: Element): boolean {
  const carrier = confluenceLinkCarrierOf(el);
  const link = carrier === null ? null : parseConfluenceLinkHref(carrier);
  if (!link || link.legacy) return false;
  if (!CONFLUENCE_LINK_KINDS_1748.includes(link.kind) || link.kind === 'anchor') return true;
  return hasLinkParameter(link);
}

function hasLinkParameter(link: ConfluenceLinkTarget): boolean {
  return link.link.length > 0 || link.resource.length > 0 || link.container !== null || link.body !== null;
}

function macroParamsRecord(marked: Element, kind: CarrierKindId): CarrierRecord | 'unsupported' | null {
  const params = marked.getAttribute('data-macro-params');
  if (params === null) return null;
  if (!isCarriedMacroParams(params)) return 'unsupported';
  return { kind, attributes: [['data-macro-params', params]], label: null };
}

/**
 * A source is recognised only as `ac:structured-macro`, `ac:emoticon` or `ac:link` in Confluence's namespace with
 * the conventional prefix (`isStorageName`): those characters appear literally in any storage holding one. A
 * macro name is an attribute value and may be spelled with references (`statu&#115;`), so it is never the gate
 * (review r1 CAR-5).
 */
const MACRO_ELEMENT = '<ac:structured-macro';

const CODE_KIND: CarrierKind = {
  id: 'macro.code',
  storageMayCarry: (storage) => storage.includes(MACRO_ELEMENT),
  storedHoldsCarrier: (stored) => stored.querySelector('pre[data-title], pre[data-macro-params]') !== null,
  targetHoldsCarrier: (el) => el.localName === 'pre' && (el.hasAttribute('data-title') || el.hasAttribute('data-macro-params')),
  record(marked, payload) {
    if (payload.k !== 'macro.code' || marked.localName !== 'pre') return 'unsupported';
    const title = marked.getAttribute('data-title');
    const params = marked.getAttribute('data-macro-params');
    if (title === null && params === null) return null;
    if (title !== null && title.length > CODE_TITLE_MAX) return 'unsupported';
    if (params !== null && !isCarriedMacroParams(params)) return 'unsupported';
    // π writes the class the converter before #1749 wrote (`language-<l>` for any non-empty language); a block
    // whose class differs today has no legacy twin to compare with.
    const code = marked.firstElementChild;
    const legacyClass = payload.l === '' ? null : `language-${payload.l}`;
    if (!code || code.getAttribute('class') !== legacyClass) return 'unsupported';
    const attributes: Array<readonly [string, string]> = [];
    if (title !== null) attributes.push(['data-title', title]);
    if (params !== null) attributes.push(['data-macro-params', params]);
    return { kind: 'macro.code', attributes, label: null };
  },
};

const STATUS_KIND: CarrierKind = {
  id: 'macro.status',
  storageMayCarry: (storage) => storage.includes(MACRO_ELEMENT),
  storedHoldsCarrier: (stored) => stored.querySelector('span.confluence-status[data-macro-params]') !== null,
  targetHoldsCarrier: (el) => el.localName === 'span' && hasClass(el, 'confluence-status') && el.hasAttribute('data-macro-params'),
  record: (marked, payload) => (payload.k === 'macro.status' && marked.localName === 'span' && hasClass(marked, 'confluence-status')
    ? macroParamsRecord(marked, 'macro.status')
    : 'unsupported'),
};

const TOC_KIND: CarrierKind = {
  id: 'macro.toc',
  storageMayCarry: (storage) => storage.includes(MACRO_ELEMENT),
  storedHoldsCarrier: (stored) => stored.querySelector('div.confluence-toc[data-macro-params]') !== null,
  targetHoldsCarrier: (el) => el.localName === 'div' && hasClass(el, 'confluence-toc') && el.hasAttribute('data-macro-params'),
  record: (marked, payload) => (payload.k === 'macro.toc' && marked.localName === 'div' && hasClass(marked, 'confluence-toc')
    ? macroParamsRecord(marked, 'macro.toc')
    : 'unsupported'),
};

const LINK_KIND: CarrierKind = {
  id: 'link',
  storageMayCarry: (storage) => storage.includes('<ac:link'),
  storedHoldsCarrier: (stored) => {
    for (const a of stored.querySelectorAll('a')) {
      const carrier = confluenceLinkCarrierOf(a);
      const link = carrier === null ? null : parseConfluenceLinkHref(carrier, { kinds: CONFLUENCE_LINK_KINDS_1748 });
      if (link && !link.legacy && (link.kind === 'anchor' || hasLinkParameter(link))) return true;
    }
    return false;
  },
  targetHoldsCarrier: (el) => el.localName === 'a' && carriesLinkValue(el),
  record(marked, payload) {
    if (payload.k !== 'link' || marked.localName !== 'a') return 'unsupported';
    const carrier = confluenceLinkCarrierOf(marked);
    if (carrier === null || carrier.length > CONFLUENCE_LINK_LIMITS.href) return 'unsupported';
    const link = parseConfluenceLinkHref(carrier);
    if (!link) return 'unsupported';
    // R7-3: a #1955 kind is no record of `link`.
    if (!CONFLUENCE_LINK_KINDS_1748.includes(link.kind)) return null;
    const own = confluenceLinkHrefAttributes(carrier);
    if (!own || own.href !== marked.getAttribute('href') || own.className !== marked.getAttribute('class')) return 'unsupported';
    // A link whose carried shape is its legacy shape carries nothing to recover. The legacy href is compared as the
    // grammar reads it (kind and decoded value), so `My Page` and today's `My%20Page` are the same link (review r2
    // CAR-9); a legacy href that decodes to another value (a title spelled `a%20b`) still differs.
    const sameText = payload.b === 'rich' || (marked.children.length === 0 && marked.textContent === payload.x);
    const legacy = payload.h === null ? null : parseConfluenceLinkHref(payload.h, { kinds: CONFLUENCE_LINK_KINDS_1748 });
    const sameTarget = payload.h === own.href
      || (legacy !== null && legacy.kind === link.kind && legacy.value === link.value && !hasLinkParameter(link));
    if (sameTarget && own.className === null && sameText) return null;
    const label = payload.b === 'none' && payload.x !== confluenceLinkDisplayText(link)
      ? confluenceLinkDisplayText(link)
      : null;
    const attributes: Array<readonly [string, string]> = [['href', own.href]];
    if (own.className !== null) attributes.push(['class', own.className]);
    attributes.push(['data-confluence-link', link.kind]);
    return { kind: 'link', attributes, label };
  },
};

/** Whether `data-emoticon-attrs` is the object emoticonWriteBack reads. */
function isEmoticonCarrier(raw: string | null): boolean {
  if (raw === null) return false;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      && Object.values(parsed).every((value) => typeof value === 'string');
  } catch {
    return false;
  }
}

const EMOTICON_KIND: CarrierKind = {
  id: 'emoticon',
  storageMayCarry: (storage) => storage.includes('<ac:emoticon'),
  storedHoldsCarrier: (stored) => stored.querySelector('span.confluence-emoticon') !== null,
  targetHoldsCarrier: (el) => el.querySelector('span.confluence-emoticon') !== null,
  record(marked, payload) {
    if (payload.k !== 'emoticon' || marked.localName !== 'span' || marked.childNodes.length > 0) return 'unsupported';
    const names = [...marked.attributes].map((attr) => attr.name);
    if (names.length !== EMOTICON_ATTRIBUTES.length || EMOTICON_ATTRIBUTES.some((name, index) => names[index] !== name)) {
      return 'unsupported';
    }
    if (marked.getAttribute('class') !== 'confluence-emoticon' || !isEmoticonCarrier(marked.getAttribute('data-emoticon-attrs'))) {
      return 'unsupported';
    }
    return {
      kind: 'emoticon',
      attributes: EMOTICON_ATTRIBUTES.map((name) => [name, marked.getAttribute(name)!] as const),
      label: null,
    };
  },
};

/** The registry (D8). Registry order only orders the report. */
export const CARRIER_KINDS: readonly CarrierKind[] = [CODE_KIND, STATUS_KIND, TOC_KIND, LINK_KIND, EMOTICON_KIND];

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

class CarrierBoundStop extends Error {
  constructor() {
    super('carrier reconcile bound');
    this.name = 'CarrierBoundStop';
  }
}

class Work {
  used = 0;
  constructor(readonly limit: number) {}
  charge(units: number): void {
    this.used += units;
    if (this.used > this.limit) throw new CarrierBoundStop();
  }
}

/**
 * Stage 2 (Z4, D17.4): every task list flat, macro nesting and count within the caps, on the reader's tree. A
 * task list inside a task or a list, or a task anywhere but directly in one list, refuses; resemblance (any prefix
 * or case) is an over-approximation used only to refuse.
 */
function preflight(root: StorageElement, budget: CarrierBudget): boolean {
  let macros = 0;
  const walk = (el: StorageElement, lists: number, tasks: number, depth: number): boolean => {
    for (const child of el.children) {
      if (typeof child === 'string') continue;
      const isList = resemblesStorageName(child, 'task-list');
      const isTask = resemblesStorageName(child, 'task');
      if (isList && (lists > 0 || tasks > 0)) return false;
      if (isTask && (tasks > 0 || lists !== 1 || !resemblesStorageName(child.parent!, 'task-list'))) return false;
      const isMacro = resemblesStorageName(child, 'structured-macro');
      if (isMacro) {
        macros += 1;
        if (macros > budget.macros || depth + 1 > budget.macroDepth) return false;
      }
      if (!walk(child, lists + (isList ? 1 : 0), tasks + (isTask ? 1 : 0), depth + (isMacro ? 1 : 0))) return false;
    }
    return true;
  };
  return walk(root, 0, 0, 0);
}

// ---------------------------------------------------------------------------
// Structure: items, runs, keys
// ---------------------------------------------------------------------------

const INLINE_TAGS: Record<string, true> = Object.fromEntries([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data', 'dfn', 'del', 'em', 'font', 'i', 'img', 'ins',
  'kbd', 'mark', 'q', 's', 'samp', 'small', 'span', 'strike', 'strong', 'sub', 'sup', 'time', 'u', 'var', 'wbr',
].map((tag) => [tag, true]));
const LEAF_PARENTS: Record<string, true> = Object.fromEntries(
  ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'td', 'th', 'summary', 'dt', 'dd'].map((tag) => [tag, true]),
);
const MARK_TAG: Readonly<Record<string, string>> = { b: 'strong', i: 'em', strike: 's', del: 's' };
const WHITESPACE = /[\t\n\f\r ]/;
const NON_WHITESPACE = /[^\t\n\f\r ]/;
const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

function isInline(node: Node): boolean {
  return node.nodeType === ELEMENT_NODE && Object.hasOwn(INLINE_TAGS, (node as Element).localName);
}

/**
 * The element that holds a task item's content: TipTap's `<li><label>…</label><div>…</div></li>` keeps it in the
 * div, every other shape in the li (the rule of content-converter's `taskItemContent`, #1751).
 */
function taskContent(li: Element): Element {
  const [label, content] = [li.children[0], li.children[1]];
  if (
    li.children.length === 2
    && label?.localName === 'label'
    && label.querySelector('input[type="checkbox"]') !== null
    && content?.localName === 'div'
  ) return content;
  return li;
}

function contentChildren(container: Element): ChildNode[] {
  const holder = container.localName === 'li' ? taskContent(container) : container;
  return [...holder.childNodes];
}

/** An item of a child sequence: an element child by its label, or a run. */
interface Item {
  readonly label: string;
  readonly el: Element | null;
  readonly nodes: readonly ChildNode[];
}

function labelOf(el: Element): string {
  return el.localName === 'div' ? `div.${el.getAttribute('class') ?? ''}` : el.localName;
}

/**
 * The child sequence of a container (Z2): every element child that is not inline as its label, empty or not; a
 * maximal sequence of text and inline children that holds a non-whitespace character or an inline element as one
 * item `run`; white space between two items is formatting.
 */
function itemsOf(container: Element, work: Work): Item[] {
  const items: Item[] = [];
  let segment: ChildNode[] = [];
  let substantive = false;
  const flush = (): void => {
    if (segment.length > 0 && substantive) items.push({ label: 'run', el: null, nodes: segment });
    segment = [];
    substantive = false;
  };
  for (const child of contentChildren(container)) {
    work.charge(1);
    if (child.nodeType === TEXT_NODE) {
      segment.push(child);
      if (NON_WHITESPACE.test((child as Text).data)) substantive = true;
    } else if (child.nodeType !== ELEMENT_NODE) {
      segment.push(child);
    } else if (isInline(child)) {
      segment.push(child);
      substantive = true;
    } else {
      flush();
      items.push({ label: labelOf(child as Element), el: child as Element, nodes: [child] });
    }
  }
  flush();
  return items;
}

/** A canonical or raw position range of an inline element of a run. */
interface InlineRange {
  t0: number;
  t1: number;
  r0: number;
  r1: number;
  attributeless: boolean;
}

interface RawItem {
  readonly key: string;
  readonly whitespace: boolean;
  /** The mark set id and whether it holds an `a`. */
  readonly marks: number;
  readonly underLink: boolean;
  readonly node: Node;
  /** The code unit offset of the character in its text node (-1 for an atom). */
  readonly offset: number;
  readonly length: number;
}

interface AnchorPosition {
  readonly t: number;
  readonly r: number;
  readonly marks: number;
}

interface RunInfo {
  readonly parent: Element;
  readonly nodes: readonly ChildNode[];
  readonly key: string | null;
  readonly raw: readonly RawItem[];
  readonly rawKey: string;
  readonly ranges: ReadonlyMap<Element, InlineRange>;
  readonly anchors: ReadonlyMap<Text, AnchorPosition>;
  /** Canonical token index → the atom element there. */
  readonly atoms: ReadonlyMap<number, Element>;
  readonly emoticons: number;
  /** The canonical tokens the run's key is built from. */
  readonly tokens: readonly string[];
}

interface DocUnits {
  readonly runOfNode: Map<Node, RunInfo>;
  readonly codeKey: Map<Element, string | null>;
  readonly tocKey: Map<Element, string | null>;
  readonly counts: Map<string, number>;
  readonly cellKeys: Map<Element, string[]>;
  units: number;
}

class UnitUnsupported extends Error {}

interface Ctx {
  readonly marker: string;
  readonly budget: CarrierBudget;
  readonly work: Work;
  readonly intern: Map<string, number>;
  readonly anchors: ReadonlySet<Text>;
  readonly report: CarrierReport;
  readonly witnesses: ReadonlyArray<LexerCodeText | null> | undefined;
}

function intern(ctx: Ctx, signature: string): number {
  const known = ctx.intern.get(signature);
  if (known !== undefined) return known;
  if (signature.length > ctx.budget.signature) throw new UnitUnsupported();
  ctx.work.charge(signature.length);
  const id = ctx.intern.size;
  ctx.intern.set(signature, id);
  return id;
}

function attributePairs(el: Element, ctx: Ctx, link: boolean): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const { name, value } of el.attributes) {
    if (name === ctx.marker) continue;
    if (link && (name === 'target' || name === 'rel' || name === 'data-confluence-link')) continue;
    let compared = value;
    if (link && name === 'href') {
      const parsed = parseConfluenceLinkHref(value);
      // A page or attachment href without parameters compares as its kind and decoded value, so an href Improve
      // re-encoded still equals the stored legacy one.
      if (parsed && (parsed.kind === 'page' || parsed.kind === 'attachment') && !hasLinkParameter(parsed)) {
        compared = `\u0000${parsed.kind}\u0000${parsed.value}`;
      }
    }
    pairs.push([name, compared]);
  }
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return pairs;
}

function ownAttributeCount(el: Element, ctx: Ctx): number {
  let count = 0;
  for (const attr of el.attributes) if (attr.name !== ctx.marker) count += 1;
  return count;
}

function isAtom(el: Element): boolean {
  const tag = el.localName;
  if (tag === 'br' || tag === 'img' || tag === 'wbr') return true;
  if (tag === 'span' && (hasClass(el, 'confluence-status') || hasClass(el, 'confluence-emoticon'))) return true;
  return el.childNodes.length === 0;
}

/**
 * Tokens of a run (§3.4): characters and atoms, each with its mark set; white space collapses to one space across
 * text nodes and mark boundaries, never across an atom; the ends are trimmed. The raw items keep every character.
 */
function tokenizeRun(nodes: readonly ChildNode[], ctx: Ctx): Omit<RunInfo, 'key' | 'parent' | 'nodes'> & { tokens: string[] } {
  const tokens: string[] = [];
  const raw: RawItem[] = [];
  const ranges = new Map<Element, InlineRange>();
  const anchors = new Map<Text, AnchorPosition>();
  const atoms = new Map<number, Element>();
  let pending: number | null = null;
  let emoticons = 0;
  const stack: number[] = [];
  const linkDepth: boolean[] = [];
  let marksId = intern(ctx, '[]');
  const setMarks = (): void => {
    marksId = intern(ctx, JSON.stringify(stack));
  };
  const flushSpace = (): void => {
    if (pending !== null && tokens.length > 0) tokens.push(`${pending}| `);
    pending = null;
  };
  const visit = (node: Node, depth: number): void => {
    if (depth > ctx.budget.inlineDepth) throw new UnitUnsupported();
    if (node.nodeType === TEXT_NODE) {
      const text = node as Text;
      if (ctx.anchors.has(text)) anchors.set(text, { t: tokens.length, r: raw.length, marks: marksId });
      const data = text.data;
      ctx.work.charge(data.length);
      const underLink = linkDepth.includes(true);
      for (let offset = 0; offset < data.length;) {
        const point = data.codePointAt(offset)!;
        const char = String.fromCodePoint(point);
        const whitespace = WHITESPACE.test(char);
        raw.push({ key: `${marksId}|${char}`, whitespace, marks: marksId, underLink, node: text, offset, length: char.length });
        if (whitespace) {
          if (pending === null) pending = marksId;
        } else {
          flushSpace();
          tokens.push(`${marksId}|${char}`);
        }
        offset += char.length;
      }
      return;
    }
    if (node.nodeType !== ELEMENT_NODE) return;
    const el = node as Element;
    const range: InlineRange = { t0: tokens.length, t1: 0, r0: raw.length, r1: 0, attributeless: false };
    if (el.localName === 'a' && ownAttributeCount(el, ctx) === 0) {
      // Not a mark (the legacy shape of a text-only link, which the editor drops): its position is side information.
      range.attributeless = true;
      for (const child of el.childNodes) visit(child, depth + 1);
    } else if (isAtom(el)) {
      flushSpace();
      const signature = JSON.stringify([
        'atom', MARK_TAG[el.localName] ?? el.localName, attributePairs(el, ctx, el.localName === 'a'), el.textContent ?? '',
      ]);
      const id = intern(ctx, signature);
      range.t0 = tokens.length;
      atoms.set(tokens.length, el);
      tokens.push(`${marksId}#${id}`);
      raw.push({ key: `${marksId}#${id}`, whitespace: false, marks: marksId, underLink: linkDepth.includes(true), node: el, offset: -1, length: 0 });
      if (el.localName === 'span' && hasClass(el, 'confluence-emoticon')) emoticons += 1;
    } else {
      const tag = MARK_TAG[el.localName] ?? el.localName;
      stack.push(intern(ctx, JSON.stringify([tag, attributePairs(el, ctx, tag === 'a')])));
      linkDepth.push(tag === 'a');
      setMarks();
      for (const child of el.childNodes) visit(child, depth + 1);
      stack.pop();
      linkDepth.pop();
      setMarks();
    }
    range.t1 = tokens.length;
    range.r1 = raw.length;
    ranges.set(el, range);
    if (el.querySelector('span.confluence-emoticon')) emoticons += 1;
  };
  for (const node of nodes) visit(node, 0);
  return { tokens, raw, rawKey: raw.map((item) => item.key).join('\u0001'), ranges, anchors, atoms, emoticons };
}

/** Labels of the ancestors of `el` from the body down, a task item's content div looked through. */
function frameLabels(el: Element, body: Element, ctx: Ctx): string[] {
  const labels: string[] = [];
  for (let node = el.parentElement; node && node !== body; node = node.parentElement) {
    ctx.work.charge(1);
    const parent = node.parentElement;
    if (node.localName === 'div' && parent?.localName === 'li' && taskContent(parent) === node) continue;
    labels.push(labelOf(node));
    if (labels.length > ctx.budget.frameDepth) throw new UnitUnsupported();
  }
  return labels.reverse();
}

/** The `code` a `pre` holds as its only child node, itself without element children; else null. */
function singleCodeChild(pre: Element): Element | null {
  if (pre.childNodes.length !== 1) return null;
  const code = pre.firstChild as Element | null;
  if (!code || code.nodeType !== ELEMENT_NODE || code.localName !== 'code' || code.children.length > 0) return null;
  return code;
}

function codeLanguage(code: Element): string {
  return /(?:^|\s)language-(\S+)/.exec(code.getAttribute('class') ?? '')?.[1] ?? '';
}

function collectUnits(doc: Document, side: 'C' | 'L' | 'T', ctx: Ctx): DocUnits {
  const body = doc.body;
  const units: DocUnits = {
    runOfNode: new Map(),
    codeKey: new Map(),
    tocKey: new Map(),
    counts: new Map(),
    cellKeys: new Map(),
    units: 0,
  };
  const count = (key: string | null, at: Element): void => {
    units.units += 1;
    if (units.units > ctx.budget.unitsPerDocument) throw new CarrierBoundStop();
    if (key === null) return;
    ctx.report.work.keyUnits += 1;
    units.counts.set(key, (units.counts.get(key) ?? 0) + 1);
    const cell = at.closest('td, th');
    if (cell) {
      const list = units.cellKeys.get(cell) ?? [];
      list.push(key);
      units.cellKeys.set(cell, list);
    }
  };

  // Code units: the elements of codeBlockElements (#1958's one definition); any other pre is opaque.
  const codeBlocks = codeBlockElements(body);
  const witnesses = ctx.witnesses;
  const witnessed = side === 'T' && witnesses !== undefined;
  codeBlocks.forEach((pre, ordinal) => {
    let key: string | null = null;
    try {
      const code = singleCodeChild(pre);
      if (code) {
        const language = codeLanguage(code);
        let text: string | null = code.textContent ?? '';
        if (witnesses !== undefined) {
          if (witnessed) {
            const witness = witnesses.length === codeBlocks.length ? witnesses[ordinal] : undefined;
            text = typeof witness === 'string' ? codeBlockIdentityKey(language, witness) : null;
          } else {
            const projected = projectSourceCodeText(text, language);
            text = projected === null ? null : codeBlockIdentityKey(language, projected);
          }
        }
        if (text !== null) {
          const frames = frameLabels(pre, body, ctx);
          ctx.work.charge(text.length);
          key = JSON.stringify([frames, 'pre', 'code', [attributePairs(pre, ctx, false), attributePairs(code, ctx, false), text]]);
        }
      }
    } catch (error) {
      if (!(error instanceof UnitUnsupported)) throw error;
    }
    units.codeKey.set(pre, key);
    count(key, pre);
  });

  for (const toc of body.querySelectorAll('div.confluence-toc')) {
    let key: string | null = null;
    try {
      key = JSON.stringify([frameLabels(toc, body, ctx), 'div', 'toc', [attributePairs(toc, ctx, false)]]);
      ctx.work.charge(key.length);
    } catch (error) {
      if (!(error instanceof UnitUnsupported)) throw error;
    }
    units.tocKey.set(toc, key);
    count(key, toc);
  }

  const parents: Element[] = [];
  for (const el of body.querySelectorAll('*')) if (Object.hasOwn(LEAF_PARENTS, el.localName)) parents.push(el);
  for (const parent of parents) {
    for (const item of itemsOf(parent, ctx.work)) {
      if (item.label !== 'run') continue;
      let info: RunInfo;
      try {
        const tokenized = tokenizeRun(item.nodes, ctx);
        const frames = frameLabels(parent, body, ctx);
        const type = /^h[1-6]$/.test(parent.localName) ? parent.localName : 'text';
        ctx.work.charge(tokenized.tokens.length);
        const key = JSON.stringify([frames, parent.localName, type, tokenized.tokens]);
        info = { parent, nodes: item.nodes, key, ...tokenized };
      } catch (error) {
        if (!(error instanceof UnitUnsupported)) throw error;
        info = {
          parent, nodes: item.nodes, key: null, raw: [], rawKey: '', ranges: new Map(), anchors: new Map(), atoms: new Map(), emoticons: 0, tokens: [],
        };
      }
      for (const node of item.nodes) units.runOfNode.set(node, info);
      count(info.key, parent);
    }
  }
  return units;
}

// ---------------------------------------------------------------------------
// Positional identity (Z2, D17.2, AA1)
// ---------------------------------------------------------------------------

interface Correspondence {
  /** C element → its L and T counterparts. */
  readonly elements: Map<Element, readonly [Element, Element]>;
  /** C run (by its first node) → the L and T runs at the same index. */
  readonly runs: Map<ChildNode, readonly [Item, Item]>;
  /** C containers whose three child sequences were equal. */
  readonly equal: Set<Element>;
  /** C containers inside which nothing is recovered, with the reason. */
  readonly blocked: Map<Element, CarrierSkipReason>;
}

function isEmptyParagraph(el: Element | null): boolean {
  return el?.localName === 'p' && el.children.length === 0 && !NON_WHITESPACE.test(el.textContent ?? '');
}

/**
 * AA1: the editor's TrailingNode. At body level only, when the stored body ends in a block that is not a
 * paragraph and `T` adds exactly one terminal empty paragraph, that paragraph is not an item. Nothing else is
 * exempt (no second paragraph, no paragraph elsewhere, no exemption inside any other container).
 */
function withoutTrailingParagraph(stored: readonly Item[], target: readonly Item[]): readonly Item[] {
  if (target.length !== stored.length + 1) return target;
  const last = target[target.length - 1]!;
  const storedLast = stored[stored.length - 1];
  if (!isEmptyParagraph(last.el) || !storedLast || storedLast.el === null || storedLast.label === 'p') return target;
  return target.slice(0, -1);
}

function tableIsSupported(table: Element, budget: CarrierBudget): boolean {
  if (table.querySelector('table')) return false;
  const cells = table.querySelectorAll('td, th');
  if (cells.length > budget.tableCells) return false;
  for (const cell of cells) {
    for (const name of ['colspan', 'rowspan']) {
      const value = cell.getAttribute(name);
      if (value !== null && value !== '1') return false;
    }
  }
  return true;
}

function correspond(c: Element, l: Element, t: Element, ctx: Ctx): Correspondence {
  const result: Correspondence = { elements: new Map(), runs: new Map(), equal: new Set(), blocked: new Map() };
  const stack: Array<readonly [Element, Element, Element, number]> = [[c, l, t, 0]];
  result.elements.set(c, [l, t]);
  while (stack.length > 0) {
    const [cp, lp, tp, depth] = stack.pop()!;
    if (depth > ctx.budget.frameDepth) {
      result.blocked.set(cp, 'unsupported');
      continue;
    }
    if (cp.localName === 'table' && !(tableIsSupported(cp, ctx.budget) && tableIsSupported(lp, ctx.budget) && tableIsSupported(tp, ctx.budget))) {
      result.blocked.set(cp, 'ambiguous');
      continue;
    }
    const ci = itemsOf(cp, ctx.work);
    const li = itemsOf(lp, ctx.work);
    const ti = cp === c ? withoutTrailingParagraph(li, itemsOf(tp, ctx.work)) : itemsOf(tp, ctx.work);
    const same = ci.length === li.length && li.length === ti.length
      && ci.every((item, index) => item.label === li[index]!.label && item.label === ti[index]!.label);
    if (!same) {
      result.blocked.set(cp, 'container');
      continue;
    }
    result.equal.add(cp);
    ci.forEach((item, index) => {
      const lItem = li[index]!;
      const tItem = ti[index]!;
      if (item.el === null) {
        result.runs.set(item.nodes[0]!, [lItem, tItem]);
        return;
      }
      const [ce, le, te] = [item.el, lItem.el!, tItem.el!];
      // A task item corresponds only under the same task id (a legacy L has none while C has, so C is not compared).
      if (ce.localName === 'li' && le.getAttribute('data-task-id') !== te.getAttribute('data-task-id')) {
        result.blocked.set(ce, 'container');
        return;
      }
      result.elements.set(ce, [le, te]);
      if (ce.localName === 'pre' || (ce.localName === 'div' && hasClass(ce, 'confluence-toc'))) return;
      stack.push([ce, le, te, depth + 1]);
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Records and the legacy projection π
// ---------------------------------------------------------------------------

interface ProjectedRecord {
  readonly kind: CarrierKind;
  readonly record: CarrierRecord;
  readonly mark: CarrierMark;
  /** The element of π(C) that holds the record (pre, toc div, status span, legacy `<a>`); null for an emoticon. */
  readonly element: Element | null;
  /** An emoticon's position in π(C): an empty text node where it stood. */
  readonly anchor: Text | null;
  readonly order: number;
}

function parseMark(raw: string): CarrierMark | null {
  try {
    const mark: unknown = JSON.parse(raw);
    if (typeof mark !== 'object' || mark === null || Array.isArray(mark)) return null;
    const value = mark as Record<string, unknown>;
    if (!Number.isSafeInteger(value.n) || (value.n as number) < 0) return null;
    switch (value.k) {
      case 'macro.code':
        return typeof value.l === 'string' ? (mark as CarrierMark) : null;
      case 'macro.status':
      case 'macro.toc':
      case 'emoticon':
        return mark as CarrierMark;
      case 'link':
        return (value.h === null || typeof value.h === 'string')
          && (value.x === null || typeof value.x === 'string')
          && (value.b === 'none' || value.b === 'plain' || value.b === 'rich')
          ? (mark as CarrierMark)
          : null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** Replace a record by its legacy shape in π(C) (§3.3 table). Returns the element that now stands for it. */
function project(el: Element, mark: CarrierMark): { element: Element | null; anchor: Text | null } {
  const doc = el.ownerDocument;
  switch (mark.k) {
    case 'macro.code':
      el.removeAttribute('data-title');
      el.removeAttribute('data-macro-params');
      if (mark.l === '') el.firstElementChild?.removeAttribute('class');
      else el.firstElementChild?.setAttribute('class', `language-${mark.l}`);
      return { element: el, anchor: null };
    case 'macro.status':
    case 'macro.toc':
      el.removeAttribute('data-macro-params');
      return { element: el, anchor: null };
    case 'emoticon': {
      const anchor = doc.createTextNode('');
      el.replaceWith(anchor);
      return { element: null, anchor };
    }
    case 'link': {
      const a = doc.createElement('a');
      if (mark.h !== null) {
        a.setAttribute('href', mark.h);
        a.setAttribute('data-confluence-link', mark.h.startsWith('#confluence-attachment:') ? 'attachment' : 'page');
      }
      if (mark.b === 'rich') {
        while (el.firstChild) a.appendChild(el.firstChild);
      } else {
        a.textContent = mark.x ?? '';
      }
      el.replaceWith(a);
      return { element: a, anchor: null };
    }
  }
}

// ---------------------------------------------------------------------------
// Operations and the splice
// ---------------------------------------------------------------------------

interface Planned {
  readonly record: ProjectedRecord;
  /** The T element whose start tag the operation rewrites (attribute operations). */
  readonly element: Element | null;
  readonly attributes: ReadonlyArray<readonly [string, string]>;
  /** An inline operation: the T run (or empty cell) it changes, its raw position and its DOM change. */
  readonly inline: { readonly target: InlineTarget; readonly position: number; readonly apply: () => void } | null;
  /** The raw range of a link operation in T, for the emoticon edge rule. */
  readonly linkRaw: readonly [number, number] | null;
  /** The T run of the record, to order and to subsume start tags. */
  readonly run: RunInfo | null;
  readonly codeOrdinal: number | null;
}

/** What an inline operation rewrites: the nodes between `before` and `after` in `parent`. */
interface InlineTarget {
  readonly parent: Node;
  readonly first: ChildNode | null;
  readonly last: ChildNode | null;
}

/**
 * The nodes a run's inline operation rewrites, in the parent that actually holds them (review r1 CAR-2): a task
 * item's runs live in its content `div`, not in the `li` its child sequence is read from. A run whose ends do not
 * share one parent is not located.
 */
function runTarget(run: RunInfo): InlineTarget | null {
  const first = run.nodes[0]!;
  const last = run.nodes[run.nodes.length - 1]!;
  const parent = first.parentNode;
  return parent && last.parentNode === parent ? { parent, first, last } : null;
}

function serializeNodes(doc: Document, nodes: readonly Node[]): string {
  const holder = doc.createElement('div');
  for (const node of nodes) holder.appendChild(node.cloneNode(true));
  return holder.innerHTML;
}

function serializeStartTag(el: Element): string {
  const holder = el.ownerDocument.createElement('div');
  holder.appendChild(el.cloneNode(false));
  const html = holder.innerHTML;
  const end = `</${el.localName}>`;
  return html.endsWith(end) ? html.slice(0, -end.length) : html;
}

type Location = { startOffset: number; endOffset: number; startTag?: { startOffset: number; endOffset: number }; endTag?: { startOffset: number; endOffset: number } };

const VOID_TAGS: Record<string, true> = Object.fromEntries(
  ['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'].map((tag) => [tag, true]),
);

/** The source range of the nodes `first`..`last` of a run, or null when a parser made one of its ends. */
function nodesRange(locate: (node: Node) => Location | null, first: ChildNode, last: ChildNode): readonly [number, number] | null {
  const start = locate(first);
  const end = locate(last);
  if (!start || !end) return null;
  if (last.nodeType === ELEMENT_NODE && !Object.hasOwn(VOID_TAGS, (last as Element).localName) && !end.endTag) return null;
  if (first.nodeType === ELEMENT_NODE && !start.startTag) return null;
  return [start.startOffset, end.endOffset];
}

// ---------------------------------------------------------------------------
// The function
// ---------------------------------------------------------------------------

function emptyReport(): CarrierReport {
  return {
    outcome: 'none',
    recovered: {},
    skipped: {},
    codeOps: [],
    droppedLinkAttributes: 0,
    work: { nodes: 0, passes: 0, projectedUnits: 0, keyUnits: 0, spliceUnits: 0, containment: 0 },
  };
}

/**
 * Attach the carriers of `storedBodyStorage` that `targetHtml` provably lost to it (#1953). See the module comment
 * for the proof; design/1953.md §3.2 for the steps. Returns `targetHtml` itself whenever nothing is applied.
 */
export function reconcileConfluenceCarriers(
  storedBodyHtml: string | null | undefined,
  storedBodyStorage: string | null | undefined,
  targetHtml: string,
  options: ReconcileCarrierOptions,
): { html: string; report: CarrierReport } {
  const report = emptyReport();
  const end = (outcome: CarrierOutcome, html = targetHtml): { html: string; report: CarrierReport } => {
    report.outcome = outcome;
    if (outcome !== 'recovered' && outcome !== 'evaluated') {
      report.recovered = {};
      report.skipped = {};
      report.codeOps = [];
    }
    return { html, report };
  };
  try {
    const stored = storedBodyHtml;
    const storage = storedBodyStorage;
    // Step 1.
    if (!storage || !stored) return end('none');
    // Step 2 (stage 0): before any scan, probe, read or parse.
    const budget: CarrierBudget = { ...DEFAULT_CARRIER_BUDGET, ...options.budget };
    if (stored.length > budget.length || storage.length > budget.length || targetHtml.length > budget.length) return end('bound');
    if (typeof options.marker !== 'string' || !MARKER_NAME.test(options.marker)) return end('failed');
    // Step 3.
    const registry = options.registry ?? CARRIER_KINDS;
    if (!registry.some((kind) => kind.storageMayCarry(storage))) return end('none');
    if (storage.includes(options.marker)) return end('bound');
    // Step 4 (stage 1).
    const read = readConfluenceStorage(storage, { length: budget.length, depth: budget.readerDepth, nodes: budget.readerNodes });
    if (!read.ok) return end(read.reason === 'not-well-formed' ? 'storage_unreadable' : 'bound');
    report.work.nodes = read.tree.nodes;
    // Step 5 (stage 2): zero conversion passes so far.
    if (!preflight(read.tree.root, budget)) return end('bound');
    // Step 6 (stages 3–4).
    let marked: CarrierMarkedConversion;
    try {
      marked = confluenceToHtmlWithCarrierMarks(storage, options.confluenceId, options.spaceKey, {
        tree: read.tree,
        marker: options.marker,
        limits: { marks: budget.marks, passes: budget.passes, html: 2 * budget.length, work: budget.workFactor * storage.length },
      });
    } catch {
      return end('storage_unconvertible');
    }
    report.work.passes = marked.passes;
    if (!marked.ok) return end(marked.reason);
    report.droppedLinkAttributes = marked.droppedLinkAttributes;
    return reconcileMarked(stored, marked.html, marked.unsupported, targetHtml, options, budget, registry, report, end);
  } catch (error) {
    if (error instanceof CarrierBoundStop) return end('bound');
    return end('failed');
  }
}

type End = (outcome: CarrierOutcome, html?: string) => { html: string; report: CarrierReport };

function skip(report: CarrierReport, kind: CarrierKindId, reason: CarrierSkipReason, count = 1): void {
  const byKind = report.skipped[kind] ?? (report.skipped[kind] = {});
  byKind[reason] = (byKind[reason] ?? 0) + count;
}

function parseHtml(html: string, locations = false): JSDOM {
  return new JSDOM(`<body>${html}</body>`, { contentType: 'text/html', includeNodeLocations: locations });
}

const BODY_PREFIX = '<body>'.length;

function reconcileMarked(
  stored: string,
  markedHtml: string,
  rejected: Readonly<Record<CarrierMarkKind, number>>,
  targetHtml: string,
  options: ReconcileCarrierOptions,
  budget: CarrierBudget,
  registry: readonly CarrierKind[],
  report: CarrierReport,
  end: End,
): { html: string; report: CarrierReport } {
  const marker = options.marker;
  // Step 7.
  const lDoc = parseHtml(stored).window.document;
  const cDoc = parseHtml(markedHtml).window.document;
  const tDom = parseHtml(targetHtml, true);
  const tDoc = tDom.window.document;

  // Step 8: the kind gate, on the whole stored body.
  const legacy = new Map<CarrierKindId, CarrierKind>();
  for (const kind of registry) if (!kind.storedHoldsCarrier(lDoc)) legacy.set(kind.id, kind);

  // Step 9 (first half): records of legacy kinds, π applied in place on C's document.
  const markedElements = [...cDoc.body.querySelectorAll(`[${marker}]`)];
  const payloads = markedElements.map((el) => parseMark(el.getAttribute(marker) ?? ''));
  const seen = new Map<number, number>();
  for (const mark of payloads) if (mark) seen.set(mark.n, (seen.get(mark.n) ?? 0) + 1);
  const records: ProjectedRecord[] = [];
  const evaluated = new Set<CarrierKindId>();
  markedElements.forEach((el, index) => {
    const mark = payloads[index];
    el.removeAttribute(marker);
    if (!mark) return;
    const kind = legacy.get(mark.k);
    if (!kind) return;
    if ((seen.get(mark.n) ?? 0) > 1) {
      // A pass cloned the source's markup: no record with that index can be told apart (S8).
      evaluated.add(kind.id);
      skip(report, kind.id, 'unsupported');
      return;
    }
    let record: CarrierRecord | 'unsupported' | null;
    try {
      record = kind.record(el, mark);
    } catch {
      evaluated.add(kind.id);
      skip(report, kind.id, 'error');
      return;
    }
    if (record === null) return;
    evaluated.add(kind.id);
    if (record === 'unsupported') {
      skip(report, kind.id, 'unsupported');
      return;
    }
    const projected = project(el, mark);
    records.push({ kind, record, mark, element: projected.element, anchor: projected.anchor, order: records.length });
  });
  // AA3: a source a builder rejected before marking is counted for its legacy kind, so a kind whose only
  // candidate was rejected is evaluated with a skip, never `none` and never fully evaluated.
  for (const [kind, count] of Object.entries(rejected) as Array<[CarrierKindId, number]>) {
    if (count > 0 && legacy.has(kind)) {
      evaluated.add(kind);
      skip(report, kind, 'unsupported', count);
    }
  }
  for (const marked of cDoc.body.querySelectorAll(`[${marker}]`)) marked.removeAttribute(marker);
  if (evaluated.size === 0) return end('none');
  if (records.length === 0) return end('evaluated');

  const work = new Work(budget.workFactor * (stored.length + markedHtml.length + targetHtml.length));
  const ctx: Ctx = {
    marker,
    budget,
    work,
    intern: new Map(),
    anchors: new Set(records.flatMap((record) => (record.anchor ? [record.anchor] : []))),
    report,
    witnesses: options.codeWitnesses,
  };

  // Step 9 (second half): units, keys and positional identity.
  const cUnits = collectUnits(cDoc, 'C', ctx);
  report.work.projectedUnits = cUnits.units;
  const lUnits = collectUnits(lDoc, 'L', ctx);
  const tUnits = collectUnits(tDoc, 'T', ctx);
  const corr = correspond(cDoc.body, lDoc.body, tDoc.body, ctx);
  const tCodeBlocks = codeBlockElements(tDoc.body);

  const runOf = (units: DocUnits, node: Node): RunInfo | null => {
    for (let at: Node | null = node; at && at !== cDoc.body; at = at.parentNode) {
      const run = units.runOfNode.get(at);
      if (run) return run;
    }
    return null;
  };
  const unplacedReason = (node: Node): CarrierSkipReason => {
    for (let at: Node | null = node; at; at = at.parentNode) {
      const reason = corr.blocked.get(at as Element);
      if (reason) return reason;
    }
    return 'container';
  };
  const unique = (key: string): boolean =>
    cUnits.counts.get(key) === 1 && lUnits.counts.get(key) === 1 && tUnits.counts.get(key) === 1;

  // Status ambiguity (§3.5; review r1 CAR-4, r2 CAR-8, r3 CAR-12). Two statuses of one run are told apart only by
  // what they are, their own canonical attributes and text, never by the marks around their positions (a swap
  // moves the status, not the marks). Equal identities with different carried values both abstain. Each record is
  // indexed once, charged before, so planning a run of n records is linear in n.
  const shapes = new Map<RunInfo, Map<string, Set<string>>>();
  const shapeOf = new Map<ProjectedRecord, string>();
  for (const record of records) {
    if (!record.element || record.mark.k !== 'macro.status') continue;
    const run = runOf(cUnits, record.element);
    if (!run) continue;
    let size = (record.element.textContent ?? '').length + 16;
    for (const { name, value } of record.element.attributes) size += name.length + value.length + 4;
    const value = JSON.stringify(record.record.attributes);
    work.charge(size + value.length);
    const shape = JSON.stringify([attributePairs(record.element, ctx, false), record.element.textContent ?? '']);
    shapeOf.set(record, shape);
    const groups = shapes.get(run) ?? new Map<string, Set<string>>();
    shapes.set(run, groups);
    const values = groups.get(shape) ?? new Set<string>();
    groups.set(shape, values);
    values.add(value);
  }
  // Link ambiguity (review r3 CAR-12/13, coordinator ruling on link identity). A link target is recovered only when
  // its visible label is shown by no other link of any kind in L, in S (as the forward conversion shows it) or in T,
  // whatever the marks, wrappers or positions; otherwise the record abstains page-wide. No finer identity proof is
  // attempted: a link that needs no change is a rival as much as one that does.
  const linkLabels = [lDoc, cDoc, tDoc].map((doc) => {
    const counts = new Map<string, number>();
    for (const a of doc.body.querySelectorAll('a')) {
      const text = a.textContent ?? '';
      work.charge(text.length + 1);
      const label = text.replace(/[\t\n\f\r ]+/g, ' ').trim();
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return counts;
  });
  const labelShared = (el: Element): boolean => {
    const label = (el.textContent ?? '').replace(/[\t\n\f\r ]+/g, ' ').trim();
    return linkLabels.some((counts) => (counts.get(label) ?? 0) > 1);
  };
  // Twin index (§3.5, Improve only): language class and rendered text of every effective code block of T.
  const twins = new Map<string, number>();
  if (options.codeWitnesses !== undefined) {
    for (const pre of tDoc.body.querySelectorAll('pre')) {
      const code = pre.querySelector('code');
      if (!code) continue;
      const key = `${code.getAttribute('class') ?? ''}\u0000${code.textContent ?? ''}`;
      work.charge(key.length);
      twins.set(key, (twins.get(key) ?? 0) + 1);
    }
  }

  // Step 10: pairing, veto, plan, kind by kind in registry order.
  const plans: Planned[] = [];
  const byKind = new Map<CarrierKindId, ProjectedRecord[]>();
  for (const record of records) {
    const list = byKind.get(record.kind.id);
    if (list) list.push(record);
    else byKind.set(record.kind.id, [record]);
  }
  for (const { id: kindId } of registry) {
    const kindRecords = byKind.get(kindId);
    if (!kindRecords) continue;
    const kindPlans: Planned[] = [];
    const kindSkips: Array<readonly [CarrierSkipReason, number]> = [];
    try {
      for (const record of kindRecords) {
        const outcome = planRecord(record);
        if (typeof outcome === 'string') kindSkips.push([outcome, 1]);
        else kindPlans.push(outcome);
      }
    } catch (error) {
      if (error instanceof CarrierBoundStop) throw error;
      skip(report, kindId, 'error', kindRecords.length);
      continue;
    }
    for (const [reason, count] of kindSkips) skip(report, kindId, reason, count);
    plans.push(...kindPlans);
  }

  function planRecord(record: ProjectedRecord): Planned | CarrierSkipReason {
    const { kind, mark } = record;
    if (mark.k === 'link' && labelShared(record.element!)) return 'ambiguous';
    if (mark.k === 'macro.code' || mark.k === 'macro.toc') {
      const el = record.element!;
      const pair = corr.elements.get(el);
      if (!pair) return unplacedReason(el);
      const [lEl, tEl] = pair;
      const keys = mark.k === 'macro.code'
        ? [cUnits.codeKey.get(el), lUnits.codeKey.get(lEl), tUnits.codeKey.get(tEl)]
        : [cUnits.tocKey.get(el), lUnits.tocKey.get(lEl), tUnits.tocKey.get(tEl)];
      if (mark.k === 'macro.code' && options.codeWitnesses !== undefined && (keys[2] === null || keys[2] === undefined)
        && singleCodeChild(tEl) !== null) return 'no_witness';
      if (keys.some((key) => key === null || key === undefined)) return 'unsupported';
      if (keys[0] !== keys[1] || keys[1] !== keys[2]) return 'changed';
      if (!unique(keys[0]!)) return 'not_unique';
      if (kind.targetHoldsCarrier(tEl)) return 'carried';
      let ordinal: number | null = null;
      if (mark.k === 'macro.code') {
        ordinal = tCodeBlocks.indexOf(tEl);
        if (ordinal < 0) return 'unsupported';
        if (options.codeWitnesses !== undefined && hasTwin(tEl)) return 'ambiguous';
      }
      return { record, element: tEl, attributes: record.record.attributes, inline: null, linkRaw: null, run: null, codeOrdinal: ordinal };
    }

    // Inline kinds: the record's run.
    const node: Node = record.element ?? record.anchor!;
    const cRun = runOf(cUnits, node);
    if (!cRun) {
      if (mark.k === 'emoticon') return emptyBlock(record);
      return unplacedReason(node);
    }
    const pair = corr.runs.get(cRun.nodes[0]!);
    if (!pair || !Object.hasOwn(LEAF_PARENTS, cRun.parent.localName) || !corr.equal.has(cRun.parent)) return unplacedReason(node);
    const lRun = lUnits.runOfNode.get(pair[0].nodes[0]!) ?? null;
    const tRun = tUnits.runOfNode.get(pair[1].nodes[0]!) ?? null;
    if (!lRun || !tRun || cRun.key === null || lRun.key === null || tRun.key === null) return 'unsupported';
    if (cRun.key !== lRun.key || lRun.key !== tRun.key) return 'changed';
    if (!unique(cRun.key)) return 'not_unique';
    const rawEqual = cRun.rawKey === lRun.rawKey && tRun.rawKey === lRun.rawKey;

    if (mark.k === 'macro.status') {
      const range = cRun.ranges.get(record.element!);
      const tEl = range ? tRun.atoms.get(range.t0) : undefined;
      if (!range || !tEl || tEl.localName !== 'span' || !hasClass(tEl, 'confluence-status')) return 'no_element';
      if (kind.targetHoldsCarrier(tEl)) return 'carried';
      if (ambiguousIn(record, cRun)) return 'ambiguous';
      return { record, element: tEl, attributes: record.record.attributes, inline: null, linkRaw: null, run: tRun, codeOrdinal: null };
    }

    if (mark.k === 'emoticon') {
      // Veto: the target run already holds an emoticon (the registry's predicate on each of its elements).
      const occupied = tRun.emoticons > 0
        || tRun.nodes.some((child) => child.nodeType === ELEMENT_NODE && kind.targetHoldsCarrier(child as Element));
      if (occupied) return 'carried';
      if (!rawEqual) return 'boundary';
      return planEmoticon(record, cRun, tRun);
    }

    if (mark.k !== 'link') return 'unsupported';
    return planLink(record, mark, cRun, lRun, tRun, rawEqual);
  }

  /**
   * Two statuses of one run with equal identities (status index above) and different carried values cannot be told
   * apart (§3.5): both are ambiguous. Links use the page-wide label rule; emoticons are identified by their offset.
   */
  function ambiguousIn(record: ProjectedRecord, run: RunInfo): boolean {
    const shape = shapeOf.get(record);
    return shape !== undefined && (shapes.get(run)?.get(shape)?.size ?? 0) > 1;
  }

  /** Another effective code block of T has the target's language class and rendered text (twin index above). */
  function hasTwin(target: Element): boolean {
    const code = target.querySelector('code');
    return (twins.get(`${code?.getAttribute('class') ?? ''}\u0000${code?.textContent ?? ''}`) ?? 0) > 1;
  }

  /** An emoticon at raw offset `r` of `cRun`, inserted at the same raw offset of `tRun` (§3.5). */
  function planEmoticon(record: ProjectedRecord, cRun: RunInfo, tRun: RunInfo): Planned | CarrierSkipReason {
    const position = cRun.anchors.get(record.anchor!);
    if (!position) return 'unsupported';
    // The gap: the white space around the position must share the emoticon's mark set.
    for (let index = position.r - 1; index >= 0 && cRun.raw[index]!.whitespace; index -= 1) {
      if (cRun.raw[index]!.marks !== position.marks) return 'boundary';
    }
    for (let index = position.r; index < cRun.raw.length && cRun.raw[index]!.whitespace; index += 1) {
      if (cRun.raw[index]!.marks !== position.marks) return 'boundary';
    }
    const before = tRun.raw[position.r - 1];
    const after = tRun.raw[position.r];
    let text: Text;
    let offset: number;
    if (before && before.offset >= 0 && before.marks === position.marks) {
      text = before.node as Text;
      offset = before.offset + before.length;
    } else if (after && after.offset >= 0 && after.marks === position.marks) {
      text = after.node as Text;
      offset = after.offset;
    } else {
      return 'boundary';
    }
    const values = record.record.attributes;
    const target = runTarget(tRun);
    if (!target) return 'unlocatable';
    return {
      record,
      element: null,
      attributes: values,
      inline: {
        target,
        position: position.r,
        apply: () => {
          const right = text.splitText(offset);
          const span = tDoc.createElement('span');
          for (const [name, value] of values) span.setAttribute(name, value);
          right.parentNode!.insertBefore(span, right);
        },
      },
      linkRaw: null,
      run: tRun,
      codeOrdinal: null,
    };
  }

  /** An emoticon whose block holds nothing else: only an emoticon-only cell of an unchanged grid (§3.4). */
  function emptyBlock(record: ProjectedRecord): Planned | CarrierSkipReason {
    const anchor = record.anchor!;
    let leaf: Element | null = anchor.parentElement;
    while (leaf && isInline(leaf)) leaf = leaf.parentElement;
    if (!leaf || leaf === cDoc.body) return unplacedReason(anchor);
    if (leaf.localName === 'div' && leaf.parentElement?.localName === 'li' && taskContent(leaf.parentElement) === leaf) leaf = leaf.parentElement;
    if (!Object.hasOwn(LEAF_PARENTS, leaf.localName)) return unplacedReason(anchor);
    const pair = corr.elements.get(leaf);
    if (!pair || !corr.equal.has(leaf.parentElement!)) return unplacedReason(anchor);
    if (leaf.localName !== 'td' && leaf.localName !== 'th') return 'empty_block';
    if (anchor.parentElement !== leaf) return 'boundary';
    const table = leaf.closest('table');
    const tables = table ? corr.elements.get(table) : undefined;
    if (!table || !tables || corr.blocked.has(table)) return 'ambiguous';
    if (!gridUnchanged(table, tables[0], tables[1])) return 'ambiguous';
    const tCell = pair[1];
    // The span goes into the cell or into its single empty paragraph, where the stored white space is unchanged.
    const cText = leaf.textContent ?? '';
    const lText = pair[0].textContent ?? '';
    let target: Element = tCell;
    if (tCell.children.length === 1 && isEmptyParagraph(tCell.firstElementChild)) target = tCell.firstElementChild!;
    else if (tCell.children.length > 0) return 'boundary';
    if (NON_WHITESPACE.test(cText) || cText !== lText || (target.textContent ?? '') !== cText || pair[0].children.length > 0) {
      return 'boundary';
    }
    // Raw offset of the anchor among the cell's text.
    let offset = 0;
    for (const child of leaf.childNodes) {
      if (child === anchor) break;
      if (child.nodeType === TEXT_NODE) offset += (child as Text).data.length;
    }
    const values = record.record.attributes;
    return {
      record,
      element: null,
      attributes: values,
      inline: {
        target: { parent: target, first: target.firstChild, last: target.lastChild },
        position: offset,
        apply: () => {
          const span = tDoc.createElement('span');
          for (const [name, value] of values) span.setAttribute(name, value);
          // A span already inserted at this offset (a later record) stays after this one: insert before it.
          let remaining = offset;
          for (const child of [...target.childNodes]) {
            if (child.nodeType === TEXT_NODE) {
              const length = (child as Text).data.length;
              if (remaining <= length) {
                target.insertBefore(span, (child as Text).splitText(remaining));
                return;
              }
              remaining -= length;
            } else if (remaining === 0) {
              target.insertBefore(span, child);
              return;
            }
          }
          target.appendChild(span);
        },
      },
      linkRaw: null,
      run: null,
      codeOrdinal: null,
    };
  }

  function gridUnchanged(cTable: Element, lTable: Element, tTable: Element): boolean {
    const cells = (table: Element, units: DocUnits): string[][] => [...table.querySelectorAll('tr')].map((row) =>
      [...row.children].filter((cell) => cell.localName === 'td' || cell.localName === 'th')
        .map((cell) => JSON.stringify(units.cellKeys.get(cell) ?? [])));
    const c = cells(cTable, cUnits);
    const l = cells(lTable, lUnits);
    const t = cells(tTable, tUnits);
    if (JSON.stringify(c) !== JSON.stringify(l) || JSON.stringify(l) !== JSON.stringify(t)) return false;
    // Rows pairwise distinct; columns pairwise distinct. An emoticon-only cell has no unit key, so the emoticon
    // cells themselves are told apart only by their row and column neighbours.
    const rows = c.map((row) => JSON.stringify(row));
    if (new Set(rows).size !== rows.length) return false;
    const width = Math.max(0, ...c.map((row) => row.length));
    if (c.some((row) => row.length !== width)) return false;
    const columns = Array.from({ length: width }, (_, index) => JSON.stringify(c.map((row) => row[index])));
    return new Set(columns).size === columns.length;
  }

  function planLink(
    record: ProjectedRecord,
    mark: Extract<CarrierMark, { k: 'link' }>,
    cRun: RunInfo,
    lRun: RunInfo,
    tRun: RunInfo,
    rawEqual: boolean,
  ): Planned | CarrierSkipReason {
    const cRange = cRun.ranges.get(record.element!);
    if (!cRange) return 'unsupported';
    const { record: values } = record;
    const anchorsOver = (run: RunInfo, range: InlineRange): Array<[Element, InlineRange]> => {
      work.charge(run.ranges.size);
      return [...run.ranges].filter(([el, other]) => el.localName === 'a'
        && (range.t0 === range.t1
          ? other.t0 === range.t0 && other.t1 === range.t1
          : other.t0 < range.t1 && other.t1 > range.t0));
    };
    const tAnchors = anchorsOver(tRun, cRange);
    const lAnchors = anchorsOver(lRun, cRange);

    if (mark.h !== null) {
      // Element present: exactly one <a> of T over the record's range.
      if (tAnchors.length !== 1) return 'range';
      const [tEl, tRange] = tAnchors[0]!;
      if (tRange.t0 !== cRange.t0 || tRange.t1 !== cRange.t1 || tRange.attributeless) return 'range';
      if (record.kind.targetHoldsCarrier(tEl)) return 'carried';
      // Only the proven legacy `href` is replaced (§3.5). Any other attribute the operation writes that T already
      // holds must be the stored body's own value at that link, unedited (review r1 CAR-6); else T changed it.
      const lEl = lAnchors.length === 1 && lAnchors[0]![1].t0 === cRange.t0 && lAnchors[0]![1].t1 === cRange.t1 ? lAnchors[0]![0] : null;
      const edited = values.attributes.some(([name]) => name !== 'href' && tEl.hasAttribute(name)
        && tEl.getAttribute(name) !== lEl?.getAttribute(name));
      if (edited) return 'changed';
      const linkRaw = [tRange.r0, tRange.r1] as const;
      if (values.label === null) {
        return { record, element: tEl, attributes: values.attributes, inline: null, linkRaw, run: tRun, codeOrdinal: null };
      }
      // A synthetic label (M4): the <a> holds exactly one text node equal to the legacy text.
      if (tEl.childNodes.length !== 1 || tEl.firstChild!.nodeType !== TEXT_NODE || tEl.textContent !== mark.x) return 'range';
      if (!rawEqual) return 'boundary';
      return inlineLink(record, tRun, tRange.r0, linkRaw, () => {
        for (const [name, value] of values.attributes) tEl.setAttribute(name, value);
        (tEl.firstChild as Text).data = values.label!;
      });
    }

    // Text only: no href in the legacy shape.
    if (mark.x === '' && mark.b === 'none') {
      // Body-less: only where L and T each hold exactly one empty <a> without attributes at the position.
      const single = (anchors: Array<[Element, InlineRange]>): Element | null =>
        (anchors.length === 1 && anchors[0]![1].attributeless && anchors[0]![0].childNodes.length === 0 ? anchors[0]![0] : null);
      const tEl = single(tAnchors);
      if (!single(lAnchors) || !tEl) return 'no_element';
      if (!rawEqual) return 'boundary';
      const label = values.label ?? '';
      return inlineLink(record, tRun, tRun.ranges.get(tEl)!.r0, [tRun.ranges.get(tEl)!.r0, tRun.ranges.get(tEl)!.r1], () => {
        for (const [name, value] of values.attributes) tEl.setAttribute(name, value);
        if (label !== '') tEl.textContent = label;
      });
    }
    if (record.element!.children.length > 0) return 'range';
    if (tAnchors.length === 1) {
      const [tEl, tRange] = tAnchors[0]!;
      const lMatch = lAnchors.length === 1 && lAnchors[0]![1].attributeless
        && lAnchors[0]![1].t0 === cRange.t0 && lAnchors[0]![1].t1 === cRange.t1;
      if (!tRange.attributeless || tRange.t0 !== cRange.t0 || tRange.t1 !== cRange.t1 || !lMatch) return 'range';
      const linkRaw = [tRange.r0, tRange.r1] as const;
      if (values.label !== null) {
        if (!rawEqual) return 'boundary';
        return inlineLink(record, tRun, tRange.r0, linkRaw, () => {
          for (const [name, value] of values.attributes) tEl.setAttribute(name, value);
          tEl.textContent = values.label!;
        });
      }
      return { record, element: tEl, attributes: values.attributes, inline: null, linkRaw, run: tRun, codeOrdinal: null };
    }
    if (tAnchors.length > 0) return 'range';
    // The editor dropped the <a>: wrap the stored range, which must lie in one text node outside any link.
    if (!rawEqual) return 'boundary';
    const first = tRun.raw[cRange.r0];
    const last = tRun.raw[cRange.r1 - 1];
    if (!first || !last || first.offset < 0 || first.node !== last.node) return 'range';
    for (let index = cRange.r0; index < cRange.r1; index += 1) {
      const item = tRun.raw[index]!;
      if (item.node !== first.node || item.underLink) return 'range';
    }
    const text = first.node as Text;
    const start = first.offset;
    const stop = last.offset + last.length;
    return inlineLink(record, tRun, cRange.r0, [cRange.r0, cRange.r1], () => {
      text.splitText(stop);
      const middle = text.splitText(start);
      const a = tDoc.createElement('a');
      for (const [name, value] of values.attributes) a.setAttribute(name, value);
      middle.parentNode!.insertBefore(a, middle);
      a.appendChild(middle);
      if (values.label !== null) a.textContent = values.label;
    });
  }

  function inlineLink(record: ProjectedRecord, tRun: RunInfo, position: number, linkRaw: readonly [number, number], apply: () => void): Planned | CarrierSkipReason {
    const target = runTarget(tRun);
    if (!target) return 'unlocatable';
    return { record, element: null, attributes: record.record.attributes, inline: { target, position, apply }, linkRaw, run: tRun, codeOrdinal: null };
  }

  // An emoticon never goes to the edge of (or into) a link operation of its run.
  const accepted: Planned[] = [];
  for (const plan of plans) {
    if (plan.record.mark.k === 'emoticon' && plan.run) {
      const touches = plans.some((other) => other.run === plan.run && other.linkRaw
        && plan.inline!.position >= other.linkRaw[0] && plan.inline!.position <= other.linkRaw[1]);
      if (touches) {
        skip(report, 'emoticon', 'boundary');
        continue;
      }
    }
    accepted.push(plan);
  }

  // Step 11.
  if (accepted.length === 0) return end('evaluated');
  return splice(accepted);

  function splice(planned: Planned[]): { html: string; report: CarrierReport } {
    const locate = (node: Node): Location | null => {
      try {
        return (tDom.nodeLocation(node) as Location | null) ?? null;
      } catch {
        return null;
      }
    };
    // Ranges first, before anything changes: a missing range skips its unit (`unlocatable`). A run and a start tag
    // are different regions even when the run starts with that element (review r1 CAR-1); containment is resolved
    // below, before anything is applied.
    interface Region { start: number; end: number; run: boolean; plans: Planned[]; serialize: () => string }
    const runRegions = new Map<Node, Region>();
    const tagRegions: Region[] = [];
    // A recovery is reported only for a carrier that was absent and is added (review r2 CAR-9): an attribute
    // operation whose values the target already holds is no operation.
    planned = planned.filter((plan) => {
      const noop = !plan.inline && plan.attributes.every(([name, value]) => plan.element!.getAttribute(name) === value);
      if (noop) skip(report, plan.record.kind.id, 'carried');
      return !noop;
    });
    for (const plan of planned) {
      if (plan.inline) {
        const { parent, first, last } = plan.inline.target;
        let region = runRegions.get(first ?? parent);
        if (!region) {
          let range: readonly [number, number] | null;
          if (first && last) {
            range = nodesRange(locate, first, last);
          } else {
            const own = locate(parent);
            range = own?.startTag ? [own.startTag.endOffset, own.startTag.endOffset] : null;
          }
          if (!range) {
            skip(report, plan.record.kind.id, 'unlocatable');
            continue;
          }
          // Everything between the run's outer neighbours in its actual parent, as it stands after the changes.
          const before = first ? first.previousSibling : null;
          const after = last ? last.nextSibling : null;
          region = {
            start: range[0] - BODY_PREFIX,
            end: range[1] - BODY_PREFIX,
            run: true,
            plans: [],
            serialize: () => {
              const nodes: Node[] = [];
              for (let node = before ? before.nextSibling : parent.firstChild; node && node !== after; node = node.nextSibling) {
                nodes.push(node);
              }
              return serializeNodes(tDoc, nodes);
            },
          };
          runRegions.set(first ?? parent, region);
        }
        region.plans.push(plan);
        continue;
      }
      const el = plan.element!;
      const own = locate(el);
      if (!own?.startTag) {
        skip(report, plan.record.kind.id, 'unlocatable');
        continue;
      }
      const start = own.startTag.startOffset - BODY_PREFIX;
      const stop = own.startTag.endOffset - BODY_PREFIX;
      const spelled = targetHtml.slice(start, stop).toLowerCase();
      if (!spelled.startsWith(`<${el.localName}`) || !spelled.endsWith('>')) {
        skip(report, plan.record.kind.id, 'unlocatable');
        continue;
      }
      tagRegions.push({ start, end: stop, run: false, plans: [plan], serialize: () => serializeStartTag(el) });
    }
    // A start tag inside a rewritten run is written by that run's serialization (review r1 CAR-1). Only run regions
    // can contain one (review r2 CAR-10): the disjoint runs are sorted once and each start tag binary-searches them,
    // every step charged before it is taken; with no run region nothing is compared.
    const runs = [...runRegions.values()];
    const ordered: Region[] = [...runs];
    if (runs.length > 0) {
      const steps = Math.ceil(Math.log2(runs.length + 1));
      work.charge(runs.length * steps + tagRegions.length * steps);
      report.work.containment += runs.length * steps + tagRegions.length * steps;
      runs.sort((a, b) => a.start - b.start);
    }
    for (const region of tagRegions) {
      let host: Region | undefined;
      for (let low = 0, high = runs.length - 1; low <= high;) {
        const middle = (low + high) >> 1;
        const run = runs[middle]!;
        if (run.end < region.end) low = middle + 1;
        else if (run.start > region.start) high = middle - 1;
        else {
          host = run;
          break;
        }
      }
      if (host) host.plans.push(...region.plans);
      else ordered.push(region);
    }
    work.charge(ordered.length * Math.ceil(Math.log2(ordered.length + 1)));
    ordered.sort((a, b) => a.start - b.start);
    for (let index = 1; index < ordered.length; index += 1) {
      if (ordered[index]!.start < ordered[index - 1]!.end) throw new Error('overlapping carrier splices');
    }
    if (ordered.length === 0) return end('evaluated');

    // Apply in the DOM: attributes, then inline changes per run from right to left.
    for (const region of ordered) {
      const inline = region.plans.filter((plan) => plan.inline).sort((a, b) => b.inline!.position - a.inline!.position || b.record.order - a.record.order);
      for (const plan of region.plans) {
        if (!plan.inline) for (const [name, value] of plan.attributes) plan.element!.setAttribute(name, value);
      }
      for (const plan of inline) plan.inline!.apply();
    }
    // Serialize, charged before each is built.
    let html = '';
    let cursor = 0;
    for (const region of ordered) {
      const values = region.plans.reduce((sum, plan) => sum + plan.attributes.reduce((n, [a, b]) => n + a.length + b.length, 0), 0);
      const charge = region.end - region.start + values;
      work.charge(charge);
      report.work.spliceUnits += charge;
      html += targetHtml.slice(cursor, region.start) + region.serialize();
      cursor = region.end;
    }
    html += targetHtml.slice(cursor);
    // Invariant (review r1): every change made in the DOM is in the returned HTML. Read back, the result must be
    // exactly the changed document; otherwise nothing is reported and T is returned (`failed`).
    work.charge(html.length);
    if (parseHtml(html).window.document.body.innerHTML !== tDoc.body.innerHTML) {
      throw new Error('carrier splice does not reproduce the changed document');
    }
    for (const region of ordered) {
      for (const plan of region.plans) {
        const kind = plan.record.kind.id;
        report.recovered[kind] = (report.recovered[kind] ?? 0) + 1;
        if (plan.codeOrdinal !== null) {
          report.codeOps.push({
            ordinal: plan.codeOrdinal,
            title: plan.attributes.find(([name]) => name === 'data-title')?.[1] ?? null,
            macroParams: plan.attributes.find(([name]) => name === 'data-macro-params')?.[1] ?? null,
          });
        }
      }
    }
    report.codeOps.sort((a, b) => a.ordinal - b.ordinal);
    return end('recovered', html);
  }
}
