# Reddit Launch Post Drafts

**Timing:**
- r/selfhosted: Launch day + 4h (after PH accumulates early social proof)
- r/Confluence, r/homelab, r/devops: Launch day + 24h (avoid cross-post flags)

**General rules:**
- Each subreddit gets unique framing. Never cross-post the same text.
- No link to Product Hunt or HN in the post. Reddit hates vote-trading.
- Link goes to the GitHub repo, not a landing page.
- Be a community member, not a marketer. Answer comments for at least 48h.
- If a mod removes the post, do not repost. Message the mod and ask what went wrong.

---

## r/selfhosted (primary)

**Flair:** New Software / Open Source (check current flair options before posting)

**Title:** `Compendiq: open-source AI knowledge base for Confluence Data Center (self-hosted Docker stack)`

**Body:**

I've been building an open-source tool that adds AI features to Confluence Data Center. Figured this community might find it useful since it's fully self-hosted and designed to keep your data on your hardware.

**What it does:**
- Connects to your Confluence Data Center instance and syncs pages
- RAG-powered Q&A: ask questions across your entire knowledge base in natural language
- Article improvement: AI rewrites for grammar, structure, clarity
- Article generation from templates (runbooks, how-tos)
- Auto-tagging, duplicate detection, knowledge gap analysis

**Stack:** Fastify 5, React 19, PostgreSQL 17 (pgvector), Redis 8. Uses Ollama for local LLM inference by default (nothing leaves your network). Also supports any OpenAI-compatible API if you prefer.

**Install:**
```
curl -fsSL https://raw.githubusercontent.com/Compendiq/compendiq-ce/main/scripts/install.sh | bash
```

This generates secrets, pulls Docker images from GHCR, starts 4 containers (frontend, backend, postgres, redis), and opens the setup wizard. Requires Docker Engine 24+ and 4 GB RAM.

AGPL-3.0, Community Edition has no feature limits. There's an Enterprise tier with OIDC/SSO and per-space permissions for larger teams.

GitHub: https://github.com/Compendiq/compendiq-ce

Happy to answer questions about the setup, architecture, or anything else. This is a solo project so responses might lag a few hours during European nights.

---

## r/Confluence

**Title:** `Open-source AI layer for Confluence Data Center -- self-hosted, no cloud dependency`

**Body:**

Hey r/Confluence,

I built this because Atlassian's AI features are Cloud-only and my team runs Confluence Data Center on-premise. There's nothing that gives you AI Q&A, article improvement, or content generation for DC -- at least not without sending your data to a third-party cloud.

**Compendiq** connects to your Confluence DC instance over the REST API, syncs your pages, and lets you:

- **Ask questions** across your entire knowledge base using RAG (pgvector hybrid search)
- **Improve articles** with one click -- grammar, structure, clarity, technical accuracy, or completeness
- **Generate new articles** from templates (runbooks, how-tos, architecture docs, troubleshooting guides)
- **Auto-tag pages** with LLM classification
- **Detect duplicates** and knowledge gaps

The editor has full Confluence macro support -- code blocks, task lists, panels, user mentions, page links, draw.io diagrams (read-only), and Children Pages macro. XHTML round-trip is preserved.

It runs as a Docker stack on your hardware. Uses Ollama for local LLM inference by default. Tested against Confluence DC 9.2.

GitHub: https://github.com/Compendiq/compendiq-ce

Install: `curl -fsSL https://raw.githubusercontent.com/Compendiq/compendiq-ce/main/scripts/install.sh | bash`

Open source (AGPL-3.0), no feature limits in the Community Edition. Would love to hear from other DC admins -- what macros am I not handling well? What would make this actually useful for your team?

---

## r/homelab

**Title:** `Self-hosted AI knowledge base for Confluence Data Center -- Docker stack + Ollama, everything local`

**Body:**

Built an AI-powered knowledge base tool that connects to Confluence Data Center and runs entirely on your own hardware. Thought the homelab crowd might appreciate the self-hosted + local AI angle.

