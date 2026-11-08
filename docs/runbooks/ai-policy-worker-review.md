# Article AI policy worker review

Policy activation remains closed pending acceptance of every enforcement slice.
Passing test suites alone do not authorize activation or publication.

## No-AI purge and shadow rollback

The policy writer removes generated state on the same transaction as the policy,
canonical labels and revision. `purgeDerivedAiState` clears the live page average
and both optional runtime shadow averages (`page_avg_embedding_next` and
`page_avg_embedding_prev`). The latter must be cleared even after a swap:
otherwise rollback could restore an average for a purged article. Deleting
`page_embeddings` also removes their derived lexical entries. Authored bodies,
ordinary authored full-text indexing, original attachments and versions remain.
The real-PostgreSQL regression `ai-policy-shadow-purge.integration.test.ts`
checks all three averages and rollback of the purge transaction.

Image-analysis batches containing only policy refusals record their last-run
`policyBlocked` count, without incrementing processed or provider-failure counts.

## Recovery and shadow verification before rollout

Recovery selects eligible rows by each stage's own `policy_blocked` status,
not the shared page reason. It filters current policy and declared locality
before applying the batch limit, so forbidden rows cannot starve eligible work.
The real-PostgreSQL `ai-policy-worker-recovery.integration.test.ts` covers
embedding, summary, quality and image rows, including a cleared shared reason
and a second pass that leaves still-forbidden rows parked. Recovery is scheduling,
not permission: each transport attempt rechecks its actual destination.

Shadow readiness and swap check local-only eligibility even when candidate
vectors are already filled or absent. Swap rechecks under schema/page and provider
locks; rollback checks the provider it would restore, including inherited
assignments. `shadow-policy-coverage.integration.test.ts` covers provider locality
changes, both vector populations and rollback refusal. A refusal names the blocking
count, not article titles. Select a permitted candidate or explicitly change policy
through the authorized flow; never bypass the gate or rewrite policy with SQL.

Check blocked populations separately from successful coverage and provider errors.
The embedding status API exposes `policyBlockedPages` and `policyBlockedReasons`;
`worker-policy-status.test.ts` preserves them through the shared wire schema.
Image-only refusals must also remain visible in the last-run counters; see
`image-worker-http-races.db.test.ts`. The recovery architecture is described in
[Article-policy worker recovery and shadow coverage](../architecture/ai-policy-worker-recovery.md).

These implemented safeguards do not replace the parent rollout gate. Before
activation, run the backend, contracts, frontend and EE/overlay suites, lint and
typechecks, drain old workers/replicas, and enforce the policy-aware browser
handshake. A failed gate remains a deployment blocker, not a reason to weaken
admission or mark excluded work complete.

Each transport admission is short and does not hold a database transaction over
inference. A restriction committed after admission cannot recall bytes already
sent. Revision validation rejects late publication; it is not proof of zero
egress, verified residency or universal data-loss prevention. Declared locality
is an administrator assertion about the endpoint and upstream forwarding.
