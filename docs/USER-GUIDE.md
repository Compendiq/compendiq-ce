# Compendiq User Guide

This guide covers day-to-day usage of Compendiq for knowledge base management, AI features, and search.

> **Deploying Compendiq into a non-trivial environment** (corporate reverse proxy, self-signed / private-CA TLS, air-gapped network)? See the [integration guides](integrations/README.md) before running the quickstart installer — they cover the config that the default install skips.

## Getting Started

### First-Run Setup

1. **Open Compendiq** in your browser (default: `http://localhost:5273` for development, or the URL provided by your administrator).
2. **Register an account.** The first user automatically receives the admin role.
3. **Configure your Confluence connection** (optional): go to **Settings** and enter your Confluence Data Center URL and Personal Access Token (PAT).

### The Getting Started checklist

The Pages overview carries a short **Getting started** checklist for as long as
you have steps outstanding. It tracks five milestones and ticks each one off by
itself as you do it — there is nothing to mark complete by hand:

1. Connect your Confluence account
2. Choose the spaces to sync
3. Ask your first question
4. Learn the keyboard shortcuts
5. Create or edit a page

Each outstanding step carries a button that takes you straight to it. The
checklist never blocks the page list, and **Dismiss guide** hides it for good —
once hidden it stays hidden, even when a later step completes behind it.

When the last step lands, a short note appears above the five checked
milestones, saying so and telling you where to find the guide afterwards. The
note and completed checklist stay until you leave the overview or dismiss them.
They appear when you return to the overview even if the final step was completed
somewhere else — you do not have to be looking at the checklist at the time.

To bring it back at any time — finished or dismissed — open the account menu in
the top right and choose **Getting Started Guide**.

### Creating a Confluence PAT

To connect Compendiq to your Confluence Data Center instance:

1. Log in to Confluence Data Center.
2. Click your profile icon > **Settings** > **Personal Access Tokens**.
3. Click **Create token**.
4. Give it a name (e.g., "Compendiq") and set an expiry.
5. Copy the generated token.
6. In Compendiq, go to **Settings**, paste the token in the PAT field, and enter your Confluence base URL.

Your PAT is encrypted at rest with AES-256-GCM and is never sent back to the browser after saving.

### Selecting Confluence Spaces

After configuring your Confluence connection:

1. Go to **Settings → Knowledge → Spaces & Sync**.
2. Click **Fetch Spaces** to load every space your PAT can read.
3. If the list is long, use the filter box above it to narrow by space name or key. It changes only what you see — spaces you have already ticked stay selected, and a count tells you how many of the list are showing.
4. Select the spaces you want to sync to Compendiq.
5. Click **Sync** to start the initial synchronization.

Synced spaces are periodically updated in the background (default: every 15 minutes).

## Working with Pages

### Browsing Pages

The **Pages** view shows all synced pages from your selected Confluence spaces, plus any locally created pages. You can:

- **Sort** by title, last modified date, quality score, or space
- **Filter** by space, tags, or status
- **Pin** important pages for quick access from the dashboard

### Connections: what to read next

In read mode, **Connections** sits below the article. It groups **Linked articles**
(links in either direction), **In this section** (parent and child pages), and
**Related articles** (up to five ranked semantic or shared-label recommendations).
Each row explains why it appears. Link direction and hierarchy are not similarity
scores; shared labels name the actual overlap, and semantic scores are the
relationship engine's recorded cosine similarity, not an AI confidence rating.

Select a title to open that article. **Explore connections** opens the current
article's focused, two-hop view at `/graph?focus=<page-id>`. Graph remains in
navigation; the panel does not replace or expand the global canvas.

Only articles you can access appear. Links, hierarchy, and shared-label evidence
update without waiting for an embedding provider, including on articles with no
body yet. An empty result is stated in the panel rather than hiding it. Loading
and failed requests are distinct from an empty result, with a Retry action on
failures. A failed refresh may retain the last loaded results with a warning;
an access denial discards them until a successful authorized read.

### Creating a Page

1. Click **New Page** (or press `Alt+N`).
2. Choose a space (Confluence or local).
3. Enter a title and start writing in the TipTap editor.
4. Use the formatting toolbar or keyboard shortcuts for rich text.
5. Save with `Ctrl+S`.

