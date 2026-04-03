# Phase 0 — Implementation Plan for Remaining Gaps

**Date:** 2026-04-03
**Deadline:** 2026-04-26 (23 days)
**Author:** Gap analysis against Release Roadmap (Research/AtlasMind)
**Reviewed by:** Critic pass — corrections integrated below

---

## Executive Summary

Phase 0 is **~75% complete**. This plan addresses the 12 remaining gaps. Estimated total effort: **~42 hours** (~11 working days at 4h/day), fitting within the 23-day window with buffer.

**Key decision:** SaaS infrastructure (§3.7) is deferred to post-launch. See rationale below.

---

## CRITICAL DECISION: SaaS Infrastructure — DEFER

**Recommendation:** Defer 100% of SaaS work to a post-v0.1.0 phase.

**Rationale:**
- The SaaS scope (multi-tenant DB, tenant provisioning, Stripe billing, signup flow, landing page, cloud hosting, CDN, monitoring, zero-downtime deploys) is a 3–6 month effort. It is impossible in 23 days.
- Phase 0's primary goal is "everything needed before flipping the repo to public." A SaaS offering is not a prerequisite for an open-source public launch.
- The self-hosted Docker path (install.sh, docker-compose, setup wizard) is fully functional.
- The User Growth & Scaling Action Strategy research explicitly states: "Do not solve tomorrow's scaling problem today" and recommends single-tenant Docker Compose per customer as the initial SaaS approach (Tier 1, triggered by first paying customer).

**Consequence for Definition of Done:**
The roadmap's Phase 0 Definition of Done includes "SaaS infrastructure is live." With this deferral, we redefine Phase 0 DoD to the **on-premise launch gates only** (functional, security, operational/on-prem, documentation, distribution). SaaS gates move to Phase 1.

**Action:** Add a "Compendiq Cloud" section to README noting that managed SaaS hosting is planned. This sets expectations without false promises.

**Consequence for EE go-to-market:**
At v0.1.0, only OIDC/SSO and seat enforcement are implemented in the EE overlay. Other enterprise features (SCIM, LLM audit trail, RAG permissions, etc.) are gated via feature flags but have no implementation behind them. This is acceptable — the license infrastructure is ready, and features ship incrementally in v1.1+. EE should not be marketed until OIDC is verified working end-to-end.

---

## PREREQUISITE: Resolve GitHub Organization Name

**This must happen before Gaps 3, 5, and 6 can proceed.**

Currently three different namespaces are in use:
- Docker Hub: `diinlu/compendiq-ce-*`
- README badge: `laboef1900/ai-kb-creator`
- EE README: `github.com/Compendiq/compendiq-ee`

**Action:** Decide on the final GitHub organization/repository name (recommendation: `Compendiq/compendiq` or `Compendiq/compendiq-ce`). All URL references across both repos depend on this.

**Effort:** Decision only (0h engineering, but blocks other work)

---

## Gap-by-Gap Implementation Plans

### Gap 1: OIDC Conditional Registration (CE `app.ts`)

**Priority:** Tier 1 — Launch blocker (EE is non-functional without this)

**Analysis (critic correction):** The OIDC code at `app.ts:195-205` is *intentionally* commented out in the CE codebase. The CE repo does not contain `routes/foundation/oidc.ts` — that file only exists in the EE overlay. The current state IS the correct CE state.

However, the EE build script (`build-enterprise.sh`) patches `app.ts` during the merge phase. **The real question is:** does the EE build correctly uncomment/insert the OIDC registration? If yes, Gap 1 is not a gap — it's working as designed.

**Tasks:**
1. Verify the EE build script patches `app.ts` to activate OIDC registration (read `build-enterprise.sh` Phase 3: "Patch app.ts").
2. Build the EE (`./scripts/build-enterprise.sh --skip-obfuscate`) and verify OIDC routes are registered when a valid enterprise license with `oidc_sso` feature is active.
3. If the build patch is missing or broken: fix the build script (not the CE source).
4. Document: "CE `app.ts` contains a commented OIDC placeholder. The EE build script activates it during merge."

