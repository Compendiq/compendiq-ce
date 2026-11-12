/**
 * #1749: the dedicated code / toc / status handlers keep every direct text
 * parameter on write-back. Canonical parameters keep their own attributes
 * (code: `language` class + `data-title`; toc: `data-<name>`; status:
 * `data-color` + badge text); every other one rides in `data-macro-params`,
 * declared as `macroParams` on codeBlock / confluenceToc / confluenceStatus in
 * both TipTap schemas (the parity test pins the pair).
 */
import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import * as Y from 'yjs';
import { generateHTML, generateJSON } from '@tiptap/html';
import {
  confluenceToHtml,
  extractLayoutSkeleton,
  htmlToConfluence,
  htmlToMarkdown,
  markdownToHtml,
  protectMedia,
  restoreMedia,
} from './content-converter.js';
import { collabExtensions, htmlToYDoc, yDocToHtml } from './collab-schema.js';
import { CODE_BLOCK_TITLED_PAGE } from './__fixtures__/confluence-xhtml.js';

// The issue's fixtures, with Atlassian's documented parameter spellings.
const CODE_MACRO =
  '<ac:structured-macro ac:name="code">'
  + '<ac:parameter ac:name="language">c#</ac:parameter>'
  + '<ac:parameter ac:name="title">Startup.cs</ac:parameter>'
  + '<ac:parameter ac:name="linenumbers">true</ac:parameter>'
  + '<ac:parameter ac:name="collapse">true</ac:parameter>'
  + '<ac:plain-text-body><![CDATA[var app = builder.Build();]]></ac:plain-text-body>'
  + '</ac:structured-macro>';
const TOC_MACRO =
  '<ac:structured-macro ac:name="toc"><ac:parameter ac:name="exclude">Secret</ac:parameter></ac:structured-macro>';
const STATUS_MACRO =
  '<ac:structured-macro ac:name="status">'
  + '<ac:parameter ac:name="colour">Green</ac:parameter>'
  + '<ac:parameter ac:name="title">DONE</ac:parameter>'
  + '<ac:parameter ac:name="subtle">true</ac:parameter>'
  + '</ac:structured-macro>';
const PAGE = `<p>Intro</p>${CODE_MACRO}${TOC_MACRO}<p>State: ${STATUS_MACRO}</p>`;

/**
 * confluenceToHtml(PAGE), byte for byte: the node contract. The frontend
 * Editor and ArticleViewer tests (#1749) load this exact string, so they
 * exercise what the converter really emits.
 */
const PAGE_HTML =
  '<p>Intro</p>'
  + '<pre data-title="Startup.cs" data-macro-params="{&quot;linenumbers&quot;:&quot;true&quot;,&quot;collapse&quot;:&quot;true&quot;}">'
  + '<code class="language-c#">var app = builder.Build();</code></pre>'
  + '<div class="confluence-toc" data-macro-params="{&quot;exclude&quot;:&quot;Secret&quot;}">[Table of Contents]</div>'
  + '<p>State: <span class="confluence-status" data-color="green" data-macro-params="{&quot;subtle&quot;:&quot;true&quot;}">DONE</span></p>';

type Params = Array<[string, string]>;

/** A parameter map as name-sorted pairs, the shape `macroParams` returns. */
function sorted(params: Record<string, string>): Params {
  return Object.entries(params).sort(([a], [b]) => a.localeCompare(b));
}

const CODE_FIXTURE_PARAMS = sorted({ language: 'c#', title: 'Startup.cs', linenumbers: 'true', collapse: 'true' });
const TOC_FIXTURE_PARAMS = sorted({ exclude: 'Secret' });
const STATUS_FIXTURE_PARAMS = sorted({ colour: 'Green', title: 'DONE', subtle: 'true' });

/**
 * Every `ac:structured-macro[ac:name=<name>]` in document order, each as its
 * direct `ac:parameter` children sorted by name: order-insensitive
 * (Confluence reads parameters as a map) but duplicate-sensitive.
 */
