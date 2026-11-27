/**
 * Legacy-shaped fixtures for the carrier recovery of pages synced before v0.10.0 (#1953, AC8).
 *
 * Every `legacyHtml` literal is the literal output of the historical forward converter for the `storage` beside
 * it: `confluenceToHtml(storage)` (no page id, no space key) at tag `v0.9.2`
 * (f85c32a18f3974db0e10235adf0c72e317809d02), before #1748/#1749/#1750 gave links, macro parameters and emoticons
 * their carriers. For `composite` and `ac1` the output at 62950a8b (the last commit before #1942/#1949/#1950/#1952)
 * is the same string (epic evidence `legacy-shapes-probe.txt`). Today's converter is only ever the oracle side of a
 * test; never regenerate a literal from it. A few long entries (`codeLong*`, `codeManyParams`, `longMarkAttribute`, `statusRun32`) are
 * written as expressions; each evaluates to the storage that was converted and to that converter's output.
 *
 * `composite` is the historical composite fixture, kept whole as an AC8 negative (design review r7 AA2): its final
 * blog-post link is self-closing before its body, so the two readings of its storage differ and the whole page
 * abstains. `ac1` is its AC1-only portion: the same strings with the blog paragraph removed from both inputs.
 */

const code = (title: string, body: string, language = 'java', extra = ''): string =>
  `<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">${language}</ac:parameter><ac:parameter ac:name="title">${title}</ac:parameter>${extra}<ac:plain-text-body><![CDATA[${body}]]></ac:plain-text-body></ac:structured-macro>`;

const status = (title: string): string =>
  `<ac:structured-macro ac:name="status"><ac:parameter ac:name="colour">Green</ac:parameter><ac:parameter ac:name="title">${title}</ac:parameter><ac:parameter ac:name="subtle">true</ac:parameter></ac:structured-macro>`;

export interface LegacyCarrierFixture {
  /** `pages.body_storage`: what Confluence holds. */
  readonly storage: string;
  /** `pages.body_html` as the converter of v0.9.2 wrote it for that storage. */
  readonly legacyHtml: string;
}

