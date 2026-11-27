/**
 * Which `ri:url` links of a written storage string were already in the page
 * (#1955, decision D2).
 *
 * A `ri:url` link whose value is not a navigable URL (`javascript:`, a
 * relative path, an empty value, …) is inert in body_html and is written back
 * to Confluence only as the occurrence the stored page already holds: an
 * import, a create or an AI Improve Accept can never add one, multiply one or
 * point one somewhere else. This module decides that on two readings made by
 * the storage reader (`confluence-storage-reader.ts`): the string about to be
 * written, and the stored storage as evidence. It reads trees only; it never
 * touches a document and never produces storage.
 *
 * {@link analyseStorageLinks} finds every element that may be a URL link and
 * describes it; {@link judgeStorageUrlLinks} matches written links to stored
 * ones, one to one. Recognition is wide (any prefix, any case, a rebound
 * prefix, a `url` nested deeper than a link's child) and authority is narrow:
 * only the exact shape write-back builds, in the Confluence namespaces, is
 * ever approved or counted as evidence.
 */
import {
  CONFLUENCE_LINK_LIMITS,
  CONFLUENCE_LINK_PRIMARY_ATTR,
  CONFLUENCE_LINK_RESOURCE_ELEMENT,
  buildConfluenceLinkHref,
  confluenceLinkDisplayText,
  isConfluenceLinkLocalName,
  isConfluenceLinkValue,
  isNavigableConfluenceUrl,
  type ConfluenceLinkAttr,
  type ConfluenceLinkKind,
} from '@compendiq/contracts';
import {
  isStorageName,
  resemblesStorageName,
  STORAGE_READER_LIMITS,
  type ConfluenceStoragePrefix,
  type StorageAttribute,
  type StorageElement,
  type StorageTree,
} from './confluence-storage-reader.js';

export interface StorageLinkLimits {
  /**
   * The most an analysis or a judgement may cost: one unit for each step it
   * takes and for each character it keeps besides the text of the string
   * itself (a body, the description of an image or of a target).
   */
  readonly work: number;
}

/**
 * A real page is far below it. Nothing else limits what is compared: a body
 * of any length and with any number of images is evidence like any other.
 * Past `work` the analysis stops ({@link StorageLinkBudgetError}) and the
 * write is refused; a link is never dropped because judging it was costly.
 */
export const STORAGE_LINK_LIMITS: StorageLinkLimits = { work: STORAGE_READER_LIMITS.nodes * 8 };

/** The text taken on each side of a link as its place, in characters that are not white space. */
const PLACE_WINDOW = 64;

/** The analysis or the judgement would cost more than {@link StorageLinkLimits.work}. */
export class StorageLinkBudgetError extends Error {
  constructor() {
    super('The links of a storage string are too many or too deeply nested to judge');
    this.name = 'StorageLinkBudgetError';
  }
}

/**
 * Something in a storage string that points somewhere: every link-like element
 * and every HTML anchor with an href. All of them take part in a judgement,
 * because a written link that sits exactly where another target stood, or
 * that took over another target's body, is that other thing retargeted.
 */
export interface StorageLinkClaim {
  /** What it points at, comparable across two readings. */
  readonly target: string;
  /**
   * Its body: `[text, images]` as JSON, the text with white space collapsed.
   * A link without a body of its own has the text the forward pass shows for
   * it (any kind). `''` when that is not known (a mention, an unknown
   * resource, a link not written `ac:link`): it then matches no body, and a
   * missing one makes every link that could be it retargeted ambiguous.
   */
  readonly body: string;
  /**
   * Where it stands: the enclosing task's id, and the text before and after
   * it. `''` when a link element encloses it outside that link's body: it has
   * no place of its own and takes part in no match.
   */
  readonly place: string;
}

/** An element that is, or could be read as, a link holding a `ri:url`. */
export interface StorageUrlLink extends StorageLinkClaim {
  /** The link-like element. */
  readonly element: StorageElement;
  /** Its position among the link-like elements of the string, in document order. */
  readonly ordinal: number;
  /**
   * Whether it is exactly what write-back builds: `ac:link` holding one
   * `ri:url` and at most one link body, in the Confluence namespaces, with
   * nothing but attributes the href grammar carries, and no mention inside.
   * Nothing else is ever approved, and nothing else is evidence.
   */
  readonly canonical: boolean;
  /** `ri:value` of a canonical link, else null. */
  readonly value: string | null;
  /** What a canonical link without a body of its own shows (its display text), else `''`. */
  readonly label: string;
  /** Canonical with a navigable value: a link anyone may write. */
  readonly navigable: boolean;
  /** Outside every context an HTML consumer keeps as text or inert (`style`, `script`, `template`, …). */
  readonly live: boolean;
}

