/**
 * Representative Confluence Data Center 9.2 XHTML storage format fixtures.
 * These cover all macro types handled by content-converter.ts.
 */

/** Simple page with headings, paragraphs, and inline formatting */
export const SIMPLE_PAGE = `<h1>Getting Started Guide</h1>
<p>Welcome to the <strong>Knowledge Base</strong>. This guide covers the <em>basics</em> of using our platform.</p>
<h2>Prerequisites</h2>
<p>You need <code>Node.js 22</code> and <a href="https://docker.com">Docker</a> installed.</p>
<h3>Optional Tools</h3>
<ul>
<li>VS Code with ESLint extension</li>
<li>Postman for API testing</li>
</ul>`;

/** Page with code blocks (ac:structured-macro[name=code]) */
export const CODE_BLOCK_PAGE = `<h2>Installation</h2>
<p>Run the following command:</p>
<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">bash</ac:parameter><ac:plain-text-body><![CDATA[npm install
npm run dev]]></ac:plain-text-body></ac:structured-macro>
<p>Then configure TypeScript:</p>
<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">typescript</ac:parameter><ac:plain-text-body><![CDATA[interface Config {
  port: number;
  host: string;
}]]></ac:plain-text-body></ac:structured-macro>`;

/** Page with task lists (ac:task-list / ac:task) */
export const TASK_LIST_PAGE = `<h2>Sprint Checklist</h2>
<ac:task-list>
<ac:task>
<ac:task-id>1</ac:task-id>
<ac:task-status>complete</ac:task-status>
<ac:task-body>Set up CI pipeline</ac:task-body>
</ac:task>
<ac:task>
<ac:task-id>2</ac:task-id>
<ac:task-status>incomplete</ac:task-status>
<ac:task-body>Write integration tests</ac:task-body>
</ac:task>
<ac:task>
<ac:task-id>3</ac:task-id>
<ac:task-status>incomplete</ac:task-status>
<ac:task-body>Deploy to <strong>staging</strong></ac:task-body>
</ac:task>
</ac:task-list>`;

/** Page with panels (info, warning, note, tip) */
export const PANELS_PAGE = `<h2>Deployment Notes</h2>
<ac:structured-macro ac:name="info"><ac:rich-text-body><p>This service requires PostgreSQL 17 with pgvector.</p></ac:rich-text-body></ac:structured-macro>
<ac:structured-macro ac:name="warning"><ac:rich-text-body><p>Never run migrations on production without a backup.</p></ac:rich-text-body></ac:structured-macro>
<ac:structured-macro ac:name="note"><ac:rich-text-body><p>Redis is optional for development.</p></ac:rich-text-body></ac:structured-macro>
<ac:structured-macro ac:name="tip"><ac:rich-text-body><p>Use <code>docker compose up -d</code> for background services.</p></ac:rich-text-body></ac:structured-macro>`;

/** Page with expand macros */
export const EXPAND_PAGE = `<h2>FAQ</h2>
<ac:structured-macro ac:name="expand"><ac:parameter ac:name="title">How do I reset my password?</ac:parameter><ac:rich-text-body><p>Go to Settings &gt; Account &gt; Change Password.</p></ac:rich-text-body></ac:structured-macro>
<ac:structured-macro ac:name="expand"><ac:parameter ac:name="title">What models are supported?</ac:parameter><ac:rich-text-body><p>Any model available on the shared Ollama server. Default is <strong>qwen3.5</strong>.</p></ac:rich-text-body></ac:structured-macro>`;

/** Page with Confluence internal links (ac:link / ri:page) */
export const LINKS_PAGE = `<h2>Related Pages</h2>
<p>See the <ac:link><ri:page ri:content-title="Architecture Overview" /><ac:plain-text-link-body><![CDATA[Architecture Overview]]></ac:plain-text-link-body></ac:link> for details.</p>
<p>Download the <ac:link><ri:attachment ri:filename="report.pdf" /><ac:plain-text-link-body><![CDATA[quarterly report]]></ac:plain-text-link-body></ac:link>.</p>`;

