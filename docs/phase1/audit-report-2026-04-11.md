# Phase 1 A1 — CE Repo Audit

**Run by:** Claude (Phase 1 Session 1)
**Date:** 2026-04-11
**Scope:** `ce/` submodule at commit `dc462e7` (origin/dev HEAD)
**Purpose:** Identify any leaking references (enterprise internals, private URLs, secrets, stale planning docs) that should not be in the public CE repo when `compendiq-ce` flips to public at A4.

> **⚠ Audit revision 2026-04-11 (late):** The original audit below was **incomplete**. After this report was first written and PR #169 was opened, the `gh-pr-reviewer` agent ran a broader grep and surfaced **11 additional launch-critical references** that the original grep patterns missed — including the most user-visible one, the install command in `README.md`. See the "Audit revision" section at the bottom for the full list of missed findings and the broader grep patterns that should be used for any future audit. All missed findings are now fixed in PR #169 (commit `88ef806`).

## Headline

**No hard leaks. ~~One real pre-launch fix required.~~ 12 pre-launch fixes required — 5 caught by the original audit, 7 missed and caught by the PR review. All 12 are now fixed in PR #169.**

The CE repo is architecturally clean — all `compendiq-ee` and `@compendiq/enterprise` references are intentional open-core extension points (plugin loader, type contracts, loader tests) or overlay templates that are meant to ship publicly. The repo can go public at A4 after PR #169 lands.

## Findings by classification

### 🚨 FIX BEFORE LAUNCH — 1 item

| File | Issue | Fix |
|---|---|---|
| `scripts/install.sh` | References wrong GitHub namespace (`github.com/diinlu/compendiq`) and wrong image names (`diinlu/compendiq-frontend`, `diinlu/compendiq-backend`). Actual public repo is `github.com/Compendiq/compendiq-ce` and public images are `diinlu/compendiq-ce-frontend`, `diinlu/compendiq-ce-backend`. **If left unchanged, the launch-day install command will 404 or pull the wrong images.** | Rewrite references: `diinlu/compendiq` → `Compendiq/compendiq-ce`; `diinlu/compendiq-frontend` → `diinlu/compendiq-ce-frontend`; `diinlu/compendiq-backend` → `diinlu/compendiq-ce-backend`. Verify on a clean machine. |

Specific lines (grep reference):
- `scripts/install.sh:4` — `# https://github.com/diinlu/compendiq`
- `scripts/install.sh:7` — `curl -fsSL https://raw.githubusercontent.com/diinlu/compendiq/main/scripts/install.sh | bash`
- `scripts/install.sh:237` — `image: diinlu/compendiq-frontend:__VERSION__`
- `scripts/install.sh:253` — `image: diinlu/compendiq-backend:__VERSION__`
- `scripts/install.sh:413` — uninstall URL points at the same wrong repo

This is a real landmine. The Phase 0 installer testing on macOS + Rocky Linux 10 presumably used a different install path (local checkout or direct `docker compose up`), otherwise this would have been caught. The 2026-04-10 installer test needs to be re-run against the published install.sh once fixed.

**Recommended action:** land the install.sh fix in the same PR that flips the repo public (or in an earlier PR). Founder reviews the rename then Claude applies.

### ⚠️ REVIEW / FLAG — 2 items

| File | Concern | Recommendation |
|---|---|---|
| `docs/issues/phase0-implementation-plan.md` | Historical internal planning doc describing the Phase 0 implementation plan. Mentions `dhi.io` registry, EE docker-compose patterns, and internal decisions that were later revised. | Either (a) leave as historical context (fine for transparency), (b) move to a `docs/archive/` subdirectory to signal it's historical, or (c) remove before going public. **Default: option (a) — leave as-is** — public repos benefit from visible design history. |
| `docs/ENTERPRISE-ARCHITECTURE.md` (lines 995, and multiple references to `dhi.io` + `COMPENDIQ_LICENSE_KEY` env var flow) | Describes the EE architecture in detail, including registry paths that may be stale (`dhi.io` vs `diinlu`) and the pre-revision env-var license flow (rather than the DB-backed flow that actually shipped in Phase 0). | Refresh to reflect 2026-04-10 decisions: DB-backed license management, single standalone `docker-compose.ee.yml`, `dhi.io` reg references clarified or removed. Not a launch blocker, but will confuse readers. **Default: land a docs refresh PR in W2 alongside the landing page work.** |

