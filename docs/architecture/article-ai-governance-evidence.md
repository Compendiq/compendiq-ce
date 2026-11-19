# Article AI governance evidence

## Candidate cutover

Policy admission emits the contracts `AiDecisionEvent` through
`core/enterprise/ai-policy-hooks.ts`. Policy mutation retains the held-client
`AiPolicyChangeEvent` persistence hook. The legacy policy-event observer and EE
writer are removed; there is no adapter or dual write to the legacy table.

Request/job callers supply an operation, actor, source, stage and attempt to
preflight admission. Ask retains its user operation into dispatch. Embedding
now persists a dirty-generation operation in `embedding_ai_operations` (CE
migration 147). The separate row avoids changing the page xmin retained by
transport/publication fences. Atomic attempt increments distinguish live batches,
dual-write shadow batches and later dirty-worker runs. Content/image revision
changes and a clean-to-dirty transition invalidate that identity. Unresolved live
providers emit a typed refusal with null destination and leave work retryable.
Quality, summary and image work retain their context from preflight to dispatch.
The genuine EE quota/inference fixture proves unresolved, HTTP-failed and recovered
live embedding passes share one operation with attempts 1/2/3, two outbound
requests, three persisted decisions and report readback. The PostgreSQL allocator
test proves concurrent callers share identity and allocate distinct attempts
without changing source xmin. This is not a claim about the separate shadow
backfill worker's durable identity or all job-level retries.

Successful preliminary checks do not emit admitted decisions. A preliminary
refusal still emits a typed blocked decision. Direct article composition uses
preliminary checks before and after collection; the queued HTTP boundary performs
the final emitting authorization. All validation remains active. Publication
checks remain fail-closed and do not add inference admission counts. No database
transaction is intentionally held across inference.

Direct root capture allocates its operation before reading authority. A failed
capture emits one blocked decision with only successfully resolved article IDs
and metadata; unresolved client references are not certified as article IDs.
The capture catch ends before preliminary admission, so an admission refusal
cannot be counted again as a capture failure. The genuine EE fixture exercises
a missing provider row and verifies one persisted refusal and no outbound call.

Unknown article/provider metadata is represented with nulls. Failed provider
resolution reads available article metadata without inventing provider identity.
Events carry identifiers and revision metadata, not article text, credentials or
endpoint URLs. Locality remains administrator-declared, not inferred from URLs.

## Allocation failure evidence

Embedding counter failures stop before dispatch and emit a unique blocked event
with `attempt: null` and `reason: policy_unavailable`. A failed database write
cannot establish the next durable ordinal; neither 1 nor a process-local counter
is a valid substitute. Numeric attempts remain mandatory for actual transport.
The contract permits null only for unavailable blocked decisions. The EE report
exports this ordinal as `unknown`, while counting each distinct recorded event.
An unknown ordinal is not a proven retry number or a new inferred inference call.

Explicit callers retain their supplied operation across failures. Shadow jobs
adopt persisted identity on successful allocation. If the shadow identity write
itself fails, the event identifies an allocation request, with stage
`shadow_embedding_allocation`; it cannot reconstruct an unreadable historical
job. Later counter failures retain the known operation and concrete destination.
The genuine EE fixture makes the actual PostgreSQL tables unavailable, verifies
two explicit refusals with distinct event UUIDs, no HTTP or usage increment,
report readback as unknown, and successful recovery at the first allocated
ordinal. It also proves bounded shadow initial-allocation refusal and recovery.
This is targeted persistence failure coverage, not a total database-outage
persistence guarantee: the evidence sink is itself best-effort.

Image active and paused work now share guarded attempt allocation. Summary and
quality also preserve the selected durable operation on claim errors and emit an
unavailable refusal with unknown ordinal before any transport. Real PostgreSQL
rejection-trigger tests with the genuine EE sink/report prove repeated refusals,
no HTTP/usage, unchanged work and recovery at the next committed ordinal. See
[worker publication](article-ai-summary-quality-publication.md). This does not
turn best-effort observation into a total-outage persistence guarantee.

## Verification and release limitation

The real PostgreSQL backend suite passes with the cutover. The genuine EE
first-publication HTTP fixture requires canonical decision rows, zero legacy
admitted rows, and one canonical admitted row per observed embedding request.
The final-stage database regression proves successful preliminary checks emit
nothing, while final admission and a later model-change refusal produce distinct
event IDs under the same operation.

The report already reads typed evidence separately from historical legacy rows.
`blocked_operations` and `blocked_stage_attempts` count typed decisions;
`ai_policy__blocked` counts only legacy rows. The governance regression now
asserts that distinction and exact typed readback, including unknown locality
and zero inference usage for a blocked decision. Typed CSV rows preserve the
concrete decision-time model instead of dropping it.

The genuine EE HTTP fixture also exercises descendant composition (one decision
for the final chat dispatch), an inline empty-response retry (one operation,
distinct event IDs and attempts 1 and 2), and unassigned vision refusal with a
null destination. Inline publication retains full held-client validation but
no longer emits a spurious third inference attempt. These focused scenarios do
not establish durable retry identity across process restarts.

Restrictive-policy activation remains OFF/default CLOSED. Passing compilation,
backend tests or this evidence fixture does not constitute complete requirement
coverage or authorize rollout.
