# Article AI policy UI (#283)

The shared CE frontend owns every control in this document; there is no EE
frontend overlay. The server is the enforcement point throughout — the UI
reflects what the server states and refuses locally only where the server
would refuse, never the other way round. No control claims protection that
has not been committed, and no copy calls a declared locality "verified".

## Inspector and header

The Details inspector mounts `ArticleAiPolicySection`. It reads the existing
page cache and exposes the selector only with explicit server capability
(`canChangeAiPolicy`), active enforcement (`aiPolicyActivation: 'active'`),
a known policy and revision, and a successful read. A save sends
`expectedRevision`; a 409 keeps the selection and requires refresh/review;
only the committed response enters the cache. The selector stays mounted
during a background refetch (Save is disabled until the fresh revision is
in) so a focused control is never removed from under the user. The No-AI
confirmation names the generated-state removals and what remains; already
admitted or sent work cannot be recalled. The article header carries the
neutral text+glyph chip for restricted policies.

Permission loss: a 401/403/404 on the page read takes the cached detail
(source, health, labels, policy) off the Details tab, shows an unavailable
notice, and evicts the cache entry when the inspector releases it. The
editor's collaborative document and drafts are untouched.

## Worker state

Every page shape carries the server's own worker state (`PageAiPolicyWorkerFieldsSchema`):
`aiPolicyBlockReason` (`pages.ai_policy_block_reason`), `aiPolicyBlockedStages`
(the stages whose status is `policy_blocked` now) and `aiPolicyRecovering`
(a reason is still recorded, nothing is blocked now, and work is queued
again). `deriveAiPolicyWorkerFields` in the contracts package is the one
derivation both the list and detail producers use. The inspector's Document
health section, the embedding badge, and the Library row's `PageStateBadge`
render policy-blocked (`tone: policy`) and recovering (`tone: recovering`)
distinctly from success, failure and ordinary pending, with the server's
reason as visible prose — never a tooltip alone, never an invented cause.

## Library

`GET /api/pages?aiPolicy=` and `GET /api/search?aiPolicy=` accept the
contract enum (`AiPolicyFilterSchema`: `all | local_only | none`). "All
articles" is the ABSENCE of the parameter and is deliberately not the `all`
policy. The backend applies an exact `pages.ai_policy` predicate on the list,
on every keyword leg (FTS, fuzzy title, facets) and on the authorized pool of
the semantic/hybrid modes; the list cache key includes the filter. The filter
narrows a set the caller may already read — it is not an access rule, and an
unfiltered lexical search still finds a readable `none` page. The frontend
carries it in the URL filter state, both query hooks' keys and requests, an
active-filter pill and clear actions.

List rows also carry `aiPolicy` / `aiPolicyRevision`, which is what the
bulk policy action (`POST /api/pages/bulk/ai-policy`) sends per selected row.
The action is all-or-nothing: a 403/409 names how many rows were involved,
never which, and keeps the selection and the draft. It refuses to send a
partial request when a selected row carries no revision (search-result rows,
an older server) and says why through `aria-describedby`.

## Labels

Label writes are not optimistic: the server normalizes synonyms, decides the
resulting policy under its authority rules and restores the canonical label
when a reserved one is removed on its own, so only the committed label set
enters the cache. The tag control suggests the canonical reserved labels,
explains that removing one alone does not relax the policy, and shows a
refused write's server verdict (`ai_policy_label_conflict`, `ai_policy_denied`,
enforcement not activated) as prose while ordinary tag edits stay.

## Assistant and editor

`runStream` holds the one fail-closed guard for page-derived assistant work:
a request that names an article is refused locally when the article's policy
is `none`, when the policy could not be read, or when the article is
`local_only` and the chat destination is not a confirmed declared-local
provider. Mouse, Enter and programmatic callers all meet it, before any bytes
leave; the server still admits each dispatch independently. A page detail
from a server that predates the policy contract (no `aiPolicyActivation`) is
not a denial. The chat destination's declared locality comes from
`GET /llm/usecase-locality` (`UsecaseLocalitySchema`), its own non-admin
route, never from the default chat row's model or provider name.

Policy refusals (`ai_history_not_replayable`, `ai_policy_unavailable`) get one
recovery whether they arrive as an HTTP refusal or as an in-band error frame
before any content: the typed prompt is restored, the thread's earlier turns
stay, the seeded turn and placeholder are withdrawn, staged attachments and
URLs stay with the draft, and New chat (history) or Retry (transient) is
offered. New chat creates an empty thread, not a redacted reuse of the old
one. Selection and block rewrites share the editor policy context and require
an article identity and authenticated authorization before dispatch; browser
rewrites recheck revisions after generation.

## Provider administration

The provider editor exposes External versus administrator-declared Local,
default External. Every endpoint edit clears the draft declaration; a
name-only save does not redeclare locality; connection probes never change
it. The list shows saved declaration actor/time when present and reports a
read failure as unknown. On a 401/403 the rows and their actions come off the
screen and any open editor closes.

## Verification boundary

Regression tests exercise the fetch/SSE boundary for policy conflicts,
capability checks, confirmation, endpoint reconfirmation, article-bound
rewrites, the bulk policy wire contract and refusals, the Library filter
predicates (route tests) and real-PostgreSQL list/detail wire fields, the
dock's fail-closed guard across mouse/keyboard/programmatic paths, and
in-band refusal recovery. The command grant supplies Vitest/build/lint/
typecheck gates, not a browser launcher: Graphite/Paper, narrow inspector,
forced-colors and real-keyboard checks remain the operator's browser
acceptance.