### ✅ OK / EXPECTED — reviewed and approved

All `compendiq-ee` and `@compendiq/enterprise` references found in these files are the intentional open-core extension points. They are part of the public architecture and should remain:

| File | Why it's OK |
|---|---|
| `CLAUDE.md` | Documents the open-core model for any collaborator |
| `docs/ENTERPRISE-ARCHITECTURE.md` | Public architectural doc (needs refresh per above, but not a leak) |
| `scripts/build-enterprise.sh` | Template for the private EE overlay build — ships publicly as reference |
| `docker/Dockerfile.enterprise` | Same — template |
| `frontend/src/shared/enterprise/types.ts` | Interface the frontend loads at runtime |
| `backend/src/core/enterprise/types.ts` | Plugin contract |
| `backend/src/core/enterprise/loader.ts` | Dynamic loader with noop fallback |
| `backend/src/core/enterprise/loader.test.ts` | Tests for the above |
| `backend/src/core/types/compendiq-enterprise.d.ts` | Optional TypeScript declaration |

Test-placeholder secrets found — all clearly marked, none real:

| File | Value | OK because |
|---|---|---|
| `backend/src/test-setup.ts:6` | `JWT_SECRET = 'test-jwt-secret-that-is-at-least-32-characters-long'` | Clearly a test placeholder, only loaded in Vitest |
| `backend/src/core/plugins/auth.test.ts:14` | `JWT_SECRET = 'a-test-secret-that-is-at-least-32-chars-long!!'` | Same |

`COMPENDIQ_LICENSE_KEY` references found in 17 files — all are legitimate documentation of the public-facing env var (deprecated bootstrap fallback after the 2026-04-10 DB-backed license refactor). The env var name is public and intentional.

`.internal` / `private.` / `dhi.io` substring matches in SSRF guard code, route handlers, and URL parsing — all are benign pattern matches (regex for blocked internal IPs, URL parsing for Confluence endpoints) and not registry or secret references.

## Verification command run

```bash
rg -i "compendiq-ee" ce/  # 10 files, all expected
rg -i "dhi\.io|internal\.|private\.|\.internal" ce/  # 17 files, all expected
rg -i "COMPENDIQ_LICENSE_KEY|ATLASMIND_LICENSE_KEY|SIGNING_PRIVATE_KEY|JWT_SECRET\s*=\s*['\"][^$]" ce/  # all documented or test placeholders
```

## Recommendation to the founder

1. **Land the `install.sh` fix in its own small PR** this week. Test on a fresh macOS box via `bash -c "$(curl -fsSL <PR raw URL>)"`.
2. Optionally refresh `docs/ENTERPRISE-ARCHITECTURE.md` to reflect the 2026-04-10 decisions — nice-to-have, not a blocker.
3. Leave `docs/issues/phase0-implementation-plan.md` as historical context.
4. Proceed with A4 (repo public) only after the install.sh fix is merged.

---

## Audit revision 2026-04-11 (late)

After this report was first written and PR #169 (the `install.sh` fix) was opened, the `gh-pr-reviewer` agent was invoked to review the PR and ran a **broader grep** that the original audit missed. It surfaced 11 additional launch-critical references — including the most user-visible one: the `curl | bash` command in `README.md` that Show HN / Product Hunt visitors would click on day one.

### Why the original grep was too narrow

The original audit ran three grep patterns:

```bash
rg -i "compendiq-ee" ce/
rg -i "dhi\.io|internal\.|private\.|\.internal" ce/
rg -i "COMPENDIQ_LICENSE_KEY|ATLASMIND_LICENSE_KEY|SIGNING_PRIVATE_KEY|JWT_SECRET" ce/
```

These catch **enterprise-internal** references but not **pre-rebrand** references. The project was previously called `ai-kb-creator` under user `laboef1900`, and the rebrand swept the code but left the user-visible docs. The original audit had no pattern for the old name, so every stale doc-level reference was invisible.

### Missed findings (all now fixed in PR #169 commit 88ef806)

