# Phase 1 A1 — CE Repo Audit

**Run by:** Claude (Phase 1 Session 1)
**Date:** 2026-04-11
**Scope:** `ce/` submodule at commit `dc462e7` (origin/dev HEAD)
**Purpose:** Identify any leaking references (enterprise internals, private URLs, secrets, stale planning docs) that should not be in the public CE repo when `compendiq-ce` flips to public at A4.

## Headline

**No hard leaks. One real pre-launch fix required. Two items flagged for review.**

The CE repo is architecturally clean — all `compendiq-ee` and `@compendiq/enterprise` references are intentional open-core extension points (plugin loader, type contracts, loader tests) or overlay templates that are meant to ship publicly. The repo can go public at A4 after the one fix below lands.

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
