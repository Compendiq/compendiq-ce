# Immutable Page Baselines: Operations and Recovery

This runbook covers the Community Edition foundation introduced by #275: the
canonical manifest, retained attachment copies, lifecycle evidence, activation
gate, writer-runtime fencing, and conservative reconciliation of interrupted
writes.

## Current release state

> **Baseline creation is not ready for activation in the #275 foundation.**
> Migrations 120 and 121, the immutable storage primitives, lifecycle APIs, and
> recovery APIs are present, but #276 has not yet registered complete
> collaboration, sync, purge, and subtree-writer enforcement. The readiness
> response therefore fails closed with
> `protected_writer_enforcement_not_registered`, and creation remains off.

There is no published admin UI or end-user freeze UI in this foundation.
Operators may inspect the authenticated HTTP APIs described below, but must not
turn creation on until #276 is deployed on every writer process and its
readiness provider reports no blockers.

The dependent work is deliberately separate:

- **#276** completes collaboration, sync, remote-resolution, purge, cascade, and
  cross-process writer enforcement, then supplies deployment readiness.
- **#278** adds Enterprise authenticated approval, signatures, independently
  trusted keys, archive protection, and governed evidence. None of those are a
  property of a #275 baseline.
- **#277** adds the shared CE frontend and runtime-gated Enterprise workflow.
- **#285** is a separate AI-policy project. A frozen page is not an AI-policy
  control, and this foundation does not add `no_ai` or `local_only` guarantees.

Do not describe the foundation as having all writers fenced, signed evidence,
a certification, or a released freeze control.

## Trust and retention boundary

A published CE baseline is an immutable application record. It binds exact
stored article representations and referenced media to a SHA-256 digest and
keeps independent copies of those media. It is useful for detecting accidental
or unauthorized divergence through the application. It is **not** a WORM
system, a defense against a database/filesystem administrator who can replace
both evidence and digest, or authenticated identity attestation.

`manual_assertion` provenance means exactly that. `reportedSignatories` and
`reportedReference` on the manual freeze request are caller assertions; names,
emails, and references are not independent approvals. Cryptographic signatures
and authenticated multi-party approval belong to #278 and are not available
here.

Published baselines and their freeze/thaw history have no product TTL, automatic
expiry, capacity eviction, baseline-delete API, or ordinary-retention deletion
path. Thaw makes the live page editable but does not alter or remove the old
baseline. A later freeze creates a new UUID and another retained copy. The
application-level retention promise does not protect against destruction of the
underlying database, attachment volume, encryption keys, or backups.

## Storage layout and database records

Retained bytes live below the ordinary attachment root:

```text
ATTACHMENTS_DIR/
  page-baselines/
    <baseline UUID>/
      <baseline UUID>/
        media/
          <internal media id>
```

The repeated UUID is the current exclusive preparation-attempt identity. The
media filename is an internal storage identity derived from the logical media
identity and filename; it is not the canonical attachment identity. Persisted
`retainedPath` is storage metadata and is deliberately excluded from the
canonical manifest.

Preparation creates directories with mode `0700` and files with mode `0600`,
uses exclusive creation, refuses symlinks, verifies source identity while the
file descriptor remains open, streams and hashes the copy, `fsync`s it, then
reopens and rehashes the destination. A retained copy must be a single-link
plain file and not a hard link to the mutable source. Publication does not occur
until all referenced copies pass verification.

The `page-baselines` root is reserved. The ordinary attachment orphan sweep and
page hard-delete cleanup must never traverse or remove it.

Migration 121 records:

- `page_baselines`: immutable authored fields, exact manifest bytes and digest,
  attachment inventory, preparation/publication state, actor display snapshots,
  and the live page link. States are `preparing`, `prepared`, `published`, and
  `abandoned`.
- `page_baseline_history`: append-only freeze/thaw entries with the original
  page ID, baseline ID, version, manifest digest, content and lifecycle
  revisions, reason, provenance, and immutable actor display name.
- `page_baseline_capacity`: the logical retained-byte reservation total.
- `page_baseline_feature_state`: creation activation and the activating admin
  snapshot.
- `page_lifecycle_outbox`: at-least-once delivery of lifecycle events after a
  committed transition.

Deleting a page or user nulls only designated live foreign keys. The baseline's
`original_page_id`, page identity, actor display snapshots, manifest, history,
and retained files remain. Deleting an ordinary `page_versions` row may null
`version_snapshot_id`; the baseline remains the authoritative snapshot.

