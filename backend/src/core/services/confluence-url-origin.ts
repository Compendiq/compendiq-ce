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
  buildConfluenceLinkHref,
  confluenceLinkDisplayText,
  isConfluenceLinkLocalName,
  isConfluenceLinkValue,
  isNavigableConfluenceUrl,
  type ConfluenceLinkAttr,
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
  /** The most steps an analysis or a judgement takes. */
  readonly work: number;
  /** The longest body text that takes part in a match, in UTF-16 code units. */
  readonly bodyText: number;
  /** The most images of a body that take part in a match. */
  readonly bodyMedia: number;
  /** The longest description of one image or one foreign target. */
  readonly signature: number;
}

/**
 * A real page is far below every one of these. Past `work` the analysis stops
 * and the write is refused; a body past `bodyText` or `bodyMedia` and a
 * description past `signature` take no part in any match.
 */
export const STORAGE_LINK_LIMITS: StorageLinkLimits = {
  work: STORAGE_READER_LIMITS.nodes * 8,
  bodyText: 4_096,
  bodyMedia: 32,
  signature: 4_096,
};

/** The text taken on each side of a link as its place, in characters that are not white space. */
const PLACE_WINDOW = 64;

/** The analysis or the judgement would take more than {@link StorageLinkLimits.work} steps. */
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
  /** Its body: `[text, images]` as JSON, or null when the body is over a limit. */
  readonly body: string | null;
  /** Whether the body says more than the target itself (text of its own, or an image). */
  readonly distinctive: boolean;
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
  /** Every link-like element and anchor, the URL links included. */
  readonly claims: readonly StorageLinkClaim[];
  /** The number of link-like elements. */
  readonly linkLike: number;
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
  mediaOverflow: boolean;
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
  body: string | null;
  distinctive: boolean;
  canonical: boolean;
  value: string | null;
  label: string;
}

