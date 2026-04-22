# Plan: Phase 1.2 / v0.4 — Polish & Ecosystem

**Target tag:** `v0.4.0`
**Window:** 2026-04-22 → 2026-07-01 (10 weeks)
**Source of truth for scope:** CE epic #295 + EE epic Compendiq/compendiq-ee#110
**Source of truth for trim history:** `Documentation-Research/Compendiq/Release Roadmap.md` §3.17–§3.20 (post-2026-04-22 founder-review trim)
**Branch convention:** `feature/<issue>-<short-desc>` from `dev`; PRs target `dev` only (per CLAUDE.md). Cross-repo features that need EE wiring open paired PRs in CE and EE that share an issue number.
**Library version pins:** §6 (verified against current Ref MCP docs 2026-04-22).

---

## 0. Executive summary

Phase 1.2 is **22 implementation issues + 2 epics** across two repos (CE + EE). Total bottoms-up estimate: **~80–100 engineering days** for one developer, or ~40–50 days with two developers running parallel CE / EE tracks. The 10-week calendar is tight but achievable if (a) the four CE prerequisites land first, (b) PII detection (#119) is conditionally deferred unless v0.4's enterprise ICP includes regulated buyers, and (c) Phase 3 / v0.6 SaaS items stay out of scope.

**Critical path** (must serialise — these gate everything else):

```
#306 (SSRF bootstrap)        ─┐
#305 (local_modified_at)     ─┼─→  All dependent EE issues
#304 (admin user CRUD)       ─┤
#307 (audit-log gaps)        ─┘
                              ↓
                      #113 Phase B-1   →  #301 (co-presence)
                      (cache-bus pub/sub)
```

Everything in the §3.20 community-growth track (#296, #297, #298, #299) is documentation-only and can run **in parallel** with engineering from day one.

**Two go/no-go decisions** still open:
- **PII detection (#119)** — ship only if v0.4 ICP includes regulated buyers; otherwise defer to v0.5 with Microsoft Presidio
- **Confluence sync history** (P0e of #307) — defer Report 7's sync-history attestation OR add a minimal capture table now

---

## 1. Dependency graph

```
                                  ┌─────────────────────────────────┐
                                  │  CE prerequisites (Sprint 1)    │
                                  │  All independent, can parallel  │
                                  └─────────────────────────────────┘
                                              │
        ┌────────────────────┬────────────────┼────────────────────┬────────────────────┐
        ↓                    ↓                ↓                    ↓                    ↓
    CE #304             CE #305          CE #306              CE #307           (CE community
    admin user CRUD     local_modified   SSRF bootstrap fix   audit-log gaps      growth — fully
        │                   _at              │                    │              independent;
        ↓                   ↓                ↓                    ↓              parallel from
    EE #116             EE #118          EE #113 Part B-1     EE #115            Sprint 1)
    bulk users          sync conflict    cache-bus migrate    compliance          - #296 stewardship
                        resolution           │                                    - #297 roadmap
                                             ↓                                    - #298 case studies
                                         CE #301                                  - #299 integration
                                         co-presence                                guides
                                             │
                                             ↓
                                         EE #113 Part A
                                         multi-instance pane

    Independent (no upstream blockers):
    - CE #300 paste-from-Confluence
    - CE #302 Draw.io
    - CE #303 PDF dashboard upgrade
    - EE #111 IP allowlisting
    - EE #112 per-space RAG ACLs (extends ADR-022 directly)
    - EE #114 webhook push
    - EE #117 batch pages (extends existing CE bulk routes)
    - EE #119 PII detection (conditional)
    - EE #120 AI output review (couples with #119; can ship first)
```

---

## 2. Sprint plan

Five sprints, two weeks each. The release ships at the end of Sprint 5 with a release-merge week absorbing slips.

### Sprint 1 (Week 1–2): CE prerequisites + start community-growth

**Theme:** Land the four CE-side prerequisites that gate downstream EE work. Start the documentation track in parallel.

| Issue | Blocks | Estimate | Owner notes |
|-------|--------|----------|-------------|
| **CE #306** SSRF bootstrap fix | EE #113 Part A; latent multi-pod bug | 0.5–1 d | **Highest priority** — security-relevant, smallest scope |
| **CE #305** `pages.local_modified_at` | EE #118 | 1–2 d | Latent bug — AI-improved content silently loses to sync today |
| **CE #304** Per-user admin CRUD | EE #116 | 2–3 d | Includes Settings → Users admin page |
| **CE #307** Audit-log coverage gaps | EE #115 | 2–3 d | 7 P0 sub-tasks (P0a–g); two open decisions for the founder |
| **CE #296** Public stewardship commitment | — | 0.5 d (founder review long-pole) | Documentation-only |
| **CE #297** Public roadmap (Projects board) | — | 0.5 d (founder click-through) | Documentation-only |
| **CE #298** Case-studies templates (Phase A) | Phase B may slip to v0.5 | 1 d | Templates only this sprint |

**Sprint exit criteria:**
- Migrations 058 (reserved for #112 in Sprint 2), 059 (reserved for #113 in Sprint 3), **060–062** landed for #305, #307a, #307b respectively (see §5 migration reservation).
- All four CE prereqs merged to `dev`; no breaking changes for CE-only deployments.
- Community-growth: `docs/STEWARDSHIP.md` published, Project board visible publicly, case-study templates committed.

**Parallelism:** With one developer, prereqs are mostly serial (~6 days). With two developers, run in parallel and finish in ~3 days.

### Sprint 2 (Week 3–4): RAG ACLs + IP allowlisting + paste-from-Confluence + integration guides

**Theme:** Independent EE / CE features with no inter-dependencies. Maximum parallelism.

| Issue | Estimate | Notes |
|-------|----------|-------|
| **EE #112** Per-space RAG ACLs | 5–7 d | Migration **058**; extends ADR-022; reconcile `ADVANCED_RBAC` vs new `PER_PAGE_ACL_ENFORCEMENT` flag (one-line decision) |
| **EE #111** IP allowlisting | 3–4 d | Reconcile with `app.ts:73`'s blanket `trustProxy: true` (must be tightened to a CIDR list when allowlisting is on) |
| **CE #300** Improved paste-from-Confluence | 5–7 d | JIRA + include + @mention + TOC macros (top 4 of 6) |
| **CE #299** Integration guides | 3 d | Three deployment guides; founder writes nginx + self-signed; air-gapped can defer to Sprint 3 |

**Sprint exit criteria:**
- EE #112 closed; ADR-023 (per-page ACL enforcement) added; `docs/architecture/09-rag-flow.md` updated.
- EE #111 closed; admin UI tab functional; lockout safeguards verified.
- CE #300 closed; 4 macros round-trip cleanly with new tests.
- CE #299 partial (nginx + self-signed shipped; air-gapped guide may slip to Sprint 3).

### Sprint 3 (Week 5–6): Webhooks + Draw.io + PDF dashboards + multi-instance Phase B

**Theme:** Heavier EE work plus the Draw.io gap-closure. Multi-instance prereqs land here so Sprint 4 can build the mgmt pane.

| Issue | Estimate | Notes |
|-------|----------|-------|
| **EE #114** Webhook push | 7–10 d | Migration **063/064/065** (subscriptions, outbox, deliveries); Standard Webhooks signing |
| **CE #302** Draw.io inline editing | 5–8 d | Add `jgraph/drawio` sidecar to compose; XML round-trip; local-page attachment storage |
| **CE #303** PDF dashboard upgrade + Excel removal | 3–4 d | Upgrade existing minimal PDF; remove `exceljs` dep; add EE-overlay registry |
| **EE #113 Part B-1** Cache-bus Redis pub/sub | 2 d | Unblocks CE #301 in Sprint 4 |
| **EE #113 Part B-2** SSRF allowlist runtime pub/sub | 1 d | Built on top of #306 from Sprint 1 |
| **EE #113 Part B-3** LLM queue admin-settings broadcast | 3 d | |

**Sprint exit criteria:**
- Webhook push end-to-end; signing verified by integration test against an SDK verifier.
- Draw.io: full XML round-trip with Confluence; Compendiq-edited diagram opens correctly in Confluence's native draw.io viewer (manual verification on real DC instance).
- Dashboard PDFs: cover + KPI + multi-page tables + integrity hash; Excel removed; bundle size measured.
- All Phase B Redis migrations complete; integration tests with two simulated pods green.

### Sprint 4 (Week 7–8): Multi-instance Part A + co-presence + AI safety + sync conflicts + bulk users

**Theme:** Build on Sprint 3's foundations. Heavy EE governance work.

| Issue | Estimate | Notes |
|-------|----------|-------|
| **EE #113 Part A** Multi-instance mgmt pane | 6–8 d | New tables in `compendiq-mgmt`; CE health-API route + token; instance poller; admin UI |
| **CE #301** Real-time co-presence | 3–5 d | Redis SSE pattern; depends on Sprint 3 Part B-1 cache-bus Redis migration |
| **EE #120** AI output review workflow | 5–7 d | Independent of #119; ships first per coupling note |
| **EE #119** PII detection (conditional) | 7–10 d | **Go/no-go decision required before Sprint 4 start** — ICP includes regulated buyers? |
| **EE #118** Sync conflict resolution | 4–5 d | Built on #305 from Sprint 1 |
| **EE #116** Bulk user operations | 3–4 d | Built on #304 from Sprint 1 |
| **EE #117** Batch page operations (net-new only) | 2–3 d | Extend existing CE bulk routes |

**Sprint exit criteria (depends on PII go/no-go):**
- If PII shipped: all 7 issues above merged to `dev`.
- If PII deferred: 6 of 7 issues merged; #119 closed with "deferred to v0.5 — Presidio path"; #120 still ships in flag-only / redact-only modes.

**This is the scope-heavy sprint.** If sprint 1–3 slip by even a few days, this becomes a 9–10-day sprint instead of 10.

### Sprint 5 (Week 9–10): Stabilise + ship

**Theme:** No new issues. Stabilisation, documentation polish, release engineering.

- Cross-issue integration testing (multi-pod + multi-instance + AI safety + sync conflicts together)
- Performance regression testing (added per-page ACL post-filter, presence SSE, webhook outbox poller)
- CHANGELOG curation
- Release notes (`docs/releases/v0.4.0.md` — mirror v0.3.0 structure)
- Bump `package.json` to `0.4.0` in **5 files**: root + backend + frontend + packages/contracts + mcp-docs
- Tag `v0.4.0` after `dev → main` merge per CLAUDE.md §Versioning
- Roadmap §3.17–§3.20 checkboxes flipped to ✅
- Both epics #295 / #110 marked DoD met
- Phase B (case studies) — at least 1 published case study lands or it rolls to v0.5 with `Phase A templates shipped` as the Roadmap delta

---

## 3. Cross-cutting concerns

### 3.1 Migration number reservation

Coordinate with `dev` HEAD before starting. Current head: `057_admin_settings_access_denied_retention.sql` (verified 2026-04-22). Reserved sequence:

| # | Owner issue | Description |
|---|-------------|-------------|
| `058` | EE #112 | `page_restrictions_sync` (extends `access_control_entries` with `source` + `synced_at`) |
| `059` | EE #113 Part A | `health_api_token` |
| `060` | CE #305 | `pages_local_modified` (`local_modified_at` + `local_modified_by` + index) |
| `061` | CE #307 P0a | `users_last_login` (`last_login_at` column) |
| `062` | EE #118 | `sync_conflict_resolution` (`conflict_pending` + `pending_sync_versions` table) |
| `063` | EE #114 | `webhook_subscriptions` |
| `064` | EE #114 | `webhook_outbox` |
| `065` | EE #114 | `webhook_deliveries` |
| `066` | EE #119 | `pii_detections` (only if PII ships) |
| `067` | EE #120 | `ai_output_reviews` |

**No two issues should claim the same number.** If a sprint slips and another lands first, the next-up issue takes the next free number and updates this table.

### 3.2 Branch + PR convention (CLAUDE.md §Git Workflow)

- All branches from `dev`: `feature/<issue>-<short-desc>` (e.g. `feature/305-local-modified-at`)
- PRs target **`dev`** never `main`
- Commits: concise, "why" not "what"; follow Conventional Commits as observed in recent merges (`fix(embedding):`, `feat(#282):`, `docs(#283):`)
- Pre-commit hooks: do **not** skip with `--no-verify` (CLAUDE.md mandate)
- Architecture diagrams (`docs/architecture/*.md`): updated in same PR per CLAUDE.md rule #6

### 3.3 Cross-repo (CE + EE) PR pairing

EE features that need a CE-side hook (per `setLlmAuditHook` pattern) require paired PRs:

- Open the CE PR first; get it green; merge to `dev`
- Open the EE PR; pin its CE dependency to the merged CE commit SHA in the EE PR body
- Merge EE only after CE is in
- Tag both repos at `v0.4.0` simultaneously per CLAUDE.md §Versioning

Issues that need this pairing: **#114** (webhook-emit-hook), **#119** (pii-scan-hook), **#120** (ai-review extension point), **#113** (health-api token wiring).

### 3.4 Testing baselines

- **Backend integration tests** require real PostgreSQL via `docker-compose.test.yml` (port 5433); never mock the database (CLAUDE.md §Testing).
- **Frontend tests**: jsdom + `@testing-library/react`; mock at HTTP boundary, not at component boundary.
- **E2E (Playwright)**: covers golden paths only; new Phase 1.2 features that touch the page-view UI (co-presence indicator, Draw.io editor, AI review banner) need a smoke spec each.
- **Multi-pod tests**: new pattern — required for #113 Phase B-1 / B-3 and #301. Use two parallel `app.build()` instances against the same Postgres + Redis; integration test asserts pub/sub propagation.

### 3.5 Coverage targets (carry-over from v0.3 baseline)

- Backend: ≥ 79% (current v0.3 baseline)
- Frontend: ≥ 67% (current v0.3 baseline)
- Critical paths (RBAC, RAG retrieval, sync, webhook delivery, PII detection): 100% line coverage required by CI gate

### 3.6 Performance regression watch

- `p99` retrieval latency (existing performance harness): **must not regress > 10%** vs v0.3 baseline (9.28 ms p99). Per-page ACL post-filter (#112) is the highest-risk addition.
- Co-presence SSE: tolerate up to **20 ms p99** added per page-view request (the auth + ACL check before SSE open).
- Webhook delivery latency: outbox poll interval = 5 s; document SLO as **median 5–10 s, p99 30 s** for end-to-end webhook delivery.
- PII detection p99: must keep chat path under **500 ms p99** (Transformers.js NER tier); async path under **2 s** (LLM-judge tier).

---

## 4. Issue-by-issue implementation notes

Each subsection assumes the issue body has been read. Notes here are deltas / corrections / cross-cutting context the issue body doesn't cover. Issues are grouped by sprint.

### 4.1 Sprint 1 — CE prerequisites

#### CE #306 — Wire `bootstrapSsrfAllowlist()` on app startup

- Place the call **after** `getPool()` is ready and **before** `app.listen()` (Fastify lifecycle: in the `app.ready()` hook or just before `listen`).
- `bootstrapSsrfAllowlist` is currently exported from `sync-service.ts:686` — verify; if not, export it.
- Pub/sub channel name: `confluence:allowlist:changed` (avoid colliding with the `provider:cache:bump` namespace from EE #113).
- **node-redis v5 API for the subscriber** (verified via Ref MCP):
  ```typescript
  const subscriber = client.duplicate();
  subscriber.on('error', err => logger.error({ err }, 'ssrf-allowlist subscriber error'));
  await subscriber.connect();
  await subscriber.subscribe('confluence:allowlist:changed', (message) => {
    const event = JSON.parse(message);
    applyAllowlistChange(event); // local set update only — no re-publish
  });
  ```
- The subscriber connection is **dedicated** — it cannot execute commands; only the main `client` does writes.
- Lifecycle: `await subscriber.unsubscribe(); await subscriber.quit();` on shutdown — wire into the existing graceful-shutdown handler.

#### CE #305 — `pages.local_modified_at` write-path coverage

- Trigger-based safety net (option B in issue body) is **strongly recommended** in addition to explicit code at write sites — otherwise a missed call site silently loses content.
  ```sql
  CREATE OR REPLACE FUNCTION set_pages_local_modified() RETURNS trigger AS $$
  BEGIN
    -- Only when body actually changed (not on metadata-only updates like view counts)
    IF NEW.body_html IS DISTINCT FROM OLD.body_html
       OR NEW.body_storage IS DISTINCT FROM OLD.body_storage THEN
      NEW.local_modified_at = NOW();
      -- local_modified_by is set by the application (trigger has no session context)
    END IF;
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;
  
  CREATE TRIGGER pages_local_modified_trigger
    BEFORE UPDATE ON pages
    FOR EACH ROW EXECUTE FUNCTION set_pages_local_modified();
  ```
- The application sets `local_modified_by` explicitly (the trigger cannot — no JWT context).
- **Sync-side:** when sync applies an upstream version, set both columns to NULL **in the same UPDATE** so the trigger doesn't re-fire incorrectly.
- **Publish-side:** same — clear both in the publish completion query.

#### CE #304 — Per-user admin CRUD

- Email lowercase normalisation: confirmed required per `migrations/051_users_email_display_name.sql` (case-sensitive index on `email`); normalise at the route layer before insert/update/lookup.
- **Self-deactivate guard:** check `req.user.id !== params.id` at route layer; return 400 with explicit message.
- **Last-admin guard:** before deactivate/delete, query `SELECT COUNT(*) FROM users WHERE role = 'admin' AND deactivated_at IS NULL` — block if would drop to 0.
- **Email-invitation flow** (optional create path): re-use existing `email-templates.ts` + `email-service.ts` patterns; new template for "your admin has created an account for you, click to set a password".
- Frontend `Settings → Users` page: must coexist with the existing `RbacPage.tsx` — they serve different purposes (RBAC = role-assignment; Users = lifecycle). Cross-link.

#### CE #307 — Audit-log coverage gaps (7 P0 sub-tasks)

- **P0a `users.last_login_at`**: migration **061**; update sites are `auth.ts` local-login success + EE-injected OIDC callback. The OIDC callback is in EE — define the contract in CE so EE can plug in.
- **P0b `auth_method` metadata**: no schema change; just emit `{ auth_method: 'local' | 'oidc' }` in the audit_log metadata jsonb at the same two sites as P0a.
- **P0c RBAC events**: audit `audit-service.ts` enum first; the issue lists 6 event types — emit any missing ones from `routes/foundation/rbac.ts`.
- **P0d retention pruning event**: one-line addition in `data-retention-service.ts` after each prune.
- **P0e** sync-history table: **founder decision required** — defer or add minimal table. Recommend defer unless compliance reports (#115) is also greenlit.
- **P0f `llm_audit_log` columns**: **founder decision required** — backfill via metadata jsonb (zero migration cost) vs add proper columns (faster query, cleaner). Recommend jsonb backfill for v0.4 — cleanup migration in v0.5.
- **P0g session/MFA**: emit `session_created` on login, `session_revoked` on logout/deactivation. MFA events stay no-op until MFA is implemented.

### 4.2 Sprint 2 — Independent EE + CE features

#### EE #112 — Per-space RAG ACLs

- **Flag reconciliation:** ADR-022 commits to `ADVANCED_RBAC` — but the issue body proposes a new `PER_PAGE_ACL_ENFORCEMENT` flag. Reviewer flagged this. Decision: **add `PER_PAGE_ACL_ENFORCEMENT`** as a separate flag; `ADVANCED_RBAC` covers the broader custom-roles surface, this flag is specific to the RAG-time per-page check. Update ADR-022 with a follow-up note (or supersede with ADR-023).
- **Migration 058** adds `source TEXT` + `synced_at TIMESTAMPTZ` to `access_control_entries`. Default `source='local'` for existing rows (safe — admin-UI created).
- **Sync rate-limit budget**: 60 RPM is shared with the rest of sync — the conditional fetch optimisation (only call `/restriction` when page metadata indicates restrictions exist) is **mandatory**, not nice-to-have.
- **RAG post-filter location**: per reviewer, this is **after RRF merging** (lines 139–179 of `rag-service.ts`), not in `vectorSearch`. The existing `userCanAccessPage()` call is a single function — drop it into the post-merge loop with an overfetch multiplier of 1.5×.

#### EE #111 — IP allowlisting

- **`trustProxy` reconciliation**: `app.ts:73` currently sets `trustProxy: true` (blanket trust). Tighten to the configured `trusted_proxies` CIDR list **only when** the IP-allowlist feature is enabled and the list is non-empty. Otherwise leave `true` for backward compat.
- **Lockout safeguards** are not optional — `/api/health` and `/api/admin/license` must be hardcoded exceptions in the hook (cannot be removed via UI).
- **Audit `AuditAction` union**: add `ip_allowlist_changed` event type to `audit-service.ts` so policy changes are visible in the audit trail.
- IPv6 dual-stack: use `ip-cidr` npm package or `node:net.BlockList` (built-in since Node 15) — no new dep needed if `BlockList` works for our patterns.

#### CE #300 — Improved paste-from-Confluence

- Test count discrepancy (issue body says 97, reviewer counted 88). Use the actual count when writing the new tests.
- Macro priority order is **JIRA → include → user-mention → TOC**; ship 4 minimum, 6 if time allows.
- For each macro: forward (XHTML→HTML), reverse (HTML→XHTML for Confluence push), and Markdown emit (HTML→MD for LLM input). Three rules per macro.

#### CE #299 — Integration guides

- Reverse-proxy guide variants: nginx is the must-have; Traefik nice-to-have; Caddy can slip
- Each guide must be **tested** on a fresh VM — no Markdown-from-ChatGPT
- Tagged `last-verified: YYYY-MM-DD` at the top of each guide so future readers see the rot date

### 4.3 Sprint 3 — Webhooks, Draw.io, dashboards, multi-instance Part B

#### EE #114 — Webhook push

- **Standard Webhooks** signing (verified spec text from §10 of the issue body):
  - Headers: `webhook-id` (UUID, stable across retries), `webhook-timestamp` (Unix seconds), `webhook-signature` (`v1,base64(HMAC-SHA256(secret, "${id}.${timestamp}.${rawBody}"))`)
  - Replay tolerance: 300s default
  - Multi-secret rotation: space-separated `v1,sig1 v1,sig2`
- **Migrations 063/064/065** for subscriptions / outbox / deliveries
- **CE/EE boundary**: `setWebhookEmitHook` in `core/services/webhook-emit-hook.ts` — pure CE no-op stub; EE registers the implementation. Mirror `llm-audit-hook.ts` exactly (verified existing pattern).
- **`undici` HTTP client** (already in stack):
  - `signal: AbortSignal.timeout(10_000)` — hard 10s
  - `redirect: 'error'` — never follow (would bypass SSRF check)
  - `assertNonSsrfUrl(url)` from `ssrf-guard.ts:241` on every POST (not just at subscription create)
- **OIDC 402-pattern correction** (per reviewer): the "register-but-return-402" pattern doesn't actually exist in CE today — OIDC routes are conditionally registered at `app.ts:243-252` (currently commented out). Decision for #114: **always-register webhook routes in CE; return 402 if EE feature flag is off.** This makes the API surface discoverable and matches Stripe's behaviour.

#### CE #302 — Draw.io inline editing

- **Image name** (verified via Ref MCP):
  - Docker image: `jgraph/drawio` on Docker Hub
  - Compose templates + variants live in the **separate** `jgraph/docker-drawio` repo (PlantUML, export server, Nextcloud-integrated, etc.)
  - For our use: pin a specific full-version tag like `jgraph/drawio:26.0.4` (no `latest` — embed protocol breaks across minor versions per gemini research)
  - Apache 2.0
- **Compose layout**: add as a sidecar in `docker/docker-compose.yml`; reverse-proxy `/drawio/` through the existing frontend nginx so postMessage `effectiveOrigin` matches the frontend origin (avoids same-origin / CORS errors)
- **Founder decisions** (the 4 in the issue body) need to be made before implementation start, not during

#### CE #303 — PDF dashboard upgrade + Excel removal

- Use **`pdf-lib`** (already in stack — confirmed in `frontend/package.json`)
- Multi-page support: `doc.addPage([595, 842])` (A4) called per data page; `font.widthOfTextAtSize()` for column-width calculation; manual header redraw on each page
- **EE-overlay registry pattern** must mirror `setLlmAuditHook` so EE can register its enterprise dashboards without touching CE files
- **Excel removal**: `exceljs` is currently the only consumer of `exportToExcel()` — remove from `frontend/package.json` after the rip-out; measure bundle size delta in CHANGELOG (~200–250 kB gzipped expected)

#### EE #113 Part B-1: Cache-bus Redis pub/sub

- **node-redis v5 dedicated subscriber pattern** (verified via Ref MCP):
  ```typescript
  // backend/src/domains/llm/services/cache-bus.ts (rewritten)
  let subscriber: ReturnType<typeof getRedisClient>['duplicate'] | null = null;
  
  export async function initCacheBus(): Promise<void> {
    const main = getRedisClient();
    subscriber = main.duplicate();
    subscriber.on('error', err => logger.error({ err }, 'cache-bus subscriber'));
    await subscriber.connect();
    await subscriber.subscribe('provider:cache:bump', (msg) => {
      const { providerId, version } = JSON.parse(msg);
      // Apply version bump locally — no re-publish
      bumpProviderCacheVersionLocal(providerId, version);
    });
    await subscriber.subscribe('provider:deleted', (msg) => {
      const { providerId } = JSON.parse(msg);
      emitProviderDeletedLocal(providerId);
    });
  }
  
  // Renamed: bumpProviderCacheVersion now publishes; the local-only helper is private
  export async function bumpProviderCacheVersion(providerId: string): Promise<void> {
    const version = ...; // existing logic
    bumpProviderCacheVersionLocal(providerId, version);
    await getRedisClient().publish('provider:cache:bump', JSON.stringify({ providerId, version }));
  }
  ```
- The subscriber is **single per pod** — handles all bus channels; do not create one per channel
- Falls back gracefully when Redis is unavailable (single-pod deployments still work)

### 4.4 Sprint 4 — Multi-instance Part A, co-presence, AI safety, sync, bulk

#### EE #113 Part A: Multi-instance pane in `compendiq-mgmt`

- New tables in `compendiq-mgmt` Postgres (separate from CE Postgres): `instances`, `instance_metrics`
- New CE migration **059**: `health_api_token` row in `admin_settings`, generated on first boot if absent
- New CE route `GET /api/internal/health?token=...` — token-gated, returns instance metadata
- Mgmt poller: 5-min interval, 10s timeout per call, 3 consecutive failures → `health_status='offline'`
- **Auth model is read-only token** — opaque to the customer-facing UI; mgmt-side can rotate

#### CE #301 — Real-time co-presence

- Built on Sprint 3 Part B-1 cache-bus migration (same node-redis v5 subscriber pattern)
- SSE pattern: `text/event-stream`, `X-Accel-Buffering: no` header (verified existing CE pattern in `routes/llm/_helpers.ts`, not `llm-chat.ts` per reviewer correction)
- Heartbeat 10s, ZRANGEBYSCORE cutoff 20s, key TTL 30s (defence in depth)
- RBAC check **before** writing the `200 text/event-stream` header (cannot 403 after headers sent)

#### EE #120 — AI output review workflow

- Ships **before or with** #119 — #119's `block-publication` mode requires this queue. Decoupled cleanly via nullable `pii_findings_id` FK.
- Migration **067**: `ai_output_reviews` table
- Publish-to-Confluence chokepoint at `pages-crud.ts:1243` (per reviewer) — must check for pending review and 409 if found
- New notification type `ai_review_pending` — `notification-service.ts` accepts arbitrary type strings (per reviewer)

#### EE #119 — PII detection (CONDITIONAL)

- **Go/no-go gate before Sprint 4 start**
- If GO:
  - Migration **066**: `pii_detections` table
  - `setPiiScanHook` extension point in CE (mirror `setLlmAuditHook` pattern)
  - EE side: bundle `@huggingface/transformers` v3 + the q8-quantized `Davlan/distilbert-base-multilingual-cased-ner-hrl` model (~67–135 MB, per Ref MCP)
  - Async LLM-judge runs on a separate **lower-priority** BullMQ queue
  - **Call sites** (per reviewer): `llm-ask.ts:279/304`, `llm-improve.ts:144/157`, `llm-generate.ts:135/148` — verify line numbers haven't drifted at start. Add `llm-summarize.ts` and `pages-tags.ts` to the coverage list (gemini missed these). **Drop `llm-usecases.ts:91`** — that's an admin event, not an inference call site.
  - German regex patterns sourced from BFDI specifications (do not trust gemini-suggested npm package names)
- If NO-GO: defer entirely; reopen as v0.5 issue with Microsoft Presidio path; close #119 with rationale comment

#### EE #118 — Sync conflict resolution

- Built on CE #305 (`pages.local_modified_at`)
- Migration **062**: adds `conflict_pending`, `conflict_detected_at` to `pages` + new `pending_sync_versions` table
- Add `SYNC_CONFLICT_RESOLUTION` flag to `enterprise/features.ts` (currently absent per reviewer)
- Sync-service insertion point: lines 248–330 (verified clean spot per reviewer)
- Diff UI: use `jsdiff` (`kpdecker/jsdiff` per Ref MCP) — ~30 KB, mature, MIT

#### EE #116 — Bulk user operations

- Built on CE #304 (per-user admin CRUD)
- **`papaparse` v5** (verified via Ref MCP):
  - No dependencies; RFC 4180 compliant
  - Node streaming via `Papa.parse(Papa.NODE_STREAM_INPUT, options)` — pipe a `Readable` and listen on `data` / `end` events
  - In stream mode `step` and `complete` callbacks are unavailable
  - Fast mode for performance; auto-detect delimiter
- Email lowercase before lookup (matches CE #304 pattern)
- Single transaction for the apply step; preview is read-only

#### EE #117 — Batch page operations (net-new only)

- **Out of scope** (already shipped in CE — verified at `pages-crud.ts:1360-1664`): bulk/delete, bulk/sync, bulk/embed, bulk/tag, BulkOperations.tsx
- **In scope** (net-new): `bulk/replace-tags` (CE), `bulk/permission` (EE-gated), filter-based selection with `expectedCount` race guard, SSE progress UI for large operations
- **EE flag gates the bulk-permission route only** — existing CE bulk routes must not break

---

## 5. Library version pins (consolidated)

| Library | Version | Verified | Used by | Notes |
|---------|---------|----------|---------|-------|
| `redis` (node-redis) | ^5.x (in stack) | Ref MCP — `redis/node-redis` | #306, #301, #113 | Pub/sub via `client.duplicate()` + dedicated subscriber connection. Subscriber **cannot** execute commands — write only via main client. |
| `pdf-lib` | latest (in stack — `frontend/package.json`) | (existing) | #303, #115 | Multi-page via `doc.addPage([595, 842])`; `font.widthOfTextAtSize()` for column widths. |
| `jgraph/drawio` (Docker image) | **`26.0.4`** (pin full version) | Ref MCP — `jgraph/drawio` repo | #302 | Apache 2.0. Compose template variants live in separate `jgraph/docker-drawio` repo. Do **not** pin `latest`. |
| `@huggingface/transformers` | v3 | Ref MCP — `huggingface/transformers.js` v3 | #119 | ONNX Runtime via `onnxruntime-node`; `dtype: 'q8'` for size-quantized models. WebGPU support exists but Compendiq is CPU-only. |
| `papaparse` | ^5.x | Ref MCP — `mholt/papaparse` | #304 (export), #116 | Node streaming via `Papa.parse(Papa.NODE_STREAM_INPUT, options)`. Zero dependencies. RFC 4180 compliant. |
| `jsdiff` | latest | Ref MCP — `kpdecker/jsdiff` | #118 | Side-by-side diff in manual-review pane. ~30 KB. MIT. |
| `archiver` | latest | (Ref MCP no result; verify before use) | #115 | ZIP packaging for compliance reports. Alternative: `node:zlib` + manual zip for the small file counts. |
| `undici` | (in stack) | (existing) | #114 | Webhook delivery. Use `undici.fetch` with `AbortSignal.timeout` + `redirect: 'error'`. |
| `ip-cidr` or `node:net.BlockList` | built-in (Node 15+) for BlockList | (existing) | #111 | IPv4 + IPv6 CIDR matching. Prefer built-in `BlockList`. |
| `recharts-to-png` | (optional) | (not yet evaluated) | #303 | Chart-image rendering — defer to v0.5 if it doesn't work cleanly with Tailwind 4. |
| Standard Webhooks spec | v1.0.0 | https://www.standardwebhooks.com/ (specification only — not an npm package) | #114 | Implement signing in-house with `node:crypto` (~20 lines). Do **not** import the `@standard-webhooks/standardwebhooks` package — it's verifier-side, we're sender-side. |

---

## 6. Risk register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Sprint 1 prereqs slip → cascading EE delays | Medium | High | Strict 2-week boundary on Sprint 1; if a prereq isn't done by end of week 2, defer the gating EE issue to v0.5 |
| Per-page ACL post-filter degrades RAG p99 > 10% | Medium | Medium | Performance harness regression test in CI; if tripped, fall back to feature flag default-off; issue #112 ships disabled |
| PII detection latency exceeds 500 ms chat budget | Medium | Medium | Test on representative German content early; if budget exceeded, ship in async-only mode (chat skips PII; summary/improve include it) |
| Multi-pod cache-bus migration introduces subtle race | Medium | High | Two-pod integration test required for sign-off; revert path: fall back to in-process emit if subscriber unavailable |
| `jgraph/drawio` minor version breaks postMessage protocol | Low | High | Pin full-version tag (`26.0.4`); ops runbook for upgrades; air-gapped customers test in staging first |
| Webhook outbox table growth unbounded | Low | Medium | Daily cleanup BullMQ job (delete `done`/`dead` rows older than 30d) — landed with #114 |
| AI output review queue creates UX friction | Medium | Medium | Auto-expire pending reviews after 30d (configurable); aggregate notifications instead of one-per-item |
| `local_modified_at` write-site missed | Medium | High | DB trigger as belt-and-braces (recommended approach in §4.1 #305 notes); integration test asserts every LLM write path sets the column |
| Two open founder decisions (sync history table; llm_audit_log columns) block #115 | Low | Medium | Resolve before Sprint 1 end (decision-by-default: defer sync history; backfill via metadata jsonb) |
| EE #119 go/no-go decision delayed | Medium | Medium | Sprint 4 start triggers the decision deadline; if no decision by then, default to NO-GO and reschedule for v0.5 |
| Confluence DC `/rest/experimental/restriction` API removed | Low | Medium | Graceful 4xx fallback to space-level enforcement; cached ACEs continue to work; log warning |
| `bootstrapSsrfAllowlist` was never called → first sync hits a 403 | Already true today | Low | Fix in Sprint 1 (#306) — small scope, high security value |
| Founder time on case studies + integration guides exceeds budget | High | Low | Phase A/B split on #298 already absorbs this; integration guides air-gapped variant can slip |

---

## 7. Definition of Done

### Per-issue
- [ ] Code merged to `dev` via PR with passing CI (typecheck, lint, tests, semgrep)
- [ ] Tests added per issue acceptance criteria
- [ ] Architecture diagrams updated where applicable (CLAUDE.md rule #6)
- [ ] CHANGELOG entry under `[Unreleased]`
- [ ] Cross-references to related issues / ADRs

### Per-sprint
- [ ] All in-sprint issues either merged or explicitly deferred with documented rationale
- [ ] Performance harness shows no > 10% p99 regression
- [ ] Coverage gates (backend ≥ 79%, frontend ≥ 67%) maintained

### Phase 1.2 / v0.4.0 release
- [ ] Both epics #295 / Compendiq/compendiq-ee#110 closed
- [ ] All CE prerequisite issues (#304-#307) closed
- [ ] CHANGELOG `[0.4.0]` curated
- [ ] `docs/releases/v0.4.0.md` written (mirror v0.3.0 structure)
- [ ] `package.json` bumped to `0.4.0` in 5 files: root + backend + frontend + packages/contracts + mcp-docs
- [ ] `dev → main` merge tagged `v0.4.0` in CE
- [ ] EE tagged `v0.4.0` in lockstep
- [ ] GHCR images at `:0.4.0`: `ce-backend`, `ce-frontend`, `ce-searxng`, `ce-mcp-docs`, `ee-backend`
- [ ] Roadmap §3.17–§3.20 checkboxes flipped to ✅ in `Documentation-Research/Compendiq/Release Roadmap.md`
- [ ] Public stewardship pledge (`docs/STEWARDSHIP.md`) live
- [ ] Public roadmap board live at `https://github.com/orgs/Compendiq/projects/<N>`
- [ ] At least 1 case study published (or rolled to v0.5 with templates shipped)
- [ ] No regressions in v0.3.0 critical paths (sync, RAG, OIDC, SCIM, RBAC)

---

## 8. Notes for the implementer

- **Read each issue body before starting** — the issues capture the per-issue research depth (gemini briefs, codebase verification, schema sketches). This plan is sprint-organisation + cross-cutting context, not a replacement for the issue bodies.
- **Use `superpowers:writing-plans` per-issue** if a single issue's implementation needs a detailed step-by-step (e.g. EE #114 webhook outbox pattern is non-trivial).
- **Spawn `code-implementer` agents** for individual sub-tasks once per-issue plans are written.
- **Open a tracking PR comment on the parent epic** when each sub-issue PR opens, so the epic checklist visualises progress.
- **Migration numbers in §3.1** are reservations — first PR to merge takes the reserved number; later PRs in conflict bump to next free.
- **Two open founder decisions** (resolve before Sprint 1 end):
  1. CE #307 P0e: defer sync-history attestation OR add minimal `confluence_sync_history` table?
  2. CE #307 P0f: backfill `llm_audit_log` columns via metadata jsonb OR add proper columns?
- **One go/no-go decision** (resolve before Sprint 4 start):
  - EE #119 PII detection: ship in v0.4 (regulated-buyer ICP) OR defer to v0.5 with Presidio?

---

*Plan version 1, 2026-04-22. Author: Claude Code with Ref MCP for library version verification. Updates as the sprints land — track in git history.*