/** Page with images (ac:image with ri:attachment and ri:url) */
export const IMAGES_PAGE = `<h2>Screenshots</h2>
<p>Dashboard view:</p>
<ac:image ac:width="600"><ri:attachment ri:filename="dashboard.png" /></ac:image>
<p>External diagram:</p>
<ac:image><ri:url ri:value="https://example.com/diagram.svg" /></ac:image>`;

/** Page with cross-page attachment images and rich link-body images */
export const CROSS_PAGE_IMAGES_PAGE = `<h2>Shared Assets</h2>
<p>Shared architecture image:</p>
<ac:image><ri:attachment ri:filename="shared.png"><ri:page ri:content-title="Shared Assets" ri:space-key="ENG" /></ri:attachment></ac:image>
<p>Linked image:</p>
<ac:link><ri:page ri:content-title="Shared Assets" /><ac:link-body><ac:image><ri:attachment ri:filename="thumbnail.png" /></ac:image></ac:link-body></ac:link>`;

/** Page with draw.io macros */
export const DRAWIO_PAGE = `<h2>System Architecture</h2>
<p>The following diagram shows the system topology:</p>
<ac:structured-macro ac:name="drawio"><ac:parameter ac:name="diagramName">system-topology</ac:parameter></ac:structured-macro>
<p>And the data flow:</p>
<ac:structured-macro ac:name="drawio"><ac:parameter ac:name="diagramName">data-flow</ac:parameter></ac:structured-macro>`;

/** Page with table of contents macro */
export const TOC_PAGE = `<ac:structured-macro ac:name="toc"></ac:structured-macro>
<h1>API Reference</h1>
<h2>Authentication</h2>
<p>All endpoints require a Bearer token.</p>
<h2>Pages</h2>
<p>CRUD operations for Confluence pages.</p>`;

/** Page with tables */
export const TABLE_PAGE = `<h2>Environment Variables</h2>
<table>
<tbody>
<tr><th>Variable</th><th>Default</th><th>Description</th></tr>
<tr><td>JWT_SECRET</td><td>-</td><td>Secret for JWT signing (32+ chars)</td></tr>
<tr><td>POSTGRES_URL</td><td>postgresql://localhost:5432/kb</td><td>Database connection string</td></tr>
<tr><td>REDIS_URL</td><td>redis://localhost:6379</td><td>Redis connection string</td></tr>
</tbody>
</table>`;

/** Page with unknown/unsupported macros (should be preserved as data attributes) */
export const UNKNOWN_MACRO_PAGE = `<h2>Jira Integration</h2>
<ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">PROJ-123</ac:parameter><ac:rich-text-body><p>Related issue</p></ac:rich-text-body></ac:structured-macro>`;