Migration 120 and migration 121 commit separately. The protected-write trigger
is installed by 121 only after `baseline_id` exists; legacy updates and deletes
remain usable in the interval. Neither migration invents historical approvals.

## Canonical manifest v1

The digest is lowercase SHA-256 over this exact array encoded once with
`JSON.stringify`, then UTF-8 with no BOM and no trailing newline:

```text
[
  "compendiq.article-baseline",
  1,
  baselineId,
  pageIdentity,
  version,
  contentRevision,
  title,
  bodyHtml,
  bodyStorage,
  bodyText,
  labels,
  parentIdentity,
  icon,
  attachments
]
```

Nested values are fixed arrays, not objects:

```text
pageIdentity   = ["page", source, decimalInternalId, confluenceId|null]
parentIdentity = null | ["parent", source, decimalInternalId,
                         confluenceId|null, storedParentKey]
icon           = null | ["icon", kind|null, value|null, color|null,
                         filled|null]
attachment     = [identity, store, pageKey, filename, size, mediaType, sha256]
```

`source` is `standalone` or `confluence`; `store` is `local`, `confluence`, or
`icon`. The attachment `identity` is SHA-256 over the same canonical encoder
applied to `[store,pageKey,filename]`. Labels and attachments are sorted by the
UTF-8 bytes of the label or attachment identity. Article and icon values retain
null versus empty string and false versus null. The encoder rejects objects,
non-integer numbers, unsafe integers, cycles, and malformed/unpaired UTF-16
instead of normalizing them. HTML and Unicode are not normalized; the original
persisted strings are bound as stored.

The manifest digest binds the inventory's logical identities, sizes, media
types, and byte digests. It does not include filesystem paths and, without
#278's independent signature/trust material, does not authenticate the database
that stores it.

## Referenced-media coverage

Inspection starts from both `body_html` and `body_storage`:

- Only root-relative `/api/local-attachments/<page>/<file>` and
  `/api/attachments/<page-key>/<file>` prefixes identify internal files,
  including query or fragment suffixes. An external or protocol-relative URL
  containing such a route elsewhere remains external.
- Media URL attributes cover `audio[src]`, `embed[src]`, SVG `image[href]` and
  `image[xlink:href]`, `img[src|srcset]`, image inputs, `object[data]`,
  `source[src|srcset]`, `track[src]`, and `video[src|poster]`.
- Legacy `#confluence-attachment:<filename>` references are bound to the
  persisted source-aware page key.
- Storage-format `ri:filename` references are included even when converted HTML
  no longer exposes them.
- Draw.io captures both the rendered PNG and its `.drawio` XML sibling, from
  storage macros and rendered `.confluence-drawio` elements.
- An uploaded image icon is included from `page-icons` and must have valid,
  readable bytes.
- Empty URLs and `data:` URLs are already inline/pinned. Any other external
  media URL in a media-bearing attribute is refused as
  `baseline_media_external_unpinned`; it is never silently omitted.

Missing, unreadable, unsafe, ambiguous, or changing files refuse preparation.
A cross-page media reference is inspected only after the actor can access the
owning page. If the foreign owner is already frozen, its verified retained bytes
are used; otherwise the foreign owner joins the sorted lifecycle lock and write
intent. Capturing accessible foreign media deliberately brings those bytes into
the new page's evidence scope.

### Configured limits

All values are byte counts or object counts and must be positive safe integers.
The current defaults are:

| Environment variable | Default | Meaning |
|---|---:|---|
| `PAGE_BASELINE_MAX_ATTACHMENTS` | `512` | Maximum referenced media objects in one baseline |
| `PAGE_BASELINE_MAX_BYTES` | `1073741824` (1 GiB) | Maximum total retained media bytes in one baseline |
| `PAGE_BASELINE_MAX_RETAINED_BYTES` | `53687091200` (50 GiB) | Logical cap across published evidence and active reservations |
| `PAGE_BASELINE_MIN_FREE_BYTES` | `67108864` (64 MiB) | Filesystem free-space reserve left after an admitted copy |

These limits apply to retained media bytes. The database also stores manifest
and authored representations. Lowering a limit does not prune old evidence; it
only causes later preparation to refuse. Invalid values fail baseline operations
with a configuration/storage error.

Capacity admission serializes on the singleton capacity row. It adds the new
reservation before copy and refuses when the logical retained total would exceed
`PAGE_BASELINE_MAX_RETAINED_BYTES`. It separately checks filesystem headroom.
Outstanding `preparing` reservations are subtracted from current free space
because some or all of their bytes may not yet exist; a partly copied
preparation is therefore conservatively counted both by `statfs` and by its
reservation. Immediately before copy it again requires the full copy size plus
the free-space reserve. `ENOSPC` and quota exhaustion return
`baseline_capacity_exceeded`; existing evidence is never evicted.

