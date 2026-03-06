import { describe, it, expect } from 'vitest';
import {
  confluenceToHtml,
  htmlToConfluence,
  htmlToMarkdown,
  markdownToHtml,
  htmlToText,
} from './content-converter.js';
import {
  SIMPLE_PAGE,
  CODE_BLOCK_PAGE,
  TASK_LIST_PAGE,
  PANELS_PAGE,
  EXPAND_PAGE,
  LINKS_PAGE,
  IMAGES_PAGE,
  DRAWIO_PAGE,
  TOC_PAGE,
  TABLE_PAGE,
  UNKNOWN_MACRO_PAGE,
  COMPLEX_PAGE,
  USER_MENTIONS_PAGE,
  DATA_MACRO_VARIANT_PAGE,
} from './__fixtures__/confluence-xhtml.js';

describe('content-converter', () => {
  // ========== confluenceToHtml ==========

  describe('confluenceToHtml', () => {
    it('passes through simple HTML unchanged', () => {
      const html = confluenceToHtml(SIMPLE_PAGE);
      expect(html).toContain('<h1>Getting Started Guide</h1>');
      expect(html).toContain('<strong>Knowledge Base</strong>');
      expect(html).toContain('<em>basics</em>');
      expect(html).toContain('<code>Node.js 22</code>');
      expect(html).not.toContain('ac:');
    });

    it('converts code blocks with language', () => {
      const html = confluenceToHtml(CODE_BLOCK_PAGE);
      expect(html).toContain('<pre><code class="language-bash">');
      expect(html).toContain('npm install');
      expect(html).toContain('<pre><code class="language-typescript">');
      expect(html).toContain('interface Config');
      expect(html).not.toContain('ac:structured-macro');
      expect(html).not.toContain('ac:plain-text-body');
    });

    it('converts task lists with status', () => {
      const html = confluenceToHtml(TASK_LIST_PAGE);
      expect(html).toContain('data-type="taskList"');
      expect(html).toContain('data-type="taskItem"');
      // First task is complete
      expect(html).toMatch(/data-checked="true"[^>]*>Set up CI pipeline/s);
      // Second task is incomplete
      expect(html).toMatch(/data-checked="false"[^>]*>Write integration tests/s);
      // Third task has inline HTML
      expect(html).toContain('<strong>staging</strong>');
      expect(html).not.toContain('ac:task');
    });

    it('converts panels (info, warning, note, tip)', () => {
      const html = confluenceToHtml(PANELS_PAGE);
      expect(html).toContain('class="panel-info"');
      expect(html).toContain('class="panel-warning"');
      expect(html).toContain('class="panel-note"');
      expect(html).toContain('class="panel-tip"');
      expect(html).toContain('PostgreSQL 17');
      expect(html).toContain('Never run migrations');
      expect(html).not.toContain('ac:structured-macro');
    });

    it('converts expand macros to <details>', () => {
      const html = confluenceToHtml(EXPAND_PAGE);
      expect(html).toContain('<details>');
      expect(html).toContain('<summary>How do I reset my password?</summary>');
      expect(html).toContain('Settings &gt; Account');
      expect(html).toContain('<summary>What models are supported?</summary>');
    });

    it('converts Confluence links (page and attachment)', () => {
      const html = confluenceToHtml(LINKS_PAGE);
      expect(html).toContain('href="#confluence-page:Architecture Overview"');
      expect(html).toContain('data-confluence-link="page"');
      expect(html).toContain('Architecture Overview</a>');
      expect(html).toContain('href="#confluence-attachment:report.pdf"');
      expect(html).toContain('data-confluence-link="attachment"');
      expect(html).not.toContain('ri:page');
    });

    it('converts images with attachments and URLs', () => {
      const html = confluenceToHtml(IMAGES_PAGE, '12345');
      expect(html).toContain('src="/api/attachments/12345/dashboard.png"');
      expect(html).toContain('alt="dashboard.png"');
      expect(html).toContain('width="600"');
      expect(html).toContain('src="https://example.com/diagram.svg"');
      expect(html).not.toContain('ri:attachment');
    });

    it('converts images without pageId to hash references', () => {
      const html = confluenceToHtml(IMAGES_PAGE);
      expect(html).toContain('src="#attachment:dashboard.png"');
    });

    it('converts draw.io macros', () => {
      const html = confluenceToHtml(DRAWIO_PAGE, '99');
      expect(html).toContain('class="confluence-drawio"');
      expect(html).toContain('data-diagram-name="system-topology"');
      expect(html).toContain('src="/api/attachments/99/system-topology.png"');
      expect(html).toContain('Edit in Confluence');
      expect(html).toContain('data-diagram-name="data-flow"');
    });

    it('converts table of contents to placeholder', () => {
      const html = confluenceToHtml(TOC_PAGE);
      expect(html).toContain('class="confluence-toc"');
      expect(html).toContain('[Table of Contents]');
    });

    it('preserves tables as-is', () => {
      const html = confluenceToHtml(TABLE_PAGE);
      expect(html).toContain('<table>');
      expect(html).toContain('JWT_SECRET');
      expect(html).toContain('POSTGRES_URL');
    });

    it('wraps unknown macros with data attributes', () => {
      const html = confluenceToHtml(UNKNOWN_MACRO_PAGE);
      expect(html).toContain('class="confluence-macro-unknown"');
      expect(html).toContain('data-macro-name="jira"');
      expect(html).toContain('Related issue');
    });

    it('strips user mentions and emoticons', () => {
      const html = confluenceToHtml(USER_MENTIONS_PAGE);
      expect(html).not.toContain('ri:user');
      expect(html).not.toContain('ac:emoticon');
      expect(html).toContain('Contact');
    });

    it('handles data-macro-name attribute variant', () => {
      const html = confluenceToHtml(DATA_MACRO_VARIANT_PAGE);
      expect(html).toContain('<pre><code class="language-python">');
      expect(html).toContain('print("hello world")');
      expect(html).toContain('class="panel-info"');
      expect(html).toContain('<details>');
      expect(html).toContain('<summary>Details</summary>');
    });

    it('converts complex page with all macro types', () => {
      const html = confluenceToHtml(COMPLEX_PAGE, '42');
      // TOC
      expect(html).toContain('class="confluence-toc"');
      // Warning panel
      expect(html).toContain('class="panel-warning"');
      // Task list
      expect(html).toContain('data-type="taskList"');
      // Links inside tasks
      expect(html).toContain('#confluence-page:Backup Procedures');
      // Draw.io
      expect(html).toContain('class="confluence-drawio"');
      expect(html).toContain('data-diagram-name="migration-flow"');
      // Code blocks
      expect(html).toContain('language-bash');
      expect(html).toContain('docker compose');
      // Info panel
      expect(html).toContain('class="panel-info"');
      // Expand
      expect(html).toContain('<summary>Troubleshooting</summary>');
      // Table
      expect(html).toContain('<table>');
      // No remaining Confluence XML
      expect(html).not.toContain('ac:structured-macro');
      expect(html).not.toContain('ac:task-list');
    });
  });

  // ========== htmlToConfluence (round-trip) ==========

  describe('htmlToConfluence', () => {
    it('round-trips code blocks', () => {
      const html = confluenceToHtml(CODE_BLOCK_PAGE);
      const xhtml = htmlToConfluence(html);
      expect(xhtml).toContain('ac:name="code"');
      expect(xhtml).toContain('ac:name="language"');
      // Content is preserved (as text, not CDATA — JSDOM HTML mode)
      expect(xhtml).toContain('npm install');
    });

    it('round-trips task lists', () => {
      const html = confluenceToHtml(TASK_LIST_PAGE);
      const xhtml = htmlToConfluence(html);
      expect(xhtml).toContain('ac:task-list');
      expect(xhtml).toContain('ac:task-status');
      expect(xhtml).toContain('complete');
      expect(xhtml).toContain('incomplete');
    });

    it('round-trips panels', () => {
      const html = confluenceToHtml(PANELS_PAGE);
      const xhtml = htmlToConfluence(html);
      expect(xhtml).toContain('ac:name="info"');
      expect(xhtml).toContain('ac:name="warning"');
      expect(xhtml).toContain('ac:name="note"');
      expect(xhtml).toContain('ac:name="tip"');
      expect(xhtml).toContain('ac:rich-text-body');
    });

    it('round-trips expand macros', () => {
      const html = confluenceToHtml(EXPAND_PAGE);
      const xhtml = htmlToConfluence(html);
      expect(xhtml).toContain('ac:name="expand"');
      expect(xhtml).toContain('How do I reset my password?');
      expect(xhtml).toContain('ac:rich-text-body');
    });

    it('round-trips draw.io macros', () => {
      const html = confluenceToHtml(DRAWIO_PAGE, '99');
      const xhtml = htmlToConfluence(html);
      expect(xhtml).toContain('ac:name="drawio"');
      expect(xhtml).toContain('system-topology');
      expect(xhtml).toContain('data-flow');
    });

    it('round-trips image attachments', () => {
      const html = confluenceToHtml(IMAGES_PAGE, '12345');
      const xhtml = htmlToConfluence(html);
      expect(xhtml).toContain('ri:filename');
      expect(xhtml).toContain('dashboard.png');
    });

    it('round-trips complex page preserving structure', () => {
      const html = confluenceToHtml(COMPLEX_PAGE, '42');
      const xhtml = htmlToConfluence(html);
      // Code blocks restored (content as text, not CDATA)
      expect(xhtml).toContain('ac:name="code"');
      expect(xhtml).toContain('docker compose');
      // Panels restored
      expect(xhtml).toContain('ac:name="warning"');
      expect(xhtml).toContain('ac:name="info"');
      // Expand restored
      expect(xhtml).toContain('ac:name="expand"');
      // Draw.io restored
      expect(xhtml).toContain('ac:name="drawio"');
      // Task list restored
      expect(xhtml).toContain('ac:task-list');
      // Table preserved
      expect(xhtml).toContain('<table>');
    });
  });

  // ========== Double round-trip stability ==========

  describe('double round-trip stability', () => {
    // Task lists and expand macros have known non-deterministic round-trips:
    // - Task lists: random task-id generation on each htmlToConfluence call
    // - Expand macros: extra <div> wrapper added on each confluenceToHtml pass
    // These are tested separately below.
    const stableFixtures = [
      { name: 'panels', xhtml: PANELS_PAGE },
      { name: 'draw.io', xhtml: DRAWIO_PAGE },
      { name: 'tables', xhtml: TABLE_PAGE },
    ];

    for (const { name, xhtml } of stableFixtures) {
      it(`stabilizes after one round-trip: ${name}`, () => {
        const html1 = confluenceToHtml(xhtml, '1');
        const xhtml1 = htmlToConfluence(html1);
        const html2 = confluenceToHtml(xhtml1, '1');
        const xhtml2 = htmlToConfluence(html2);
        expect(xhtml2).toBe(xhtml1);
      });
    }

    it('stabilizes code blocks after one round-trip (ignoring CDATA vs entities)', () => {
      // First round-trip converts CDATA to text, second should be stable
      const html1 = confluenceToHtml(CODE_BLOCK_PAGE, '1');
      const xhtml1 = htmlToConfluence(html1);
      const html2 = confluenceToHtml(xhtml1, '1');
      // HTML output stabilizes (the readable form)
      expect(html2).toBe(html1);
    });

    it('preserves task list content across round-trips', () => {
      const html1 = confluenceToHtml(TASK_LIST_PAGE, '1');
      const xhtml1 = htmlToConfluence(html1);
      const html2 = confluenceToHtml(xhtml1, '1');
      // HTML output is stable (task-ids change but aren't in HTML)
      expect(html2).toBe(html1);
    });

    it('preserves expand content across round-trips', () => {
      const html1 = confluenceToHtml(EXPAND_PAGE, '1');
      const xhtml1 = htmlToConfluence(html1);
      const html2 = confluenceToHtml(xhtml1, '1');
      const xhtml2 = htmlToConfluence(html2);
      const html3 = confluenceToHtml(xhtml2, '1');
      // HTML stabilizes after second pass
      expect(html3).toBe(html2);
    });
  });

  // ========== htmlToMarkdown ==========

  describe('htmlToMarkdown', () => {
    it('converts headings and paragraphs', () => {
      const html = confluenceToHtml(SIMPLE_PAGE);
      const md = htmlToMarkdown(html);
      expect(md).toContain('# Getting Started Guide');
      expect(md).toContain('**Knowledge Base**');
      expect(md).toContain('_basics_');
      expect(md).toContain('`Node.js 22`');
    });

    it('converts code blocks with language', () => {
      const html = confluenceToHtml(CODE_BLOCK_PAGE);
      const md = htmlToMarkdown(html);
      expect(md).toContain('```bash');
      expect(md).toContain('npm install');
      expect(md).toContain('```typescript');
    });

    it('converts task lists to checkbox syntax', () => {
      const html = confluenceToHtml(TASK_LIST_PAGE);
      const md = htmlToMarkdown(html);
      expect(md).toContain('- [x] Set up CI pipeline');
      expect(md).toContain('- [ ] Write integration tests');
    });

    it('converts panels to blockquotes with type', () => {
      const html = confluenceToHtml(PANELS_PAGE);
      const md = htmlToMarkdown(html);
      expect(md).toContain('**INFO**');
      expect(md).toContain('**WARNING**');
      expect(md).toContain('**NOTE**');
      expect(md).toContain('**TIP**');
    });

    it('produces clean markdown for LLM consumption from complex page', () => {
      const html = confluenceToHtml(COMPLEX_PAGE, '42');
      const md = htmlToMarkdown(html);
      // Should contain key content
      expect(md).toContain('Database Migration');
      expect(md).toContain('docker compose');
      // Should not contain HTML tags
      expect(md).not.toMatch(/<div[^>]*>/);
      expect(md).not.toMatch(/<ac:/);
    });
  });

  // ========== markdownToHtml ==========

  describe('markdownToHtml', () => {
    it('converts markdown to HTML', async () => {
      const html = await markdownToHtml('# Hello\n\nThis is **bold** and `code`.');
      expect(html).toContain('<h1>Hello</h1>');
      expect(html).toContain('<strong>bold</strong>');
      expect(html).toContain('<code>code</code>');
    });

    it('converts fenced code blocks', async () => {
      const html = await markdownToHtml('```js\nconsole.log("hi");\n```');
      expect(html).toContain('<code');
      expect(html).toContain('console.log');
    });
  });

  // ========== htmlToText ==========

  describe('htmlToText', () => {
    it('strips all tags from simple HTML', () => {
      const html = confluenceToHtml(SIMPLE_PAGE);
      const text = htmlToText(html);
      expect(text).toContain('Getting Started Guide');
      expect(text).toContain('Knowledge Base');
      expect(text).not.toContain('<');
      expect(text).not.toContain('>');
    });

    it('extracts text from complex page', () => {
      const html = confluenceToHtml(COMPLEX_PAGE, '42');
      const text = htmlToText(html);
      expect(text).toContain('Database Migration');
      expect(text).toContain('docker compose');
      expect(text).toContain('Troubleshooting');
      expect(text).not.toMatch(/<[^>]+>/);
    });

    it('decodes HTML entities', () => {
      const text = htmlToText('<p>A &amp; B &lt; C</p>');
      expect(text).toContain('A & B < C');
    });
  });

  // ========== Lossy macro documentation ==========

  describe('lossy conversion documentation', () => {
    it('documents what is lost in user mentions', () => {
      const html = confluenceToHtml(USER_MENTIONS_PAGE);
      const xhtml = htmlToConfluence(html);
      // User mentions are stripped and cannot be restored
      expect(xhtml).not.toContain('ri:user');
      // This is expected - document it
    });

    it('documents what is lost in unknown macros', () => {
      const html = confluenceToHtml(UNKNOWN_MACRO_PAGE);
      const xhtml = htmlToConfluence(html);
      // Unknown macros lose their original structure
      // They become divs with data attributes, not restored to ac:structured-macro
      expect(html).toContain('confluence-macro-unknown');
    });

    it('documents TOC macro is replaced with placeholder', () => {
      const html = confluenceToHtml(TOC_PAGE);
      const xhtml = htmlToConfluence(html);
      // TOC becomes a div placeholder, not restored to ac:structured-macro
      expect(xhtml).not.toContain('ac:name="toc"');
    });

    it('documents emoticons are stripped', () => {
      const html = confluenceToHtml(USER_MENTIONS_PAGE);
      expect(html).not.toContain('ac:emoticon');
      // Cannot be restored
    });
  });
});
