# Implementation Plan — Issue #1875: admin UI control for `webhookDeliveriesRetentionDays`

> Target branch: `feature/1875-webhook-deliveries-retention-ui` → PR to `dev`.
> Scope: add an editable retention window for the `webhook_deliveries`
> attempt ledger to Settings → Governance → Data & Compliance → Retention,
> validated exactly like the contract, beside the existing admin
> access-denied retention control. Frontend + docs only.
>
> Out of scope: terminal `webhook_outbox` retention (#1760); any change to the
> retention sweep, the admin-settings route or the contract; making the
> Retention sub-tab visible in Community Edition (see §8 R1).

---

## 1. Verified facts (on `origin/dev` `e03172a`)

| Fact | Evidence |
|---|---|
| Contract: read field required, update optional, both `z.number().int().min(7).max(3650)` | `packages/contracts/src/schemas/admin.ts:447`, `:597` |
| `AdminSettingsSchema` is a plain `z.object` (field schemas reachable via `.shape`) | `admin.ts:378` |
| GET returns, PUT upserts only when the key is present (`!== undefined`) | `backend/src/routes/foundation/admin.ts:454`, `:797-801` |
| Every `/admin/*` route in that plugin is admin-only (`onRequest: requireAdmin`) | `admin.ts:187` |
| Sweep is CE core, license-independent; never touches `webhook_outbox` | `backend/src/core/services/data-retention-service.ts:116-118`, `:515-560` |
| Backend tests already cover GET default 90 and PUT persistence | `backend/src/routes/foundation/admin.test.ts:784-800` |
| Contract tests cover the range for the sibling field; the webhook field is in the read fixture | `packages/contracts/src/schemas/admin.test.ts:29`, `:250-325` |
| Existing control `AdminAccessDeniedRetentionSection` (single-field PUT, `['admin-settings']` query, draft-over-server, `?? 90` fallback) | `frontend/src/features/admin/DataRetentionTab.tsx:59-140` |
| It is rendered in both branches of the tab, outside the `data_retention_policies` gate | `DataRetentionTab.tsx:235`, `:271` |
| Weaknesses: `Number(e.target.value)` draft (empty → `0`, `30.5` reach Save); range only via HTML `min`/`max`; read failure renders the fabricated default 90; save error only toasted | `DataRetentionTab.tsx:61-84`, `:120` |
| **Webhooks gating:** Webhooks sub-tab visible only for `isEnterprise && hasFeature('webhook_push')`; webhook admin routes are EE overlay routes | `frontend/src/features/settings/wrappers/ComplianceWrapper.tsx:44-52`, `frontend/src/features/admin/WebhooksTab.tsx:113`, `docs/ADMIN-GUIDE.md:1325` |
| **Retention tab gating:** sub-tab visible only for `isEnterprise && hasFeature('data_retention_policies')`; the whole nav item is `enterpriseOnly` | `ComplianceWrapper.tsx:22-31`, `frontend/src/features/settings/settings-nav.ts:105-110` |
| Reference patterns for validated numeric admin settings | `frontend/src/features/settings/panels/BackupObjectLockCard.tsx:15-16,59,71,80` (string draft, hand-written range check, `aria-invalid`, inline alert, "changes kept"), `frontend/src/features/settings/WorkersTab.tsx:154-276` (draft kept across save, `setQueryData` then invalidate, read/refresh failure notice) |
| Shared retry recipe for "could not be read" notices | `frontend/src/shared/hooks/use-notice-retry.ts` |
| Docs describe the setting as API/env-only | `docs/ADMIN-GUIDE.md:430` |
| E2E: admin login pattern (`COLLAB_E2E_ADMIN`) and `page.route` mocking both exist; no spec covers the Retention tab | `e2e/settings-nav.spec.ts:70-88`, `e2e/confluence-sync-mock.spec.ts:30` |

**Backend/contract gap check:** none found. The route persists only supplied
keys, Zod enforces the range server-side, and both directions are already
tested. No backend or contract change.

## 2. CE/EE placement decision

The new control is rendered **in the same CE-native region as the
access-denied control** (outside the in-tab `data_retention_policies` gate, in
both render branches) and is **not** gated on `webhook_push`.

- The setting is a CE core admin setting; the sweep that consumes it runs in
  every edition and regardless of licence state.
- Ledger rows outlive the webhook feature: a lapsed licence or a removed
  `webhook_push` feature stops new deliveries but leaves existing rows that the
  sweep keeps pruning by this window. Hiding the control behind `webhook_push`
  would hide a setting that still governs stored data.
- Reachability is unchanged and inherited from the tab: the Retention sub-tab
  itself is EE + `data_retention_policies` only (pre-existing; §8 R1).
- Security: the client gate is presentation only. Authorization stays on the
  server (`requireAdmin`), validation stays on the server (Zod). Client-side
  validation is UX and never a trust boundary.

## 3. UI design (impeccable: Operate mode, refinement of incumbent)

### 3.1 Layout

One `nm-card` section at the top of the tab, replacing the standalone
access-denied card:

```
┌ Retention windows ──────────────────────────────────────────────┐
│ The daily retention sweep deletes these rows once they are older │
│ than their window. Each window is saved on its own.              │
│ [read/refresh notice + Retry, only when the settings read failed]│
│──────────────────────────────────────────────────────────────────│
│ ⛨ Admin access-denied audit retention (days)       [ 90 ] [Save] │
│   <existing description, verbatim>                               │
│   Whole days, 7–3650.                                            │
│   <inline validation / save error>                               │
│──────────────────────────────────────────────────────────────────│
│ ⚲ Webhook delivery attempts retention (days)       [ 90 ] [Save] │
│   <description>                                                  │
│   Whole days, 7–3650.                                            │
│   <inline validation / save error>                               │
└──────────────────────────────────────────────────────────────────┘
```

- Rows separated by the structural hairline (`divide-y divide-border`), never
  nested cards (ui-ux: bordered card inside a bordered region is the
  nested-card tell).
- Row geometry follows `WorkersTab`'s `BatchSizeControl`:
  `flex flex-wrap items-start justify-between gap-x-4 gap-y-2`; text column
  `min-w-0 flex-1`; controls `shrink-0`. Below ~480px the controls wrap under
  the text instead of squeezing it.
- Heading `h2`, `text-lg font-semibold`, matching the sibling
  "Data Retention Policies" `h2`; `tabIndex={-1}` so a successful Retry can
  rehome focus to it. Copy 13px (`text-xs`, the floor); leading 18px icons
  `aria-hidden` (`ShieldAlert` kept for the existing row, `Webhook` for the
  new one).
- Each row is its own `<form noValidate>` (so implicit Enter submission can
  only ever submit that row, and the browser never substitutes its native
  min/max tooltip for the project copy).
- Input: `nm-input w-24 text-right` (32px, interactive border, project focus
  treatment), `type="number"`, `inputMode="numeric"`, `min=7 max=3650 step=1`
  for spinbutton semantics and ArrowUp/Down.
- Save: `<button type="submit" className="nm-button-ghost h-8 min-w-20 text-xs …">`
  (`nm-button-ghost` alone is 34px; `h-8` brings it to the input's 32px as the
  `WorkersTab` Retry does; `min-w` stops the "Saving…" swap from shifting the
  row; real interactive border, its own `:focus-visible` ring) using the
  `BackupObjectLockCard` recipe: unavailability is `aria-disabled` plus a
  handler refusal, **never** native `disabled`, so a keyboard admin who saves
  keeps focus on the button through the request and after success; pending is
  a label swap "Saving…" plus `aria-busy`. `aria-disabled:cursor-default
  aria-disabled:opacity-70` as in `WebhooksTab.tsx:250`. Retry uses the same
  `nm-button-ghost h-8 text-xs` recipe. `onSubmit` calls `preventDefault()`.

### 3.2 Copy

- Section: **Retention windows** — "The daily retention sweep deletes these
  rows once they are older than their window. Each window is saved on its own."
- Existing row: label and description unchanged.
- New row label: **Webhook delivery attempts retention (days)**.
- New row description: "Automated purge of `webhook_deliveries` rows, the log
  of each webhook delivery attempt. Only attempts of finished deliveries
  (delivered or dead-lettered) are removed; deliveries still retrying and the
  `webhook_outbox` queue are never touched. Default 90 days."
- Hint (both rows): "Whole days, 7–3650."
- Validation error (both rows): "Enter a whole number from 7 to 3650."
- Save failure: "<server message> Your change has been kept. Retry saving."
  (mirrors `BackupObjectLockCard`).
- Success toast: "Webhook delivery retention updated" (existing row keeps
  "Denied-admin retention updated").
- Read failure (nothing cached): "Retention settings could not be read." + Retry.
- Refresh failure (cached data): "Retention settings could not be refreshed.
  Last loaded values and unsaved edits are still shown." + Retry.
- Loading: "Loading retention settings…" (visible, `role="status"`).

### 3.3 State model (per row)

- `draft: string | undefined` — raw input text; `undefined` = showing server.
- `serverValue = settings?.[field] ?? 90` (older backend omitting the field →
  90, no crash).
- `parsed`: `raw.trim() === ''` → invalid; otherwise `Number(raw)` checked with
  the contract's own field schema `AdminSettingsSchema.shape[field].safeParse`
  — validation is the contract, not a copy of it.
- `invalid = draft !== undefined && !parsed.success` — drives `aria-invalid`
  immediately.
- `touched` flag: set on blur and on any submit attempt, reset on the next
  edit. The validation **message** shows only when `invalid && touched`, so
  typing "30" never flashes an error at "3"; an attempted save of an invalid
  value always shows and announces it.
- `hasChange = draft !== undefined && parsed.success && parsed.data !== serverValue`.
- Save allowed iff settings loaded ∧ `hasChange` ∧ not pending. Enforced in the
  row form's `onSubmit` (Enter and click both go through it); the button is
  only `aria-disabled` when not allowed.
- Double fire: a synchronous `useRef` in-flight flag set before `mutate` and
  cleared in the mutation-level `onSettled`; TanStack's `isPending` re-render
  is scheduled through `notifyManager` (`setTimeout(0)`), so the ref is the
  guard and `isPending` is the visual.
- Success: `setQueryData` merges only the saved field into `['admin-settings']`
  (write is confirmed even if the follow-up read fails; the key is shared with
  `WorkersTab`, hence merge, never replace), then
  `invalidateQueries(['admin-settings'])`; the draft is cleared only if it
  still equals the submitted text, so an edit typed during the save survives.
- Failure: draft retained; inline `role="alert"` with the server message; error
  cleared on the next edit or the next submit; Save stays available.
- Rows are independent: each owns its draft, mutation and error. A save in one
  row PUTs one key and never reads or sends the other row's draft or value.

### 3.4 Section states (shared query)

Render precedence (as `WorkersTab.tsx:220-245` / `WebhooksTab.tsx:236-262`):
failure/retry notice first, then the loading skeleton, then the rows.

- Read failure with nothing cached (`isError || retryInFlight`, no data):
  destructive notice "Retention settings could not be read." + Retry; rows are
  **not** rendered (no fabricated 90 that Save would diff against). While the
  retry is in flight react-query reports `pending`, but the notice wins.
- Loading (no data, no failure): skeleton row pair + "Loading retention
  settings…" (`role="status"`).
- Refresh failure with cached data: amber notice + Retry above intact rows;
  drafts and their Save availability preserved.
- Retry uses `useNoticeRetry` (`aria-disabled` busy state + "Retrying…" label;
  focus rehomed to the section heading (`tabIndex={-1}`) when a successful
  retry unmounts the notice and focus fell to `<body>`).

### 3.5 Accessibility

- `<label htmlFor>` programmatic label per input.
- `aria-describedby` = description id + hint id, plus the error id whenever an
  error message is shown.
- `aria-invalid="true"` while the draft is invalid. The validation message
  lives in a persistently mounted `aria-live="polite"` region and appears only
  after blur or a submit attempt (§3.3 `touched`), so it is announced once,
  not per keystroke. Save failure uses `role="alert"`.
- Keyboard: Tab → input, type/arrow keys, Enter submits **that row's** form,
  Tab → Save (Enter/Space). Save stays focusable when unavailable
  (`aria-disabled`). Activating it with an invalid draft shows and announces
  the validation message; with no change it is a silent no-op, the dimmed
  state being the reason (as in `BackupObjectLockCard`) — no extra "nothing
  to save" notice.
- Focus: `nm-input` focus treatment, `nm-button-ghost` `:focus-visible` ring
  for Save and Retry; browser check confirms the Steel ring in both themes,
  falling back to `nm-focus-ring` if it does not win the cascade.
- Colour is not the only channel: every error is text; tokens only
  (`text-destructive`, `text-warning`, `text-muted-foreground`) so both
  Graphite and Paper resolve through the measured palette.

## 4. Shared-component decision

**Extract** into a sibling module `frontend/src/features/admin/RetentionWindowsSection.tsx`
(the tab file is already 511 lines), exporting `RetentionWindowsSection`:

- `RetentionWindowsSection` — owns the `['admin-settings']` query, loading /
  read-failure / refresh-failure states and Retry; renders two rows.
- `RetentionDaysRow` (module-private) — one field rendered as its own
  `<form noValidate>`: label, description, hint, validated input, single-field
  mutation, inline errors. Parameterised by `field`
  (`'adminAccessDeniedRetentionDays' | 'webhookDeliveriesRetentionDays'`),
  ids/testid prefix, copy, icon, success toast.

Why: two identical knobs on one surface must behave identically. Adding a
validated sibling next to an unvalidated original would ship two conventions
side by side (one blocks 6 with an inline error, the other sends it and gets a
400 toast). The existing control therefore gains the same validation and
failure handling. It keeps its label, description, PUT key, toast and
`data-testid`s: `admin-denied-retention-input`,
`admin-denied-retention-save-btn`, `denied-admin-retention-section`,
`denied-admin-retention-loading` (the loading id moves to the shared loading
state). Not moved to `shared/`: no other consumer.

Regression proof: existing tests pass; only the Save-availability assertion
is migrated from native `disabled` to `aria-disabled` + no-PUT-on-submit
(intended N2 change); the other four `AdminAccessDeniedRetentionSection
(#264)` tests run byte-for-byte. The validation `it.each` runs over both
fields; new tests prove the access-denied draft survives a webhook-row save
and submit; browser check confirms its value persists independently.

## 5. Files

| File | Change |
|---|---|
| `frontend/src/features/admin/RetentionWindowsSection.tsx` (new) | `RetentionWindowsSection` + `RetentionDaysRow` |
| `frontend/src/features/admin/DataRetentionTab.tsx` | Remove `AdminAccessDeniedRetentionSection`; render `RetentionWindowsSection` in both branches |
| `frontend/src/features/admin/DataRetentionTab.test.tsx` | New tests (§6); existing #264 tests untouched except the shared fixture type |
| `e2e/data-retention.spec.ts` (new) | Admin round-trip (§7.2) |
| `docs/ADMIN-GUIDE.md` | `:430` no longer API/env-only; describe the Retention tab's retention windows |
| `CHANGELOG.md` | `### Added` (new control) and `### Changed` (access-denied control: validation, read-failure, inline save error) under `[Unreleased]` |
| `docs/issues/1875-implementation-plan.md` | This plan + approval record |

No `docs/architecture/*` change: no structural change (CLAUDE.md rule 6).

## 6. Unit test plan (`DataRetentionTab.test.tsx`, existing style: fetch spy + `fireEvent`)

| # | Test | AC |
|---|---|---|
| U1 | Renders server `webhookDeliveriesRetentionDays` (120) | AC-2 |
| U2 | Field omitted by server → 90, no crash (access-denied still shows its value) | AC-2 |
| U3 | Save sends exactly `{ webhookDeliveriesRetentionDays: n }` (`Object.keys` equality, numeric value) | AC-5 |
| U4 | `it.each` over **both fields**: `7`, `3650` → no error, Save available; `6`, `3651`, `30.5`, `''` → `aria-invalid`, Save `aria-disabled`; after `blur` the error text shows and its id is in `aria-describedby`; `fireEvent.submit(form)` sends no PUT | AC-3, AC-10 |
| U5 | Save unavailable initially, available on a real change, unavailable again when the server value is typed back (`'090'` too) | AC-4 |
| U6 | Success: GET refetched, input shows new server value, Save unavailable (draft cleared) | AC-6 |
| U7 | Failure: PUT 400 with message → inline alert with server message, draft kept, Save still available | AC-7 |
| U8 | Two synchronous clicks → exactly one PUT; while pending the button carries `aria-busy` and the "Saving…" label | AC-8 |
| U9 | Access-denied draft (30, unsaved) survives a webhook-row **click** save; webhook PUT carries no access-denied key | AC-5, AC-10 |
| U10 | GET `/admin/settings` 500 with nothing cached → read-failure notice, no inputs; Retry success → inputs render and focus lands on the section heading | AC-9 |
| U11 | Existing "CE-native when gated off" test extended: webhook input present beside the EE gate | AC-1 |
| U12 | Load OK → access-denied draft typed → next GET 500 → refetch (`invalidateQueries`) → amber refresh-failure notice with Retry, both inputs rendered, the draft still shown and its Save still available | AC-9 |
| U13 | Access-denied draft 30 (unsaved) + valid webhook draft 120 → `fireEvent.submit` on the webhook row's form → exactly one PUT, keys `['webhookDeliveriesRetentionDays']`, access-denied input still 30 | AC-5, AC-10 |
| — | Existing five #264 tests unchanged and green | AC-10 |

jsdom has no implicit submission, so Enter is modelled with
`fireEvent.submit(form)` (precedent `LoginPage.test.tsx:781`); real Enter is
proven in §7.2.

No wording-only or wiring-echo tests.

## 7. Verification plan

### 7.1 Checks (once, after implementation)

`npm run lint`, `npm run typecheck`, `npx vitest run src/features/admin/DataRetentionTab.test.tsx`
then the full frontend suite, `npm test -w packages/contracts`, the backend
`admin.test.ts` + `data-retention-service` tests (real Postgres on 5433),
`npm run build`.

### 7.2 Browser (real local stack)

Stack: own `pgvector/pgvector:pg17` + `redis:8-alpine` containers on unused
loopback ports (5475 / 6405; existing 5433 test DB, the `cq1882-*` stack and
the `compendiq-ee-*` stack on 8081/3052 are left alone); worktree `.env` with
those URLs and `BACKEND_PORT=3075` (3061 is in use by another worktree);
`npm run dev`'s two workspaces run under `concurrently` with
`VITE_API_PROXY_TARGET=http://localhost:3075` and Vite on `--port 8095
--strictPort` (8081 is taken). First admin via `POST /api/setup/admin`.

Licence: CE has no EE package, so the Retention sub-tab is hidden. The browser
intercepts **only** `GET /api/admin/license` to return
`{ edition: 'enterprise', valid: true, features: ['data_retention_policies'] }`
(no `canUpdate`, so no overlay load). Every `/api/admin/settings` request hits
the real backend and Postgres. This mocks presentation entitlement only, not
authorization or persistence. Two consequences to read the evidence by:
(a) with one visible sub-tab, `SubTabs` renders its body directly with no
tablist (`SubTabs.tsx:62-66`), so navigation is
`/settings/governance/compliance`; (b) `GET /api/admin/data-retention` is an
EE overlay route that 404s on CE, so the EE matrix renders "No retention rules
configured." For one read-only layout screenshot the browser also fulfils that
GET with the unit-test fixture, to show the section above a populated matrix;
no matrix save is made. (The local `compendiq-ee-*` stack is the owner's and
runs a published image without this change, so it is not used.)

Steps: open the Retention tab; server value shown; type 6, 3651, 30.5 and
empty, pressing **Enter** each time → error visible, no PUT; save 120 with
**Enter** → capture the PUT body (`{"webhookDeliveriesRetentionDays":120}`
only); reload → 120; `GET /api/admin/settings` agrees; access-denied value
unchanged; refresh failure: after load, block `/api/admin/settings` and
trigger a refetch → amber notice + Retry with drafts kept; unblock → Retry →
notice gone; keyboard-only path with the Steel focus ring visible on input
and Save; Graphite and Paper; 375px viewport. Screenshots in the PR evidence
list.

E2E: `e2e/data-retention.spec.ts` combines the admin-login pattern
(`settings-nav.spec.ts:70-79`) with `page.route` licence interception;
`beforeEach` reads the original value via `GET` and picks the target as
`original === 120 ? 121 : 120`; asserts invalid input blocks saving, the
single-field PUT, persistence across reload and via `GET`, the access-denied
value untouched; `afterEach` restores the original value via the API with a
throwing helper (as `e2e/helpers/collab.ts:27-35`). CI runs `workers: 1`
(`playwright.config.ts:22-24`) and the PUT is single-key, so shared state is
safe.

## 8. Risks

- **R1 (pre-existing, out of scope):** the Retention sub-tab — and so both
  CE-native controls — is reachable only with EE + `data_retention_policies`
  (`settings-nav.ts:107-110`, `ComplianceWrapper.tsx:26`). CE admins and EE
  tiers without that feature still use the API/env. Changing nav visibility is
  a product decision beyond #1875; flagged in the PR for a follow-up.
- **R2:** against an older backend that omits the field, the control shows 90
  and a PUT of the unknown key would be stripped by that backend's Zod object
  and not persist; after refresh the value reads 90 again. Frontend and backend
  ship in one image, so the window is a mismatched deploy only.
- **R3:** the existing control's behaviour changes (blocks invalid input it
  previously sent; read failure no longer shows a fabricated 90; save errors
  inline instead of a toast; Save is `aria-disabled` rather than `disabled`).
  Intended; covered by §4 regression proof and a CHANGELOG `### Changed`
  entry.