**Files:** `/compendiq-ee/scripts/build-enterprise.sh` (verify/fix, not CE `app.ts`)
**Effort:** 2h (verification + potential build script fix)
**Acceptance:** EE build registers OIDC routes; CE build does not.

---

### Gap 2: docker-compose.ee.yml (EE repo)

**Priority:** Tier 2 — Important for documented EE deployment path

**Tasks:**
1. Create `/compendiq-ee/docker/docker-compose.ee.yml`:
   ```yaml
   services:
     backend:
       image: dhi.io/compendiq-backend:ee
       build: !reset null
       environment:
         COMPENDIQ_LICENSE_KEY: ${COMPENDIQ_LICENSE_KEY}
   ```
2. Verify merge: `docker compose -f docker/docker-compose.yml -f docker/docker-compose.ee.yml config` produces valid YAML with backend image overridden.
3. Update EE README to remove the "planned" tone — the file now exists.

**Files:** `/compendiq-ee/docker/docker-compose.ee.yml` (create)
**Effort:** 30min
**Acceptance:** Compose merge works, standalone compose unaffected.

---

### Gap 3: GHCR Mirror Publishing

**Priority:** Tier 2 — Trust signal for open-source projects

**Blocked by:** GitHub org name decision (prerequisite above)

**Tasks:**
1. In `/compendiq-ce/.github/workflows/docker-build.yml`, for each of the 4 jobs:
   a. Add `packages: write` to permissions.
   b. Add GHCR login step.
   c. Use dual `images` list in metadata-action:
      ```yaml
      images: |
        diinlu/compendiq-ce-backend
        ghcr.io/<org>/compendiq-ce-backend
      ```
2. Test with a workflow dispatch dry run before merging.

**Files:** `/compendiq-ce/.github/workflows/docker-build.yml`
**Effort:** 3h
**Acceptance:** Tag push publishes to both Docker Hub and GHCR.

---

### Gap 4: Public Stewardship Commitment

**Priority:** Tier 1 — Critical for open-source trust

**Context from research:** The Open-Core Business Model research explicitly states: "GitLab publishes a public stewardship promise: they will never move a feature from free to paid. AtlasMind should adopt the same commitment."

**Tasks:**
1. Create `/compendiq-ce/STEWARDSHIP.md` containing:
   - Pledge: features in Community Edition will never be moved behind the Enterprise paywall.
   - The AGPL-3.0 license is irrevocable for released versions.
   - Community contributions remain under AGPL-3.0.
   - The open-core boundary: CE = full self-hosted product; EE = governance, compliance, identity, and organizational-scale features (the "IT buyer" features, not the "individual contributor" features).
2. Add a "Stewardship" section to README with a brief summary and link.

**Files:** `/compendiq-ce/STEWARDSHIP.md` (create), `/compendiq-ce/README.md` (add section)
**Effort:** 2h
**Acceptance:** Clear, unambiguous pledge exists. No vague language.

---

### Gap 5: Cross-Platform Installer Testing

**Priority:** Tier 3 — Important but deferrable

**Tasks:**
1. Add `--dry-run` flag to `/compendiq-ce/scripts/install.sh` that stops after generating `.env` and `docker-compose.yml` but before pulling images or starting services.
2. Create `/compendiq-ce/.github/workflows/installer-test.yml` with matrix:
   - `ubuntu-22.04` (GitHub-hosted)
   - `macos-14` (GitHub-hosted Apple Silicon)
   - Debian 12 via Docker-in-Docker step
3. Each matrix entry tests: Docker detection, Compose v2 detection, secret generation, `.env` creation, compose YAML generation.
4. WSL2: document manual test procedure (cannot automate in CI).

**Files:** `/compendiq-ce/scripts/install.sh` (add `--dry-run`), `/compendiq-ce/.github/workflows/installer-test.yml` (create)
**Effort:** 5h
**Acceptance:** CI matrix passes on Ubuntu/Debian/macOS. WSL2 procedure documented.

