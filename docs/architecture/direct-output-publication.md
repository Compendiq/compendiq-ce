# Direct-output cache publication

Direct streaming routes use `streamSSE` for output delivery and usage accounting.
A completed HTTP stream is not by itself permission to publish reusable output.
When a cache entry has server-captured provenance and an authenticated audit
actor, the helper uses `admitArticleStage`'s publication transaction to revalidate
page ACLs, policy/content revisions and provider configuration/locality, holding
the shared revision locks through the Redis SET. This prevents a restriction
committed during generation from being followed by publication of stale output.
Missing provenance is unknown, not an independent-input exemption; independent
Generate output records an explicit empty dependency set and provider binding.

Publication refusal leaves the completed inference's usage accounting intact.
It does not retract content already streamed, and does not imply that the model
was never called. Improve's durable row has its own guarded publication. Replay
still validates cache provenance against current authority, even if invalidation
fails or an old entry survives a policy transition.

The real-PostgreSQL/Redis HTTP regression in
`stream-result-publication.test.ts` commits either a page restriction or a
provider endpoint change after admission and before the provider responds. The
completed stream remains accounted for, while neither the reusable cache nor a
completed improvement row is populated. The unchanged-binding control still
publishes both.
