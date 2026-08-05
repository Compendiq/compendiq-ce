import { describe, it, expect } from 'vitest';
import {
  confluenceToHtml,
  htmlToConfluence,
  htmlToMarkdown,
  markdownToHtml,
  htmlToText,
  protectMedia,
  restoreMedia,
  extractLayoutSkeleton,
  LayoutRecoveryError,
  hasRecoverableLayoutTokens,
} from './content-converter.js';
import {
  SIMPLE_PAGE,
  CODE_BLOCK_PAGE,
  TASK_LIST_PAGE,
  PANELS_PAGE,
  EXPAND_PAGE,
  UI_EXPAND_PAGE,
  MIXED_EXPAND_PAGE,
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
  LAYOUT_THREE_WITH_SIDEBARS_PAGE,
  LAYOUT_DC_EXTRA_ATTRS_PAGE,
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
import { STRUCTURE_PRESERVATION_INSTRUCTION } from '../../domains/llm/services/prompts.js';

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
      // #1211: the forward pass stamps the producing macro's identity so the
      // reverse pass can write back the right ac:name.
      expect(html).toContain('<details data-macro-name="expand">');
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

    it('converts the labels macro to a placeholder and never leaks "[Confluence macro: labels]" (#348, #765)', () => {
      const xhtml = `<p>Before</p>
        <ac:structured-macro ac:name="labels" ac:schema-version="1">
          <ac:parameter ac:name="showLabels">true</ac:parameter>
        </ac:structured-macro>
        <p>After</p>`;
      const html = confluenceToHtml(xhtml);
      expect(html).not.toContain('[Confluence macro: labels]');
      expect(html).not.toContain('confluence-macro-unknown');
      expect(html).not.toContain('ac:structured-macro');
      // #765: kept as a placeholder (was: dropped) so write-back does not
      // delete the widget from the Confluence page body.
      expect(html).toContain('class="confluence-labels-macro"');
      expect(html).toContain('data-showlabels="true"');
      expect(html).toContain('Before');
      expect(html).toContain('After');
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
      expect(html).toContain('<details data-macro-name="expand">');
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

    it('splits embedded CDATA terminators in code block content (#900)', () => {
      const xhtml = htmlToConfluence('<pre><code>printf("]]&gt;");</code></pre>');
      // The literal ]]> must be split across two adjacent CDATA sections so
      // the wrapping section is not prematurely closed.
      expect(xhtml).toContain('<![CDATA[printf("]]]]><![CDATA[>");]]>');
    });

    it('round-trips code blocks containing ]]> (#900)', () => {
      const html = '<pre><code>printf("]]&gt;");</code></pre>';
      const xhtml = htmlToConfluence(html);
      const roundTripped = confluenceToHtml(xhtml);
      expect(roundTripped).toContain('printf("]]&gt;");');
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

    it('converts an editor-authored empty panel to a macro (#1134)', () => {
      // The panel picker inserts an empty panel, so the reverse pass sees a
      // shape the Confluence sync never produces: a .panel-* div whose only
      // child is an empty <p>. It must still become the macro rather than
      // being dropped as empty — otherwise an author's freshly inserted Info
      // box vanishes on the first save to Confluence.
      const xhtml = htmlToConfluence('<div class="panel-info"><p></p></div>');
      expect(xhtml).toContain('ac:name="info"');
      expect(xhtml).toContain('ac:rich-text-body');
    });

    it('round-trips expand macros', () => {
      const html = confluenceToHtml(EXPAND_PAGE);
      const xhtml = htmlToConfluence(html);
      expect(xhtml).toContain('ac:name="expand"');
      expect(xhtml).toContain('How do I reset my password?');
      expect(xhtml).toContain('ac:rich-text-body');
    });

    // ========== Macro identity on <details> (#1211) ==========
    //
    // htmlToConfluence used to write ac:name="expand" on EVERY <details>. That
    // is correct only while exactly one macro maps to <details>; the moment a
    // second one does (#1129, Refined "UI Expand"), write-back would silently
    // rewrite the third-party macro into a native expand on the first editor
    // save. These cases pin the identity round-trip that prevents that.
    describe('macro identity on <details> (#1211)', () => {
      it('writes back two different ac:name values, each on its own body', () => {
        const html =
          '<details data-macro-name="expand"><summary>Native</summary><p>A</p></details>' +
          '<details data-macro-name="ui-expand"><summary>Refined</summary><p>B</p></details>';
        const xhtml = htmlToConfluence(html);
        // Pin the name-to-content pairing, not just that both values appear
        // somewhere — a reverse-loop regression that SWAPPED the identities
        // would pass a presence-only assertion (PR #1216 review).
        const native = xhtml.match(
          /<ac:structured-macro ac:name="expand">[\s\S]*?<\/ac:structured-macro>/,
        )?.[0];
        expect(native).toBeDefined();
        expect(native).toContain('Native');
        expect(native).toContain('<p>A</p>');
        expect(native).not.toContain('Refined');
        const refined = xhtml.match(
          /<ac:structured-macro ac:name="ui-expand">[\s\S]*?<\/ac:structured-macro>/,
        )?.[0];
        expect(refined).toBeDefined();
        expect(refined).toContain('Refined');
        expect(refined).toContain('<p>B</p>');
      });

      it('round-trips nested expand sections without leaking a literal <details> (innermost-first)', () => {
        // Confluence natively supports expand-inside-expand. The reverse loop
        // rebuilds each body by re-parsing innerHTML, so converting outer
        // before inner would copy the still-raw inner <details> into the new
        // body — a copy the loop snapshot never visits — and ship a literal
        // HTML5 element to Confluence (PR #1216 review).
        const storage =
          '<ac:structured-macro ac:name="expand"><ac:parameter ac:name="title">Outer</ac:parameter><ac:rich-text-body>' +
          '<p>before</p>' +
          '<ac:structured-macro ac:name="expand"><ac:parameter ac:name="title">Inner</ac:parameter><ac:rich-text-body><p>deep</p></ac:rich-text-body></ac:structured-macro>' +
          '<p>after</p>' +
          '</ac:rich-text-body></ac:structured-macro>';
        const html = confluenceToHtml(storage);
        const xhtml = htmlToConfluence(html);
        expect(xhtml).not.toContain('<details');
        expect(xhtml.match(/ac:name="expand"/g)).toHaveLength(2);
        expect(xhtml).toContain('<ac:parameter ac:name="title">Outer</ac:parameter>');
        expect(xhtml).toContain('<ac:parameter ac:name="title">Inner</ac:parameter>');
        expect(xhtml).toContain('<p>deep</p>');
      });

      it('keeps a nested foreign identity intact inside a native section', () => {
        const xhtml = htmlToConfluence(
          '<details data-macro-name="expand"><summary>Outer</summary>' +
            '<details data-macro-name="ui-expand"><summary>Inner</summary><p>deep</p></details>' +
            '</details>',
        );
        expect(xhtml).not.toContain('<details');
        expect(xhtml).toContain('ac:name="expand"');
        expect(xhtml).toContain('ac:name="ui-expand"');
      });

      it('unwraps a summary that is not a direct child instead of leaking the tag', () => {
        // The direct-child rule (above) means a wrapped <summary> is not this
        // section's title — but it must not ship to Confluence as a literal
        // HTML5 element either. Improve-apply feeds model-produced markdown
        // through htmlToConfluence with no tag allow-list, so the shape is
        // reachable without the editor (#1216 re-review).
        const xhtml = htmlToConfluence(
          '<details data-macro-name="expand"><div><summary>WrappedTitle</summary></div><p>body</p></details>',
        );
        expect(xhtml).not.toContain('<summary');
        expect(xhtml).toContain('WrappedTitle');
        expect(xhtml).not.toContain('ac:name="title"');
      });

      it('does not let a summary-less outer section steal a nested summary as its title', () => {
        const xhtml = htmlToConfluence(
          '<details>' +
            '<details data-macro-name="ui-expand"><summary>InnerTitle</summary><p>deep</p></details>' +
            '</details>',
        );
        // Exactly one title parameter, and it belongs to the inner macro.
        expect(xhtml.match(/ac:name="title"/g)).toHaveLength(1);
        const inner = xhtml.match(
          /<ac:structured-macro ac:name="ui-expand">[\s\S]*?<\/ac:structured-macro>/,
        )?.[0];
        expect(inner).toContain('<ac:parameter ac:name="title">InnerTitle</ac:parameter>');
      });

      it('passes an unrecognised macroName through, never coercing to expand', () => {
        const xhtml = htmlToConfluence(
          '<details data-macro-name="whatever"><summary>S</summary><p>B</p></details>',
        );
        expect(xhtml).toContain('ac:name="whatever"');
        expect(xhtml).not.toContain('ac:name="expand"');
      });

      it('defaults an attribute-less <details> to expand (stored content + editor-created sections)', () => {
        const xhtml = htmlToConfluence('<details><summary>S</summary><p>B</p></details>');
        expect(xhtml).toContain('ac:name="expand"');
      });

      it('persists non-title parameters through the forward pass, title staying in <summary> only', () => {
        const page =
          '<ac:structured-macro ac:name="expand">' +
          '<ac:parameter ac:name="title">T</ac:parameter>' +
          '<ac:parameter ac:name="breakout-mode">wide</ac:parameter>' +
          '<ac:rich-text-body><p>B</p></ac:rich-text-body></ac:structured-macro>';
        const html = confluenceToHtml(page);
        expect(html).toContain('data-macro-name="expand"');
        expect(html).toContain('breakout-mode');
        // title is not duplicated into the params JSON — <summary> is its
        // single source of truth.
        expect(html).not.toMatch(/data-macro-params="[^"]*title/);
      });

      it('re-emits data-macro-params as ac:parameter entries, <summary> winning over a stale title param', () => {
        const xhtml = htmlToConfluence(
          '<details data-macro-name="ui-expand" ' +
            'data-macro-params=\'{"breakout-mode":"wide","title":"stale"}\'>' +
            '<summary>Real Title</summary><p>B</p></details>',
        );
        expect(xhtml).toContain('ac:name="ui-expand"');
        expect(xhtml).toContain('<ac:parameter ac:name="breakout-mode">wide</ac:parameter>');
        expect(xhtml).toContain('<ac:parameter ac:name="title">Real Title</ac:parameter>');
        expect(xhtml).not.toContain('stale');
      });

      it('preserves a foreign identity on the next sync', () => {
        // Writing a ui-expand back and re-importing must return it as a
        // <details> with its identity intact — not vanish, and not become a
        // native expand. Before #1129 the re-import landed in the #865
        // unknown-macro placeholder instead (identity preserved, but opaque).
        const xhtml = htmlToConfluence(
          '<details data-macro-name="ui-expand"><summary>T</summary><p>B</p></details>',
        );
        const html = confluenceToHtml(xhtml);
        expect(html).toContain('<details data-macro-name="ui-expand">');
        expect(html).toContain('<summary>T</summary>');
        expect(html).not.toContain('confluence-macro-unknown');
      });
    });

    // ========== Refined "UI Expand" macro (#1129) ==========
    //
    // A second macro now maps onto <details>, which is what the #1211 identity
    // stamp above exists for. Storage shape verified against a Confluence DC
    // 9.2.19 instance with the Refined Macro Toolkit installed: same `title`
    // parameter and ac:rich-text-body as the native macro, plus an `expanded`
    // parameter present ONLY on default-open sections.
    describe('Refined UI Expand macro (#1129)', () => {
      it('converts ui-expand to <details> carrying its own identity', () => {
        const html = confluenceToHtml(UI_EXPAND_PAGE);
        expect(html).toContain('data-macro-name="ui-expand"');
        expect(html).toContain('<summary>Development Team</summary>');
        expect(html).toContain('<summary>Support Team</summary>');
        // Not the #865 opaque placeholder any more, and not a native expand.
        expect(html).not.toContain('confluence-macro-unknown');
        expect(html).not.toContain('data-macro-name="expand"');
      });

      it('maps expanded=true onto the open attribute and leaves a collapsed section closed', () => {
        const html = confluenceToHtml(UI_EXPAND_PAGE);
        const sections = [...html.matchAll(/<details[^>]*>/g)].map((m) => m[0]);
        expect(sections).toHaveLength(2);
        // First section is expanded=true in the fixture, second omits the param.
        expect(sections[0]).toMatch(/\bopen\b/);
        expect(sections[1]).not.toMatch(/\bopen\b/);
      });

      it('keeps `expanded` out of data-macro-params — open is its only home', () => {
        // Otherwise a user toggling the section in the editor flips `open`
        // while the stale string rides along, and the reverse pass emits both.
        const html = confluenceToHtml(UI_EXPAND_PAGE);
        expect(html).not.toMatch(/data-macro-params="[^"]*expanded/);
      });

      it('round-trips a default-open section back to expanded=true', () => {
        const xhtml = htmlToConfluence(confluenceToHtml(UI_EXPAND_PAGE));
        const open = xhtml.match(
          /<ac:structured-macro ac:name="ui-expand">[\s\S]*?<\/ac:structured-macro>/,
        )?.[0];
        expect(open).toContain('<ac:parameter ac:name="expanded">true</ac:parameter>');
        expect(open).toContain('<ac:parameter ac:name="title">Development Team</ac:parameter>');
        expect(open).toContain('Development Team');
      });

      it('emits no expanded parameter at all for a collapsed section', () => {
        // Confluence DC omits the parameter on collapsed sections rather than
        // spelling expanded=false; emitting one would fabricate a parameter the
        // page never had.
        const xhtml = htmlToConfluence(
          confluenceToHtml(
            '<ac:structured-macro ac:name="ui-expand"><ac:parameter ac:name="title">Closed</ac:parameter>' +
              '<ac:rich-text-body><p>body</p></ac:rich-text-body></ac:structured-macro>',
          ),
        );
        expect(xhtml).toContain('ac:name="ui-expand"');
        expect(xhtml).not.toContain('expanded');
      });

      it('never fabricates expanded on a native expand the editor left open', () => {
        // Atlassian's expand macro has no such parameter. The editor forces
        // every <details> open in edit mode and its summary click handler
        // writes the attribute, so `open` on a native section is reachable and
        // must stay inert on write-back.
        const xhtml = htmlToConfluence(
          '<details data-macro-name="expand" open><summary>T</summary><p>B</p></details>',
        );
        expect(xhtml).toContain('ac:name="expand"');
        expect(xhtml).not.toContain('expanded');
      });

      it('rebuilds expanded from open alone, ignoring a stale params copy', () => {
        const xhtml = htmlToConfluence(
          '<details data-macro-name="ui-expand" data-macro-params=\'{"expanded":"true"}\'>' +
            '<summary>T</summary><p>B</p></details>',
        );
        // The section is closed; the stale param must not resurrect it.
        expect(xhtml).toContain('ac:name="ui-expand"');
        expect(xhtml).not.toContain('expanded');
      });

      it('keeps a native expand and a ui-expand distinct across a full round-trip', () => {
        const xhtml = htmlToConfluence(confluenceToHtml(MIXED_EXPAND_PAGE));
        const native = xhtml.match(
          /<ac:structured-macro ac:name="expand">[\s\S]*?<\/ac:structured-macro>/,
        )?.[0];
        expect(native).toContain('Native');
        expect(native).toContain('<p>native body</p>');
        expect(native).not.toContain('expanded');
        const refined = xhtml.match(
          /<ac:structured-macro ac:name="ui-expand">[\s\S]*?<\/ac:structured-macro>/,
        )?.[0];
        expect(refined).toContain('Refined');
        expect(refined).toContain('<p>refined body</p>');
        expect(refined).toContain('<ac:parameter ac:name="expanded">true</ac:parameter>');
      });

      it("carries Refined's own classed body markup through the round-trip", () => {
        const xhtml = htmlToConfluence(confluenceToHtml(UI_EXPAND_PAGE));
        expect(xhtml).toContain('rw_adf_text_strong');
        expect(xhtml).toContain('ordered-list top_level');
        expect(xhtml).toContain('<li>Backend</li>');
      });

      it('still writes back a pre-#1129 stored placeholder for the same macro', () => {
        // body_html synced before this change holds the #865 unknown-macro
        // placeholder, not a <details>. There is no migration — the shape
        // changes on the next sync — so both must keep writing back to the same
        // macro, and the placeholder path keeps `expanded` as an ordinary
        // parameter (it has no `open` attribute to hold it).
        const stored =
          '<div class="confluence-macro-unknown" data-macro-name="ui-expand" ' +
          'data-macro-params=\'{"title":"Old","expanded":"true"}\'><p>body</p></div>';
        const xhtml = htmlToConfluence(stored);
        expect(xhtml).toContain('ac:name="ui-expand"');
        expect(xhtml).toContain('<ac:parameter ac:name="title">Old</ac:parameter>');
        expect(xhtml).toContain('<ac:parameter ac:name="expanded">true</ac:parameter>');
      });

      it('keeps its identity through the AI Improve round-trip (#1221)', async () => {
        // The ordering constraint from #1221, pinned: before that issue a
        // ui-expand mapped onto <details> moved from protected (the #865
        // unknown-macro freeze) to destroyed by the Markdown round-trip. Stage 1
        // fixed it with an opaque freeze, stage 2 with boundary tokens — the
        // property under test is the identity surviving, not the mechanism.
        const html = confluenceToHtml(UI_EXPAND_PAGE);
        const { html: prot, media } = protectMedia(html);
        const md = htmlToMarkdown(prot, { layoutTokens: true });
        const rebuilt = restoreMedia(
          await markdownToHtml(md, { layoutSkeleton: extractLayoutSkeleton(prot) }),
          media,
        );
        expect((rebuilt.match(/data-macro-name="ui-expand"/g) ?? []).length).toBe(2);
        expect(rebuilt).toContain('<summary>Development Team</summary>');
        expect(rebuilt).not.toContain('data-macro-name="expand"');
      });
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

    it('converts section/column to markdown with boundary tokens when layoutTokens is set (#765)', () => {
      const html = confluenceToHtml(SECTION_COLUMN_PAGE);
      const md = htmlToMarkdown(html, { layoutTokens: true });
      expect(md).toContain('Left column content');
      expect(md).toContain('Right column content');
      expect(md).not.toMatch(/<div[^>]*>/);
      expect(md).not.toContain('confluence-section');
      expect(md).not.toContain('confluence-column');
      // #765: wrappers are no longer dropped — boundary tokens carry them.
      expect(md).toContain('[[[SECTION]]]');
      expect(md).toContain('[[[COLUMN width=30%]]]');
      expect(md).toContain('[[[COLUMN width=70%]]]');
      expect(md).toContain('[[[/COLUMN]]]');
      expect(md).toContain('[[[/SECTION]]]');
    });

    it('converts modern layout divs to markdown with boundary tokens when layoutTokens is set (#765)', () => {
      const html = confluenceToHtml(LAYOUT_TWO_EQUAL_PAGE);
      const md = htmlToMarkdown(html, { layoutTokens: true });
      expect(md).toContain('[[[LAYOUT]]]');
      expect(md).toContain('[[[LAYOUT-SECTION two_equal]]]');
      expect(md).toContain('[[[LAYOUT-CELL]]]');
      expect(md).toContain('[[[/LAYOUT-CELL]]]');
      expect(md).toContain('[[[/LAYOUT-SECTION]]]');
      expect(md).toContain('[[[/LAYOUT]]]');
      expect(md).toContain('Left column content');
      expect(md).toContain('Right column content');
      expect(md).not.toMatch(/<div[^>]*>/);
    });

    it('does NOT emit boundary tokens by default — non-Improve flows keep the flattened output (#765 review)', () => {
      // Default call shape used by quality-worker, auto-tagger, llm-diagram,
      // version-tracker, subpage-context, and pages-import: no options.
      const layoutMd = htmlToMarkdown(confluenceToHtml(LAYOUT_TWO_EQUAL_PAGE));
      expect(layoutMd).not.toContain('[[[');
      expect(layoutMd).toContain('Left column content');
      expect(layoutMd).toContain('Right column content');
      expect(layoutMd).not.toMatch(/<div[^>]*>/);

      const sectionMd = htmlToMarkdown(confluenceToHtml(SECTION_COLUMN_PAGE));
      expect(sectionMd).not.toContain('[[[');
      expect(sectionMd).toContain('Left column content');
      expect(sectionMd).toContain('Right column content');
      expect(sectionMd).not.toMatch(/<div[^>]*>/);
      expect(sectionMd).not.toContain('confluence-section');
      expect(sectionMd).not.toContain('confluence-column');
    });

    it('does NOT emit boundary tokens when layoutTokens is explicitly false (#765 review)', () => {
      const md = htmlToMarkdown(confluenceToHtml(LAYOUT_TWO_EQUAL_PAGE), { layoutTokens: false });
      expect(md).not.toContain('[[[');
      expect(md).toContain('Left column content');
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

    it('unknown macros now round-trip back to ac:structured-macro (#865)', () => {
      // The `widget-connector` fixture falls through to the unknown-macro
      // wrapper on the forward pass, but must be rebuilt into its original
      // ac:structured-macro on write-back — dropping it here would permanently
      // delete the macro from the Confluence page (same hazard as #765 labels).
      const html = confluenceToHtml(UNKNOWN_MACRO_PAGE);
      expect(html).toContain('confluence-macro-unknown');

      const xhtml = htmlToConfluence(html);
      expect(xhtml).toContain('ac:name="widget-connector"');
      expect(xhtml).toContain('<ac:rich-text-body>');
      expect(xhtml).toContain('Embedded widget');
      // The macro's parameters round-trip too (persisted as data-macro-params).
      expect(xhtml).toContain('ac:name="url"');
      expect(xhtml).toContain('https://widget.example.com');
      // The lossy placeholder wrapper must be gone from the storage output.
      expect(xhtml).not.toContain('confluence-macro-unknown');
      expect(xhtml).not.toContain('data-macro-name');
    });

    it('excerpt macro round-trips instead of being destroyed on write-back (#865)', () => {
      // The exact scenario from #865: a synced page with an excerpt macro,
      // edited and saved from Compendiq, must NOT lose the excerpt macro.
      const source =
        '<ac:structured-macro ac:name="excerpt"><ac:rich-text-body><p>Team charter</p></ac:rich-text-body></ac:structured-macro>';
      const html = confluenceToHtml(source);
      const xhtml = htmlToConfluence(html);
      expect(xhtml).toContain('ac:name="excerpt"');
      expect(xhtml).toContain('<ac:rich-text-body>');
      expect(xhtml).toContain('Team charter');
      expect(xhtml).not.toContain('confluence-macro-unknown');
    });

    it('body-less unknown macro round-trips without leaking the placeholder text (#865)', () => {
      // A macro with no rich-text-body (e.g. anchor) is rendered as the
      // `[Confluence macro: name]` placeholder on the forward pass. On
      // write-back it must become a body-less macro, NOT a macro whose body
      // contains the literal placeholder string.
      const source =
        '<ac:structured-macro ac:name="anchor"><ac:parameter ac:name="name">top</ac:parameter></ac:structured-macro>';
      const html = confluenceToHtml(source);
      expect(html).toContain('[Confluence macro: anchor]');

      const xhtml = htmlToConfluence(html);
      expect(xhtml).toContain('ac:name="anchor"');
      expect(xhtml).toContain('ac:name="name"');
      expect(xhtml).toContain('top');
      expect(xhtml).not.toContain('[Confluence macro:');
      expect(xhtml).not.toContain('confluence-macro-unknown');
    });

    it('editor-wrapped body-less unknown macro does not push the placeholder text upstream (#865)', () => {
      // The TipTap editor serializes a body-less unknown macro's placeholder
      // as a single wrapped block: <p>[Confluence macro: anchor]</p>. The
      // reverse handler must still treat it as body-less — otherwise the
      // fabricated `[Confluence macro: anchor]` string gets written back into
      // Confluence as a real rich-text-body.
      const editorHtml =
        '<div class="confluence-macro-unknown" data-macro-name="anchor"><p>[Confluence macro: anchor]</p></div>';
      const xhtml = htmlToConfluence(editorHtml);
      expect(xhtml).toContain('ac:name="anchor"');
      // The fabricated placeholder must never leak upstream into Confluence.
      expect(xhtml).not.toContain('[Confluence macro:');
      // Body-less: no rich-text-body wrapping the placeholder.
      expect(xhtml).not.toContain('<ac:rich-text-body>');
      expect(xhtml).not.toContain('confluence-macro-unknown');
    });

    it('editor-wrapped unknown macro with a REAL body still round-trips to a rich-text-body (#865)', () => {
      // A genuine body (not the fabricated placeholder) must survive as an
      // ac:rich-text-body — the placeholder heuristic must not swallow it.
      const editorHtml =
        '<div class="confluence-macro-unknown" data-macro-name="x"><p>real content</p></div>';
      const xhtml = htmlToConfluence(editorHtml);
      expect(xhtml).toContain('ac:name="x"');
      expect(xhtml).toContain('<ac:rich-text-body>');
      expect(xhtml).toContain('real content');
      expect(xhtml).not.toContain('confluence-macro-unknown');
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

// ==========================================================================
// #1222 — a macro's parameters are its DIRECT ac:parameter children
// ==========================================================================
//
// getParamValue used to search all descendants, so a body-carrying macro read
// the first matching parameter anywhere in its subtree — a nested macro's. The
// forward pass then rendered that value, and write-back persisted it as the
// outer macro's own parameter on the user's Confluence page. Three thefts were
// verified on dev: expand→title (including cross-type, from a nested status
// badge), section→border and column→width.
describe('content-converter: #1222 direct-child parameter resolution', () => {
  it('does not give an untitled expand a nested expand\'s title', () => {
    const storage =
      '<ac:structured-macro ac:name="expand"><ac:rich-text-body>' +
      '<p>before</p>' +
      '<ac:structured-macro ac:name="expand"><ac:parameter ac:name="title">Inner</ac:parameter>' +
      '<ac:rich-text-body><p>deep</p></ac:rich-text-body></ac:structured-macro>' +
      '</ac:rich-text-body></ac:structured-macro>';
    const summaries = [...confluenceToHtml(storage).matchAll(/<summary>[^<]*<\/summary>/g)].map(
      (m) => m[0],
    );
    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toBe('<summary>Click to expand</summary>');
    expect(summaries[1]).toBe('<summary>Inner</summary>');
  });

  it('write-back does not persist the stolen title onto the outer macro', () => {
    // The outer section still round-trips with the placeholder summary as its
    // title parameter — the forward pass always emits a <summary> and the
    // reverse pass always turns one into a `title`. That half is #1227 and is
    // deliberately untouched here. What must not survive is the *inner*
    // macro's real string being written onto a page that never had it.
    const storage =
      '<ac:structured-macro ac:name="expand"><ac:rich-text-body>' +
      '<ac:structured-macro ac:name="expand"><ac:parameter ac:name="title">Inner</ac:parameter>' +
      '<ac:rich-text-body><p>deep</p></ac:rich-text-body></ac:structured-macro>' +
      '</ac:rich-text-body></ac:structured-macro>';
    const xhtml = htmlToConfluence(confluenceToHtml(storage));
    expect(
      xhtml.match(/<ac:parameter ac:name="title">Inner<\/ac:parameter>/g),
    ).toHaveLength(1);
    expect(xhtml.match(/ac:name="expand"/g)).toHaveLength(2);
  });

  it('does not give an untitled expand a nested status badge\'s title', () => {
    // Cross-type theft: `status` is processed after `expand`, so its title is
    // still an ac:parameter in the subtree when the expand branch looks.
    const storage =
      '<ac:structured-macro ac:name="expand"><ac:rich-text-body><p>' +
      '<ac:structured-macro ac:name="status"><ac:parameter ac:name="colour">Green</ac:parameter>' +
      '<ac:parameter ac:name="title">DONE</ac:parameter></ac:structured-macro>' +
      '</p></ac:rich-text-body></ac:structured-macro>';
    const html = confluenceToHtml(storage);
    expect(html).toContain('<summary>Click to expand</summary>');
    expect(html).not.toContain('<summary>DONE</summary>');

    const xhtml = htmlToConfluence(html);
    // Exactly one DONE title parameter, and it belongs to the status macro.
    expect(xhtml.match(/<ac:parameter ac:name="title">DONE<\/ac:parameter>/g)).toHaveLength(1);
    const status = xhtml.match(
      /<ac:structured-macro ac:name="status">[\s\S]*?<\/ac:structured-macro>/,
    )?.[0];
    expect(status).toContain('<ac:parameter ac:name="title">DONE</ac:parameter>');
  });

  it('does not let a section inherit a nested macro\'s border', () => {
    // The donor is a third-party macro: an unknown macro's parameter names are
    // arbitrary (#865 persists them generically), and its handler runs after
    // the section loop, so its parameters are still ac:parameter elements in
    // the subtree when the section branch looks for `border`.
    const storage =
      '<ac:structured-macro ac:name="section"><ac:rich-text-body>' +
      '<ac:structured-macro ac:name="bordered-widget"><ac:parameter ac:name="border">true</ac:parameter>' +
      '<ac:rich-text-body><p>widget</p></ac:rich-text-body></ac:structured-macro>' +
      '</ac:rich-text-body></ac:structured-macro>';
    const html = confluenceToHtml(storage);
    expect(html.match(/<div class="confluence-section"[^>]*>/)?.[0]).toBe(
      '<div class="confluence-section">',
    );
    // …and the donor still carries the parameter it was never asked to share.
    expect(html).toContain('data-macro-name="bordered-widget"');
    expect(html).toMatch(/data-macro-params="[^"]*border/);
  });

  it('does not let a column inherit a nested macro\'s width', () => {
    const storage =
      '<ac:structured-macro ac:name="section"><ac:rich-text-body>' +
      '<ac:structured-macro ac:name="column"><ac:rich-text-body>' +
      '<ac:structured-macro ac:name="chart"><ac:parameter ac:name="width">400px</ac:parameter>' +
      '<ac:rich-text-body><p>chart body</p></ac:rich-text-body></ac:structured-macro>' +
      '</ac:rich-text-body></ac:structured-macro>' +
      '</ac:rich-text-body></ac:structured-macro>';
    const html = confluenceToHtml(storage);
    const column = html.match(/<div class="confluence-column"[^>]*>/)?.[0];
    expect(column).toBe('<div class="confluence-column">');
    // The stolen width was also written into an inline style.
    expect(html).not.toContain('flex: 0 0 400px');
  });

  it('resolves an expand\'s own title when its parameter follows the body', () => {
    // Storage XHTML is API-writable, so parameter-after-body is reachable even
    // though Confluence's own serializer emits parameters first. Descendant
    // search returned the first match in document order, which here is the
    // nested macro's — turning fabrication into overwrite of a real title.
    const storage =
      '<ac:structured-macro ac:name="expand"><ac:rich-text-body>' +
      '<ac:structured-macro ac:name="expand"><ac:parameter ac:name="title">Inner</ac:parameter>' +
      '<ac:rich-text-body><p>deep</p></ac:rich-text-body></ac:structured-macro>' +
      '</ac:rich-text-body><ac:parameter ac:name="title">Outer</ac:parameter></ac:structured-macro>';
    const summaries = [...confluenceToHtml(storage).matchAll(/<summary>[^<]*<\/summary>/g)].map(
      (m) => m[0],
    );
    expect(summaries[0]).toBe('<summary>Outer</summary>');
    expect(summaries[1]).toBe('<summary>Inner</summary>');
  });

  // A parameter is a direct child by storage-format schema — but the pipeline
  // parses storage XHTML with an HTML parser, where `<ac:parameter …/>` does
  // NOT self-close. Every following sibling parameter nests inside it and
  // becomes a grandchild, so "direct child by schema" only holds in the parsed
  // DOM because the tag is pre-expanded (SELF_CLOSING_XHTML_TAGS). Reachable
  // the same way parameter-after-body above is: storage XHTML is API-writable,
  // and an XML serializer in a third-party app normalises an empty element to
  // self-closing form.
  describe('self-closing ac:parameter', () => {
    it('keeps reading a status macro\'s colour and title past a self-closed parameter', () => {
      const storage =
        '<ac:structured-macro ac:name="status"><ac:parameter ac:name="subtle"/>' +
        '<ac:parameter ac:name="colour">Green</ac:parameter>' +
        '<ac:parameter ac:name="title">DONE</ac:parameter></ac:structured-macro>';
      const html = confluenceToHtml(storage);
      expect(html).toContain('data-color="green"');
      expect(html).toContain('>DONE<');
      // Write-back must not persist a defaulted colour and an emptied title.
      const xhtml = htmlToConfluence(html);
      expect(xhtml).toContain('<ac:parameter ac:name="colour">Green</ac:parameter>');
      expect(xhtml).toContain('<ac:parameter ac:name="title">DONE</ac:parameter>');
    });

    it('keeps an expand\'s own title past a self-closed parameter, and recovers that parameter', () => {
      const storage =
        '<ac:structured-macro ac:name="expand"><ac:parameter ac:name="breakout-mode"/>' +
        '<ac:parameter ac:name="title">Real Title</ac:parameter>' +
        '<ac:rich-text-body><p>body</p></ac:rich-text-body></ac:structured-macro>';
      const html = confluenceToHtml(storage);
      expect(html).toContain('<summary>Real Title</summary>');
      // The self-closed parameter is a real parameter of this macro too — once
      // it closes, the #865 net can carry it through the round-trip.
      expect(html).toMatch(/data-macro-params="[^"]*breakout-mode/);
    });

    it('keeps a column\'s width past a self-closed parameter', () => {
      const storage =
        '<ac:structured-macro ac:name="column"><ac:parameter ac:name="subtle"/>' +
        '<ac:parameter ac:name="width">30%</ac:parameter>' +
        '<ac:rich-text-body><p>c</p></ac:rich-text-body></ac:structured-macro>';
      const html = confluenceToHtml(storage);
      expect(html).toContain('data-cell-width="30%"');
      expect(html).toContain('style="flex: 0 0 30%"');
    });

    it('does not let a self-closed title parameter swallow the body as its title', () => {
      // Pre-existing on dev, not introduced by the direct-child lookup: the
      // unclosed parameter absorbs ac:rich-text-body, so textContent returned
      // the body's prose and the section was titled with its own first words.
      const storage =
        '<ac:structured-macro ac:name="expand"><ac:parameter ac:name="title"/>' +
        '<ac:rich-text-body><p>body text</p></ac:rich-text-body></ac:structured-macro>';
      const html = confluenceToHtml(storage);
      expect(html).not.toContain('<summary>body text</summary>');
      expect(html).toContain('<p>body text</p>');
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

// ==========================================================================
// #765 — layout / section / column preservation through the AI Improve
// markdown round-trip, exercised over the FULL Improve path:
//   protectMedia → htmlToMarkdown → (LLM edit) → markdownToHtml →
//   restoreMedia → htmlToConfluence
// ==========================================================================

describe('content-converter: #765 layout preservation through AI Improve round-trip', () => {
  /** Run the full Improve pipeline, optionally editing the markdown like an LLM would. */
  async function improveRoundTrip(
    storageXhtml: string,
    editMarkdown: (md: string) => string = (md) => md,
  ): Promise<{ md: string; html: string; xhtml: string }> {
    const bodyHtml = confluenceToHtml(storageXhtml);
    const { html: protectedHtml, media } = protectMedia(bodyHtml);
    // layoutTokens: true mirrors the Improve route's main-page conversion.
    const md = editMarkdown(htmlToMarkdown(protectedHtml, { layoutTokens: true }));
    const html = restoreMedia(await markdownToHtml(md), media);
    return { md, html, xhtml: htmlToConfluence(html) };
  }

  it('preserves a two-column (two_equal) layout end to end', async () => {
    const { html, xhtml } = await improveRoundTrip(LAYOUT_TWO_EQUAL_PAGE);
    expect(html).toContain('class="confluence-layout"');
    expect(html).toContain('data-layout-type="two_equal"');
    expect((html.match(/class="confluence-layout-cell"/g) ?? []).length).toBe(2);
    expect(xhtml).toContain('<ac:layout>');
    expect(xhtml).toContain('ac:type="two_equal"');
    expect((xhtml.match(/<ac:layout-cell>/g) ?? []).length).toBe(2);
    expect(xhtml).toContain('Left column content');
    expect(xhtml).toContain('Right column content');
    expect(xhtml).not.toContain('[[[');
  });

  it('preserves a three-column (three_equal) layout end to end', async () => {
    const { xhtml } = await improveRoundTrip(LAYOUT_THREE_EQUAL_PAGE);
    expect(xhtml).toContain('ac:type="three_equal"');
    expect((xhtml.match(/<ac:layout-cell>/g) ?? []).length).toBe(3);
    expect(xhtml).toContain('Column one');
    expect(xhtml).toContain('Column two');
    expect(xhtml).toContain('Column three');
  });

  it('preserves stacked layout sections with distinct types', async () => {
    const { xhtml } = await improveRoundTrip(LAYOUT_STACKED_SECTIONS_PAGE);
    expect(xhtml).toContain('ac:type="single"');
    expect(xhtml).toContain('ac:type="two_equal"');
    expect(xhtml).toContain('ac:type="three_equal"');
    expect((xhtml.match(/<ac:layout>/g) ?? []).length).toBe(1);
    expect(xhtml).toContain('Welcome to the guide.');
    expect(xhtml).toContain('Feature C');
  });

  it('preserves legacy section/column with border and width parameters', async () => {
    const { xhtml } = await improveRoundTrip(SECTION_BORDER_PAGE);
    expect(xhtml).toContain('ac:name="section"');
    expect(xhtml).toContain('<ac:parameter ac:name="border">true</ac:parameter>');
    expect((xhtml.match(/ac:name="column"/g) ?? []).length).toBe(2);
    expect(xhtml).toContain('Column A');
    expect(xhtml).toContain('Column B');

    const widths = await improveRoundTrip(SECTION_COLUMN_PAGE);
    expect(widths.xhtml).toContain('<ac:parameter ac:name="width">30%</ac:parameter>');
    expect(widths.xhtml).toContain('<ac:parameter ac:name="width">70%</ac:parameter>');
  });

  it('keeps prose inside cells editable — an LLM-style text edit survives with the layout', async () => {
    const { md, xhtml } = await improveRoundTrip(LAYOUT_TWO_EQUAL_PAGE, (markdown) =>
      markdown.replace('Left column content', 'Left column content, now much clearer.'),
    );
    // The prose was exposed as plain markdown (NOT hidden in an opaque token).
    expect(md).toContain('Left column content');
    expect(xhtml).toContain('Left column content, now much clearer.');
    expect(xhtml).toContain('ac:type="two_equal"');
    expect((xhtml.match(/<ac:layout-cell>/g) ?? []).length).toBe(2);
  });

  it('preserves rich nested content (lists, code, tables) inside layout cells', async () => {
    const { xhtml } = await improveRoundTrip(LAYOUT_NESTED_CONTENT_PAGE);
    expect(xhtml).toContain('<ac:layout>');
    expect(xhtml).toContain('ac:type="two_equal"');
    expect(xhtml).toContain('ac:name="code"');
    expect(xhtml).toContain('echo "hello"');
    expect(xhtml).toContain('<li>Item 1</li>');
    expect(xhtml).toContain('<td>Name</td>');
    // Panels are still lossy through the markdown boundary (blockquote form —
    // pre-existing, unrelated to #765) but their text stays inside the cell.
    expect(xhtml).toContain('Important note');
  });

  it('protects media inside layout cells via tokens and restores it in place', async () => {
    const storage = `<ac:layout><ac:layout-section ac:type="two_equal"><ac:layout-cell><p>Intro</p><ac:image><ri:attachment ri:filename="photo.png"></ri:attachment></ac:image></ac:layout-cell><ac:layout-cell><p>Other</p></ac:layout-cell></ac:layout-section></ac:layout>`;
    const bodyHtml = confluenceToHtml(storage, '42');
    const { html: protectedHtml, media } = protectMedia(bodyHtml);
    expect(media).toHaveLength(1);
    const md = htmlToMarkdown(protectedHtml, { layoutTokens: true });
    // The media token sits INSIDE the cell boundary tokens.
    expect(md.indexOf('[[[LAYOUT-CELL]]]')).toBeLessThan(md.indexOf('CQ\\_MEDIA\\_PLACEHOLDER\\_0'));
    const html = restoreMedia(await markdownToHtml(md), media);
    const xhtml = htmlToConfluence(html);
    expect(xhtml).toContain('ri:filename="photo.png"');
    // Image is still inside the first layout cell.
    const firstCell = xhtml.slice(xhtml.indexOf('<ac:layout-cell>'), xhtml.indexOf('</ac:layout-cell>'));
    expect(firstCell).toContain('ri:filename="photo.png"');
  });

  describe('drop-guard', () => {
    it('flattens gracefully when the LLM drops a closing token (unbalanced)', async () => {
      const bodyHtml = confluenceToHtml(LAYOUT_TWO_EQUAL_PAGE);
      const md = htmlToMarkdown(bodyHtml, { layoutTokens: true }).replace('[[[/LAYOUT-CELL]]]', '');
      const html = await markdownToHtml(md);
      expect(html).not.toContain('[[[');
      expect(html).not.toContain('confluence-layout');
      expect(html).toContain('Left column content');
      expect(html).toContain('Right column content');
      // The flattened HTML still converts to valid (layout-free) storage.
      const xhtml = htmlToConfluence(html);
      expect(xhtml).not.toContain('ac:layout');
      expect(xhtml).not.toContain('[[[');
    });

    it('flattens gracefully when the LLM reorders tokens into invalid nesting', async () => {
      // LAYOUT-CELL outside any LAYOUT-SECTION — balanced but invalid.
      const md = '[[[LAYOUT-CELL]]]\n\nOrphan prose\n\n[[[/LAYOUT-CELL]]]';
      const html = await markdownToHtml(md);
      expect(html).not.toContain('[[[');
      expect(html).not.toContain('confluence-layout');
      expect(html).toContain('Orphan prose');
    });

    it('rebuilds even when the LLM merges token lines without blank lines', async () => {
      const md =
        '[[[LAYOUT]]]\n[[[LAYOUT-SECTION two_equal]]]\n[[[LAYOUT-CELL]]]\nLeft prose\n[[[/LAYOUT-CELL]]]\n[[[LAYOUT-CELL]]]\nRight prose\n[[[/LAYOUT-CELL]]]\n[[[/LAYOUT-SECTION]]]\n[[[/LAYOUT]]]';
      const html = await markdownToHtml(md);
      expect(html).toContain('data-layout-type="two_equal"');
      expect((html.match(/class="confluence-layout-cell"/g) ?? []).length).toBe(2);
      expect(html).toContain('Left prose');
      expect(html).not.toContain('[[[');
    });

    it('strips case-mangled token remnants instead of leaking them into the page', async () => {
      const md = '[[[layout]]]\n\n[[[layout-section two_equal]]]\n\nProse survives\n\n[[[/layout-section]]]\n\n[[[/layout]]]';
      const html = await markdownToHtml(md);
      expect(html).not.toContain('[[[');
      expect(html).not.toContain('confluence-layout');
      expect(html).toContain('Prose survives');
    });

    it('leaves ordinary bracketed prose untouched', async () => {
      const md = 'See [the docs](https://example.com) and \\[citation\\] plus [[wiki-style]] links.';
      const html = await markdownToHtml(md);
      expect(html).toContain('the docs');
      expect(html).toContain('[citation]');
      expect(html).toContain('[[wiki-style]]');
    });

    it('falls back to single for an invalid layout-section type', async () => {
      const md = '[[[LAYOUT]]]\n\n[[[LAYOUT-SECTION <script>alert(1)</script>]]]\n\n[[[LAYOUT-CELL]]]\n\nX\n\n[[[/LAYOUT-CELL]]]\n\n[[[/LAYOUT-SECTION]]]\n\n[[[/LAYOUT]]]';
      const html = await markdownToHtml(md);
      // Injected attrs never reach the output; type falls back to single.
      expect(html).not.toContain('script');
      expect(html).toContain('data-layout-type="single"');
    });
  });

  describe('labels macro (#765 triage fix)', () => {
    const LABELS_PAGE = `<p>Before</p><ac:structured-macro ac:name="labels" ac:schema-version="1"><ac:parameter ac:name="showLabels">true</ac:parameter></ac:structured-macro><p>After</p>`;

    it('round-trips the in-body labels macro at the Confluence⇄HTML boundary', () => {
      const html = confluenceToHtml(LABELS_PAGE);
      expect(html).toContain('class="confluence-labels-macro"');
      const xhtml = htmlToConfluence(html);
      expect(xhtml).toContain('ac:name="labels"');
      expect(xhtml).toContain('<ac:parameter ac:name="showLabels">true</ac:parameter>');
      expect(xhtml).not.toContain('confluence-labels-macro');
    });

    it('survives the full Improve path via opaque media protection', async () => {
      const { md, xhtml } = await improveRoundTrip(LABELS_PAGE);
      // Atomic placeholder — protected as an opaque token, not boundary tokens.
      expect(md).toContain('CQ\\_MEDIA\\_PLACEHOLDER\\_0');
      expect(xhtml).toContain('ac:name="labels"');
      expect(xhtml).toContain('Before');
      expect(xhtml).toContain('After');
    });
  });

  // #765 review follow-up: legacy section/column wrappers nested inside
  // markdown-constrained containers must be opaque-frozen (pre-#765
  // behavior), never boundary-tokenized — token normalization would rip the
  // token line out of the construct (e.g. split a GFM table row).
  describe('legacy section/column nested in constrained containers (#765 review)', () => {
    const SECTION_MACRO =
      '<ac:structured-macro ac:name="section"><ac:rich-text-body>' +
      '<ac:structured-macro ac:name="column"><ac:rich-text-body><p>Nested cell prose</p></ac:rich-text-body></ac:structured-macro>' +
      '</ac:rich-text-body></ac:structured-macro>';

    it('protectMedia freezes a nested section but not a top-level one', () => {
      const html = confluenceToHtml(
        `<table><tbody><tr><th>H1</th><th>H2</th></tr><tr><td>${SECTION_MACRO}</td><td><p>other</p></td></tr></tbody></table>${SECTION_MACRO}`,
      );
      const { html: protectedHtml, media } = protectMedia(html);
      // Only the in-table section is frozen (whole, including its column).
      expect(media).toHaveLength(1);
      expect(media[0]!.html).toContain('class="confluence-section"');
      expect(media[0]!.html).toContain('Nested cell prose');
      // The top-level section stays in the DOM for boundary tokens.
      expect(protectedHtml).toContain('class="confluence-section"');
    });

    it('a legacy section inside a table cell round-trips without corrupting the table', async () => {
      // Note: plain-text sibling cell — turndown's GFM rule cannot flatten
      // block content (<p>) inside cells, a pre-existing quirk unrelated to
      // the frozen wrapper under test here.
      const storage = `<table><tbody><tr><th>H1</th><th>H2</th></tr><tr><td>${SECTION_MACRO}</td><td>other</td></tr></tbody></table>`;
      const { md, html, xhtml } = await improveRoundTrip(storage);

      // The wrapper traveled as an opaque token, not boundary tokens.
      expect(md).toContain('CQ\\_MEDIA\\_PLACEHOLDER\\_0');
      expect(md).not.toContain('[[[');

      // Table is intact: two rows, no cells leaked as literal `| … |` text.
      expect((html.match(/<tr>/g) ?? []).length).toBe(2);
      expect((html.match(/<td>/g) ?? []).length).toBe(2);
      expect(html).not.toMatch(/<p>[^<]*\|/);

      // Section macro restored inside the cell, no token leakage.
      expect(xhtml).toContain('ac:name="section"');
      expect(xhtml).toContain('ac:name="column"');
      expect(xhtml).toContain('Nested cell prose');
      expect(xhtml).toContain('other');
      expect(xhtml).not.toContain('[[[');
      const td = xhtml.slice(xhtml.indexOf('<td>'), xhtml.indexOf('</td>'));
      expect(td).toContain('ac:name="section"');
    });

    it('a legacy section inside a list item round-trips without corrupting the list', async () => {
      const storage = `<ul><li><p>Item with layout</p>${SECTION_MACRO}</li><li><p>Plain item</p></li></ul>`;
      const { md, html, xhtml } = await improveRoundTrip(storage);

      expect(md).toContain('CQ\\_MEDIA\\_PLACEHOLDER\\_0');
      expect(md).not.toContain('[[[');

      // Both list items survive; the section stays inside the first.
      expect((html.match(/<li>/g) ?? []).length).toBe(2);
      expect(xhtml).toContain('ac:name="section"');
      expect(xhtml).toContain('Nested cell prose');
      expect(xhtml).toContain('Plain item');
      expect(xhtml).not.toContain('[[[');
    });

    it('a legacy section inside a panel is frozen, not tokenized — survives verbatim', async () => {
      const storage = `<ac:structured-macro ac:name="info"><ac:rich-text-body><p>Panel intro</p>${SECTION_MACRO}</ac:rich-text-body></ac:structured-macro>`;
      const { md, xhtml } = await improveRoundTrip(storage);

      expect(md).toContain('CQ\\_MEDIA\\_PLACEHOLDER\\_0');
      expect(md).not.toContain('[[[');

      // (Panels degrade to blockquotes through markdown — pre-existing, and
      // the frozen section may land after the quote, exactly like pre-#765.)
      // What matters: the section is never flattened and tokens never leak.
      expect(xhtml).toContain('ac:name="section"');
      expect(xhtml).toContain('Nested cell prose');
      expect(xhtml).toContain('Panel intro');
      expect(xhtml).not.toContain('[[[');
    });
  });

  // #765 review follow-up: literal token text inside <pre>/<code> is data —
  // never rebuilt into layout divs, never stripped by the backstop.
  describe('literal token text inside code blocks (#765 review)', () => {
    it('a fenced code block containing [[[LAYOUT]]] literal text survives markdownToHtml unchanged', async () => {
      const md = 'Token docs:\n\n```\n[[[LAYOUT]]]\nliteral token text\n[[[/LAYOUT]]]\n```\n';
      const html = await markdownToHtml(md);
      expect(html).toContain('[[[LAYOUT]]]');
      expect(html).toContain('[[[/LAYOUT]]]');
      expect(html).toContain('literal token text');
      expect(html).not.toContain('confluence-layout');
      expect(html).toMatch(/<pre><code>\[\[\[LAYOUT\]\]\]\nliteral token text\n\[\[\[\/LAYOUT\]\]\]/);
    });

    it('inline code containing a token literal survives markdownToHtml unchanged', async () => {
      const md = 'Use `[[[LAYOUT]]]` to open a layout.';
      const html = await markdownToHtml(md);
      expect(html).toContain('<code>[[[LAYOUT]]]</code>');
      expect(html).not.toContain('confluence-layout');
    });

    it('a stray token inside a code block does not poison validation of real tokens', async () => {
      const md = [
        '[[[LAYOUT]]]', '',
        '[[[LAYOUT-SECTION two_equal]]]', '',
        '[[[LAYOUT-CELL]]]', '',
        'Cell prose with docs:', '',
        '```',
        '[[[LAYOUT-CELL]]]', // unbalanced INSIDE code — must be ignored
        '```', '',
        '[[[/LAYOUT-CELL]]]', '',
        '[[[LAYOUT-CELL]]]', '',
        'Second cell', '',
        '[[[/LAYOUT-CELL]]]', '',
        '[[[/LAYOUT-SECTION]]]', '',
        '[[[/LAYOUT]]]',
      ].join('\n');
      const html = await markdownToHtml(md);
      // Real tokens rebuilt…
      expect(html).toContain('data-layout-type="two_equal"');
      expect((html.match(/class="confluence-layout-cell"/g) ?? []).length).toBe(2);
      // …while the code literal is untouched.
      expect(html).toMatch(/<code>\[\[\[LAYOUT-CELL\]\]\]/);
    });

    it('a code macro containing token literals survives the full Improve round-trip', async () => {
      const storage =
        '<p>Docs page</p><ac:structured-macro ac:name="code"><ac:plain-text-body>' +
        '<![CDATA[[[[LAYOUT]]] opens a layout]]></ac:plain-text-body></ac:structured-macro>';
      const { xhtml } = await improveRoundTrip(storage);
      expect(xhtml).toContain('ac:name="code"');
      expect(xhtml).toContain('[[[LAYOUT]]] opens a layout');
    });
  });
});

// ==========================================================================
// #781 — skeleton-guided recovery of LLM-mangled layout tokens.
//
// #774's all-or-nothing drop-guard silently flattened the layout whenever a
// real model mangled a single token. The system KNOWS the expected token
// skeleton (derived from the page's own body HTML), so markdownToHtml can
// align whatever came back against it and rebuild the layout from the
// ORIGINAL skeleton — and when alignment is impossible it throws
// LayoutRecoveryError instead of silently flattening.
// ==========================================================================

describe('content-converter: #781 layout-token resilience', () => {
  /** body HTML → expected skeleton + the markdown the Improve route would send. */
  function prepare(storageXhtml: string): {
    skeleton: ReturnType<typeof extractLayoutSkeleton>;
    md: string;
    media: ReturnType<typeof protectMedia>['media'];
  } {
    const bodyHtml = confluenceToHtml(storageXhtml);
    const { html: protectedHtml, media } = protectMedia(bodyHtml);
    return {
      skeleton: extractLayoutSkeleton(protectedHtml),
      md: htmlToMarkdown(protectedHtml, { layoutTokens: true }),
      media,
    };
  }

  // ------------------------------------------------------------------
  // Layout-type coverage: sidebar/fixed layouts through the Improve path
  // ------------------------------------------------------------------
  describe('sidebar layout coverage through the Improve round-trip', () => {
    async function improveRoundTrip(storageXhtml: string): Promise<string> {
      const { skeleton, md, media } = prepare(storageXhtml);
      const html = restoreMedia(await markdownToHtml(md, { layoutSkeleton: skeleton }), media);
      return htmlToConfluence(html);
    }

    it('preserves a two_left_sidebar layout end to end', async () => {
      const xhtml = await improveRoundTrip(LAYOUT_LEFT_SIDEBAR_PAGE);
      expect(xhtml).toContain('ac:type="two_left_sidebar"');
      expect((xhtml.match(/<ac:layout-cell>/g) ?? []).length).toBe(2);
      expect(xhtml).toContain('Sidebar navigation');
      expect(xhtml).toContain('Main content area');
    });

    it('preserves a two_right_sidebar layout end to end', async () => {
      const xhtml = await improveRoundTrip(LAYOUT_RIGHT_SIDEBAR_PAGE);
      expect(xhtml).toContain('ac:type="two_right_sidebar"');
      expect((xhtml.match(/<ac:layout-cell>/g) ?? []).length).toBe(2);
      expect(xhtml).toContain('Sidebar widgets');
    });

    it('preserves a three_with_sidebars layout stacked between single sections (official docs shape)', async () => {
      const xhtml = await improveRoundTrip(LAYOUT_THREE_WITH_SIDEBARS_PAGE);
      expect(xhtml).toContain('ac:type="three_with_sidebars"');
      expect((xhtml.match(/ac:type="single"/g) ?? []).length).toBe(2);
      expect((xhtml.match(/<ac:layout-cell>/g) ?? []).length).toBe(5);
      expect(xhtml).toContain('Left sidebar nav');
      expect(xhtml).toContain('Wide middle content');
      expect(xhtml).toContain('Right sidebar widgets');
      expect(xhtml).toContain('Footer text.');
    });

    it('tolerates extra/unknown attributes a real DC may emit on ac:layout*', async () => {
      const html = confluenceToHtml(LAYOUT_DC_EXTRA_ATTRS_PAGE);
      expect(html).toContain('data-layout-type="two_left_sidebar"');
      expect((html.match(/class="confluence-layout-cell"/g) ?? []).length).toBe(2);
      const xhtml = await improveRoundTrip(LAYOUT_DC_EXTRA_ATTRS_PAGE);
      expect(xhtml).toContain('ac:type="two_left_sidebar"');
      expect(xhtml).toContain('Sidebar cell');
      expect(xhtml).toContain('Main cell');
    });
  });

  // ------------------------------------------------------------------
  // extractLayoutSkeleton
  // ------------------------------------------------------------------
  describe('extractLayoutSkeleton', () => {
    it('extracts the ordered open/close token skeleton with section types', () => {
      const bodyHtml = confluenceToHtml(LAYOUT_TWO_EQUAL_PAGE);
      const skeleton = extractLayoutSkeleton(bodyHtml);
      expect(skeleton.map((t) => `${t.isClose ? '/' : ''}${t.kind}${t.attrs ? ' ' + t.attrs : ''}`)).toEqual([
        'LAYOUT',
        'LAYOUT-SECTION two_equal',
        'LAYOUT-CELL', '/LAYOUT-CELL',
        'LAYOUT-CELL', '/LAYOUT-CELL',
        '/LAYOUT-SECTION',
        '/LAYOUT',
      ]);
    });

    it('extracts legacy section/column with border and width attrs', () => {
      const bodyHtml = confluenceToHtml(SECTION_COLUMN_PAGE);
      const skeleton = extractLayoutSkeleton(bodyHtml);
      const opens = skeleton.filter((t) => !t.isClose).map((t) => `${t.kind}${t.attrs ? ' ' + t.attrs : ''}`);
      expect(opens).toEqual(['SECTION', 'COLUMN width=30%', 'COLUMN width=70%']);
    });

    it('returns an empty skeleton for layout-free HTML', () => {
      expect(extractLayoutSkeleton('<h1>Title</h1><p>Prose</p>')).toEqual([]);
    });

    it('skips frozen legacy wrappers (nested in constrained containers) but keeps top-level ones', () => {
      const SECTION_MACRO =
        '<ac:structured-macro ac:name="section"><ac:rich-text-body>' +
        '<ac:structured-macro ac:name="column"><ac:rich-text-body><p>Nested</p></ac:rich-text-body></ac:structured-macro>' +
        '</ac:rich-text-body></ac:structured-macro>';
      const bodyHtml = confluenceToHtml(
        `<table><tbody><tr><td>${SECTION_MACRO}</td></tr></tbody></table>${SECTION_MACRO}`,
      );
      const skeleton = extractLayoutSkeleton(bodyHtml);
      // Only the top-level section/column pair is tokenized (the in-table one
      // travels opaquely via protectMedia, matching htmlToMarkdown).
      expect(skeleton.filter((t) => t.kind === 'SECTION' && !t.isClose)).toHaveLength(1);
      expect(skeleton.filter((t) => t.kind === 'COLUMN' && !t.isClose)).toHaveLength(1);
    });
  });

  // ------------------------------------------------------------------
  // Recovery of realistically mangled LLM output
  // ------------------------------------------------------------------
  describe('skeleton-guided recovery of mangled tokens', () => {
    async function recover(storageXhtml: string, mangle: (md: string) => string): Promise<string> {
      const { skeleton, md } = prepare(storageXhtml);
      return markdownToHtml(mangle(md), { layoutSkeleton: skeleton });
    }

    function expectTwoEqualRebuilt(html: string): void {
      expect(html).toContain('class="confluence-layout"');
      expect(html).toContain('data-layout-type="two_equal"');
      expect((html.match(/class="confluence-layout-cell"/g) ?? []).length).toBe(2);
      expect(html).toContain('Left column content');
      expect(html).toContain('Right column content');
      expect(html).not.toContain('[[[');
    }

    it('recovers lower-cased tokens (the #781 report case — was silently flattened)', async () => {
      const html = await recover(LAYOUT_TWO_EQUAL_PAGE, (md) =>
        md.replace(/\[\[\[([^\]]+)\]\]\]/g, (m) => m.toLowerCase()),
      );
      expectTwoEqualRebuilt(html);
    });

    it('recovers a single case-mangled close token', async () => {
      const html = await recover(LAYOUT_TWO_EQUAL_PAGE, (md) =>
        md.replace('[[[/LAYOUT-CELL]]]', '[[[/layout-cell]]]'),
      );
      expectTwoEqualRebuilt(html);
    });

    it('recovers tokens merged onto one line inside prose', async () => {
      const html = await recover(LAYOUT_TWO_EQUAL_PAGE, (md) =>
        md
          .replace(/\n+\[\[\[LAYOUT\]\]\]\n+/g, ' [[[LAYOUT]]] ')
          .replace(/\n+\[\[\[LAYOUT-SECTION two_equal\]\]\]\n+/g, ' [[[LAYOUT-SECTION two_equal]]] '),
      );
      expectTwoEqualRebuilt(html);
    });

    it('recovers a dropped close token (re-derived from the skeleton)', async () => {
      const html = await recover(LAYOUT_TWO_EQUAL_PAGE, (md) => md.replace('[[[/LAYOUT-CELL]]]', ''));
      expectTwoEqualRebuilt(html);
    });

    it('recovers dropped trailing closes (everything after the last cell open stays in that cell)', async () => {
      const html = await recover(LAYOUT_TWO_EQUAL_PAGE, (md) =>
        md
          .replace('[[[/LAYOUT-SECTION]]]', '')
          .replace('[[[/LAYOUT]]]', '')
          .replace(/\[\[\[\/LAYOUT-CELL\]\]\](?![\s\S]*\[\[\[\/LAYOUT-CELL\]\]\])/, ''),
      );
      expectTwoEqualRebuilt(html);
    });

    it('recovers a dropped section-type argument (type comes from the skeleton, never the echo)', async () => {
      const html = await recover(LAYOUT_TWO_EQUAL_PAGE, (md) =>
        md.replace('[[[LAYOUT-SECTION two_equal]]]', '[[[LAYOUT-SECTION]]]'),
      );
      expectTwoEqualRebuilt(html);
    });

    it('ignores a section type the LLM rewrote — the skeleton wins', async () => {
      const html = await recover(LAYOUT_TWO_EQUAL_PAGE, (md) =>
        md.replace('[[[LAYOUT-SECTION two_equal]]]', '[[[LAYOUT-SECTION three_equal]]]'),
      );
      expectTwoEqualRebuilt(html); // asserts data-layout-type="two_equal"
    });

    it('recovers bracket-count variants ([[…]] and [[[[…]]]])', async () => {
      const html = await recover(LAYOUT_TWO_EQUAL_PAGE, (md) =>
        md
          .replace('[[[LAYOUT]]]', '[[LAYOUT]]')
          .replace('[[[/LAYOUT]]]', '[[[[/LAYOUT]]]]'),
      );
      expectTwoEqualRebuilt(html);
    });

    it('recovers markdown-escaped tokens (\\[\\[\\[LAYOUT\\]\\]\\])', async () => {
      const html = await recover(LAYOUT_TWO_EQUAL_PAGE, (md) =>
        md.replace('[[[LAYOUT]]]', '\\[\\[\\[LAYOUT\\]\\]\\]'),
      );
      expectTwoEqualRebuilt(html);
    });

    it('recovers emphasis-wrapped tokens (**[[[LAYOUT-CELL]]]**)', async () => {
      const html = await recover(LAYOUT_TWO_EQUAL_PAGE, (md) =>
        md.replace('[[[LAYOUT-CELL]]]', '**[[[LAYOUT-CELL]]]**'),
      );
      expectTwoEqualRebuilt(html);
    });

    it('recovers underscore/space kind variants (LAYOUT_CELL, LAYOUT SECTION)', async () => {
      const html = await recover(LAYOUT_TWO_EQUAL_PAGE, (md) =>
        md
          .replace('[[[LAYOUT-SECTION two_equal]]]', '[[[LAYOUT SECTION two_equal]]]')
          .replace('[[[LAYOUT-CELL]]]', '[[[LAYOUT_CELL]]]'),
      );
      expectTwoEqualRebuilt(html);
    });

    it('recovers tokens the LLM wrapped in their own code fence', async () => {
      const html = await recover(LAYOUT_TWO_EQUAL_PAGE, (md) =>
        md.replace('[[[LAYOUT]]]\n\n[[[LAYOUT-SECTION two_equal]]]', '```\n[[[LAYOUT]]]\n[[[LAYOUT-SECTION two_equal]]]\n```'),
      );
      expectTwoEqualRebuilt(html);
    });

    it('recovers when the LLM fenced its ENTIRE output', async () => {
      const html = await recover(LAYOUT_TWO_EQUAL_PAGE, (md) => '```markdown\n' + md + '\n```');
      expectTwoEqualRebuilt(html);
    });

    it('strips duplicated/hallucinated extra tokens and still rebuilds per the skeleton', async () => {
      const html = await recover(LAYOUT_TWO_EQUAL_PAGE, (md) =>
        md.replace('[[[/LAYOUT]]]', '[[[/LAYOUT]]]\n\n[[[LAYOUT]]]\n\n[[[/LAYOUT]]]'),
      );
      // Exactly ONE layout — the duplicate echo is debris.
      expect((html.match(/class="confluence-layout"/g) ?? []).length).toBe(1);
      expectTwoEqualRebuilt(html);
    });

    it('keeps prose the LLM placed between cell boundaries out of the bare section (folds into the next cell)', async () => {
      const html = await recover(LAYOUT_TWO_EQUAL_PAGE, (md) =>
        md.replace('[[[LAYOUT-CELL]]]\n\nRight column content', 'Stray inter-cell prose\n\n[[[LAYOUT-CELL]]]\n\nRight column content'),
      );
      expect(html).toContain('Stray inter-cell prose');
      // The stray prose must live inside a cell, not directly in the section div.
      const sectionInner = html.slice(html.indexOf('confluence-layout-section'));
      const firstCellIdx = sectionInner.indexOf('confluence-layout-cell');
      const strayIdx = sectionInner.indexOf('Stray inter-cell prose');
      expect(strayIdx).toBeGreaterThan(firstCellIdx);
      expect((html.match(/class="confluence-layout-cell"/g) ?? []).length).toBe(2);
    });

    it('recovers mangled legacy SECTION/COLUMN tokens with widths from the skeleton', async () => {
      const { skeleton, md } = prepare(SECTION_COLUMN_PAGE);
      const mangled = md
        .replace('[[[SECTION]]]', '[[[section]]]')
        .replace('[[[COLUMN width=30%]]]', '[[[COLUMN]]]'); // width dropped by the LLM
      const html = await markdownToHtml(mangled, { layoutSkeleton: skeleton });
      const xhtml = htmlToConfluence(html);
      expect(xhtml).toContain('ac:name="section"');
      expect((xhtml.match(/ac:name="column"/g) ?? []).length).toBe(2);
      // Width restored from the skeleton even though the echo dropped it.
      expect(xhtml).toContain('<ac:parameter ac:name="width">30%</ac:parameter>');
      expect(xhtml).toContain('<ac:parameter ac:name="width">70%</ac:parameter>');
      expect(xhtml).not.toContain('[[[');
    });

    it('recovers a mangled sidebar layout end to end (acceptance: sidebar layout survives a misbehaving model)', async () => {
      const { skeleton, md } = prepare(LAYOUT_THREE_WITH_SIDEBARS_PAGE);
      const mangled = md
        .replace(/\[\[\[([^\]]+)\]\]\]/g, (m) => m.toLowerCase())
        .replace('[[[layout-section three_with_sidebars]]]', '[[[layout-section]]]');
      const html = await markdownToHtml(mangled, { layoutSkeleton: skeleton });
      const xhtml = htmlToConfluence(html);
      expect(xhtml).toContain('ac:type="three_with_sidebars"');
      expect((xhtml.match(/ac:type="single"/g) ?? []).length).toBe(2);
      expect((xhtml.match(/<ac:layout-cell>/g) ?? []).length).toBe(5);
      expect(xhtml).toContain('Wide middle content');
    });

    it('still treats literal token text inside code blocks as data when real tokens are intact', async () => {
      const { skeleton, md } = prepare(LAYOUT_TWO_EQUAL_PAGE);
      const withDocs = md.replace(
        'Left column content',
        'Left column content\n\n```\n[[[LAYOUT]]] is the open marker\n```',
      );
      const html = await markdownToHtml(withDocs, { layoutSkeleton: skeleton });
      expect(html).toContain('[[[LAYOUT]]] is the open marker');
      expect((html.match(/class="confluence-layout-cell"/g) ?? []).length).toBe(2);
    });

    it('strips hallucinated tokens on a layout-free page instead of inventing a layout', async () => {
      const hallucinated =
        '[[[LAYOUT]]]\n\n[[[LAYOUT-SECTION two_equal]]]\n\n[[[LAYOUT-CELL]]]\n\nProse\n\n[[[/LAYOUT-CELL]]]\n\n[[[/LAYOUT-SECTION]]]\n\n[[[/LAYOUT]]]';
      const html = await markdownToHtml(hallucinated, { layoutSkeleton: [] });
      expect(html).not.toContain('[[[');
      expect(html).not.toContain('confluence-layout');
      expect(html).toContain('Prose');
    });
  });

  // ------------------------------------------------------------------
  // Strictness ladder: loose matching only when the echo needs it
  // (#785 review — finding 1)
  // ------------------------------------------------------------------
  describe('strictness ladder — prose lookalikes vs mangled echoes (#785 review)', () => {
    it('keeps token lookalikes in prose as literal text when every real token is intact', async () => {
      const { skeleton, md } = prepare(LAYOUT_TWO_EQUAL_PAGE);
      const withLookalikes = md.replace(
        'Left column content',
        'Left column content — see [[[layout]]] and [[[section intro]]] in the style guide',
      );
      const html = await markdownToHtml(withLookalikes, { layoutSkeleton: skeleton });
      // Every real token aligned strictly, so the loose scan never ran: the
      // non-canonical lookalikes are prose and must reach the output verbatim.
      expect(html).toContain('[[[layout]]]');
      expect(html).toContain('[[[section intro]]]');
      expect(html).toContain('data-layout-type="two_equal"');
      expect((html.match(/class="confluence-layout-cell"/g) ?? []).length).toBe(2);
    });

    it('still escalates to loose matching when the echo is mangled (lookalike exposure accepted)', async () => {
      const { skeleton, md } = prepare(LAYOUT_TWO_EQUAL_PAGE);
      const mangled = md
        .replace('[[[/LAYOUT-CELL]]]', '[[[/layout-cell]]]') // first close lower-cased by the model
        .replace('Left column content', 'Left column content mentions [[[layout]]]');
      const html = await markdownToHtml(mangled, { layoutSkeleton: skeleton });
      // Loose escalation rescued the layout; the lookalike was consumed as
      // token debris — the accepted price of recovering a mangled echo.
      expect(html).toContain('data-layout-type="two_equal"');
      expect((html.match(/class="confluence-layout-cell"/g) ?? []).length).toBe(2);
      expect(html).toContain('Left column content mentions');
      expect(html).not.toContain('[[[');
    });
  });

  // ------------------------------------------------------------------
  // Unambiguous single-slot recovery (#785 review — finding 2)
  // ------------------------------------------------------------------
  describe('single prose-bearing slot — wrap recovery without any tokens (#785 review)', () => {
    it('recovers a single-cell layout when the model dropped every token (prose can only belong in the one cell)', async () => {
      const { skeleton, md } = prepare(LAYOUT_SINGLE_PAGE);
      const tokenFree = md.replace(/\[\[\[[^\]]+\]\]\]\n*/g, '');
      expect(tokenFree).not.toContain('[[[');
      const html = await markdownToHtml(tokenFree, { layoutSkeleton: skeleton });
      expect(html).toContain('data-layout-type="single"');
      expect((html.match(/class="confluence-layout-cell"/g) ?? []).length).toBe(1);
      expect(html).not.toContain('[[[');
      // The prose must land INSIDE the one cell, not at top level next to an
      // empty rebuilt layout.
      const xhtml = htmlToConfluence(html);
      expect(xhtml).toMatch(/<ac:layout-cell>[\s\S]*Full width content[\s\S]*<\/ac:layout-cell>/);
    });

    it('strips stray mangled-token debris and still wraps the prose into the single slot', async () => {
      const { skeleton, md } = prepare(LAYOUT_SINGLE_PAGE);
      const mangled = md
        .replace(/\[\[\[[^\]]+\]\]\]\n*/g, '')
        .replace('Full width content', 'Full width content\n\n[[[/layout cell]]]');
      const html = await markdownToHtml(mangled, { layoutSkeleton: skeleton });
      expect(html).not.toContain('[[[');
      expect((html.match(/class="confluence-layout-cell"/g) ?? []).length).toBe(1);
      const xhtml = htmlToConfluence(html);
      expect(xhtml).toMatch(/<ac:layout-cell>[\s\S]*Full width content[\s\S]*<\/ac:layout-cell>/);
    });

    it('still throws for multi-slot skeletons when tokens are dropped AND the cell-leading prose was rewritten (no anchors to split by)', async () => {
      const { skeleton, md } = prepare(LAYOUT_TWO_EQUAL_PAGE);
      const tokenFree = md
        .replace(/\[\[\[[^\]]+\]\]\]\n*/g, '')
        .replace('Left column content', 'Completely new intro')
        .replace('Right column content', 'Another fresh paragraph');
      await expect(markdownToHtml(tokenFree, { layoutSkeleton: skeleton })).rejects.toThrow(LayoutRecoveryError);
    });
  });

  // ------------------------------------------------------------------
  // hasRecoverableLayoutTokens — the Improve route's cache guard predicate
  // ------------------------------------------------------------------
  describe('hasRecoverableLayoutTokens', () => {
    it('is true for canonical tokens', () => {
      expect(hasRecoverableLayoutTokens('[[[LAYOUT-CELL]]]\n\nProse')).toBe(true);
    });

    it('is true for realistically mangled tokens (recovery could still use them)', () => {
      expect(hasRecoverableLayoutTokens('**[[[layout cell]]]**\n\nProse')).toBe(true);
      expect(hasRecoverableLayoutTokens('[[LAYOUT CELL]]\n\nProse')).toBe(true);
    });

    it('is false for plain prose without any token-ish text', () => {
      expect(hasRecoverableLayoutTokens('Just improved prose, nothing else.')).toBe(false);
    });

    it('is false when token text only appears inside code constructs (data, not structure)', () => {
      expect(hasRecoverableLayoutTokens('```\n[[[LAYOUT-CELL]]]\n```')).toBe(false);
    });
  });

  // ------------------------------------------------------------------
  // Anchor-based multi-cell recovery: all tokens dropped, but each cell's
  // leading prose survives — re-slot deterministically instead of rejecting.
  // (Observed in prod/dev: small local models return the improved prose with
  // every [[[…]]] token gone while cell-leading headings/markers survive.)
  // ------------------------------------------------------------------
  describe('anchor-based recovery when the model dropped every token (multi-cell)', () => {
    const dropAllTokens = (md: string): string => md.replace(/\[\[\[[^\]]+\]\]\]\n*/g, '');

    it('recovers a two_equal layout by splitting prose at the surviving cell anchors', async () => {
      const { skeleton, md } = prepare(LAYOUT_TWO_EQUAL_PAGE);
      const tokenFree = dropAllTokens(md);
      expect(tokenFree).not.toContain('[[[');
      const html = await markdownToHtml(tokenFree, { layoutSkeleton: skeleton });
      const xhtml = htmlToConfluence(html);
      expect(xhtml).toContain('ac:type="two_equal"');
      expect((xhtml.match(/<ac:layout-cell>/g) ?? []).length).toBe(2);
      // Each cell's prose must land in ITS OWN cell, in order.
      expect(xhtml).toMatch(/<ac:layout-cell>[\s\S]*Left column content[\s\S]*<\/ac:layout-cell>\s*<ac:layout-cell>[\s\S]*Right column content[\s\S]*<\/ac:layout-cell>/);
    });

    it('keeps prose preceding the layout at top level (not pulled into the first cell)', async () => {
      const { skeleton, md } = prepare(LAYOUT_TWO_EQUAL_PAGE);
      const html = await markdownToHtml(dropAllTokens(md), { layoutSkeleton: skeleton });
      const xhtml = htmlToConfluence(html);
      // The fixture's "Two Column Layout" h2 sits before <ac:layout> in storage.
      expect(xhtml).toMatch(/Two Column Layout[\s\S]*<ac:layout>/);
      expect(xhtml).not.toMatch(/<ac:layout-cell>[\s\S]*Two Column Layout/);
    });

    it('recovers the real-world failure shape: grammar-corrected prose, bold anchors stripped to plain text, no tokens', async () => {
      // Mirrors the observed model output: **ALPHA-LEFT** → ALPHA-LEFT (bold
      // dropped), prose grammar-corrected, every token gone.
      const storage =
        '<ac:layout><ac:layout-section ac:type="two_equal">' +
        '<ac:layout-cell><p><strong>ALPHA-LEFT</strong></p><p>Der Bereitstellungsprozess beginnt mit der Compilierung des Backends. Danach werden die Migrationen ausgefuehrt.</p></ac:layout-cell>' +
        '<ac:layout-cell><p><strong>BRAVO-RIGHT</strong></p><p>Rollbacks erfolgen durch Wiederherstellen des vorherigen Builds.</p></ac:layout-cell>' +
        '</ac:layout-section></ac:layout>';
      const { skeleton } = prepare(storage);
      const modelOutput =
        'ALPHA-LEFT\n\nDer Bereitstellungsprozess beginnt mit der Compilierung des Backends. Anschließend werden die Migrationen ausgeführt.\n\n' +
        'BRAVO-RIGHT\n\nRollbacks erfolgen durch Wiederherstellen des vorherigen Builds.';
      const html = await markdownToHtml(modelOutput, { layoutSkeleton: skeleton });
      const xhtml = htmlToConfluence(html);
      expect((xhtml.match(/<ac:layout-cell>/g) ?? []).length).toBe(2);
      expect(xhtml).toMatch(/<ac:layout-cell>[\s\S]*Anschließend[\s\S]*<\/ac:layout-cell>\s*<ac:layout-cell>[\s\S]*Rollbacks[\s\S]*<\/ac:layout-cell>/);
    });

    it('recovers a five-cell three_with_sidebars page when every token was dropped', async () => {
      const { skeleton, md } = prepare(LAYOUT_THREE_WITH_SIDEBARS_PAGE);
      const html = await markdownToHtml(dropAllTokens(md), { layoutSkeleton: skeleton });
      const xhtml = htmlToConfluence(html);
      expect(xhtml).toContain('ac:type="three_with_sidebars"');
      expect((xhtml.match(/<ac:layout-cell>/g) ?? []).length).toBe(5);
      expect(xhtml).toMatch(/<ac:layout-cell>[\s\S]*Left sidebar nav[\s\S]*<\/ac:layout-cell>\s*<ac:layout-cell>[\s\S]*Wide middle content[\s\S]*<\/ac:layout-cell>/);
      expect(xhtml).toMatch(/<ac:layout-cell>[\s\S]*Footer text\.[\s\S]*<\/ac:layout-cell>/);
    });

    it('matches anchors case-insensitively and through markdown emphasis', async () => {
      const { skeleton, md } = prepare(LAYOUT_TWO_EQUAL_PAGE);
      const mangled = dropAllTokens(md)
        .replace('Left column content', '**left COLUMN content**')
        .replace('Right column content', '_Right column content_');
      const html = await markdownToHtml(mangled, { layoutSkeleton: skeleton });
      const xhtml = htmlToConfluence(html);
      expect((xhtml.match(/<ac:layout-cell>/g) ?? []).length).toBe(2);
      expect(xhtml).toMatch(/left COLUMN content[\s\S]*<\/ac:layout-cell>\s*<ac:layout-cell>[\s\S]*Right column content/);
    });

    it('throws when an anchor would match ambiguously (same text appears twice)', async () => {
      const storage =
        '<ac:layout><ac:layout-section ac:type="two_equal">' +
        '<ac:layout-cell><p>Notes</p><p>First details.</p></ac:layout-cell>' +
        '<ac:layout-cell><p>Summary</p><p>Notes</p></ac:layout-cell>' +
        '</ac:layout-section></ac:layout>';
      const { skeleton, md } = prepare(storage);
      await expect(markdownToHtml(dropAllTokens(md), { layoutSkeleton: skeleton })).rejects.toThrow(LayoutRecoveryError);
    });

    it('throws when the anchors come back out of order (cells swapped)', async () => {
      const { skeleton, md } = prepare(LAYOUT_TWO_EQUAL_PAGE);
      const swapped = dropAllTokens(md)
        .replace('Left column content', 'TEMP-MARKER')
        .replace('Right column content', 'Left column content')
        .replace('TEMP-MARKER', 'Right column content');
      await expect(markdownToHtml(swapped, { layoutSkeleton: skeleton })).rejects.toThrow(LayoutRecoveryError);
    });

    it('throws when a cell was empty in the original (no anchor to split by)', async () => {
      const storage =
        '<ac:layout><ac:layout-section ac:type="two_equal">' +
        '<ac:layout-cell><p>Left column content</p></ac:layout-cell>' +
        '<ac:layout-cell><p></p></ac:layout-cell>' +
        '</ac:layout-section></ac:layout>';
      const { skeleton, md } = prepare(storage);
      await expect(markdownToHtml(dropAllTokens(md), { layoutSkeleton: skeleton })).rejects.toThrow(LayoutRecoveryError);
    });
  });

  // ------------------------------------------------------------------
  // Hard fallback: unrecoverable mangling must throw, never flatten
  // ------------------------------------------------------------------
  describe('predictable failure when recovery is impossible', () => {
    async function expectRecoveryError(storageXhtml: string, mangle: (md: string) => string): Promise<LayoutRecoveryError> {
      const { skeleton, md } = prepare(storageXhtml);
      try {
        await markdownToHtml(mangle(md), { layoutSkeleton: skeleton });
      } catch (err) {
        expect(err).toBeInstanceOf(LayoutRecoveryError);
        return err as LayoutRecoveryError;
      }
      throw new Error('expected markdownToHtml to throw LayoutRecoveryError');
    }

    it('throws when the LLM translated/reworded the tokens (unrecoverable)', async () => {
      const err = await expectRecoveryError(LAYOUT_TWO_EQUAL_PAGE, (md) =>
        md
          .replace(/\[\[\[LAYOUT-CELL\]\]\]/g, '[[[SPALTE]]]')
          .replace(/\[\[\[\/LAYOUT-CELL\]\]\]/g, '[[[/SPALTE]]]'),
      );
      expect(err.details.expectedTokens).toBeGreaterThan(0);
    });

    it('throws when the LLM merged two cells AND rewrote the second cell lead (anchor recovery impossible)', async () => {
      await expectRecoveryError(LAYOUT_TWO_EQUAL_PAGE, (md) =>
        md
          .replace('[[[/LAYOUT-CELL]]]\n\n[[[LAYOUT-CELL]]]', '')
          .replace('Right column content', 'Umgeschriebener zweiter Teil'),
      );
    });

    it('recovers a merged-cells echo via anchors when both cell leads survived', async () => {
      const { skeleton, md } = prepare(LAYOUT_TWO_EQUAL_PAGE);
      const merged = md.replace('[[[/LAYOUT-CELL]]]\n\n[[[LAYOUT-CELL]]]', '');
      const html = await markdownToHtml(merged, { layoutSkeleton: skeleton });
      const xhtml = htmlToConfluence(html);
      expect((xhtml.match(/<ac:layout-cell>/g) ?? []).length).toBe(2);
      expect(xhtml).toMatch(/<ac:layout-cell>[\s\S]*Left column content[\s\S]*<\/ac:layout-cell>\s*<ac:layout-cell>[\s\S]*Right column content[\s\S]*<\/ac:layout-cell>/);
    });

    it('throws when the LLM dropped every token and rewrote the cell-leading prose (anchor recovery impossible)', async () => {
      await expectRecoveryError(LAYOUT_TWO_EQUAL_PAGE, (md) =>
        md
          .replace(/\[\[\[[^\]]+\]\]\]\n*/g, '')
          .replace('Left column content', 'Erste Spalte, neu formuliert')
          .replace('Right column content', 'Zweite Spalte, neu formuliert'),
      );
    });

    it('without a skeleton the legacy drop-guard behavior is unchanged (flatten, strip tokens)', async () => {
      const { md } = prepare(LAYOUT_TWO_EQUAL_PAGE);
      const html = await markdownToHtml(md.replace('[[[/LAYOUT-CELL]]]', ''));
      expect(html).not.toContain('[[[');
      expect(html).not.toContain('confluence-layout');
      expect(html).toContain('Left column content');
    });
  });
});

// ---------------------------------------------------------------------------
// #1221 stage 2: expand sections ride boundary tokens where position allows.
//
// Stage 1 (#1225) froze EVERY <details> via protectMedia, which preserved the
// macro but made its body non-improvable. Stage 2 makes that freeze conditional
// (mirroring isFrozenLegacyWrapper) and emits [[[EXPAND …]]] boundary tokens
// everywhere else, so the prose inside a collapsible section is editable again
// while the macro identity, summary and parameters ride opaquely in the token.
// ---------------------------------------------------------------------------
describe('content-converter: #1221 stage 2 expand boundary tokens', () => {
  /** The Improve pipeline exactly as the route runs it (protect → tokens → rebuild). */
  async function improveRoundTrip(
    storageXhtml: string,
    editMarkdown: (md: string) => string = (md) => md,
  ): Promise<{ md: string; html: string; xhtml: string }> {
    const bodyHtml = confluenceToHtml(storageXhtml);
    const { html: protectedHtml, media } = protectMedia(bodyHtml);
    const layoutSkeleton = extractLayoutSkeleton(protectedHtml);
    const md = editMarkdown(htmlToMarkdown(protectedHtml, { layoutTokens: true }));
    const html = restoreMedia(await markdownToHtml(md, { layoutSkeleton }), media);
    return { md, html, xhtml: htmlToConfluence(html) };
  }

  describe('token emission', () => {
    it('wraps an unconstrained expand in EXPAND boundary tokens and leaves its body as markdown', () => {
      const md = htmlToMarkdown(protectMedia(confluenceToHtml(EXPAND_PAGE)).html, { layoutTokens: true });
      // Grammar is the contract: name / open / title / params, values
      // percent-encoded so no value can break the one-line token shape.
      expect(md).toContain('[[[EXPAND name=expand open=0 title=How%20do%20I%20reset%20my%20password%3F params=]]]');
      expect(md).toContain('[[[/EXPAND]]]');
      // The body is plain markdown the model can rewrite …
      expect(md).toContain('Change Password');
      // … while the summary rides opaquely inside the token, never as prose.
      expect(md.replace(/\[\[\[[^\]\n]*\]\]\]/g, '')).not.toContain('How do I reset my password');
      // And the section was NOT frozen into an opaque media token.
      expect(md).not.toContain('CQ\\_MEDIA\\_PLACEHOLDER');
    });

    it('emits open=1 and the macro parameters for a default-open Refined UI Expand', () => {
      const md = htmlToMarkdown(protectMedia(confluenceToHtml(UI_EXPAND_PAGE)).html, { layoutTokens: true });
      expect(md).toContain('[[[EXPAND name=ui-expand open=1 title=Development%20Team params=]]]');
      expect(md).toContain('[[[EXPAND name=ui-expand open=0 title=Support%20Team params=]]]');
    });
  });

  describe('round-trip through the full Improve pipeline', () => {
    it('preserves a native expand macro end to end and keeps its body improvable', async () => {
      const { xhtml } = await improveRoundTrip(EXPAND_PAGE, (md) =>
        md.replace('Change Password', 'Change Password (takes ~2 minutes)'),
      );
      expect((xhtml.match(/ac:name="expand"/g) ?? []).length).toBe(2);
      expect(xhtml).toContain('<ac:parameter ac:name="title">How do I reset my password?</ac:parameter>');
      expect(xhtml).toContain('Change Password (takes ~2 minutes)');
      expect(xhtml).toContain('<ac:rich-text-body>');
      expect(xhtml).not.toContain('[[[');
      // A native expand never gains an `expanded` parameter Atlassian's macro
      // does not define (#1129) — `open` stays inert on write-back.
      expect(xhtml).not.toContain('ac:name="expanded"');
    });

    it('preserves Refined UI Expand identity, parameters and open state end to end', async () => {
      const { xhtml } = await improveRoundTrip(UI_EXPAND_PAGE, (md) =>
        md.replace('Handles escalations.', 'Handles customer escalations end to end.'),
      );
      expect((xhtml.match(/ac:name="ui-expand"/g) ?? []).length).toBe(2);
      expect(xhtml).not.toContain('ac:name="expand"');
      expect(xhtml).toContain('<ac:parameter ac:name="title">Development Team</ac:parameter>');
      expect(xhtml).toContain('Handles customer escalations end to end.');
      // `expanded` is rebuilt from `open` and only for the section that had it.
      expect((xhtml.match(/<ac:parameter ac:name="expanded">true<\/ac:parameter>/g) ?? []).length).toBe(1);
    });

    it('keeps a native expand and a UI Expand distinct on the same page', async () => {
      const { md, xhtml } = await improveRoundTrip(MIXED_EXPAND_PAGE);
      expect(md).toContain('[[[EXPAND name=expand ');
      expect(md).toContain('[[[EXPAND name=ui-expand ');
      expect(xhtml).toContain('ac:name="expand"');
      expect(xhtml).toContain('ac:name="ui-expand"');
      expect(xhtml).toContain('native body');
      expect(xhtml).toContain('refined body');
    });

    it('round-trips a summary whose text would otherwise break the token grammar', async () => {
      const storage =
        '<ac:structured-macro ac:name="expand">' +
        '<ac:parameter ac:name="title">100% [done] &amp; &lt;b&gt;bold&lt;/b&gt; "quoted"</ac:parameter>' +
        '<ac:rich-text-body><p>body prose</p></ac:rich-text-body></ac:structured-macro>';
      const { md, xhtml } = await improveRoundTrip(storage);
      // The raw characters never appear in the token line — they are encoded.
      const tokenLine = md.split('\n').find((l) => l.startsWith('[[[EXPAND'))!;
      expect(tokenLine).toBeDefined();
      expect(tokenLine).not.toContain(' [done]');
      expect(xhtml).toContain('<ac:parameter ac:name="title">100% [done] &amp; &lt;b&gt;bold&lt;/b&gt; "quoted"</ac:parameter>');
      expect(xhtml).toContain('body prose');
    });

    it('preserves extra macro parameters carried in data-macro-params', async () => {
      const storage =
        '<ac:structured-macro ac:name="ui-expand">' +
        '<ac:parameter ac:name="title">Notes</ac:parameter>' +
        '<ac:parameter ac:name="class">highlight</ac:parameter>' +
        '<ac:rich-text-body><p>note body</p></ac:rich-text-body></ac:structured-macro>';
      const { md, xhtml } = await improveRoundTrip(storage, (m) =>
        m.replace('note body', 'note body, clarified'),
      );
      expect(md).toContain('params=%7B%22class%22%3A%22highlight%22%7D');
      expect(xhtml).toContain('<ac:parameter ac:name="class">highlight</ac:parameter>');
      expect(xhtml).toContain('<ac:parameter ac:name="title">Notes</ac:parameter>');
      expect(xhtml).toContain('note body, clarified');
    });

    it('preserves an expand nested inside another expand', async () => {
      const storage =
        '<ac:structured-macro ac:name="expand"><ac:parameter ac:name="title">Outer</ac:parameter>' +
        '<ac:rich-text-body><p>outer prose</p>' +
        '<ac:structured-macro ac:name="expand"><ac:parameter ac:name="title">Inner</ac:parameter>' +
        '<ac:rich-text-body><p>inner prose</p></ac:rich-text-body></ac:structured-macro>' +
        '</ac:rich-text-body></ac:structured-macro>';
      const { md, xhtml } = await improveRoundTrip(storage);
      expect((md.match(/\[\[\[EXPAND /g) ?? []).length).toBe(2);
      expect((xhtml.match(/ac:name="expand"/g) ?? []).length).toBe(2);
      expect(xhtml).toContain('<ac:parameter ac:name="title">Outer</ac:parameter>');
      expect(xhtml).toContain('<ac:parameter ac:name="title">Inner</ac:parameter>');
      // The inner macro really is nested inside the outer one's body.
      expect(xhtml).toMatch(/Outer<\/ac:parameter>[\s\S]*Inner<\/ac:parameter>[\s\S]*inner prose/);
      expect(xhtml).not.toContain('<details');
    });

    it('preserves a legacy section/column layout nested inside an expand body', async () => {
      const storage =
        '<ac:structured-macro ac:name="expand"><ac:parameter ac:name="title">Layout inside</ac:parameter>' +
        '<ac:rich-text-body>' +
        '<ac:structured-macro ac:name="section"><ac:rich-text-body>' +
        '<ac:structured-macro ac:name="column"><ac:parameter ac:name="width">30%</ac:parameter>' +
        '<ac:rich-text-body><p>left cell</p></ac:rich-text-body></ac:structured-macro>' +
        '<ac:structured-macro ac:name="column"><ac:parameter ac:name="width">70%</ac:parameter>' +
        '<ac:rich-text-body><p>right cell</p></ac:rich-text-body></ac:structured-macro>' +
        '</ac:rich-text-body></ac:structured-macro>' +
        '</ac:rich-text-body></ac:structured-macro>';
      const { md, xhtml } = await improveRoundTrip(storage);
      expect(md).toContain('[[[EXPAND ');
      expect(md).toContain('[[[SECTION]]]');
      expect(md).toContain('[[[COLUMN width=30%]]]');
      expect(xhtml).toContain('ac:name="expand"');
      expect(xhtml).toContain('ac:name="section"');
      expect((xhtml.match(/ac:name="column"/g) ?? []).length).toBe(2);
      expect(xhtml).toContain('<ac:parameter ac:name="width">30%</ac:parameter>');
      expect(xhtml).toContain('left cell');
      expect(xhtml).not.toContain('[[[');
    });

    it('protects media inside an expand body with its own token and restores it in place', async () => {
      const storage =
        '<ac:structured-macro ac:name="expand"><ac:parameter ac:name="title">Diagrams</ac:parameter>' +
        '<ac:rich-text-body><p>Intro</p><ac:image><ri:attachment ri:filename="photo.png"></ri:attachment></ac:image>' +
        '</ac:rich-text-body></ac:structured-macro>';
      const bodyHtml = confluenceToHtml(storage, '42');
      const { html: protectedHtml, media } = protectMedia(bodyHtml);
      // Stage 1 froze the whole section; stage 2 leaves it open and gives the
      // image its own media token so the surrounding prose stays improvable.
      expect(media).toHaveLength(1);
      expect(media[0]!.html).toContain('photo.png');
      expect(media[0]!.html).not.toContain('<details');
      const md = htmlToMarkdown(protectedHtml, { layoutTokens: true });
      expect(md).toContain('[[[EXPAND ');
      // The media token sits INSIDE the section's boundary tokens.
      expect(md.indexOf('[[[EXPAND ')).toBeLessThan(md.indexOf('CQ\\_MEDIA\\_PLACEHOLDER\\_0'));
      expect(md.indexOf('CQ\\_MEDIA\\_PLACEHOLDER\\_0')).toBeLessThan(md.indexOf('[[[/EXPAND]]]'));
      const html = restoreMedia(
        await markdownToHtml(md, { layoutSkeleton: extractLayoutSkeleton(protectedHtml) }),
        media,
      );
      const xhtml = htmlToConfluence(html);
      expect(xhtml).toContain('ri:filename="photo.png"');
      expect(xhtml).toContain('ac:name="expand"');
      // The image is still inside the expand body, not appended after it.
      expect(xhtml.indexOf('ri:filename="photo.png"')).toBeLessThan(xhtml.indexOf('</ac:rich-text-body>'));
    });
  });

  describe('sections the forward pass never produced', () => {
    /** Tokenise + rebuild body HTML directly (no storage-format source). */
    async function tokenRoundTrip(bodyHtml: string): Promise<{ md: string; html: string }> {
      const { html: prot } = protectMedia(bodyHtml);
      const md = htmlToMarkdown(prot, { layoutTokens: true });
      return { md, html: await markdownToHtml(md, { layoutSkeleton: extractLayoutSkeleton(prot) }) };
    }

    it('tokenises a <details> carrying no identity stamp, defaulting to the native expand', async () => {
      // body_html synced before #1211, and editor-created sections, carry no
      // `data-macro-name`. Requiring the stamp to recognise an expand would
      // leave these with neither a token nor the freeze — i.e. back to the
      // silent macro deletion. htmlToConfluence defaults them the same way.
      const { md, html } = await tokenRoundTrip('<details><summary>Legacy</summary><p>old body</p></details>');
      expect(md).toContain('[[[EXPAND name=expand open=0 title=Legacy params=]]]');
      expect(htmlToConfluence(html)).toContain('ac:name="expand"');
      expect(htmlToConfluence(html)).toContain('old body');
    });

    it('omits the summary for a title-less section rather than inventing a blank title', async () => {
      const { md, html } = await tokenRoundTrip('<details data-macro-name="expand"><p>body only</p></details>');
      // The `title` key is absent, not empty — presence is what distinguishes
      // "no <summary>" from "<summary></summary>" (#1232 review).
      expect(md).not.toContain('title=');
      expect(html).toContain('<details data-macro-name="expand">');
      expect(html).not.toContain('<summary>');
      const xhtml = htmlToConfluence(html);
      expect(xhtml).toContain('ac:name="expand"');
      expect(xhtml).not.toContain('ac:name="title"');
    });

    it('still emits tokens for a section with an empty body', async () => {
      // turndown replaces a "blank" element with nothing at all, which would
      // drop the boundary tokens and 422 every apply on such a page.
      const { md, html } = await tokenRoundTrip('<details data-macro-name="expand"><summary>Empty</summary></details>');
      expect(md).toContain('[[[EXPAND name=expand open=0 title=Empty params=]]]');
      expect(md).toContain('[[[/EXPAND]]]');
      expect(html).toContain('<summary>Empty</summary>');
      expect(htmlToConfluence(html)).toContain('ac:name="expand"');
    });
  });

  describe('token provenance on the skeleton path (#1232 review)', () => {
    async function skeletonRoundTrip(bodyHtml: string): Promise<{ md: string; html: string; xhtml: string }> {
      const { html: prot, media } = protectMedia(bodyHtml);
      const md = htmlToMarkdown(prot, { layoutTokens: true });
      const html = restoreMedia(
        await markdownToHtml(md, { layoutSkeleton: extractLayoutSkeleton(prot) }),
        media,
      );
      return { md, html, xhtml: htmlToConfluence(html) };
    }

    it('keeps token-shaped text inside an expand title instead of stripping it', async () => {
      // The backstop strip ran over the rebuilt HTML, where layoutOpenTag had
      // already decoded the title back to literal brackets — so a title that
      // documented the token syntax was emptied on save.
      const { xhtml } = await skeletonRoundTrip(
        '<details data-macro-name="expand"><summary>[[[EXPAND name=expand]]] explained</summary><p>b</p></details>',
      );
      expect(xhtml).toContain('<ac:parameter ac:name="title">[[[EXPAND name=expand]]] explained</ac:parameter>');
    });

    it('keeps token-shaped text inside a macro parameter value', async () => {
      const { xhtml } = await skeletonRoundTrip(
        '<details data-macro-name="ui-expand" data-macro-params="{&quot;note&quot;:&quot;[[[LAYOUT]]] here&quot;}">' +
        '<summary>T</summary><p>b</p></details>',
      );
      expect(xhtml).toContain('<ac:parameter ac:name="note">[[[LAYOUT]]] here</ac:parameter>');
    });

    it("strips a token shape the MODEL invented, while keeping the page's own", async () => {
      // The two are distinguishable, and the distinction is the escape.
      // Prose that was on the page reaches the model turndown-escaped
      // (\[\[\[…), which the strict scanner cannot see, so it stays prose all
      // the way to the saved page. An unescaped token shape the model typed
      // itself is indistinguishable from a hallucinated marker, and #781
      // strips those by design — keeping it would contradict the
      // 'hallucinated layout tokens are stripped, never built' guarantee.
      // Only the token shape goes; the surrounding words stay.
      const bodyHtml =
        '<p>Docs mention [[[EXPAND name=expand]]] here.</p>' +
        '<details data-macro-name="expand"><summary>Runbook</summary><p>step one</p></details>';
      const { html: prot } = protectMedia(bodyHtml);
      const md = `${htmlToMarkdown(prot, { layoutTokens: true })}\n\nI preserved the [[[EXPAND]]] marker.`;
      const html = await markdownToHtml(md, { layoutSkeleton: extractLayoutSkeleton(prot) });
      // The page's own sentence survives verbatim …
      expect(html).toContain('Docs mention [[[EXPAND name=expand]]] here.');
      // … the model's invented marker is stripped, its words kept …
      expect(html).toContain('marker.');
      expect(html).not.toContain('the [[[EXPAND]]] marker');
      // … and the real section is rebuilt.
      expect(html).toContain('<summary>Runbook</summary>');
    });

    it('leaves literal token text in a fenced code block untouched on the skeleton path', async () => {
      const bodyHtml = '<details data-macro-name="expand"><summary>Docs</summary><p>body</p></details>';
      const { html: prot } = protectMedia(bodyHtml);
      const md = `${htmlToMarkdown(prot, { layoutTokens: true })}\n\n\`\`\`\n[[[EXPAND name=expand]]]\n\`\`\`\n`;
      const html = await markdownToHtml(md, { layoutSkeleton: extractLayoutSkeleton(prot) });
      expect(html).toMatch(/<code>\[\[\[EXPAND name=expand\]\]\]/);
      expect(html).toContain('<summary>Docs</summary>');
    });

    it('keeps literal token text belonging to a legacy SECTION page, macro included', async () => {
      // The provenance fix is in the SHARED machinery, so it changes two things
      // for non-expand pages too — both strictly safer, both deliberate. Here:
      // a page documenting the token syntax used to lose the sentence AND the
      // section macro; now both survive.
      const bodyHtml = '<p>We document [[[SECTION]]] here.</p><div class="confluence-section"><p>real</p></div>';
      const { html: prot, media } = protectMedia(bodyHtml);
      const xhtml = htmlToConfluence(
        restoreMedia(
          await markdownToHtml(htmlToMarkdown(prot, { layoutTokens: true }), {
            layoutSkeleton: extractLayoutSkeleton(prot),
          }),
          media,
        ),
      );
      expect(xhtml).toContain('[[[SECTION]]]');
      expect(xhtml).toContain('ac:name="section"');
    });

    it('fails closed for a stored column macro that never had its section', async () => {
      // Not an expand shape, but the same class, and the one most likely to
      // exist in the wild: a hand-authored `column` outside any `section`.
      // Base stripped every token and saved the flattened body, deleting the
      // macro; refusing is strictly safer, at the cost of that page not being
      // improvable until its storage is fixed.
      const skeleton = extractLayoutSkeleton('<div class="confluence-column"><p>orphan</p></div>');
      expect(skeleton.map((t) => t.kind)).toEqual(['COLUMN', 'COLUMN']);
      await expect(markdownToHtml('orphan', { layoutSkeleton: skeleton })).rejects.toThrow(LayoutRecoveryError);
    });

    it('fails closed when the page itself carries a nesting the storage format forbids', async () => {
      // Reached only if the freeze misses a shape: strip-and-save would delete
      // the macros, so the apply is refused instead.
      const skeleton = extractLayoutSkeleton(
        '<div class="confluence-section"><div class="confluence-layout"><div class="confluence-layout-section" data-layout-type="single">' +
        '<div class="confluence-layout-cell"><p>x</p></div></div></div></div>',
      );
      expect(skeleton.map((t) => t.kind)).toContain('LAYOUT');
      await expect(markdownToHtml('anything', { layoutSkeleton: skeleton })).rejects.toThrow(LayoutRecoveryError);
    });
  });

  describe('shapes that must keep the opaque freeze (#1232 review)', () => {
    const CASES: { name: string; bodyHtml: string; keep: string }[] = [
      {
        name: 'an expand containing a bare column macro',
        bodyHtml:
          '<details data-macro-name="expand"><summary>T</summary>' +
          '<div class="confluence-column" data-cell-width="50%"><p>col body</p></div></details>',
        keep: 'confluence-column',
      },
      {
        name: 'an expand containing a layout cell without its grid',
        bodyHtml:
          '<details data-macro-name="expand"><summary>T</summary>' +
          '<div class="confluence-layout-cell"><p>cell body</p></div></details>',
        keep: 'confluence-layout-cell',
      },
      {
        name: 'an expand sitting directly inside a layout wrapper',
        bodyHtml:
          '<div class="confluence-layout">' +
          '<details data-macro-name="expand"><summary>T</summary><p>b</p></details></div>',
        keep: 'data-macro-name="expand"',
      },
    ];

    for (const { name, bodyHtml, keep } of CASES) {
      it(`freezes ${name}`, async () => {
        const { html: prot, media } = protectMedia(bodyHtml);
        expect(media.some((m) => m.html.includes('<details'))).toBe(true);
        const restored = restoreMedia(
          await markdownToHtml(htmlToMarkdown(prot, { layoutTokens: true }), {
            layoutSkeleton: extractLayoutSkeleton(prot),
          }),
          media,
        );
        expect(restored).toContain('data-macro-name="expand"');
        expect(restored).toContain(keep);
      });
    }

    it('still tokenises a section/column layout nested the legal way inside an expand', async () => {
      const bodyHtml =
        '<details data-macro-name="expand"><summary>T</summary>' +
        '<div class="confluence-section"><div class="confluence-column"><p>col</p></div></div></details>';
      const { html: prot, media } = protectMedia(bodyHtml);
      expect(media).toHaveLength(0);
      expect(htmlToMarkdown(prot, { layoutTokens: true })).toContain('[[[EXPAND ');
    });

    it('gives media exactly one token when a frozen expand holds an unfrozen nested one', async () => {
      // The outer section freezes for a reason its descendants do not share, so
      // frozen-ness is not inherited — the nearest-ancestor test handed the
      // image a second token the apply drop-guard could re-append.
      const bodyHtml =
        '<details data-macro-name="expand"><summary>Outer</summary>' +
        '<div class="confluence-column"><p>col</p></div>' +
        '<details data-macro-name="expand"><summary>Inner</summary>' +
        '<p><img src="/api/attachments/1/p.png" alt="P"></p></details></details>';
      const { media } = protectMedia(bodyHtml);
      expect(media).toHaveLength(1);
      expect(media[0]!.html).toContain('<summary>Outer</summary>');
    });
  });

  describe('anchors and titles (#1232 review)', () => {
    it('anchors on body prose only, skipping a nested section\'s summary too', async () => {
      // A nested <summary> rides in its own token and never reaches the
      // markdown either, so anchoring on it searches for text the model was
      // never shown — the same defect the direct-summary skip was written for.
      const skeleton = extractLayoutSkeleton(
        '<details data-macro-name="expand"><summary>Outer</summary>' +
        '<details data-macro-name="expand"><summary>Inner</summary><p>inner prose</p></details></details>',
      );
      expect(skeleton[0]!.anchor).toBe('inner prose');
    });

    it('preserves an explicitly empty title instead of dropping the parameter', async () => {
      // `title=` had to mean both "no <summary>" and "<summary></summary>", so
      // storage carrying an empty title parameter lost it on write-back.
      const { html: prot } = protectMedia(
        '<details data-macro-name="expand"><summary></summary><p>b</p></details>',
      );
      const md = htmlToMarkdown(prot, { layoutTokens: true });
      expect(md).toContain('title= ');
      const html = await markdownToHtml(md, { layoutSkeleton: extractLayoutSkeleton(prot) });
      expect(html).toContain('<summary></summary>');
      expect(htmlToConfluence(html)).toContain('<ac:parameter ac:name="title"></ac:parameter>');
    });

    it('still omits the summary entirely for a section that never had one', async () => {
      const { html: prot } = protectMedia('<details data-macro-name="expand"><p>body only</p></details>');
      const md = htmlToMarkdown(prot, { layoutTokens: true });
      expect(md).not.toContain('title=');
      const html = await markdownToHtml(md, { layoutSkeleton: extractLayoutSkeleton(prot) });
      expect(html).not.toContain('<summary>');
      expect(htmlToConfluence(html)).not.toContain('ac:name="title"');
    });
  });

  describe('safety envelope', () => {
    it('escapes a token title instead of injecting markup into the rebuilt section', async () => {
      const md = '[[[EXPAND name=expand open=0 title=%3Cscript%3Ealert%281%29%3C%2Fscript%3E params=]]]\n\nBody\n\n[[[/EXPAND]]]';
      const html = await markdownToHtml(md);
      expect(html).toContain('<details');
      expect(html).not.toContain('<script>');
      expect(html).toContain('&lt;script&gt;');
    });

    it('neutralizes raw markup a mangled token carried in its attrs', async () => {
      const md = '[[[EXPAND name=<script>x</script> open=0 title=<img onerror=y> params=]]]\n\nBody\n\n[[[/EXPAND]]]';
      const html = await markdownToHtml(md);
      expect(html).not.toContain('<script>');
      expect(html).not.toContain('<img onerror');
      expect(html).toContain('Body');
    });

    it('drops a params value that is not a JSON object rather than persisting garbage', async () => {
      const md = '[[[EXPAND name=expand open=0 title=T params=not%20json]]]\n\nBody\n\n[[[/EXPAND]]]';
      const html = await markdownToHtml(md);
      expect(html).toContain('<details');
      expect(html).not.toContain('data-macro-params');
    });

    it('flattens gracefully when an EXPAND token opens where the storage format forbids it', async () => {
      // LAYOUT-CELL may only open inside a LAYOUT-SECTION — balanced but invalid.
      const md = [
        '[[[EXPAND name=expand open=0 title=T params=]]]', '',
        '[[[LAYOUT-CELL]]]', '',
        'Orphan prose', '',
        '[[[/LAYOUT-CELL]]]', '',
        '[[[/EXPAND]]]',
      ].join('\n');
      const html = await markdownToHtml(md);
      expect(html).not.toContain('[[[');
      expect(html).not.toContain('<details');
      expect(html).toContain('Orphan prose');
    });

    it('preserves an expand wrapping a modern layout grid rather than flattening both', async () => {
      // The one shape where an expand cannot use tokens for a reason other than
      // its own position: [[[LAYOUT]]] is only valid at the top of the token
      // stack, so the sequence would be rejected and the drop-guard would strip
      // every token, deleting the macro. Verified end to end, through storage.
      const bodyHtml =
        '<details data-macro-name="expand"><summary>Grid</summary>' +
        '<div class="confluence-layout"><div class="confluence-layout-section" data-layout-type="two_equal">' +
        '<div class="confluence-layout-cell"><p>Left</p></div>' +
        '<div class="confluence-layout-cell"><p>Right</p></div>' +
        '</div></div></details>';
      const { html: prot, media } = protectMedia(bodyHtml);
      const rebuilt = restoreMedia(
        await markdownToHtml(htmlToMarkdown(prot, { layoutTokens: true }), {
          layoutSkeleton: extractLayoutSkeleton(prot),
        }),
        media,
      );
      const xhtml = htmlToConfluence(rebuilt);
      expect(xhtml).toContain('ac:name="expand"');
      expect(xhtml).toContain('<ac:parameter ac:name="title">Grid</ac:parameter>');
      expect(xhtml).toContain('ac:type="two_equal"');
      expect(xhtml).toContain('Left');
      expect(xhtml).toContain('Right');
      expect(xhtml).not.toContain('CQ_MEDIA_PLACEHOLDER');
    });

    it('#781: recovers a case-mangled EXPAND token against the page skeleton', async () => {
      const bodyHtml = confluenceToHtml(EXPAND_PAGE);
      const { html: protectedHtml } = protectMedia(bodyHtml);
      const skeleton = extractLayoutSkeleton(protectedHtml);
      const md = htmlToMarkdown(protectedHtml, { layoutTokens: true })
        .replace('[[[/EXPAND]]]', '[[[/expand]]]');
      const xhtml = htmlToConfluence(await markdownToHtml(md, { layoutSkeleton: skeleton }));
      expect((xhtml.match(/ac:name="expand"/g) ?? []).length).toBe(2);
      expect(xhtml).not.toContain('[[[');
    });

    it('#781: throws LayoutRecoveryError when the model dropped every EXPAND token and rewrote both bodies', async () => {
      const bodyHtml = confluenceToHtml(EXPAND_PAGE);
      const { html: protectedHtml } = protectMedia(bodyHtml);
      const skeleton = extractLayoutSkeleton(protectedHtml);
      // Two prose slots, no tokens, and both anchors reworded: there is no
      // deterministic way to know which prose belongs in which section.
      const mangled = 'Passwort zuruecksetzen: Einstellungen oeffnen.\n\nModelle: alle vom Server.';
      await expect(markdownToHtml(mangled, { layoutSkeleton: skeleton })).rejects.toThrow(LayoutRecoveryError);
    });

    it('names every emittable token kind in the model-facing instruction', () => {
      // The instruction enumerates the tokens the model will see; a kind
      // missing from it is a kind the model was never told to keep verbatim,
      // and since #781 a mangled token costs the user a 422 rather than a
      // silent flatten. Guards the enumeration against a new kind being added
      // to the converter alone.
      for (const kind of ['LAYOUT-SECTION', 'LAYOUT-CELL', 'LAYOUT', 'SECTION', 'COLUMN', 'EXPAND']) {
        expect(STRUCTURE_PRESERVATION_INSTRUCTION).toContain(`[[[${kind}`);
      }
    });

    it('shows EXPAND in the worked example, not only in the enumeration', () => {
      // #781 added the example because models echo tokens far more reliably
      // when shown one, and EXPAND is the only kind carrying an opaque
      // percent-encoded payload the model must copy byte-exact — so it is the
      // kind that most needs the demonstration. Asserting on the example half
      // specifically: the enumeration alone satisfies a `toContain('[[[EXPAND')`.
      const example = STRUCTURE_PRESERVATION_INSTRUCTION.slice(
        STRUCTURE_PRESERVATION_INSTRUCTION.indexOf('Example. Given this input:'),
      );
      expect(example).toContain('[[[EXPAND ');
      expect(example).toContain('[[[/EXPAND]]]');
    });

    it('#781: an expand skeleton does not disturb hasRecoverableLayoutTokens', () => {
      const md = htmlToMarkdown(protectMedia(confluenceToHtml(EXPAND_PAGE)).html, { layoutTokens: true });
      expect(hasRecoverableLayoutTokens(md)).toBe(true);
      expect(hasRecoverableLayoutTokens('Just prose, no structure.')).toBe(false);
    });
  });

  describe('constrained positions stay frozen', () => {
    const EXPAND_MACRO =
      '<ac:structured-macro ac:name="expand"><ac:parameter ac:name="title">In place</ac:parameter>' +
      '<ac:rich-text-body><p>constrained body</p></ac:rich-text-body></ac:structured-macro>';

    const CASES: { name: string; storage: string }[] = [
      { name: 'table cell', storage: `<table><tbody><tr><td>${EXPAND_MACRO}</td><td><p>other</p></td></tr></tbody></table>` },
      { name: 'table header cell', storage: `<table><tbody><tr><th>${EXPAND_MACRO}</th><th><p>other</p></th></tr></tbody></table>` },
      { name: 'list item', storage: `<ul><li><p>Item</p>${EXPAND_MACRO}</li><li><p>Plain</p></li></ul>` },
      { name: 'blockquote', storage: `<blockquote><p>Quoted</p>${EXPAND_MACRO}</blockquote>` },
      { name: 'panel', storage: `<ac:structured-macro ac:name="info"><ac:rich-text-body><p>Panel intro</p>${EXPAND_MACRO}</ac:rich-text-body></ac:structured-macro>` },
    ];

    for (const { name, storage } of CASES) {
      it(`freezes an expand inside a ${name} instead of tokenising it`, async () => {
        const bodyHtml = confluenceToHtml(storage);
        const { html: protectedHtml, media } = protectMedia(bodyHtml);
        // Frozen whole — markdown's token normalization would rip a boundary
        // token out of the containing construct (#765 review).
        expect(media).toHaveLength(1);
        expect(media[0]!.html).toContain('data-macro-name="expand"');
        const md = htmlToMarkdown(protectedHtml, { layoutTokens: true });
        expect(md).not.toContain('[[[EXPAND');
        expect(extractLayoutSkeleton(protectedHtml).filter((t) => t.kind === 'EXPAND')).toEqual([]);

        const { xhtml } = await improveRoundTrip(storage);
        expect(xhtml).toContain('ac:name="expand"');
        expect(xhtml).toContain('constrained body');
        expect(xhtml).not.toContain('<details');
      });
    }
  });
});
