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

## Outstanding rollout checks

Do not use the current shadow readiness indicator as permission to relax article
policy. The review still requires a locality eligibility gate independent of
missing candidate vectors, including rollback and provider edits. Recovery must
also stop depending on the shared page block reason: another successful stage
can clear it while a different stage remains parked. Image reconciliation must
not repeatedly re-pend still-forbidden work. Embedding blocked populations need
explicit count-contract coverage. These are activation blockers, not operational
workarounds to bypass with direct SQL policy changes.

Each transport admission is short and does not hold a database transaction over
inference. A restriction committed after admission cannot recall bytes already
sent. Revision validation rejects late publication; it is not proof of zero
egress, verified residency or universal data-loss prevention. Declared locality
is an administrator assertion about the endpoint and upstream forwarding.