export interface StorageLinkAnalysis {
  /** The URL links, in document order. */
  readonly links: readonly StorageUrlLink[];
  /** Every link-like element and anchor, in document order; a URL link is the same object as in `links`. */
  readonly claims: readonly StorageLinkClaim[];
  /** The number of link-like elements. */
  readonly linkLike: number;
  /**
   * The text the string shows, white space collapsed: the text outside
   * link-like elements, the text of a link's own bodies, and the display text
   * of a link without one. Taking a link away from what it shows leaves this
   * unchanged, so comparing it before and after proves nothing shown was lost.
   */
  readonly text: string;
}

/**
 * What became of a written URL link. `navigable`, `unchanged` (the stored
 * link, where it was or moved), `pinned` (the stored link among copies of it,
 * told apart by its place) and `edited` (the stored link in its place with
 * another body) are written. `unproven` (no stored link proves it),
 * `ambiguous` (it cannot be told from a copy or from another source) and
 * `retarget` (it stands for a stored link to something else) are not.
 */
export type StorageUrlLinkVerdict = 'navigable' | 'unchanged' | 'pinned' | 'edited' | 'unproven' | 'ambiguous' | 'retarget';

const APPROVED: ReadonlySet<StorageUrlLinkVerdict> = new Set(['navigable', 'unchanged', 'pinned', 'edited']);

/** Whether a link with this verdict is written. */
export function isApprovedUrlLinkVerdict(verdict: StorageUrlLinkVerdict): boolean {
  return APPROVED.has(verdict);
}

/** Contexts an HTML consumer keeps as text or inert: a link inside one is dormant there. */
const DORMANT = new Set([
  'style', 'script', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'plaintext', 'textarea', 'title', 'template',
]);

const BODY_LOCALS = ['link-body', 'plain-text-link-body'];

interface OpenLink {
  element: StorageElement;
  anchor: boolean;
  ordinal: number;
  /** 1 while inside this link's own body (always, for an anchor). */
  inBody: number;
  /** `url`-like elements outside the link's bodies. */
  urls: StorageElement[];
  hasUser: boolean;
  media: string[];
  /** The link's rendered text: its range of the text stream. */
  start: number;
  end: number;
  bodyStart: number;
  bodyEnd: number;
  scope: string;
  live: boolean;
  /** False while a link encloses it outside that link's body. */
  placed: boolean;
  /** Its position among the links and anchors, in document order. */
  sequence: number;
  described: Described | null;
}

/** What a link or an anchor is, known when it ends; its place needs the text after it. */
interface Described {
  target: string;
  body: string;
  canonical: boolean;
  value: string | null;
  label: string;
}

function sortedAttributes(attributes: readonly StorageAttribute[]): Array<[string, string]> {
  return attributes
    .map((attribute): [string, string] => [attribute.name, attribute.value])
    .sort(([a, x], [b, y]) => (a === b ? Number(x > y) - Number(x < y) : Number(a > b) - Number(a < b)));
}

/** The characters a description of these attributes holds. */
function attributeCost(attributes: readonly StorageAttribute[]): number {
  let cost = 0;
  for (const attribute of attributes) cost += attribute.name.length + attribute.value.length + 1;
  return cost;
}

const isOwnLinkBody = (link: StorageElement, child: StorageElement): boolean =>
  child.parent === link && isStorageName(link, 'ac', 'link') && BODY_LOCALS.some((local) => isStorageName(child, 'ac', local));

/**
 * What a URL link shows, when that is known (#1955): the display text of the
 * exact shape without a body, or the content of its own bodies. Null when it
 * is not known, so the link cannot be taken away from what it shows without a
 * possible loss:
 * - the element is not `ac:link` (another prefix, another case);
 * - it holds text or an element outside its own `ac:link-body` /
 *   `ac:plain-text-link-body` children, other than white space and resource
 *   elements (`ri:*`, or anything named `url`) without content of their own;
 * - it has no body with content and is not the exact shape: what Confluence
 *   shows for it (a resource's title, a value) is not something this module
 *   computes.
 */
