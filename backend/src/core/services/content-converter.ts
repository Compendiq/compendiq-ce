import { JSDOM } from 'jsdom';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { marked } from 'marked';
import he from 'he';
import {
  getAttachmentImageSource,
  getLocalFilenameForImageSource,
} from './image-references.js';

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
const SELF_CLOSING_XHTML_TAGS = ['ri:user', 'ri:page', 'ri:attachment', 'ri:url', 'ac:emoticon'];

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

function getParamValue(macro: Element, name: string): string | null {
  for (const param of byTag(macro as unknown as Element, 'ac:parameter')) {
    if (param.getAttribute('ac:name') === name) {
      return param.textContent;
    }
  }
  return null;
}

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

  // Process expand macros: ac:structured-macro[name=expand] -> <details>
  for (const macro of byTag(doc, 'ac:structured-macro')) {
    if (getMacroName(macro) !== 'expand') continue;
    const title = getParamValue(macro, 'title') ?? 'Click to expand';
    const bodyEl = byTag(macro, 'ac:rich-text-body')[0];

    const details = doc.createElement('details');
    const summary = doc.createElement('summary');
    summary.textContent = title;
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

  // Remove remaining unknown macros - preserve as data attributes
  for (const macro of byTag(doc, 'ac:structured-macro')) {
    const name = getMacroName(macro) || 'unknown';
    const bodyEl = byTag(macro, 'ac:rich-text-body')[0];

    const div = doc.createElement('div');
    div.className = 'confluence-macro-unknown';
    div.setAttribute('data-macro-name', name);
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

  // Convert task lists back
  for (const ul of doc.querySelectorAll('ul[data-type="taskList"]')) {
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

  // Convert panels back
  for (const panelType of ['info', 'warning', 'note', 'tip']) {
    for (const div of doc.querySelectorAll(`.panel-${panelType}`)) {
      const macro = doc.createElement('ac:structured-macro');
      macro.setAttribute('ac:name', panelType);
      const body = doc.createElement('ac:rich-text-body');
      transferInnerHtml(body, div);
      macro.appendChild(body);
      div.replaceWith(macro);
    }
  }

  // Convert expand sections back
  for (const details of doc.querySelectorAll('details')) {
    const summary = details.querySelector('summary');
    const macro = doc.createElement('ac:structured-macro');
    macro.setAttribute('ac:name', 'expand');

    if (summary) {
      const param = doc.createElement('ac:parameter');
      param.setAttribute('ac:name', 'title');
      param.textContent = summary.textContent ?? '';
      macro.appendChild(param);
      summary.remove();
    }

    const body = doc.createElement('ac:rich-text-body');
    transferInnerHtml(body, details);
    macro.appendChild(body);
    details.replaceWith(macro);
  }

  // Convert section divs back to ac:structured-macro[name=section] (outside-in: sections before columns)
  for (const div of doc.querySelectorAll('div.confluence-section')) {
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

  // Convert column divs back to ac:structured-macro[name=column] (inside sections)
  for (const div of doc.querySelectorAll('div.confluence-column')) {
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
      return `<ac:plain-text-body><![CDATA[${raw}]]></ac:plain-text-body>`;
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
      if (n.parentElement?.closest('div.confluence-drawio, div.confluence-mermaid, div.mermaid')) return false;
      // Skip descendants of a frozen wrapper — it is protected whole. If the
      // nearest wrapper ancestor is not frozen, no farther one can be either
      // (frozenness propagates downward: a frozen ancestor's constrained
      // container is an ancestor of every nested wrapper too).
      const wrapperAncestor = n.parentElement?.closest(LEGACY_WRAPPER_SELECTOR);
      if (wrapperAncestor && isFrozenLegacyWrapper(wrapperAncestor)) return false;
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
const LAYOUT_TOKEN_KINDS = 'LAYOUT-SECTION|LAYOUT-CELL|LAYOUT|SECTION|COLUMN';
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
    case 'SECTION': return top === undefined || top === 'LAYOUT-CELL' || top === 'COLUMN';
    case 'COLUMN': return top === 'SECTION';
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
    // Unreachable: kinds are constrained by LAYOUT_TOKEN_KINDS in the regex.
    default:
      return '<div>';
  }
}

/**
 * Rebuild div.confluence-layout* / -section / -column wrappers from boundary
 * tokens in marked's HTML output. All-or-nothing: the token sequence is
 * validated for balance + nesting first, so a single mangled token can never
 * produce unbalanced divs — instead every token is stripped (graceful
 * flatten) while the prose is kept.
 */
function rebuildLayoutStructure(html: string): string {
  const tokens = [...html.matchAll(layoutTokenRegex())].map(parseLayoutToken);
  if (tokens.length === 0) return html;

  let valid = true;
  const stack: string[] = [];
  for (const t of tokens) {
    if (!t.isClose) {
      if (!layoutOpenAllowed(t.kind, stack)) { valid = false; break; }
      stack.push(t.kind);
    } else if (stack.pop() !== t.kind) {
      valid = false;
      break;
    }
  }
  if (stack.length > 0) valid = false;

  let i = 0;
  return html.replace(layoutTokenRegex(), () => {
    const t = tokens[i++]!;
    if (!valid) return ''; // drop-guard: strip the token, keep the prose
    return t.isClose ? '</div>' : layoutOpenTag(t.kind, t.attrs);
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
// ---------------------------------------------------------------------------

export interface LayoutSkeletonToken { kind: string; isClose: boolean; attrs: string; }

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
    if (wrapper) tokens.push({ kind: wrapper.kind, isClose: false, attrs: wrapper.attrs });
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
const LAYOUT_KIND_LOOSE = 'LAYOUT[-_ ]SECTION|LAYOUT[-_ ]CELL|LAYOUT|SECTION|COLUMN';
const LAYOUT_TOKEN_LOOSE_SRC =
  String.raw`(?:\*{1,2}|_{1,2})?` +
  String.raw`((?:\\?\[){2,4})` +
  String.raw`[ \t]*([/\\])?[ \t]*` +
  String.raw`(${LAYOUT_KIND_LOOSE})` +
  String.raw`((?:[^\]\n\\]|\\[^\]\n])*)` +
  String.raw`(?:\\?\]){2,4}` +
  String.raw`(?:\*{1,2}|_{1,2})?`;

interface ScannedLayoutToken { start: number; end: number; kind: string; isClose: boolean; }

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
const PROSE_BEARING_KINDS = new Set(['LAYOUT-CELL', 'COLUMN', 'SECTION']);

/** Greedy in-order alignment of scanned tokens onto the skeleton. */
function alignLayoutTokens(
  found: ScannedLayoutToken[],
  skeleton: LayoutSkeletonToken[],
): { matched: number[]; ok: boolean; matchedCount: number } {
  const matched: number[] = new Array<number>(skeleton.length).fill(-1);
  let s = 0;
  for (let f = 0; f < found.length; f++) {
    let k = s;
    while (k < skeleton.length && !(skeleton[k]!.kind === found[f]!.kind && skeleton[k]!.isClose === found[f]!.isClose)) k++;
    if (k < skeleton.length) {
      matched[k] = f;
      s = k + 1;
    }
    // else: unmatched echo — debris, stripped during reconstruction.
  }
  const ok = skeleton.every((t, i) => matched[i] !== -1 || t.isClose || !PROSE_BEARING_KINDS.has(t.kind));
  return { matched, ok, matchedCount: matched.filter((f) => f !== -1).length };
}

function canonicalLayoutToken(t: LayoutSkeletonToken): string {
  return t.isClose ? `[[[/${t.kind}]]]` : `[[[${t.kind}${t.attrs ? ` ${t.attrs}` : ''}]]]`;
}

/** Prose may live at top level and inside cells/columns/legacy sections. */
function proseAllowedIn(stack: string[]): boolean {
  const top = stack[stack.length - 1];
  return top === undefined || top === 'LAYOUT-CELL' || top === 'COLUMN' || top === 'SECTION';
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
    const seg = raw.replace(/^\n+|\n+$/g, ''); // outer newlines only — keep code indentation
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

  // Single-slot wrap (#785 review): with exactly one prose-bearing open the
  // assignment is unambiguous even when nothing aligned at all.
  const proseSlots = skeleton.filter((t) => !t.isClose && PROSE_BEARING_KINDS.has(t.kind));
  if (proseSlots.length === 1) {
    const wrapped = wrapProseInSingleSlot(markdown, skeleton);
    if (matchesSkeleton(wrapped, skeleton)) return wrapped;
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
  // #781: with a known skeleton, align the LLM's echo against it first —
  // throws LayoutRecoveryError when the layout is unrecoverable.
  const input = options?.layoutSkeleton
    ? recoverLayoutMarkdown(markdown, options.layoutSkeleton)
    : markdown;

  // #765: force every layout boundary token onto its own paragraph so marked
  // wraps it in a lone <p>, even when the LLM merged adjacent token lines or
  // pulled a token into surrounding prose. Code constructs are skipped —
  // literal token text in a fenced block must survive verbatim.
  const tokenLine = new RegExp(`[ \\t]*(${LAYOUT_TOKEN_BARE})[ \\t]*`, 'g');
  const normalized = transformOutsideMarkdownCode(input, (segment) =>
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

  html = transformOutsideHtmlCode(html, (segment) => {
    // #765: rebuild layout/section/column wrappers from boundary tokens.
    let out = rebuildLayoutStructure(segment);

    // #765 drop-guard backstop: strip any token-shaped remnant that failed
    // structural matching (e.g. the LLM lower-cased a marker) — raw [[[…]]]
    // text must never reach the saved page. With a skeleton (#781) recovery
    // has already rewritten every real token canonically and consumed all
    // mangled debris, so the strip stays case-SENSITIVE there: a surviving
    // lower-case token shape is a prose lookalike the strictness ladder
    // deliberately preserved, not a failed marker (#785 review).
    out = out.replace(
      new RegExp(
        `<p>\\s*${LAYOUT_TOKEN_BARE}\\s*</p>|${LAYOUT_TOKEN_BARE}`,
        options?.layoutSkeleton ? 'g' : 'gi',
      ),
      '',
    );
    return out;
  });

  return html;
}

/**
 * Strips all HTML tags, returning plain text (for full-text search + embedding input).
 */
export function htmlToText(html: string): string {
  const dom = new JSDOM(`<body>${html}</body>`, { contentType: 'text/html' });
  const text = dom.window.document.body.textContent ?? '';
  return he.decode(text).replace(/\s+/g, ' ').trim();
}