Read-only diagnosis:

```sql
SELECT reserved_bytes, updated_at
FROM page_baseline_capacity
WHERE singleton = TRUE;

SELECT status, count(*) AS baselines,
       sum(reserved_bytes) AS reserved_bytes,
       sum(total_bytes) AS media_bytes
FROM page_baselines
GROUP BY status
ORDER BY status;

SELECT id, original_page_id, status, reserved_bytes, prepared_at,
       abandoned_at, preparation_intent_id
FROM page_baselines
WHERE status IN ('preparing', 'prepared', 'abandoned')
ORDER BY prepared_at, id;
```

Compare these figures with free bytes on the filesystem that actually backs
`ATTACHMENTS_DIR`; container-layer free space is irrelevant when the attachment
volume is mounted elsewhere. Do not edit the capacity row to manufacture room.
Reconcile or safely clean eligible unpublished preparations instead.

## Preparation, reuse, publication, and abandonment

`GET /api/pages/:id/freeze-preview` is not a passive calculation. When creation
is enabled and deployment readiness is true, it performs a two-phase durable
preparation:

1. Under the writer-runtime and sorted lifecycle locks, it rechecks the active
   actor, page visibility, freeze authority, current page state, pending writers,
   and cross-page media access. Inspection hashes sources but writes no retained
   bytes.
2. It atomically stores a `preparing` row, logical capacity reservation, and
   local `baseline.prepare` write intent before filesystem I/O.
3. The intent's effect gate creates the exclusive retained namespace, streams
   and verifies every copy, and persists the effect-finished marker while the
   intent remains pending.
4. Completion reacquires the original revision locks, verifies retained bytes,
   changes the row to `prepared`, and settles the intent in the same
   transaction.

The response is:

```json
{
  "baselineId": "<uuid>",
  "pageId": 123,
  "version": 7,
  "contentRevision": "42",
  "manifestVersion": 1,
  "manifestDigest": "<64 lowercase hex>",
  "attachments": [
    {
      "identity": "<64 lowercase hex>",
      "store": "local",
      "pageKey": "123",
      "filename": "diagram.drawio",
      "size": 1024,
      "mediaType": "application/xml",
      "sha256": "<64 lowercase hex>"
    }
  ],
  "totalBytes": 1024
}
```

A retry by the same actor for the same content and lifecycle revisions reuses
the exact prepared UUID and retained bytes after re-inspection and verification.
It does not mint another directory or reservation. If the active preparation no
longer matches, it is first committed as `abandoned`; cleanup then removes only
that unpublished UUID namespace after its intent is terminal/quiescent and no
live or history row references it. The row and capacity reservation are removed
only after byte cleanup succeeds.

The maintenance poll marks a `prepared` row abandoned if its preparing actor or
live page link has been deleted. It also reclaims a `preparing` reservation
whose intent was durably cancelled before either local or remote effect-start:
reservation and effect-start are separate commits, so a crashed writer can leave
this state. Both use the same guarded byte cleanup and capacity release. It is
not a TTL collector; pending, started, published, referenced or malformed
preparations are not blindly removed.
Publishing a baseline atomically abandons the page's other prepared previews,
including another actor's preview. Maintenance removes their unpublished bytes
and releases their reservations through the same guards; it never evicts the
published baseline.

Publication uses the preview's values:

```http
POST /api/pages/123/freeze
Content-Type: application/json
Authorization: Bearer <token>

{
  "reason": "Approved persisted revision for release",
  "expectedContentRevision": "42",
  "expectedManifestDigest": "<64 lowercase hex>",
  "reportedSignatories": [
    { "displayName": "Release reviewer", "email": "reviewer@example.com" }
  ],
  "reportedReference": "change-123"
}
```

`reason` is 5–1000 trimmed characters, signatories are optional and limited to
20, and the optional reference is 1–500 trimmed characters. The service finds
the actor's matching prepared UUID; it does not allocate another. Under the
final lock it rechecks actor status, visibility, role/group/ACE authority,
content and lifecycle revisions, referenced source bytes, retained copies, and
the persisted governance marker. The page link, published baseline, exact
version snapshot reconciliation, history, audit row, and lifecycle outbox row
commit atomically. A stale preview or media change refuses publication.
An already-frozen page returns `423 page_is_frozen`, including an exact retry.
Changing the caller, reason or reported signatories cannot return success for
evidence that was not recorded.