export function storageLinkShown(link: StorageUrlLink): { label: string } | { bodies: StorageElement[] } | null {
  if (link.canonical && link.label !== '') return { label: link.label };
  const element = link.element;
  if (!isStorageName(element, 'ac', 'link')) return null;
  const bodies: StorageElement[] = [];
  let content = false;
  for (const child of element.children) {
    if (typeof child === 'string') {
      if (child.trim() !== '') return null;
    } else if (isOwnLinkBody(element, child)) {
      bodies.push(child);
      content ||= child.children.some((inner) => typeof inner !== 'string' || inner.trim() !== '');
    } else {
      // A resource and what it holds: resource elements and white space, nothing that could be shown.
      const pending: StorageElement[] = [child];
      while (pending.length > 0) {
        const resource = pending.pop()!;
        if (resource.prefix !== 'ri' && !resemblesStorageName(resource, 'url')) return null;
        for (const inner of resource.children) {
          if (typeof inner !== 'string') pending.push(inner);
          else if (inner.trim() !== '') return null;
        }
      }
    }
  }
  return content ? { bodies } : null;
}

/**
 * The attributes of `element` a link href carries, or null when it holds any
 * other: every one must be `prefix:*` in that prefix's Confluence namespace,
 * with a name and a value the grammar takes, at most 16 besides `primary`.
 */
function carriedAttributes(
  element: StorageElement,
  prefix: ConfluenceStoragePrefix,
  primary: string | null,
): { carried: ConfluenceLinkAttr[]; primary: string | null } | null {
  const carried: ConfluenceLinkAttr[] = [];
  let value: string | null = null;
  for (const attribute of element.attributes) {
    if (!isStorageName(attribute, prefix, attribute.local) || !isConfluenceLinkValue(attribute.value)) return null;
    if (attribute.local === primary) {
      value = attribute.value;
      continue;
    }
    if (!isConfluenceLinkLocalName(attribute.local)) return null;
    carried.push([attribute.name, attribute.value]);
  }
  return carried.length > CONFLUENCE_LINK_LIMITS.attrs ? null : { carried, primary: value };
}

/** The kind each resource element is the target of, by its name as written in lower case. */
const RESOURCE_KIND: ReadonlyMap<string, ConfluenceLinkKind> = new Map(
  Object.entries(CONFLUENCE_LINK_RESOURCE_ELEMENT).map(([kind, element]) => [element, kind as ConfluenceLinkKind]),
);

/** What a link whose shown text is not known stands for in the text of a string: one character, never empty. */
const UNKNOWN_SHOWN = '\uFFFC';

/**
 * Characters an HTML reading of a storage attribute may show where the XML
 * reading has these: U+2329/U+232A (`&lang;`/`&rang;`, which HTML reads as
 * U+27E8/U+27E9) and the C1 controls (a numeric reference HTML maps to a
 * windows-1252 character).
 */
const HTML_READS_OTHERWISE = /[\u2329\u232A\u0080-\u009F]/;

/**
 * What the forward pass shows for an `ac:link` that shows nothing of its own
 * (#1955, review r2 R11), read as `confluence-link.ts` reads one: the display
 * text of its kind's primary value (a page title, a space key, an anchor, a
 * URL). Its first `ri:*` child is the resource; with none it is an anchor.
 * Review r3, R16: in the text an explicit body is compared in, white space
 * collapsed and trimmed, as the editor shows it. Null when that is not known:
 * the element is not written `ac:link`, it holds text or an element that is
 * no resource, its resource is of no kind the forward pass carries (a
 * mention), the value is none the grammar takes, or it holds a character the
 * HTML reading the editor shows may read as another one.
 */
function forwardLabel(element: StorageElement, others: readonly StorageElement[]): string | null {
  if (element.name !== 'ac:link') return null;
  if (element.children.some((child) => typeof child === 'string' && child.trim() !== '')) return null;
  if (others.some((child) => !child.name.toLowerCase().startsWith('ri:'))) return null;
  const resource = others[0];
  const kind = resource ? RESOURCE_KIND.get(resource.name.toLowerCase()) : 'anchor';
  if (!kind) return null;
  const primary = CONFLUENCE_LINK_PRIMARY_ATTR[kind];
  const value = (resource ?? element).attributes.find((attribute) => attribute.name.toLowerCase() === primary)?.value;
  if (value === undefined || !isConfluenceLinkValue(value) || HTML_READS_OTHERWISE.test(value)) return null;
  return confluenceLinkDisplayText({ kind, value }).replace(/\s+/gu, ' ').trim();
}