---

### Gap 6: GitHub Repository Preparation

**Priority:** Tier 1 — This IS the launch

**Blocked by:** Gap 4 (stewardship), Gap 7 (license alignment), org name decision

**Tasks:**
1. Update all repository URLs across both repos:
   - `/compendiq-ce/README.md` badges (currently `laboef1900/ai-kb-creator`)
   - `/compendiq-ce/CONTRIBUTING.md` repo URL (line 18)
   - `/compendiq-ce/scripts/install.sh` (line 4)
   - `/compendiq-ce/.github/CODEOWNERS` (org handle)
2. Add EE version compatibility matrix to CE README:
   ```markdown
   ## Enterprise Edition
   | CE Version | EE Version | Notes |
   |-----------|-----------|-------|
   | 0.1.x     | 0.1.x    | Current |
   ```
3. Promote CHANGELOG.md `[Unreleased]` section to `[0.1.0] — 2026-04-26` (critic catch: cannot tag a release with an empty changelog).
4. Configure branch protection on `main` and `dev` (GitHub UI or API):
   - Require PR + CI pass + 1 review on `main`
   - Require PR + CI pass on `dev`
5. Add "Compendiq Cloud" planned section to README (SaaS deferral note).
6. Tag `v0.1.0` on `main`.
7. Make repo public.

**Files:** Multiple (see list above)
**Effort:** 4h
**Acceptance:** All URLs correct, branch protection active, CHANGELOG has tagged release, repo is public.

---

### Gap 7: EE License Type Alignment

**Priority:** Tier 1 — Legal consistency required before going public

**Decision: Keep "All Rights Reserved" (Proprietary).**

The research documents reference BUSL-1.1 (same model as HashiCorp, Sentry, CockroachDB). The actual EE LICENSE is "All Rights Reserved." Both are viable, but they have different implications:
- **BUSL-1.1:** Source-available, converts to Apache 2.0 after change date (typically 4 years). Industry-accepted.
- **All Rights Reserved:** Maximum protection, no auto-conversion, less transparent.

**Recommendation:** The founder must make this decision. Either is defensible. If choosing to stay with "All Rights Reserved," remove all BUSL-1.1 references. If switching to BUSL-1.1, update the LICENSE file. **Do not ship with conflicting references.**

**Tasks (assuming "All Rights Reserved" stays):**
1. Update `/compendiq-ee/scripts/build-enterprise.sh` lines 13, 306: change "BUSL-1.1" → "Proprietary".
2. Update `/compendiq-ce/docs/ENTERPRISE-ARCHITECTURE.md`:
   - Line 140: `"license": "BUSL-1.1"` → `"license": "SEE LICENSE IN LICENSE"`
   - Lines ~1208, ~1424: replace BUSL-1.1 → "Proprietary (All Rights Reserved)"
3. Update `/compendiq-ce/docker/Dockerfile.enterprise` line 15: "BUSL-1.1" → "Proprietary".

**Note (critic flag):** The legal coherence of AGPL-3.0 (CE) + proprietary plugin running in the same process should be reviewed with legal counsel. AGPL has network copyleft implications. This is not a blocker for launch (GitLab and Metabase use the same model), but should be on the radar.

**Files:** See list above
**Effort:** 1h
**Acceptance:** Zero BUSL-1.1 references in either repo. All EE license references say "Proprietary" or "All Rights Reserved" consistently.

---

### Gap 8: Missing E2E Tests

**Priority:** Tier 2 — Coverage for two core user flows

**Tasks:**
1. Create `/compendiq-ce/e2e/pdf-export.spec.ts`:
   - Register test user, create page with known content.
   - Navigate to page, trigger PDF export.
   - Verify download event / response headers.
   - Follow existing patterns in `pages-crud.spec.ts`.

