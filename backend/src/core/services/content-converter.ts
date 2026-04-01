import { JSDOM } from 'jsdom';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { marked } from 'marked';
import he from 'he';
import {
  getAttachmentImageSource,
  getLocalFilenameForImageSource,
} from './image-references.js';

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
 * Converts Confluence storage format (XHTML) to clean HTML for TipTap editor.
 * Handles common Confluence macros: code blocks, task lists, panels, links, images, draw.io.
 */
export function confluenceToHtml(storageXhtml: string, pageId?: string, spaceKey?: string): string {
  const dom = new JSDOM(`<body>${stripCdata(storageXhtml)}</body>`, { contentType: 'text/html' });
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
      li.innerHTML = bodyEl?.innerHTML ?? '';
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
    div.innerHTML = bodyEl?.innerHTML ?? '';
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
    const pageRef = byTag(link, 'ri:page')[0];
    const attachRef = byTag(link, 'ri:attachment')[0];
    const bodyEl = byTag(link, 'ac:link-body')[0] ?? byTag(link, 'ac:plain-text-link-body')[0];

    const a = doc.createElement('a');
    if (pageRef) {
      const pageTitle = pageRef.getAttribute('ri:content-title') ?? '';
      a.href = `#confluence-page:${pageTitle}`;
      if (bodyEl && bodyEl.tagName.toLowerCase() === 'ac:link-body') {
        a.innerHTML = bodyEl.innerHTML;
      } else {
        a.textContent = bodyEl?.textContent ?? pageTitle;
      }
      a.setAttribute('data-confluence-link', 'page');
    } else if (attachRef) {
      const filename = attachRef.getAttribute('ri:filename') ?? '';
      a.href = `#confluence-attachment:${filename}`;
      if (bodyEl && bodyEl.tagName.toLowerCase() === 'ac:link-body') {
        a.innerHTML = bodyEl.innerHTML;
      } else {
        a.textContent = bodyEl?.textContent ?? filename;
      }
      a.setAttribute('data-confluence-link', 'attachment');
    } else {
      if (bodyEl && bodyEl.tagName.toLowerCase() === 'ac:link-body') {
        a.innerHTML = bodyEl.innerHTML;
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

  // Process table of contents macro -> placeholder
  for (const macro of byTag(doc, 'ac:structured-macro')) {
    if (getMacroName(macro) !== 'toc') continue;
    const div = doc.createElement('div');
    div.className = 'confluence-toc';
    div.textContent = '[Table of Contents]';
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
    div.innerHTML = bodyEl?.innerHTML ?? '';
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
    div.innerHTML = bodyEl?.innerHTML ?? '';
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
    div.innerHTML = cell.innerHTML;
    cell.replaceWith(div);
  }
  for (const section of byTag(doc, 'ac:layout-section')) {
    const layoutType = section.getAttribute('ac:type') ?? 'single';
    const div = doc.createElement('div');
    div.className = 'confluence-layout-section';
    div.setAttribute('data-layout-type', layoutType);
    div.innerHTML = section.innerHTML;
    section.replaceWith(div);
  }
  for (const layout of byTag(doc, 'ac:layout')) {
    const div = doc.createElement('div');
    div.className = 'confluence-layout';
    div.innerHTML = layout.innerHTML;
    layout.replaceWith(div);
  }

  // Remove remaining unknown macros - preserve as data attributes
  for (const macro of byTag(doc, 'ac:structured-macro')) {
    const name = getMacroName(macro) || 'unknown';
    const bodyEl = byTag(macro, 'ac:rich-text-body')[0];

    const div = doc.createElement('div');
    div.className = 'confluence-macro-unknown';
    div.setAttribute('data-macro-name', name);
    div.innerHTML = bodyEl?.innerHTML ?? `[Confluence macro: ${name}]`;
    macro.replaceWith(div);
  }

  // Clean remaining Confluence-specific elements
  for (const el of [...byTag(doc, 'ac:emoticon'), ...byTag(doc, 'ri:user')]) {
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
      taskBody.innerHTML = li.innerHTML;

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
      body.innerHTML = div.innerHTML;
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
    body.innerHTML = details.innerHTML;
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
    body.innerHTML = div.innerHTML;
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
      if (m) width = m[1];
    }
    if (width) {
      const param = doc.createElement('ac:parameter');
      param.setAttribute('ac:name', 'width');
      param.textContent = width;
      macro.appendChild(param);
    }
    const body = doc.createElement('ac:rich-text-body');
    body.innerHTML = div.innerHTML;
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

/**
 * Converts HTML to Markdown (for LLM consumption).
 */
export function htmlToMarkdown(html: string): string {
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

  // Custom rule for section containers — render content inline
  turndownService.addRule('confluenceSection', {
    filter: (node) =>
      node.nodeName === 'DIV' && node.classList.contains('confluence-section'),
    replacement: (content) => `\n${content.trim()}\n\n`,
  });

  // Custom rule for column containers — separate with divider
  turndownService.addRule('confluenceColumn', {
    filter: (node) =>
      node.nodeName === 'DIV' && node.classList.contains('confluence-column'),
    replacement: (content) => `\n${content.trim()}\n`,
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

  return turndownService.turndown(html);
}

/**
 * Converts Markdown to HTML (for LLM output -> editor).
 */
export async function markdownToHtml(markdown: string): Promise<string> {
  return await marked(markdown) as string;
}

/**
 * Strips all HTML tags, returning plain text (for full-text search + embedding input).
 */
export function htmlToText(html: string): string {
  const dom = new JSDOM(`<body>${html}</body>`, { contentType: 'text/html' });
  const text = dom.window.document.body.textContent ?? '';
  return he.decode(text).replace(/\s+/g, ' ').trim();
}
