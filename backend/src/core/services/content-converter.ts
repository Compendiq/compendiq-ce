import { JSDOM } from 'jsdom';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { marked } from 'marked';
import he from 'he';
import {
  getAttachmentImageSource,
  getLocalFilenameForImageSource,
} from './image-references.js';
import { logger } from '../utils/logger.js';

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
// elements like ac:structured-macro, ac:rich-text-body, ac:link, etc.
//
// `ac:parameter` is the one entry that CAN legitimately hold children (the
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
const SELF_CLOSING_XHTML_TAGS = [
  'ri:user',
  'ri:page',
  'ri:attachment',
  'ri:url',
  'ac:emoticon',
  'ac:parameter',
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

/**
 * Transfer innerHTML from a source element to a target element.
 * Server-side JSDOM only — used for Confluence macro conversion.
 */
// nosemgrep: javascript.browser.security.insecure-document-method.insecure-document-method
function transferInnerHtml(target: Element, source: Element | undefined | null, fallback = ''): void {
  target.innerHTML = source?.innerHTML ?? fallback;
}

/**
 * Converts Confluence storage format (XHTML) to clean HTML for TipTap editor.
 * Handles common Confluence macros: code blocks, task lists, panels, links, images, draw.io.
 */
export function confluenceToHtml(storageXhtml: string, pageId?: string, spaceKey?: string): string {
  const preprocessed = expandSelfClosingXhtmlTags(stripCdata(storageXhtml));
  const dom = new JSDOM(`<body>${preprocessed}</body>`, { contentType: 'text/html' });
  const doc = dom.window.document;

  // Process code blocks: ac:structured-macro[name=code] -> <pre><code>
  for (const macro of byTag(doc, 'ac:structured-macro')) {
    if (getMacroName(macro) !== 'code') continue;
    const language = getParamValue(macro, 'language') ?? '';
    const bodyEl = byTag(macro, 'ac:plain-text-body')[0];
    const code = bodyEl?.textContent ?? '';

    const pre = doc.createElement('pre');
    const codeEl = doc.createElement('code');
    if (language) codeEl.className = `language-${language}`;
    codeEl.textContent = code;
    pre.appendChild(codeEl);
    macro.replaceWith(pre);
  }

  // Process task lists: ac:task-list -> <ul data-type="taskList">
  for (const taskList of byTag(doc, 'ac:task-list')) {
    const ul = doc.createElement('ul');
    ul.setAttribute('data-type', 'taskList');

    for (const task of byTag(taskList, 'ac:task')) {
      const statusEl = byTag(task, 'ac:task-status')[0];
      const bodyEl = byTag(task, 'ac:task-body')[0];
      const checked = statusEl?.textContent === 'complete';

      const li = doc.createElement('li');
      li.setAttribute('data-type', 'taskItem');
      li.setAttribute('data-checked', checked ? 'true' : 'false');
      transferInnerHtml(li, bodyEl);
      ul.appendChild(li);
    }

    taskList.replaceWith(ul);
  }

  // Process panels: ac:structured-macro[name=info|warning|note|tip] -> <div class="panel-*">
  const panelTypes = new Set(['info', 'warning', 'note', 'tip']);
  for (const macro of byTag(doc, 'ac:structured-macro')) {
    const name = getMacroName(macro);
    if (!panelTypes.has(name)) continue;
    const bodyEl = byTag(macro, 'ac:rich-text-body')[0];
    const div = doc.createElement('div');
    div.className = `panel-${name}`;
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

    const pageRef = byTag(link, 'ri:page')[0];
    const attachRef = byTag(link, 'ri:attachment')[0];
    const bodyEl = byTag(link, 'ac:link-body')[0] ?? byTag(link, 'ac:plain-text-link-body')[0];

    const a = doc.createElement('a');
    if (pageRef) {
      const pageTitle = pageRef.getAttribute('ri:content-title') ?? '';
      a.href = `#confluence-page:${pageTitle}`;
      if (bodyEl && bodyEl.tagName.toLowerCase() === 'ac:link-body') {
        transferInnerHtml(a, bodyEl);
      } else {
        a.textContent = bodyEl?.textContent ?? pageTitle;
      }
      a.setAttribute('data-confluence-link', 'page');
    } else if (attachRef) {
      const filename = attachRef.getAttribute('ri:filename') ?? '';
      a.href = `#confluence-attachment:${filename}`;
      if (bodyEl && bodyEl.tagName.toLowerCase() === 'ac:link-body') {
        transferInnerHtml(a, bodyEl);
      } else {
        a.textContent = bodyEl?.textContent ?? filename;
      }
      a.setAttribute('data-confluence-link', 'attachment');
    } else {
      if (bodyEl && bodyEl.tagName.toLowerCase() === 'ac:link-body') {
        transferInnerHtml(a, bodyEl);
      } else {
        a.textContent = bodyEl?.textContent ?? '';
      }
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

    const img = doc.createElement('img');
    if (pageId) {
      img.src = `/api/attachments/${pageId}/${encodeURIComponent(diagramName)}.png`;
    } else {
      img.src = `#drawio:${diagramName}`;
    }
    img.alt = `Draw.io diagram: ${diagramName}`;
    div.appendChild(img);

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
    const colour = (getParamValue(macro, 'colour') ?? 'Grey').toLowerCase();
    const title = getParamValue(macro, 'title') ?? '';
    const span = doc.createElement('span');
    span.className = 'confluence-status';
    span.setAttribute('data-color', colour);
    span.textContent = title;
    macro.replaceWith(span);
  }

  // Process table of contents macro -> placeholder, preserving key params
  // (#300). Common TOC params — `maxLevel`, `minLevel`, `outline`, `style`,
  // `type` — are round-tripped as data attributes so htmlToConfluence can
  // rebuild the macro losslessly.
  const tocParamNames = ['maxLevel', 'minLevel', 'outline', 'style', 'type', 'printable', 'absoluteUrl'];
  for (const macro of byTag(doc, 'ac:structured-macro')) {
    if (getMacroName(macro) !== 'toc') continue;
    const div = doc.createElement('div');
    div.className = 'confluence-toc';
    div.textContent = '[Table of Contents]';
    for (const paramName of tocParamNames) {
      const val = getParamValue(macro, paramName);
      if (val !== null && val !== undefined) div.setAttribute(`data-${paramName.toLowerCase()}`, val);
    }
    macro.replaceWith(div);
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
  const childrenParamNames = ['sort', 'reverse', 'depth', 'first', 'page', 'style', 'excerptType'];
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

  // Clean remaining Confluence-specific elements (emoticons strip unchanged)
  for (const el of byTag(doc, 'ac:emoticon')) {
    el.remove();
  }

  return doc.body.innerHTML;
}

/**
 * Converts clean HTML back to Confluence storage format.
 * Reverses the conversions done by confluenceToHtml.
 */
export function htmlToConfluence(html: string): string {
  const dom = new JSDOM(`<body>${html}</body>`, { contentType: 'text/html' });
  const doc = dom.window.document;

  // Strip auto-generated index blocks before export to Confluence (#13)
  for (const div of doc.querySelectorAll('div.figure-index, div.table-index')) {
    div.remove();
  }

  // Convert code blocks back
  for (const pre of doc.querySelectorAll('pre')) {
    const codeEl = pre.querySelector('code');
    if (!codeEl) continue;

    const language = (codeEl.className.match(/language-(\w+)/) ?? [])[1] ?? '';
    const code = codeEl.textContent ?? '';

    const macro = doc.createElement('ac:structured-macro');
    macro.setAttribute('ac:name', 'code');

    if (language) {
      const param = doc.createElement('ac:parameter');
      param.setAttribute('ac:name', 'language');
      param.textContent = language;
      macro.appendChild(param);
    }

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
  for (const ul of [...doc.querySelectorAll('ul[data-type="taskList"]')].reverse()) {
    const taskList = doc.createElement('ac:task-list');

    for (const li of ul.querySelectorAll('li[data-type="taskItem"]')) {
      const task = doc.createElement('ac:task');
      const taskId = doc.createElement('ac:task-id');
      taskId.textContent = String(Math.floor(Math.random() * 1000000));
      const taskStatus = doc.createElement('ac:task-status');
      taskStatus.textContent = li.getAttribute('data-checked') === 'true' ? 'complete' : 'incomplete';
      const taskBody = doc.createElement('ac:task-body');
      transferInnerHtml(taskBody, li);

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
      macro.setAttribute('ac:name', panelType);
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
  const childrenRoundTripParams = ['sort', 'reverse', 'depth', 'first', 'page', 'style', 'excerptType'];
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

    // Rebuild parameters persisted generically on the forward pass.
    const rawParams = div.getAttribute('data-macro-params');
    if (rawParams) {
      try {
        const params = JSON.parse(rawParams) as Record<string, unknown>;
        for (const [paramName, paramValue] of Object.entries(params)) {
          if (typeof paramValue !== 'string') continue;
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
    for (const [dataAttr, paramName] of Object.entries(tocReverseParams)) {
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

  // Convert status badges back to ac:structured-macro[name=status]
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

  let result = doc.body.innerHTML;

  // Post-process: self-close void elements for XHTML compatibility.
  // JSDOM innerHTML uses HTML serialization (<br>, <img ...>) but Confluence
  // storage format requires valid XHTML (<br />, <img ... />).
  result = result.replace(
    /<(area|base|br|col|embed|hr|img|input|link|meta|source|track|wbr)(\s[^>]*)?\s*>/gi,
    '<$1$2 />',
  );

  // Post-process: wrap ac:plain-text-body content in CDATA sections.
  // Confluence requires CDATA inside <ac:plain-text-body> for code macros.
  result = result.replace(
    /<ac:plain-text-body>([\s\S]*?)<\/ac:plain-text-body>/g,
    (_, content: string) => {
      // Unescape HTML entities back to raw text for CDATA
      const raw = he.decode(content);
      // #900: a literal ']]>' inside the content would prematurely close the
      // CDATA section, producing invalid XHTML. Split it across two adjacent
      // CDATA sections (the standard escape) so the terminator survives intact.
      const safe = raw.replace(/\]\]>/g, ']]]]><![CDATA[>');
      return `<ac:plain-text-body><![CDATA[${safe}]]></ac:plain-text-body>`;
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

export interface ProtectedMedia { token: string; html: string; }

const MEDIA_TOKEN_PREFIX = 'CQ_MEDIA_PLACEHOLDER_';
// #765: legacy section/column wrappers are NO LONGER opaque-protected here
// (with one exception — see below). #723 froze them whole (token swap), which
// preserved them but made the prose inside uneditable by the LLM. They now
// round-trip via layout boundary tokens in htmlToMarkdown/markdownToHtml (see
// LAYOUT_TOKEN_* below) so the inner content stays improvable. The labels
// macro placeholder IS opaque — it is atomic (no prose inside) so the token
// pattern fits it exactly.
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
const OPAQUE_SUBTREE_SELECTOR =
  'div.confluence-drawio, div.confluence-mermaid, div.mermaid, div.confluence-macro-unknown';

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
 */
export function protectMedia(html: string): { html: string; media: ProtectedMedia[] } {
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
      if (n.parentElement?.closest('div.confluence-drawio, div.confluence-mermaid, div.mermaid, div.confluence-macro-unknown')) return false;
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
  for (const node of nodes) {
    const token = `${MEDIA_TOKEN_PREFIX}${media.length}`;
    media.push({ token, html: (node as Element).outerHTML });
    node.replaceWith(doc.createTextNode(` ${token} `));
  }
  return { html: doc.body.innerHTML, media };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Re-inject protected media. Replaces `<p>TOKEN</p>` (markdown wrapped the lone
 * token in a paragraph) and bare TOKEN occurrences with the original HTML.
 * Also handles the turndown-escaped form (underscores escaped as \_) so that
 * tokens survive a full htmlToMarkdown→markdownToHtml round-trip.
 *
 * #723 correctness:
 * - Single combined pass via one alternation regex + a *function* replacer.
 *   Function replacers treat their return value literally, so original media
 *   HTML containing `$`, `$&`, `$1`, `` $` ``, `$'`, `$$` (legitimate in
 *   Confluence attachment URLs / encoded query strings) is injected verbatim
 *   rather than being reinterpreted as String.replace special patterns.
 * - One pass also makes restoration collision-safe: already-injected media is
 *   never re-scanned, so an earlier entry whose original HTML literally
 *   contains a *later* token (e.g. in an `alt` / `data-diagram-name`) can no
 *   longer be corrupted by a subsequent replacement.
 * - `<p>TOKEN</p>` is preferred over the bare token via alternation order so
 *   the wrapping paragraph is consumed too. A `(?![0-9])` boundary on the bare
 *   form stops `..._1` from matching the prefix of `..._10`.
 */
export function restoreMedia(html: string, media: ProtectedMedia[]): string {
  if (media.length === 0) return html;

  // Map every token spelling (raw + turndown-escaped) back to its original HTML.
  const byMatch = new Map<string, string>();
  const wrappedAlts: string[] = [];
  const bareAlts: string[] = [];
  for (const { token, html: original } of media) {
    const escapedToken = token.replace(/_/g, '\\_'); // e.g. CQ\_MEDIA\_PLACEHOLDER\_0
    for (const t of [token, escapedToken]) {
      const pat = escapeRegExp(t);
      // Paragraph-wrapped form is matched first (it consumes the wrapping <p>);
      // the bare form ends on a non-digit so token N never matches token N0…N9.
      wrappedAlts.push(`<p>\\s*${pat}\\s*</p>`);
      bareAlts.push(`${pat}(?![0-9])`);
      byMatch.set(t, original);
    }
  }

  // All wrapped alternatives precede all bare ones so a `<p>TOKEN</p>` is never
  // partially matched by a bare-token alternative.
  const combined = new RegExp([...wrappedAlts, ...bareAlts].join('|'), 'g');
  return html.replace(combined, (matched) => {
    // Recover the token spelling from the (possibly <p>-wrapped, whitespace-
    // padded) match, then return the original literally (function replacers do
    // not interpret `$`-sequences).
    const inner = matched
      .replace(/^<p>\s*/, '')
      .replace(/\s*<\/p>$/, '')
      .trim();
    return byMatch.get(inner) ?? matched;
  });
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
      return `${checked ? '- [x]' : '- [ ]'} ${content.trim()}\n`;
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
      return `\n> **${type}**: ${content.trim()}\n\n`;
    },
  });

  // #723: draw.io diagrams — emit a fenced block carrying the diagram name so
  // markdownToHtml can rebuild the .confluence-drawio wrapper losslessly.
  turndownService.addRule('confluenceDrawio', {
    filter: (node) => node.nodeName === 'DIV' && node.classList.contains('confluence-drawio'),
    replacement: (_content, node) => {
      const name = (node as HTMLElement).getAttribute('data-diagram-name') ?? 'diagram';
      return `\n\n\`\`\`drawio\n${name}\n\`\`\`\n\n`;
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
}

/**
 * Converts Markdown to HTML (for LLM output -> editor).
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

  let html = await marked(normalized) as string;

  // #723: rebuild draw.io wrappers from ```drawio fences.
  // marked emits: <pre><code class="language-drawio">NAME\n</code></pre>
  html = html.replace(
    /<pre><code class="language-drawio">([\s\S]*?)\n?<\/code><\/pre>/g,
    (_m, name) => {
      const safe = String(name).trim();
      return `<div class="confluence-drawio" data-diagram-name="${safe.replace(/"/g, '&quot;')}"></div>`;
    },
  );

  if (skeleton) {
    // Sentinels can only exist outside code constructs (sentinelizeLayoutTokens
    // skips them), so no masking is needed. Nothing else is touched: any
    // remaining [[[…]]] text is prose the strictness ladder deliberately kept,
    // and it now reaches the page verbatim instead of being stripped.
    return rebuildLayoutFromSentinels(html, sentinelPrefix, sentinelTokens);
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

  return html;
}

/**
 * Strips all HTML tags, returning plain text (for full-text search — and, until
 * #1265, the embedding input; see htmlToEmbeddingText for why that moved).
 */
export function htmlToText(html: string): string {
  const dom = new JSDOM(`<body>${html}</body>`, { contentType: 'text/html' });
  const text = dom.window.document.body.textContent ?? '';
  return he.decode(text).replace(/\s+/g, ' ').trim();
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