2. Create `/compendiq-ce/e2e/confluence-sync.spec.ts`:
   - **Mark as `test.skip` unless `CONFLUENCE_URL` env var is set** (cannot run in CI — no Confluence container in `pr-check.yml`).
   - When enabled: configure Confluence connection, test connection, trigger sync, verify page appears.
   - This test is primarily documentation-as-code for the integration flow.

**Critic note acknowledged:** The Confluence sync test cannot run in CI and is therefore local-only coverage. This is acceptable — it proves the flow works and catches regressions during local development. Adding a Confluence container to CI is out of scope for Phase 0.

**Files:** `/compendiq-ce/e2e/pdf-export.spec.ts` (create), `/compendiq-ce/e2e/confluence-sync.spec.ts` (create)
**Effort:** 5h
**Acceptance:** PDF export test passes in CI. Confluence sync test passes locally with Confluence running.

---

### Gap 9: Test Coverage Reports

**Priority:** Tier 2 — Must measure before claiming readiness

**Critic warning:** If actual coverage is far below targets (70% backend / 60% frontend), this gap explodes in scope. **Run coverage on Day 1 to get the number early.**

**Tasks:**
1. Verify `@vitest/coverage-v8` is installed (already in `backend/package.json` as devDep).
2. Add coverage config to `/compendiq-ce/backend/vitest.config.ts`:
   ```typescript
   coverage: {
     provider: 'v8',
     include: ['src/**/*.ts'],
     exclude: ['src/**/*.test.ts', 'src/**/__mocks__/**'],
   }
   ```
3. Add coverage config to `/compendiq-ce/frontend/vitest.config.ts` similarly.
4. Run `npx vitest run --coverage` in both workspaces. Record results.
5. **If targets met:** Add threshold enforcement and commit.
6. **If targets not met:** Document actual coverage, create tracking issues for improvement. Set thresholds to current level (avoid blocking CI). Do NOT spend days writing tests to hit arbitrary numbers — ship what exists.
7. Optionally add coverage step to `pr-check.yml`.

**Files:** Backend + frontend vitest configs, root package.json (add script)
**Effort:** 3h (config + run + analysis). Could be 8h+ if remediation needed.
**Acceptance:** Coverage measured and documented. Thresholds set (at current level or target level).

---

### Gap 10: Wizard State Persistence

**Priority:** Tier 3 — Polish

**Critic correction:** The wizard uses `useState` for `currentStep`. On browser refresh, this resets. However, `useSetupStatus()` queries `/api/health/setup-status` which reports server-side completion per step (admin exists, LLM configured, etc.). The wizard already skips completed steps on mount.

**The right approach is to derive resume position from server state, NOT localStorage.** Adding localStorage creates a second source of truth that can diverge across devices/sessions.

**Tasks:**
1. Read the setup route handler to verify it reports per-step completion in real-time (not just full-wizard completion).
2. If per-step tracking works: verify the wizard auto-advances past completed steps after a refresh. If it does, this gap is already closed — document it.
3. If there's a gap (e.g., LLM config is saved but setup-status doesn't reflect it): fix the server endpoint to report accurate per-step state.
4. Write a test: complete steps 1-2, unmount wizard, remount, verify it resumes at step 3.

**Files:** Potentially `SetupWizard.tsx`, setup route handler
**Effort:** 2h (investigation-first, may be a no-op)
**Acceptance:** Refreshing the wizard mid-flow does not force re-entry of completed steps.

---

### Gap 11: Contracts Enterprise Schema

**Priority:** Tier 3 — Accept deviation

**Decision:** Do not create `packages/contracts/src/schemas/enterprise.ts`.

Enterprise types are co-located with the plugin loader (`core/enterprise/types.ts`) because they define an internal plugin interface, not an API boundary needing Zod runtime validation. This is a reasonable architectural decision.

**Tasks:**
1. Add a brief note to `docs/ENTERPRISE-ARCHITECTURE.md` explaining the deviation.

**Files:** `/compendiq-ce/docs/ENTERPRISE-ARCHITECTURE.md`
**Effort:** 15min
**Acceptance:** Deviation documented.

---

### Gap 12: Performance Benchmark

