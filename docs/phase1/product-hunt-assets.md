# Product Hunt Launch Assets

**Launch date:** Tuesday 2026-05-05, 00:01 PT (07:01 UTC)
**Product page:** producthunt.com/posts/compendiq (to be created)
**Links to:** github.com/Compendiq/compendiq-ce

---

## Tagline (60 chars max)

**Primary:** `Open-source AI knowledge base for Confluence Data Center`

**Alternatives:**
- `Self-hosted AI layer for your Confluence wiki`
- `Ask your Confluence knowledge base anything, on-premise`

---

## Description (260 chars max)

Compendiq syncs your Confluence Data Center pages, then lets you ask questions, improve articles, and generate documentation using AI -- all self-hosted. Runs on Ollama (local) or any OpenAI-compatible API. Install in 3 minutes with Docker.

---

## Topics

- Artificial Intelligence
- Developer Tools
- Open Source
- Self-Hosted
- Knowledge Management

---

## Maker Comment (post within 10 minutes of launch)

> Hey Product Hunt!
>
> I built Compendiq because my team's Confluence Data Center instance had 4,000+ pages and nobody could find anything. Cloud AI tools weren't an option -- our data has to stay on-premise.
>
> **What it does:**
> - Syncs your Confluence DC pages over the REST API
> - Lets you ask questions in natural language (RAG with pgvector hybrid search)
> - Improves existing articles for grammar, structure, and completeness
> - Generates new documentation from templates (runbooks, how-tos, architecture docs)
> - Runs entirely on your hardware -- Ollama for local inference, or any OpenAI-compatible API
>
> **Install in 3 minutes:**
> ```
> curl -fsSL https://raw.githubusercontent.com/Compendiq/compendiq-ce/main/scripts/install.sh | bash
> ```
>
> **What's free:** Everything in the Community Edition. Full RAG Q&A, full article generation, full sync. No limits, no feature gates, AGPL-3.0.
>
> **What's paid:** The Enterprise Edition adds OIDC/SSO, per-space RAG permissions, and audit log export for larger teams.
>
> I'm a solo developer, so I'll be here answering questions all day. If you run Confluence Data Center on-premise and AI tools have been a non-starter because of data sovereignty, this is for you.
>
> GitHub: https://github.com/Compendiq/compendiq-ce

---

## Screenshot Descriptions (5 screenshots)

Capture these from a running instance with realistic Confluence content. Use dark mode for visual impact. All screenshots should be 1270x760px minimum.

### Screenshot 1: Dashboard Overview
- Show the main dashboard with synced spaces, page counts, and sync status
- The glassmorphic UI should be visible (backdrop blur cards, gradient background)
- Caption: "Dashboard showing synced Confluence spaces with AI-powered insights"

### Screenshot 2: RAG Q&A in Action
- Show the AI assistant panel with a real question and a streaming answer
- Source citations should be visible at the bottom
- Caption: "Ask questions across your entire knowledge base -- answers cite source pages"

### Screenshot 3: Article Improvement
- Show a page in the editor with the AI improvement panel open
- Display a "Structure" improvement with the suggested changes visible
- Caption: "One-click article improvement for grammar, structure, and clarity"

### Screenshot 4: Rich Text Editor
- Show the TipTap editor with Confluence macros rendered (code block, task list, panel, status labels)
- Caption: "Full-featured editor with Confluence macro support and Vim mode"

### Screenshot 5: Admin Panel
- Show the admin settings page with LLM configuration, RBAC roles, or the audit log
- Caption: "Admin panel with LLM provider settings, RBAC, and audit logging"

---

## GIF (1 animated GIF, 15-30 seconds)

**Content:** The RAG Q&A flow.
1. User clicks the AI assistant
2. Types a question about a Confluence topic
3. Answer streams in word by word
4. Citations appear at the bottom

**Technical:** 800x500px, < 5 MB, 15fps. Use LICEcap, Kap, or gifski for recording. Optimize with gifsicle.

---

## Pre-Launch Checklist

- [ ] Product Hunt account is 60+ days old with upvote/follow history
- [ ] 5 screenshots captured at 1270x760px minimum (dark mode, realistic content)
- [ ] 1 GIF of RAG Q&A flow (< 5 MB)
- [ ] Tagline, description, and maker comment reviewed
- [ ] Topics selected (5 max)
- [ ] Product page created in draft mode, all assets uploaded
- [ ] Launch scheduled for 00:01 PT Tuesday 2026-05-05
- [ ] Maker comment saved -- paste within 10 minutes of launch going live
- [ ] Demo video (YouTube unlisted) linked if ready by launch day
- [ ] GitHub repo is public (A4 must be done before launch)

---

## Launch Day Schedule (founder's perspective)

| Time (UTC) | Action |
|------------|--------|
| 07:00 | PH goes live. Check the product page renders correctly. |
| 07:10 | Post maker comment. |
| 07:30 | Share PH link on personal social channels. |
| 08:00 -- 12:00 | Monitor PH for questions, respond to every comment. |
| 14:00 | Post Show HN (see `show-hn-drafts.md`). |
| 15:00 | Post on r/selfhosted (see `reddit-drafts.md`). |
| 18:00 | Check PH ranking. Respond to remaining comments. |
| 22:00 | Final PH + HN check before sleep. |

---

## Success Metrics (week 1)

| Metric | Target | Stretch |
|--------|--------|---------|
| PH upvotes | 200+ | 500+ (Product of the Day) |
| GitHub stars | 500 | 1000 |
| Docker pulls | 100 | 250 |
| Discussions participants | 50 | 100 |
| Enterprise inquiries | 5 | 20 |
