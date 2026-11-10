# Pages and Confluence

Moved verbatim from `CLAUDE.md`. Paths are relative to the repository root.

## Article Connections (#1314)

Connections belongs below the read-mode article, not on another canvas. Keep
explicit links, hierarchy, and ranked recommendations in separate groups.
`page_relationships` is the evidence, not an invitation to invent an AI reason:
canonical pair order does not establish link direction or parenthood, and a
label-overlap score does not identify the shared labels. Check actual content
and hierarchy evidence; apply source and target visibility before ranking.
Missing embeddings must not gate deterministic connections: database-tracked
page mutations feed the shared deterministic materializer, independently of
semantic embedding work. Do not introduce another read-side relationship engine.
Use the canonical parent key, never a synced parent's unrelated internal ID;
ambiguous keys do not justify asserting multiple parents. Keep loading, empty,
failed, and stale data distinct. Access denial discards cached titles across
later failures and panel remounts until a successful authorized result replaces
them.
`/graph?focus=<pageId>` remains the existing two-hop exploration path; do not
remove Graph from navigation before the post-release four-week decision gate.
Panel usage goes through the authenticated collection path, without content in
event metadata. Impression semantics and adoption evaluation are documented in
`docs/ADMIN-GUIDE.md`.

Graph shareable filters (`space`, `edgeTypes`, `minScore`, `labels`, `full`)
are read directly from the current URL, including on Back/Forward while
`GraphPage` remains mounted. Filter changes replace the entry; the sidebar
clear-focus and picker selection push entries. Keep unrelated URL parameters
when editing filters, and keep the local graph request keyed on restored filters.

## Standalone Trash Cascade (#1636)

Trashing a standalone article takes its WHOLE subtree, so the delete, the
restore and the number the confirm dialog shows must all come from one
definition: `backend/src/core/services/page-subtree.ts`. Both delete paths
(soft and `?permanent=true`), the bulk delete, `descendantCount` on
`GET /api/pages/:id` and the restore batch read that walk, and re-implementing
any of them in a route is how the two disagree.

