# Article route admission and regression fixtures

The summarize HTTP endpoint uses the administrator-resolved `summary` assignment.
A request body's `model` is not an override for this endpoint. Its cache key,
transport authorization, outbound model and usage audit must name the same resolved
model. This does not remove explicit model overrides from manual worker invocations
or other APIs whose contracts support them.

Article route tests must save a readable article and a provider/use-case assignment.
An owned private standalone article needs `source = 'standalone'`,
`visibility = 'private'`, and `created_by_user_id`; setting `owner_id` alone does not
establish visibility. Missing or inaccessible article identity must not be replaced
with synthetic non-article authorization.

`backend/src/routes/llm/article-route-test-fixture.ts` exercises PostgreSQL,
Redis, the authoritative resolver, admission and the real HTTP transport. Its local
HTTP peer supplies deterministic model responses. It waits for the actual stream
counter to settle after SSE ends: hijacking a response can complete an injection
before audit, persistence and finally blocks finish. Fixtures must not truncate the
database or clear audit spies while that work is outstanding.

Layout tests pass rendered Confluence HTML, not storage XHTML, through the real
converter. Cache tests populate Redis through the route and replay the same request;
the legacy malformed-cache test explicitly overwrites that saved cache entry. Image
wiring tests stage real bytes in Redis and save capability verdicts in PostgreSQL.
Protocol-only synthetic evaluation is distinct from an article-derived request.

## Remaining limitations observed during review

This migration is not an enforcement rollout approval. Restrictive-policy activation
remains closed by default. The direct transport helper still rejects every
`includeSubPages` request rather than certifying the complete source set. Inline
completion still has a separate direct HTTP path without article-stage authorization.
Neither behavior is repaired by supplying better fixtures. The full backend gate
also still reports worker-admission and stream-limit fixture failures; narrow passing
route suites must not be presented as complete backend acceptance evidence.
