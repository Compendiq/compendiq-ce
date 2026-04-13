# Show HN Post Drafts

**Post time:** 2026-05-05 at 14:00 UTC / 07:00 PT (7 hours after PH launch)
**Post URL:** news.ycombinator.com/submit
**Link to:** https://github.com/Compendiq/compendiq-ce

---

## Variant A (recommended): Technical, problem-first

**Title:** `Show HN: Compendiq -- open-source AI knowledge base for Confluence Data Center`

**Body:**

Hi HN,

I built Compendiq because I was running Confluence Data Center on-premise and couldn't use any of the cloud-only AI tools that exist for Confluence Cloud. Our pages had to stay on our hardware.

Compendiq connects to your Confluence DC instance over the REST API, syncs pages, and gives you:

- RAG-powered Q&A: ask natural-language questions across your entire knowledge base. Uses pgvector for hybrid search (vector cosine + full-text keyword + Reciprocal Rank Fusion).
- Article improvement: one-click AI rewrites for grammar, structure, clarity, technical accuracy.
- Article generation: create runbooks, how-tos, and architecture docs from templates.
- Content analysis: auto-tagging, duplicate detection, knowledge gap identification.

It runs on Docker (4 containers: Fastify backend, React frontend, PostgreSQL with pgvector, Redis). For LLM inference it uses Ollama by default (everything local) or any OpenAI-compatible API.

Install in 3 minutes: `curl -fsSL https://raw.githubusercontent.com/Compendiq/compendiq-ce/main/scripts/install.sh | bash`

Tech stack: Fastify 5, React 19, TipTap v3 (ProseMirror), PostgreSQL 17, Redis 8, Ollama/OpenAI, TypeScript throughout.

AGPL-3.0. Community Edition has no artificial limits. Enterprise Edition adds OIDC/SSO and per-space RAG permissions.

Solo dev, happy to answer questions.

---

## Variant B: Personal, story-first

**Title:** `Show HN: I built an open-source AI layer for our Confluence wiki because cloud AI wasn't an option`

**Body:**

Hi HN,

I work with Confluence Data Center (the on-prem version). We had ~4,000 pages and the usual problem: nobody could find anything. Atlassian's AI features are Cloud-only. Third-party tools all want your data in their cloud. We needed something that ran on our hardware.

So I built Compendiq. It syncs your Confluence DC pages and puts an AI layer on top: ask questions across the whole knowledge base, improve existing articles, generate new ones from templates. It uses RAG with pgvector (hybrid vector + keyword search) and streams answers in real-time via SSE.

For inference it defaults to Ollama -- your data never leaves your network. Or you can point it at any OpenAI-compatible API.

One-command install: `curl -fsSL https://raw.githubusercontent.com/Compendiq/compendiq-ce/main/scripts/install.sh | bash`

Generates secrets, pulls Docker images from GHCR, starts the stack, and opens the setup wizard. Tested on macOS and Rocky Linux.

The codebase is a TypeScript monorepo: Fastify 5 backend, React 19 frontend, TipTap v3 editor with full Confluence macro round-trip support. Tests against a real PostgreSQL database, no database mocks.

AGPL-3.0, fully functional Community Edition with no limits. Enterprise tier adds SSO and per-space permissions.

Happy to go deep on any of the technical decisions (the XHTML conversion pipeline alone was an adventure). AMA.

---

## Variant C: Shortest, for backup

**Title:** `Show HN: Compendiq -- self-hosted AI for Confluence Data Center (open source)`

**Body:**

Compendiq connects to your Confluence Data Center instance and adds AI capabilities: RAG Q&A across your knowledge base, article improvement, content generation, auto-tagging, and duplicate detection.

Self-hosted Docker stack (Fastify, React, PostgreSQL + pgvector, Redis). Uses Ollama for local LLM inference. Your data stays on your hardware.

Install: `curl -fsSL https://raw.githubusercontent.com/Compendiq/compendiq-ce/main/scripts/install.sh | bash`

AGPL-3.0, no feature limits in the Community Edition.

https://github.com/Compendiq/compendiq-ce

Solo dev, happy to answer questions.

---

## HN Best Practices (for the founder)

1. **First comment matters.** Post a reply to your own submission within 5 minutes with additional technical context -- e.g., why you chose pgvector over a dedicated vector DB, or how the XHTML conversion pipeline works. HN rewards technical depth.

2. **Respond to every comment for the first 2 hours.** This is the critical window for staying on the front page. Genuine, technical responses outperform everything else.

3. **Do not ask for upvotes.** Not on HN, not on social media, not in DMs. HN actively penalizes vote rings.

4. **If someone finds a bug, acknowledge it immediately.** "Good catch, fixing now" is the ideal response. If you can push a fix and reply with "Fixed in [commit SHA]", even better.

5. **Do not delete and repost.** If it doesn't gain traction, accept it. HN considers resubmission within 24h as spam.

6. **Be honest about limitations.** "We haven't tested on Ubuntu yet" is better than silence. HN respects candor.

7. **The title format matters.** `Show HN:` prefix is mandatory. Keep the rest factual and specific. Avoid superlatives ("the best", "revolutionary").