/**
 * Every link-like element and anchor of `tree`, described for a judgement.
 * One pass over the tree; throws {@link StorageLinkBudgetError} past the work
 * limit, so a caller refuses rather than judges half a string.
 */
export function analyseStorageLinks(tree: StorageTree, limits: StorageLinkLimits = STORAGE_LINK_LIMITS): StorageLinkAnalysis {
  let work = 0;
  const charge = (steps = 1): void => {
    work += steps;
    if (work > limits.work) throw new StorageLinkBudgetError();
  };

  // The text of the string as a reader sees it, white space collapsed to single spaces.
  let stream = '';
  let pendingSpace = false;
  // Open link-like elements that enclose the current position outside their own body: text there is not content.
  let outsideBody = 0;
  /** Open links and anchors whose body encloses the current position. */
  let inBodies = 0;
  let dormant = 0;
  const scopes: string[] = [];
  const open: OpenLink[] = [];
  const closed: OpenLink[] = [];
  let linkLike = 0;

  const appendText = (text: string): void => {
    if (outsideBody > 0) return;
    const collapsed = text.replace(/\s+/gu, ' ');
    if (collapsed === '') return;
    const leading = collapsed.startsWith(' ');
    const trailing = collapsed.length > 1 && collapsed.endsWith(' ');
    const inner = collapsed.slice(Number(leading), collapsed.length - Number(trailing));
    if (inner === '') {
      pendingSpace = true;
      return;
    }
    if ((pendingSpace || leading) && stream !== '') stream += ' ';
    stream += inner;
    pendingSpace = trailing;
  };

  /**
   * A description of `roots` and their element descendants: names and
   * attributes in document order, attribute order aside. No recursion, and
   * every node is charged what its description holds before it is written.
   */
  const structure = (roots: readonly StorageElement[]): string => {
    const parts: string[] = [];
    const pending: Array<StorageElement | null> = [...roots].reverse();
    while (pending.length > 0) {
      const node = pending.pop()!;
      if (node === null) {
        parts.push(']');
        continue;
      }
      charge(1 + node.name.length + node.uri.length + attributeCost(node.attributes) + node.children.length);
      parts.push(JSON.stringify([node.name, node.uri, sortedAttributes(node.attributes)]), '[');
      pending.push(null);
      for (let index = node.children.length - 1; index >= 0; index -= 1) {
        const child = node.children[index]!;
        if (typeof child !== 'string') pending.push(child);
      }
    }
    return parts.join('');
  };

  const isOwnBody = (link: OpenLink, child: StorageElement): boolean => !link.anchor && isOwnLinkBody(link.element, child);

  /** What `link` is, at its end tag, and the text it shows when it has no body of its own. */
  const describe = (link: OpenLink): { described: Described; shown: string } => {
    const element = link.element;
    // The body is a range of the text: charged before it is copied, so nested bodies cannot be copied for free.
    const bodyLength = link.bodyStart < 0 || link.bodyEnd < 0 ? 0 : link.bodyEnd - link.bodyStart;
    charge(bodyLength);
    const bodyText = bodyLength === 0 ? '' : stream.slice(link.bodyStart, link.bodyEnd).trim();
    if (link.anchor) {
      const href = element.attributes.find((attribute) => attribute.name === 'href')!.value;
      const className = element.attributes.find((attribute) => attribute.name === 'class')?.value ?? null;
      charge(href.length + (className?.length ?? 0));
      return {
        described: {
          target: `a|${JSON.stringify([href, className])}`, body: JSON.stringify([bodyText, link.media]),
          canonical: false, value: null, label: '',
        },
        shown: '',
      };
    }
    // The link's own children, told apart in one pass that is charged before it is made (review r2, R13).
    charge(element.children.length + attributeCost(element.attributes));
    const bodies: StorageElement[] = [];
    const others: StorageElement[] = [];
    let url: StorageElement | undefined;
    for (const child of element.children) {
      if (typeof child === 'string') continue;
      if (BODY_LOCALS.some((local) => isStorageName(child, 'ac', local))) {
        bodies.push(child);
        continue;
      }
      others.push(child);
      url ??= isStorageName(child, 'ri', 'url') ? child : undefined;
    }
    if (url) charge(attributeCost(url.attributes));
    const linkAttrs = isStorageName(element, 'ac', 'link') ? carriedAttributes(element, 'ac', null) : null;
    const urlAttrs = url ? carriedAttributes(url, 'ri', 'value') : null;
    const body = bodies[0];
    // A body with no element and no text is no body: the link shows its display text.
    const blank = !body || (bodyText === '' && body.children.every((child) => typeof child === 'string'));
    let canonical = Boolean(
      url && linkAttrs && urlAttrs && urlAttrs.primary !== null
      && link.urls.length === 1 && link.urls[0] === url
      && others.length === 1 && bodies.length <= 1
      && url.children.length === 0
      && element.children.every((child) => typeof child !== 'string' || child.trim() === '')
      && !link.hasUser,
    );
    const value = canonical ? urlAttrs!.primary : null;
    if (canonical) {
      // The carrier must hold every attribute: one the href cap would drop is one the link would lose.
      const dropped: string[] = [];
      buildConfluenceLinkHref({
        kind: 'url', value: value!, link: linkAttrs!.carried, resource: urlAttrs!.carried, container: null,
        body: blank ? null : isStorageName(body, 'ac', 'link-body') ? 'rich' : 'plain',
      }, dropped);
      canonical = dropped.length === 0;
    }
    const display = canonical ? confluenceLinkDisplayText({ kind: 'url', value: value! }) : '';
    let text = canonical && blank ? display : bodyText;
    let shown = canonical && blank ? display : '';
    // Review r2, R11: any other link that shows nothing of its own shows what the forward pass shows for it, and
    // that is competing evidence like an explicit body (never authority: only `canonical` grants). When that is
    // not known, its body is '' (no body matches it) and it stands in the text as one unknown character.
    let known = true;
    const showsOwn = bodyText !== '' || link.media.length > 0
      || bodies.some((own) => own.children.some((child) => typeof child !== 'string'));
    if (!canonical && !showsOwn) {
      const label = forwardLabel(element, others);
      known = label !== null;
      text = label ?? '';
      shown = label ?? UNKNOWN_SHOWN;
    }
    let target: string;
    if (canonical) {
      // Attribute order is not part of what a link points at.
      target = `url|${Number(link.live)}|${JSON.stringify([value, [...linkAttrs!.carried].sort(), [...urlAttrs!.carried].sort()])}`;
    } else {
      const shape = structure(others);
      target = `link|${JSON.stringify([element.name, element.uri, sortedAttributes(element.attributes), shape])}`;
    }
    return {
      described: {
        target,
        body: known ? JSON.stringify([text, link.media]) : '',
        canonical,
        value,
        label: canonical && blank ? display : '',
      },
      shown,
    };
  };

  type Frame = { element: StorageElement; next: number; link: OpenLink | null; body: OpenLink | null; dormant: boolean; scoped: boolean };
  const frames: Frame[] = [{ element: tree.root, next: 0, link: null, body: null, dormant: false, scoped: false }];

  while (frames.length > 0) {
    const frame = frames[frames.length - 1]!;
    if (frame.next < frame.element.children.length) {
      const child = frame.element.children[frame.next]!;
      frame.next += 1;
      charge();
      if (typeof child === 'string') {
        appendText(child);
        continue;
      }
      // Entering `child`.
      const entered: Frame = { element: child, next: 0, link: null, body: null, dormant: false, scoped: false };
      const enclosing = open[open.length - 1];
      if (enclosing && isOwnBody(enclosing, child)) {
        enclosing.inBody = 1;
        inBodies += 1;
        outsideBody -= 1;
        if (enclosing.bodyStart < 0) enclosing.bodyStart = stream.length;
        entered.body = enclosing;
      }
      if (resemblesStorageName(child, 'url')) {
        for (const link of open) {
          charge();
          if (!link.anchor && link.inBody === 0) link.urls.push(child);
        }
      }
      if (resemblesStorageName(child, 'user')) {
        for (const link of open) {
          charge();
          link.hasUser = true;
        }
      }
      // An image is described only for a body that holds it, and each body that keeps the description pays for it.
      if (inBodies > 0 && (resemblesStorageName(child, 'image') || child.name === 'img')) {
        let signature: string;
        if (child.name === 'img') {
          const src = child.attributes.find((attribute) => attribute.name === 'src')?.value ?? null;
          charge(src?.length ?? 0);
          signature = JSON.stringify(['img', src]);
        } else {
          // What the image shows, not how: its own display attributes (`ac:width`, …) are not its identity.
          signature = structure(child.children.filter((inner): inner is StorageElement => typeof inner !== 'string'));
        }
        for (const link of open) {
          if (link.inBody === 0) continue;
          charge(1 + signature.length);
          link.media.push(signature);
        }
      }
      if (DORMANT.has(child.local.toLowerCase())) {
        dormant += 1;
        entered.dormant = true;
      }
      if (isStorageName(child, 'ac', 'task')) {
        const id = child.children.find((node): node is StorageElement => typeof node !== 'string' && isStorageName(node, 'ac', 'task-id'));
        scopes.push(`task:${id ? id.children.filter((node) => typeof node === 'string').join('').trim().slice(0, 64) : ''}`);
        entered.scoped = true;
      }
      const isLink = resemblesStorageName(child, 'link');
      const isAnchor = !isLink && child.name === 'a' && child.attributes.some((attribute) => attribute.name === 'href');
      if (isLink || isAnchor) {
        const link: OpenLink = {
          element: child, anchor: isAnchor, ordinal: isLink ? linkLike : -1, inBody: Number(isAnchor), urls: [], hasUser: false,
          media: [], start: stream.length, end: -1, bodyStart: isAnchor ? stream.length : -1, bodyEnd: -1,
          scope: scopes[scopes.length - 1] ?? '', live: dormant === 0, placed: outsideBody === 0,
          sequence: open.length + closed.length, described: null,
        };
        if (isLink) {
          linkLike += 1;
          outsideBody += 1;
        } else {
          inBodies += 1;
        }
        open.push(link);
        entered.link = link;
      }
      frames.push(entered);
      continue;
    }
    // Leaving `frame.element`.
    frames.pop();
    if (frame.body) {
      frame.body.inBody = 0;
      inBodies -= 1;
      outsideBody += 1;
      frame.body.bodyEnd = stream.length;
    }
    if (frame.dormant) dormant -= 1;
    if (frame.scoped) scopes.pop();
    if (frame.link) {
      const link = open.pop()!;
      if (!link.anchor) {
        outsideBody -= 1;
      } else {
        inBodies -= 1;
        link.bodyEnd = stream.length;
      }
      const { described, shown } = describe(link);
      link.described = described;
      // A link without a body shows its display text: that is its rendered text, here and once it is unwrapped.
      if (shown !== '') appendText(shown);
      link.end = stream.length;
      closed.push(link);
    }
  }

  // The text stream is complete now, so every place can be read.
  const links: StorageUrlLink[] = [];
  const claims: StorageLinkClaim[] = [];
  closed.sort((a, b) => a.sequence - b.sequence);
  for (const link of closed) {
    charge();
    const before = stream.slice(Math.max(0, link.start - PLACE_WINDOW * 2 - 2), link.start).replaceAll(' ', '').slice(-PLACE_WINDOW);
    const after = stream.slice(link.end, link.end + PLACE_WINDOW * 2 + 2).replaceAll(' ', '').slice(0, PLACE_WINDOW);
    const { target, body, canonical, value, label } = link.described!;
    const claim: StorageLinkClaim = { target, body, place: link.placed ? JSON.stringify([link.scope, before, after]) : '' };
    if (link.anchor || link.urls.length === 0) {
      claims.push(claim);
      continue;
    }
    const found: StorageUrlLink = {
      ...claim,
      element: link.element,
      ordinal: link.ordinal,
      canonical,
      value,
      label,
      navigable: canonical && isNavigableConfluenceUrl(value!),
      live: link.live,
    };
    claims.push(found);
    links.push(found);
  }
  return { links, claims, linkLike, text: stream };
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function count<K>(map: Map<K, number>, key: K): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/**
 * One verdict per written URL link, against the stored links (#1955, D2).
 * Every approval is the match of one written link with one distinct stored
 * link to the same target, so no target is ever written more often than it is
 * stored, and none that is not stored is written at all.
 *
 * A written link stands for a stored one only on continuity that nothing
 * contradicts. Everything in either string that points somewhere takes part:
 * every link-like element and every HTML anchor, whatever its body. (body_html
 * cannot tell the carrier of a link from a stored `<a>` with the same href, so
 * a stored anchor is a possible source of any written link with its body.)
 *
 * 0. A link that stands exactly where one stored thing pointing elsewhere
 *    stood is that thing retargeted: `retarget`.
 * 1. Same target and same body. A link in a place that holds one thing in
 *    each string, the stored one being a link of its target and body, is that
 *    link (`unchanged`; `pinned` when more such links are written than
 *    stored). Any other link has moved: with more written than stored it is a
 *    copy (`ambiguous`); else it is `unchanged`, unless a stored thing with
 *    this very body and another target is missing from what is written: then
 *    it cannot be told from that one retargeted (`ambiguous`).
 * 2. Same target and same place, another body: the one stored link there with
 *    the one written link there is that link relabelled (`edited`), unless
 *    the new body is that of any stored thing with another target
 *    (`retarget`). A link both moved and relabelled is not told from a
 *    deletion and a new link: `unproven`.
 *
 * Nothing depends on document order, and the cost grows with the number of
 * links and anchors, not with their square. Throws
 * {@link StorageLinkBudgetError} past the work limit.
 */
export function judgeStorageUrlLinks(
  written: StorageLinkAnalysis,
  stored: StorageLinkAnalysis | null,
  limits: StorageLinkLimits = STORAGE_LINK_LIMITS,
): StorageUrlLinkVerdict[] {
  let work = 0;
  const charge = (steps = 1): void => {
    work += steps;
    if (work > limits.work) throw new StorageLinkBudgetError();
  };
  const verdicts: Array<StorageUrlLinkVerdict | null> = written.links.map((link) => (link.navigable ? 'navigable' : null));
  const candidates: number[] = [];
  written.links.forEach((link, index) => {
    if (verdicts[index] !== null) return;
    // Only the exact shape write-back builds, in a place of its own, can stand for a stored link.
    if (!link.canonical || link.place === '') verdicts[index] = 'unproven';
    else candidates.push(index);
  });
  const finish = (): StorageUrlLinkVerdict[] => verdicts.map((verdict) => verdict ?? 'unproven');
  if (candidates.length === 0 || stored === null) return finish();

  // Targets, bodies and places are compared as numbers: each string is hashed once, however long it is.
  const numbers = new Map<string, number>();
  const numberOf = (kind: 't' | 'b' | 'p', value: string): number => {
    const key = kind + value;
    let number = numbers.get(key);
    if (number === undefined) {
      number = numbers.size;
      numbers.set(key, number);
    }
    return number;
  };
  const targetOf = (claim: StorageLinkClaim): number => numberOf('t', claim.target);
  const bodyOf = (claim: StorageLinkClaim): number => numberOf('b', claim.body);
  const placeOf = (claim: StorageLinkClaim): number => numberOf('p', claim.place);
  const classOf = (claim: StorageLinkClaim): string => `${targetOf(claim)}:${bodyOf(claim)}`;

  // Indexes over everything that points somewhere, in both readings.
  const storedAtPlace = new Map<number, StorageLinkClaim[]>();
  /** body → target → how many stored things with that body point there. */
  const storedByBody = new Map<number, Map<number, number>>();
  for (const claim of stored.claims) {
    charge();
    if (claim.place !== '') pushTo(storedAtPlace, placeOf(claim), claim);
    const body = bodyOf(claim);
    let targets = storedByBody.get(body);
    if (!targets) storedByBody.set(body, targets = new Map());
    count(targets, targetOf(claim));
  }
  const writtenAtPlace = new Map<number, number>();
  const writtenByClass = new Map<string, number>();
  for (const claim of written.claims) {
    charge();
    if (claim.place !== '') count(writtenAtPlace, placeOf(claim));
    count(writtenByClass, classOf(claim));
  }
  /** The one stored thing that stood exactly where `link` stands, when the place names one thing on both sides. */
  const placeOwner = (link: StorageUrlLink): StorageLinkClaim | undefined => {
    const place = placeOf(link);
    const owners = storedAtPlace.get(place);
    return owners?.length === 1 && writtenAtPlace.get(place) === 1 ? owners[0] : undefined;
  };
  /** body → the stored targets with that body that are written less often than they are stored; made once a body. */
  const missingByBody = new Map<number, Set<number>>();
  const missingSources = (body: number): Set<number> => {
    let missing = missingByBody.get(body);
    if (missing) return missing;
    missing = new Set();
    for (const [target, storedCount] of storedByBody.get(body) ?? []) {
      charge();
      if ((writtenByClass.get(`${target}:${body}`) ?? 0) < storedCount) missing.add(target);
    }
    missingByBody.set(body, missing);
    return missing;
  };
  // Review r2, R11: a stored thing whose shown text is not known (body '') may show any text. One that is still
  // written is no rival; one missing from what is written could be any written link retargeted.
  const unknownMissing = (): boolean => missingSources(numberOf('b', '')).size > 0;
  /** Whether a stored thing with `link`'s body and another target, or one that may show it, is missing from what is written. */
  const otherSourceMissing = (link: StorageUrlLink): boolean => {
    const missing = missingSources(bodyOf(link));
    return missing.size > Number(missing.has(targetOf(link))) || unknownMissing();
  };
  /** Whether any stored thing with `link`'s body points somewhere else, or one that may show it is missing. */
  const foreignBody = (link: StorageUrlLink): boolean => {
    const targets = storedByBody.get(bodyOf(link));
    return (targets !== undefined && targets.size > Number(targets.has(targetOf(link)))) || unknownMissing();
  };

  // 0. A link in the place of something that pointed elsewhere.
  const remaining: number[] = [];
  for (const index of candidates) {
    charge();
    const link = written.links[index]!;
    const owner = placeOwner(link);
    if (owner && owner.target !== link.target) verdicts[index] = 'retarget';
    else remaining.push(index);
  }

  // 1. Same target, same body.
  const evidence = new Set<StorageLinkClaim>();
  const storedLinksByClass = new Map<string, StorageUrlLink[]>();
  for (const link of stored.links) {
    charge();
    if (!link.canonical || link.navigable || link.place === '') continue;
    evidence.add(link);
    pushTo(storedLinksByClass, classOf(link), link);
  }
  const candidatesByClass = new Map<string, number[]>();
  for (const index of remaining) pushTo(candidatesByClass, classOf(written.links[index]!), index);
  /** Stored links no written link of their own class has taken, for step 2. */
  const available = new Map<string, number>();
  const unmatched: number[] = [];
  for (const [key, indexes] of candidatesByClass) {
    const storedClass = storedLinksByClass.get(key);
    if (!storedClass) {
      unmatched.push(...indexes);
      continue;
    }
    const copies = indexes.length > storedClass.length;
    const taken = new Set<StorageLinkClaim>();
    let moved = 0;
    for (const index of indexes) {
      charge();
      const link = written.links[index]!;
      // Step 0 left only owners with this target; one that is a stored link with this body is this link.
      const owner = placeOwner(link);
      if (owner && evidence.has(owner) && owner.body === link.body) {
        taken.add(owner);
        verdicts[index] = copies ? 'pinned' : 'unchanged';
        continue;
      }
      moved += 1;
      verdicts[index] = copies || otherSourceMissing(link) ? 'ambiguous' : 'unchanged';
    }
    // Which stored link a moved one was is not known, so with any moved link none of the class is left for step 2.
    if (moved === 0 || copies) {
      for (const link of storedClass) {
        charge();
        if (!taken.has(link)) count(available, `${targetOf(link)}:${placeOf(link)}`);
      }
    }
  }
  for (const [key, storedClass] of storedLinksByClass) {
    if (candidatesByClass.has(key)) continue;
    for (const link of storedClass) {
      charge();
      count(available, `${targetOf(link)}:${placeOf(link)}`);
    }
  }

  // 2. Same target, same place, another body.
  const unmatchedAt = new Map<string, number>();
  for (const index of unmatched) {
    const link = written.links[index]!;
    count(unmatchedAt, `${targetOf(link)}:${placeOf(link)}`);
  }
  for (const index of unmatched) {
    charge();
    const link = written.links[index]!;
    if (foreignBody(link)) {
      verdicts[index] = 'retarget';
      continue;
    }
    const at = `${targetOf(link)}:${placeOf(link)}`;
    const inPlace = available.get(at) === 1 && unmatchedAt.get(at) === 1 && placeOwner(link)?.target === link.target;
    verdicts[index] = inPlace ? 'edited' : 'unproven';
  }
  return finish();
}