Five things in it look simplifiable and are not. (1) The recursive arm has NO
`deleted_at` filter: a walk that stops at a trashed intermediate leaves its LIVE
grandchildren behind, orphaned at the tree root — the #1636 bug, one level down —
while `deleted_at IS NULL` on the UPDATE's IN-subquery still lets an
already-trashed descendant keep its ORIGINAL stamp. (2) `UNION`, never
`UNION ALL`: `parent_id` is unconstrained TEXT, so a cycle is only prevented
from hanging the request by the deduplication. (3) The join key is
SOURCE-AWARE — `confluence_id` for a Confluence-sourced row, `id::text`
otherwise, i.e. exactly `parentKeyFor`'s rule restated in SQL because `core`
may not import a domain. It is deliberately not `COALESCE(confluence_id,
id::text)`: the two differ for a standalone row carrying a `confluence_id`, and
there the COALESCE form reads a key no writer ever stores. The id arm is TEXT so
a Confluence content id above 2^31 cannot overflow the cast (#1167). (4) The
cascade is ONE data-modifying statement — walk and write in the same
statement — because `NOW()` is transaction time and the rows it touches then
share one `deleted_at`; that equality IS the restore batch key
(`trashBatchIds`), so splitting the cascade into SELECT-then-UPDATE silently
breaks restore, and it is also what closes the window in which a child
committed by a concurrent `POST /pages` is walked but not written. (5) An
AMBIGUOUS key is refused, never resolved: `parent_id` is read against either
identifier, Confluence DC ids are numeric strings and `pages.id` is a serial
growing into that space, so one key can name two pages. `findSubtreeKeyAmbiguity`
detects it and the delete, bulk delete and restore all answer 409
`subtree_identifier_ambiguous` — the rule `assertIdentifierUnambiguous` already
enforces for `/move` and `/relocate` (#1166) and `resolveBulkSelection` for the
bulk routes (#1167). Picking a winner is not available: the stored key stays
ambiguous, so one reader follows one candidate and the next reader the other.

**A cascade may only touch rows its caller may act on.** Both cascades, the
bulk cascade and `descendantCount` all carry TWO guards: `source =
'standalone'` and `created_by_user_id`. The ownership guard is not defensive
tidiness — `POST /api/pages` validates a `parentId` for existence and space but
never for ownership, so another user's article legitimately sits inside this
subtree. Trashing it would drop it into a trash its owner cannot restore from
(the parent they would have to restore first is not theirs) until the 30-day
purge destroyed it, and `?permanent=true` would destroy it and its attachments
outright, on a request that checked authority for the root alone. Accept the
residual instead: a row either guard skips stays LIVE with `parent_id` pointing
at a trashed parent, so the tree renders it at the root. That is #1636's own
orphan, deliberately preferred over acting without authority, and the dialog
warns about none of it because the count carries the same guards.

Consequences worth remembering. `hasChildren` on `GET /api/pages/:id` uses the
tree's dual-identifier join (the old form matched `parent_id = confluence_id`
only, so every standalone parent answered `false`), which also means the field
now reads `true` for standalone pages whose children the UI previously could not
see. It answers the TREE's question; `descendantCount` answers the DELETE's —
the caller's own live standalone descendants — so `true` with a count of 0 is a
real answer. Neither counts another user's PRIVATE sub-article: the detail route
serves any reader of a shared page, and counting rows the tree hides
(`visiblePagesPredicate`) both disclosed their existence and offered an expander
that yields nothing.

**Hierarchy metadata follows shared list visibility, not the space container.**
A local space is discoverable to every authenticated user, but its private
standalone pages are not. `GET /spaces/:key/tree`, `/pages/tree`, `/pages`,
page detail, breadcrumbs, recursive children, graphs, pins, filter facets and
page-derived space summaries use the existing caller-bound list definition:
Confluence pages in assigned spaces, shared standalone pages, and the caller's
own private standalone pages. System administrators retain that same list
behavior; hierarchy reads do not introduce an admin bypass. The focused graph
(`/pages/:id/graph/local`) resolves its center, vertex set and traversal through
`authorizedPageIds`, which is this same predicate, so an ACE-denied parent there
is a hidden parent. When a visible child has an invisible direct
parent, present the child as a root (`parentId: null`) and rebase every
descendant's local-tree depth from that visible root; breadcrumbs keep only the
contiguous visible suffix and children traversal stops at the hidden node.
Full, clustered, and focused graphs apply the same hidden-parent projection.
The focused graph resolves its center in one caller-visible query and returns
the same caller-keyed empty payload for missing, ambiguous, or inaccessible
input, so identifier normalization cannot become an existence oracle. It also
derives hierarchy traversal and `parent_child` output edges from caller-visible
parent candidates; inaccessible identifier collisions cannot alter the
response. Mixed-source parent/child links are valid, but a stored key that
identifies multiple applicable parent candidates fails closed. `/has-children`
and `/children` answer a canonical-key collision with a row the caller cannot
read exactly like detail's `hasChildren` (`false` / no children, status 200);
409 `Page identifier is ambiguous` is reserved for collisions among readable
rows, so the status is never a hidden-row oracle. Never retain a
hidden or ambiguous parent ID or original depth as a hierarchy oracle.
Hierarchy trees
and lists are per-user, generation-checked entries in the `pages` cache
namespace. Visibility/hierarchy writers and every RBAC invalidation advance
that generation, fencing in-flight fills across role and group changes. A fill
MUST capture its generation (`getWithGeneration`) before reading any input it
depends on (`getUserAccessibleSpaces`, space source), then run the access gate
before serving a cached body (#817); capturing it after the RBAC read lets a
pre-revocation fill publish under the post-revocation generation. The
exception is an RBAC input that is itself part of the cache key, as in
`/pages/filters` (`filters:v3:<sorted spaces>`): a request with the fresh list
misses the stale entry, so reading the spaces first is safe there.
`GET /pages?visibility=private|shared` narrows that caller-visible set by
the row's visibility, including Confluence rows. The list, count and ILIKE
fallback share the predicate; the cache identity includes visibility and is
versioned when its shape changes. Filter-mode bulk selection uses the same
visibility test. This is a filter, not a replacement for the access predicate.

Local-space and shared space lists remain uncached because their mutable space
metadata and caller-visible page count/home page belong to independent
invalidation domains.

**Page restrictions apply to every non-RAG read; RAG keeps its own gate.**
`visiblePagesPredicate` is that list definition PLUS `userCanAccessPage`'s
restriction arm: a Confluence page with `inherit_perms = FALSE` also needs a
page ACE for the caller (user principal, or a group they belong to), in both
editions. Admins are exempt from that arm only — their listings keep
restricted pages and still hide other users' private standalone pages. Every
surface that returns page rows, titles, snippets, labels, counts, hierarchy or
bodies to a user goes through it (or `authorizedPageIds` for id gates):
lists, trees, children, breadcrumbs, search rows and facets (semantic/hybrid
rows too: a pool of `max(rag_fetch_width, 2 × limit)` pages is authorized BEFORE
the `limit` slice, so results fall short only when more than `pool − limit`
unreadable pages rank in it or fewer than `limit` readable pages match, and the analytics row counts the returned set),
graphs, space summaries, pins, embedding
status, sub-page LLM
context, duplicates, verification, versions, exports, attachments, bulk
selection, drafts, presence, watch and LLM conversation/page
references. A restricted page answers
exactly like a missing one, and a hidden restricted parent re-roots its
children like a hidden private parent. Never use it inside RAG retrieval:
retrieval SQL (both legs, lexical chunk resolution, the identifier pin and its
excerpt, the coverage denominator; shadow compare and the production
benchmark through them) uses `ragRetrievalPagesPredicate`, which is
space-level by design (ADR-022/ADR-023) and gated per page only by the EE
`rag_permission_enforcement` post-filter. ACE rows and group memberships
behind page ACEs are fenced in the database (migration 129 queues the pages;
the page publication worker bumps the `pages` generation), so sync, relocate
and the EE bulk route need no cache code of their own.

Sub-page LLM context uses the parent's source at the initial lookup and every
recursive step: Confluence ID for a Confluence page, internal ID as text for
a standalone page, even if that standalone row retains a historical
Confluence ID. Do not add that historical ID as an alternate traversal key.
The caller's visibility filter and the existing breadth, depth and character
limits still apply.

Per-page duplicate lookup uses source-aware identity: a standalone page's
internal ID, or a Confluence page's content ID, never a historical standalone
Confluence ID. Resolve the source within `visiblePagesPredicate`, just like
the full scan and candidate set. Missing, inaccessible, deleted, and
caller-visible ambiguous identities return the same empty result; an
inaccessible collision must not alter the answer.

A restore is refused with 409 `Restore "<title>" first` when the page's DIRECT
parent is still in the trash AND is one the caller can actually restore — their
own standalone row. Both halves matter. Direct, because the invariant is a
statement about `parent_id` alone: a live parent means the page reappears
beneath it and orphans nothing, whatever is trashed further up, so refusing on
the nearest trashed ancestor at any depth refused safe restores. Actionable,
because nothing else is restorable through this route — a Confluence-sourced row
is rejected outright and another user's row is not the caller's — so refusing
there traded a visible orphan for silent data loss at the retention deadline.
Because the refusal only ever names a page the caller owns, it needs no
readability gate to decide whether it may print the title. It stays idempotent
for an already-live page, because a bulk restore fires one request per selected
row and a cascade batch spans several of them. The 409 carries
`reason: 'restore_ancestor_trashed'`, which is what `TrashPage` retries; the
route's other refusals (a live import already exists, an ambiguous parent) are
permanent, so the status code alone cannot be the classifier.

Cache scope is read off the ROWS the cascade touched, never off the target:
`visibility` is per page, so a private parent can hold a shared sub-article, and
keying `invalidateAcrossUsers` on the target alone left every other user holding
a stale tree (#893). Per-id side effects run through `Promise.allSettled` for
the same class of reason: they fire after the cascade has COMMITTED, so one
failing collab tombstone must not skip the remaining ids' webhooks, the cache
invalidation and the audit row.

The frontend delete hook does not remove anything before the DELETE succeeds.
After success it adjusts only paginated Library caches that actually contain
the confirmed target; an absent row gives no evidence that the page belongs to
that filter or page, so its total stays unchanged. Settlement invalidates the
whole `['pages']` prefix (lists, tree, pins and details), and success also
invalidates `['trash']`. Keep rollback snapshots out of this flow: overlapping
deletes can otherwise restore a different deletion that already committed.

The dialog copy for all THREE destructive surfaces — the article view, the
article inspector and the multi-select bulk bar — lives in
`frontend/src/shared/lib/trash-copy.ts`. The count comes from the server, never
from `usePageTree()` (space/visibility filtered, possibly mid-load, and it
cannot know what the delete will do). A Confluence-sourced page gets its own
copy: that delete propagates upstream and the page never reaches Trash, so it
must not be offered a 30-day restore — and it must not be promised a cascade
either, since that branch removes exactly one row.

The `source = 'standalone'` guard is not decoration, and it is NOT redundant
with "a standalone subtree cannot contain a Confluence-sourced row": that
invariant is false in practice, reachable both through `POST /api/pages` with a
Confluence-sourced body under a standalone parent and through `PUT
/pages/:id/move` re-parenting a synced page (neither looks at the parent's
source). Both the integration suite
(`pages-crud-cascade-trash.integration.test.ts`, the "stated limitation" case)
and the PR body record the residual orphan it leaves.

## Confluence Integration Toggle (#1623)

**Confluence off is STANDALONE MODE, not a degraded product.** The owner's
ruling, verbatim: *"When confluence is off the app should be in standalone
mode, all features should work just with no sync to confluence."*
`user_settings.confluence_enabled` (migration 119, `BOOLEAN NOT NULL DEFAULT
TRUE`, so every pre-existing row keeps behaving exactly as it did) carries it
per user. Everything keeps working on the local corpus; nothing is pushed to or
pulled from Confluence. Six rules fall out, and none of them is negotiable.

1. **A previously synced page stays fully usable while the integration is
   off** — editable, movable, deletable, AI-usable. The write lands locally and
   is NEVER pushed upstream; the row keeps its `confluence_id` and its history.
2. **`Confluence not configured` is not an answer to a standalone user.** That
   string stays reserved for a Confluence-ENABLED user whose credentials are
   missing or broken. A flag-off user gets local success, not an error.
3. **Credentials are retained across a toggle.** Turning it off clears neither
   `confluence_url` nor `confluence_pat`, so re-enabling needs no re-paste and
   the masked PAT placeholder is still there afterwards.
4. **No surface may prompt for a URL or a PAT while the flag is off** — not the
   PAT banner, not the Getting Started checklist, not the Library empty state,
   not the version-history strip, not the spaces panel. Copy that mentions
   Confluence at all in that state describes the mode; it does not solicit
   setup.
5. **Scheduled and manual sync do not run**, and the spaces/sync surfaces
   **hide** (never merely disable) `Fetch Spaces`, `Sync Selected` and the sync
   overview, while keeping the saved space selection listed and editable — a
   toggle must not look like it destroyed configuration.
6. **One truth source, and it is read as `=== false`.**
   `isConfluenceEnabled(userId, dbClient?, lockSettings?)` in
   `core/services/confluence-integration.ts` is the only backend reader of the
   column (`true` when no row exists); every other consumer imports it rather
   than re-querying. `lockSettings=true` requires a read-write transaction
   client and is only for mutation admission that must hold an existing
   settings row through commit; read-only capability checks never request the
   lock. `getClientForUser` returns `null` when the flag is off — but it **also**
   returns `null` for enabled-but-unconfigured, so a caller that must keep
   working locally may not infer the mode from a null client; it has to ask
   `isConfluenceEnabled`. On the frontend the flag comes
   only from the `['settings']` query via `useSettings()`, and every read is
   `settings.confluenceEnabled === false`, never a falsy test: a payload from a
   backend that predates the field legitimately omits the key, and falsy would
   read *unknown* as *off* — the one misreading that silently makes a connected
   user's workspace standalone.

The settings mode switch awaits the parent's `mutateAsync` callback (#1808),
then awaits the authoritative settings read (`refetch` with `cancelRefetch:
false` joins the mutation's invalidation; `throwOnError: true` exposes failure).
The settings query alone drives the switch, mode copy and credential form;
neither a late successful PUT acknowledgment nor a failure may replace a newer
confirmed read. Keep the switch blocked through confirmation without removing
keyboard focus. A failed confirmation is not a failed write: keep the switch
blocked and offer a read-only retry, returning focus to the switch only if the
successful retry still owns focus. Credential saves retain drafts on error.

**A local write succeeds; only a Confluence-ONLY operation refuses.** With the
flag off a synced page takes the same write path a standalone page takes — the
editor/collab save, `PUT /pages/:id` and the AI-improve apply write the local
row, bump the local version and stamp `local_modified_at`, making **zero**
Confluence calls; `DELETE /pages/:id` removes the local row and leaves the
upstream page alone (trash is standalone-only, so a soft delete there would be
unrestorable). What refuses is the set of operations that have no local
meaning — creating a page *in* a Confluence space, `POST /pages/bulk/sync`,
`POST /embeddings/force-embed-tree` and `POST /pages/:id/relocate` (both
directions: it is defined as create-upstream / delete-upstream) — all with
`Confluence integration is disabled`, never `Confluence not configured`.
`POST /api/sync` answers **200** with that same sentence (no status flicker, no
`SYNC_STARTED` audit row, no worker-lock claim), `GET /api/spaces/available` answers **409**, and a
`selectedSpaces` write arriving while the integration is off answers **422**;
the **400 `Confluence not configured`** is now reachable only by an enabled user
whose credentials are missing or broken. Re-enabling needs no new reconciliation
model: the divergence a standalone stretch produced is handled by the existing
conflict path on the next sync (the `local_modified_at` marker, and a
locally-deleted page re-imported by the sync upsert).

**The mode changes where a write lands, never who may make it.** The toggle
belongs to the caller, so it must not relax page authority. Every local write
to a synced page must enforce at least the `PUT /pages/:id` rule,
`userCanAccessPage` AND `userCanEditPage` (a role on the page's space and, on
an `inherit_perms = false` page, an ACE as well). It must check that rule
before any content-dependent answer and again with the transaction client
under the page fence. AI-improve apply, version restore and the local branch
of `applyLabelChanges` (`PUT /pages/:id/labels`, `POST /pages/:id/apply-tags`)
call the two predicates directly. Collab commit uses
`assertCurrentCollabMutationAuthority`. Draft publish, delete and the bulk paths
use `loadAuthorizedContentWriteState`. A new local-write branch must not rely
on the Confluence branch's admission callback for authority, because that
callback never runs when the write stays local. AI-improve apply and the label
routes answer a denied page with the same 404 as a missing one.

**A skip that is a choice reports differently from a skip that is a gap.**
`VersionBackfillStatusSchema` gained `skipped_confluence_off` beside #763's
`skipped_no_credentials` for exactly that reason: the lazy on-open version
import is not attempted at all in standalone mode, and the panel says so ("the
list below is this page's local history") instead of earning the credential
prompt the older status carries.

**It is a MODE — not a credential state, and not `pages.source`.**
`confluenceConnected` still answers only "do stored credentials exist": a user
can be connected and disabled, or disabled and connected, and the response
schema reports both independently. And `source = 'standalone'` classifies one
row's *origin* (the cascade section above); `confluence_enabled` is a per-user
integration *mode* and says nothing about any page's provenance. The collision
of words is unfortunate and the two must not be collapsed.

**Setup probes certify an exact persisted URL/PAT pair (#1807).** Every edit,
new probe and departure invalidates earlier completions, including failures
and toasts. Check ownership after both persistence and probing; Continue and
space discovery use only current-pair success. Order setup settings writes
across revisits and standalone choices, and discard the previous pair's
available-spaces cache before revealing a newly verified picker. Keep PATs
out of query keys and persistent browser storage.

## Library Search

Search provenance comes from `pages.source`, never a space key, historical
Confluence ID, or embedding metadata. Keep it consistent across retrieval
modes and use it for source-sensitive bulk actions. Enter/ArrowDown may focus
only current-query results; removal of a focused result from the result set
returns focus to the query without stealing focus from another control.
Virtualization eviction is not result removal and must not move focus or scroll.
Each filter has one visible Tab stop. Search controls adapt to pane width,
not viewport width alone.
