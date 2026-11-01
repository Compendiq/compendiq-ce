# Testing and Retrieval Eval

Moved verbatim from `CLAUDE.md`. Paths are relative to the repository root.

## Testing & Mocks

Mock external Confluence/LLM boundaries where needed. Playwright CI uses real PostgreSQL and Redis, not mocked persistence or auth.

The notification bell uses the global `/notifications/count` for its badge
and mark-all action, not the current list page. Its paginated list and count
queries must both be invalidated after read mutations.

**Carve-out — the retrieval eval (#1102) runs a REAL embedding model in CI.**
The `retrieval-eval` job in `pr-check.yml` brings up Ollama as a service
container and embeds the vendored corpus with `nomic-embed-text`, because a
quality metric computed against mocked vectors measures the mock. The model
must read a whole chunk: `all-minilm`'s 256-token window silently embedded
about a sixth of each one, so `assertModelReadsFullChunk` now refuses any
model that returns the same vector for two chunk-sized texts differing only in
their final word. It is a dedicated
job, scoped to PRs that touch retrieval, so the fast path never waits on it.
The rule above still holds everywhere else — and note this model is for
detecting *regressions in retrieval logic*, never for judging a model upgrade:
those comparisons need the real candidates, run locally through the same script
(`docs/runbooks/retrieval-eval.md`), or scored on the real corpus during a
#1116 shadow migration's `ready` window via the shadow card's **Compare on
real queries** (#1260): `shadow-compare-service.ts` samples the most frequent
`search_analytics` queries, embeds each once per model (prefix per model),
retrieves top-K from `embedding` and `embedding_next` through `vectorSearch`'s
allow-listed `column` option, and reports AGREEMENT (top-1 change rate,
Jaccard, RBO) plus per-query disagreements — never presented as quality. An
unfilled candidate row must never enter the top-K: that column is nullable by
construction (the dual-write leaves it NULL when the candidate provider fails
on a page edited mid-migration), `NULL <=> $2` is NULL, and `1 - null` is 1 in
JS — a PERFECT MATCH that would inflate every figure computed from it. What
guarantees that is the `distance !== null` filter in JS, which also covers the
LIVE column between a swap and its cleanup (the swap drops the renamed
column's NOT NULL) and which `rag-service.integration.test.ts` falsifies by
dropping the HNSW index. The shadow arm's `AND embedding_next IS NOT NULL` is
a NARROWING beside it, not the guarantee: `ORDER BY` is ASC and therefore
NULLS LAST, so such a row cannot displace a scored one under the LIMIT — no
test can make that clause fail, and its comment must not claim a fetch-budget
effect it does not have. A transient failure costs its own query
(`failedQueries` on the report), never the comparisons already paid for;
only a majority of failures fails the run. Mode 2 judgements accumulate in
`embedding_compare_judgements` (101) keyed by **provider AND model on each
side** — the same name behind a different provider is a different index — and
quote a McNemar p only from 20 **live-or-candidate PICKS**, never from a total
that ties inflate (fourteen ties plus six picks published `p = 0.031` from six
clicks). Since migration 109 (#1527) **`judged_by` is the sixth key column**:
the stored page-id arrays are retrieved under the judging admin's
`ragRetrievalPagesPredicate`, so a key without the judge let one admin's click
physically overwrite another admin's evidence. One query is still ONE McNemar
trial, and that invariant now lives in the READ path: `judgementsForReport`
collapses to `DISTINCT ON (query_hash) … ORDER BY query_hash, created_at DESC,
id DESC` — the most recently judged row per query, taken WHOLE, so the verdict
carries ONE named judge's visibility scope per trial (never a blend of two),
N stays the count of DISTINCT judged queries, and every other judge's row
survives on disk for audit. `created_at` IS the judged-at stamp (the upsert
bumps it on every re-judge; there is no `judged_at` column). The unique index
is deliberately DEFAULT NULLS DISTINCT — `judged_by` is `ON DELETE SET NULL`,
and `NULLS NOT DISTINCT` would make the second judge of a query undeletable.
Runs reuse `retrieval_benchmark_runs`
(`config.kind = 'shadow-compare'`), so a comparison and the production
benchmark exclude each other — deliberately, both spend the shared LLM queue —
**and BOTH 409s are worded by the run that HOLDS the slot** (`slotBusyMessage`,
in `eval/benchmark-run-lifecycle.ts` because both routes call it and a route may
not import another route; the stale-sweep copy beside it is private to that
module's own sweep, its only writer) **while the
holder's id is withheld unless it is the caller's OWN run of the caller's own
kind** — `activeBenchmarkRun` reports `requestedBy` for that decision alone, and
both `:id` reads are scoped by kind AND by `requested_by`, so a foreign id is a
card re-attached to a run whose every poll 404s. The exclusion is
the owner decision and both cards' copy states it; telling an operator refused
by a comparison that "a production retrieval benchmark is already running" is
not part of that decision, and it named a run that does not exist on the one
surface consulted to find out what is holding the slot. Both route suites
`importActual` that module rather than hand-writing a stand-in: the previous
factories defined a `class extends Error {}` the route's `instanceof` could not
have distinguished from the real one, and a `slotBusyMessage` that did not
exist at all — so the sentence never once ran in the suite pinning its wording.
The whole row lifecycle is ONE module, `eval/benchmark-run-lifecycle.ts`:
the two private copies diverged inside a single review round, the stale sweep
failing comparisons with "start a new benchmark" and the benchmark's own
`GET /:id` serving compare runs to a renderer that dereferences
`report.baseline`. Its fetch takes the expected `kind` as a REQUIRED argument
in both directions, and a compare run is additionally scoped to
`requested_by` — the report's titles came out of that admin's ACL. `GET …/compare`
(no id) answers this admin's latest run, because the card's `runId` is
component state and a comparison outlives a tab switch — but only a run whose
config carries the candidate PAIR that is live now: run rows outlive the
migration that produced them, so an aborted migration's report was otherwise
adopted into the next migration's card, under a heading naming the new
candidate, with live judgement controls beside it. That pair check is a
PREDICATE of the query (`config @> $2::jsonb`, a bind parameter), never a
filter over its one row: applied after `ORDER BY created_at DESC LIMIT 1` it
discarded the completed comparison of the pair that is live NOW whenever any
newer run named another candidate, so an operator who tries X, tries Y and
comes back to X loses X's report and re-spends its N x 2 embedding calls. The
card's half of that is `refetchOnMount: 'always'` plus a cache seed at start;
`staleTime: Infinity` alone served the first mount's `{run: null}` back to the
second one, so the re-attachment worked only across a full reload. The judged
verdict renders **Recall and MRR beside the p and withheld with it** — both
come off the same scored picks, so quoting them under a withheld p publishes
the quality half of a verdict the server declined to state; the surface is a
labelled `region` with a real heading, because a completed run puts four
judgement controls per disagreeing query above the assignments grid, its Save
and the runtime-limits card in tab order. **The section lives inside the card's
`ready` branch, so every way a run can end is also a way the section can
vanish** — a mid-run Abort took the progress line, the section and any failure
strip away within one poll while the run failed server-side and nothing
rendered the reason, and the pair-scoped re-attachment above cannot recover it
BY DESIGN. So the two surfaces that survive the unmount speak instead: the
section reports an in-flight run UP to the card (read BEFORE the lifecycle
request, because that request's own `refresh()` is what unmounts the reporter),
the card warns that the comparison ended, and a run that fails while still
mounted is additionally toasted — a toast renders at the app root, the strip
does not. **The card's warning is keyed on the migration WINDOW, latched by
run id, and outlives the branch it was raised in.** The window, because the
server ends a run on the state row's fingerprint while `phase` is recomputed
from a live `embedding_next IS NULL` count on every poll — one page whose
shadow embed failed mid-window (a shadow failure must never fail the live
embed) flips ready → backfilling with the row untouched, and a phase-keyed
signal announced an ending to a run that was still going, still held the
one-active slot, and prescribed a remedy the compare route's own 409 refuses.
That branch keeps the id and says so, and the section re-adopts the run when
`ready` returns; `Re-run backfill` therefore passes `endsMigrationWindow:
false`, because path-blind arming would fire on exactly that button. Latched
by id, because `post()` snapshots the in-flight id BEFORE its request while
the 5s poll can raise the same ending inside that window — a real abort takes
a table lock and drops columns, so the POST losing that race is the ordinary
case, and one ending produced two identical toasts. Outliving the branch,
because a toast is gone in seconds and the fact it reports is that N × 2
embedding calls were spent for nothing: the ending is a dismissible amber
`role="status"` strip rendered by every branch of the card (the toast still
covers the one case the strip cannot — a rollback with no pending change takes
the whole card away). That branch also asks the SERVER which
comparison is live rather than reading a flag only the section can set: the
section is unmounted there, so a fresh mount (a reload, a sub-tab switch) had
watched nothing and told the admin comparing was merely "not yet possible"
over a run holding the slot, while a run that FINISHED behind the note kept
"still running" for as long as the stragglers lasted and left a stale id that
made the next swap warn about a comparison that had completed. It reads the
section's own cache key, candidate and all, so the two are one entry.
All four "could not be read" notices on the section carry the
`RetrievalTab` retry recipe (`useNoticeRetry`), because all four were gated on
`isError` alone and react-query reverts a refetch with nothing cached to
`pending`: the `role="status"` line containing the pressed button unmounted
under the admin's focus, and for the judgement notice the four picks came back
reading `aria-checked="false"` on a pair whose stored side had never been read.
So each notice is gated on `<its isError> || retryInFlight`, the busy state is
`aria-disabled` + a label swap (never native `disabled`, which blurs the focus
the flag exists to hold) and a successful retry rehomes focus to the nearest
surviving prose, guarded on `activeElement === document.body`.
The judgements read consumes `isError` like its two
siblings — a failed read of a MODEL PAIR's accumulated judgements is a
failure, not "nothing judged yet" — in THREE states, not two: unreadable
(nothing cached) hides the four picks rather than rendering
`aria-checked="false"` on rows that are already judged, while a failed
BACKGROUND refetch over loaded judgements keeps them under a muted
last-loaded line, because `isError` alone let one 500 on a 30s-stale tab-back
blank every pick of a sitting react-query was still holding — the `usePageTree`
ladder, on the workflow whose own copy is "twenty judgements across sittings".
Judging is also the one flow here that writes in a BURST, so the judgement
POST carries its own allowance (`JUDGEMENT_RATE_LIMIT_FACTOR` × the admin
knob, a multiple and never a floor, so lowering `rate_limit_admin_max` still
lowers it): the shared 20/min bucket is sized for the run-starting POSTs, the
p needs 20 PICKS with ties costing a POST each, and a 429 here DROPS the pick.
The client's `['shadow-compare-latest']` cache key carries the CANDIDATE for
the same reason the server's lookup carries a pair predicate — keyed on the
bare name, a remount after aborting migration A and readying B inside one
gcTime rendered A's report and A's live judgement radios under B's heading.
The model NAME is one dimension short of that predicate, so the key is the
MIGRATION's identity — `` `${migration.model}@${migration.startedAt}` ``,
built once in the card and passed to the section as `candidateKey`, both
halves keying the one entry. `providerId` is not on the shadow-status wire, so
the same name re-hosted behind a second provider collided on the client while
the server refused; `startedAt` is strictly FINER than the pair, which is the
safe direction — a finer key can only miss the cache and pay the round trip
the server was going to answer anyway, never serve the wrong run. And the
card's ending notice rehomes focus when its Dismiss unmounts itself (the phase
paragraph, `tabIndex={-1}`), under `useNoticeRetry`'s two guards: it was the
fourth self-removing control on this surface and the only one dropping a
keyboard admin to `<body>`.
An empty sample fails naming the window it asked for and the
control that widens it, not just the state: it is the likeliest first-run
outcome on a quiet instance and it recurs in the amber failed-run strip on
every attempt. The
polite completion announcer is MOUNTED FOR THE SECTION'S LIFE with only its
sentence conditional, the pattern `AiAssistantPage` and `DockPanel` use,
because a region inserted together with its text is the case AT is least
reliable about and this one is `sr-only`. `fetchBenchmarkRun`'s `requestedBy`
is now passed by BOTH callers: the production benchmark's `GET` was the one
that omitted it, so the module's own ACL argument was contradicted by the
caller beside the one that honoured it. **The report is keyed on STATUS, never on provenance**, and the card
watches its own poll as well as its own POST: `GET …/compare` resolves through
`latestBenchmarkRun(…, requestedBy, …)` (`WHERE requested_by = $1`), so a run
adopted on mount is always this admin's own — gating the channel on
started-in-this-session made it dead on exactly the path re-attachment exists
for, and the next Abort then ended a live comparison in silence. The
from-another-tab case needs the card's *poll*, not its POST: nothing is pressed
here, `refresh()` alone flips the branch, and the server fails the run only at
its next per-query fingerprint check — one or more polls later — so the
section's compensating toast loses that race and the card raises the same
sentence when the phase leaves `ready` with a run in flight. Amber-versus-quiet
likewise tracks WATCHED-versus-adopted rather than provenance: a comparison
showing live progress one poll earlier is news, one adopted already failed is
history. The channel is armed on the **202**, by seeding the run cache beside
the latest cache (and invalidating it, or the app client's 30s `staleTime`
holds the placeholder until the first poll tick): between the POST and the
first status GET the section otherwise rendered as idle — Run re-enabled, a
second click firing a duplicate POST the server 409s, and an Abort in that
window reporting nothing at all. The completed report carries the surface's one
POLITE announcement (`shadow-compare-complete`); every failure here already
announced, while the outcome the run exists to produce arrived in silence after
minutes. The disagreement list marks the pages only
ONE side returned, in words (`forced-colors` flattens both inks and a
colour-blind reader sees one grey), and opens at ten rows with an expander:
`limit` 100 × `topK` 20 is ~4000 lines inside a settings card, with the
migration's own Swap and Abort above the fold behind it. The four sides are one
**`radiogroup` with a roving tabindex**, not four `aria-pressed` toggles — one
mutually exclusive choice, one tab stop per row — and its arrows move FOCUS
ONLY, deliberately not APG's selection-follows-focus, because every selection
is a POST that becomes a row in the McNemar count. The chosen side keeps
`nm-pill-active` and gains a **check glyph**: measured off the tokens that
recipe's fill step is 1.07:1 (Graphite) / 1.11:1 (Paper) and even its ink step
is 2.06:1 (Graphite), all under WCAG 1.4.11's 3:1, so the only channel that is
not a contrast question is a shape — `QualityScoreBadge`'s segment-meter
argument. A 42703 while the migration
still reports active is a SCHEMA fault, not a provider one — it ends the run at
the first query instead of being counted as a skipped query and reported as
"check the provider" once the failed-share ceiling (**half** the sample; pinned
by 2-of-4 completes / 3-of-4 fails) trips. Lifecycle step 3b in
`docs/runbooks/shadow-reembed.md`.
There is no separate model-comparison harness — #1113 was closed without one.

**A run states which FTS configuration it measured, and the default is
`simple` for every language (#1114).** Hybrid retrieval has a lexical leg, and
`pages.tsv` is built by migration 049's trigger from
`admin_settings.fts_language` while `keywordSearch` re-reads the same row per
query. The eval never wrote that row, so every run — `--lang de` included —
scored its keyword leg through a language-neutral stemmer, and **every German
number published on #1114 before this is `fts=simple`**. `--fts-language` pins
it, the report carries `ftsLanguage`, and `--baseline` refuses a mismatched
pair (absent means `simple`, because that is what it was). The default is
deliberately NOT derived from `--lang`: every recorded baseline, CI's included,
was measured under `simple`, and deriving it would silently re-measure all of
them and report the difference as a retrieval change. **The rule reaches the
one surface those numbers are shown on**: Settings → AI Models' benchmark table
carries `ftsLanguage` **per language block** and renders it beside each heading
— enforcing it on the JSON report alone would move the omission one layer up
rather than fix it, and one global label became a lie the moment the two blocks
diverged. **The German re-run under `german` is done (2026-08-16) and the
stemmer bought nothing**: R@10 came back bit-identical query-for-query on both
models, the only nominally significant cell (Qwen3 R@1, p = 0.039) dies under
Bonferroni ×4, and the model gap reproduced — R@3 p = 0.0037 and R@10
p = 0.0075 clear correction under both configurations, while German R@1 fell
from `established: true` (p = 0.026 under `simple`) to `false` (p = 0.088), so
top-1 is now unestablished in both languages. So the panel's note states the
result rather than a pending flag, and the Retrieval tab's keyword-language
hint names the rebuild cost instead of promising a recall gain. `ef_search` at
`halfvec(2560)` is **measured, not settled**: effectively exact from 40,
recall@10 0.9995 at the default floor of 100 and unchanged to the 1000
ceiling — leave it alone and watch **footprint** instead (18.6 MiB of HNSW for
2,377 vectors, larger than heap and TOAST combined). That footprint figure came
from one cache-resident 2,377-chunk corpus with **build time unmeasured**, so it
does not license extrapolating to production scale — and it is a property of how
the index was BUILT (`m` / `ef_construction`), identical at every value of the
floor below, which is why the panel's copy names scan time (0.39 ms per probe at
100 against 1.74 ms at 1000) and never footprint as this control's cost.
**Since #1285 that floor
is a knob, not an environment variable**: `admin_settings.rag_ef_search`
(default 100, range 1–1000 — pgvector's own bound), read through the same
60-second cached reader as its Retrieval-panel siblings and written by
`PUT /admin/settings`, with the panel's help text quoting the measurement above
so nobody raises it hoping for recall. `efSearchFor(k)` in
`domains/llm/services/hnsw-ef-search.ts` is the ONE form all four kNN probes
call (retrieval's vector leg, the image leg, `computePageRelationships`, the
duplicate detector) — it resolves the floor and returns
`min(1000, max(floor, 2k))`, and a fifth probe needs nothing but `await
efSearchFor(rawRowCount)` interpolated into a `SET LOCAL` **inside the
transaction it already owns** (a session-level `SET` leaks into the next
borrower of that pooled connection). It sits beside Fetch width as CONTEXT and
**must never be described as a knob to raise with the width** (review r1): the
`2k` half covers every probe's own SQL LIMIT at every reachable width — both
legs cap the raw fetch at 500, so `2 × raw` stays inside the 1000 ceiling — so
the floor binds only probes narrower than half of it and a wider fetch outgrows
it rather than plateauing against it. Three docs, THREE code comments and the
panel's own placement note shipped the inverse claim, which told an operator to
buy scan time (0.39 → 1.74 ms) for nothing; the panel's visible help text was
right all along and is the wording to copy. The third comment was `vectorSearch`'s
own JSDoc — the function whose `SET LOCAL hnsw.ef_search` line this work
rewrites — still carrying both "higher ef_search = better recall" and "the floor
here is 100" a whole round after the rest was corrected (review r1). No test
reads a JSDoc, so grep the retired phrasings across `backend/src`, `docs/` and
`frontend/src` rather than trusting a green suite. `RAG_EF_SEARCH` survives as a bootstrap
fallback in `getRagEfSearch`'s row → env → 100 cascade, and it is the LEGACY-LLM-VARS
kind of deprecated rather than `FTS_LANGUAGE`'s: nothing seeds the row, so the
variable is still live wherever the server has not READ a saved value — which
is what the startup notice ("while no `rag_ef_search` row has been read") and
the panel's own muted line ("the server has not read a saved value for the
setting below") now say, both re-worded off "never saved" by #1512 because a
cold read failure reaches the same state. #1512's verification round found the
FIFTH surface that grep, not the suite, had to catch: the pin's own success
TOAST still answered the press with "RAG_EF_SEARCH is no longer read" — the
absolute the other four had dropped — and it now says the saved value "takes
over from" the variable, pinned in `RetrievalTab.test.tsx`. The same note also
names the one cost that state can carry ("if a value was saved before and this
server could not read it, saving here replaces it"), because the operator in
front of the button is not reading ADMIN-GUIDE, and the route test
`re-offers the variable to a pod that could not read the saved row` pins that
disclosed overwrite deliberately so a later edit cannot mistake it for a
regression. Three
rules that review r1 had to add and that a fifth probe or a later edit must
keep: a row read that THREW never falls through to the variable **over a value
already resolved** (an unreadable row is not an absent one, and the
fall-through silently reinstated a retired env value for a TTL) — #1512
narrowed that to what it was actually protecting: a failure now holds the last
`{value, source}` `resolveRagEfSearch` resolved, and a COLD failure — nothing
resolved AND no row written BY THIS PROCESS since boot, which is a restarted pod
or any pod that did not serve the write as much as a first-ever resolve —
reaches the bootstrap rather than the constant 100,
because the old shape retired a live `RAG_EF_SEARCH` on one statement timeout,
dropped every kNN probe on that pod to 100 for a full TTL and — since
`ragEfSearchFromEnv` is `source === 'env'` — stripped the panel's note and its
`Keep` remedy exactly while the value was wrong (`getRagContextCharsPerPage`'s
"fail toward the operator's last known setting", same direction);
`invalidateRagEfSearchCache()` stays a full forget, because it is the reset
hook ~30 tests in four files call between cases — which is precisely why the
admin PUT calls `noteRagEfSearchRowSaved(value)` instead (review r1 of #1512):
a bare forget leaves the reader unable to tell "cleared by this write" from
"nothing has ever resolved", and the panel refetches straight into that window,
so one SELECT there — blipped, or SUCCEEDING on the pre-INSERT snapshot, which
is a raced snapshot and not evidence the row is gone (review r3) — reinstated
the RETIRED variable over the row just
saved and re-offered the `Keep <old env value>` that writes it back; the
floor is resolved **before** the probe checks its
client out, never between `BEGIN` and the `SET LOCAL`, because on a cache miss
it queries the MAIN pool and a transaction asking its own pool for a second
connection stalls under saturation; and the panel's line about the variable
renders only where `ragEfSearchFromEnv` says the variable really produced the
number, carrying its own one-key `Keep <value>` write — Save is a pure value
diff, so on exactly that instance the number on screen already matches the
server's and the row the note asks for could not be written from the panel
(the #1114 `Keep`/`Record` precedent, same reason, same discipline) — reading
`saved` and never the draft in the field, like every other `Keep` on this
panel. Review r2 added the guards those three rules were missing: the ordering
one is pinned at all four probes by a source assertion in
`hnsw-ef-search.test.ts` plus an `invocationCallOrder` assertion at the vector
leg, and the `Keep` one by a test that edits the ef-search field itself before
pressing it. Review r3 closed the two holes in the first of those: it checked
each file's FIRST probe only, and read its file list off a hand-maintained
array — so a second probe added below a correct one passed green, and a probe
in a NEW file was covered by nothing at all. It now checks EVERY probe in a
file and cross-checks that array against a walk of `backend/src`, so a fifth
probe fails the suite until it is registered there (which is where its author
is told a pool this text guard cannot instrument also wants a runtime
ordering assertion). That cross-check keys on the GUC NAME, never on the
statement: keyed on `SET LOCAL hnsw.ef_search` it could not see the one
spelling that hurts most — a session-level `SET hnsw.ef_search`, invisible to
both walks and worse than the literal, since it outlives `COMMIT` — so every
code line in `backend/src` naming the GUC must now spell `SET LOCAL`, checked
per line with its own failure message. The verification round closed the hole
BETWEEN those two walks: both compare sets of file PATHS, so a second,
unresolved depth statement added inside an ALREADY-LISTED file satisfied all of
them at once — the GUC walk still matched the same file set, the `SET LOCAL`
assertion still passed, and the ordering test iterates probes, of which such a
mutant adds none (verified green on `rag-service.ts`, the file #1260 edits
against this head). So the per-callsite check now COUNTS a file's depth
statements against that file's own probe count and requires each to
interpolate (`hnsw.ef_search = ${…}`) rather than name a literal — per-LINE
rules where the walks are per-FILE. The startup notice's out-of-range branch hedges on the row too
("while no `rag_ef_search` row has been read…"): the function reads `process.env` and
cannot know the resolved floor. And the panel-wide `aria-describedby` wiring
those knobs gained reaches **`ToggleRow` too, not only `NumberRow`** — the
first cut stopped at the number rows, so inside one group a screen-reader user
heard the caveat for `Images per page` and not the one for `Image leg` above
it, and the toggles carry the sharpest caveats on the panel (`Image leg`'s
"one extra embedding call per question", MMR's measured NO-gain). Either way
**a row's `children` are prose only** — a
description flattens to one string, so an operable control or a wayfinding
link goes in the row's `aside` prop, beside the region rather than inside it
(`RetrievalTab.test.tsx` walks the region behind every `aria-describedby` on
the panel — review r3 widened it from `input`/`select` describers, which
certified the layer #1285 had just fixed and stayed silent on the one live
offender: the #1114 calibration strip's `Keep` **button**, described by a
sentence that carried the LLM-providers link. That link now sits on its own
line inside the strip. Review r2 of the verification round then seeded that
walk on the **`RAG_EF_SEARCH` note** as well: both existing cells rendered a
panel with no env note on it, so the one branch whose source comment states
this rule — the pin sits outside its row to obey it — was the one branch
nothing walked, and folding the button back into the described span passed the
whole suite). **#1285's
other value went the other way and must stay there**: `TRGM_SIMILARITY_THRESHOLD`
in `routes/knowledge/search.ts` is FIXED at 0.3 because the fuzzy-title query is
sargable only through pg_trgm's `%` operator, which compares against the
`pg_trgm.similarity_threshold` GUC — so the constant must equal the GUC's
default or the retained `similarity() > $4` stops being exact, and making it a
knob means moving the GUC too (a `SET LOCAL` per search, i.e. a checked-out
client where a pooled `query()` does now). Documented as deliberately fixed in
its JSDoc, in ADMIN-GUIDE's Retrieval section and on the panel's Keyword index
group; don't "finish the job" by making it configurable. **The proposed go/no-go, revert
criteria and measured costs for the Qwen3 cutover live in
`docs/runbooks/shadow-reembed.md`** — they are proposals until the owner agrees
them, and they must be agreed before a re-embed starts. Both eval entrypoints
now **refuse an unrecognised flag** (`assertKnownFlags`, `eval/cli-flags.ts`)
and print a usage list: `--fts-langauge german` parsed cleanly and spent an
hour embedding under the default. They also share **one flag reader**
(`flagValue`): `--out x` and `--out=x` both work, a value flag given without a
value is refused rather than defaulted, and a switch refuses a value — the
guard admitted `--baseline=prev.json` on its name half while the eval's own
`indexOf('--baseline')` could not see it, so the comparison silently never ran.
And `resetEvalCorpus` drops the
`eval_corpus_language` claim it invalidates, so a seed that dies halfway leaves
*no* claim rather than the previous run's — absent routes the benchmark to its
warning, which is the safe verdict for "unknown".

**The image corpus, fixture and `--images` arm axis (#1115 P5; ADR-027).**
`eval/corpus-de-images/` is a THIRD corpus — 65 German Wikipedia articles
carrying 187 vendored images, the first vendored content whose licence is not
MIT, so page text is CC BY-SA 4.0 and every image carries a named author and any
`requiredCredit` verbatim in `LICENSE-ATTRIBUTION.md`. Keep it out of
`CORPUS_DIRS` and `corpusDirsForLanguage`: `computeCorpusManifestSha` covers
every directory in that list, so wiring it in invalidates every recorded
baseline at once, and only `--images` reaches it (through
`loadImageCorpusManifest`). Its page bodies carry `![](images/…)` with an EMPTY
alt and no caption, and no query may restate a manifest caption — a page that
captions its own figures is answerable from text alone, so a leg measured on it
scores a win it did not earn. Each page pins a `textSha256` and each image the
upstream Commons `sha1`, because a revision id renders through the CURRENT
templates and never pinned the pictures at all. Pinned rebuilds also compare
encoded image SHA-256 digests against the committed files: source hashes do not
pin thumbnail renderers or Pillow. Encoder upgrades require the controlled
refresh in `tools/eval-corpus-images/README.md`, including image inspection and
label revalidation before updating the fixture's manifest digest.
`corpus-de-images.test.ts` fails on the wiring, a leaked caption, a licence
outside the allow-list, an unnamed or silently-cut author, a missing credit and
a body whose sha no longer matches.
`fixture-de-images.json` is its own file with its own schema and loader (never a
widened `FixtureSchema`): 309 labels over all 65 pages and 187 images, written
by blind labellers on a different model from the implementer, in two styles —
`image`, and `image-negative` distractors with EMPTY `expectedImages`, without
which a leg that always answers with a picture scores like one that answers
correctly. `fixture-de-images.test.ts` pins the sha, the counts, the per-language
negative floors and the caption rule. **The negative slice is blind end to end
(#1370, done):** six blind labels (`img-07/08/09-*`) replace the four
merger-written ones; the merger only adjudicates verbatim candidates, so a
labeller's numbering gap records a rejection. ADR-025's `--images` table used
the old 307-label, 22-negative fixture: the next run must identify its changed
negative slice beside `delta.perStyle['image-negative']` and cannot pair against
those numbers through `--baseline` (`pairedBootstrapCi` rejects differing query
sets); no image-axis report is committed.
`--images` is a CORPUS SELECTOR on the ADR-027 arm axis, not a flag on the
gate and no longer a paired leg switch: **#1618 stage 2 retired the paired
form** with `page_image_embeddings` itself (migration 118), so there is no
second leg to force per query and no in-process A/B. A bare `--images` is
REFUSED before the database is opened — it names `--arm B|C` (ADR-027 "Arms
and revisions"): B is the candidate with derived `image_analysis` chunks live,
C the same revision with `image_analysis` unassigned, and arm A (ADR-025's
legacy leg) is refused like any unknown arm, reproducible only by checking out
its recorded `revisionSha`. One run measures ONE arm into its own report
(`axis: 'images'`, default `--out retrieval-eval-images.json`) and the pairing
happens LATER across files — `assertComparableArms` for the retrieval
endpoints, `judge-arms.ts --unblind` for the answer ones — so everything the
ADR holds fixed is a field of `ArmRunReportSchema` and a refusal there, and
what one arm must carry and another must not (B's vision model and
output-token ceiling) is `armProvenanceProblems`. Seed it through the REAL
intake — bytes on disk under `attachment-store`'s own layout, the body
rewritten by `buildPageImageUrl`, then `embedPage` — because a seeder that
INSERTed rows would measure its own fixture; the analysis backfill runs off
the `image_analysis_dirty` queue the seeder raises. `--deep-search` is refused
here (expansion reformulates per request, so the arms would be paraphrased
separately). Recipe: `docs/runbooks/retrieval-eval.md` ("Arm axis").
**Measured 2026-08-18 (local shim, so plumbing-grade — ADR-025 D11)** is the
RETIRED leg's record and is never re-labelled (ADR-027 A-5): the leg never
cost a page at K ≥ 3 and was a tie at R@1 on a text-easy corpus, `imageHit@1`
was .82, and 2B ≥ 8B at a quarter of the intake cost — full tables in ADR-025
**Measured** §B.

**Query-time latency is measured OUTSIDE `eval/`**, by
`backend/scripts/benchmark-query-latency.ts` — `runner.ts`'s participation
floors assume exactly one sequential hit per query, so a concurrency flag does
not belong there. It is non-destructive (never seeds, `recordAnalytics: false`)
and refuses a search arm whose model width does not match the live
`page_embeddings` column, because `hybridSearch` degrades to keyword-only on an
embedding failure and would otherwise publish FTS latency as retrieval latency.
**It reports no configuration it has not certified**, so it runs
`assertSeededFtsLanguage` over the row it publishes as `ftsLanguage`: the eval
writes that row *before* it truncates the corpus and `resetEvalCorpus`
deliberately never clears it (migration 049's trigger reads it per inserted
row), so a seed that dies in between leaves the previous corpus standing under a
changed configuration — and the keyword leg then genuinely runs mismatched, so
the timing is wrong too and not only the label. The certification is one
recomputing `SELECT`, which is what keeps the script read-only.
**Its two halves do not take their model from the same place**, and the report
would lie by default if that were left implicit: `hybridSearch` accepts no model
and no endpoint, so `rag-service` resolves both from the DB's `embedding`
assignment while `--models`/`--base-url` describe only the direct-POST embedding
half. So a `search`/`both` arm takes exactly ONE model, is refused unless it
names what the assignment resolves to (the width probe cannot separate two
1024-dim models), and the report records the resolved pair. That endpoint
comparison is **exact**: `--base-url` is spelled as the provider row is, because
`generateEmbedding` posts `${base_url}/embeddings` verbatim — guessing a `/v1`
onto a bare host both timed a URL the product never calls and let a `/v1` arm
pass against an assignment resolving somewhere else. `--lang` selects the
question set, never the corpus — `run-retrieval-eval.ts` records the seeded
corpus in `admin_settings.eval_corpus_language` and a mismatched `--lang` is
refused, because the dead-vector-leg guard only fires at *zero* participation.
The metadata also carries `llmConcurrency` and `vectorPoolMax`: the search half
runs through the shared LLM queue (default 4) and the vector pool (default 5),
so a rung above those measures the product's serialisation, while the embedding
half bypasses the queue and really does run N wide. Since #1285 it carries
`ragEfSearch` and `ragEfSearchSource` beside them: the HNSW scan depth stopped
being a module-load `process.env` constant visible in the launching shell and
became a row in the database under test, so two identically-labelled runs can
now measure different scan depths over one corpus (0.39 ms per probe at 100
against 1.74 ms at 1000 — the very quantity this script publishes). The
provenance is reported because "100" reached by a saved row, by the deprecated
variable and by the unconfigured default are three different claims about the
instance. Reported, **not certified** like `ftsLanguage`: there is no seeded
artefact to recompute it against, and a floor the operator chose is a fact
about the instance rather than an inconsistency to refuse over. Both fields
are pinned in `eval/script-wiring.test.ts` beside `llmConcurrency` /
`vectorPoolMax`, which is that file's whole subject: deleting the pair from
the metadata literal leaves the measurement correct and the report silent
about what it measured, and lint, typecheck and every other suite stay green.

- DB tests → real Postgres, never mocked.
- Backend route tests → mock external HTTP and auth via `vi.spyOn()` passthroughs; nothing else.
- Frontend tests → mock fetch/MSW at the network boundary, not internal components.
- Pure utilities → test directly with real inputs.
- Mock at the boundary (HTTP), never at the service-function layer.

SMTP save success reconciles the submitted snapshot against the current draft;
never clear the whole form: fields edited while the request is pending,
including fields absent from its body, remain unsaved for the next request.

**Browser CI (#1543).** PR Check's `Playwright E2E` job runs on relevant PRs
(frontend, backend, contracts, E2E, build/config and workflow changes); manual
`workflow_dispatch` runs it unconditionally. `E2E_CI=1` builds on a disposable
loopback `kb_e2e` database: Playwright starts the compiled backend and Vite
preview, creates the admin through `/api/setup/admin`, and opens registration
through the admin settings API. One worker plus CI-only rate-limit settings
avoid the default 5-auth-requests/minute cap; production defaults stay intact.
The `collab` project runs last using that admin. The reporter prints executed
and skipped counts and fails on any selected skip, including all-skipped runs.
Failures retain HTML reports, screenshots and traces for seven days.

Only three external specs are excluded from this CI selection:
`confluence-sync`, `llm-providers`, and `think-toggle`; their prerequisites and
the local reproduction recipe are in
[`docs/architecture/05-deployment.md`](docs/architecture/05-deployment.md#pull-request-browser-stack-1543).
Do not turn a missing core prerequisite into `test.skip()`.
