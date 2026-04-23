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
  CROSS_PAGE_IMAGES_PAGE,
  DRAWIO_PAGE,
  TOC_PAGE,
  TABLE_PAGE,
  UNKNOWN_MACRO_PAGE,
  COMPLEX_PAGE,
  USER_MENTIONS_PAGE,
  DATA_MACRO_VARIANT_PAGE,
  STATUS_MACRO_PAGE,
  CHILDREN_MACRO_ALL_PARAMS_PAGE,
  UI_CHILDREN_MACRO_PAGE,
  LAYOUT_TWO_EQUAL_PAGE,
  LAYOUT_SINGLE_PAGE,
  LAYOUT_LEFT_SIDEBAR_PAGE,
  LAYOUT_RIGHT_SIDEBAR_PAGE,
  LAYOUT_THREE_EQUAL_PAGE,
  LAYOUT_STACKED_SECTIONS_PAGE,
  LAYOUT_NESTED_CONTENT_PAGE,
  SECTION_COLUMN_PAGE,
  SECTION_BORDER_PAGE,
  SECTION_PIXEL_WIDTH_PAGE,
  ATTACHMENTS_MACRO_PAGE,
  ATTACHMENTS_MACRO_NO_PARAMS_PAGE,
  JIRA_PAGE,
  INCLUDE_PAGE,
  EXCERPT_INCLUDE_PAGE,
  TOC_WITH_PARAMS_PAGE,
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
      expect(html).toContain('data-confluence-image-source="attachment"');
      expect(html).toContain('width="600"');
      expect(html).toContain('src="/api/attachments/12345/external-');
      expect(html).toContain('data-confluence-image-source="external-url"');
      expect(html).toContain('data-confluence-url="https://example.com/diagram.svg"');
      expect(html).not.toContain('ri:attachment');
    });

    it('converts images without pageId to hash references', () => {
      const html = confluenceToHtml(IMAGES_PAGE);
      expect(html).toContain('src="#attachment:dashboard.png"');
    });

    it('converts cross-page attachment images to deterministic local filenames', () => {
      const html = confluenceToHtml(CROSS_PAGE_IMAGES_PAGE, '55', 'OPS');
      expect(html).toMatch(/src="\/api\/attachments\/55\/shared\.xref-[a-f0-9]{12}\.png"/);
      expect(html).toContain('data-confluence-owner-page-title="Shared Assets"');
      expect(html).toContain('data-confluence-owner-space-key="ENG"');
    });

    it('preserves images inside rich link bodies', () => {
      const html = confluenceToHtml(CROSS_PAGE_IMAGES_PAGE, '55', 'OPS');
      expect(html).toContain('<a href="#confluence-page:Shared Assets"');
      expect(html).toContain('<img');
      expect(html).not.toContain('thumbnail.png</a>');
    });

    it('converts draw.io macros', () => {
      const html = confluenceToHtml(DRAWIO_PAGE, '99');
      expect(html).toContain('class="confluence-drawio"');
      expect(html).toContain('data-diagram-name="system-topology"');
      expect(html).toContain('src="/api/attachments/99/system-topology.png"');
      expect(html).toContain('Edit in Confluence');
      expect(html).toContain('data-diagram-name="data-flow"');
    });

    it('converts status macros to colored inline badges', () => {
      const html = confluenceToHtml(STATUS_MACRO_PAGE);
      expect(html).toContain('class="confluence-status"');
      expect(html).toContain('data-color="green"');
      expect(html).toContain('>DONE</span>');
      expect(html).toContain('data-color="yellow"');
      expect(html).toContain('>IN PROGRESS</span>');
      expect(html).toContain('data-color="red"');
      expect(html).toContain('>BLOCKED</span>');
      expect(html).toContain('data-color="blue"');
      expect(html).toContain('>IN REVIEW</span>');
      expect(html).toContain('data-color="grey"');
      expect(html).toContain('>TODO</span>');
      expect(html).not.toContain('ac:structured-macro');
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
      // `widget-connector` is our canary for "truly unknown" — the top-4
      // named macros (jira, include, user mention, toc) now have
      // dedicated paths in #300.
      const html = confluenceToHtml(UNKNOWN_MACRO_PAGE);
      expect(html).toContain('class="confluence-macro-unknown"');
      expect(html).toContain('data-macro-name="widget-connector"');
      expect(html).toContain('Embedded widget');
    });

    it('preserves user mentions as @username spans (#300)', () => {
      const html = confluenceToHtml(USER_MENTIONS_PAGE);
      // Raw `<ri:user>` is rewritten into `<span class="confluence-user-mention">`.
      expect(html).not.toContain('ri:user'); // raw tag removed
      expect(html).toContain('class="confluence-user-mention"');
      // Emoticons still stripped (no round-trip for those).
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

    it('converts section/column macros to flex layout divs', () => {
      const html = confluenceToHtml(SECTION_COLUMN_PAGE);
      expect(html).toContain('class="confluence-section"');
      expect(html).toContain('class="confluence-column"');
      expect(html).toContain('data-cell-width="30%"');
      expect(html).toContain('data-cell-width="70%"');
      expect(html).toContain('Left column content');
      expect(html).toContain('Right column content');
      expect(html).toContain('<strong>bold</strong>');
      expect(html).not.toContain('ac:structured-macro');
    });

    it('adds inline flex style for visual column widths', () => {
      const html = confluenceToHtml(SECTION_COLUMN_PAGE);
      expect(html).toContain('style="flex: 0 0 30%"');
      expect(html).toContain('style="flex: 0 0 70%"');
    });

    it('adds inline flex style for pixel-width columns', () => {
      const html = confluenceToHtml(SECTION_PIXEL_WIDTH_PAGE);
      expect(html).toContain('style="flex: 0 0 200px"');
    });

    it('does not add inline style for columns without width', () => {
      const html = confluenceToHtml(SECTION_BORDER_PAGE);
      // Columns in SECTION_BORDER_PAGE have no width parameter
      expect(html).not.toContain('style="flex:');
    });

    it('converts section with border parameter', () => {
      const html = confluenceToHtml(SECTION_BORDER_PAGE);
      expect(html).toContain('class="confluence-section"');
      expect(html).toContain('data-border="true"');
      expect(html).toContain('Column A');
      expect(html).toContain('Column B');
    });

    it('preserves pixel widths on columns', () => {
      const html = confluenceToHtml(SECTION_PIXEL_WIDTH_PAGE);
      expect(html).toContain('data-cell-width="200px"');
      expect(html).toContain('Fixed sidebar');
      expect(html).toContain('Flexible main content');
      // Column without width should not have data-cell-width
      const columns = html.match(/class="confluence-column"/g);
      expect(columns).toHaveLength(2);
    });

    it('does not apply section/column classes to unrelated macros', () => {
      // Ensure other macros are not affected
      const html = confluenceToHtml(PANELS_PAGE);
      expect(html).not.toContain('confluence-section');
      expect(html).not.toContain('confluence-column');
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

    // --- Attachments macro tests ---

    it('converts attachments macro with parameters', () => {
      const html = confluenceToHtml(ATTACHMENTS_MACRO_PAGE);
      expect(html).toContain('class="confluence-attachments-macro"');
      expect(html).toContain('data-upload="true"');
      expect(html).toContain('data-old="false"');
      expect(html).toContain('[Attachments]');
      expect(html).not.toContain('ac:structured-macro');
    });

    it('converts attachments macro without parameters (defaults to false)', () => {
      const html = confluenceToHtml(ATTACHMENTS_MACRO_NO_PARAMS_PAGE);
      expect(html).toContain('class="confluence-attachments-macro"');
      expect(html).toContain('data-upload="false"');
      expect(html).toContain('data-old="false"');
      expect(html).not.toContain('confluence-macro-unknown');
    });

    // --- Layout macro tests ---

    it('converts two_equal layout to grid divs', () => {
      const html = confluenceToHtml(LAYOUT_TWO_EQUAL_PAGE);
      expect(html).toContain('class="confluence-layout"');
      expect(html).toContain('class="confluence-layout-section"');
      expect(html).toContain('data-layout-type="two_equal"');
      expect(html).toContain('class="confluence-layout-cell"');
      expect(html).toContain('Left column content');
      expect(html).toContain('Right column content');
      expect(html).not.toContain('ac:layout');
    });

    it('converts single layout', () => {
      const html = confluenceToHtml(LAYOUT_SINGLE_PAGE);
      expect(html).toContain('data-layout-type="single"');
      expect(html).toContain('Full width content');
    });

    it('converts two_left_sidebar layout', () => {
      const html = confluenceToHtml(LAYOUT_LEFT_SIDEBAR_PAGE);
      expect(html).toContain('data-layout-type="two_left_sidebar"');
      expect(html).toContain('Sidebar navigation');
      expect(html).toContain('Main content area');
    });

    it('converts two_right_sidebar layout', () => {
      const html = confluenceToHtml(LAYOUT_RIGHT_SIDEBAR_PAGE);
      expect(html).toContain('data-layout-type="two_right_sidebar"');
      expect(html).toContain('Main content area');
      expect(html).toContain('Sidebar widgets');
    });

    it('converts three_equal layout', () => {
      const html = confluenceToHtml(LAYOUT_THREE_EQUAL_PAGE);
      expect(html).toContain('data-layout-type="three_equal"');
      expect(html).toContain('Column one');
      expect(html).toContain('Column two');
      expect(html).toContain('Column three');
    });

    it('converts multiple stacked layout sections', () => {
      const html = confluenceToHtml(LAYOUT_STACKED_SECTIONS_PAGE);
      expect(html).toContain('data-layout-type="single"');
      expect(html).toContain('data-layout-type="two_equal"');
      expect(html).toContain('data-layout-type="three_equal"');
      expect(html).toContain('Introduction');
      expect(html).toContain('Feature A');
      expect(html).toContain('Feature C');
      // All layout XML removed
      expect(html).not.toContain('ac:layout');
      expect(html).not.toContain('ac:layout-section');
      expect(html).not.toContain('ac:layout-cell');
    });

    it('converts layout cells with nested rich content (lists, tables, macros)', () => {
      const html = confluenceToHtml(LAYOUT_NESTED_CONTENT_PAGE);
      expect(html).toContain('class="confluence-layout-section"');
      // Lists preserved
      expect(html).toContain('<li>Item 1</li>');
      // Code block converted
      expect(html).toContain('<pre><code class="language-bash">');
      // Table preserved
      expect(html).toContain('<table>');
      expect(html).toContain('Name');
      // Info panel converted
      expect(html).toContain('class="panel-info"');
      expect(html).toContain('Important note');
      // No remaining Confluence XML
      expect(html).not.toContain('ac:layout');
      expect(html).not.toContain('ac:structured-macro');
    });
  });

  // ========== htmlToConfluence (round-trip) ==========

  describe('htmlToConfluence', () => {
    it('self-closes void elements for valid XHTML', () => {
      const xhtml = htmlToConfluence('<p>Hello</p><br><hr><p>World</p>');
      expect(xhtml).toContain('<br />');
      expect(xhtml).toContain('<hr />');
      // Must not contain unclosed void elements
      expect(xhtml).not.toMatch(/<br>/);
      expect(xhtml).not.toMatch(/<hr>/);
    });

    it('self-closes img tags with attributes for valid XHTML', () => {
      const xhtml = htmlToConfluence('<p><img src="test.png" alt="test" width="100"></p>');
      expect(xhtml).toMatch(/<img [^>]*\/>/);
      expect(xhtml).not.toMatch(/<img [^/]+">/);
    });

    it('wraps code block content in CDATA sections', () => {
      const xhtml = htmlToConfluence('<pre><code class="language-js">var x = 1 && y < 2;</code></pre>');
      expect(xhtml).toContain('<![CDATA[var x = 1 && y < 2;]]>');
      expect(xhtml).toContain('ac:plain-text-body');
    });

    it('correctly unescapes HTML entities in CDATA sections', () => {
      const xhtml = htmlToConfluence('<pre><code>a &lt; b &amp;&amp; c &gt; d</code></pre>');
      expect(xhtml).toContain('<![CDATA[a < b && c > d]]>');
    });

    it('round-trips code blocks', () => {
      const html = confluenceToHtml(CODE_BLOCK_PAGE);
      const xhtml = htmlToConfluence(html);
      expect(xhtml).toContain('ac:name="code"');
      expect(xhtml).toContain('ac:name="language"');
      expect(xhtml).toContain('<![CDATA[');
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

    it('round-trips status macros', () => {
      const html = confluenceToHtml(STATUS_MACRO_PAGE);
      const xhtml = htmlToConfluence(html);
      expect(xhtml).toContain('ac:name="status"');
      expect(xhtml).toContain('ac:name="colour"');
      expect(xhtml).toContain('>Green<');
      expect(xhtml).toContain('>Yellow<');
      expect(xhtml).toContain('>Red<');
      expect(xhtml).toContain('>Blue<');
      expect(xhtml).toContain('>Grey<');
      expect(xhtml).toContain('ac:name="title"');
      expect(xhtml).toContain('>DONE<');
      expect(xhtml).toContain('>IN PROGRESS<');
      expect(xhtml).not.toContain('confluence-status');
    });

    it('round-trips section/column macros', () => {
      const html = confluenceToHtml(SECTION_COLUMN_PAGE);
      const xhtml = htmlToConfluence(html);
      expect(xhtml).toContain('ac:name="section"');
      expect(xhtml).toContain('ac:name="column"');
      expect(xhtml).toContain('ac:name="width"');
      expect(xhtml).toContain('>30%<');
      expect(xhtml).toContain('>70%<');
      expect(xhtml).toContain('ac:rich-text-body');
      expect(xhtml).toContain('Left column content');
      expect(xhtml).not.toContain('confluence-section');
      expect(xhtml).not.toContain('confluence-column');
    });

    it('round-trips section border parameter', () => {
      const html = confluenceToHtml(SECTION_BORDER_PAGE);
      const xhtml = htmlToConfluence(html);
      expect(xhtml).toContain('ac:name="section"');
      expect(xhtml).toContain('ac:name="border"');
      expect(xhtml).toContain('>true<');
    });

    it('round-trips pixel width columns', () => {
      const html = confluenceToHtml(SECTION_PIXEL_WIDTH_PAGE);
      const xhtml = htmlToConfluence(html);
      expect(xhtml).toContain('>200px<');
      // Column without width should not have width parameter
      expect(xhtml).toContain('ac:name="column"');
    });

    it('round-trips children macro with all parameters', () => {
      const html = confluenceToHtml(CHILDREN_MACRO_ALL_PARAMS_PAGE);
      expect(html).toContain('data-sort="creation"');
      expect(html).toContain('data-reverse="true"');
      expect(html).toContain('data-depth="2"');
      expect(html).toContain('data-first="10"');
      expect(html).toContain('data-page="My Parent"');
      expect(html).toContain('data-style="h3"');
      // HTML attributes are case-insensitive; jsdom lowercases on serialization
      expect(html).toContain('data-excerpttype="rich"');

      const xhtml = htmlToConfluence(html);
      expect(xhtml).toContain('ac:name="children"');
      expect(xhtml).toContain('>creation<');
      expect(xhtml).toContain('>true<');
      expect(xhtml).toContain('>2<');
      expect(xhtml).toContain('>10<');
      expect(xhtml).toContain('>My Parent<');
      expect(xhtml).toContain('>h3<');
      expect(xhtml).toContain('>rich<');
    });

    it('round-trips ui-children macro preserving macro name', () => {
      const html = confluenceToHtml(UI_CHILDREN_MACRO_PAGE);
      expect(html).toContain('data-macro-name="ui-children"');
      expect(html).toContain('data-sort="title"');
      expect(html).toContain('data-depth="3"');

      const xhtml = htmlToConfluence(html);
      expect(xhtml).toContain('ac:name="ui-children"');
      expect(xhtml).toContain('>title<');
      expect(xhtml).toContain('>3<');
    });

    it('round-trips attachments macro with parameters', () => {
      const html = confluenceToHtml(ATTACHMENTS_MACRO_PAGE);
      const xhtml = htmlToConfluence(html);
      expect(xhtml).toContain('ac:name="attachments"');
      expect(xhtml).toContain('ac:name="upload"');
      expect(xhtml).toContain('>true<');
      expect(xhtml).not.toContain('confluence-attachments-macro');
    });

    it('round-trips attachments macro without parameters (no false params emitted)', () => {
      const html = confluenceToHtml(ATTACHMENTS_MACRO_NO_PARAMS_PAGE);
      const xhtml = htmlToConfluence(html);
      expect(xhtml).toContain('ac:name="attachments"');
      // Default "false" params should not be emitted as Confluence parameters
      expect(xhtml).not.toContain('ac:name="upload"');
      expect(xhtml).not.toContain('ac:name="old"');
    });

    it('round-trips two_equal layout macros', () => {
      const html = confluenceToHtml(LAYOUT_TWO_EQUAL_PAGE);
      const xhtml = htmlToConfluence(html);
      expect(xhtml).toContain('ac:layout');
      expect(xhtml).toContain('ac:layout-section');
      expect(xhtml).toContain('ac:type="two_equal"');
      expect(xhtml).toContain('ac:layout-cell');
      expect(xhtml).toContain('Left column content');
      expect(xhtml).toContain('Right column content');
      expect(xhtml).not.toContain('confluence-layout');
    });

    it('round-trips all layout type variants', () => {
      for (const { fixture, type } of [
        { fixture: LAYOUT_SINGLE_PAGE, type: 'single' },
        { fixture: LAYOUT_LEFT_SIDEBAR_PAGE, type: 'two_left_sidebar' },
        { fixture: LAYOUT_RIGHT_SIDEBAR_PAGE, type: 'two_right_sidebar' },
        { fixture: LAYOUT_THREE_EQUAL_PAGE, type: 'three_equal' },
      ]) {
        const html = confluenceToHtml(fixture);
        const xhtml = htmlToConfluence(html);
        expect(xhtml).toContain(`ac:type="${type}"`);
        expect(xhtml).toContain('ac:layout-cell');
        expect(xhtml).not.toContain('confluence-layout-section');
      }
    });

    it('round-trips stacked layout sections', () => {
      const html = confluenceToHtml(LAYOUT_STACKED_SECTIONS_PAGE);
      const xhtml = htmlToConfluence(html);
      expect(xhtml).toContain('ac:type="single"');
      expect(xhtml).toContain('ac:type="two_equal"');
      expect(xhtml).toContain('ac:type="three_equal"');
      expect(xhtml).toContain('Introduction');
      expect(xhtml).toContain('Feature C');
    });

    it('round-trips layout with nested macros and rich content', () => {
      const html = confluenceToHtml(LAYOUT_NESTED_CONTENT_PAGE);
      const xhtml = htmlToConfluence(html);
      expect(xhtml).toContain('ac:layout');
      expect(xhtml).toContain('ac:type="two_equal"');
      // Code block restored inside cell
      expect(xhtml).toContain('ac:name="code"');
      expect(xhtml).toContain('<![CDATA[echo "hello"]]>');
      // Info panel restored inside cell
      expect(xhtml).toContain('ac:name="info"');
      expect(xhtml).toContain('Important note');
      // Table preserved inside cell
      expect(xhtml).toContain('<table>');
    });

    it('round-trips draw.io macros', () => {
      const html = confluenceToHtml(DRAWIO_PAGE, '99');
      const xhtml = htmlToConfluence(html);
      expect(xhtml).toContain('ac:name="drawio"');
      expect(xhtml).toContain('system-topology');
      expect(xhtml).toContain('data-flow');
    });

    it('round-trips image attachments', () => {
      const html = confluenceToHtml(IMAGES_PAGE, '12345', 'OPS');
      const xhtml = htmlToConfluence(html);
      expect(xhtml).toContain('ri:filename');
      expect(xhtml).toContain('dashboard.png');
      expect(xhtml).toContain('ri:url');
      expect(xhtml).toContain('https://example.com/diagram.svg');
    });

    it('round-trips cross-page image metadata back to ri:page references', () => {
      const html = confluenceToHtml(CROSS_PAGE_IMAGES_PAGE, '55', 'OPS');
      const xhtml = htmlToConfluence(html);
      expect(xhtml).toContain('ri:filename="shared.png"');
      expect(xhtml).toContain('ri:content-title="Shared Assets"');
      expect(xhtml).toContain('ri:space-key="ENG"');
    });

    it('round-trips complex page preserving structure', () => {
      const html = confluenceToHtml(COMPLEX_PAGE, '42');
      const xhtml = htmlToConfluence(html);
      // Code blocks restored with CDATA wrapping
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
      { name: 'layout-two-equal', xhtml: LAYOUT_TWO_EQUAL_PAGE },
      { name: 'layout-three-equal', xhtml: LAYOUT_THREE_EQUAL_PAGE },
      { name: 'layout-stacked', xhtml: LAYOUT_STACKED_SECTIONS_PAGE },
      { name: 'section/column', xhtml: SECTION_COLUMN_PAGE },
      { name: 'section/column with border', xhtml: SECTION_BORDER_PAGE },
      { name: 'section/column with pixel width', xhtml: SECTION_PIXEL_WIDTH_PAGE },
      { name: 'attachments macro', xhtml: ATTACHMENTS_MACRO_NO_PARAMS_PAGE },
      { name: 'attachments macro with params', xhtml: ATTACHMENTS_MACRO_PAGE },
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

    it('converts status macros to text badges', () => {
      const html = confluenceToHtml(STATUS_MACRO_PAGE);
      const md = htmlToMarkdown(html);
      expect(md).toContain('[STATUS: DONE]');
      expect(md).toContain('[STATUS: IN PROGRESS]');
      expect(md).toContain('[STATUS: BLOCKED]');
      expect(md).toContain('[STATUS: IN REVIEW]');
      expect(md).toContain('[STATUS: TODO]');
      expect(md).not.toMatch(/<span[^>]*>/);
      expect(md).not.toContain('confluence-status');
    });

    it('converts ui-children macro to markdown placeholder', () => {
      const html = confluenceToHtml(UI_CHILDREN_MACRO_PAGE);
      const md = htmlToMarkdown(html);
      expect(md).toContain('[Children pages]');
      expect(md).not.toContain('confluence-children-macro');
    });

    it('converts attachments macro to markdown placeholder', () => {
      const html = confluenceToHtml(ATTACHMENTS_MACRO_PAGE);
      const md = htmlToMarkdown(html);
      expect(md).toContain('[Attachments]');
      expect(md).not.toContain('confluence-attachments-macro');
    });

    it('converts section/column to markdown preserving column content', () => {
      const html = confluenceToHtml(SECTION_COLUMN_PAGE);
      const md = htmlToMarkdown(html);
      expect(md).toContain('Left column content');
      expect(md).toContain('Right column content');
      expect(md).not.toMatch(/<div[^>]*>/);
      expect(md).not.toContain('confluence-section');
      expect(md).not.toContain('confluence-column');
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
    it('user mentions now round-trip back to ri:user (#300)', () => {
      const html = confluenceToHtml(USER_MENTIONS_PAGE);
      const xhtml = htmlToConfluence(html);
      expect(xhtml).toContain('<ri:user');
    });

    it('unknown macros (not in the top-4 #300 coverage) are still lossy', () => {
      // The `widget-connector` fixture is not in the top-4 covered in #300,
      // so it continues to fall through to the unknown-macro wrapper.
      const html = confluenceToHtml(UNKNOWN_MACRO_PAGE);
      const xhtml = htmlToConfluence(html);
      expect(html).toContain('confluence-macro-unknown');
      expect(xhtml).not.toContain('ac:name="widget-connector"');
    });

    it('TOC macro now round-trips back to ac:structured-macro[name=toc] (#300)', () => {
      const html = confluenceToHtml(TOC_PAGE);
      const xhtml = htmlToConfluence(html);
      expect(xhtml).toContain('ac:name="toc"');
    });

    it('documents emoticons are stripped', () => {
      const html = confluenceToHtml(USER_MENTIONS_PAGE);
      expect(html).not.toContain('ac:emoticon');
      // Cannot be restored
    });
  });
});

// ========== Figure/Caption pass-through tests (#13) ==========

// ==========================================================================
// #300 — improved paste-from-Confluence macro coverage
// ==========================================================================

describe('content-converter: #300 paste-from-Confluence macros', () => {
  describe('JIRA issue macro', () => {
    it('forward: renders [JIRA: KEY] span with data attributes', () => {
      const html = confluenceToHtml(JIRA_PAGE);
      expect(html).toContain('class="confluence-jira-issue"');
      expect(html).toContain('data-key="PROJ-123"');
      expect(html).toContain('data-server-id="abc-123"');
      expect(html).toContain('[JIRA: PROJ-123]');
    });

    it('reverse: restores ac:structured-macro[name=jira] with params', () => {
      const html = confluenceToHtml(JIRA_PAGE);
      const xhtml = htmlToConfluence(html);
      expect(xhtml).toContain('ac:name="jira"');
      expect(xhtml).toContain('<ac:parameter ac:name="key">PROJ-123</ac:parameter>');
      expect(xhtml).toContain('<ac:parameter ac:name="serverId">abc-123</ac:parameter>');
    });

    it('double round-trip preserves the JIRA key', () => {
      const once = htmlToConfluence(confluenceToHtml(JIRA_PAGE));
      const twice = htmlToConfluence(confluenceToHtml(once));
      expect(twice).toContain('PROJ-123');
      expect(twice).toContain('ac:name="jira"');
    });

    it('Markdown emit keeps the JIRA key visible (turndown escapes brackets)', () => {
      const md = htmlToMarkdown(confluenceToHtml(JIRA_PAGE));
      // turndown escapes `[` / `]` in body text; the key itself must survive.
      expect(md).toContain('JIRA: PROJ-123');
    });
  });

  describe('include / excerpt-include macro', () => {
    it('include: forward renders [Include: PageName] placeholder', () => {
      const html = confluenceToHtml(INCLUDE_PAGE);
      expect(html).toContain('class="confluence-include-macro"');
      expect(html).toContain('data-macro-name="include"');
      expect(html).toContain('data-page-title="Backup Procedures"');
      expect(html).toContain('data-space-key="OPS"');
      expect(html).toContain('[Include: Backup Procedures]');
    });

    it('include: reverse restores macro with page reference', () => {
      const html = confluenceToHtml(INCLUDE_PAGE);
      const xhtml = htmlToConfluence(html);
      expect(xhtml).toContain('ac:name="include"');
      expect(xhtml).toContain('ri:content-title="Backup Procedures"');
      expect(xhtml).toContain('ri:space-key="OPS"');
    });

    it('excerpt-include: preserves the macro name across round-trip', () => {
      const html = confluenceToHtml(EXCERPT_INCLUDE_PAGE);
      const xhtml = htmlToConfluence(html);
      expect(html).toContain('data-macro-name="excerpt-include"');
      expect(html).toContain('[Excerpt: Quarterly Report]');
      expect(xhtml).toContain('ac:name="excerpt-include"');
      expect(xhtml).toContain('ri:content-title="Quarterly Report"');
    });

    it('reverse: omits empty ac:name attribute on anonymous include parameter (#300)', () => {
      // Finding #3: when the original macro's <ac:parameter> has no name
      // (anonymous param wrapping <ri:page/>), the reverse path must NOT
      // emit `ac:name=""` — it must omit the attribute entirely.
      const html = confluenceToHtml(INCLUDE_PAGE);
      const xhtml = htmlToConfluence(html);
      expect(xhtml).not.toContain('ac:name=""');
      // Sanity: the ri:page child is still present inside an ac:parameter.
      expect(xhtml).toMatch(/<ac:parameter>\s*<ri:page/);
    });

    it('double round-trip for include macro preserves the page reference', () => {
      const once = htmlToConfluence(confluenceToHtml(INCLUDE_PAGE));
      const twice = htmlToConfluence(confluenceToHtml(once));
      expect(twice).toContain('ac:name="include"');
      expect(twice).toContain('ri:content-title="Backup Procedures"');
      expect(twice).toContain('ri:space-key="OPS"');
      expect(twice).not.toContain('ac:name=""');
    });
  });

  describe('user mentions', () => {
    it('forward: renders @<username> span with data attributes', () => {
      const html = confluenceToHtml(USER_MENTIONS_PAGE);
      expect(html).toContain('class="confluence-user-mention"');
      // Fixture uses userkey (deleted-user shape) — span should keep the key.
      expect(html).toMatch(/data-userkey="user\d+"/);
    });

    it('reverse: restores ri:user wrapped in ac:link', () => {
      const html = confluenceToHtml(USER_MENTIONS_PAGE);
      const xhtml = htmlToConfluence(html);
      expect(xhtml).toContain('<ri:user');
      // JSDOM may serialize `<ri:user/>` as either self-closing or
      // as an empty element pair — accept both.
      expect(xhtml).toMatch(/<ac:link>\s*<ri:user[^>]*(?:\/>|><\/ri:user>)\s*<\/ac:link>/);
    });

    it('preserves username-based mentions (vs userkey-based)', () => {
      const src = `<p>Contact <ri:user ri:username="alice" /> today.</p>`;
      const html = confluenceToHtml(src);
      const xhtml = htmlToConfluence(html);
      expect(html).toContain('data-username="alice"');
      expect(html).toContain('@alice');
      expect(xhtml).toContain('ri:username="alice"');
    });

    it('adjacent self-closing ri:user tags preserve both mentions and surrounding text (#300 regression)', () => {
      // Finding #1: JSDOM in text/html mode does NOT treat `<ri:user ... />` as
      // self-closing. Two adjacent self-closing `<ri:user/>` tags nest, with the
      // first swallowing the second plus all text until the next close tag.
      // Pre-processor must rewrite self-closing ri:* tags to explicit close form.
      const html = confluenceToHtml(USER_MENTIONS_PAGE);
      // Both mentions must survive.
      const mentionCount = (html.match(/confluence-user-mention/g) ?? []).length;
      expect(mentionCount).toBe(2);
      expect(html).toContain('data-userkey="user123"');
      expect(html).toContain('data-userkey="user456"');
      // Surrounding text must survive too.
      expect(html).toContain('Contact');
      expect(html).toContain('or');
      expect(html).toContain('for questions');
      // And the following paragraph (after the mention paragraph) must survive.
      expect(html).toContain('Great job!');
    });

    it('adjacent username ri:user mentions with text between them round-trip (#300 regression)', () => {
      const src = `<p>Hey <ri:user ri:username="alice" /> and <ri:user ri:username="bob" />, please review.</p>`;
      const html = confluenceToHtml(src);
      const mentionCount = (html.match(/confluence-user-mention/g) ?? []).length;
      expect(mentionCount).toBe(2);
      expect(html).toContain('@alice');
      expect(html).toContain('@bob');
      expect(html).toContain('Hey');
      expect(html).toContain('and');
      expect(html).toContain('please review');
      const xhtml = htmlToConfluence(html);
      expect(xhtml).toContain('ri:username="alice"');
      expect(xhtml).toContain('ri:username="bob"');
    });

    it('double round-trip preserves mentions when wrapped in ac:link (#300 regression)', () => {
      // Finding #2: htmlToConfluence wraps ri:user in ac:link. On a second
      // forward pass, the ac:link handler must detect the nested ri:user and
      // delegate to the ri:user handler — NOT emit an empty <a></a>.
      const src = `<p>Contact <ac:link><ri:user ri:username="alice" /></ac:link> today.</p>`;
      const html = confluenceToHtml(src);
      expect(html).toContain('class="confluence-user-mention"');
      expect(html).toContain('data-username="alice"');
      expect(html).toContain('@alice');
      // Full double-round-trip: XHTML → HTML → XHTML → HTML → XHTML must still
      // carry the mention through.
      const once = htmlToConfluence(html);
      const twiceHtml = confluenceToHtml(once);
      expect(twiceHtml).toContain('class="confluence-user-mention"');
      expect(twiceHtml).toContain('@alice');
      const twiceXhtml = htmlToConfluence(twiceHtml);
      expect(twiceXhtml).toContain('ri:username="alice"');
    });

    it('double round-trip preserves both mentions on the USER_MENTIONS_PAGE fixture (#300 regression)', () => {
      const once = htmlToConfluence(confluenceToHtml(USER_MENTIONS_PAGE));
      const twiceHtml = confluenceToHtml(once);
      const mentionCount = (twiceHtml.match(/confluence-user-mention/g) ?? []).length;
      expect(mentionCount).toBe(2);
      const twiceXhtml = htmlToConfluence(twiceHtml);
      // Both userkeys must survive the full double round-trip.
      expect(twiceXhtml).toContain('ri:userkey="user123"');
      expect(twiceXhtml).toContain('ri:userkey="user456"');
    });
  });

  describe('TOC macro', () => {
    it('forward: renders confluence-toc placeholder preserving params', () => {
      const html = confluenceToHtml(TOC_WITH_PARAMS_PAGE);
      expect(html).toContain('class="confluence-toc"');
      expect(html).toContain('data-maxlevel="3"');
      expect(html).toContain('data-outline="true"');
      expect(html).toContain('[Table of Contents]');
    });

    it('reverse: restores ac:structured-macro[name=toc] with params', () => {
      const html = confluenceToHtml(TOC_WITH_PARAMS_PAGE);
      const xhtml = htmlToConfluence(html);
      expect(xhtml).toContain('ac:name="toc"');
      expect(xhtml).toContain('<ac:parameter ac:name="maxLevel">3</ac:parameter>');
      expect(xhtml).toContain('<ac:parameter ac:name="outline">true</ac:parameter>');
    });

    it('double round-trip preserves TOC params', () => {
      const once = htmlToConfluence(confluenceToHtml(TOC_WITH_PARAMS_PAGE));
      const twice = htmlToConfluence(confluenceToHtml(once));
      expect(twice).toContain('ac:name="toc"');
      expect(twice).toContain('maxLevel');
    });
  });
});

describe('content-converter: figure/caption round-trip (#13)', () => {
  it('passes <figure> and <figcaption> through confluenceToHtml unchanged', () => {
    const html = '<figure class="figure-block"><img src="test.png" alt="Test" /><figcaption>My caption</figcaption></figure>';
    // confluenceToHtml processes Confluence XHTML; standard HTML elements should pass through
    const result = confluenceToHtml(html);
    expect(result).toContain('<figure');
    expect(result).toContain('<figcaption>');
    expect(result).toContain('My caption');
  });

  it('passes <div class="table-caption"> through confluenceToHtml unchanged', () => {
    const html = '<div class="table-caption">Revenue by Quarter</div>';
    const result = confluenceToHtml(html);
    expect(result).toContain('table-caption');
    expect(result).toContain('Revenue by Quarter');
  });

  it('preserves <figure> and <figcaption> in htmlToConfluence', () => {
    const html = '<figure class="figure-block"><img src="test.png" alt="Test" /><figcaption>My caption</figcaption></figure>';
    const result = htmlToConfluence(html);
    expect(result).toContain('<figure');
    expect(result).toContain('<figcaption>');
    expect(result).toContain('My caption');
  });

  it('preserves <div class="table-caption"> in htmlToConfluence', () => {
    const html = '<div class="table-caption">Revenue by Quarter</div>';
    const result = htmlToConfluence(html);
    expect(result).toContain('table-caption');
    expect(result).toContain('Revenue by Quarter');
  });
});

// ========== Index block stripping tests (#13) ==========

describe('content-converter: index block stripping (#13)', () => {
  it('strips <div class="figure-index"> during htmlToConfluence', () => {
    const html = '<p>Hello</p><div class="figure-index"><h3>List of Figures</h3><ol><li>Figure 1: Test</li></ol></div><p>World</p>';
    const result = htmlToConfluence(html);
    expect(result).not.toContain('figure-index');
    expect(result).not.toContain('List of Figures');
    expect(result).toContain('Hello');
    expect(result).toContain('World');
  });

  it('strips <div class="table-index"> during htmlToConfluence', () => {
    const html = '<p>Hello</p><div class="table-index"><h3>List of Tables</h3><ol><li>Table 1: Test</li></ol></div><p>World</p>';
    const result = htmlToConfluence(html);
    expect(result).not.toContain('table-index');
    expect(result).not.toContain('List of Tables');
    expect(result).toContain('Hello');
    expect(result).toContain('World');
  });

  it('strips multiple index blocks at once', () => {
    const html = '<div class="figure-index">figures</div><div class="table-index">tables</div><p>Content</p>';
    const result = htmlToConfluence(html);
    expect(result).not.toContain('figure-index');
    expect(result).not.toContain('table-index');
    expect(result).toContain('Content');
  });

  it('does not strip index blocks during confluenceToHtml (inbound pass-through)', () => {
    // Index blocks in stored HTML should be preserved when loading into the editor
    const html = '<div class="figure-index">figures</div><p>Content</p>';
    const result = confluenceToHtml(html);
    expect(result).toContain('figure-index');
  });
});
