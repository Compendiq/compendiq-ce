# Enterprise and Baselines

Moved verbatim from `CLAUDE.md`. Paths are relative to the repository root.

## Shared Enterprise Backup Surface

`BackupKmsCard` and `BackupObjectLockCard` belong to the shared CE frontend,
runtime-gated by valid Enterprise plus `enterprise_backup_dr`; do not move
them into an unpublished EE frontend overlay. Keep `kmsEnabled` distinct from
`hasMasterKey`, with absent optional status fields remaining unsupported/off.
Cloud credentials never enter these forms. Object Lock saves are partial and
must preserve unrelated S3 drafts; KMS test/rotation acts on saved settings only.

## Enterprise Model Policy and Audit Hooks

`core/services/client-model-asset-policy.ts` is the inert CE boundary for
EE public-hub checks, verified browser downloads and registry discovery.
Check the policy at every outbound hub fetch, not by URL spelling at routing.
Registered-but-invalid assets must fail closed, never fall through to local
copies. A verified asset's `dispose()` runs exactly once: for a streamed GET
only after the body stream has ended or been destroyed (completion, client
abort, stream error), and immediately for responses without a body (HEAD, 304,
416). The download route registers GET and HEAD explicitly (Fastify's implicit
HEAD would drain the stream), never opens a stream for HEAD, ignores Range on
HEAD, and opts out of compression so Content-Length and Content-Range stay
truthful (#1793).

Summarize, Diagram and Quality use the shared SSE audit lifecycle. Inline
completion reports provider usage (estimates if absent) without plaintext.
Cache replays do not represent new inference. EE composes department metering
once with its selected audit writer; do not also charge inside persistence.
Department text fallback must not rewrite embedding, rerank or image analysis.
`model_governance` belongs to the shared report contract and frontend, gated
by backend availability. Supplied artifact observations and current-registry
checksum agreement are not execution or air-gap attestation; never infer an
observation from a model name or invent missing browser audit coverage.

## Article AI Policy Activation

The enforcement switch for restrictive article AI policies is CE-owned and
licence-independent: one `ai_policy_activation_state` row, changed by an
active system administrator through `PUT /api/admin/ai-policy/activation`,
cached per process in `core/services/ai-policy-activation.ts` and reloaded
from PostgreSQL on the `ai_policy:activation:changed` bus signal, reconnect
and a 30 s poll. `isAiPolicyEnforcementAvailable()` delegates to that cache;
no `EnterprisePlugin` hook, env flag or licence opens or closes it, and
admission never reads it (stored restrictions are enforced in both states).
Enabling refuses with named blockers (active version-0 runtimes,
unacknowledged legacy browser sessions) and is reversible; the one-way door
is on binaries: the registration trigger refuses a new active version-0
runtime while the switch is on or any restriction exists, and the tightening
trigger refuses a stricter `ai_policy` while a version-0 runtime is active.
Tests that need an open switch write the real row
(`setAiPolicyEnforcementForTest` / `setAiPolicyEnforcementEnabled`), never a
plugin spy; tests that insert runtimes use `insertTestRuntime` (current
versions by default, `legacy: true` deliberately). Design and operator
procedure: `docs/architecture/article-ai-policy-activation.md`.

## Immutable Page Baselines

`core/services/page-baseline-service.ts` owns the CE lifecycle; the canonical
manifest, retained storage and distributed writer admission also live in
`core`, not in a route or an EE domain. The manifest is the versioned, framed
UTF-8 array produced by its canonical encoder. Never concatenate fields, sort
with a locale, normalize persisted HTML, or include a retained filesystem path
in the digest. Retained media are exclusive verified copies, not hard links or
a fallback to the live attachment store. Authorize every source page before
inspecting its files, and stream the same file descriptor that was verified.
Only root-relative attachment route prefixes identify internal media; an
external URL containing that route in its path, query or fragment is not local.
Install the protected-page trigger in migration 121, after `baseline_id` exists,
so independently committed migration 120 does not break legacy writes.

Writer lock order is runtime epoch, sorted lifecycle locks, then subsystem and
page locks, then, for restrictive policy writes, activation-state `FOR SHARE`
(taken by the migration-151 tightening trigger after the writer's page
locks). A durable intent precedes external mutation; its effect gate must
finish before settlement. Unknown outcomes stay pending without TTL expiry.
A pending collaborative commit (`collab.commit.confluence[.media]`) is transient
only for its own room's in-memory steps (`ownCollabCommit: 'proceed'`: frames,
peer updates, state reads, joins); the room's persists wait for it (`'defer'`
answers `collab_commit_pending`) and retry after it settles. Every other
writer, including a second Save, and every other pending intent keep
`page_write_busy` (#1763).
Recovery requires server-observed fencing evidence, never a caller's assertion,
a missing heartbeat or a force-clear. A read-only HTTP fetch needs no durable
mutation intent: capture current authority and revisions, then check the same
pair under admission before the final SQL write.
Successful effect phases keep their continuation owned until final settlement;
quiescence must not acknowledge a gap between staging and remote/activation
work. It refuses new work, not an already-started intent's next phase. Only a
proven committed settlement releases that ownership after a commit error.
Effect phases explicitly distinguish local staging from remote dispatch. Keep
the remote-start and all-remote-complete markers across later local phases;
local filesystem work is never evidence that Confluence was contacted.
Known terminal remote work may be published locally by its registered kind's
reconciler. Unversioned work without a terminal result stays pending.
Claim every recovery on the current active runtime before invoking any verifier,
with a durable `recovery_started_at` marker and local drain ownership covering
verification through settlement/publication. No-start fencing must inspect that
marker too. A fully failed callback may retry on the same owner; concurrent
callbacks and recovery on a quiesced/fenced process are refused.
Retain local retry eligibility after a successful claim UPDATE, before awaiting
COMMIT: its acknowledgment can be lost after ownership committed. The next
attempt still checks durable ownership, so a real rollback cannot bypass the
original-runtime fence. Handle checked-out pg client errors and discard broken
connections; an unacknowledged transaction fails to its caller, never as an
uncaught event.
Recovery administration is checked on the mutation client at fencing, claim,
verification, repair and settlement. Quiescence authorizes and audits before
closing the gate, then rechecks after draining; revocation leaves the gate
closed but cannot produce an acknowledgment. Original-writer authority remains
a separate check.
Every accepted recovery attempt, including a same-runtime retry by a different
admin, records that actor and reason before callbacks. Quiescence cancellation
records the acting admin in `settled_by`, not the original writer.
The history's 32-entry / 64 KiB bound is per segment, never a lifetime attempt
cap. Archive a full segment atomically before claiming the next attempt;
`page_write_recovery_history_segments` is append-only and retains every actor
and reason. Keep the latest attempt in-row for current-owner cleanup checks.
Ordinary, Apply and restore PUT replies retain bounded acknowledgment before readback;
never invent returned body fingerprints from the request or lose known success
because a later GET failed. Current authority, source identity, integration mode
and credentials are re-read at each admitted remote phase.
Version restore checks its optional optimistic version against the live page row
held by `FOR UPDATE`, before adding the superseded snapshot or mutating content.
Omitting the version remains an unconditional restore; protected-page admission
still precedes the row lock and refuses frozen content.
The first attachment upload resolves authority inside the remote callback too;
an earlier client preflight is not dispatch authority. Notion media carries its
original owner and normalized source-ID binding through normal publication and
recovery. Generic shared-page edit permission must not replace that identity.
Icon publication always checks current page access, even with inherited perms.
Conditional E+1 recovery is read-only at Confluence, not locally: the same
kind-owned publisher used by normal completion must commit verified authored
state and exact AI/restore metadata before settling the intent. A missing or
deactivated original actor, missing metadata or conflicting history stays pending.
Normal and recovered publication invalidate the collaborative document in the
same SQL transaction and enqueue cache invalidation on that exact intent.
Flush after a proven commit; Redis failure leaves durable work for the existing
outbox worker, not a failed response for an already-committed page. Provider
lookups inside a locked transaction use its client, never a second pool lease.
SQL-only page changes use the transactional per-page cache publication queue;
hard deletion must not erase its row. Coalescing must retain the existing queue
row's lock until the new writer commits: `ON CONFLICT DO NOTHING` lets an older
delivery erase a newer, still-uncommitted privacy change. Generation-checked cache fills cannot
reinstate data invalidated while they were loading. Outbox shutdown must cancel
database checkout/lock waits as well as Redis work, with no SQL from a late lease.
Relocation's exact original state lives in its operation-owned preparation,
not the generic intent metadata; keep it through failed recovery and remove it
with settlement. Never delete a known-successful upstream creation as
compensation for a failed local phase.
Preparation persistence itself is a gated local effect. With exact unchanged
local identity/revisions and no remote-start marker, an active recovery admin
can discard a to-Confluence preparation even after the original actor loses
authority, credentials or its account. A NULL live actor link is permitted
only for that exact no-remote-start cleanup, never publication or to-local
rollback. With no local cutover, recovery leaves current ACLs untouched.
After a cutover, restore the snapshot only from the still-empty cutover ACL,
serializing the check and write with ordinary grant/revoke statements using
the ACE relation lock **before the page row lock**, matching restriction sync.
A changed ACL must refuse rather than be overwritten.
Local delete recovery uses exact tombstones and retries committed cleanup
without repeating deletion.
Persist the create identity and each upload receipt before further provider work.
Bound receipt capacity by the admitted inventory, not a fixed aggregate that can
fail after valid uploads; the generic terminal result binds a count and ordered
digest instead of duplicating the array. Pasted-image receipts are positional
accepted markers matched to the immutable plan; provider attachment versions
are metadata, never byte attestation. Compact readbacks re-resolve credentials.
The final ordinary attachment receipt and all-remote-complete marker commit
atomically; a complete receipt set must survive interruption of its wrapper.

Creation defaults off. #276 registers the readiness provider and protected
writer enforcement version `1` at application startup. Activation succeeds
only when every active registered runtime is version `1`, the activation GET
reports `deploymentReady: true` with no blockers, and the acting administrator's
Confluence integration is explicitly off. `incompatible_page_writer_runtime`,
`protected_writer_enforcement_not_registered`, and
`deployment_readiness_unavailable` all fail closed; readiness is not service
discovery, so operators must deploy and drain every HTTP, collaboration, job,
sync and maintenance writer before activation. Once creation is enabled or any
published baseline exists, migration 124 refuses a runtime on an older protocol.

New preview/freeze and future governed proposal/approval require both
`pages.source = 'standalone'` and the acting user's persisted
`confluence_enabled = false`. The exact eligibility denials are
`standalone_article_required` and `confluence_integration_enabled`. A missing
settings row is enabled and a failed read is not off. Page provenance is
authoritative: a historical `confluence_id`, space key or credentials cannot
make a Confluence-origin row eligible, and ordinary sync must not claim a
standalone row that merely carries a historical `confluence_id`.

Eligibility and activation do not weaken existing enforcement. Published
baseline bytes and history survive page/actor deletion; a frozen page remains
protected if creation is disabled or Confluence is re-enabled. Re-enabling
never thaws, removes evidence or replays a write. Authorized thaw,
history/evidence reads, and baseline attachment export/download are independent
of creation and integration mode; attachment reads still verify the retained
descriptor, containment, size and SHA-256 before streaming. Manual signatory
text is not authenticated approval. An already-frozen request returns 423,
never success for unrecorded assertions.

Collaborative Save posts a bounded base64 Yjs Snapshot containing clocks **and
the delete set**, not document content. The server obtains a freshly correlated
cross-process room snapshot, rechecks the exact active-owner set, transport
generation, lifecycle and current authority, and refuses if the Save-start
snapshot is not covered. A successful acknowledgment covers only that captured
snapshot; later local edits keep the editor open. Dirty connected and offline
drafts are navigation/unload guarded. Lifecycle/freeze/permission/document loss
disconnects the provider but keeps an inert recoverable Y.Doc with **Download
draft** and explicitly confirmed **Open current version**; thaw or reconnect
never automatically replays that blocked draft.

Page Save is single-flight per editing session. Claim the flight synchronously
before draw.io draining (the first await), and release it after success or
failure so a later intentional retry remains possible. The button, editor
callback and `Ctrl`/`Cmd`+`S` all share that flight; do not move the guard into
mutation pending state or the collaborative branch. Its state-backed pending
UI must survive discard and retained `/pages/:id` resets: while an older Save
is unresolved, read mode shows `Finishing save…` and cannot open another
editing session whose Save would be dropped. Do not turn this into a page-wide
navigation or mutation lock; existing navigation, deletion, and sibling
inspector behavior remain independent.

Subtree delete/restore/bulk cascades expand the exact authorized
standalone-owner mutation component under the hierarchy fence. A frozen root is
`423 page_is_frozen`; an authorized frozen descendant is
`409 subtree_contains_frozen_page` with only `blockedCount`. Traversal crosses
deleted, synced and foreign-owned intermediates, but rows outside the authorized
component neither block nor leak.

Publication abandons other prepared previews of that page in the same commit;
guarded cleanup releases only their unpublished bytes and capacity. A
`preparing` reservation whose intent was durably cancelled before any effect is
also reclaimable. Pending or started preparations never expire by age.
A durable governed marker still vetoes direct manual freeze when EE is
unavailable. It never prevents authorized audited thaw, including a manual
baseline frozen before that policy was enabled. #278 signing/governance and
#277's full baseline UI are not implemented in this slice.
Operations, capacity, retention and recovery:
`docs/runbooks/immutable-page-baselines.md`.

Webhook administration distinguishes an unreadable list from a successful
empty response. A failed refresh retains cached subscriptions with a stale
notice; retry uses `useNoticeRetry` so focus survives pending and recovery.
Keep the runtime feature gate and signing notice intact.
`useNoticeRetry` lives in `frontend/src/shared/hooks/use-notice-retry.ts`;
all settings and administration consumers import that one shared definition,
not the former settings-panel path.