Thaw requires the current baseline and lifecycle revision:

```http
POST /api/pages/123/unfreeze
Content-Type: application/json
Authorization: Bearer <token>

{
  "reason": "Reopen the article for a corrected revision",
  "expectedBaselineId": "<uuid>",
  "expectedLifecycleRevision": "43"
}
```

The reason is 10–1000 trimmed characters. Thaw clears only the live freeze
fields and advances lifecycle revision; it appends a `thaw` history row using
the original baseline version and digest. It never deletes or rewrites evidence
and never applies a remote sync candidate.

An enabled governance policy vetoes a new direct manual freeze, not an
authorized audited thaw. Thaw remains available when EE is unavailable and
when a manual baseline predates the policy. Its historical provenance stays
`manual_assertion`; reopening never upgrades that assertion into approval.

## Activation and rollback gate

The admin activation state is available without a UI:

```http
GET /api/admin/page-baselines/activation
Authorization: Bearer <system-admin-token>
```

```json
{
  "creationEnabled": false,
  "deploymentReady": false,
  "blockers": ["protected_writer_enforcement_not_registered"],
  "activatedAt": null,
  "activatedBy": null,
  "activatedByName": null
}
```

The #275 foundation's expected response is the blocked response above. A
readiness-provider failure instead reports `deployment_readiness_unavailable`.
Do not work around either blocker in the database or send an activation request
against a test-only readiness override.

After #276 is released, activation requires all of the following:

1. Back up PostgreSQL and the complete `ATTACHMENTS_DIR` together.
2. Deploy migrations and the compatible enforcement build to every HTTP,
   collaboration, job, sync, and maintenance process.
3. Stop and drain every older process and job image. Do not activate in a
   mixed-version cluster.
4. Resolve or conservatively retain every item returned by
   `GET /api/admin/page-write-recovery`; no admission or pending intent may be
   treated as expired.
5. Confirm every live process reports the #276 readiness contract and the
   activation GET returns `deploymentReady: true` with an empty `blockers`
   array.
6. Only then enable creation:

```http
PUT /api/admin/page-baselines/activation
Content-Type: application/json
Authorization: Bearer <system-admin-token>

{ "creationEnabled": true }
```

The same route with `false` disables **new** previews/finalizations. Once any
baseline exists, never roll back to a binary that lacks lock, read, retention,
or thaw enforcement. On an incident, disable creation and forward-fix while
preserving existing evidence. Disabling creation is not a thaw and does not
unlock frozen pages.

## Authority, access, and redaction

All routes authenticate. Enterprise ACL checks compose with these CE roles when
an Enterprise hook is installed.

| Operation | Required current authority |
|---|---|
| Preview or manual freeze | Active actor, current page visibility, and system admin, space `manage`, or owner of that standalone page |
| Thaw | Active actor, current page visibility, and system admin or space `manage`; standalone owner alone is insufficient |
| Live page history | Active actor and current access to the existing, non-deleted page |
| Frozen page media | Active actor and current access to the existing page; exact original page, baseline UUID, and inventory identity must match |
| Activation, deleted-source evidence, baseline attachment download | Active system admin, rechecked from PostgreSQL |
| Writer recovery, quiescence, fencing, reconciliation | Active system admin; page ownership or space administration is not sufficient |

Media publication uses current authority on its mutation client. Inherited
Confluence icon permissions do not bypass the page-access verdict. A Notion
media batch additionally retains the original owner and normalized Notion ID in
its durable descriptor; normal publication and recovery must match that import
identity, not merely generic shared-page edit permission.

Page-level history is chronological using an opaque `(created_at,id)` cursor:

```http
GET /api/pages/123/freeze-history?limit=25&cursor=<opaque>
```

`limit` defaults to 25 and is bounded to 1–100. It returns `entries` and
`nextCursor`. An ordinary authorized page reader can see the transition reason,
actor display snapshot, provenance, reported reference, and signatory display
names. Signatory emails are always removed from history responses.

The admin evidence route may include the caller-reported signatory email because
it returns the stored manual assertion:

```http
GET /api/admin/page-baselines/<baselineId>
GET /api/admin/page-baselines/<baselineId>/history?limit=25&cursor=<opaque>
GET /api/admin/page-baselines/<baselineId>/attachments/<attachmentIdentity>
```

Admin history still redacts signatory emails. Attachment download requires
exact persisted inventory membership and verifies the retained descriptor and
digest before streaming. A UUID or hash is never authorization.