/** Complex page combining multiple macro types (realistic Confluence page) */
export const COMPLEX_PAGE = `<ac:structured-macro ac:name="toc"></ac:structured-macro>
<h1>Runbook: Database Migration</h1>
<ac:structured-macro ac:name="warning"><ac:rich-text-body><p>This runbook must be followed <strong>exactly</strong>. Skipping steps may cause data loss.</p></ac:rich-text-body></ac:structured-macro>
<h2>Prerequisites</h2>
<ac:task-list>
<ac:task>
<ac:task-id>10</ac:task-id>
<ac:task-status>incomplete</ac:task-status>
<ac:task-body>Verify backup completed (see <ac:link><ri:page ri:content-title="Backup Procedures" /><ac:plain-text-link-body><![CDATA[Backup Procedures]]></ac:plain-text-link-body></ac:link>)</ac:task-body>
</ac:task>
<ac:task>
<ac:task-id>11</ac:task-id>
<ac:task-status>incomplete</ac:task-status>
<ac:task-body>Notify #ops channel on Slack</ac:task-body>
</ac:task>
</ac:task-list>
<h2>Architecture</h2>
<ac:structured-macro ac:name="drawio"><ac:parameter ac:name="diagramName">migration-flow</ac:parameter></ac:structured-macro>
<h2>Steps</h2>
<h3>1. Stop the Application</h3>
<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">bash</ac:parameter><ac:plain-text-body><![CDATA[docker compose -f docker/docker-compose.yml down]]></ac:plain-text-body></ac:structured-macro>
<h3>2. Run Migrations</h3>
<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">bash</ac:parameter><ac:plain-text-body><![CDATA[docker compose exec backend npm run migrate]]></ac:plain-text-body></ac:structured-macro>
<ac:structured-macro ac:name="info"><ac:rich-text-body><p>Migrations are idempotent. Running them twice is safe.</p></ac:rich-text-body></ac:structured-macro>
<h3>3. Verify</h3>
<p>Check the health endpoint:</p>
<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">bash</ac:parameter><ac:plain-text-body><![CDATA[curl http://localhost:3000/api/health]]></ac:plain-text-body></ac:structured-macro>
<ac:structured-macro ac:name="expand"><ac:parameter ac:name="title">Troubleshooting</ac:parameter><ac:rich-text-body><p>If migrations fail, restore from backup and contact the DBA team.</p></ac:rich-text-body></ac:structured-macro>
<h2>Reference</h2>
<table>
<tbody>
<tr><th>Version</th><th>Date</th><th>Author</th></tr>
<tr><td>1.0</td><td>2025-01-15</td><td>Platform Team</td></tr>
<tr><td>1.1</td><td>2025-03-01</td><td>DBA Team</td></tr>
</tbody>
</table>`;

/** Page with user mentions and emoticons (should be stripped) */
export const USER_MENTIONS_PAGE = `<h2>Team</h2>
<p>Contact <ri:user ri:userkey="user123" /> or <ri:user ri:userkey="user456" /> for questions.</p>
<p>Great job! <ac:emoticon ac:name="smile" /></p>`;

/** Page with Confluence status macro badges (all six colours) */
export const STATUS_MACRO_PAGE = `<h2>Project Status</h2>
<p>Backend: <ac:structured-macro ac:name="status"><ac:parameter ac:name="colour">Green</ac:parameter><ac:parameter ac:name="title">DONE</ac:parameter></ac:structured-macro></p>
<p>Frontend: <ac:structured-macro ac:name="status"><ac:parameter ac:name="colour">Yellow</ac:parameter><ac:parameter ac:name="title">IN PROGRESS</ac:parameter></ac:structured-macro></p>
<p>Docs: <ac:structured-macro ac:name="status"><ac:parameter ac:name="colour">Red</ac:parameter><ac:parameter ac:name="title">BLOCKED</ac:parameter></ac:structured-macro></p>
<p>QA: <ac:structured-macro ac:name="status"><ac:parameter ac:name="colour">Blue</ac:parameter><ac:parameter ac:name="title">IN REVIEW</ac:parameter></ac:structured-macro></p>
<p>Deploy: <ac:structured-macro ac:name="status"><ac:parameter ac:name="colour">Grey</ac:parameter><ac:parameter ac:name="title">TODO</ac:parameter></ac:structured-macro></p>`;

/** Table with colspan and rowspan (common in Confluence) */
export const TABLE_COLSPAN_ROWSPAN_PAGE = `<h2>Team Schedule</h2>
<table>
<tbody>
<tr><th colspan="3">Q1 2025 Sprint Assignments</th></tr>
<tr><th>Name</th><th>Sprint 1</th><th>Sprint 2</th></tr>
<tr><td rowspan="2">Backend Team</td><td>Auth Service</td><td>API Gateway</td></tr>
<tr><td>Database Migration</td><td>Cache Layer</td></tr>
<tr><td colspan="2">Frontend Team</td><td>Dashboard UI</td></tr>
</tbody>
</table>`;

