# Article AI policy activation — design (#1881)

Status: **Draft for independent AI review** (see *Approval record*).
Issue: Compendiq/compendiq-ce#1881. Spec: Compendiq/compendiq-ee#285
(SPEC-CORE-002/003 live in #280, SPEC-UI-001 in #283). The issue's
*Acceptance* section is the source of truth; this document maps to it and
does not restate it.

## 1. Findings that shape the decision

1. **The issue's premise is partly stale.** EE `origin/dev` (merged #308)
   already implements `aiPolicyEnforcementAvailable` in
   `overlay/backend/src/enterprise/plugin.ts:846` as *option 2*: true only
   when `COMPENDIQ_AI_POLICY_ENFORCEMENT === 'enabled'` **and** the live licence
   grants `org_llm_policy`. CE documents it in
   `docs/architecture/article-ai-policy-activation.md`. The browser
   observation in the issue was made without that flag (the local EE checkout
   is 11 commits behind `origin/dev`). CE alone can never activate
   (`noop.ts:39`).
2. **Option 2 as merged contradicts #285.** #285 *Deployment and
   compatibility*: "CE owns universal policy enforcement … EE owns licensed
   creation defaults, cascade and evidence/report extensions"; #280 (CE) owns
   "one activation capability". The env flag also has no observable
   preconditions, no actor/time record, is per-process (replicas can
   disagree), is reversible, and licence loss closes it — which hides the
   policy selector from editors of already-restricted articles.
3. **Enforcement coverage on current dev** (scout audit + spot checks;
   evidence in the tracker §F). Every `isAiPolicyEnforcementAvailable()`
   call site gates only *new tightening* or *deferred-observation
   consumption* (`ai-policy-service.ts:481,555,609,801`,
   `ai-policy-ingestion.ts:67`, `ai-policy-deferred-ingestion.ts:118,131`,
   `ordinary-page-write-reconciler.ts:246`, `pages-crud.ts:137,490,2014,2617`);
   no admission/dispatch path consults it, so stored restrictions are always
   enforced. The "Rollout and coverage limits" list in
   `article-ai-governance-foundation.md` is stale:
   | Path | State on dev | Evidence |
   |---|---|---|
   | Embedding worker (dispatch + publication) | migrated | `embedding-service.ts:771` preliminary admission; transport `openai-compatible-client.ts:37-47` `authorizeArticleDispatch`; publication `:881` `admitArticleStage` + `validateEmbeddingPublicationOnClient` |
   | Shadow embedding | migrated | `embedding-service.ts:923` separate admission, `embedding-article-stage.ts:72` candidate assignment check |
   | Image analysis (dispatch, block, success/failure publication) | migrated | `image-analysis-worker.ts:98` (all publication through `admitArticleStage`), `:661-675`, transport `image-analysis-client.ts:366` |
   | Summary / quality / auto-tag | migrated | `admitArticleStage` + `publishCurrentAiPolicyBlock` (migrations 144–149) |
   | Notion (fresh + existing) | migrated | `resolveCreationAiPolicy` / deferred ingestion `ai-policy-deferred-ingestion.ts` |
   | Confluence sync (fresh + existing) | migrated | `ordinary-page-write-reconciler.ts:246,961`, fresh-publication fence |
   | Existing-row SQL writers of `ai_policy` | only `applyAiPolicyOnClient` (`ai-policy-service.ts:413`) moves the column | grep of non-test `backend/src` |
   | **Global admin label rename/delete** | **GAP G1** | `routes/foundation/admin.ts:123-153` rewrites `labels` with `array_replace/array_remove` and never consults the policy primitive: renaming `foo → no-ai` stores a reserved label on rows whose `ai_policy` stays `all` (an accepted restriction that is not enforced); deleting `no-ai` strips the canonical slot |
   | Browser (WebGPU) inference | handshake exists for current bundles | `client-inference-manager.ts:171` `POST /llm/inline-completion/browser-authorization`; **pre-handshake bundles in still-open tabs are GAP G2** (server cannot stop client-side inference it never hears about) |

## 2. Decision

**Option 1, CE-owned.** One durable, cluster-wide enforcement switch turned
on by an active system administrator through
`PUT /api/admin/ai-policy/activation`, refused with named reasons while its
observable preconditions are unmet, and recorded with actor and time. The
one-way door the spec asks for is on *binaries* (§2.2). The EE env/licence
hook is removed (EE PR). Option 3 is rejected (#285: "Installing schema
alone is not activation").

### 2.1 Data model (CE migration 151)

- `ai_policy_activation_state` singleton (`singleton BOOLEAN PK CHECK
  (singleton)`, `enabled BOOLEAN NOT NULL`, `changed_at`,
  `changed_by_user_id → users ON DELETE SET NULL`, `changed_by_name`
  snapshot, `legacy_clients_acknowledged BOOLEAN NOT NULL DEFAULT false`,
  `observing_since TIMESTAMPTZ NOT NULL DEFAULT NOW()`). Seeded
  `enabled = false` with NULL actor/time; `observing_since` is the moment
  this schema (and so the legacy-client observer) was installed. Every
  transition is also an audit event, so the history survives later changes.
  `legacy_clients_acknowledged` is set by the enabling transition only and
  reset by every disable: an acknowledgement never carries into a later
  enable.
- `ai_policy_legacy_client_observations` (`user_id PK → users ON DELETE
  CASCADE`, `last_seen_at`, `token_expires_at`, `observations INTEGER`):
  attributed observations of legacy browser sessions (§2.3).
  `token_expires_at = NOW() + access-token lifetime` at issuance, so a later
  `ACCESS_TOKEN_EXPIRY` change cannot mis-measure the window.
- `page_writer_runtimes.ai_policy_enforcement_version INTEGER NOT NULL
  DEFAULT 0 CHECK (>= 0)`. This build registers `1`
  (`AI_POLICY_ENFORCEMENT_VERSION`, beside `PAGE_WRITER_ENFORCEMENT_VERSION`
  in `registerRuntimeOnClient`). Older binaries omit the column → `0`.
- **Binary door, two guards that serialize in both orders:**
  - Registration trigger `guard_ai_policy_runtime_registration` (BEFORE
    INSERT OR UPDATE OF `ai_policy_enforcement_version` on
    `page_writer_runtimes`): version `1` returns immediately (no lock, so
    the per-admission re-registration of current processes stays free);
    otherwise it takes **`FOR UPDATE`** on the activation row and raises
    `55000` if `enabled` or any page (soft-deleted included, fail closed)
    has `ai_policy <> 'all'`. A missing state row also raises (migration-124
    pattern).
  - Tightening trigger `guard_ai_policy_tightening` (AFTER INSERT OR UPDATE
    OF `ai_policy` on `pages`, so it sees the value the existing BEFORE
    INSERT label trigger produced): when the new value is restrictive and
    stricter than OLD (any restrictive INSERT counts), it takes `FOR SHARE`
    on the activation row and raises `55000` with constraint name
    `ai_policy_incompatible_runtime_active` if any active runtime has
    `ai_policy_enforcement_version <> 1`. This covers every writer — the
    policy primitive, creation INSERTs, recovery replay, deferred ingestion
    and a stale-enabled cache — without trusting application code.
  - Registration first: the tightening's `FOR SHARE` waits, then its next
    statement sees the committed v0 runtime → refuses. Tightening first:
    registration's `FOR UPDATE` waits, then sees the committed restriction →
    refuses. Tightenings take only `FOR SHARE`, so they never contend with
    each other; enabling (`FOR UPDATE`) waits for in-flight tightenings.
  - The error maps to 409 `ai_policy_enforcement_unavailable` on HTTP paths
    (recognized by its constraint name); workers and recovery treat it like
    any refused tightening and stay pending.
  - Partial indexes `pages (id) WHERE ai_policy <> 'all'` and
    `page_writer_runtimes (runtime_id) WHERE fenced_at IS NULL AND
    quiesced_at IS NULL AND ai_policy_enforcement_version <> 1` keep both
    checks index probes.
- `test-db-helper.truncateAllTables` reseeds the singleton.

Why not an `admin_settings` key: no FK, no CHECK, no row to serialize
runtime registration against. The baseline precedent uses a dedicated
singleton for the same reasons.

### 2.2 Authority and reversibility

- Who: an **active system administrator**: `requireAdmin`, then a new
  `SELECT … FROM users … FOR SHARE` (active, `role = 'admin'`) on the
  activation transaction, so a concurrent demotion/deactivation serializes
  with it. No licence requirement: CE and EE behave identically. Space
  admins, editors and page owners cannot activate.
- Routes (`routes/foundation/ai-policy-activation.ts`, core-only imports,
  admin rate limit): `GET /api/admin/ai-policy/activation` and
  `PUT /api/admin/ai-policy/activation` with
  `{ enabled: boolean, acknowledgeLegacyClients?: boolean }` (mirrors
  `PUT /admin/page-baselines/activation`).
- Durable record: `changed_at`, `changed_by_user_id`, `changed_by_name` on
  the state row and an audit event per transition
  (`AI_POLICY_ENFORCEMENT_ACTIVATED` / `…_DEACTIVATED`, details: blockers
  seen, `legacyClientsAcknowledged` with the observed users/count/window).
- **Reversible switch, one-way binary door.** The spec's "one-way door after
  rollout" is about binaries: once restrictions exist, a policy-unaware
  build must not run. That is enforced by the registration trigger keyed on
  `enabled OR restrictions exist`, independent of the switch. The switch
  itself only opens or closes *new tightening* (admission never reads it),
  so turning it off weakens nothing stored; it is the emergency lever for
  the active-state legacy-client refusal (§2.3) and matches the baseline
  precedent. Turning it off needs no preconditions. "Pause AI" stays
  available through existing controls.

### 2.3 Observable preconditions → named refusal reasons

`GET` returns `{ enabled, changedAt, changedBy, changedByName, ready,
blockers[] }`; enabling re-evaluates under the row lock and answers 409
`{ error: 'ai_policy_activation_refused', blockers }`.

| Blocker `code` | Observed how | Details | Overridable |
|---|---|---|---|
| `incompatible_ai_policy_runtime` | `page_writer_runtimes` rows with `fenced_at IS NULL AND quiesced_at IS NULL AND ai_policy_enforcement_version <> 1` (one process per replica registers at startup, `app.ts:136`; workers run in that process) | `total` + ≤50 `{runtimeId, host, pid, startedAt}` | no |
| `legacy_clients_active` | rows in `ai_policy_legacy_client_observations` with `token_expires_at + 30 s throttle slack > NOW()` | `users` (distinct count), ≤20 `{userId, username, lastSeenAt}`, `clearsAt` (= max expiry + slack) | yes, with `acknowledgeLegacyClients: true` (audited) |
| `legacy_client_window_open` | the observer is blind to tokens issued before it existed or by old replicas: `NOW() < GREATEST(observing_since, MAX(quiesced_at) of version-0 runtimes) + access-token lifetime + 30 s` (`quiesced_at` = owner-acknowledged drain of a live old process; fencing long-dead rows does not restart the clock) | `since`, `clearsAt` | yes, same acknowledgement |
| `ai_policy_enforcement_not_registered` | this process has not installed the readiness provider (installed at startup beside the baseline provider, before routes) | — | no |
| `ai_policy_readiness_unavailable` | readiness read threw | — | no |

Not observable, documented as operator duties (same limit as the baseline
precedent): processes that never registered a runtime row (pre-#275
builds), whether a version-0 row's process is really gone (fencing remains
the operator's server-verified `durable_no_started_effects` / owner-ack
procedure — every historical pre-#1881 row needs it once; the runbook gets a
bulk procedure), and browsers that send no `Sec-Fetch-Mode` (Safari < 16.4).

**Legacy-client marker (closes G2 as far as the server can).** One frontend
helper (`withClientProtocol(headers)`) adds `X-Compendiq-Client-Protocol: 1`;
every SPA request to a covered route uses it: `apiFetch`, the raw refresh
and logout fetches in `shared/lib/api.ts`, the OIDC exchange in
`OidcCallbackPage.tsx` and setup-admin in `AdminStep.tsx`. A frontend test
enumerates every `fetch(` to `/api/auth/*` and `/api/setup/admin` and
asserts the marker. The new bundle maps a `client_reload_required` body to a
distinct "Reload this page to continue" message (never a generic login
failure) so a header-stripping proxy is diagnosable.

Backend: an explicit allow-list of session-issuing POSTs — `/api/auth/refresh`,
`/login`, `/register`, `/oidc/exchange` (EE) and `/api/setup/admin`. The GET
`/api/auth/oidc/callback` navigation sets the cookie but cannot carry a
header and is deliberately not covered; the SPA's following exchange is.
A request is *legacy* when it carries `Sec-Fetch-Mode` (browser-set) and no
marker ≥ 1:
- **disabled**: the response is unchanged. Only a **successful** (2xx)
  session issuance by a legacy client records an observation: the `onSend`
  hook safe-parses the serialized response body for the `user.id` that all
  five routes return (`{ accessToken, user }`), and a detached upsert (errors
  caught and logged; it can neither fail nor delay the response) sets
  `last_seen_at`, `token_expires_at` and increments `observations`
  (per-user, per-process throttle 30 s). Forged unauthenticated requests
  record nothing; an authenticated griefer is attributed by name. A failed
  or unparseable record is a missed observation, which the
  acknowledgement model already covers.
- **enabled**: refuse in `onRequest`, before any credential check or token
  rotation, with 409 `{ error: 'client_reload_required' }`; the switch is
  read from the DB on this rare path (503 `ai_policy_unavailable` if that
  read fails — fail closed). The legacy tab cannot obtain another access
  token; reloading loads the policy-aware bundle (`index.html` is never
  cached, `frontend/nginx.conf:185-188`). Non-explicit session loss keeps
  per-user drafts. Non-browser clients (no `Sec-Fetch-*`; Playwright's
  Node-side `request`) are unaffected. Refusing in `onRequest` leaves EE's
  single-use OIDC login code unconsumed, so reloading the callback URL
  after the 409 still signs in.
- Hooks are registered globally before CE routes and before the EE plugin's
  `registerRoutes` (the `ipAllowlistHook` precedent), so EE's exchange route
  is covered without EE code. CORS: `@fastify/cors` has no `allowedHeaders`
  (`app.ts:150-163`), so requested headers are reflected; leave it unset.
Residual risk (documented): a legacy tab keeps content it already loaded,
and its current access token, for at most the access-token lifetime; a
legacy tab may adopt a sibling new tab's token through shared storage. The
acknowledgement override accepts exactly that bounded window, and is
recorded with the observed users in the audit event.

### 2.4 Activation flow and failure handling

```mermaid
sequenceDiagram
  participant Admin
  participant API as PUT /admin/ai-policy/activation
  participant PG as PostgreSQL
  participant Bus as cache bus
  Admin->>API: { enabled: true, acknowledgeLegacyClients? }
  API->>PG: BEGIN; users row FOR SHARE (active admin)
  API->>PG: ai_policy_activation_state FOR UPDATE
  alt already in requested state
    API->>PG: COMMIT (no audit, no rewrite)
    API-->>Admin: 200 existing record
  else enabling
    API->>PG: readiness on same client (runtimes, legacy observations)
    alt non-overridable blocker, or unacknowledged legacy clients
      API->>PG: ROLLBACK
      API-->>Admin: 409 ai_policy_activation_refused + blockers
    else ready
      API->>PG: UPDATE state (enabled, NOW(), actor, name) + audit
      API->>PG: COMMIT
      API->>Bus: publish ai_policy:activation:changed (reload signal)
      API-->>Admin: 200 enabled, actor, time
    end
  else disabling
    API->>PG: UPDATE state + audit, COMMIT, publish
    API-->>Admin: 200 disabled, actor, time
  end
```

- **Atomicity:** state + audit in one transaction. A failed bus publish
  after commit is logged; the response still reports the committed state.
- **Concurrency:** transitions serialize on `FOR UPDATE`; a loser that finds
  the requested state returns the winner's record without a second audit
  row. A version-0 runtime registering concurrently either commits first
  (seen by readiness → refusal) or waits on the state row and is refused by
  the trigger. Tightening vs registration: §2.1.
- **Propagation (ADR-024):** `isAiPolicyEnforcementAvailable()` stays
  synchronous and reads a process cache loaded from PostgreSQL at startup
  before routes and workers; if that first read fails the process starts
  *disabled* (fail closed) and keeps polling. The writing process reloads
  its own cache from the DB right after commit; other processes re-read on
  the new `ai_policy:activation:changed` channel (payload ignored — a reload
  signal, never a state carrier), on `onReconnect`, and by an unref'd 30 s
  poll. A stale *disabled* refuses new tightening (fail closed); a stale
  *enabled* after a switch-off can attempt a tightening for ≤30 s, which the
  §2.1 tightening trigger refuses whenever an old runtime is active and
  which admission enforces in any case — no safety property depends on the
  cache.
- **Rollback of binaries:** a pre-#1881 binary cannot register while the
  switch is on or any restriction exists, and no restriction can be created
  while one is active, so it never runs beside restrictions. Forward-fix
  only.
- **Switch-off UX:** while off, editors see the inert copy and cannot relax
  a stored restriction from the UI (the API still allows an authorized
  relaxation). The turn-off confirmation and the docs say so; it is the
  emergency lever, not a routine state.
- **Stale policy-aware clients:** `aiPolicyActivation` is read on every
  page-detail fetch; no reload needed. Legacy bundles: §2.3.
- **Leftover env flag:** a set `COMPENDIQ_AI_POLICY_ENFORCEMENT` is reported
  once at startup as ignored (FTS_LANGUAGE precedent). Env-flag deployments
  come up disabled with their restrictions still enforced until an admin
  enables the switch.

### 2.5 Closing G1 (global label rename/delete)

`PUT /api/admin/labels/rename` and `DELETE /api/admin/labels/:name` refuse when either name normalizes (contracts
`normalizeAiPolicyLabel`) to a reserved AI-policy label, with 409
`{ error: 'ai_policy_reserved_label' }`, before any lock or write, in both
switch states. Policy-bearing label changes must go through the policy
endpoints, which check per-page authority and revisions.

### 2.6 EE overlay (companion PR, branch of the same name)

Remove `aiPolicyEnforcementAvailable` and `COMPENDIQ_AI_POLICY_ENFORCEMENT`
from `overlay/backend/src/enterprise/plugin.ts`; migrate overlay tests that
set the env flag to the CE activation (real DB); add a licence-loss test:
with CE activation set, clearing the licence leaves
`isAiPolicyEnforcementAvailable() === true`, a stored `none` page still
refuses admission, and `resolveAiPolicyCreationDefault` falls back to `all`
for **new** rows only. Update `docs/phase1.1/enterprise-model-provenance.md`.
CE removes the optional hook from `EnterprisePlugin` (`types.ts:84`),
`noop.ts:39`, the loader comment and the loader test (clean cutover).
Merge order: CE, then EE, then the submodule sync.

**Test seam (CE and EE).** Tests that need an open switch write the real
state row through `setAiPolicyEnforcementEnabled` (or a test helper that
updates the row and then calls the same cache reload) — never a plugin
spy. The four CE suites that spy on the hook today
(`loader.test.ts:67,85`, `ai-policy-recovery-admission.db.test.ts:11`,
`page-ai-policy-creation-labels.db.test.ts:26,37`,
`policy-label-synchronization.db.test.ts:35`) and
`ai-policy-worker-admission.integration.test.ts` (env flag) migrate to it.
No production path sets the cache without reading PostgreSQL.

### 2.7 Binding implementation requirements (round-3 review)

- **N19** Registration trigger returns `NEW` without locking when a row with
  `NEW.runtime_id` already exists (re-registration) or the new row is
  already fenced/quiesced; `FOR UPDATE` is taken only by a genuinely new
  active version-0 row (a process start holding no page locks). Old
  binaries' per-admission re-registration therefore cannot deadlock with a
  new-binary tightening.
- **N20** Each trigger runs the row lock and the existence check as separate
  statements (`PERFORM … FOR SHARE/UPDATE;` then `IF EXISTS (…)`), never one
  `SELECT EXISTS(…) … FOR SHARE`. Two-connection tests hold the other
  transaction open across the lock wait.
- **N21** Tightening guard: `AFTER UPDATE ON pages FOR EACH ROW WHEN
  (NEW.ai_policy IS DISTINCT FROM OLD.ai_policy)` and `AFTER INSERT … WHEN
  (NEW.ai_policy <> 'all')`; the function itself decides "stricter". A
  missing state row raises (fail closed).
- **N22** Shared test helper `insertTestRuntime({ legacy?: boolean })`
  setting both enforcement versions current by default; sweep every test
  that inserts `page_writer_runtimes` rows. Deliberately legacy fixtures
  (`page-baseline-governance.integration.test.ts`) stay version 0.
  *As implemented:* every **active** fixture row now registers version 1;
  fixture rows inserted already fenced or quiesced are inert under N19 (no
  lock, never counted as active) and were left unchanged.
- **N23** `truncateAllTables` reseeds `observing_since = NOW() - interval
  '2 days'`; window tests set it explicitly.
- **N24** Recovery and deferred ingestion classify `55000` +
  `ai_policy_incompatible_runtime_active` as a refused tightening (stays
  pending, completes after the version-0 row is fenced), never terminal or
  `intent_recovery_metadata_invalid`. HTTP maps it centrally to 409
  `ai_policy_enforcement_unavailable` with `reason:
  'incompatible_runtime_active'`.
- **N25** The activation transaction sets `lock_timeout = '5s'`; a timeout
  answers a retryable 503 `ai_policy_activation_busy`.
- **N26** Operator notes: old replicas killed without quiescence after
  migration 151 issue tokens the window cannot see (drain via quiescence or
  wait one lifetime); a new install shows `legacy_client_window_open` for
  one lifetime (copy says acknowledging is appropriate there); mixed-fleet
  env-flag pods see transient 500s for their own tightenings.
- **N27** Expiry sweep of observation rows in the existing token-cleanup
  job; CORS `allowedHeaders` stays unset; extend the writer lock-order
  sentence in `docs/claude/enterprise-and-baselines.md` with "then, for
  restrictive policy writes, activation-state `FOR SHARE`".

## 3. Preservation invariants

| ID | Invariant | How it holds | Automated proof |
|---|---|---|---|
| I1 | Switch off ⇒ the policy flows are unchanged (409 `ai_policy_enforcement_unavailable`, inert copy) | Fresh/upgraded DB is disabled; every gate keeps its code path; UI copy untouched. Deliberate changes while off, each tested: (a) G1 refusal; (b) SPA sends the marker header (cross-origin `FRONTEND_URL` setups gain a CORS preflight; `allowedHeaders` stays unset, so it is reflected); (c) observation upsert after a successful legacy session issuance, response unchanged; (d) registration trigger refuses new pre-#1881 binaries when restrictions exist, tightening trigger refuses restrictions while one is active; (e) EE env flag ignored, startup notice | never-enabled DB: detail `foundation_only`, PUT/bulk/create 409; restrictions present + disabled → `foundation_only` and GET activation `ready`; tests for (a)–(e) |
| I2 | Licence loss never downgrades | Switch is licence-independent; no admission path reads licence or switch | EE overlay test (§2.6); CE test: noop plugin + enabled keeps `none` admission refused |
| I3 | Stale revision ⇒ 409, draft kept | Unchanged `expectedRevision` CAS + existing selector reducer | active-mode HTTP 409; existing `ArticleAiPolicySection.test.tsx` |
| I4 | Committed restrictions block new admissions | Unchanged admission; the switch adds only tightening ability; switching off keeps them | active-mode test: set `none` → admission refused, then switch off → still refused |
| I5 | Restrictive changes need editor authority | Unchanged `canMutateAiPolicy`; the switch is not authority | active-mode HTTP: shared viewer 403 `ai_policy_denied`, scoped editor 200 |
| I6 | RBAC/ACE, ESLint boundaries, revision + lock fences intact | New code in `core` + `routes/foundation`; enabling locks users row → state row (no page locks); registration takes state `FOR UPDATE` only for a genuinely new active version-0 row (N19) and never locks pages; the tightening trigger takes state `FOR SHARE` after the writer's page locks | `npm run lint`, existing fence suites, two-client trigger tests |
| I7 | Never enable on incomplete enforcement | G1 closed; runtime blocker non-overridable; restrictions cannot be created while an old runtime is active (trigger); legacy-client blockers named, attributed, overridable only by an audited acknowledgement of the bounded residual that never carries over | refusal tests per blocker; override and re-enable tests |

## 4. UI (to be produced under /impeccable)

- Settings → Governance gains **Article AI policy** beside *Article
  baselines*, reusing its card/blocker/strip patterns: state line (off /
  on since *date* by *name*), blocker list with named, actionable copy
  (runtime total + ids/hosts/start times with the retirement procedure;
  legacy users with last-seen and `clearsAt`), the acknowledgement checkbox
  only when the legacy-client blocker is the sole blocker, and **Turn on
  enforcement…** opening the existing `ConfirmDialog` that states what
  changes (restrictive policies can be chosen; old builds can no longer
  start; legacy tabs must reload). Turning off is a quieter secondary
  action with its own confirmation stating that stored restrictions stay
  enforced. Blocked actions stay mounted with `aria-disabled` + explanatory
  copy (no native `disabled`); errors name the server reason. No new tokens,
  neutral chips, Steel accent only for the primary action.
- New bundle's handling of `client_reload_required` on login/refresh/OIDC/
  setup: a distinct reload message.
- Active article surfaces (`ArticleAiPolicySection`, bulk dialog, dock) are
  unchanged code paths; the switch makes them reachable. #1882 polish is out
  of scope.

## 5. Verification plan

Browser steps (real `npm run dev`, isolated Postgres/Redis/ports; EE overlay
build for B8/B10):
B1 refused activation shows named blockers (a real pre-#1881 backend from an
`origin/dev` worktree registered against the same DB; a legacy browser
session) · B2 fence the old runtime, acknowledge/clear legacy, turn on;
actor + time shown and in the audit log · B3 `GET /api/pages/:id` →
`aiPolicyActivation: 'active'` · B4 policy selector; a concurrent change
makes the save 409 and the draft stays selected · B5 No-AI confirmation then
committed change · B6 `local_only` article: editor AI and inline completion
paths · B7 a conversation citing a now-restricted article refuses
continuation and offers New chat · B8 EE space default applied to a new page
and subtree cascade · B9 before enabling, the inert copy and bulk refusal
are unchanged · B10 EE licence removed: switch stays on, stored
restrictions still enforced, space-default actions disabled.

| Acceptance / invariant | Automated test (real Postgres) | Browser |
|---|---|---|
| A1 | — (docs) | — |
| A4 | `ai-policy-activation.integration.test.ts`: each blocker; fenced/quiesced runtimes ignored; `legacy_client_window_open` on a fresh migration, cleared after the window, extended by a version-0 `quiesced_at`; acknowledgement overrides only the two legacy blockers, is reset by disable and required again on re-enable; registration trigger refuses version-0 while enabled and while restrictions exist (soft-deleted included); tightening trigger refuses a restrictive INSERT, a tightening UPDATE and a recovery replay while a version-0 runtime is active, allows relaxations; two-client interleavings registration-vs-tightening in both orders and enable-vs-enable; `__tests__/151_*.test.ts` fresh/upgrade/idempotent | B1 |
| A2 | same file: enable → 200 actor/time + audit; idempotent repeat (no second audit); non-admin 403; demoted/deactivated admin 403; bad body 400; then detail `active` and editor PUT `local_only` 200 | B2, B3 |
| A3 / I1 | never-enabled HTTP test (detail, PUT, bulk, create 409); restrictions-present-disabled test; frontend inert copy tests unchanged | B9 |
| A5 / I2 | EE overlay licence-loss test; CE noop + enabled | B10 |
| A6a–e / I3 | HTTP 409 stale revision; existing selector, confirmation, `local_only`, dock-history and EE cascade suites run with the switch on where they previously spied | B4–B8 |
| I4, I5 | active-mode HTTP tests above | B4–B6 |
| G1 | rename to/from every reserved spelling → 409, nothing written; ordinary rename/delete unchanged | — |
| G2 | auth hook: forged unauthenticated legacy login records nothing; successful legacy login, refresh and (stub-route) OIDC exchange record the user with `token_expires_at`, response unchanged; enabled → 409 `client_reload_required` before rotation (refresh-token rows unchanged) on each allow-listed route, including a stub `/api/auth/oidc/exchange` registered after the hook; switching off stops the refusal on the next request; non-browser and marked requests unaffected; DB-read failure → 503; frontend: enumerates every `fetch(` to `/api/auth/*`, `/api/setup/admin` and asserts the marker; `client_reload_required` copy. EE overlay: real exchange refused when enabled and the login code survives for a retry | B1 |
| Propagation | unit: bus event and poll re-read the DB; payload ignored; writer reloads after commit; failed first load starts disabled | — |
| Env flag | startup notice when `COMPENDIQ_AI_POLICY_ENFORCEMENT` is set | — |

Fail-before/pass-after: activation, G1 and G2 tests fail on `origin/dev`
(routes/columns absent; reserved rename succeeds; legacy refresh unrefused).
Full gates: `npm run typecheck`, `npm run lint`, backend and frontend suites,
EE overlay suite against this branch.

## 6. Documentation

Rewrite `docs/architecture/article-ai-policy-activation.md` (as-built
mechanism, diagram, operator procedure incl. bulk runtime retirement);
update the stale coverage section of `article-ai-governance-foundation.md`,
`03-backend-domains.md`, `06-data-model.md`, `docs/ADMIN-GUIDE.md`,
`docs/runbooks/immutable-page-baselines.md` (runtime retirement now also
gates AI policy), `docs/claude/enterprise-and-baselines.md`. EE:
`enterprise-model-provenance.md`.

## 7. Exception record (owner-authorized, #1881 only)

- **Waived rule:** CLAUDE.md Mandatory Rule 4 ("Ask when ambiguous") for the
  issue's *Decision needed* and design sign-off, and the user-approval pause
  in `/impeccable`.
- **Reason:** owner (Simon) authorized an independent AI reviewer to replace
  the human design-approval pause for this issue.
- **Risks:** reviewer-model blind spots; an unvetted product decision
  (CE-owned activation replacing the merged EE env/licence hook); a one-way
  door (once restrictions exist, pre-#1881 binaries can no longer start).
- **Compensating controls:** adversarial review with explicit
  APPROVE/REJECT; re-review on any material change (mechanism, precondition,
  invariant, data model, authority); `/review` on the PR plus a targeted
  re-review of fixes; full local and CI verification; no merge, no deploy,
  no push to `dev`/`main`.
- **Owner authorization:** Simon, for #1881 only. Every other rule applies in
  full; any ADR deviation or ambiguity outside this design goes to the owner.
- **Expiry:** when the PR is completed or abandoned.

## Approval record

Reviewer: `reviewer` subagent, model identity reported by its runtime:
`anthropic/claude-fable-5-1` (not the design author).

- **Round 1 — REJECT.** Blocking: B1 marker missed raw OIDC-exchange and
  setup-admin fetches → SSO lockout after one-way activation; B2 legacy
  observation was an unauthenticated, unattributed, unoverridable veto.
  Non-blocking N1–N10 (I1 overclaim, `assertFreshAdmin` has no `FOR
  SHARE`, one-way rationale wrong, historical runtime rows, env-flag
  upgrade, trigger index, propagation details, prefix matching, test-plan
  gaps, nits). Resolutions in this revision: single marker helper on every
  covered fetch + enumeration test + reload copy (B1); observation only on
  successful issuance, attributed per user, audited acknowledgement
  override, active-state refusal kept (B2); I1 enumerates deliberate
  changes (N1); new users-row `FOR SHARE` (N2); reversible switch with the
  binary one-way door in the trigger (N3); runtime total + bulk retirement
  procedure (N4); env-flag notice + test (N5); partial index (N6);
  reload-signal bus, 503 on read failure, throttle slack (N7); explicit
  allow-list (N8); B-steps, concurrency and migration tests, CE seam (N9);
  placement/path/rate-limit fixes (N10).
- **Round 2 — REJECT.** B1/B2 confirmed resolved. New blocking: B3 the
  binary door was not serialized against tightening (stale-enabled cache,
  recovery replay, creation INSERTs could add a restriction beside a live
  old runtime); B4 the legacy blocker was blind for one token lifetime
  after upgrade. Non-blocking N11–N18. Resolutions: AFTER tightening
  trigger on `pages` (`FOR SHARE`) + registration trigger `FOR UPDATE`,
  both indexed, mapped to 409 (B3); `legacy_client_window_open` from
  `observing_since` / version-0 `quiesced_at` (B4); acknowledgement per
  enabling transition, reset on disable (N11); body-parsed attribution with
  detached upsert (N12); switch-off UX stated (N13); fail-closed first load
  and writer-side reload (N14); hook order before routes and EE plugin
  (N15); CORS left unset (N16); `token_expires_at` (N17); added tests (N18).
- **Round 3 — APPROVE** (no blocking findings). Non-blocking N19–N27 are
  binding implementation requirements, listed in §2.7 and verified in
  `/review`; none changes mechanism, preconditions, invariants, data model or
  authority.