After source-page deletion, `page_id` becomes null but evidence remains. The old
`/api/pages/:id/freeze-history` and
`/api/pages/:id/baselines/:baselineId/media/:identity` URLs return not found;
they cannot be used to recover deleted-source evidence. Only the active
system-admin baseline routes above remain available. Actor deletion similarly
nulls the actor ID while retaining the immutable display snapshot.

## Diagnosing blocked writers

Every recovery route below is admin-only and rechecks that the caller is an
active system administrator.
The service repeats that check on the transaction client at fence, recovery
claim, verification, repair and settlement boundaries; a prior route check is
not sufficient. Original-writer authority is checked separately where the
intent kind requires it.

Start with a read; it never changes state:

```http
GET /api/admin/page-write-recovery
GET /api/admin/page-write-recovery?pageId=123
Authorization: Bearer <system-admin-token>
```

The response is intentionally redacted. It never exposes effect descriptors,
authored payloads, actor IDs, or internal revision maps:

```json
{
  "limitPerCollection": 500,
  "truncated": {
    "intents": false,
    "admissions": false,
    "runtimes": false
  },
  "intents": [
    {
      "id": "<intent UUID>",
      "runtimeId": "<runtime UUID>",
      "pageIds": [123],
      "kind": "baseline.prepare",
      "createdAt": "2026-09-19T12:00:00.000Z",
      "effectStartedAt": "2026-09-19T12:00:01.000Z",
      "effectFinishedAt": null,
      "remoteEffectStartedAt": null,
      "remoteEffectsCompletedAt": null,
      "recoveryStartedAt": null,
      "recoveryMode": "local_verified"
    }
  ],
  "admissions": [
    {
      "id": "<admission UUID>",
      "runtimeId": "<runtime UUID>",
      "pageId": 123,
      "lifecycleRevision": "8",
      "admittedAt": "2026-09-19T11:59:00.000Z"
    }
  ],
  "runtimes": [
    {
      "runtimeId": "<runtime UUID>",
      "deploymentIdentity": {
        "host": "backend-0",
        "pid": 1,
        "startedAt": "2026-09-19T11:00:00.000Z"
      },
      "startedAt": "2026-09-19T11:00:00.000Z",
      "quiescedAt": null,
      "acknowledgmentId": null,
      "fencedAt": null,
      "fenceReason": null
    }
  ]
}
```

Each collection is independently limited to 500; inspect `truncated` before
assuming the response is complete. `effectStartedAt` means dispatch was durably
marked before I/O; `effectFinishedAt` means the registered callback returned.
`recoveryStartedAt` means the current runtime claimed verification/recovery
before invoking a callback. None of these timestamps proves what an external
system or filesystem ultimately contains. Only the intent-kind reconciler can
establish a terminal outcome.

A writable room admission remains active until a clean disconnect and successful
flush, or a server-proven runtime fence. Redis liveness, a missing heartbeat,
elapsed time, and process age do not expire it.

## Runtime retirement and fencing

### Preferred: owning-process quiescence

Quiescence must reach the backend process that owns the displayed `runtimeId`.
A load-balanced request can hit another process and will return
`409 runtime_not_local`. Route directly to the owning pod/process (for example,
through its administrative service address or a port-forward) and send:

```http
POST /api/admin/page-write-recovery/runtime/quiesce
Content-Type: application/json
Authorization: Bearer <system-admin-token>

{
  "expectedRuntimeId": "<runtime UUID>",
  "reason": "Drain this writer before deployment replacement"
}
```

The reason is 10–1000 trimmed characters. The receiving process durably audits
the request, permanently closes its writer gate for that process lifetime,
waits for running effects, recovery callbacks and successful intent continuations
to settle, and cancels only proven pre-effect reservations. A successful staging phase is not
a drained writer: its admitted remote/activation phases may finish after the
gate closes, but no new request may start work. Cancellation and acknowledgment
hold the runtime row before lifecycle locks, including against a caller-owned
reservation transaction that has not committed yet.
The durable phase fields distinguish local staging from remote dispatch.
`remoteEffectStartedAt` is absent until a mutating provider phase is admitted;
`remoteEffectsCompletedAt` records the successful final remote phase, not merely
the most recent local stage. Subsequent file activation cannot erase that proof.