function sortedAttributes(attributes: readonly StorageAttribute[]): Array<[string, string]> {
  return attributes
    .map((attribute): [string, string] => [attribute.name, attribute.value])
    .sort(([a, x], [b, y]) => (a === b ? Number(x > y) - Number(x < y) : Number(a > b) - Number(a < b)));
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

  /** A description of `element`'s element descendants: names and attributes, attribute order aside. */
  const structure = (element: StorageElement): string | null => {
    const describe = (node: StorageElement): unknown => {
      charge(1 + node.attributes.length);
      const children = node.children.filter((child): child is StorageElement => typeof child !== 'string');
      return [node.name, node.uri, sortedAttributes(node.attributes), children.map(describe)];
    };
    const children = element.children.filter((child): child is StorageElement => typeof child !== 'string');
    const signature = JSON.stringify(children.map(describe));
    return signature.length > limits.signature ? null : signature;
  };

  const isOwnBody = (link: OpenLink, child: StorageElement): boolean =>
    !link.anchor
    && child.parent === link.element
    && isStorageName(link.element, 'ac', 'link')
    && BODY_LOCALS.some((local) => isStorageName(child, 'ac', local));

  /** What `link` is, at its end tag, and the text it shows when it has no body of its own. */
  const describe = (link: OpenLink): { described: Described; shown: string } => {
    const element = link.element;
    const bodyText = link.bodyStart < 0 ? '' : stream.slice(link.bodyStart, link.bodyEnd < 0 ? link.bodyStart : link.bodyEnd).trim();
    const overLimit = link.mediaOverflow || bodyText.length > limits.bodyText;
    if (link.anchor) {
      const target = `a|${JSON.stringify([
        element.attributes.find((attribute) => attribute.name === 'href')!.value,
        element.attributes.find((attribute) => attribute.name === 'class')?.value ?? null,
      ])}`;
      return {
        described: {
          target, body: overLimit ? null : JSON.stringify([bodyText, link.media]),
          distinctive: bodyText !== '' || link.media.length > 0, canonical: false, value: null, label: '',
        },
        shown: '',
      };
    }
    const children = element.children.filter((child): child is StorageElement => typeof child !== 'string');
    const bodies = children.filter((child) => BODY_LOCALS.some((local) => isStorageName(child, 'ac', local)));
    const url = children.find((child) => isStorageName(child, 'ri', 'url'));
    const linkAttrs = isStorageName(element, 'ac', 'link') ? carriedAttributes(element, 'ac', null) : null;
    const urlAttrs = url ? carriedAttributes(url, 'ri', 'value') : null;
    const body = bodies[0];
    // A body with no element and no text is no body: the link shows its display text.
    const blank = !body || (bodyText === '' && body.children.every((child) => typeof child === 'string'));
    let canonical = Boolean(
      url && linkAttrs && urlAttrs && urlAttrs.primary !== null
      && link.urls.length === 1 && link.urls[0] === url
      && children.length === 1 + bodies.length && bodies.length <= 1
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
    const text = canonical && blank ? display : bodyText;
    let target: string;
    if (canonical) {
      // Attribute order is not part of what a link points at.
      target = `url|${Number(link.live)}|${JSON.stringify([value, [...linkAttrs!.carried].sort(), [...urlAttrs!.carried].sort()])}`;
    } else {
      const shape = structure({ ...element, children: children.filter((child) => !bodies.includes(child)) });
      target = shape === null
        ? `link|${link.sequence}|unbounded`
        : `link|${JSON.stringify([element.name, element.uri, sortedAttributes(element.attributes), shape])}`;
    }
    return {
      described: {
        target,
        body: overLimit ? null : JSON.stringify([text, link.media]),
        distinctive: link.media.length > 0 || (text !== '' && text !== display),
        canonical,
        value,
        label: canonical && blank ? display : '',
      },
      shown: canonical && blank ? display : '',
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
      if (resemblesStorageName(child, 'image') || child.name === 'img') {
        const signature = child.name === 'img'
          ? JSON.stringify(['img', child.attributes.find((attribute) => attribute.name === 'src')?.value ?? null])
          : structure(child);
        for (const link of open) {
          charge();
          if (link.inBody === 0) continue;
          if (signature === null || link.media.length >= limits.bodyMedia) link.mediaOverflow = true;
          else link.media.push(signature);
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
          media: [], mediaOverflow: false, start: stream.length, end: -1, bodyStart: isAnchor ? stream.length : -1, bodyEnd: -1,
          scope: scopes[scopes.length - 1] ?? '', live: dormant === 0, placed: outsideBody === 0,
          sequence: open.length + closed.length, described: null,
        };
        if (isLink) {
          linkLike += 1;
          outsideBody += 1;
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
      outsideBody += 1;
      frame.body.bodyEnd = stream.length;
    }
    if (frame.dormant) dormant -= 1;
    if (frame.scoped) scopes.pop();
    if (frame.link) {
      const link = open.pop()!;
      if (!link.anchor) outsideBody -= 1;
      else link.bodyEnd = stream.length;
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
    const { target, body, distinctive, canonical, value, label } = link.described!;
    const claim: StorageLinkClaim = {
      target, body, distinctive, place: link.placed ? JSON.stringify([link.scope, before, after]) : '',
    };
    claims.push(claim);
    if (link.anchor || link.urls.length === 0) continue;
    links.push({
      ...claim,
      element: link.element,
      ordinal: link.ordinal,
      canonical,
      value,
      label,
      navigable: canonical && isNavigableConfluenceUrl(value!),
      live: link.live,
    });
  }
  return { links, claims, linkLike };
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
 * contradicts:
 *
 * 0. A link that stands exactly where one stored thing pointing elsewhere
 *    stood (another link of any kind, an HTML anchor) is that thing
 *    retargeted: `retarget`.
 * 1. Same target and same body. A link in the place of a stored one, the only
 *    such pair there, is that link. With no more written links than stored
 *    ones the rest have only moved (`unchanged`), unless the body is also that
 *    of a stored link to another target that is now missing: then the moved
 *    link cannot be told from that one retargeted (`ambiguous`). With more
 *    written than stored the class holds copies: the links still in a stored
 *    place are kept (`pinned`), every other one is `ambiguous`.
 * 2. Same target and same place, another body: the one stored link there with
 *    the one written link there is that link relabelled (`edited`), unless
 *    the new body is that of a stored link to another target (`retarget`).
 *    A link both moved and relabelled is not told from a deletion and a new
 *    link: `unproven`.
 *
 * Nothing depends on document order. Throws {@link StorageLinkBudgetError}
 * past the work limit.
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
    // Only the exact shape write-back builds, with a body within the limits, can stand for a stored link.
    if (!link.canonical || link.body === null || link.place === '') verdicts[index] = 'unproven';
    else candidates.push(index);
  });
  const finish = (): StorageUrlLinkVerdict[] => verdicts.map((verdict) => verdict ?? 'unproven');
  if (candidates.length === 0 || stored === null) return finish();

  // Indexes over both readings.
  const evidence = stored.links.filter((link) => link.canonical && !link.navigable && link.body !== null && link.place !== '');
  const storedAtPlace = new Map<string, StorageLinkClaim[]>();
  const storedWithBody = new Map<string, Set<string>>();
  const storedTargetBody = new Map<string, number>();
  for (const claim of stored.claims) {
    charge();
    if (claim.place !== '') pushTo(storedAtPlace, claim.place, claim);
    if (claim.body === null || !claim.distinctive) continue;
    const targets = storedWithBody.get(claim.body);
    if (targets) targets.add(claim.target);
    else storedWithBody.set(claim.body, new Set([claim.target]));
    count(storedTargetBody, `${claim.target}\u0000${claim.body}`);
  }
  const writtenAtPlace = new Map<string, number>();
  const writtenTargetBody = new Map<string, number>();
  for (const claim of written.claims) {
    charge();
    if (claim.place !== '') count(writtenAtPlace, claim.place);
    if (claim.body !== null && claim.distinctive) count(writtenTargetBody, `${claim.target}\u0000${claim.body}`);
  }
  /** The one stored thing that stood exactly where `link` stands, when the place names one thing on both sides. */
  const placeOwner = (link: StorageUrlLink): StorageLinkClaim | undefined => {
    const owners = storedAtPlace.get(link.place);
    return owners?.length === 1 && writtenAtPlace.get(link.place) === 1 ? owners[0] : undefined;
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
  const classOf = (link: StorageUrlLink): string => `${link.target}\u0000${link.body}`;
  const storedByClass = new Map<string, StorageUrlLink[]>();
  for (const link of evidence) pushTo(storedByClass, classOf(link), link);
  const writtenByClass = new Map<string, number[]>();
  for (const index of remaining) pushTo(writtenByClass, classOf(written.links[index]!), index);
  /** Stored links no written link of their own class has taken, for step 2. */
  const available = new Map<string, StorageUrlLink[]>();
  const taken = new Set<StorageUrlLink>();
  const unmatched: number[] = [];
  for (const [key, indexes] of writtenByClass) {
    const storedClass = storedByClass.get(key);
    if (!storedClass) {
      unmatched.push(...indexes);
      continue;
    }
    // A written link and a stored one in the same place, the only two of the class there, are one link.
    const places = new Map<string, { stored: StorageUrlLink[]; written: number[] }>();
    for (const link of storedClass) {
      charge();
      const at = places.get(link.place);
      if (at) at.stored.push(link);
      else places.set(link.place, { stored: [link], written: [] });
    }
    for (const index of indexes) {
      charge();
      places.get(written.links[index]!.place)?.written.push(index);
    }
    const copies = indexes.length > storedClass.length;
    const inPlace = new Set<number>();
    for (const at of places.values()) {
      if (at.stored.length !== 1 || at.written.length !== 1) continue;
      inPlace.add(at.written[0]!);
      taken.add(at.stored[0]!);
      verdicts[at.written[0]!] = copies ? 'pinned' : 'unchanged';
    }
    let moved = 0;
    for (const index of indexes) {
      if (inPlace.has(index)) continue;
      moved += 1;
      const link = written.links[index]!;
      if (copies) {
        verdicts[index] = 'ambiguous';
        continue;
      }
      // Moved, body unchanged: not when a stored link to another target with this very body went missing.
      let otherSource = false;
      if (link.distinctive) {
        for (const target of storedWithBody.get(link.body!) ?? []) {
          charge();
          if (target === link.target) continue;
          const pair = `${target}\u0000${link.body}`;
          if ((writtenTargetBody.get(pair) ?? 0) < (storedTargetBody.get(pair) ?? 0)) otherSource = true;
        }
      }
      verdicts[index] = otherSource ? 'ambiguous' : 'unchanged';
    }
    // Which stored link a moved one was is not known, so with any moved link none of the class is left for step 2.
    if (moved === 0 || copies) {
      for (const link of storedClass) {
        if (!taken.has(link)) pushTo(available, `${link.target}\u0000${link.place}`, link);
      }
    }
  }
  for (const [key, storedClass] of storedByClass) {
    if (writtenByClass.has(key)) continue;
    for (const link of storedClass) {
      charge();
      pushTo(available, `${link.target}\u0000${link.place}`, link);
    }
  }

  // 2. Same target, same place, another body.
  const unmatchedAt = new Map<string, number>();
  for (const index of unmatched) {
    const link = written.links[index]!;
    count(unmatchedAt, `${link.target}\u0000${link.place}`);
  }
  for (const index of unmatched) {
    charge();
    const link = written.links[index]!;
    let foreignBody = false;
    if (link.distinctive) {
      for (const target of storedWithBody.get(link.body!) ?? []) {
        charge();
        if (target !== link.target) foreignBody = true;
      }
    }
    if (foreignBody) {
      verdicts[index] = 'retarget';
      continue;
    }
    const at = `${link.target}\u0000${link.place}`;
    const inPlace = available.get(at)?.length === 1 && unmatchedAt.get(at) === 1 && placeOwner(link)?.target === link.target;
    verdicts[index] = inPlace ? 'edited' : 'unproven';
  }
  return finish();
}