## 9. Acceptance checklist (shared; all agents report against these IDs)

- **AC-1** Control lives in Data & Compliance → Retention, in the CE-native
  region outside the `data_retention_policies` gate (both branches), not gated
  on `webhook_push`; placement rationale (§2) documented.
- **AC-2** Shows the server `webhookDeliveriesRetentionDays`; missing field →
  90 without crashing.
- **AC-3** Validation equals the contract (integer, 7–3650): 7 and 3650
  accepted; 6, 3651, 30.5 and empty rejected with inline error text,
  `aria-invalid`, `aria-describedby`, live announcement; click and Enter
  blocked.
- **AC-4** Save enabled only for a valid value different from the server value.
- **AC-5** PUT `/api/admin/settings` body is exactly
  `{ webhookDeliveriesRetentionDays }`; never carries or overwrites the
  access-denied draft/value or any other setting.
- **AC-6** Success refreshes `['admin-settings']`, clears the draft, confirms;
  value persists across reload and `GET /api/admin/settings` agrees.
- **AC-7** Failed save keeps the draft and shows the server error inline;
  retry possible.
- **AC-8** Pending state visible; Save cannot fire twice.
- **AC-9** Loading, read-failure (no fabricated value) and refresh-failure
  (cached values + drafts kept) states visible, with Retry.