**The setup:** 4 Docker containers (Fastify backend, React frontend, PostgreSQL with pgvector, Redis) + Ollama on the host for LLM inference. Total RAM footprint is about 2-3 GB for the app itself, plus whatever your Ollama model needs.

**What it does:** Syncs your Confluence DC pages, then lets you ask questions across the knowledge base (RAG with hybrid vector + keyword search), improve articles with AI, generate new docs from templates, auto-tag pages, and detect duplicates.

**Install:**
```
curl -fsSL https://raw.githubusercontent.com/Compendiq/compendiq-ce/main/scripts/install.sh | bash
```

Pulls images from GHCR, generates secrets, starts everything. Setup wizard opens in your browser.

The LLM part is flexible -- Ollama is the default (so your data never leaves the box), but you can point it at any OpenAI-compatible API (Azure OpenAI, LM Studio, vLLM, etc.).

AGPL-3.0, full Community Edition with no limits.

GitHub: https://github.com/Compendiq/compendiq-ce

If you're running Confluence DC in your homelab (or at work) and want to add AI capabilities without cloud dependencies, give it a try. Happy to answer questions about resource requirements, reverse proxy setups, or anything else.

---

## r/devops

**Title:** `Open-source self-hosted AI knowledge base for Confluence Data Center`

**Body:**

Sharing an open-source tool I built for teams running Confluence Data Center on-premise. It adds AI capabilities (RAG Q&A, article improvement, content generation) without requiring any cloud AI service -- everything runs locally with Ollama.

**Problem:** Confluence DC has no native AI features. Atlassian's AI is Cloud-only. If you're on DC because of data sovereignty, compliance, or network constraints, you're stuck with manual search and tribal knowledge.

**Solution:** Compendiq syncs your Confluence DC pages and adds:
- Hybrid search (pgvector + full-text keyword + RRF re-ranking)
- Natural language Q&A across the knowledge base (RAG with citations)
- AI article improvement (grammar, structure, clarity, accuracy)
- Article generation from templates
- Auto-tagging, duplicate detection, knowledge gap analysis

**Deployment:** Docker Compose stack -- 4 containers (Fastify 5 backend, React 19 frontend, PostgreSQL 17 + pgvector, Redis 8). Ollama runs on the host. One-command install:

```
curl -fsSL https://raw.githubusercontent.com/Compendiq/compendiq-ce/main/scripts/install.sh | bash
```

Health probes on `/api/health` (live, ready, start). OpenTelemetry tracing supported. All config via env vars.

**Licensing:** AGPL-3.0 Community Edition with no limits. Enterprise tier (separate binary) adds OIDC/SSO and per-space RAG permissions.

GitHub: https://github.com/Compendiq/compendiq-ce

Interested in hearing about edge cases -- air-gapped environments, reverse proxy requirements, or unusual Confluence DC setups. Solo dev, will be around to answer questions.

---

## Comment Templates

### For responding to "why not just use Confluence Cloud AI?"

> Confluence Cloud AI requires migrating to Cloud, which isn't an option for many organizations (compliance, network isolation, data sovereignty). Compendiq is specifically for teams that need to stay on Data Center.

### For responding to "why AGPL?"

> AGPL ensures that if someone builds a hosted service on top of Compendiq, they have to contribute back. For self-hosted deployments (which is the primary use case), AGPL behaves the same as GPL -- you can use it internally without any obligation to release your changes. The Enterprise tier uses a separate proprietary license.

### For responding to "security concerns about curl | bash"

> Fair point. You can also clone the repo and review `scripts/install.sh` before running it -- it's about 200 lines of bash. The script generates local secrets, writes a docker-compose.yml, and runs docker compose up. No telemetry, no external calls beyond pulling the Docker images from GHCR.

### For responding to "what about Confluence Cloud?"

> Right now Compendiq targets Data Center only. Cloud support (one-way import) is on the roadmap for v1.2 but not committed yet. The REST API differences between Cloud and DC are significant enough that it's a separate engineering effort.
