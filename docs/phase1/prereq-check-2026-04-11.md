# Phase 1 Prerequisite Check — 2026-04-11

**Run by:** Claude (Phase 1 Session 1)
**Source:** `Phase 1 Implementation Plan.md` §0 Prerequisites
**Revised 2026-04-11 (late):** Founder decisions removed A8 (landing page → Phase 3), A14 (email form → deferred), and corrected the gh scope name. This file now reflects the revised state.

## Summary

| Status | Count |
|---|---|
| ✅ Verified ready | 3 |
| ⚠ Needs founder action (quick) | 2 |
| ❓ Founder-confirmed / founder-only | 5 |
| n/a (deferred by 2026-04-11 decision) | 2 |

**Session 1 proceeded** with read-only and draft-only work. Two prerequisites block launch-week execution and need founder action before 2026-05-05.

## Row-by-row

| # | Prerequisite | Status | Notes |
|---|---|---|---|
| P1 | `compendiq.com` DNS controllable | ✅ | Nameservers: `ns69.domaincontrol.com`, `ns70.domaincontrol.com` (GoDaddy). DNS is controllable. Not urgent — with A8 moved to Phase 3, the domain is unused at launch (or optionally set up a simple redirect to the GitHub repo). |
| P2 | ~~Cloudflare Pages account linked to `compendiq.com`~~ | n/a | **Not needed per 2026-04-11 founder decision.** A8 landing page moved to Phase 3 alongside the SaaS showcase. Phase 1 launch routes all traffic directly to `github.com/Compendiq/compendiq-ce`. |
| P3 | `gh` CLI scopes | ⚠ | Logged in as `laboef1900`. Token scopes: `gist`, `read:org`, `repo`. **Missing:** `admin:org`, `workflow`. **Action:** `gh auth refresh -s admin:org,workflow` before A4/A5 execution. **Correction:** an earlier draft listed `discussions:write` which is not a valid GitHub OAuth scope — it produced `invalid_scope` errors. The correct singular name is `write:discussion` but even that is unnecessary because the `repo` scope already covers GitHub Discussions operations on `compendiq-ce`. |
| P4 | Docker Hub admin access | ✅ | Founder confirmed access 2026-04-11. When ready to flip images public at A6, log into Docker Hub, navigate to `diinlu/compendiq-ce-*` (backend, frontend, mcp-docs, searxng), set visibility to public. Claude verifies afterward with `docker pull`. |
| P5 | GitHub admin on `Compendiq` org | ⚠ | Cannot verify fully from the `laboef1900` session. **Founder confirms** that the same or a parallel session has `admin:org` on `Compendiq`. The P3 scope refresh also satisfies this. |
| P6 | Hacker News account with karma > 100 | ❓ | **Founder only** — Claude cannot introspect HN accounts. |
| P7 | Product Hunt account ≥60 days old | ❓ | **Founder only**. Confirm the launch account was created before ~2026-03-06. |
| P8 | Reddit posting eligibility | ❓ | **Founder only**. Confirm posting karma / subreddit-age minimums on r/selfhosted, r/Confluence, r/homelab, r/devops. |
| P9 | ~~Mailgun / Resend / SMTP account~~ | n/a | **Not needed per 2026-04-11 founder decision.** A14 enterprise email form is deferred; Phase 1 routes interest via GitHub issues or a plain `mailto:` link. |
| P10 | YouTube channel | ❓ | **Founder only** — needed for A9 demo video upload. |
| P11 | Clean dev machine / VM for demo video | ❓ | **Founder only**. |
| P12 | `compendiq-ce` CI green on `dev` | ✅ | Latest 3 runs on `dev`: `Docker Build & Push` success (dc462e7), `Dependabot Updates` failure (bot-initiated, not blocking), `Docker Build & Push` success (28112ef). **OK to proceed.** |

## Critical actions before A4 / A5 execution

1. **P3 — gh CLI scope refresh (30 seconds).** Run:
   ```bash
   gh auth refresh -s admin:org,workflow
   ```
   Required before Claude can:
   - Flip `compendiq-ce` public (A4) via `gh repo edit --visibility public`
   - Configure branch protection (A5) via `gh api`

   A15 (GitHub Discussions setup) uses the `repo` scope that's already in place — no additional scope needed.

2. **P4 — Docker Hub UI action.** Founder has access confirmed. When ready: Docker Hub web UI → `diinlu/compendiq-ce-*` images → flip to public. Claude verifies.

## What Session 1 delivered

Session 1 is drafts-only. Everything is landed in `feature/phase1-session1` (PR #168):

- ✅ A1 repo audit (read-only) — one real fix surfaced, landed as PR #169 (install.sh public-repo references)
- ✅ A3 CE tests without EE shim — backend 1686/1686, frontend 1705/1705
- ✅ A16 CHANGELOG draft
- ✅ A15 Discussions seed posts **draft** (actual posting blocked on the quick gh scope refresh)

**Dropped from Session 1 on 2026-04-11 founder decision:**
- A8 landing page scaffold — moved to Phase 3 alongside the SaaS showcase. See `Phase 3 Landing Page Scaffold/` in the Nextcloud research folder for the preserved draft.
- A14 enterprise email form — deferred; Phase 1 uses `mailto:` or GitHub issues instead.
