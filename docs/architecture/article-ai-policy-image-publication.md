# Image inference: dispatch and result publication

Restrictive policy activation remains **closed**. This change hardens an existing
consumer; it is not an enforcement-readiness declaration.

The image worker retains the early article policy/provider admission and the
selected page content revision. It passes this server-derived provenance as an
`ArticleTransportStage` to `analyzeImage`, which forwards it to the shared queued
chat-completion transport. That transport checks the actual provider configuration
and article snapshot after the queue wait. An `ArticleStageRefusedError` propagates
through the inference client and is skipped by the worker without spending an
image attempt or classifying it as a provider failure.

Inference remains outside database transactions. Success, inference failure,
unavailable attachment bytes, and skipped-intake publication use a new short
`admitArticleStage` transaction. The held client validates current article policy,
content revision, and provider configuration/locality before executing the update.
The selected image row's PostgreSQL `xmin` is also compared, so another image-row
writer at the same page revision wins over a late completion. Uniform-rejection
settlement uses the generation returned by the preceding failure update and
revalidates each article independently. No network inference occurs while these
locks are held.

## Verification and limits

- `image-result-publication.db.test.ts` exercises stale policy, content, and
  provider configuration against real PostgreSQL publication.
- `image-transport-publication.db.test.ts` uses a local HTTP provider and real
  PostgreSQL. It changes policy/content/provider state while inference is in
  flight, verifies stale success and failure cannot publish, and proves a
  pre-dispatch policy refusal sends no request.
- The existing image-worker integration and denial-publication suites remain
  passing.

- `image-worker-http-races.db.test.ts` runs the complete batch with real HTTP,
  PostgreSQL, Redis and attachment files. Policy/content/provider changes during
  inference discard success; a late HTTP failure preserves a successor row;
  uniform HTTP 400 responses cannot rewrite a successor's generation. Terminal
  counts subtract only committed reversals, not refused or stale rewrites. The
  suite supplies assignment/probe settings, not enforcement readiness, and uses
  the real queued inference transport.

The inverse invalidation sweep now re-admits retained-payload candidates and
publishes through the same held-client guard. It checks the selected content
revision and image xmin, and requires the saved payload endpoint to match the
locked provider endpoint. Reuse performs no inference. Real-PostgreSQL batch
regressions cover allowed reuse, no-AI and external/local-only denial, and an
endpoint change, including the page revision/dirty flags. This is current-state
re-admission, not a claim of complete historical payload provenance.

Migration 146 persists image job operation UUID/attempt separately from the
provider failure budget. A guarded xmin claim retains identity across batch
retries, including unassigned/resolution-failed attempts, without charging tokens
or hiding pending work. The claim's returned xmin becomes the publication fence.
Changed attachment bytes and explicit regeneration reset the operation.
The genuine EE HTTP fixture independently verifies unassigned, capability and
retained-identity refusals followed by failed and successful HTTP attempts:
one operation, five distinct decisions, actual provider/model/revision when
resolved, and report readback without image bytes or URLs. Pauses retain work
and do not spend provider failure budget. Settings-read exceptions also produce
bounded `policy_unavailable` refusals: retained-identity/token-limit failures
leave the destination unknown, whereas a vision-capability read failure retains
the already resolved provider/model and readable configuration metadata. Recovery
uses the same pending generation's operation and advances its evidence attempt.
The genuine fixture verifies these exceptions, recovery HTTP, and report readback.

Retained-payload reuse uses preliminary policy authorization followed by the
unchanged held-client publication guard. Allowed reuse emits no admitted inference
decision, since no provider request occurs; refusals remain observable. The genuine
fixture compares persisted admitted counts before/after reuse as well as report
rows and HTTP counts. This does not weaken policy, content, endpoint or xmin checks.

The full epic remains unready for restrictive activation; these producer proofs
are not a rollout certificate.