Close collaboration connections cleanly and let their flush/release finish.
An unproven final SQL settlement after a successful effect also retains local
ownership. If that continuation cannot finish, terminate the owner and use
independently verified termination; elapsed time does not make it drained.
Quiescence first authorizes and audits the request, then closes the gate.
It checks the administrator again after draining and before acknowledgment.
If that authority was revoked meanwhile, the response is 403 and no durable
acknowledgment is written; the process gate stays closed. An active system
administrator can retry to finish retirement.
Committed no-start cancellations record that administrator in `settled_by`;
the original writer remains `actor_id`.
A successful response is:

```json
{
  "runtimeId": "<runtime UUID>",
  "acknowledgmentId": "<ack UUID>",
  "deploymentIdentity": {
    "host": "backend-0",
    "pid": 1,
    "startedAt": "2026-09-19T11:00:00.000Z"
  }
}
```

Then persist the fence with the exact acknowledgment:

```http
POST /api/admin/page-write-recovery/runtimes/<runtimeId>/fence
Content-Type: application/json
Authorization: Bearer <system-admin-token>

{
  "mode": "owner_ack",
  "acknowledgmentId": "<ack UUID>",
  "reason": "Owning process drained and acknowledged this exact epoch"
}
```

The result is `{ "unresolvedIntents": <non-negative integer> }`. Remove or
restart the quiesced process before returning it to service; its writer gate is
intentionally irreversible for that process lifetime.

### Crashed process with no started effects

If the owner cannot answer and every pending intent for that epoch has both
`effectStartedAt: null` and `recoveryStartedAt: null`, request the server-verified
durable no-start fence:

```json
{
  "mode": "durable_no_started_effects",
  "reason": "Runtime is gone and durable state records no dispatched effect"
}
```

The server locks the runtime epoch, proves there is no pending started effect
or recovery marker, cancels only pre-effect intents, and releases its room
admissions. It returns `runtime_effects_started` if either kind of work started.
The reason is an audit explanation, not proof; callers cannot submit a proof object.

### Independently verified local termination

For a started effect, `verified_local_termination` is available only where the
server can verify the original process in the same supported local kernel
scope. The durable runtime identity must carry Linux or Darwin boot identity,
PID namespace, host, PID, and process-start identity. The verifying server must
be on the same host, boot, and PID namespace and must observe either `ESRCH` or
a different process-start identity for a reused PID. Missing/hardened process
metadata, `EPERM`, another host or pod, or coarse identity that cannot distinguish
a reuse fails closed with `runtime_termination_unverified`.

```json
{
  "mode": "verified_local_termination",
  "reason": "Local kernel identity proves the original process is no longer running"
}
```

This proves only that the process died. It does not prove the outcome of an
already-dispatched file or remote request. Started intents remain pending for
kind-specific reconciliation.

Never use a heartbeat, Redis TTL, pod age, operator assertion, or a fabricated
acknowledgment as a fence. There is no force-clear endpoint.

## Reconciling a fenced intent

Reconciliation requires the original runtime to have a server-proven fence.
The request carries only an operator reason; the server selects the registered
closed-kind verifier and constructs proof from fresh observations:

```http
POST /api/admin/page-write-recovery/intents/<intentId>/reconcile
Content-Type: application/json
Authorization: Bearer <system-admin-token>

{ "reason": "Reconcile exact durable state after fencing the original writer" }
```

Success is one of:

```json
{ "intentId": "<uuid>", "status": "reconciled_applied" }
```

```json
{ "intentId": "<uuid>", "status": "reconciled_not_applied" }
```

The reason is 10–1000 trimmed characters. It is not a declaration of outcome.
The server also rechecks the original page set, deletion tombstones, exact
content/lifecycle revisions, editability, and absence of a competing intent.
Unexpected state remains pending.

The receiving process must still admit new work. It joins its local drain
before the first await, then claims the same intent UUID on its active runtime
and records `recoveryStartedAt` **before any verifier callback**. It preserves
the original revisions and local/remote phase evidence. Verification, local
repair, settlement and cache publication remain owned until they finish.
Quiescence cannot acknowledge while one of those callbacks can still write.

A simultaneous attempt on the same process is refused with
`intent_recovery_running`. Once an attempt has fully failed, that same active
process may retry it. If the recovering process crashes, the displayed
`runtimeId` now identifies the owner that must be fenced before another process
can continue. A quiesced or fenced process cannot start recovery; send the
request to an active replacement.
Every accepted attempt, including a same-runtime retry, appends its actual
administrator and reason before verifier or repair work. Failed attempts retain
that attribution even when a later administrator settles the intent. The
existing 32-entry recovery-history bound applies to accepted attempts; an
exhausted history refuses before another callback runs.

