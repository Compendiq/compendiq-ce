import { JSDOM } from 'jsdom';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { marked } from 'marked';
import he from 'he';

/**
 * Converts Confluence storage format (XHTML) to clean HTML for TipTap editor.
 * Handles common Confluence macros: code blocks, task lists, panels, links, images, draw.io.
 */
export function confluenceToHtml(storageXhtml: string, pageId?: string): string {
  const dom = new JSDOM(`<body>${storageXhtml}</body>`, { contentType: 'text/html' });
  const doc = dom.window.document;

  // Process code blocks: ac:structured-macro[name=code] -> <pre><code>
  for (const macro of doc.querySelectorAll('ac\\:structured-macro[ac\\:name="code"], ac\\:structured-macro[data-macro-name="code"]')) {
    const language = getParamValue(macro, 'language') ?? '';
    const bodyEl = macro.querySelector('ac\\:plain-text-body');
    const code = bodyEl?.textContent ?? '';

    const pre = doc.createElement('pre');
    const codeEl = doc.createElement('code');
    if (language) codeEl.className = `language-${language}`;
    codeEl.textContent = code;
    pre.appendChild(codeEl);
    macro.replaceWith(pre);
  }

  // Process task lists: ac:task-list -> <ul data-type="taskList">
  for (const taskList of doc.querySelectorAll('ac\\:task-list')) {
    const ul = doc.createElement('ul');
    ul.setAttribute('data-type', 'taskList');

    for (const task of taskList.querySelectorAll('ac\\:task')) {
      const statusEl = task.querySelector('ac\\:task-status');
      const bodyEl = task.querySelector('ac\\:task-body');
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
  for (const panelType of ['info', 'warning', 'note', 'tip']) {
    for (const macro of doc.querySelectorAll(`ac\\:structured-macro[ac\\:name="${panelType}"], ac\\:structured-macro[data-macro-name="${panelType}"]`)) {
      const bodyEl = macro.querySelector('ac\\:rich-text-body');
      const div = doc.createElement('div');
      div.className = `panel-${panelType}`;
      div.innerHTML = bodyEl?.innerHTML ?? '';
      macro.replaceWith(div);
    }
  }

  // Process expand macros: ac:structured-macro[name=expand] -> <details>
  for (const macro of doc.querySelectorAll('ac\\:structured-macro[ac\\:name="expand"], ac\\:structured-macro[data-macro-name="expand"]')) {
    const title = getParamValue(macro, 'title') ?? 'Click to expand';
    const bodyEl = macro.querySelector('ac\\:rich-text-body');

    const details = doc.createElement('details');
    const summary = doc.createElement('summary');
    summary.textContent = title;
    details.appendChild(summary);
    if (bodyEl) {
      const content = doc.createElement('div');
      content.innerHTML = bodyEl.innerHTML;
      details.appendChild(content);
    }
    macro.replaceWith(details);
  }

  // Process Confluence links: ac:link -> <a>
  for (const link of doc.querySelectorAll('ac\\:link')) {
    const pageRef = link.querySelector('ri\\:page');
    const attachRef = link.querySelector('ri\\:attachment');
    const bodyEl = link.querySelector('ac\\:link-body, ac\\:plain-text-link-body');

    const a = doc.createElement('a');
    if (pageRef) {
      const pageTitle = pageRef.getAttribute('ri:content-title') ?? '';
      a.href = `#confluence-page:${pageTitle}`;
      a.textContent = bodyEl?.textContent ?? pageTitle;
      a.setAttribute('data-confluence-link', 'page');
    } else if (attachRef) {
      const filename = attachRef.getAttribute('ri:filename') ?? '';
      a.href = `#confluence-attachment:${filename}`;
      a.textContent = bodyEl?.textContent ?? filename;
      a.setAttribute('data-confluence-link', 'attachment');
    } else {
      a.textContent = bodyEl?.textContent ?? '';
    }
    link.replaceWith(a);
  }

  // Process images: ac:image -> <img>
  for (const image of doc.querySelectorAll('ac\\:image')) {
    const attachRef = image.querySelector('ri\\:attachment');
    const urlRef = image.querySelector('ri\\:url');

    const img = doc.createElement('img');
    if (attachRef) {
      const filename = attachRef.getAttribute('ri:filename') ?? '';
      if (pageId) {
        img.src = `/api/attachments/${pageId}/${encodeURIComponent(filename)}`;
      } else {
        img.src = `#attachment:${filename}`;
      }
      img.alt = filename;
    } else if (urlRef) {
      img.src = urlRef.getAttribute('ri:value') ?? '';
    }
    const width = image.getAttribute('ac:width');
    if (width) img.width = parseInt(width, 10);
    image.replaceWith(img);
  }

  // Process draw.io macros -> <div class="confluence-drawio">
  for (const macro of doc.querySelectorAll('ac\\:structured-macro[ac\\:name="drawio"], ac\\:structured-macro[data-macro-name="drawio"]')) {
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

  // Process table of contents macro -> placeholder
  for (const macro of doc.querySelectorAll('ac\\:structured-macro[ac\\:name="toc"], ac\\:structured-macro[data-macro-name="toc"]')) {
    const div = doc.createElement('div');
    div.className = 'confluence-toc';
    div.textContent = '[Table of Contents]';
    macro.replaceWith(div);
  }

  // Remove remaining unknown macros - preserve as data attributes
  for (const macro of doc.querySelectorAll('ac\\:structured-macro')) {
    const name = macro.getAttribute('ac:name') ?? macro.getAttribute('data-macro-name') ?? 'unknown';
    const bodyEl = macro.querySelector('ac\\:rich-text-body');

    const div = doc.createElement('div');
    div.className = 'confluence-macro-unknown';
    div.setAttribute('data-macro-name', name);
    div.innerHTML = bodyEl?.innerHTML ?? `[Confluence macro: ${name}]`;
    macro.replaceWith(div);
  }

  // Clean remaining Confluence-specific elements
  for (const el of doc.querySelectorAll('ac\\:emoticon, ri\\:user')) {
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
    const cdata = doc.createCDATASection(code);
    body.appendChild(cdata);
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
    const filename = decodeURIComponent(src.split('/').pop() ?? '');

    const acImage = doc.createElement('ac:image');
    const riAttachment = doc.createElement('ri:attachment');
    riAttachment.setAttribute('ri:filename', filename);
    acImage.appendChild(riAttachment);

    const width = img.getAttribute('width');
    if (width) acImage.setAttribute('ac:width', width);
    img.replaceWith(acImage);
  }

  return doc.body.innerHTML;
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

function getParamValue(macro: Element, name: string): string | null {
  for (const param of macro.querySelectorAll('ac\\:parameter')) {
    if (param.getAttribute('ac:name') === name) {
      return param.textContent;
    }
  }
  return null;
}
