# Phase 1 Prerequisite Check — 2026-04-11

**Run by:** Claude (Phase 1 Session 1)
**Source:** `Phase 1 Implementation Plan.md` §0 Prerequisites

## Summary

| Status | Count |
|---|---|
| ✅ Verified ready | 5 |
| ⚠ Needs founder action | 3 |
| ❓ Not checkable by Claude | 5 |

**Session 1 can proceed** with read-only and draft-only work. Three items block launch-week execution and need founder action before 2026-05-05.

## Row-by-row

| # | Prerequisite | Status | Notes |
|---|---|---|---|
| P1 | `compendiq.com` DNS controllable | ✅ | Nameservers: `ns69.domaincontrol.com`, `ns70.domaincontrol.com` (GoDaddy). DNS records can be managed via the GoDaddy dashboard; if we choose Cloudflare Pages for the landing page, either (a) change nameservers to Cloudflare or (b) leave at GoDaddy and point a CNAME at `compendiq.pages.dev`. **Founder decision needed on DNS provider.** |
| P2 | Cloudflare Pages account linked to `compendiq.com` | ❓ | Cannot verify from this machine. **Founder confirms.** |
| P3 | `gh` CLI scopes | ⚠ | Logged in as `laboef1900`. Token scopes: `gist`, `read:org`, `repo`. **Missing:** `admin:org`, `discussions:write`, `workflow`. **Action:** `gh auth refresh -s admin:org,discussions:write,workflow` before A4/A5/A15 execution. |
| P4 | Docker Hub admin access | ❓ | Cannot verify (no web-UI automation). **Founder confirms.** Needed to flip `diinlu/compendiq-ce-*` images public at A6. |
| P5 | GitHub admin on `Compendiq` org | ⚠ | Cannot verify fully — the current session is logged in as `laboef1900`, not as the org admin. **Founder confirms** that the same or a parallel session has `admin:org` on `Compendiq`. The P3 scope refresh also satisfies this. |
| P6 | Hacker News account with karma > 100 | ❓ | **Founder only** — Claude cannot introspect HN accounts. |
| P7 | Product Hunt account ≥60 days old | ❓ | **Founder only**. Confirm the launch account was created before ~2026-03-06. |
| P8 | Reddit posting eligibility | ❓ | **Founder only**. Confirm posting karma / subreddit-age minimums on r/selfhosted, r/Confluence, r/homelab, r/devops. |
| P9 | Mailgun / Resend / SMTP account | ❓ | **Founder confirms**. API key needed for A14 enterprise email form. |
| P10 | YouTube channel | ❓ | **Founder only** — needed for A9 demo video upload. |
| P11 | Clean dev machine / VM for demo video | ❓ | **Founder only**. |
| P12 | `compendiq-ce` CI green on `dev` | ✅ | Latest 3 runs on `dev`: `Docker Build & Push` success (dc462e7), `Dependabot Updates` failure (bot-initiated, not blocking), `Docker Build & Push` success (28112ef). **OK to proceed.** |

## Critical actions before A4 / A5 / A15 execution

1. **P3 — gh CLI scope refresh.** Run:
   ```bash
   gh auth refresh -s admin:org,discussions:write,workflow
   ```
   This is a 30-second step but is required before Claude can:
   - Flip `compendiq-ce` public (A4) via `gh repo edit --visibility public`
   - Configure branch protection (A5) via `gh api`
   - Enable Discussions and post seeds (A15)

2. **P4 — Docker Hub UI action.** Log into Docker Hub, navigate to the `diinlu/compendiq-ce-*` images (backend, frontend, mcp-docs, searxng), flip visibility to public for each. Claude verifies afterward with `docker pull` from a clean session.

3. **P2 — Cloudflare Pages account.** Claude can draft the landing page but cannot deploy. Founder either:
   - Links an existing Cloudflare account to `compendiq.com`, supplies an API token in `$CLOUDFLARE_API_TOKEN`, and Claude does the deployment via `wrangler`
   - Takes the scaffold and deploys it manually via the Cloudflare dashboard

## What Session 1 can still do despite the blockers

Session 1 is drafts-only, so everything is unblocked:

- ✅ A1 repo audit (read-only)
- ✅ A3 CE tests without EE shim (local shell + test postgres on :5433)
- ✅ A16 CHANGELOG draft
- ✅ A15 Discussions seed posts **draft** (actual posting blocked on P3)
- ✅ Landing page **scaffold** (actual deployment blocked on P2)

All artifacts go to a `feature/phase1-session1` branch as a PR for founder review before any external-facing action happens.
