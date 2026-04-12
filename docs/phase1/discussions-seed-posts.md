# GitHub Discussions — Seed Posts Draft

**Claude draft 2026-04-11 (Phase 1 Session 1) — for founder review before posting.**

These are the 4 seed posts for the 4 GitHub Discussions categories that launch with v1.0. Post them manually (or via `gh api`) once the repo is public and Discussions is enabled.

Tone notes:
- Conversational, not corporate
- "We" = the founder. Don't pretend to be a team.
- Every post ends with a concrete ask so there's a hook for replies
- No marketing copy; treat readers like peers

---

## Category: Announcements

**Title:** `Welcome to Compendiq — v1.0 is live`

**Body:**

> Hey everyone,
>
> Compendiq just went public at v1.0. If you ended up here from Product Hunt, Hacker News, Reddit, or somewhere else — welcome.
>
> **What Compendiq is:** an open-source, self-hosted AI layer for Confluence Data Center. It connects to your Confluence instance over the network, syncs page content, and lets you ask questions, improve articles, and generate new ones using an LLM of your choice (Ollama by default, or any OpenAI-compatible API).
>
> **What's free and what's not:** the Community Edition you see on the repo is AGPL-3.0 and has no functional limits — full RAG Q&A, full article generation, full sync. The Enterprise Edition adds SSO/OIDC, per-space RAG permissions, audit log export, and seat enforcement, and requires a separate proprietary license key.
>
> **Install:** `curl -fsSL https://raw.githubusercontent.com/Compendiq/compendiq-ce/main/scripts/install.sh | bash` — this auto-generates secrets, pulls the images from GHCR, and opens the first-run wizard in your browser. Tested on macOS 14 and Rocky Linux 10 so far; Ubuntu / Debian / WSL2 is in Phase 2.
>
> **What to do from here:**
> - File bugs you hit in the Q&A category below (please include install platform + Confluence DC version + a copy of the error)
> - Ask for features in the Ideas category — I'm particularly interested in hearing which Confluence DC 9.x macros we're still not rendering well
> - If you get it running, drop a note in Show & Tell — I'd love to see screenshots of real knowledge bases
>
> I'm a team of one, so responses may lag by a few hours during European nights. The project isn't going anywhere — if you invest time on a self-hosted install, I'm committed to making it work for you.
>
> — {{FOUNDER_NAME}}

---

## Category: Q&A

**Title:** `Install troubleshooting — drop your issue here`

**Body:**

> Use this thread for anything that goes wrong during install or first-run. A few things to include so I (or a helpful bystander) can help you faster:
>
> 1. **Platform:** macOS / Linux distro + version / WSL2 / native Windows
> 2. **Docker version:** `docker --version` and `docker compose version`
> 3. **Confluence DC version:** (from Atlassian admin UI)
> 4. **What step failed:** was it `install.sh`? the first-run wizard? the Confluence connection test? the first sync?
> 5. **Logs:** `docker compose logs backend --tail=200` usually has the relevant error. Paste it in a fenced code block, not a screenshot.
>
> **Known issues as of v1.0 launch:**
> - `install.sh` on Ubuntu 22.04 and Debian 12 has not been tested yet — may need Docker-first setup. See #{{ISSUE_NUMBER}} for progress.
> - Windows / WSL2 is Phase 2 work. If you're on WSL2 and it works, please tell me what you did.
>
> If your issue turns out to be a bug in Compendiq itself rather than config, I'll open a GitHub issue for it and link back here. Severity triage:
> - **Critical** (data loss, auth bypass): patch within 24h, released as v1.0.x
> - **High** (install fails, sync breaks): within 72h
> - **Medium / low:** next minor release
>
> For **security issues, don't post here** — follow `SECURITY.md` and email the disclosure address.

---

## Category: Show & Tell

**Title:** `Show us your Compendiq setup`

**Body:**

> This is the "I got it running and here's what it does" thread. Everything is welcome:
>
> - Screenshots of your knowledge base + AI Q&A
> - Your docker-compose customizations
> - How you integrated Compendiq with your existing internal tooling
> - Dashboards showing content-gap analysis on your real knowledge
> - Weird edge cases that ended up working better than expected
>
> Two things I'd especially love to see:
>
> 1. **Unusual Confluence DC deployments** — air-gapped, behind a reverse proxy, self-signed certs, multi-region, whatever. I tested against a single Confluence DC 9.2 instance. Your setup is almost certainly more interesting than mine.
> 2. **Custom LLM providers** — Compendiq supports any OpenAI-compatible API out of the box, so if you've wired it to LM Studio, vLLM, Azure OpenAI, a local llama.cpp, or an in-house gateway, drop a note. Rough performance numbers welcome.
>
> If you have a blog post or video walkthrough, please link it. I'll feature the best ones in a future Announcements post.

---

## Category: Ideas

**Title:** `What should Compendiq do next?`

**Body:**

> v1.0 is deliberately the "sync + search + AI on Confluence DC" vertical, nothing more. There's a roadmap for what comes after, but the roadmap is owned by this community as much as by me. Use this thread to propose anything — features, UX changes, integrations, workflows — and I'll respond with one of:
>
> - **Already planned** (with a link to the roadmap item)
> - **Good idea, adding to the backlog**
> - **Interesting but not yet** (with my best guess at when)
> - **I don't think this fits the project** (with a reason)
>
> Some things I'm already thinking about for v1.1 and v1.2:
>
> - **Full draw.io in-place editing** (currently read-only)
> - **SCIM user provisioning** for enterprise deployments
> - **AI output review workflow** — human-in-the-loop approval before AI content gets pushed back to Confluence
> - **Slack/Teams integration** — deep links + "ask Compendiq" command
> - **Confluence Cloud import** — one-way migration path for teams moving from Cloud → DC or Compendiq
>
> A few things I'm **not** planning to do, to set expectations:
>
> - A hosted SaaS version in the next 6 months (it's on the 2027 roadmap, but on-premise is the priority for launch)
> - Support for non-Confluence knowledge sources (maybe post-v2, if there's demand)
> - A mobile app (the web UI is responsive; a native app is a v2+ ask)
>
> Your turn — what's missing?

---

## How to post these

Once the repo is public and Discussions is enabled:

```bash
# Enable Discussions on the repo
gh api \
  --method PATCH \
  -H "Accept: application/vnd.github+json" \
  /repos/Compendiq/compendiq-ce \
  -f has_discussions=true

# Create the 4 categories via the GraphQL API (REST doesn't support category creation)
# Categories to create:
#   1. Announcements (format: Announcement)
#   2. Q&A (format: Q&A)
#   3. Show & Tell (format: Open)
#   4. Ideas (format: Open)

# Post each seed (requires `discussions:write` scope on the gh CLI token)
gh api \
  --method POST \
  /repos/Compendiq/compendiq-ce/discussions \
  -f category_id=<ID> \
  -f title="Welcome to Compendiq — v1.0 is live" \
  -f body="$(cat announcements-post.md)"
```

**Prerequisite:** `gh auth refresh -s discussions:write` to add the scope (the Phase 1 Session 1 prereq check found this is missing).