- **AC-10** Access-denied control does not regress: existing tests pass; only
  the Save-availability assertion is migrated from native `disabled` to
  `aria-disabled` + no-PUT-on-submit (intended N2 change); same label, test
  ids, PUT key; gains identical validation.
- **AC-11** Accessibility: programmatic label, `aria-describedby` description,
  announced error, keyboard-only operation, project focus ring, correct in
  Graphite and Paper, usable at 375px.
- **AC-12** Docs: ADMIN-GUIDE (setting editable in UI; Retention tab
  description) and CHANGELOG `Added` + `Changed`; no backend/contract change
  (gap check §1).
- **AC-13** Lint, typecheck, frontend/contracts/backend affected tests,
  production build pass; browser workflow evidence captured; E2E spec passes
  locally.
- **AC-14** Process: independent AI design approval recorded (§10) before
  code; PR into `dev`; `/review` run; every finding fixed or justified;
  required CI checks green; not merged or deployed.

## 10. Design-approval exception record

- **Rule waived:** the human design-approval pause before implementation —
  the impeccable `shape` step's "Present the brief for explicit confirmation
  … then stop" (`~/.agents/skills/impeccable/reference/shape.md:55-57`),
  required by the owner's task sequence for UI work — **only** for this
  design. CLAUDE.md Mandatory Rule 4 ("Ask when ambiguous") stays in force for
  product-intent ambiguity outside design approval. Nothing else is waived.
