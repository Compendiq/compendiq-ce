/**
 * Base bytes of the version-restore storage derivation (#1953 PR 0, epic #2027 decision D1).
 *
 * Every `storage` literal is what `htmlToConfluence(targetHtml, { previousStorage, legacyTasks:
 * hasOnlyUncarriedTasks(storedBodyHtml) })` wrote at `origin/dev` bff6d4ec9ec3ca08642e347d19eef51059a5a4bf,
 * the commit before any storage-derivation feature of the epic. `storedBodyHtml` and a converter-shaped
 * `targetHtml` are that commit's `confluenceToHtml` output for the storage beside them.
 *
 * A restore intent reserved before the epic records no feature and is recovered by deriving these bytes again,
 * so `derivationFeatures: NO_STORAGE_DERIVATION_FEATURES` must reproduce every entry for as long as such an
 * intent can exist. A pull request that registers a feature keeps `storage-derivation.corpus.test.ts` green
 * and appends entries for the construct it changes.
 *
 * Never regenerate an entry from the current converter: capture it in a clean checkout of the base commit
 * (`git worktree add <dir> bff6d4ec9ec3ca08642e347d19eef51059a5a4bf`) by evaluating that expression there.
 */
export interface StorageDerivationBaseEntry {
  name: string;
  /** `page_versions.body_html` of the version being restored. */
  targetHtml: string;
  /** `pages.body_storage` of the live row; its tasks give the restored tasks their ids. */
  previousStorage: string | null;
  /** `pages.body_html` of the live row; only decides `legacyTasks`. */
  storedBodyHtml: string | null;
  /** The storage the base commit derives. */
  storage: string;
}