### `local_verified`

A trusted verifier compares exact local bytes and metadata with the durable
intent. It may prove the intended state present, prove safe absence, or return a
partial state to a registered repairer. Both verification and repair execute
under the recovering runtime's claim described above; a new crash requires
fencing that new epoch. A remote-class intent needs the additional pre-remote
or known-terminal evidence described below before any local repair; it never
gains permission to replay a provider mutation.

For `baseline.prepare` specifically:

- A `prepared` row whose manifest bytes, attachment inventory, sizes, and every
  retained digest verify settles as applied.
- Exact retained bytes under a `preparing` row can be promoted by the trusted
  repair path and then settle as applied.
- Incomplete staged bytes cause the unpublished row to be committed
  `abandoned`; only then may its private directory be removed, the row deleted,
  and its capacity released, settling as not applied.
- An already abandoned preparation resumes the same cleanup without becoming
  publishable again.
- No row plus an absent exact UUID namespace can settle as not applied.
- Bytes without the matching durable reservation are inconsistent evidence;
  they remain pending for investigation rather than being deleted.

Repair rechecks current authority where the intent kind requires it. Do not
manually move, overwrite, or delete retained paths before reconciliation; that
can destroy the observation the verifier needs.

Local standalone, integration-off synced, and bulk hard-delete intents have
registered recovery. Exact deletion tombstones prove which rows committed;
cleanup retries attachments/icons, collaboration tombstones and durable cache
publication without repeating the delete. Partial or conflicting evidence stays
pending. Once deletion is committed, an active recovery administrator may finish
cleanup even if the original writer is no longer active.

### `remote_conditional`

Conditional recovery is read-only **at the provider**. The registered reconciler
reads the exact historical result version `E+1` and compares its canonical state
digest with the durable intended digest. An exact match publishes the verified
title, storage body, converted local bodies and version in the same transaction
that settles the intent. Ordinary completion uses that same publisher. AI Apply
updates only its originally bound improvement record; restore preserves the
pre-restore snapshot and verifies the original history target. Missing or
conflicting completion metadata, unavailable history, a deactivated original
actor, conversion failure or failed local publication leaves the intent pending.
Publication also deletes stale persisted collaborative bytes in that transaction
and queues pages/search cache invalidation on the same intent. Delivery happens
after commit and retries through the existing outbox worker; a Redis outage does
not undo the publication or report the committed change as failed.
Normal Apply and restore also persist bounded provider acknowledgment before
confirming publication. Large replies never enter generic intent metadata.
A compact reply requires exact provider readback, with current authority,
integration mode and credentials re-resolved after admission and again before
readback. A failed read leaves the acknowledgment recoverable rather than
inventing body fingerprints from the submitted request.

A different historical state at `E+1` proves not applied and changes no local
authored state. A remote version that has not reached the expected result,
missing historical version, failed provider read or ambiguous response remains
pending. A successful HTTP status observed by a caller is not proof.

The foundation's closed policy assigns this mode only to remote writes with the
required conditional-version evidence, currently AI Apply and version restore.
It does not permit replaying the write during reconciliation.

### `remote_terminal_only`

A fenced intent is not automatically an unknown remote outcome. The trusted
kind-specific recovery distinguishes three states:

- **No remote phase started.** A verifier may recover the exact local staging
  or safely remove it and settle not applied. The fenced epoch, recorded stage
  identity, current authority and observed local bytes remain required.
- **All remote phases completed successfully.** A durable server-owned terminal
  marker and the kind's bounded identity can support provider re-observation and
  the omitted local publication. This repairs a final local transaction failure
  without dispatching another provider mutation. Missing identities, changed
  authority, conflicting observations or an unsupported repair remain pending.
- **A remote phase started but its terminal outcome is unknown.** Reconciliation
  refuses with `409 intent_outcome_unrecoverable`; current values or replayed
  bytes cannot identify which side of the lost response committed after later
  remote changes.

Ordinary page updates and draft publications record a successful PUT
acknowledgment before any follow-up GET. A compact reply is therefore not
discarded when readback fails. The receipt keeps command identity/version
separate from fields actually supplied by the provider; it never invents a
returned body fingerprint from the request. Publication requires the exact
expected, non-trashed provider version and agreement with all returned
fingerprints. A failed read can be retried through recovery without replaying
PUT; a conflicting version or trashed page stays pending.
For ordinary attachment uploads, the final per-file receipt and the
all-remote-complete marker commit atomically. An interruption before the outer
callback records completion therefore cannot strand a complete receipt set.
Partial sets and ambiguous acknowledgments still remain pending.
The first upload resolves current authority and credentials inside the remote
callback, just like every later sibling. Its earlier read-only preflight client
is never reused as dispatch authority after an admission wait.

