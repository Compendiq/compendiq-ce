# Compendiq User Guide

This guide covers day-to-day usage of Compendiq for knowledge base management, AI features, and search.

> **Deploying Compendiq into a non-trivial environment** (corporate reverse proxy, self-signed / private-CA TLS, air-gapped network)? See the [integration guides](integrations/README.md) before running the quickstart installer — they cover the config that the default install skips.

## Getting Started

### First-Run Setup

1. **Open Compendiq** in your browser (default: `http://localhost:5273` for development, or the URL provided by your administrator).
2. **Register an account.** The first user automatically receives the admin role.
3. **Configure your Confluence connection** (optional): go to **Settings** and enter your Confluence Data Center URL and Personal Access Token (PAT).

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

1. Go to **Spaces** in the sidebar.
2. You will see all available Confluence spaces.
3. Select the spaces you want to sync to Compendiq.
4. Click **Sync** to start the initial synchronization.

Synced spaces are periodically updated in the background (default: every 15 minutes).

## Working with Pages

### Browsing Pages

The **Pages** view shows all synced pages from your selected Confluence spaces, plus any locally created pages. You can:

- **Sort** by title, last modified date, quality score, or space
- **Filter** by space, tags, or status
- **Pin** important pages for quick access from the dashboard

### Creating a Page

1. Click **New Page** (or press `Alt+N`).
2. Choose a space (Confluence or local).
3. Enter a title and start writing in the TipTap editor.
4. Use the formatting toolbar or keyboard shortcuts for rich text.
5. Save with `Ctrl+S`.

You can also generate pages from templates (runbook, how-to, architecture, troubleshooting) using the **Templates** feature.

### Editing a Page

1. Open a page by clicking on it.
2. Click **Edit** or press `Ctrl+E` to toggle edit mode.
3. Make your changes in the TipTap editor.
4. Save with `Ctrl+S`.

Changes to Confluence-synced pages can be pushed back to Confluence.

### Page Versions

Compendiq tracks version history for all pages:

1. Open a page.
2. Click the **Versions** tab in the right panel.
3. View diffs between versions.
4. Restore a previous version if needed.

### Tagging Pages

Tags help organize and categorize your knowledge base:

1. Open a page.
2. Click the **Tags** section.
3. Add tags manually or accept AI-suggested tags.

Compendiq can automatically suggest tags based on page content using LLM classification.

### Page Comments

Add comments to pages for discussions and feedback:

1. Open a page.
2. Scroll to the **Comments** section.
3. Write your comment and submit.

### Page Verification

The verification workflow helps maintain knowledge base quality:

1. Admins or reviewers can mark pages for review.
2. Reviewers verify the content is accurate and up-to-date.
3. Verified pages display a verification badge with the reviewer and date.

## Using AI Features

### AI Chat

The AI assistant can answer questions, improve content, and help with writing:

1. Open the **AI** panel from the sidebar (or press `G A`).
2. Type your question or request.
3. Responses stream in real-time via SSE.
4. Conversations are saved and can be continued later.

### Improve an Article

AI can analyze and improve existing articles:

1. Open a page.
2. Click **AI Improve** (or press `Alt+I`).
3. Choose an improvement mode:
   - **Grammar** -- fix spelling, grammar, and punctuation
   - **Structure** -- improve headings, sections, and organization
   - **Clarity** -- simplify language and improve readability
   - **Technical accuracy** -- verify technical claims and add corrections
   - **Completeness** -- identify and fill gaps in the content
4. Review the suggested changes and apply them.

### Generate an Article

Create new articles from templates and prompts:

1. Go to **Templates**.
2. Choose a template type (runbook, how-to, architecture, troubleshooting).
3. Provide a topic and any context.
4. The AI generates a full article that you can edit and save.

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

- Pages receive a quality score based on structure, completeness, and readability.
- Low-quality pages are highlighted for improvement.
- View quality scores in the page list or on individual pages.

## Search

Compendiq supports three search modes:

### Keyword Search

Traditional text-based search. Matches exact words and phrases in page titles and content.

### Semantic Search

Uses vector embeddings to find conceptually similar content. This finds results even when the exact words do not match -- for example, searching for "authentication" will also find pages about "login" and "SSO".

### Hybrid Search

Combines keyword and semantic search with Reciprocal Rank Fusion (RRF) for the best results. This is the default search mode.

Access search via the **Search** page in the sidebar or the **Command Palette** (`Ctrl+K`).

## Knowledge Graph

The knowledge graph provides a visual map of relationships between pages:

1. Go to **Graph** in the sidebar (or press `G G`).
2. Explore connections between pages based on links, tags, and semantic similarity.
3. Click on nodes to navigate to specific pages.

## Keyboard Shortcuts

Press `?` or `Ctrl+/` to open the keyboard shortcuts modal. Key shortcuts:

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
| `Alt+I` | AI Improve |

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
| `.` | Toggle Right Panel |
| `\` | Zen Mode |
| `Esc` | Close dialog / modal |

Single-key shortcuts (`,`, `.`, `\`, `?`) can be toggled on/off in the shortcuts modal. They are automatically disabled when typing in inputs or the editor.

On macOS, `Ctrl` is replaced by `Cmd` and `Alt` by `Option`.

## Knowledge Requests

Request new documentation topics when you identify knowledge gaps:

1. Go to **Knowledge Requests** in the sidebar.
2. Click **New Request**.
3. Describe the topic you need documented.
4. Track the status of your request as it progresses.

## Notifications

Compendiq notifies you of relevant events:

- Page updates and comments on pages you follow
- Verification requests assigned to you
- Knowledge request status changes

Access notifications via the bell icon in the top navigation bar.

## Dark and Light Theme

Compendiq supports both dark and light themes:

- The theme follows your system preference by default.
- Toggle manually via the theme switch in the user menu.
- The glassmorphic UI design works well in both modes.

## Webhook Integrations (Enterprise)

Enterprise administrators can configure outbound webhooks so external systems receive a signed HTTP POST whenever specific events happen in Compendiq (page created / updated / deleted, sync completed, AI quality / summary complete). Configuration lives at **Settings → Webhooks**.

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

Under **Settings → Webhooks**, click **Rotate secret** to stage a new primary while keeping the old one as a secondary signer for a grace window. Receivers should accept *either* signature during the window. When all receivers are updated, click **Complete rotation** (or let the window expire) to drop the old secret.

## Tips

- Use the **Command Palette** (`Ctrl+K`) for quick navigation to any page, space, or action.
- **Pin** frequently used pages for quick access from the dashboard.
- Use **tags** consistently across your knowledge base for better organization and search.
- The **quality score** helps identify pages that need improvement -- aim for high scores across your knowledge base.
- **Hybrid search** generally gives the best results for natural language questions.