export const STORAGE_DERIVATION_BASE_CORPUS: readonly StorageDerivationBaseEntry[] = [
  {
    name: 'cell-align-raw',
    targetHtml: '<table><tbody><tr><th align="center">H</th><td align="right">1</td></tr><tr><td style="text-align: center;">2</td><td align="justify" style="color: red; text-align: left">3</td></tr></tbody></table>',
    previousStorage: null,
    storedBodyHtml: null,
    storage: '<table><tbody><tr><th align="center">H</th><td align="right">1</td></tr><tr><td style="text-align: center;">2</td><td align="justify" style="color: red; text-align: left">3</td></tr></tbody></table>',
  },
  {
    name: 'cell-align-editor-table',
    targetHtml: '<table style="min-width: 50px;"><colgroup><col style="min-width: 25px;"><col style="min-width: 25px;"></colgroup><tbody><tr><th colspan="1" rowspan="1" align="center"><p>a</p></th><th colspan="1" rowspan="1"><p>b</p></th></tr><tr><td colspan="1" rowspan="1" style="text-align: right;"><p>1</p></td><td colspan="2" rowspan="1" align="left"><p>2</p></td></tr></tbody></table>',
    previousStorage: null,
    storedBodyHtml: null,
    storage: '<table style="min-width: 50px;"><colgroup><col style="min-width: 25px;" /><col style="min-width: 25px;" /></colgroup><tbody><tr><th colspan="1" rowspan="1" align="center"><p>a</p></th><th colspan="1" rowspan="1"><p>b</p></th></tr><tr><td colspan="1" rowspan="1" style="text-align: right;"><p>1</p></td><td colspan="2" rowspan="1" align="left"><p>2</p></td></tr></tbody></table>',
  },
  {
    name: 'link-carriers-hand-written',
    targetHtml: '<p><a href="#confluence-space:ENG">s</a> <a href="#confluence-blog-post:News?ri:posting-day=2026%2F01%2F02">b</a> <a href="#confluence-shortcut:jira?ri:parameter=ABC-1">j</a> <a href="#confluence-content-entity:123">c</a> <a href="#confluence-url:javascript%3Aalert%281%29">u</a> <a href="#confluence-url:">empty</a> <a target="_blank" rel="noopener noreferrer nofollow" class="#confluence-url:https%3A%2F%2Fexample.com%2Fx" href="https://example.com/x">n</a> <a href="https://example.com/y" class="#confluence-url:https%3A%2F%2Fexample.com%2Fother">mismatch</a></p>',
    previousStorage: null,
    storedBodyHtml: null,
    storage: '<p><a href="#confluence-space:ENG">s</a> <a href="#confluence-blog-post:News?ri:posting-day=2026%2F01%2F02">b</a> <a href="#confluence-shortcut:jira?ri:parameter=ABC-1">j</a> <a href="#confluence-content-entity:123">c</a> <a href="#confluence-url:javascript%3Aalert%281%29">u</a> <a href="#confluence-url:">empty</a> <a target="_blank" rel="noopener noreferrer nofollow" class="#confluence-url:https%3A%2F%2Fexample.com%2Fx" href="https://example.com/x">n</a> <a href="https://example.com/y" class="#confluence-url:https%3A%2F%2Fexample.com%2Fother">mismatch</a></p>',
  },
  {
    name: 'link-carriers-1748',
    targetHtml: '<p><a href="#confluence-page:My%20Page?ri:space-key=ENG&amp;ac:anchor=sec&amp;body=plain">the page</a> <a href="#confluence-attachment:a.pdf?page.ri:content-title=Other">a.pdf</a> <a href="#confluence-anchor:top?body=plain">to top</a> <a href="#confluence-page:Legacy Title" data-confluence-link="page">legacy</a> <a>no href</a> <a href="https://example.com/">plain</a></p>',
    previousStorage: null,
    storedBodyHtml: null,
    storage: '<p><ac:link ac:anchor="sec"><ri:page ri:content-title="My Page" ri:space-key="ENG"></ri:page><ac:plain-text-link-body><![CDATA[the page]]></ac:plain-text-link-body></ac:link> <ac:link><ri:attachment ri:filename="a.pdf"><ri:page ri:content-title="Other"></ri:page></ri:attachment></ac:link> <ac:link ac:anchor="top"><ac:plain-text-link-body><![CDATA[to top]]></ac:plain-text-link-body></ac:link> <ac:link><ri:page ri:content-title="Legacy Title"></ri:page><ac:plain-text-link-body><![CDATA[legacy]]></ac:plain-text-link-body></ac:link> <a>no href</a> <a href="https://example.com/">plain</a></p>',
  },
  {
    name: 'linked-image',
    targetHtml: '<p><a href="#confluence-page:Home"><img src="/api/attachments/123/a.png" alt="a.png" data-confluence-image-source="attachment" data-confluence-filename="a.png"></a></p><a target="_blank" rel="noopener noreferrer nofollow" href="https://example.com/"><img src="/api/attachments/123/a.png" alt="a.png" data-confluence-image-source="attachment" data-confluence-filename="a.png"></a><p><a href="#confluence-url:https%3A%2F%2Fexample.com%2Fz"><img src="/api/attachments/123/a.png" alt="a.png" data-confluence-image-source="attachment" data-confluence-filename="a.png"></a></p>',
    previousStorage: null,
    storedBodyHtml: null,
    storage: '<p><ac:link><ri:page ri:content-title="Home"></ri:page><ac:link-body><ac:image><ri:attachment ri:filename="a.png"></ri:attachment></ac:image></ac:link-body></ac:link></p><a target="_blank" rel="noopener noreferrer nofollow" href="https://example.com/"><ac:image><ri:attachment ri:filename="a.png"></ri:attachment></ac:image></a><p><a href="#confluence-url:https%3A%2F%2Fexample.com%2Fz"><ac:image><ri:attachment ri:filename="a.png"></ri:attachment></ac:image></a></p>',
  },
  {
    name: 'linked-code',
    targetHtml: '<p><a href="#confluence-page:Home"><code>x()</code></a> and <a href="https://example.com/"><code>y</code> tail</a> and <code><a href="#confluence-page:Home">z</a></code></p>',
    previousStorage: null,
    storedBodyHtml: null,
    storage: '<p><ac:link><ri:page ri:content-title="Home"></ri:page><ac:link-body><code>x()</code></ac:link-body></ac:link> and <a href="https://example.com/"><code>y</code> tail</a> and <code><ac:link><ri:page ri:content-title="Home"></ri:page><ac:plain-text-link-body><![CDATA[z]]></ac:plain-text-link-body></ac:link></code></p>',
  },
  {
    name: 'link-across-line-break',
    targetHtml: '<p><a href="#confluence-page:Home">one</a><br><a href="#confluence-page:Home">two</a></p><p><a href="#confluence-page:Home">one<br>two</a></p><p><a href="https://example.com/">a</a><br><a href="https://example.com/">b</a></p>',
    previousStorage: null,
    storedBodyHtml: null,
    storage: '<p><ac:link><ri:page ri:content-title="Home"></ri:page><ac:plain-text-link-body><![CDATA[one]]></ac:plain-text-link-body></ac:link><br /><ac:link><ri:page ri:content-title="Home"></ri:page><ac:plain-text-link-body><![CDATA[two]]></ac:plain-text-link-body></ac:link></p><p><ac:link><ri:page ri:content-title="Home"></ri:page><ac:link-body>one<br />two</ac:link-body></ac:link></p><p><a href="https://example.com/">a</a><br /><a href="https://example.com/">b</a></p>',
  },
  {
    name: 'code-annotated',
    targetHtml: '<pre data-title="Main" data-macro-params="{&quot;linenumbers&quot;:&quot;true&quot;}"><code class="language-java">class A {}</code></pre><pre><code>plain\n</code></pre><pre data-title="Only title"><code class="language-mermaid">graph TD; A--&gt;B</code></pre>',
    previousStorage: null,
    storedBodyHtml: null,
    storage: '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">java</ac:parameter><ac:parameter ac:name="title">Main</ac:parameter><ac:parameter ac:name="linenumbers">true</ac:parameter><ac:plain-text-body><![CDATA[class A {}]]></ac:plain-text-body></ac:structured-macro><ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[plain\n]]></ac:plain-text-body></ac:structured-macro><ac:structured-macro ac:name="code"><ac:parameter ac:name="language">mermaid</ac:parameter><ac:parameter ac:name="title">Only title</ac:parameter><ac:plain-text-body><![CDATA[graph TD; A-->B]]></ac:plain-text-body></ac:structured-macro>',
  },
  {
    name: 'emoticons',
    targetHtml: '<p>Done <span class="confluence-emoticon" data-emoticon-attrs="{&quot;ac:name&quot;:&quot;tick&quot;}" data-emoticon-label="✅" role="img" aria-label="tick"></span> now</p><p><span class="confluence-emoticon" data-emoticon-label="x">raw</span></p>',
    previousStorage: null,
    storedBodyHtml: null,
    storage: '<p>Done <ac:emoticon ac:name="tick" /> now</p><p>x</p>',
  },
  {
    name: 'macros-converter-shaped',
    targetHtml: '<details data-macro-name="expand"><summary>More</summary><p>Inside <span class="confluence-emoticon" data-emoticon-attrs="{&quot;ac:name&quot;:&quot;tick&quot;}" data-emoticon-label="✅" role="img" aria-label="tick"></span></p><pre data-title="Main" data-macro-params="{&quot;linenumbers&quot;:&quot;true&quot;}"><code class="language-java">class A {}</code></pre></details><div class="confluence-toc" data-maxlevel="3" data-macro-params="{&quot;exclude&quot;:&quot;Intro&quot;}">[Table of Contents]</div><div class="panel-info"><p>Note <span class="confluence-status" data-color="green" data-macro-params="{&quot;subtle&quot;:&quot;true&quot;}">OK</span></p></div><p>See <a href="#confluence-page:My%20Page?ac:anchor=sec&amp;ri:space-key=ENG" data-confluence-link="page">the page</a> and <a href="#confluence-attachment:a.pdf?page.ri:content-title=Other" data-confluence-link="attachment">a.pdf</a>.</p><table><tbody><tr><th style="text-align: center;">H</th><td>1</td></tr></tbody></table>',
    previousStorage: '<ac:structured-macro ac:name="expand"><ac:parameter ac:name="title">More</ac:parameter><ac:rich-text-body><p>Inside <ac:emoticon ac:name="tick" /></p><ac:structured-macro ac:name="code"><ac:parameter ac:name="language">java</ac:parameter><ac:parameter ac:name="title">Main</ac:parameter><ac:parameter ac:name="linenumbers">true</ac:parameter><ac:plain-text-body><![CDATA[class A {}]]></ac:plain-text-body></ac:structured-macro></ac:rich-text-body></ac:structured-macro><ac:structured-macro ac:name="toc"><ac:parameter ac:name="maxLevel">3</ac:parameter><ac:parameter ac:name="exclude">Intro</ac:parameter></ac:structured-macro><ac:structured-macro ac:name="info"><ac:rich-text-body><p>Note <ac:structured-macro ac:name="status"><ac:parameter ac:name="colour">Green</ac:parameter><ac:parameter ac:name="title">OK</ac:parameter><ac:parameter ac:name="subtle">true</ac:parameter></ac:structured-macro></p></ac:rich-text-body></ac:structured-macro><p>See <ac:link ac:anchor="sec"><ri:page ri:content-title="My Page" ri:space-key="ENG" /><ac:plain-text-link-body><![CDATA[the page]]></ac:plain-text-link-body></ac:link> and <ac:link><ri:attachment ri:filename="a.pdf"><ri:page ri:content-title="Other" /></ri:attachment></ac:link>.</p><table><tbody><tr><th style="text-align: center;">H</th><td>1</td></tr></tbody></table>',
    storedBodyHtml: '<details data-macro-name="expand"><summary>More</summary><p>Inside <span class="confluence-emoticon" data-emoticon-attrs="{&quot;ac:name&quot;:&quot;tick&quot;}" data-emoticon-label="✅" role="img" aria-label="tick"></span></p><pre data-title="Main" data-macro-params="{&quot;linenumbers&quot;:&quot;true&quot;}"><code class="language-java">class A {}</code></pre></details><div class="confluence-toc" data-maxlevel="3" data-macro-params="{&quot;exclude&quot;:&quot;Intro&quot;}">[Table of Contents]</div><div class="panel-info"><p>Note <span class="confluence-status" data-color="green" data-macro-params="{&quot;subtle&quot;:&quot;true&quot;}">OK</span></p></div><p>See <a href="#confluence-page:My%20Page?ac:anchor=sec&amp;ri:space-key=ENG" data-confluence-link="page">the page</a> and <a href="#confluence-attachment:a.pdf?page.ri:content-title=Other" data-confluence-link="attachment">a.pdf</a>.</p><table><tbody><tr><th style="text-align: center;">H</th><td>1</td></tr></tbody></table>',
    storage: '<ac:structured-macro ac:name="expand"><ac:parameter ac:name="title">More</ac:parameter><ac:rich-text-body><p>Inside <ac:emoticon ac:name="tick" /></p><ac:structured-macro ac:name="code"><ac:parameter ac:name="language">java</ac:parameter><ac:parameter ac:name="title">Main</ac:parameter><ac:parameter ac:name="linenumbers">true</ac:parameter><ac:plain-text-body><![CDATA[class A {}]]></ac:plain-text-body></ac:structured-macro></ac:rich-text-body></ac:structured-macro><ac:structured-macro ac:name="toc"><ac:parameter ac:name="maxLevel">3</ac:parameter><ac:parameter ac:name="exclude">Intro</ac:parameter></ac:structured-macro><ac:structured-macro ac:name="info"><ac:rich-text-body><p>Note <ac:structured-macro ac:name="status"><ac:parameter ac:name="colour">Green</ac:parameter><ac:parameter ac:name="title">OK</ac:parameter><ac:parameter ac:name="subtle">true</ac:parameter></ac:structured-macro></p></ac:rich-text-body></ac:structured-macro><p>See <ac:link ac:anchor="sec"><ri:page ri:content-title="My Page" ri:space-key="ENG"></ri:page><ac:plain-text-link-body><![CDATA[the page]]></ac:plain-text-link-body></ac:link> and <ac:link><ri:attachment ri:filename="a.pdf"><ri:page ri:content-title="Other"></ri:page></ri:attachment></ac:link>.</p><table><tbody><tr><th style="text-align: center;">H</th><td>1</td></tr></tbody></table>',
  },
  {
    name: 'tasks-nested-idless-target',
    targetHtml: '<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>Parent</p><ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>Child</p></li></ul></li><li data-type="taskItem" data-checked="false"><p>Sibling</p></li><li data-type="taskItem" data-checked="false"><p>New</p></li></ul>',
    previousStorage: '<ac:task-list><ac:task><ac:task-id>1</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>Parent <ac:task-list><ac:task><ac:task-id>2</ac:task-id><ac:task-status>complete</ac:task-status><ac:task-body>Child</ac:task-body></ac:task></ac:task-list></ac:task-body></ac:task><ac:task><ac:task-id>3</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>Sibling</ac:task-body></ac:task></ac:task-list>',
    storedBodyHtml: '<ul data-type="taskList"><li data-type="taskItem" data-checked="false" data-task-id="1">Parent <ac:task-list><ac:task><ac:task-id>2</ac:task-id><ac:task-status>complete</ac:task-status><ac:task-body>Child</ac:task-body></ac:task></ac:task-list></li><li data-type="taskItem" data-checked="true" data-task-id="2">Child</li><li data-type="taskItem" data-checked="false" data-task-id="3">Sibling</li></ul>',
    storage: '<ac:task-list><ac:task><ac:task-id>1</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body><p>Parent</p><ac:task-list><ac:task><ac:task-id>2</ac:task-id><ac:task-status>complete</ac:task-status><ac:task-body><p>Child</p></ac:task-body></ac:task></ac:task-list></ac:task-body></ac:task><ac:task><ac:task-id>3</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body><p>Sibling</p></ac:task-body></ac:task><ac:task><ac:task-id>4</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body><p>New</p></ac:task-body></ac:task></ac:task-list>',
  },
  {
    name: 'tasks-nested-converter-shaped-target',
    targetHtml: '<ul data-type="taskList"><li data-type="taskItem" data-checked="false" data-task-id="1">Parent <ac:task-list><ac:task><ac:task-id>2</ac:task-id><ac:task-status>complete</ac:task-status><ac:task-body>Child</ac:task-body></ac:task></ac:task-list></li><li data-type="taskItem" data-checked="true" data-task-id="2">Child</li><li data-type="taskItem" data-checked="false" data-task-id="3">Sibling</li></ul>',
    previousStorage: '<ac:task-list><ac:task><ac:task-id>1</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>Parent <ac:task-list><ac:task><ac:task-id>2</ac:task-id><ac:task-status>complete</ac:task-status><ac:task-body>Child</ac:task-body></ac:task></ac:task-list></ac:task-body></ac:task><ac:task><ac:task-id>3</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>Sibling</ac:task-body></ac:task></ac:task-list>',
    storedBodyHtml: '<ul data-type="taskList"><li data-type="taskItem" data-checked="false" data-task-id="1">Parent <ac:task-list><ac:task><ac:task-id>2</ac:task-id><ac:task-status>complete</ac:task-status><ac:task-body>Child</ac:task-body></ac:task></ac:task-list></li><li data-type="taskItem" data-checked="true" data-task-id="2">Child</li><li data-type="taskItem" data-checked="false" data-task-id="3">Sibling</li></ul>',
    storage: '<ac:task-list><ac:task><ac:task-id>1</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>Parent <ac:task-list><ac:task><ac:task-id>2</ac:task-id><ac:task-status>complete</ac:task-status><ac:task-body>Child</ac:task-body></ac:task></ac:task-list></ac:task-body></ac:task><ac:task><ac:task-id>4</ac:task-id><ac:task-status>complete</ac:task-status><ac:task-body>Child</ac:task-body></ac:task><ac:task><ac:task-id>3</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>Sibling</ac:task-body></ac:task></ac:task-list>',
  },
  {
    name: 'tasks-nested-list-before-own-text',
    targetHtml: '<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>own text</p></li><li data-type="taskItem" data-checked="false"><p>nested first</p></li><li data-type="taskItem" data-checked="false"><p>nested firstown text</p></li></ul>',
    previousStorage: '<ac:task-list><ac:task><ac:task-id>4</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body><ac:task-list><ac:task><ac:task-id>5</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>nested first</ac:task-body></ac:task></ac:task-list>own text</ac:task-body></ac:task></ac:task-list>',
    storedBodyHtml: '<ul data-type="taskList"><li data-type="taskItem" data-checked="false" data-task-id="4"><ac:task-list><ac:task><ac:task-id>5</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>nested first</ac:task-body></ac:task></ac:task-list>own text</li><li data-type="taskItem" data-checked="false" data-task-id="5">nested first</li></ul>',
    storage: '<ac:task-list><ac:task><ac:task-id>4</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body><p>own text</p></ac:task-body></ac:task><ac:task><ac:task-id>5</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body><p>nested first</p></ac:task-body></ac:task><ac:task><ac:task-id>6</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body><p>nested firstown text</p></ac:task-body></ac:task></ac:task-list>',
  },
  {
    name: 'tasks-three-levels-with-macro',
    targetHtml: '<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>L1</p><ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>L2</p><ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>L3 <span class="confluence-status" data-color="green">OK</span></p></li></ul></li><li data-type="taskItem" data-checked="false"><p>L2 second</p></li></ul></li></ul>',
    previousStorage: '<ac:task-list><ac:task><ac:task-id>10</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>L1 <ac:task-list><ac:task><ac:task-id>11</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>L2 <ac:task-list><ac:task><ac:task-id>12</ac:task-id><ac:task-status>complete</ac:task-status><ac:task-body>L3 <ac:structured-macro ac:name="status"><ac:parameter ac:name="colour">Green</ac:parameter><ac:parameter ac:name="title">OK</ac:parameter></ac:structured-macro></ac:task-body></ac:task></ac:task-list></ac:task-body></ac:task><ac:task><ac:task-id>13</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>L2 second</ac:task-body></ac:task></ac:task-list></ac:task-body></ac:task></ac:task-list>',
    storedBodyHtml: '<ul data-type="taskList"><li data-type="taskItem" data-checked="false" data-task-id="10">L1 <ac:task-list><ac:task><ac:task-id>11</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>L2 <ac:task-list><ac:task><ac:task-id>12</ac:task-id><ac:task-status>complete</ac:task-status><ac:task-body>L3 <span class="confluence-status" data-color="green">OK</span></ac:task-body></ac:task></ac:task-list></ac:task-body></ac:task><ac:task><ac:task-id>13</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>L2 second</ac:task-body></ac:task></ac:task-list></li><li data-type="taskItem" data-checked="false" data-task-id="11">L2 <ac:task-list><ac:task><ac:task-id>12</ac:task-id><ac:task-status>complete</ac:task-status><ac:task-body>L3 <span class="confluence-status" data-color="green">OK</span></ac:task-body></ac:task></ac:task-list></li><li data-type="taskItem" data-checked="true" data-task-id="12">L3 <span class="confluence-status" data-color="green">OK</span></li><li data-type="taskItem" data-checked="false" data-task-id="13">L2 second</li></ul>',
    storage: '<ac:task-list><ac:task><ac:task-id>10</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body><p>L1</p><ac:task-list><ac:task><ac:task-id>11</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body><p>L2</p><ac:task-list><ac:task><ac:task-id>12</ac:task-id><ac:task-status>complete</ac:task-status><ac:task-body><p>L3 <ac:structured-macro ac:name="status"><ac:parameter ac:name="colour">Green</ac:parameter><ac:parameter ac:name="title">OK</ac:parameter></ac:structured-macro></p></ac:task-body></ac:task></ac:task-list></ac:task-body></ac:task><ac:task><ac:task-id>13</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body><p>L2 second</p></ac:task-body></ac:task></ac:task-list></ac:task-body></ac:task></ac:task-list>',
  },
  {
    name: 'tasks-legacy-uncarried-order-pairing',
    targetHtml: '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>Parent edited</p></li><li data-type="taskItem" data-checked="false"><p>Child edited</p></li><li data-type="taskItem" data-checked="false"><p>Sibling</p></li></ul>',
    previousStorage: '<ac:task-list><ac:task><ac:task-id>1</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>Parent <ac:task-list><ac:task><ac:task-id>2</ac:task-id><ac:task-status>complete</ac:task-status><ac:task-body>Child</ac:task-body></ac:task></ac:task-list></ac:task-body></ac:task><ac:task><ac:task-id>3</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>Sibling</ac:task-body></ac:task></ac:task-list>',
    storedBodyHtml: '<ul data-type="taskList"><li data-type="taskItem" data-checked="false">Parent</li><li data-type="taskItem" data-checked="true">Child</li><li data-type="taskItem" data-checked="false">Sibling</li></ul>',
    storage: '<ac:task-list><ac:task><ac:task-id>1</ac:task-id><ac:task-status>complete</ac:task-status><ac:task-body><p>Parent edited</p></ac:task-body></ac:task><ac:task><ac:task-id>2</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body><p>Child edited</p></ac:task-body></ac:task><ac:task><ac:task-id>3</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body><p>Sibling</p></ac:task-body></ac:task></ac:task-list>',
  },
  {
    name: 'task-text-from-bodyless-links',
    targetHtml: '<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>Read</p></li><li data-type="taskItem" data-checked="true"><p>See and site</p></li><li data-type="taskItem" data-checked="false"><p>Read Q3</p></li><li data-type="taskItem" data-checked="false"><p>See ENG and site</p></li></ul>',
    previousStorage: '<ac:task-list><ac:task><ac:task-id>7</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>Read <ac:link><ri:blog-post ri:content-title="Q3" ri:posting-day="2026/01/02" /></ac:link></ac:task-body></ac:task><ac:task><ac:task-id>8</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>See <ac:link><ri:space ri:space-key="ENG" /></ac:link> and <ac:link><ri:url ri:value="https://example.com/a" /><ac:plain-text-link-body><![CDATA[site]]></ac:plain-text-link-body></ac:link></ac:task-body></ac:task></ac:task-list>',
    storedBodyHtml: '<ul data-type="taskList"><li data-type="taskItem" data-checked="false" data-task-id="7">Read <a></a></li><li data-type="taskItem" data-checked="false" data-task-id="8">See <a></a> and <a>site</a></li></ul>',
    storage: '<ac:task-list><ac:task><ac:task-id>7</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body><p>Read</p></ac:task-body></ac:task><ac:task><ac:task-id>8</ac:task-id><ac:task-status>complete</ac:task-status><ac:task-body><p>See and site</p></ac:task-body></ac:task><ac:task><ac:task-id>9</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body><p>Read Q3</p></ac:task-body></ac:task><ac:task><ac:task-id>10</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body><p>See ENG and site</p></ac:task-body></ac:task></ac:task-list>',
  },
  {
    name: 'generated-index-plain',
    targetHtml: '<h2>Figures</h2><p>Body text</p>',
    previousStorage: null,
    storedBodyHtml: null,
    storage: '<h2>Figures</h2><p>Body text</p>',
  },
  {
    name: 'generated-index-with-figure-index',
    targetHtml: '<h2>Figures</h2><div class="figure-index"><ol><li>Figure 1</li></ol></div><p>Body text</p><div class="table-index"><ol><li>Table 1</li></ol></div>',
    previousStorage: null,
    storedBodyHtml: null,
    storage: '<h2>Figures</h2><p>Body text</p>',
  },
  {
    name: 'combined-restore-target',
    targetHtml: '<table><tbody><tr><th align="center">H</th><td align="right">1</td></tr></tbody></table><ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>Parent</p></li><li data-type="taskItem" data-checked="false"><p>Read</p></li></ul><p>See <a href="#confluence-page:My%20Page?ri:space-key=ENG">the page</a>, <a href="#confluence-space:ENG">a space</a> and <a href="#confluence-page:Home"><img src="/api/attachments/123/a.png" alt="a.png" data-confluence-image-source="attachment" data-confluence-filename="a.png"></a>.</p><pre data-title="Main"><code class="language-java">class A {}</code></pre>',
    previousStorage: '<ac:task-list><ac:task><ac:task-id>1</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>Parent <ac:task-list><ac:task><ac:task-id>2</ac:task-id><ac:task-status>complete</ac:task-status><ac:task-body>Child</ac:task-body></ac:task></ac:task-list></ac:task-body></ac:task><ac:task><ac:task-id>3</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>Sibling</ac:task-body></ac:task></ac:task-list><ac:task-list><ac:task><ac:task-id>7</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>Read <ac:link><ri:blog-post ri:content-title="Q3" ri:posting-day="2026/01/02" /></ac:link></ac:task-body></ac:task><ac:task><ac:task-id>8</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>See <ac:link><ri:space ri:space-key="ENG" /></ac:link> and <ac:link><ri:url ri:value="https://example.com/a" /><ac:plain-text-link-body><![CDATA[site]]></ac:plain-text-link-body></ac:link></ac:task-body></ac:task></ac:task-list><p><ac:link><ri:page ri:content-title="My Page" ri:space-key="ENG" /></ac:link></p>',
    storedBodyHtml: '<ul data-type="taskList"><li data-type="taskItem" data-checked="false" data-task-id="1">Parent <ac:task-list><ac:task><ac:task-id>2</ac:task-id><ac:task-status>complete</ac:task-status><ac:task-body>Child</ac:task-body></ac:task></ac:task-list></li><li data-type="taskItem" data-checked="true" data-task-id="2">Child</li><li data-type="taskItem" data-checked="false" data-task-id="3">Sibling</li></ul><ul data-type="taskList"><li data-type="taskItem" data-checked="false" data-task-id="7">Read <a></a></li><li data-type="taskItem" data-checked="false" data-task-id="8">See <a></a> and <a>site</a></li></ul><p><a href="#confluence-page:My%20Page?ri:space-key=ENG" data-confluence-link="page">My Page</a></p>',
    storage: '<table><tbody><tr><th align="center">H</th><td align="right">1</td></tr></tbody></table><ac:task-list><ac:task><ac:task-id>1</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body><p>Parent</p></ac:task-body></ac:task><ac:task><ac:task-id>7</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body><p>Read</p></ac:task-body></ac:task></ac:task-list><p>See <ac:link><ri:page ri:content-title="My Page" ri:space-key="ENG"></ri:page><ac:plain-text-link-body><![CDATA[the page]]></ac:plain-text-link-body></ac:link>, <a href="#confluence-space:ENG">a space</a> and <ac:link><ri:page ri:content-title="Home"></ri:page><ac:link-body><ac:image><ri:attachment ri:filename="a.png"></ri:attachment></ac:image></ac:link-body></ac:link>.</p><ac:structured-macro ac:name="code"><ac:parameter ac:name="language">java</ac:parameter><ac:parameter ac:name="title">Main</ac:parameter><ac:plain-text-body><![CDATA[class A {}]]></ac:plain-text-body></ac:structured-macro>',
  },
  {
    name: 'cell-align-marked-gfm-table',
    targetHtml: '<table>\n<thead>\n<tr>\n<th align="left">a</th>\n<th align="center">b</th>\n<th align="right">c</th>\n<th>d</th>\n</tr>\n</thead>\n<tbody><tr>\n<td align="left">1</td>\n<td align="center">2</td>\n<td align="right">3</td>\n<td>4</td>\n</tr>\n</tbody></table>\n',
    previousStorage: null,
    storedBodyHtml: null,
    storage: '<table>\n<thead>\n<tr>\n<th align="left">a</th>\n<th align="center">b</th>\n<th align="right">c</th>\n<th>d</th>\n</tr>\n</thead>\n<tbody><tr>\n<td align="left">1</td>\n<td align="center">2</td>\n<td align="right">3</td>\n<td>4</td>\n</tr>\n</tbody></table>\n',
  },
  {
    name: 'cell-align-confluence-stored',
    targetHtml: '<table class="wrapped"><colgroup><col><col></colgroup><tbody><tr><th class="confluenceTh" style="text-align: center;">H</th><th class="confluenceTh">I</th></tr><tr><td class="confluenceTd" style="text-align: right; background-color: rgb(1, 2, 3);" colspan="1" data-highlight-colour="red">x</td><td class="confluenceTd">y</td></tr></tbody></table>',
    previousStorage: null,
    storedBodyHtml: null,
    storage: '<table class="wrapped"><colgroup><col /><col /></colgroup><tbody><tr><th class="confluenceTh" style="text-align: center;">H</th><th class="confluenceTh">I</th></tr><tr><td class="confluenceTd" style="text-align: right; background-color: rgb(1, 2, 3);" colspan="1" data-highlight-colour="red">x</td><td class="confluenceTd">y</td></tr></tbody></table>',
  },
  {
    name: 'cell-align-style-forms',
    targetHtml: '<table><tbody><tr><th align="center" style="text-align: justify">a</th><th align="left" style="TEXT-ALIGN: right">b</th><th align="right" style="color: red">c</th></tr><tr><td align="center" style="text-align: left; text-align: right">1</td><td align="left" style="--x: \'text-align: center\'">2</td><td align=" Right ">3</td></tr></tbody></table>',
    previousStorage: null,
    storedBodyHtml: null,
    storage: '<table><tbody><tr><th align="center" style="text-align: justify">a</th><th align="left" style="TEXT-ALIGN: right">b</th><th align="right" style="color: red">c</th></tr><tr><td align="center" style="text-align: left; text-align: right">1</td><td align="left" style="--x: \'text-align: center\'">2</td><td align=" Right ">3</td></tr></tbody></table>',
  },
  {
    name: 'cell-align-in-panel',
    targetHtml: '<div class="panel-info"><table><tbody><tr><th align="center"><p>H</p></th></tr><tr><td align="center"><p>x</p></td></tr></tbody></table></div>',
    previousStorage: null,
    storedBodyHtml: null,
    storage: '<ac:structured-macro ac:name="info"><ac:rich-text-body><table><tbody><tr><th align="center"><p>H</p></th></tr><tr><td align="center"><p>x</p></td></tr></tbody></table></ac:rich-text-body></ac:structured-macro>',
  },
];