You can also start a page from a template (Meeting Notes, Incident Report, How-to Guide, ADR, Runbook, Cornell Notes, plus any templates you or an admin created) via the **Use Template** button on the New Page screen. Shared templates and your own templates are listed separately. If the editor already has content, **Save current as template** stores it as a personal template (admins can tick **Share with everyone**).

### Page templates

Templates are starter layouts for new pages.

1. Open **Settings → Knowledge → Templates**.
2. **New template** opens a title, optional description/category/icon, and the editor for the body.
3. Your templates appear under **My templates**. Only you can use, edit, or delete them.
4. **Shared templates** are visible to everyone. Only an administrator can create a shared template (the **Share with everyone** checkbox), or edit and delete shared ones.

Cornell Notes is a built-in shared template: a two-column **Cues | Notes** table plus a **Summary** at the bottom. Fill notes during the session, cues when you review, and the summary last.

### Importing from Notion

This is a **one-shot migrate**, not a live sync. Open it from **Library → Import from Notion** or from **New Page → Import from Notion**.

1. Paste an **internal integration token**. That is Notion’s **Installation access token** for an **internal connection** — not an OAuth app, and not a personal access token. Create one under **Developer tools → Connections** at [app.notion.com/developers/connections](https://app.notion.com/developers/connections) (workspace owners only), then share the pages you want to import with that connection. Compendiq stores it encrypted and never shows it again.
2. Pick what to import in the grouped workspace tree. Selecting a parent selects the importable group below it. Importing a page also discovers its actual embedded child pages and database contents, even if those children were not individually selected. Ordinary links do not import the linked pages. To import only part of a page's contents, select the desired children without their parent; set unwanted databases to **Skip**. Databases offer **Table | Pages | Skip**:
   - **Table** — property-only rows become table columns and rows, not separate articles. An embedded database's table belongs on its parent article; a standalone database owns its own table article.
   - **Pages** — rows with real content stay articles. Choosing *Pages* keeps the database's own article, with its rows beneath it, even when that database sits inside another page you are importing. Wikis retain their root article and body, with rows beneath it, and offer only *Pages* or *Skip*. A database you never select — an inline table, or one found inside a page you did select — has no shape of its own: property-only rows become the parent's table, rows with content become the parent's children, and no empty container article is created.
   - **Skip** — leave the database in Notion.

   Rows beneath a *Table* database read **Included in the table above** and are not separately selectable. Everything beneath a *Skip* database reads **Excluded — stays in Notion**. If you force *Table* on a database whose scan found row content, the picker shows an amber caution: *Some rows have page content — the whole database imports as pages instead*.
3. Confirm the destination: a **local space**, optional parent page, and visibility (the same contract as creating a standalone page).
4. Run the import. The server keeps working after the request returns; a large Knowledge Base can take several minutes because Notion allows about three requests per second. Stay on the confirm step until the result appears. Refreshing or closing the tab does not cancel it — re-open **Import from Notion** later and pages that already exist locally are reported as already imported rather than duplicated. If a run is interrupted on the server, wait about ten minutes before starting another; a dead job stops blocking new imports once its lock expires.

**Not supported — stays in Notion** (the picker uses these exact words, and those nodes cannot be selected):

- Data sources — they point at content the pinned Notion API cannot resolve. A linked view of a database Search already returned as the source database is not listed twice.
- Comments, permissions, automations, buttons, Notion AI artefacts, whiteboards/canvases.
- **Board** databases — Compendiq is not a Kanban board. The picker marks the Board (and a page that only hosts an inline Board) with *Board view is not compatible — import cards as articles*. Tick the Board row to select its cards; each card imports as an article under a parent article named after the Notion page that contains the database.

**Blocks inside a page.** Web bookmarks import as a plain link, labelled with the bookmark's caption or with the URL itself — Notion's preview card is not recreated. Images import as local attachments. Embeds, link previews, videos, audio and file attachments are left behind.

**Database properties.** In *Table* mode the properties **are** the imported content — they become the table’s columns. On an imported row page they become the metadata callout at the top of the page, which is what makes that row an article rather than a bare page. Relations, rollups and formulas render as their plain-text value wherever the converter can read one.

**Inline databases and child pages.** Non-wiki inline databases read *Imports inside its parent article*. Property-only entries become a simple table there. Entries with page content remain articles, and actual embedded pages become subarticles. The parent uses Compendiq's **Child pages** feature to display its children, including pages nested inside Notion columns or toggles. Wiki roots remain selectable and are never flattened into a table.

**Nothing is dropped to make a table.** If a database cannot be safely flattened — a row holds page content, or a row cannot be read — it imports as pages instead of losing anything, and the result screen says so. Result rows read *imported as a table*, *imported as an article*, or *imported*.

**Very large branches are cut off, not truncated silently.** One run pulls in at
most 2000 pages beyond the ones you selected. Anything past that reads *Import
limit reached — select this branch directly to import it* on the result screen;
re-running the import on that branch picks up exactly where it stopped, and
nothing already imported is duplicated.

**Repairing an earlier import.** Select its root and enable **Update existing pages with latest Notion content** to rebuild imported content and child-page lists without changing article IDs. This replaces local edits. Leave it off to preserve existing bodies. Old database-row articles are not automatically deleted; review them separately, and do not identify duplicates by title alone.

Skipped and unselected Notion items keep their Notion URLs in imported page bodies. Markdown import on New Page is unchanged: it still loads one `.md` file into the editor and does not create pages until you press Create.

### Editing a Page

1. Open a page by clicking on it.
2. Click **Edit** or press `Ctrl+E` to toggle edit mode.
3. Make your changes in the TipTap editor.
4. Save with `Ctrl+S`.

Changes to Confluence-synced pages can be pushed back to Confluence.

### Page Details

Open **Details** in the right-hand page inspector (`Alt+D`). The panel groups
the page's source and metadata, document health, labels, notes, and page actions.
**Open in Confluence** sits with the source information. **Pin** and
**Version history** remain directly available under **Page actions**; relocation,
re-sync, and AI maintenance are under **More actions**.

Document health distinguishes search indexing from quality analysis. A human
verification records a review; it does not certify that AI indexing succeeded.

### Page Versions

Compendiq tracks version history for all pages:

1. Open a page.
2. Open **Details → Page actions → Version history** in the right panel.
3. View diffs between versions.
4. Restore a previous version if needed.

### Tagging Pages

Tags help organize and categorize your knowledge base:

1. Open a page.
2. Click the **Tags** section.
3. Add tags manually or accept AI-suggested tags.

Compendiq can automatically suggest tags based on page content using LLM classification.

### Page Comments

Add page notes and replies for discussions and feedback:

1. Open **Details → Notes**, or press `Alt+N`.
2. Choose **New note** to start a thread, or **Reply** on an existing note.
3. Write your note and submit. Use **Open** and **Resolved** to filter threads.

The Notes area grows with its content; longer thread lists scroll within it.
Tab into the thread list to scroll with the keyboard. When starting a note in an
empty list, the composer replaces the introductory guidance until you cancel.

Unsent notes and replies survive inspector tab switches on the same page.
**Cancel** discards the draft. Drafts are not stored persistently: submit them
before closing the inspector or leaving the page.

### Page Verification

The verification workflow helps maintain knowledge base quality:

1. Admins or reviewers can mark pages for review.
2. Reviewers verify the content is accurate and up-to-date.
3. **Details → Document health** displays the verification date separately from AI processing status.

## Using AI Features

### AI Chat

The AI assistant can answer questions, improve content, and help with writing:

1. Open the **AI** panel from the sidebar (or press `G A`).
2. Type your question or request.
3. Responses stream in real-time via SSE.
4. **Q&A conversations are saved.** Past conversations are listed in the left
   pane on the AI page, grouped by when you last used them (Today, Yesterday,
   Previous 7 days, and so on), with a filter box once you have more than
   eight. Selecting one reopens it at its own address (`/ai/c/<id>`), so it can
   be bookmarked and walked with the browser's Back and Forward buttons, and
   your next question continues it. Each row's `⋯` menu **renames** it in place
   (Enter commits, Escape cancels) or **deletes** it permanently. **New chat**
   — in the top bar and at the top of the pane — starts an empty one. After the
   first completed answer, Compendiq generates a concise title in the question's
   language without delaying the response. If that background step fails, the
   first question remains the title; a title you rename manually is never
   replaced later.
5. Only Q&A is saved. Generate, the rewrite skills and Diagram are not.
   Questions you ask from the assistant beside an article are saved too and
   appear in the list tagged with the page they started on; continuing one from
   the AI page searches the whole knowledge base rather than that page.

### Improve an Article

AI can analyze and improve existing articles:

1. Open a page.
2. Click **AI Assistant** (or press `Alt+I`) to open the assistant beside the article.
   Opening it starts nothing.
3. Optionally type instructions in the prompt box -- they are sent with the request --
   and attach a document or image as reference material.
4. Click the **Improve** chip.
5. Review the proposed changes in the diff card and **Apply** or **Skip** them.

Improve rewrites for grammar, spelling and punctuation by default. To ask for something
else -- restructuring, simpler language, filling gaps, checking technical claims -- say so
in the prompt box before clicking **Improve**; whatever you type is sent as extra
instructions with the request.

### Generate an Article

Create new articles from prompts:

1. Open the **AI** panel and switch to **Generate** mode.
2. Enter a topic or prompt (optionally attach a PDF or enable web search for extra context).
3. The AI generates a full article that you can save as a new page.

### Summarize

Generate concise summaries of long articles:

1. Open a page.
2. Click **Summarize** in the AI actions menu.
3. The summary appears and can be saved as part of the page metadata.

Background workers can also auto-generate summaries for pages that do not have one (configured by your administrator).

### RAG-Powered Q&A

Ask questions across your entire knowledge base:

1. Open the AI chat.
2. Type your question naturally (e.g., "How do I deploy the authentication service?").
3. Compendiq searches across all synced pages using hybrid search (vector similarity + keyword matching).
4. The AI answers using the most relevant page content as context, with source citations.

### Quality Analysis

Compendiq automatically analyzes page quality in the background:

- Pages receive a quality score based on completeness, clarity, structure, accuracy, and readability.
- Low-quality pages are highlighted for improvement.
- View quality scores in the page list or on individual pages.
- In **Details → Document health**, activate the quality score to see available
  dimension scores, the analysis timestamp, and the full summary. The disclosure
  supports keyboard and touch; `Escape` closes it and returns focus to the score.
  If analysis is pending or failed, it explains that state rather than presenting
  a previous score as the current result.

## AI Output Review (Enterprise)

When the **AI review policy** is enabled, AI-generated output (improve, generate, summarise, auto-tag, apply-improvement) is queued in a review list before it lands on the underlying page. A reviewer must explicitly **approve**, **reject**, or **edit-and-approve** each entry. This sits between the AI worker and the persistence layer — the proposed content is stored in `ai_output_reviews` rather than written directly to the page.

### Who reviews

For v0.4, any admin can act on the queue. (Per-space scoping based on editor-on-space lands in v0.5; until then the access gate is admin-only — see the EE overlay route file for the exact policy.)

### What the queue looks like

Open **Settings → AI → AI Safety → Review queue**. Each row shows:

- The action type chip (Improve, Summary, Generate, Auto-tag, Apply improvement).
- The page id the review targets, plus the page title once you click into the detail.
- A short id of the author who triggered the AI run.
- A relative submitted-at timestamp (e.g. `5h ago`, `2d ago`).
- The current status (Pending / Approved / Rejected / Edited & approved / Expired).

Filter the queue by status or action. The queue defaults to the **Pending** status — that's the work to act on. The Approved / Rejected / Expired statuses are useful for spot-checking past decisions.

### How the diff view works

Clicking **Review** opens the detail page at `/settings/ai-reviews/<id>` (full viewport). The header shows the page title, action type, current status, and — for pending rows — the auto-expiry timestamp.

The diff is rendered side-by-side. The default view is a **text diff** of the page's current `body_text` against the AI's proposed `body_text`, line-by-line. Removed lines are highlighted red on the left; added lines are highlighted green on the right. Lines that match are shown unmodified on both sides.

Toggle to **HTML** view to see the raw HTML from both sides in two columns. The HTML view is intentionally not diff-highlighted — accurate HTML-aware diffing is out of scope for this iteration (the upstream `htmldiff-js` library is unmaintained), so we render the HTML pair as-is for visual scanning rather than risking misleading red/green spans on attribute-reorder noise.

If the AI run flagged personally identifiable information, the header shows a **PII findings** badge. PII gating only blocks approval when the policy mode is **Review required (block on PII)**.

### What each action does

- **Approve** — applies the AI's proposed content to the page draft and records a single audit row (`AI_REVIEW_APPROVED`). The page's draft is what gets pushed to Confluence on the next publish; nothing is auto-published as part of approval.
- **Reject** — discards the proposed content. Optionally leave a short note for the author (max 4000 chars) so they can re-run the AI with better instructions. Records `AI_REVIEW_REJECTED`.
- **Edit and approve** — opens a fullscreen editor pre-loaded with the proposed body text. Make any changes you like, optionally add a note, then save. Two audit rows are recorded: the original AI authorship plus your reviewer modification (`AI_REVIEW_EDIT_AND_APPROVED`). The edited content — not the AI's original — is what lands on the page.

### Handling rejected output

A rejection is final for that particular review row, but the author is free to re-run the AI. The reviewer note is the right place to give the author a steer (e.g. "tone is too casual; prefer the existing prose style").

### Auto-expiry

Pending reviews that nobody acts on are auto-expired after the policy's configured window (default 30 days). The author is notified; the proposed content is discarded — there is **no implicit auto-approval**. This protects against stale AI output sneaking onto a page weeks after the human context that produced it.

## PII Protection (Enterprise)

When your administrator has enabled PII detection, AI output (Chat, Improve, Generate, Summary, Auto-tag) is scanned for personally identifiable information before it reaches you. Depending on the per-action policy your admin configured, you may notice one of three things:

- **Flag only** (the default) — output looks unchanged, but findings are recorded in the audit log so admins can review patterns over time.
- **Redact & publish** — sensitive spans are replaced with `[REDACTED:CATEGORY]` placeholders in the output you see (e.g. `[REDACTED:EMAIL_ADDRESS]`). The original AI text is not stored.
- **Block publication** — the AI request fails with a notice that PII was detected. The proposed output is queued for admin review (see *AI Output Review* above) rather than applied directly.

The scanner detects person names, locations, organisations, email addresses, phone numbers, IBANs, credit-card numbers, German tax IDs, German Rentenversicherungsnummer, and German Personalausweis numbers. If you believe a redaction was a false positive, ask an admin to lower the confidence threshold or remove the affected category from the policy.

## Search

Compendiq supports three search modes:

### Keyword Search

Traditional text-based search. Matches exact words and phrases in page titles and content.

### Semantic Search

Uses vector embeddings to find conceptually similar content. This finds results even when the exact words do not match -- for example, searching for "authentication" will also find pages about "login" and "SSO".

### Hybrid Search

Combines keyword and semantic search with Reciprocal Rank Fusion (RRF). The search API defaults to keyword; pass `mode=hybrid` for RRF results.

Access search via the search box in the top bar or the **Command Palette** (`Ctrl+K`).

In Library, the **Local** and **Confluence** badges identify a page's origin,
independently of its space and the selected search mode. On narrow screens,
the query, mode choices, and scope controls use separate rows.

Press `/` to focus Library search. `Enter` or `ArrowDown` moves from the query
to the first result only when the displayed results match the current query.
While older results remain visible during an update, focus stays in the query.
If an update removes a focused result, focus returns to the query field.
Each filter has one visible Tab stop; `Escape` closes its menu and returns
focus to the trigger.

## Knowledge Graph

The knowledge graph provides a visual map of relationships between pages:

1. Go to **Graph** in the sidebar (or press `G G`).
2. Explore connections between pages based on links, tags, and semantic similarity.
3. Click on nodes to navigate to specific pages.

## Keyboard Shortcuts

Press `?` or `Ctrl+/` to open the keyboard shortcuts modal, then start typing in its search box to narrow the list. Key shortcuts:

### Navigation

| Shortcut | Action |
|----------|--------|
| `Ctrl+K` | Search / Command Palette |
| `/ai` | AI mode (inside palette) |
| `?` or `Ctrl+/` | Keyboard Shortcuts |
| `G P` | Go to Pages |
| `G G` | Go to Graph |
| `G A` | Go to AI |
| `G S` | Go to Settings |
| `G T` | Go to Trash |

### Actions

| Shortcut | Action |
|----------|--------|
| `Alt+N` | New Page |
| `Alt+P` | Pin/Unpin page |
| `Alt+Shift+D` | Delete page |
| `Alt+I` | AI Assistant |

### Editor

| Shortcut | Action |
|----------|--------|
| `Ctrl+S` | Save article |
| `Ctrl+E` | Toggle Edit Mode |
| `Ctrl+B` | Bold |
| `Ctrl+I` | Italic |
| `Ctrl+U` | Underline |
| `Ctrl+Z` | Undo |
| `Ctrl+Shift+Z` | Redo |

### Panels

| Shortcut | Action |
|----------|--------|
| `,` | Toggle Left Sidebar |
| `.` | Toggle Page Inspector |
| `\` | Zen Mode |
| `Esc` | Close dialog / modal |

Single-key shortcuts (`,`, `.`, `\`, `?`) are automatically disabled when typing in inputs or the editor.

On macOS, `Ctrl` is replaced by `Cmd` and `Alt` by `Option`.

## Notifications

Compendiq notifies you of relevant events:

- Page updates and comments on pages you follow
- Verification requests assigned to you

Access notifications via the bell icon in the top navigation bar.

## Dark and Light Theme

Compendiq supports both dark and light themes:

- The theme follows your system preference by default.
- Toggle manually via the theme switch in the user menu.
- The glassmorphic UI design works well in both modes.

## Webhook Integrations (Enterprise)

Enterprise administrators can configure outbound webhooks so external systems receive a signed HTTP POST whenever specific events happen in Compendiq (page created / updated / deleted, sync completed, AI quality / summary complete). Configuration lives at **Settings → Governance → Data & Compliance → Webhooks**.

### Event catalogue (v0.4)

| Event type | Fires when |
|------------|-----------|
| `page.created` | A new page is created (local or synced) |
| `page.updated` | A page body or metadata changes |
| `page.deleted` | A page is deleted (soft or hard) |
| `sync.completed` | A Confluence sync run finishes |
| `ai.quality.complete` | The AI quality worker finishes a page |
| `ai.summary.complete` | The AI summary worker finishes a page |

### Signing verification (receiver-side)

Deliveries follow the [Standard Webhooks](https://www.standardwebhooks.com) specification. Each request carries three headers:

```
webhook-id:        <uuid, stable across retries — use as your dedup key>
webhook-timestamp: <unix seconds>
webhook-signature: v1,<base64 HMAC-SHA256>
```

Verify with the Standard Webhooks library for your language (example: Node.js):

```js
import { Webhook } from 'standardwebhooks';

const wh = new Webhook(secret, { format: 'raw' }); // plaintext secret, not base64

app.post('/webhook', (req, res) => {
  try {
    wh.verify(req.rawBody, {
      'webhook-id':        req.headers['webhook-id'],
      'webhook-timestamp': req.headers['webhook-timestamp'],
      'webhook-signature': req.headers['webhook-signature'],
    });
  } catch (err) {
    return res.status(401).send('invalid signature');
  }
  // ...handle the event (idempotent — use webhook-id as dedup key)
  res.status(204).end();
});
```

The receiver MUST:
- Verify the signature on every request.
- Check `webhook-timestamp` is within your tolerance window (we recommend 5 minutes) to reject replay.
- Use `webhook-id` as an **idempotency key** — Compendiq retries on transient failures, and the same `webhook-id` may arrive more than once.
- Return `2xx` within 10 seconds. Non-2xx responses are retried up to 8 times with exponential backoff (5 s → 5 h); `408` and `429` are retried, other `4xx` are treated as permanent failures.

### Secret rotation

Under **Settings → Governance → Data & Compliance → Webhooks**, click **Rotate secret** to stage a new primary while keeping the old one as a secondary signer for a grace window. Receivers should accept *either* signature during the window. When all receivers are updated, click **Complete rotation** (or let the window expire) to drop the old secret.

## Tips

- Use the **Command Palette** (`Ctrl+K`) for quick navigation to any page, space, or action.
- **Pin** frequently used pages for quick access from the dashboard.
- Use **tags** consistently across your knowledge base for better organization and search.
- The **quality score** helps identify pages that need improvement -- aim for high scores across your knowledge base.
- **Hybrid search** generally gives the best results for natural language questions.