/** Multi-row table with many rows */
export const TABLE_MULTI_ROW_PAGE = `<h2>API Endpoints</h2>
<table>
<tbody>
<tr><th>Method</th><th>Path</th><th>Description</th><th>Auth</th></tr>
<tr><td>GET</td><td>/api/health</td><td>Health check</td><td>No</td></tr>
<tr><td>POST</td><td>/api/auth/login</td><td>User login</td><td>No</td></tr>
<tr><td>GET</td><td>/api/pages</td><td>List pages</td><td>Yes</td></tr>
<tr><td>GET</td><td>/api/pages/:id</td><td>Get page</td><td>Yes</td></tr>
<tr><td>PUT</td><td>/api/pages/:id</td><td>Update page</td><td>Yes</td></tr>
<tr><td>DELETE</td><td>/api/pages/:id</td><td>Delete page</td><td>Yes</td></tr>
<tr><td>POST</td><td>/api/llm/ask</td><td>Ask AI</td><td>Yes</td></tr>
</tbody>
</table>`;

/** Page with code blocks that have titles (ac:parameter ac:name="title") */
export const CODE_BLOCK_TITLED_PAGE = `<h2>Configuration Files</h2>
<p>Docker Compose configuration:</p>
<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">yaml</ac:parameter><ac:parameter ac:name="title">docker-compose.yml</ac:parameter><ac:plain-text-body><![CDATA[version: "3.8"
services:
  backend:
    build: .
    ports:
      - "3000:3000"]]></ac:plain-text-body></ac:structured-macro>
<p>TypeScript config:</p>
<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">json</ac:parameter><ac:parameter ac:name="title">tsconfig.json</ac:parameter><ac:plain-text-body><![CDATA[{
  "compilerOptions": {
    "strict": true
  }
}]]></ac:plain-text-body></ac:structured-macro>
<p>Code block without a title:</p>
<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">bash</ac:parameter><ac:plain-text-body><![CDATA[echo "no title"]]></ac:plain-text-body></ac:structured-macro>`;

/** Page with children display macro (ac:structured-macro[name=children]) */
export const CHILDREN_MACRO_PAGE = `<h2>Sub-pages</h2>
<p>The following child pages are available:</p>
<ac:structured-macro ac:name="children"><ac:parameter ac:name="sort">title</ac:parameter><ac:parameter ac:name="reverse">false</ac:parameter></ac:structured-macro>`;

/** Page with children display macro with no parameters */
export const CHILDREN_MACRO_NO_PARAMS_PAGE = `<h2>Sub-pages</h2>
<ac:structured-macro ac:name="children"></ac:structured-macro>`;

/** Page with children macro using all supported parameters */
export const CHILDREN_MACRO_ALL_PARAMS_PAGE = `<h2>Sub-pages</h2>
<ac:structured-macro ac:name="children"><ac:parameter ac:name="sort">creation</ac:parameter><ac:parameter ac:name="reverse">true</ac:parameter><ac:parameter ac:name="depth">2</ac:parameter><ac:parameter ac:name="first">10</ac:parameter><ac:parameter ac:name="page">My Parent</ac:parameter><ac:parameter ac:name="style">h3</ac:parameter><ac:parameter ac:name="excerptType">rich</ac:parameter></ac:structured-macro>`;

/** Page with ui-children macro variant */
export const UI_CHILDREN_MACRO_PAGE = `<h2>Sub-pages</h2>
<ac:structured-macro ac:name="ui-children"><ac:parameter ac:name="sort">title</ac:parameter><ac:parameter ac:name="depth">3</ac:parameter></ac:structured-macro>`;

/** Page with data-macro-name attribute variant (some Confluence versions use this) */
export const DATA_MACRO_VARIANT_PAGE = `<h2>Code Example</h2>
<ac:structured-macro data-macro-name="code"><ac:parameter ac:name="language">python</ac:parameter><ac:plain-text-body><![CDATA[print("hello world")]]></ac:plain-text-body></ac:structured-macro>
<ac:structured-macro data-macro-name="info"><ac:rich-text-body><p>Python 3.12+ required.</p></ac:rich-text-body></ac:structured-macro>
<ac:structured-macro data-macro-name="expand"><ac:parameter ac:name="title">Details</ac:parameter><ac:rich-text-body><p>More info here.</p></ac:rich-text-body></ac:structured-macro>`;