function macroParams(xhtml: string, name: string): Params[] {
  const doc = new JSDOM(`<body>${xhtml}</body>`).window.document;
  return [...doc.getElementsByTagName('ac:structured-macro')]
    .filter((macro) => macro.getAttribute('ac:name') === name)
    .map((macro) => [...macro.children]
      .filter((child) => child.tagName.toLowerCase() === 'ac:parameter')
      .map((child): [string, string] => [child.getAttribute('ac:name') ?? '', child.textContent ?? ''])
      .sort(([a], [b]) => a.localeCompare(b)));
}

/** The parsed `data-macro-params` of the first element matching `selector`; null when absent. */
function carried(html: string, selector: string): unknown {
  const el = new JSDOM(`<body>${html}</body>`).window.document.querySelector(selector);
  return JSON.parse(el?.getAttribute('data-macro-params') ?? 'null');
}

describe('content-converter: #1749 dedicated macro parameters survive write-back', () => {
  describe('htmlToConfluence(confluenceToHtml(x))', () => {
    it('keeps code(language=c#, title=Startup.cs, linenumbers=true, collapse=true)', () => {
      const xhtml = htmlToConfluence(confluenceToHtml(CODE_MACRO));
      expect(macroParams(xhtml, 'code')).toEqual([CODE_FIXTURE_PARAMS]);
      expect(xhtml).toContain('<![CDATA[var app = builder.Build();]]>');
    });

    it('keeps toc(exclude=Secret)', () => {
      expect(macroParams(htmlToConfluence(confluenceToHtml(TOC_MACRO)), 'toc')).toEqual([TOC_FIXTURE_PARAMS]);
    });

    it('keeps status(colour=Green, title=DONE, subtle=true)', () => {
      expect(macroParams(htmlToConfluence(confluenceToHtml(`<p>${STATUS_MACRO}</p>`)), 'status'))
        .toEqual([STATUS_FIXTURE_PARAMS]);
    });

    it('keeps subtle on the bare status(subtle=true)', () => {
      // A status without colour/title still gets the pre-existing default fill on
      // write-back (colour=Grey, title=""); only `subtle` is this issue's.
      const [params] = macroParams(htmlToConfluence(confluenceToHtml(
        '<p><ac:structured-macro ac:name="status"><ac:parameter ac:name="subtle">true</ac:parameter></ac:structured-macro></p>',
      )), 'status');
      expect(params).toContainEqual(['subtle', 'true']);
    });

    it('keeps a value-less status parameter written self-closed', () => {
      // The #1222 shape: an XML serializer writes an empty parameter as <ac:parameter …/>.
      const storage =
        '<p><ac:structured-macro ac:name="status"><ac:parameter ac:name="subtle"/>'
        + '<ac:parameter ac:name="colour">Green</ac:parameter>'
        + '<ac:parameter ac:name="title">DONE</ac:parameter></ac:structured-macro></p>';
      expect(macroParams(htmlToConfluence(confluenceToHtml(storage)), 'status'))
        .toEqual([sorted({ colour: 'Green', title: 'DONE', subtle: '' })]);
    });

    it('keeps every code title of CODE_BLOCK_TITLED_PAGE and invents none for the untitled block', () => {
      expect(macroParams(htmlToConfluence(confluenceToHtml(CODE_BLOCK_TITLED_PAGE)), 'code')).toEqual([
        sorted({ language: 'yaml', title: 'docker-compose.yml' }),
        sorted({ language: 'json', title: 'tsconfig.json' }),
        sorted({ language: 'bash' }),
      ]);
    });
  });

  describe('canonical attributes and the carrier', () => {
    it('emits the language class, data-title and one data-macro-params per macro', () => {
      expect(confluenceToHtml(PAGE)).toBe(PAGE_HTML);
    });

    it('keeps toc\'s named parameters as data-* attributes and carries only the others', () => {
      const html = confluenceToHtml(
        '<ac:structured-macro ac:name="toc"><ac:parameter ac:name="maxLevel">3</ac:parameter>'
        + '<ac:parameter ac:name="exclude">Secret</ac:parameter>'
        + '<ac:parameter ac:name="class">bigpink</ac:parameter></ac:structured-macro>',
      );
      expect(html).toContain('data-maxlevel="3"');
      expect(carried(html, 'div.confluence-toc')).toEqual({ exclude: 'Secret', class: 'bigpink' });
      expect(macroParams(htmlToConfluence(html), 'toc'))
        .toEqual([sorted({ maxLevel: '3', exclude: 'Secret', class: 'bigpink' })]);
    });

    it('writes a canonical attribute instead of a same-named carried parameter', () => {
      // Stale carried copies (hand-edited HTML): the attribute the editor edits wins.
      const xhtml = htmlToConfluence(
        '<pre data-title="Startup.cs" data-macro-params="{&quot;language&quot;:&quot;java&quot;,&quot;title&quot;:&quot;Old.cs&quot;,&quot;linenumbers&quot;:&quot;true&quot;}">'
        + '<code class="language-c#">x</code></pre>'
        + '<div class="confluence-toc" data-maxlevel="2" data-macro-params="{&quot;maxLevel&quot;:&quot;5&quot;,&quot;exclude&quot;:&quot;Secret&quot;}">[Table of Contents]</div>'
        + '<p><span class="confluence-status" data-color="green" data-macro-params="{&quot;colour&quot;:&quot;Red&quot;,&quot;title&quot;:&quot;Stale&quot;,&quot;subtle&quot;:&quot;true&quot;}">DONE</span></p>',
      );
      expect(macroParams(xhtml, 'code')).toEqual([sorted({ language: 'c#', title: 'Startup.cs', linenumbers: 'true' })]);
      expect(macroParams(xhtml, 'toc')).toEqual([sorted({ maxLevel: '2', exclude: 'Secret' })]);
      expect(macroParams(xhtml, 'status')).toEqual([sorted({ colour: 'Green', title: 'DONE', subtle: 'true' })]);
    });

    it('carries an empty code language and title, and a language chosen later replaces only the empty one', () => {
      const html = confluenceToHtml(
        '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language"/><ac:parameter ac:name="title"/>'
        + '<ac:plain-text-body><![CDATA[echo hi]]></ac:plain-text-body></ac:structured-macro>',
      );
      expect(macroParams(htmlToConfluence(html), 'code')).toEqual([sorted({ language: '', title: '' })]);
      // The editor's language picker: updateAttributes({ language }) on the parsed node.
      const doc = generateJSON(html, collabExtensions());
      doc.content[0].attrs.language = 'bash';
      expect(macroParams(htmlToConfluence(generateHTML(doc, collabExtensions())), 'code'))
        .toEqual([sorted({ language: 'bash', title: '' })]);
    });

    it('keeps hostile parameter values (" < > &) inert and intact', () => {
      const html = confluenceToHtml(
        '<ac:structured-macro ac:name="code">'
        + '<ac:parameter ac:name="language">c"&gt;&lt;x&gt;&amp;</ac:parameter>'
        + '<ac:parameter ac:name="theme">"&gt;&lt;br&gt;&amp;</ac:parameter>'
        + '<ac:plain-text-body><![CDATA[x]]></ac:plain-text-body></ac:structured-macro>',
      );
      const xhtml = htmlToConfluence(html);
      const expected = [sorted({ language: 'c"><x>&', theme: '"><br>&' })];
      expect(macroParams(xhtml, 'code')).toEqual(expected);
      // Storage: values are element text, so `<`, `>` and `&` are escaped and the
      // void-element post-process (`<br …>` → `<br />`) has nothing to rewrite.
      expect(xhtml).toContain('<ac:parameter ac:name="language">c"&gt;&lt;x&gt;&amp;</ac:parameter>');
      expect(xhtml).toContain('<ac:parameter ac:name="theme">"&gt;&lt;br&gt;&amp;</ac:parameter>');
      // body_html: values are attribute values (`"` and `&` escaped), so no element
      // and no attribute escapes from them.
      const body = new JSDOM(`<body>${html}</body>`).window.document.body;
      expect(body.querySelectorAll('x, br')).toHaveLength(0);
      const pre = body.querySelector('pre');
      expect(pre?.getAttributeNames()).toEqual(['data-macro-params']);
      expect(pre?.querySelector('code')?.getAttributeNames()).toEqual(['class']);
      // The collab schema serializes (happy-dom) with the same escaping.
      expect(macroParams(htmlToConfluence(yDocToHtml(htmlToYDoc(html))), 'code')).toEqual(expected);
    });
  });

  describe('language class', () => {
    it.each(['c#', 'objective-c', 'c++'])('writes language %s back whole', (language) => {
      expect(macroParams(htmlToConfluence(`<pre><code class="language-${language}">x</code></pre>`), 'code'))
        .toEqual([[['language', language]]]);
    });

    // TipTap spreads CodeBlock's own `language` parse (the class token of <pre>'s
    // first element child) over this rule's getAttrs, so the rule's regex decides
    // only when <code> is not that first child: the second shape.
    it.each(['c#', 'objective-c', 'c++'])(
      'the collab code-block parse keeps language-%s whole, also when <code> is not the first element of <pre>',
      (language) => {
        for (const html of [
          `<pre><code class="language-${language}">x</code></pre>`,
          `<pre><span></span><code class="language-${language}">x</code></pre>`,
        ]) {
          expect(generateJSON(html, collabExtensions()).content?.[0]?.attrs?.language, html).toBe(language);
        }
      },
    );
  });

  describe('collab TipTap schema', () => {
    // htmlToYDoc parses with collabExtensions() into a Y.Doc of getCollabSchema()
    // (collab-schema.ts:938-941); yDocToHtml serializes it back (943-946).
    it.each([
      { name: 'code', selector: 'pre', params: { linenumbers: 'true', collapse: 'true' } },
      { name: 'toc', selector: 'div.confluence-toc', params: { exclude: 'Secret' } },
      { name: 'status', selector: 'span.confluence-status', params: { subtle: 'true' } },
    ])(
      'keeps the $name carrier through the collab schema round trip (htmlToYDoc → yDocToHtml on getCollabSchema())',
      ({ selector, params }) => {
        expect(carried(yDocToHtml(htmlToYDoc(PAGE_HTML)), selector)).toEqual(params);
      },
    );

    it('keeps every parameter through a collab load, an unrelated edit and write-back', () => {
      const doc = htmlToYDoc(confluenceToHtml(PAGE));
      // Type into the first paragraph, as a co-editor would; no macro is touched.
      const intro = doc.getXmlFragment('default').get(0);
      if (!(intro instanceof Y.XmlElement)) throw new Error('PAGE must open with a paragraph');
      const text = intro.get(0);
      if (!(text instanceof Y.XmlText)) throw new Error('the opening paragraph must hold text');
      text.insert(text.length, ' (edited)');

      const saved = yDocToHtml(doc);
      expect(saved).toContain('<p>Intro (edited)</p>');
      const xhtml = htmlToConfluence(saved);
      expect(macroParams(xhtml, 'code')).toEqual([CODE_FIXTURE_PARAMS]);
      expect(macroParams(xhtml, 'toc')).toEqual([TOC_FIXTURE_PARAMS]);
      expect(macroParams(xhtml, 'status')).toEqual([STATUS_FIXTURE_PARAMS]);
    });
  });

  describe('AI Improve round trip', () => {
    it('keeps the toc and status parameters and the code language', async () => {
      // The Improve apply exactly (llm-conversations.ts:454-488): protect → markdown → rebuild → restore.
      const { html: protectedHtml, media } = protectMedia(confluenceToHtml(PAGE));
      const layoutSkeleton = extractLayoutSkeleton(protectedHtml);
      const markdown = htmlToMarkdown(protectedHtml, { layoutTokens: true });
      const xhtml = htmlToConfluence(restoreMedia(await markdownToHtml(markdown, { layoutSkeleton }), media));
      expect(macroParams(xhtml, 'toc')).toEqual([TOC_FIXTURE_PARAMS]);
      expect(macroParams(xhtml, 'status')).toEqual([STATUS_FIXTURE_PARAMS]);
      // <pre> extras (title, linenumbers, collapse) are out of scope here (#1749 PR); only the language is pinned.
      expect(macroParams(xhtml, 'code')[0]).toContainEqual(['language', 'c#']);
    });
  });
});