**Priority:** Tier 3 — Verify claims before launch

**Critic note:** Running the benchmark requires a seeded database with 1,000 pages AND their embeddings (requires Ollama running with bge-m3). Results will be hardware-specific.

**Tasks:**
1. Run seed script: `npx tsx scripts/seed-perf-data.ts` (creates 1,000 pages).
2. Measure hybrid search latency: keyword, semantic, and hybrid modes.
3. Record results in `docs/PERFORMANCE.md` (file exists but has no measured data).
4. If p99 > 500ms: investigate query plans, HNSW index status.
5. Document hardware used so results are contextual, not absolute.

**Files:** `/compendiq-ce/docs/PERFORMANCE.md` (update with results)
**Effort:** 4h (including troubleshooting if Ollama/embeddings need setup)
**Acceptance:** Benchmark results recorded with hardware context. Hybrid search p99 < 500ms target (or documented exception).

---

## CE vs EE Feature Classification

Based on the Research/AtlasMind documents (Open-Core Business Model, Gap Analysis vs Confluence, Enterprise Delivery & Code Protection Strategy), here is the feature classification with the buyer-based framework:

### Decision Framework (from research)
1. **Buyer Test:** Individual contributor → CE. IT/Security team → EE.
2. **Adoption Test:** Would gating prevent the "aha moment"? → CE.
3. **Compliance Test:** Required for security questionnaire? → EE.

### Features That MUST Stay in CE (never gate)
| Feature | Why CE |
|---------|--------|
| All AI features (RAG Q&A, generation, improvement, summarization) | Headline differentiator, adoption driver |
| Ollama/local LLM support | Privacy differentiator for regulated industries |
| OpenAI-compatible API support | Flexibility |
| Full editor (TipTap v3 + all extensions) | Core productivity |
| Unlimited pages and versioning | No artificial limits |
| Confluence DC bi-directional sync | Core value proposition |
| Templates, comments, PDF export/import | Productivity drivers |
| Semantic + keyword hybrid search | Core search experience |
| Auto-tagging, quality scoring, duplicate detection | AI automation value |
| Email/password auth + basic RBAC (Admin/Editor/Viewer) | Basic security |
| Per-user Confluence PAT management | Core integration |
| Docker Compose deployment | Self-hosted path |
| Basic analytics (page views, search analytics) | Feedback loop |
| In-app notifications | User experience |
| Knowledge requests workflow | Collaboration |
| Local spaces (standalone, non-Confluence) | Flexibility |
| Knowledge graph visualization | Differentiator |
| Setup wizard + installer | Adoption friction removal |
| Draw.io diagram display (read-only) | Content compatibility |

### Features Correctly in EE (gated by enterprise license)

Two EE tiers: **Business** (Team + Business merged) and **Enterprise**.

| Feature | Tier | Why EE | Status |
|---------|------|--------|--------|
| **OIDC/SSO** | Business | #1 enterprise gate — IT blocks tools without SSO | **Implemented** |
| **Seat enforcement** | Business | License compliance | **Implemented** |
| OIDC group mappings | Business | Enterprise identity management | Planned (v1.1) |
| Advanced RBAC (custom roles) | Business | Governance gate | **Decided: EE-only.** CE keeps Admin/Editor/Viewer; custom roles gated. |
| Audit log export | Business | Compliance gate (SOC2, ISO 27001) | Planned (v1.1) |
| LLM audit trail | Business | AI governance — who queried what | Planned (v1.1) |
| Advanced analytics dashboards | Business | Manager/dept head reporting | Planned (v1.1) |
| AI usage analytics | Business | AI governance visibility | Planned (v1.1) |
| ~~Unlimited spaces~~ | ~~Business~~ | ~~Scale gate~~ | **Decided: No limit in CE.** Unlimited spaces permanently in CE — removed from EE. |
| Batch page operations | Business | Organizational scale | Planned (v1.2) |
| Webhook push | Business | Enterprise integration | Planned (v1.2) |
| SCIM provisioning | Enterprise | Automated offboarding | Planned (v1.1) |
| RAG permission enforcement | Enterprise | AI governance — AI respects user permissions | Planned (v1.1) |
| Org LLM policy | Enterprise | Prevent employees using personal API keys | Planned (v1.1) |
| AI output review workflow | Enterprise | Human-in-the-loop before AI publish | Planned (v1.2) |
| PII detection | Enterprise | Compliance gate | Planned (v1.2) |
| Data retention policies | Enterprise | Compliance gate | Planned (v1.1) |
| Compliance reports | Enterprise | SOC2/ISO 27001 evidence generation | Planned (v1.2) |
| ABAC permissions | Enterprise | Fine-grained attribute-based control | Planned (v1.2) |
| IP allowlisting | Enterprise | Security gate | Planned (v1.2) |
| LDAP group sync | Enterprise | Active Directory integration | Planned (v1.2) |
| Multi-instance management | Enterprise | Large org deployment | Planned (v1.2) |
| Bulk user operations | Enterprise | Organizational scale | Planned (v1.2) |
| Slack/Teams deep integration | Enterprise | Enterprise comms integration | Planned (v1.2) |