| File | Line(s) | What was wrong |
|---|---|---|
| `README.md` | 7 | CI badge URL pointed at `laboef1900/ai-kb-creator` |
| `README.md` | 9, 10 | Docker pull badges pointed at `diinlu/compendiq-backend`/`-frontend` (bare, no `-ce-` infix) |
| `README.md` | 142 | **The launch-day install one-liner** was `curl -fsSL https://raw.githubusercontent.com/laboef1900/ai-kb-creator/main/scripts/install.sh \| bash` — this is the link Show HN and PH visitors would actually click |
| `README.md` | 155 | "Pulls images from..." list used bare image names (no `-ce-` infix) |
| `README.md` | 164 | Second copy of the install one-liner in the "custom install directory" example |
| `README.md` | 181 | Docker Hub images table used bare names (no `-ce-` infix) |
| `README.md` | 207 | Developer Quick Start `git clone` used a `your-org/compendiq` placeholder |
| `CONTRIBUTING.md` | 18, 19 | `git clone https://github.com/laboef1900/ai-kb-creator.git` + `cd ai-kb-creator` |
| `docs/ADMIN-GUIDE.md` | 24, 25 | Same clone URL and directory name |
| `.github/ISSUE_TEMPLATE/config.yml` | 4 | Security contact link pointed at the stale private repo — broken on launch day |
| `docs/ENTERPRISE-ARCHITECTURE.md` | 1321 | Sample enterprise CI snippet referenced `github.com/yourorg/compendiq` placeholder |
| `scripts/install.sh` | 481 | `--dry-run` summary print still used bare `compendiq-frontend`/`compendiq-backend` without the `-ce-` infix (not caught by `install.test.sh` because the test harness doesn't assert on dry-run output) |
| `scripts/install.test.sh` | ~236 | `test_compose_defaults` only asserted the **backend** `:latest` tag, not the frontend — a stale frontend reference on the defaults path would slip through |

### Intentional / historical references (NOT fixed)

| File | Line(s) | Why it's OK |
|---|---|---|
| `docs/ACTION-PLAN-STANDALONE.md` | 3 | Historical planning doc referencing `laboef1900/ai-kb-creator/issues/353` — this is a real old issue number; leaving as historical context |
| `docs/issues/phase0-implementation-plan.md` | 44, 169 | The Phase 0 planning doc that **knew** about these stale refs and explicitly tracked them as TODO items. This PR closes those items — the planning doc stays as historical record. |
| `frontend/src/shared/lib/migrate-storage-key.ts` | 2 | Code comment documenting the rebrand history (`ai-kb-creator → AtlasMind → Compendiq`) — intentional as a migration helper note |
| `.github/CODEOWNERS` | 2,5,8,11,14,15,18 | `@laboef1900` is the founder's actual current GitHub username (the gh CLI still logs in as this user) — not a rebrand leftover |

### Broader audit grep for future use

For any future pre-launch audit on a similar product, the following grep patterns should replace the narrower ones in §Verification:

```bash
# Pre-rebrand project names (any prior name the project has ever had)
rg -n "laboef1900|ai-kb-creator|atlasmind|AtlasMind" ce/ --glob '!migrate-storage-key.ts' --glob '!docs/issues/**'

# Stale Docker Hub image names (bare vs. the actual -ce- prefixed names)
rg -nE "diinlu/compendiq-(backend|frontend|mcp-docs|searxng)[^-]" ce/

# Placeholder org names that should have been substituted during rebrand
rg -n "your-org/compendiq|yourorg/compendiq|<YOUR_ORG>|<your-org>" ce/

# Enterprise-only references leaking into open repo (original audit, still valid)
rg -i "compendiq-ee\|compendiq/enterprise" ce/

# Internal hostnames and private registry refs (original audit, still valid)
rg -iE "dhi\.io|\.internal[:/]" ce/

# Non-test secret placeholders (original audit, still valid)
rg -nE "JWT_SECRET\s*=\s*['\"][a-zA-Z0-9_-]{20,}" ce/ --glob '!*.test.ts' --glob '!test-setup.ts'
```

### Process improvement

The one-line rule I should have applied on the first pass: **audit any string a launch-day visitor could click, copy, or read — not just the ones I was looking for**. The original grep optimised for my mental model of what could leak (enterprise internals) instead of for what users would actually see. A full grep of every URL, image name, and `git clone` command in every Markdown file under `ce/` would have caught everything in one pass.

### Status

- **All 12 launch-critical findings now fixed** in PR #169 (commit `88ef806`, on top of `6c79b83` which addressed the 5 originally identified).
- Local test harness: **40 passed, 0 failed** (was 39 before the frontend-defaults assertion was added).
- CI on PR #169 will re-run automatically.
- **A4 (repo public) remains blocked until PR #169 merges** — but that was already true; the new findings just make it more obvious how important PR #169 is.
