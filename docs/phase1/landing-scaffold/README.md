# Compendiq Landing Page — Phase 1 Scaffold

**Claude draft 2026-04-11 (Phase 1 Session 1) — for founder review.**

This is a static-HTML scaffold for `compendiq.com`. Single-file, zero build step, deployable to Cloudflare Pages / GitHub Pages / any static host.

## What's in here

- `index.html` — hero, three-feature strip, install block, SaaS teaser, stewardship hedge, community links, footer
- `styles.css` — minimal CSS (no Tailwind build needed at this stage)
- This README

## `{{FOUNDER_TODO}}` markers

The founder must fill in or approve these before launch:

1. `{{FOUNDER_NAME}}` — your first name for the "built by" line
2. `{{HERO_TAGLINE}}` — current draft: "Bring AI to your Confluence Data Center, self-hosted." Approve or rewrite.
3. `{{STEWARDSHIP_HEDGE}}` — §2.4 of the Phase 1 plan asks: soft hedge ("A formal stewardship commitment ships with v1.1 in August 2026") or hard commitment now? Default = soft.
4. `{{DEMO_VIDEO_URL}}` — replace the placeholder once the video is live (A9)
5. `{{GITHUB_STARS_BADGE_URL}}` — pick a Shields.io URL or GitHub's native badge
6. `{{ENTERPRISE_FORM_ENDPOINT}}` — the POST endpoint for A14. If Mailgun/Resend, the founder provides the form-submission URL; if self-hosted, it's a serverless function.

## How to deploy (founder, not Claude)

```bash
# Option A: Cloudflare Pages (recommended per Phase 1 plan §5.x)
cd docs/phase1/landing-scaffold
wrangler pages deploy . --project-name compendiq-landing

# Option B: GitHub Pages (fallback per failure playbook)
# Commit this directory to a dedicated branch of compendiq-ce
# In repo settings → Pages → source branch = <branch>, folder = /docs/phase1/landing-scaffold
```

## Intentional omissions

- **No CMS.** Static HTML only. Any copy change is a git commit.
- **No analytics.** Add Plausible or Fathom post-launch if needed — no tracking on day one.
- **No dark-mode toggle.** Landing pages don't need the glassmorphic dashboard aesthetic; the goal is legibility and fast load.
- **No pricing page.** On-premise CE is free; Enterprise pricing is a conversation via the email form. Pricing page arrives with Phase 3 (public SaaS).