### Items Requiring Decision
| Feature | Current State | Research Says | Recommendation |
|---------|--------------|---------------|----------------|
| **Custom RBAC roles** | Implemented in CE (`routes/foundation/rbac.ts`) | EE (Advanced RBAC) | **Decided: Gate as EE Business tier.** CE provides Admin/Editor/Viewer only. Custom role creation requires enterprise license. |
| **Confluence space limit** | No limit enforced | CE: up to 5 spaces; EE: unlimited | **Decided: No limit ever in CE.** Unlimited spaces permanently in CE. |
| **Draw.io inline editing** | Read-only in CE | CE (full functionality per research) | **Keep read-only for now.** Inline editing is not built. When built, keep in CE per research recommendation. |
| **Email notifications (SMTP)** | Not implemented | CE (basic email) | **When implemented, keep in CE.** Basic email notifications are an individual-contributor feature. |

---

## Sprint Schedule

### Week 1: Apr 3–10 — Foundations

| Day | Task | Gap | Effort |
|-----|------|-----|--------|
| Thu 3 | **PREREQUISITE: Decide GitHub org name** | Prereq | Decision |
| Thu 3 | Run coverage reports (measure baseline ASAP) | Gap 9 | 3h |
| Fri 4 | License type alignment (remove BUSL-1.1 refs) | Gap 7 | 1h |
| Fri 4 | docker-compose.ee.yml creation | Gap 2 | 0.5h |
| Mon 7 | Verify OIDC registration in EE build | Gap 1 | 2h |
| Tue 8 | Stewardship commitment draft | Gap 4 | 2h |
| Wed 9 | E2E test: PDF export | Gap 8 | 3h |
| Thu 10 | E2E test: Confluence sync (conditional) | Gap 8 | 3h |

**Week 1 deliverables:** Gaps 1, 2, 7, 9 (measured) closed. Gap 4 drafted. Gap 8 done.

### Week 2: Apr 10–17 — CI & Testing

| Day | Task | Gap | Effort |
|-----|------|-----|--------|
| Fri 11 | GHCR mirror publishing | Gap 3 | 3h |
| Mon 14 | Installer `--dry-run` flag + CI workflow | Gap 5 | 5h |
| Tue 15 | Wizard state persistence investigation | Gap 10 | 2h |
| Wed 16 | Performance benchmark (seed + measure) | Gap 12 | 4h |
| Thu 17 | Coverage remediation if needed | Gap 9 | 4h (buffer) |

**Week 2 deliverables:** Gaps 3, 5, 10, 12 closed. Gap 9 remediated if needed.

### Week 3: Apr 17–26 — Launch