export const LEGACY_CARRIER_FIXTURES = {
  composite: {
    storage: '<p>Done <ac:emoticon ac:name="tick" /> now</p><table><tbody><tr><td><ac:emoticon ac:name="cross" /></td><td>x</td></tr></tbody></table><ac:structured-macro ac:name="code"><ac:parameter ac:name="language">java</ac:parameter><ac:parameter ac:name="title">Main</ac:parameter><ac:parameter ac:name="linenumbers">true</ac:parameter><ac:plain-text-body><![CDATA[class A {}]]></ac:plain-text-body></ac:structured-macro><ac:structured-macro ac:name="toc"><ac:parameter ac:name="maxLevel">3</ac:parameter><ac:parameter ac:name="exclude">Intro</ac:parameter></ac:structured-macro><p><ac:structured-macro ac:name="status"><ac:parameter ac:name="colour">Green</ac:parameter><ac:parameter ac:name="title">OK</ac:parameter><ac:parameter ac:name="subtle">true</ac:parameter></ac:structured-macro></p><p>See <ac:link ac:anchor="sec"><ri:page ri:content-title="My Page" ri:space-key="ENG" /><ac:plain-text-link-body><![CDATA[the page]]></ac:plain-text-link-body></ac:link>.</p><p><ac:link><ri:attachment ri:filename="a.pdf"><ri:page ri:content-title="Other" /></ri:attachment></ac:link></p><p>Jump <ac:link ac:anchor="top"><ac:plain-text-link-body><![CDATA[to top]]></ac:plain-text-link-body></ac:link> now</p><p>Blog <ac:link><ri:blog-post ri:content-title="News" ri:posting-day="2026/01/02" /><ac:plain-text-link-body><![CDATA[news]]></ac:plain-text-link-body></ac:link></p>',
    legacyHtml: '<p>Done  now</p><table><tbody><tr><td></td><td>x</td></tr></tbody></table><pre><code class="language-java">class A {}</code></pre><div class="confluence-toc" data-maxlevel="3">[Table of Contents]</div><p><span class="confluence-status" data-color="green">OK</span></p><p>See <a href="#confluence-page:My Page" data-confluence-link="page">the page</a>.</p><p><a href="#confluence-page:Other" data-confluence-link="page">Other</a></p><p>Jump <a>to top</a> now</p><p>Blog <a>news</a></p>',
  },
  ac1: {
    storage: '<p>Done <ac:emoticon ac:name="tick" /> now</p><table><tbody><tr><td><ac:emoticon ac:name="cross" /></td><td>x</td></tr></tbody></table><ac:structured-macro ac:name="code"><ac:parameter ac:name="language">java</ac:parameter><ac:parameter ac:name="title">Main</ac:parameter><ac:parameter ac:name="linenumbers">true</ac:parameter><ac:plain-text-body><![CDATA[class A {}]]></ac:plain-text-body></ac:structured-macro><ac:structured-macro ac:name="toc"><ac:parameter ac:name="maxLevel">3</ac:parameter><ac:parameter ac:name="exclude">Intro</ac:parameter></ac:structured-macro><p><ac:structured-macro ac:name="status"><ac:parameter ac:name="colour">Green</ac:parameter><ac:parameter ac:name="title">OK</ac:parameter><ac:parameter ac:name="subtle">true</ac:parameter></ac:structured-macro></p><p>See <ac:link ac:anchor="sec"><ri:page ri:content-title="My Page" ri:space-key="ENG" /><ac:plain-text-link-body><![CDATA[the page]]></ac:plain-text-link-body></ac:link>.</p><p><ac:link><ri:attachment ri:filename="a.pdf"><ri:page ri:content-title="Other" /></ri:attachment></ac:link></p><p>Jump <ac:link ac:anchor="top"><ac:plain-text-link-body><![CDATA[to top]]></ac:plain-text-link-body></ac:link> now</p>',
    legacyHtml: '<p>Done  now</p><table><tbody><tr><td></td><td>x</td></tr></tbody></table><pre><code class="language-java">class A {}</code></pre><div class="confluence-toc" data-maxlevel="3">[Table of Contents]</div><p><span class="confluence-status" data-color="green">OK</span></p><p>See <a href="#confluence-page:My Page" data-confluence-link="page">the page</a>.</p><p><a href="#confluence-page:Other" data-confluence-link="page">Other</a></p><p>Jump <a>to top</a> now</p>',
  },
  emoticonRun: {
    storage: '<p>Done <ac:emoticon ac:name="tick" /> now</p><p>Other text</p>',
    legacyHtml: '<p>Done  now</p><p>Other text</p>',
  },
  emoticonsInOneGap: {
    storage: '<p>a <ac:emoticon ac:name="tick" /><ac:emoticon ac:name="cross" /> b</p>',
    legacyHtml: '<p>a  b</p>',
  },
  emoticonAfterMark: {
    storage: '<p><strong>bold </strong><ac:emoticon ac:name="tick" /> after</p>',
    legacyHtml: '<p><strong>bold </strong> after</p>',
  },
  emoticonSurrogates: {
    storage: '<p>𝄞 <ac:emoticon ac:name="tick" /> 😀 tail</p>',
    legacyHtml: '<p>𝄞  😀 tail</p>',
  },
  emoticonOnlyParagraph: {
    storage: '<p><ac:emoticon ac:name="tick" /></p><p>text</p>',
    legacyHtml: '<p></p><p>text</p>',
  },
  emoticonGrid: {
    storage: '<table><tbody><tr><th>Name</th><th>State</th></tr><tr><td>alpha</td><td><ac:emoticon ac:name="tick" /></td></tr><tr><td>beta</td><td><ac:emoticon ac:name="cross" /></td></tr></tbody></table>',
    legacyHtml: '<table><tbody><tr><th>Name</th><th>State</th></tr><tr><td>alpha</td><td></td></tr><tr><td>beta</td><td></td></tr></tbody></table>',
  },
  emoticonGridRepeated: {
    storage: '<table><tbody><tr><th>Name</th><th>State</th></tr><tr><td>alpha</td><td><ac:emoticon ac:name="tick" /></td></tr><tr><td>alpha</td><td><ac:emoticon ac:name="tick" /></td></tr></tbody></table>',
    legacyHtml: '<table><tbody><tr><th>Name</th><th>State</th></tr><tr><td>alpha</td><td></td></tr><tr><td>alpha</td><td></td></tr></tbody></table>',
  },
  emoticonGridSpanned: {
    storage: '<table><tbody><tr><th>Name</th><th>State</th></tr><tr><td>alpha</td><td><ac:emoticon ac:name="tick" /></td></tr><tr><td colspan="2">wide</td></tr></tbody></table>',
    legacyHtml: '<table><tbody><tr><th>Name</th><th>State</th></tr><tr><td>alpha</td><td></td></tr><tr><td colspan="2">wide</td></tr></tbody></table>',
  },
  code: {
    storage: '<p>Intro</p><ac:structured-macro ac:name="code"><ac:parameter ac:name="language">java</ac:parameter><ac:parameter ac:name="title">Main</ac:parameter><ac:parameter ac:name="linenumbers">true</ac:parameter><ac:plain-text-body><![CDATA[class A {}]]></ac:plain-text-body></ac:structured-macro>',
    legacyHtml: '<p>Intro</p><pre><code class="language-java">class A {}</code></pre>',
  },
  codeEntities: {
    storage: '<p>Intro</p><ac:structured-macro ac:name="code"><ac:parameter ac:name="language">js</ac:parameter><ac:parameter ac:name="title">Lf</ac:parameter><ac:plain-text-body><![CDATA[\nif (a < b && c > d) {}\n]]></ac:plain-text-body></ac:structured-macro>',
    legacyHtml: '<p>Intro</p><pre><code class="language-js">\nif (a &lt; b &amp;&amp; c &gt; d) {}\n</code></pre>',
  },
  codeTwins: {
    storage: '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">java</ac:parameter><ac:parameter ac:name="title">Main</ac:parameter><ac:plain-text-body><![CDATA[x]]></ac:plain-text-body></ac:structured-macro><p>between</p><ac:structured-macro ac:name="code"><ac:parameter ac:name="language">java</ac:parameter><ac:parameter ac:name="title">Main</ac:parameter><ac:plain-text-body><![CDATA[x]]></ac:plain-text-body></ac:structured-macro>',
    legacyHtml: '<pre><code class="language-java">x</code></pre><p>between</p><pre><code class="language-java">x</code></pre>',
  },
  codeLanguageSpace: {
    storage: '<p>Intro</p><ac:structured-macro ac:name="code"><ac:parameter ac:name="language">a b</ac:parameter><ac:parameter ac:name="title">Main</ac:parameter><ac:plain-text-body><![CDATA[x]]></ac:plain-text-body></ac:structured-macro>',
    legacyHtml: '<p>Intro</p><pre><code class="language-a b">x</code></pre>',
  },
  codeLongTitle: {
    storage: `<p>Intro</p>${code('T'.repeat(1025), 'x')}`,
    legacyHtml: '<p>Intro</p><pre><code class="language-java">x</code></pre>',
  },
  codeManyParams: {
    storage: `<p>Intro</p>${code('Main', 'x', 'java', Array.from({ length: 65 }, (_, i) => `<ac:parameter ac:name="p${i}">v</ac:parameter>`).join(''))}`,
    legacyHtml: '<p>Intro</p><pre><code class="language-java">x</code></pre>',
  },
  codeLongParams: {
    storage: `<p>Intro</p>${code('Main', 'x', 'java', `<ac:parameter ac:name="big">${'v'.repeat(16_400)}</ac:parameter>`)}`,
    legacyHtml: '<p>Intro</p><pre><code class="language-java">x</code></pre>',
  },
  statusToc: {
    storage: '<ac:structured-macro ac:name="toc"><ac:parameter ac:name="maxLevel">3</ac:parameter><ac:parameter ac:name="exclude">Intro</ac:parameter></ac:structured-macro><p>State <ac:structured-macro ac:name="status"><ac:parameter ac:name="colour">Green</ac:parameter><ac:parameter ac:name="title">OK</ac:parameter><ac:parameter ac:name="subtle">true</ac:parameter></ac:structured-macro> today</p>',
    legacyHtml: '<div class="confluence-toc" data-maxlevel="3">[Table of Contents]</div><p>State <span class="confluence-status" data-color="green">OK</span> today</p>',
  },
  pageLink: {
    storage: '<p>See <ac:link ac:anchor="sec"><ri:page ri:content-title="My Page" ri:space-key="ENG" /><ac:plain-text-link-body><![CDATA[the page]]></ac:plain-text-link-body></ac:link>.</p>',
    legacyHtml: '<p>See <a href="#confluence-page:My Page" data-confluence-link="page">the page</a>.</p>',
  },
  attachmentOwned: {
    storage: '<p>File <ac:link><ri:attachment ri:filename="a.pdf"><ri:page ri:content-title="Other" /></ri:attachment></ac:link> here</p>',
    legacyHtml: '<p>File <a href="#confluence-page:Other" data-confluence-link="page">Other</a> here</p>',
  },
  attachmentOwnedBodyTitle: {
    storage: '<p>File <ac:link><ri:attachment ri:filename="a.pdf"><ri:page ri:content-title="Other" /></ri:attachment><ac:plain-text-link-body><![CDATA[Other]]></ac:plain-text-link-body></ac:link> here</p>',
    legacyHtml: '<p>File <a href="#confluence-page:Other" data-confluence-link="page">Other</a> here</p>',
  },
  attachmentOwnedBodyOther: {
    storage: '<p>File <ac:link><ri:attachment ri:filename="a.pdf"><ri:page ri:content-title="Other" /></ri:attachment><ac:plain-text-link-body><![CDATA[the file]]></ac:plain-text-link-body></ac:link> here</p>',
    legacyHtml: '<p>File <a href="#confluence-page:Other" data-confluence-link="page">the file</a> here</p>',
  },
  anchorLink: {
    storage: '<p>Jump <ac:link ac:anchor="top"><ac:plain-text-link-body><![CDATA[to top]]></ac:plain-text-link-body></ac:link> now</p>',
    legacyHtml: '<p>Jump <a>to top</a> now</p>',
  },
  anchorBodyless: {
    storage: '<p>Jump <ac:link ac:anchor="top" /> now</p>',
    legacyHtml: '<p>Jump <a></a></p>',
  },
  anchorBodylessEnd: {
    storage: '<p>Jump <ac:link ac:anchor="top" /></p>',
    legacyHtml: '<p>Jump <a></a></p>',
  },
  twoLookalikeLinks: {
    storage: '<p><ac:link><ri:page ri:content-title="X" ri:space-key="A" /></ac:link> and <ac:link><ri:page ri:content-title="X" ri:space-key="B" /></ac:link></p>',
    legacyHtml: '<p><a href="#confluence-page:X" data-confluence-link="page">X</a> and <a href="#confluence-page:X" data-confluence-link="page">X</a></p>',
  },
  linkDroppedAttribute: {
    storage: '<p>Go <ac:link ac:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx="v"><ri:page ri:content-title="P" ri:space-key="S" /></ac:link> now</p>',
    legacyHtml: '<p>Go <a href="#confluence-page:P" data-confluence-link="page">P</a> now</p>',
  },
  linkCodeBody: {
    storage: '<ac:link><ri:page ri:content-title="P" ri:space-key="S" /><ac:link-body><ac:structured-macro ac:name="code"><ac:parameter ac:name="language">java</ac:parameter><ac:parameter ac:name="title">Inner</ac:parameter><ac:plain-text-body><![CDATA[x]]></ac:plain-text-body></ac:structured-macro></ac:link-body></ac:link><ac:structured-macro ac:name="code"><ac:parameter ac:name="language">java</ac:parameter><ac:parameter ac:name="title">Outer</ac:parameter><ac:plain-text-body><![CDATA[y]]></ac:plain-text-body></ac:structured-macro>',
    legacyHtml: '<a href="#confluence-page:P" data-confluence-link="page"><pre><code class="language-java">x</code></pre></a><pre><code class="language-java">y</code></pre>',
  },
  sourcesInContainers: {
    storage: '<ac:structured-macro ac:name="info"><ac:rich-text-body><p>panel <ac:emoticon ac:name="tick" /> body</p></ac:rich-text-body></ac:structured-macro><ac:structured-macro ac:name="expand"><ac:parameter ac:name="title">More</ac:parameter><ac:rich-text-body><p>expand <ac:emoticon ac:name="cross" /> body</p></ac:rich-text-body></ac:structured-macro><ac:layout><ac:layout-section ac:type="single"><ac:layout-cell><p>layout <ac:emoticon ac:name="smile" /> cell</p></ac:layout-cell></ac:layout-section></ac:layout><ac:task-list><ac:task><ac:task-id>1</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>task <ac:emoticon ac:name="wink" /> body</ac:task-body></ac:task></ac:task-list>',
    legacyHtml: '<div class="panel-info"><p>panel  body</p></div><details data-macro-name="expand"><summary>More</summary><p>expand  body</p></details><div class="confluence-layout"><div class="confluence-layout-section" data-layout-type="single"><div class="confluence-layout-cell"><p>layout  cell</p></div></div></div><ul data-type="taskList"><li data-type="taskItem" data-checked="false">task  body</li></ul>',
  },
  taskNestedList: {
    storage: '<ac:task-list><ac:task><ac:task-id>1</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>a <ac:task-list><ac:task><ac:task-id>2</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>b</ac:task-body></ac:task></ac:task-list></ac:task-body></ac:task></ac:task-list><p>x <ac:emoticon ac:name="tick" /> y</p>',
    legacyHtml: '<ul data-type="taskList"><li data-type="taskItem" data-checked="false">a <ac:task-list><ac:task><ac:task-id>2</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>b</ac:task-body></ac:task></ac:task-list></li><li data-type="taskItem" data-checked="false">b</li></ul><p>x  y</p>',
  },
  taskInTask: {
    storage: '<ac:task-list><ac:task><ac:task-id>1</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>a <ac:task><ac:task-id>2</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>b</ac:task-body></ac:task></ac:task-body></ac:task></ac:task-list><p>x <ac:emoticon ac:name="tick" /> y</p>',
    legacyHtml: '<ul data-type="taskList"><li data-type="taskItem" data-checked="false">a <ac:task><ac:task-id>2</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>b</ac:task-body></ac:task></li><li data-type="taskItem" data-checked="false">b</li></ul><p>x  y</p>',
  },
  reboundPrefix: {
    storage: '<div xmlns:ac="urn:other"><ac:structured-macro ac:name="code"><ac:parameter ac:name="language">java</ac:parameter><ac:parameter ac:name="title">T</ac:parameter><ac:plain-text-body><![CDATA[x]]></ac:plain-text-body></ac:structured-macro></div><p>x <ac:emoticon ac:name="tick" /> y</p>',
    legacyHtml: '<div xmlns:ac="urn:other"><pre><code class="language-java">x</code></pre></div><p>x  y</p>',
  },
  redeclaredPrefix: {
    storage: '<div xmlns:ac="http://atlassian.com/content"><ac:structured-macro ac:name="code"><ac:parameter ac:name="language">java</ac:parameter><ac:parameter ac:name="title">T</ac:parameter><ac:plain-text-body><![CDATA[x]]></ac:plain-text-body></ac:structured-macro></div><p>x <ac:emoticon ac:name="tick" /> y</p>',
    legacyHtml: '<div xmlns:ac="http://atlassian.com/content"><pre><code class="language-java">x</code></pre></div><p>x  y</p>',
  },
  presentationNameBesideGenuine: {
    storage: '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">java</ac:parameter><ac:parameter ac:name="title">G</ac:parameter><ac:plain-text-body><![CDATA[x]]></ac:plain-text-body></ac:structured-macro><ac:structured-macro data-macro-name="code"><ac:parameter ac:name="title">L</ac:parameter><ac:plain-text-body><![CDATA[y]]></ac:plain-text-body></ac:structured-macro>',
    legacyHtml: '<pre><code class="language-java">x</code></pre><pre><code>y</code></pre>',
  },
  upperCaseMacro: {
    storage: '<AC:STRUCTURED-MACRO ac:name="code"><ac:parameter ac:name="title">U</ac:parameter><ac:plain-text-body><![CDATA[x]]></ac:plain-text-body></AC:STRUCTURED-MACRO><p>after</p>',
    legacyHtml: '<pre><code>x</code></pre><p>after</p>',
  },
  aliasedMacro: {
    storage: '<x:structured-macro xmlns:x="http://atlassian.com/content" x:name="code"><x:parameter x:name="title">A</x:parameter><x:plain-text-body><![CDATA[x]]></x:plain-text-body></x:structured-macro><p>after</p>',
    legacyHtml: '<x:structured-macro xmlns:x="http://atlassian.com/content" x:name="code"><x:parameter x:name="title">A</x:parameter><x:plain-text-body>x</x:plain-text-body></x:structured-macro><p>after</p>',
  },
  legacyMacroElement: {
    storage: '<ac:macro ac:name="code"><ac:parameter ac:name="title">M</ac:parameter><ac:plain-text-body><![CDATA[x]]></ac:plain-text-body></ac:macro><p>after</p>',
    legacyHtml: '<ac:macro ac:name="code"><ac:parameter ac:name="title">M</ac:parameter><ac:plain-text-body>x</ac:plain-text-body></ac:macro><p>after</p>',
  },
  commentHidesEmoticon: {
    storage: '<p>a</p><!--><ac:emoticon ac:name="smile"></ac:emoticon>--><p>b <ac:emoticon ac:name="tick" /> c</p>',
    legacyHtml: '<p>a</p><!---->--&gt;<p>b  c</p>',
  },
  piHidesEmoticon: {
    storage: '<p>a</p><?x ><ac:emoticon ac:name="smile"></ac:emoticon>?><p>b <ac:emoticon ac:name="tick" /> c</p>',
    legacyHtml: '<p>a</p><!--?x -->?&gt;<p>b  c</p>',
  },
  textareaHidesEmoticon: {
    storage: '<textarea><ac:emoticon ac:name="smile"></ac:emoticon></textarea><p>b <ac:emoticon ac:name="tick" /> c</p>',
    legacyHtml: '<textarea>&lt;ac:emoticon ac:name="smile"&gt;&lt;/ac:emoticon&gt;</textarea><p>b  c</p>',
  },
  oneHiddenFromEach: {
    storage: '<?x ><ac:emoticon ac:name="a"></ac:emoticon>?><!--><p title="--><ac:emoticon ac:name="a"></ac:emoticon><q a="x"></q>',
    legacyHtml: '<!--?x -->?&gt;<!----><p title="--><ac:emoticon ac:name=" a"=""><q a="x"></q></p>',
  },
  notWellFormed: {
    storage: '<p>a &check; <ac:emoticon ac:name="tick" /> b</p>',
    legacyHtml: '<p>a ✓  b</p>',
  },
  z1SelfClosingTitle: {
    storage: '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">js</ac:parameter><ac:parameter ac:name="title" data-x="a/b" /><ac:plain-text-body><![CDATA[x]]></ac:plain-text-body></ac:structured-macro><p>after</p>',
    legacyHtml: '<pre><code class="language-js">x</code></pre><p>after</p>',
  },
  z1ClosedTitle: {
    storage: '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">js</ac:parameter><ac:parameter ac:name="title" data-x="a/b"></ac:parameter><ac:plain-text-body><![CDATA[x]]></ac:plain-text-body></ac:structured-macro><p>after</p>',
    legacyHtml: '<pre><code class="language-js">x</code></pre><p>after</p>',
  },
  selfClosingToc: {
    storage: '<ac:structured-macro ac:name="toc" ac:schema-version="1" /><p>a <ac:emoticon ac:name="smile" /> b</p>',
    legacyHtml: '<div class="confluence-toc">[Table of Contents]</div>',
  },
  selfClosingTocControl: {
    storage: '<p>a <ac:emoticon ac:name="smile" /> b</p>',
    legacyHtml: '<p>a  b</p>',
  },
  selfClosingParagraph: {
    storage: '<p /><ac:structured-macro ac:name="code"><ac:parameter ac:name="language">java</ac:parameter><ac:parameter ac:name="title">T</ac:parameter><ac:plain-text-body><![CDATA[x]]></ac:plain-text-body></ac:structured-macro>',
    legacyHtml: '<p><pre><code class="language-java">x</code></pre></p>',
  },
  selfClosingParagraphControl: {
    storage: '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">java</ac:parameter><ac:parameter ac:name="title">T</ac:parameter><ac:plain-text-body><![CDATA[x]]></ac:plain-text-body></ac:structured-macro>',
    legacyHtml: '<pre><code class="language-java">x</code></pre>',
  },
  blogLinkBody: {
    storage: '<p>Blog <ac:link><ri:blog-post ri:content-title="News" ri:posting-day="2026/01/02" /><ac:plain-text-link-body><![CDATA[news]]></ac:plain-text-link-body></ac:link></p><p>a <ac:emoticon ac:name="smile" /> b</p>',
    legacyHtml: '<p>Blog <a>news</a></p><p>a  b</p>',
  },
  spaceLinkBody: {
    storage: '<p>Space <ac:link><ri:space ri:space-key="DOC" /><ac:plain-text-link-body><![CDATA[Docs]]></ac:plain-text-link-body></ac:link></p><p>a <ac:emoticon ac:name="smile" /> b</p>',
    legacyHtml: '<p>Space <a>Docs</a></p><p>a  b</p>',
  },
  urlLinkBody: {
    storage: '<p>Web <ac:link><ri:url ri:value="https://example.com/a" /><ac:plain-text-link-body><![CDATA[site]]></ac:plain-text-link-body></ac:link></p><p>a <ac:emoticon ac:name="smile" /> b</p>',
    legacyHtml: '<p>Web <a>site</a></p><p>a  b</p>',
  },
  resourceLinkControl: {
    storage: '<p>a <ac:emoticon ac:name="smile" /> b</p>',
    legacyHtml: '<p>a  b</p>',
  },
  endEventDiffers: {
    storage: '<p>x <ac:emoticon ac:name="tick" data-x="1/2" />swallowed</p><p>a <ac:emoticon ac:name="smile" /> b</p>',
    legacyHtml: '<p>x </p><p>a  b</p>',
  },
  rawCarrierMarkup: {
    storage: '<pre data-title="Raw"><code>raw</code></pre><p><a href="#confluence-page:P?ri:space-key=S">P</a></p><ac:structured-macro ac:name="code"><ac:parameter ac:name="language">java</ac:parameter><ac:parameter ac:name="title">Main</ac:parameter><ac:plain-text-body><![CDATA[x]]></ac:plain-text-body></ac:structured-macro><p>See <ac:link><ri:page ri:content-title="Q" ri:space-key="T" /></ac:link> now</p>',
    legacyHtml: '<pre data-title="Raw"><code>raw</code></pre><p><a href="#confluence-page:P?ri:space-key=S">P</a></p><pre><code class="language-java">x</code></pre><p>See <a href="#confluence-page:Q" data-confluence-link="page">Q</a> now</p>',
  },
  rawEmoticonSpan: {
    storage: '<p>raw <span class="confluence-emoticon" data-emoticon-attrs="{}">r</span> real <ac:emoticon ac:name="tick" /> end</p>',
    legacyHtml: '<p>raw <span class="confluence-emoticon" data-emoticon-attrs="{}">r</span> real  end</p>',
  },
  listItems: {
    storage: '<ul><li><p>A <ac:emoticon ac:name="tick" /> a</p><p>X <ac:emoticon ac:name="cross" /> x</p></li><li><p>B <ac:emoticon ac:name="smile" /> b</p></li></ul><p>P <ac:emoticon ac:name="wink" /> p</p>',
    legacyHtml: '<ul><li><p>A  a</p><p>X  x</p></li><li><p>B  b</p></li></ul><p>P  p</p>',
  },
  emptySiblingsBody: {
    storage: '<p>A <ac:emoticon ac:name="tick" /> a</p><p>X <ac:emoticon ac:name="cross" /> x</p><p></p><p>B <ac:emoticon ac:name="smile" /> b</p>',
    legacyHtml: '<p>A  a</p><p>X  x</p><p></p><p>B  b</p>',
  },
  emptySiblingsItem: {
    storage: '<ul><li><p>A <ac:emoticon ac:name="tick" /> a</p><p>X <ac:emoticon ac:name="cross" /> x</p><p></p><p>B <ac:emoticon ac:name="smile" /> b</p></li></ul>',
    legacyHtml: '<ul><li><p>A  a</p><p>X  x</p><p></p><p>B  b</p></li></ul>',
  },
  emptySiblingsCell: {
    storage: '<table><tbody><tr><td><p>A <ac:emoticon ac:name="tick" /> a</p><p>X <ac:emoticon ac:name="cross" /> x</p><p></p><p>B <ac:emoticon ac:name="smile" /> b</p></td></tr></tbody></table>',
    legacyHtml: '<table><tbody><tr><td><p>A  a</p><p>X  x</p><p></p><p>B  b</p></td></tr></tbody></table>',
  },
  aa1TrailingEmpty: {
    storage: '<p>A <ac:emoticon ac:name="tick" /> a</p><p>B b</p><p></p>',
    legacyHtml: '<p>A  a</p><p>B b</p><p></p>',
  },
  tableEnding: {
    storage: '<p>State <ac:structured-macro ac:name="status"><ac:parameter ac:name="colour">Green</ac:parameter><ac:parameter ac:name="title">OK</ac:parameter><ac:parameter ac:name="subtle">true</ac:parameter></ac:structured-macro> today</p><table><tbody><tr><td><ac:emoticon ac:name="cross" /></td><td>x</td></tr></tbody></table>',
    legacyHtml: '<p>State <span class="confluence-status" data-color="green">OK</span> today</p><table><tbody><tr><td></td><td>x</td></tr></tbody></table>',
  },
  cells: {
    storage: '<table><tbody><tr><td>one <ac:emoticon ac:name="tick" /> 1</td><td>two</td></tr><tr><td>three</td><td>four <ac:emoticon ac:name="cross" /> 4</td></tr></tbody></table><p>after <ac:emoticon ac:name="smile" /> it</p>',
    legacyHtml: '<table><tbody><tr><td>one  1</td><td>two</td></tr><tr><td>three</td><td>four  4</td></tr></tbody></table><p>after  it</p>',
  },
  listUnits: {
    storage: '<ul><li>first <ac:emoticon ac:name="tick" /> 1</li><li>second</li><li>third <ac:emoticon ac:name="cross" /> 3</li></ul>',
    legacyHtml: '<ul><li>first  1</li><li>second</li><li>third  3</li></ul>',
  },
  heading: {
    storage: '<h2>Title <ac:emoticon ac:name="tick" /> here</h2><p>body</p>',
    legacyHtml: '<h2>Title  here</h2><p>body</p>',
  },
  unsupportedParents: {
    storage: '<blockquote>quote <ac:emoticon ac:name="tick" /> text</blockquote><ac:structured-macro ac:name="section"><ac:rich-text-body>section <ac:emoticon ac:name="cross" /> text</ac:rich-text-body></ac:structured-macro>',
    legacyHtml: '<blockquote>quote  text</blockquote><div class="confluence-section">section  text</div>',
  },
  bodyText: {
    storage: 'top <ac:emoticon ac:name="tick" /> level<p>para</p>',
    legacyHtml: 'top  level<p>para</p>',
  },
  repeatedBlocks: {
    storage: '<p>same <ac:emoticon ac:name="tick" /> text</p><p>same <ac:emoticon ac:name="tick" /> text</p>',
    legacyHtml: '<p>same  text</p><p>same  text</p>',
  },
  imageLink: {
    storage: '<p><ac:link><ri:page ri:content-title="Pics" ri:space-key="ENG" /><ac:link-body><ac:image><ri:url ri:value="https://example.com/i.png" /></ac:image></ac:link-body></ac:link></p>',
    legacyHtml: '<p><a href="#confluence-page:Pics" data-confluence-link="page"><img src="https://example.com/i.png" data-confluence-image-source="external-url" data-confluence-url="https://example.com/i.png" alt="i.png"></a></p>',
  },
  nestedColumns: {
    storage: '<ac:structured-macro ac:name="column"><ac:rich-text-body><ac:structured-macro ac:name="column"><ac:rich-text-body><p>inner <ac:emoticon ac:name="tick" /> column</p></ac:rich-text-body></ac:structured-macro></ac:rich-text-body></ac:structured-macro><p>outer <ac:emoticon ac:name="smile" /> text</p>',
    legacyHtml: '<div class="confluence-column"><div class="confluence-column"><p>inner  column</p></div></div><p>outer  text</p>',
  },
  macroCap: {
    storage: '<ac:structured-macro ac:name="toc"><ac:parameter ac:name="exclude">x</ac:parameter></ac:structured-macro><ac:structured-macro ac:name="toc"><ac:parameter ac:name="exclude">x</ac:parameter></ac:structured-macro><ac:structured-macro ac:name="toc"><ac:parameter ac:name="exclude">x</ac:parameter></ac:structured-macro><ac:structured-macro ac:name="toc"><ac:parameter ac:name="exclude">x</ac:parameter></ac:structured-macro><ac:structured-macro ac:name="toc"><ac:parameter ac:name="exclude">x</ac:parameter></ac:structured-macro><ac:structured-macro ac:name="toc"><ac:parameter ac:name="exclude">x</ac:parameter></ac:structured-macro>',
    legacyHtml: '<div class="confluence-toc">[Table of Contents]</div><div class="confluence-toc">[Table of Contents]</div><div class="confluence-toc">[Table of Contents]</div><div class="confluence-toc">[Table of Contents]</div><div class="confluence-toc">[Table of Contents]</div><div class="confluence-toc">[Table of Contents]</div>',
  },
  emoticonBesideTable: {
    storage: '<p>Done <ac:emoticon ac:name="tick" /> now</p><p>Other text</p><table><tbody><tr><td>t</td></tr></tbody></table>',
    legacyHtml: '<p>Done  now</p><p>Other text</p><table><tbody><tr><td>t</td></tr></tbody></table>',
  },
  emoticonInBold: {
    storage: '<p><strong>Done <ac:emoticon ac:name="tick" /> now</strong></p><p>tail</p>',
    legacyHtml: '<p><strong>Done  now</strong></p><p>tail</p>',
  },
  codeAfterNestedPre: {
    storage: '<pre><span><code>z</code></span></pre><ac:structured-macro ac:name="code"><ac:parameter ac:name="language">java</ac:parameter><ac:parameter ac:name="title">Main</ac:parameter><ac:plain-text-body><![CDATA[x]]></ac:plain-text-body></ac:structured-macro>',
    legacyHtml: '<pre><span><code>z</code></span></pre><pre><code class="language-java">x</code></pre>',
  },
  codeBesideRawPre: {
    storage: '<p>Intro</p><ac:structured-macro ac:name="code"><ac:parameter ac:name="language">java</ac:parameter><ac:parameter ac:name="title">Main</ac:parameter><ac:plain-text-body><![CDATA[class A {}]]></ac:plain-text-body></ac:structured-macro><blockquote><pre><code class="language-java">class A {}</code></pre></blockquote>',
    legacyHtml: '<p>Intro</p><pre><code class="language-java">class A {}</code></pre><blockquote><pre><code class="language-java">class A {}</code></pre></blockquote>',
  },
  twoCodes: {
    storage: '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">java</ac:parameter><ac:parameter ac:name="title">Main</ac:parameter><ac:plain-text-body><![CDATA[x]]></ac:plain-text-body></ac:structured-macro><p>mid</p><ac:structured-macro ac:name="code"><ac:parameter ac:name="language">js</ac:parameter><ac:parameter ac:name="title">Other</ac:parameter><ac:plain-text-body><![CDATA[y]]></ac:plain-text-body></ac:structured-macro>',
    legacyHtml: '<pre><code class="language-java">x</code></pre><p>mid</p><pre><code class="language-js">y</code></pre>',
  },
  blogLinkBodyless: {
    storage: '<p>a <ac:link><ri:blog-post ri:content-title="News" ri:posting-day="2026/01/02" /></ac:link> b</p><p>c <ac:emoticon ac:name="tick" /> d</p>',
    legacyHtml: '<p>a <a></a> b</p><p>c  d</p>',
  },
  pageLinkWithNeighbour: {
    storage: '<p>See <ac:link ac:anchor="sec"><ri:page ri:content-title="My Page" ri:space-key="ENG" /><ac:plain-text-link-body><![CDATA[the page]]></ac:plain-text-link-body></ac:link>.</p><p>Other text</p>',
    legacyHtml: '<p>See <a href="#confluence-page:My Page" data-confluence-link="page">the page</a>.</p><p>Other text</p>',
  },
  emoticonAtLinkEdge: {
    storage: '<p>See <ac:link><ri:page ri:content-title="P" ri:space-key="S" /><ac:plain-text-link-body><![CDATA[the page]]></ac:plain-text-link-body></ac:link><ac:emoticon ac:name="tick" /> after</p>',
    legacyHtml: '<p>See <a href="#confluence-page:P" data-confluence-link="page">the page</a> after</p>',
  },
  evaluatedMix: {
    storage: '<p><ac:link><ri:page ri:content-title="X" ri:space-key="A" /></ac:link> and <ac:link><ri:page ri:content-title="X" ri:space-key="B" /></ac:link></p><p>Done <ac:emoticon ac:name="tick" /> now</p>',
    legacyHtml: '<p><a href="#confluence-page:X" data-confluence-link="page">X</a> and <a href="#confluence-page:X" data-confluence-link="page">X</a></p><p>Done  now</p>',
  },
  linkRejectedOnly: {
    storage: '<ac:link><ri:page ri:content-title="P" ri:space-key="S" /><ac:link-body><ac:structured-macro ac:name="expand"><ac:rich-text-body><p>x</p></ac:rich-text-body></ac:structured-macro></ac:link-body></ac:link><p>tail</p>',
    legacyHtml: '<a href="#confluence-page:P" data-confluence-link="page"><details data-macro-name="expand"><summary></summary><p>x</p></details></a><p>tail</p>',
  },
  longMarkAttribute: {
    storage: Array.from({ length: 20 }, (_, i) => `<p><strong title="${'t'.repeat(1000)}">bold</strong> <ac:emoticon ac:name="tick" /> n${i}</p>`).join(''),
    legacyHtml: Array.from({ length: 20 }, (_, i) => `<p><strong title="${'t'.repeat(1000)}">bold</strong>  n${i}</p>`).join(''),
  },
  statusThenEmoticon: {
    storage: '<p><ac:structured-macro ac:name="status"><ac:parameter ac:name="colour">Green</ac:parameter><ac:parameter ac:name="title">OK</ac:parameter><ac:parameter ac:name="subtle">true</ac:parameter></ac:structured-macro> a <ac:emoticon ac:name="tick" /> b</p>',
    legacyHtml: '<p><span class="confluence-status" data-color="green">OK</span> a  b</p>',
  },
  linkThenEmoticon: {
    storage: '<p><ac:link ac:anchor="sec"><ri:page ri:content-title="My Page" ri:space-key="ENG" /><ac:plain-text-link-body><![CDATA[the page]]></ac:plain-text-link-body></ac:link> a <ac:emoticon ac:name="tick" /> b</p>',
    legacyHtml: '<p><a href="#confluence-page:My Page" data-confluence-link="page">the page</a> a  b</p>',
  },
  emoticonGridAdjacent: {
    storage: '<table><tbody><tr><th>Name</th><th>State</th></tr><tr><td>alpha</td><td><ac:emoticon ac:name="tick" /><ac:emoticon ac:name="wink" /></td></tr><tr><td>beta</td><td><ac:emoticon ac:name="cross" /></td></tr></tbody></table>',
    legacyHtml: '<table><tbody><tr><th>Name</th><th>State</th></tr><tr><td>alpha</td><td></td></tr><tr><td>beta</td><td></td></tr></tbody></table>',
  },
  taskLeadingRun: {
    storage: '<ac:task-list><ac:task><ac:task-id>1</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>lead <ac:emoticon ac:name="tick" /> x<p>after</p></ac:task-body></ac:task></ac:task-list>',
    legacyHtml: '<ul data-type="taskList"><li data-type="taskItem" data-checked="false">lead  x<p>after</p></li></ul>',
  },
  encodedStatus: {
    storage: '<p><ac:structured-macro ac:name="statu&#115;"><ac:parameter ac:name="colour">Green</ac:parameter><ac:parameter ac:name="title">OK</ac:parameter><ac:parameter ac:name="subtle">true</ac:parameter></ac:structured-macro></p>',
    legacyHtml: '<p><span class="confluence-status" data-color="green">OK</span></p>',
  },
  encodedStatusNeutral: {
    storage: '<p>status</p><p><ac:structured-macro ac:name="statu&#115;"><ac:parameter ac:name="colour">Green</ac:parameter><ac:parameter ac:name="title">OK</ac:parameter><ac:parameter ac:name="subtle">true</ac:parameter></ac:structured-macro></p>',
    legacyHtml: '<p>status</p><p><span class="confluence-status" data-color="green">OK</span></p>',
  },
  encodedCode: {
    storage: '<p>Intro</p><ac:structured-macro ac:name="&#99;ode"><ac:parameter ac:name="language">java</ac:parameter><ac:parameter ac:name="title">Main</ac:parameter><ac:plain-text-body><![CDATA[x]]></ac:plain-text-body></ac:structured-macro>',
    legacyHtml: '<p>Intro</p><pre><code class="language-java">x</code></pre>',
  },
  encodedToc: {
    storage: '<ac:structured-macro ac:name="t&#111;c"><ac:parameter ac:name="exclude">Intro</ac:parameter></ac:structured-macro><p>after</p>',
    legacyHtml: '<div class="confluence-toc">[Table of Contents]</div><p>after</p>',
  },
  statusRun32: {
    storage: `<p>${Array.from({ length: 32 }, (_, i) => status(`S${i}`)).join(' ')}</p>`,
    legacyHtml: `<p>${Array.from({ length: 32 }, (_, i) => `<span class="confluence-status" data-color="green">S${i}</span>`).join(' ')}</p>`,
  },
  linksEquivalentBold: {
    storage: '<p><ac:link><ri:page ri:content-title="X" ri:space-key="A" /><ac:link-body><b>X</b></ac:link-body></ac:link> and <ac:link><ri:page ri:content-title="X" ri:space-key="B" /><ac:link-body><strong>X</strong></ac:link-body></ac:link></p>',
    legacyHtml: '<p><a href="#confluence-page:X" data-confluence-link="page"><b>X</b></a> and <a href="#confluence-page:X" data-confluence-link="page"><strong>X</strong></a></p>',
  },
  linksEquivalentSpan: {
    storage: '<p><ac:link><ri:page ri:content-title="X" ri:space-key="A" /><ac:link-body><span title="x" lang="en">X</span></ac:link-body></ac:link> and <ac:link><ri:page ri:content-title="X" ri:space-key="B" /><ac:link-body><span lang="en" title="x">X</span></ac:link-body></ac:link></p>',
    legacyHtml: '<p><a href="#confluence-page:X" data-confluence-link="page"><span title="x" lang="en">X</span></a> and <a href="#confluence-page:X" data-confluence-link="page"><span lang="en" title="x">X</span></a></p>',
  },
  linksIdenticalBold: {
    storage: '<p><ac:link><ri:page ri:content-title="X" ri:space-key="A" /><ac:link-body><b>X</b></ac:link-body></ac:link> and <ac:link><ri:page ri:content-title="X" ri:space-key="B" /><ac:link-body><b>X</b></ac:link-body></ac:link></p>',
    legacyHtml: '<p><a href="#confluence-page:X" data-confluence-link="page"><b>X</b></a> and <a href="#confluence-page:X" data-confluence-link="page"><b>X</b></a></p>',
  },
  linksDistinct: {
    storage: '<p><ac:link><ri:page ri:content-title="X" ri:space-key="A" /><ac:link-body><b>X</b></ac:link-body></ac:link> and <ac:link><ri:page ri:content-title="X" ri:space-key="B" /><ac:link-body><b>Y</b></ac:link-body></ac:link></p>',
    legacyHtml: '<p><a href="#confluence-page:X" data-confluence-link="page"><b>X</b></a> and <a href="#confluence-page:X" data-confluence-link="page"><b>Y</b></a></p>',
  },
  pageLinkSpaced: {
    storage: '<p>See <ac:link><ri:page ri:content-title="My Page" /></ac:link>.</p>',
    legacyHtml: '<p>See <a href="#confluence-page:My Page" data-confluence-link="page">My Page</a>.</p>',
  },
  pageLinkSpacedBody: {
    storage: '<p>See <ac:link><ri:page ri:content-title="My Page" /><ac:plain-text-link-body><![CDATA[there]]></ac:plain-text-link-body></ac:link>.</p>',
    legacyHtml: '<p>See <a href="#confluence-page:My Page" data-confluence-link="page">there</a>.</p>',
  },
  attachmentSpaced: {
    storage: '<p>See <ac:link><ri:attachment ri:filename="My File" /></ac:link>.</p>',
    legacyHtml: '<p>See <a href="#confluence-attachment:My File" data-confluence-link="attachment">My File</a>.</p>',
  },
  pageLinkPercentTitle: {
    storage: '<p>See <ac:link><ri:page ri:content-title="a%20b" /></ac:link>.</p>',
    legacyHtml: '<p>See <a href="#confluence-page:a%20b" data-confluence-link="page">a%20b</a>.</p>',
  },
  markerSpelled: {
    storage: '<p>data-cq-0123456789abcdef0123456789abcdef <ac:emoticon ac:name="tick" /> b</p>',
    legacyHtml: '<p>data-cq-0123456789abcdef0123456789abcdef  b</p>',
  },
} as const satisfies Record<string, LegacyCarrierFixture>;