- **Scope and authorization:** issue #1875 only; authorized by repo owner for
  #1875 only, in the task instructions given to the implementing agent on
  2026-11-10.
- **Reason:** the owner delegated design approval for this narrowly scoped
  control to an independent adversarial AI reviewer.
- **Risks:** an AI reviewer can share blind spots with the author; a design
  flaw could reach code without a human eye; product-intent questions could be
  silently decided.
- **Compensating controls:** independent reviewer on a different model
  (author `anthropic/claude-opus-5-5`; reviewer `anthropic/claude-fable-5-1`)
  that receives this document and the acceptance checklist, not the author's
  conclusions, with read-only repository access used to verify every claim;
  instructed to challenge UX, security boundaries, preservation invariants,
  failure handling and the verification plan; every blocking finding resolved
  before code; material design changes after approval go back to the same
  reviewer; full local and browser verification; `/review` on the PR and on
  fix deltas.
- **Expiry:** when the PR is merged or closed, or the work is abandoned.

### Review log

- **Round 1 (2026-11-10, `anthropic/claude-fable-5-1`): CHANGES REQUIRED.**
  Blocking: B1 refresh-failure state unverified → U12 + §7.2 step; B2 per-row
  form unstated and Enter-with-valid-change untested → §3.1/§4 per-row
  `<form noValidate>`, U13, Enter steps in §7.2. Non-blocking, all adopted:
  N1 test ids corrected (§4); N2 Save adopts the `BackupObjectLockCard`
  recipe (`nm-button-ghost`, `aria-disabled`, "Saving…", `aria-busy`) and the
  focus-ring check; N3 `touched` gating of the message; N4 render precedence;
  N5 no-tablist navigation, EE matrix 404 and fixture layout screenshot
  (owner's EE stack not used: published image, owner credentials); N6 E2E
  hygiene; N7 `it.each` over both fields, `aria-busy` and focus assertions;
  N8 CHANGELOG `Changed`; N9 `text-lg`, `noValidate`, sibling module;
  N10 this record.
- **Round 2 (2026-11-10, `anthropic/claude-fable-5-1`): APPROVED.** B1 and B2
  resolved (U12/U13, per-row `<form noValidate>`, §7.2 Enter and
  refresh-failure steps); N1–N10 adopted. Residual non-blocking, adopted
  before implementation: N11 `h-8` on `nm-button-ghost` (34px → 32px) and
  corrected height claim; N12 accurate wording of the `aria-disabled` Save
  no-change case; N13 `min-w` on Save, `preventDefault()`, and §1 no longer
  credits `BackupObjectLockCard` with a contract check. Material changes after
  this point return to the reviewer.
- **Round 2, post-approval deviation (2026-11-10, `anthropic/claude-fable-5-1`):
  APPROVED.** jest-dom's `toBeDisabled` reads only native `disabled`, so the
  #264 test at `DataRetentionTab.test.tsx:296-308` migrates to
  `toHaveAttribute('aria-disabled', 'true')` / `not.toHaveAttribute('aria-disabled')`
  plus a no-PUT-on-submit check. Conditions: `aria-disabled={… || undefined}`
  (attribute absent when available); negative no-PUT assertions only after an
  `act`-flushed submit (here and in U4); the other four #264 tests unchanged.
- **Implementation refinements (non-material, from the browser pass):** the
  input also takes `h-8` (`nm-input` measured 34px beside the 32px Save), and
  the row list takes `max-w-2xl` because `SettingsLayout` caps every `<form>`
  at that width (`SettingsLayout.tsx:62`), so the hairlines now end where the
  rows do. No behaviour, copy or state change.