| Day | Task | Gap | Effort |
|-----|------|-----|--------|
| Fri 18 | Stewardship finalized after review | Gap 4 | 1h |
| Mon 21 | Update all repo URLs + badges | Gap 6 | 2h |
| Mon 21 | Promote CHANGELOG [Unreleased] → [0.1.0] | Gap 6 | 0.5h |
| Tue 22 | Add compatibility matrix + SaaS deferral note | Gap 6 | 1h |
| Tue 22 | Document enterprise schema deviation | Gap 11 | 0.25h |
| Wed 23 | Configure branch protection (main + dev) | Gap 6 | 1h |
| Thu 24 | Full manual integration test pass | All | 4h |
| Fri 25 | Tag v0.1.0 on main | Gap 6 | 0.5h |
| Sat 26 | **Flip repo to public** | Gap 6 | Launch |

---

## Critical Path

```
Org Name Decision (Day 1)
  ├──→ Gap 3 (GHCR)
  ├──→ Gap 5 (Installer CI)
  └──→ Gap 6 (URL updates, repo public)
         ↑
Gap 4 (Stewardship) ──→ Gap 6
Gap 7 (License) ──────→ Gap 6
Gap 9 (Coverage) ─────→ Confidence to launch

Gap 1 (OIDC) ────→ independent, EE repo
Gap 2 (Compose) ──→ independent, EE repo
```

**Bottleneck risks:**
1. **Org name undecided** → blocks 3 gaps. Must resolve Day 1.
2. **Coverage far below targets** → could add days of test writing. Mitigated by measuring Day 1.
3. **EE build script doesn't patch OIDC correctly** → blocks EE functionality. Verify Day 4.

---

## Total Effort Summary

| Gap | Description | Effort | Priority |
|-----|-------------|--------|----------|
| Prereq | GitHub org name decision | 0h (decision) | Blocker |
| 1 | OIDC verification in EE build | 2h | Tier 1 |
| 2 | docker-compose.ee.yml | 0.5h | Tier 2 |
| 3 | GHCR mirror publishing | 3h | Tier 2 |
| 4 | Stewardship commitment | 2h | Tier 1 |
| 5 | Cross-platform installer testing | 5h | Tier 3 |
| 6 | GitHub repo preparation | 4h | Tier 1 |
| 7 | EE license alignment | 1h | Tier 1 |
| 8 | Missing E2E tests | 5h | Tier 2 |
| 9 | Coverage reports | 3–8h | Tier 2 |
| 10 | Wizard state persistence | 2h | Tier 3 |
| 11 | Enterprise schema deviation doc | 0.25h | Tier 3 |
| 12 | Performance benchmark | 4h | Tier 3 |
| — | SaaS deferral note in README | 0.5h | Decision |
| **Total** | | **~32–42h** | |

**Buffer:** At 4h/day over 15 working days = 60h available. Plan uses 32–42h. Buffer of 18–28h for surprises.

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| GitHub org name not decided | Medium | High (blocks 3 gaps) | Escalate Day 1, set 24h decision deadline |
| Coverage far below 70%/60% | Medium | Medium (more test writing) | Measure Day 1; ship with documented current level if needed |
| EE OIDC build patch broken | Low | High (EE non-functional) | Verify early (Day 4) |
| Ollama not available for benchmark | Low | Low (skip benchmark) | Document as deferred if Ollama unavailable |
| AGPL + proprietary plugin legal question | Low | Medium (post-launch) | Note for legal review; not a launch blocker (GitLab uses same model) |

---

## Definition of Done (Revised — On-Premise Launch)

All five on-premise gates pass:

1. **Functional** — CE features work end-to-end, no critical bugs
2. **Security** — Audit pass ✅, no critical/high prod CVEs ✅, auth hardened ✅
3. **Operational (on-prem)** — New user: zero to running in < 15 min via installer; wizard completes without support
4. **Documentation** — Admin guide ✅, user guide ✅, API reference ✅, .env.example ✅, stewardship ✅
5. **Distribution** — Docker Hub images ✅, GHCR mirror, GitHub releases tagged, installer tested cross-platform, repo public

Gate 6 (SaaS operational) → deferred to post-launch phase.