Remote phases recheck the original actor, source identity, page/space authority,
integration mode and current credentials after admission waits. Stored
credentials captured before the wait are not permission to send after the
integration is disabled or a PAT is rotated.

Relocation retains its exact original bodies, ownership/ACL state, child IDs
and attachment receipts in `page_relocation_preparations`. This is
operation-owned preparation, not a full document stuffed into generic intent
metadata. Failed recovery keeps it; terminal settlement removes it in the same
transaction. A known-successful upstream creation is not deleted to compensate
for a later local failure.
Preparation persistence is itself a gated local effect. Recovery distinguishes
an interrupted transaction that wrote no preparation from one that committed
the preparation before the next phase. With exact unchanged local identity and
revisions plus no remote-start marker, an active recovery administrator can
remove a to-Confluence preparation even after the original actor is revoked or
its connection is disabled. No authored publication is authorized by this
cleanup. A to-local rollback still needs original-writer authority and provider
verification.
The acknowledged create ID is committed before readback or uploads; each
acknowledged attachment is committed before the next provider call. The receipt
array is bounded by the admitted inventory, while the generic terminal result
binds its count and ordered digest. It does not impose a new attachment-count
limit. Compact-create readbacks resolve current mode and credentials again.
With no remaining provider mutation, a failed readback can be retried read-only
after fencing the owner; an unknown later upload still cannot be replayed.
A failure between a provider acknowledgment and that immediate receipt commit
can still leave the effect unknown. No subsequent work widens that unavoidable
durability window.

For the unknown case, keep the page blocked and preserve the intent/provider
evidence for a forward fix or provider-specific investigation. A success log,
elapsed time, process death or an operator's assertion is not the durable
terminal evidence. There is no safe force-clear.

## Cache publication and worker retirement

Page inserts, protected/lifecycle changes, visibility/ownership/inheritance
changes and hard deletes enqueue a coalesced per-page cache invalidation in the
committing SQL transaction. The queue has no page foreign key: deleting a page
must not delete the work needed to stop serving it. Intent-owned publications
also retain their terminal invalidation flag.

Coalescing retains the existing queue row's lock until the page writer commits,
without moving its original queue timestamp. `ON CONFLICT DO NOTHING` is not
equivalent: a worker could consume the older queue entry while a newer privacy
change is still uncommitted, leaving that change with no invalidation to deliver.

The outbox worker retries both sources. It clears delivery work only after real
pages/search cache invalidation succeeds; Redis failure neither loses the work
nor turns a committed page change into a failed publication. Generation-checked
cache fills cannot reinsert a snapshot whose generation was invalidated while
the query was loading. Global invalidation covers other readers; targeted
user invalidation does not evict unrelated users.

Shutdown cancels PostgreSQL pool checkout and lock waits as well as Redis
delivery. An acquired transaction is rolled back by destroying its connection;
a lease arriving after cancellation is returned without starting SQL. Pending
work remains available to the next worker. Do not clear queues manually to make
a shutdown or outage look complete.

## Backup and restore

A usable baseline backup requires **both** PostgreSQL and the complete
`ATTACHMENTS_DIR` from the same backup operation. PostgreSQL contains manifest
bytes, digests, inventory, history, actor snapshots, capacity state, and intent
recovery metadata; the attachment tree contains the exclusive retained copies.
A database-only dump loses the evidence bytes. A volume-only copy loses the
authoritative inventory and history.

The in-app encrypted backup recursively includes all of `ATTACHMENTS_DIR`, so
`page-baselines/` is included, and includes `pg_dump` from the exported database
snapshot. Prefer that path. For manual backups, stop application traffic and
writers while taking the database and volume copies; do not rely on an ordinary
attachment sweep or recreate retained files from mutable live attachments.

Restore the database and complete attachment tree together. After restore, use
the admin evidence route to obtain a published baseline and download each
inventory identity through the admin attachment route; reads verify the
persisted descriptor, exact path containment, size, and SHA-256 before streaming.
A missing or changed retained file is `baseline_storage_unavailable`, not a
reason to regenerate or silently fall back to the live attachment store.

Backups are the protection against storage loss; application permanence is not
a substitute for tested off-instance retention. #278 will add separate signing
key and trust-material backup requirements when signed governance is actually
implemented. Do not create or advertise such keys for the #275 foundation.
