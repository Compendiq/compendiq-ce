# Runbook — retrieval quality eval (#1102)

Answers one question: **did this change make retrieval better or worse?**

Before this existed, tests covered plumbing (RRF arithmetic, ACL, keyword
fallback) but nothing measured quality, so every retrieval change was argued
rather than measured.

## What it measures, and what it does not

- **Does** detect regressions in retrieval *logic* — the same corpus, the same
  embedding model, and ideally the same machine before and after a change.
  The bootstrap and the sign test both condition on this pair of runs: neither
  models run-to-run variance in retrieval itself. HNSW is an approximate index
  and its graph differs between builds, which is enough to move a query or two
  — a local run and a CI run of identical code differed by one query at K=3.
  So **measure both sides in the same environment**; pairing a CI artifact
  against a laptop run mixes that noise into the deltas the test reads.
- **Does not** judge an embedding-model upgrade. The CI model is small and fast
  on purpose, and `--baseline` refuses a cross-model comparison for that reason.
  There is no separate model-comparison harness and none is planned (#1113 was
  closed without one). Compare models either **here, locally** — run this script
  twice with `EVAL_EMBEDDING_MODEL` set to each real candidate and read the two
  reports side by side, never through `--baseline` — or, for the question that
  actually decides a swap, on **your own corpus** via #1260. This corpus is
  vendored OSS docs; a model that wins on it has not been shown to win on your
  pages.
- **Does not** claim your knowledge base scores this well. The corpus is
  vendored MIT documentation (Fastify, Vitest, Vite), not your pages.

## Running a comparison on production data

The dev-article fixture must not be used as a production score: its expected
page labels point at the vendored corpus. For an operational check, use
**Settings → AI Models → Retrieval → Production benchmark**. The panel takes
the most recent distinct questions from `search_analytics` and runs each one
through the current production pages and embeddings twice:

1. ordinary retrieval, matching the chat path;
2. deep search, with the per-question expansion enabled.

The run is asynchronous and can be polled from the panel. It is read-only
with respect to knowledge content, embeddings and retrieval settings, and it
does not write replayed questions back to `search_analytics`. It reports p50
and p95 latency, empty-result counts, result-set overlap, top-1 movement and
whether expansion actually ran. Production questions have no ground truth by
default, so the report intentionally leaves Recall/MRR blank rather than
inventing labels from the dev fixture.

The same API accepts an explicitly labelled custom suite when a team has
ground truth for its own pages:

```bash
curl -X POST https://compendiq.example/api/admin/retrieval-benchmark \
  -H 'Authorization: Bearer <admin-token>' \
  -H 'Content-Type: application/json' \
  -d '{
    "source": "custom",
    "topK": 5,
    "queries": [
      {"id": "retention", "query": "where is retention configured?", "expectedPageIds": [42]}
    ]
  }'

curl https://compendiq.example/api/admin/retrieval-benchmark/<run-id> \
  -H 'Authorization: Bearer <admin-token>'
```

Custom labels are the only basis for Recall/MRR. The endpoint is admin-only,
allows one queued/running comparison at a time, and stores the query text plus
compact page ids/titles and timings—not retrieved chunk text. Runs heartbeat
while they progress; if a worker disappears, the next start request marks a
stale run failed so it cannot block future benchmarks.

## Running it

```bash
# The script REFUSES any database whose name does not look disposable — it
# truncates pages, page_embeddings, page_relationships and search_analytics and
# retypes the vector columns. Name it *eval* or *test*, or set
# EVAL_ALLOW_DESTRUCTIVE=yes-wipe-this-database if you mean it.
# Plus an embedding endpoint:
docker run -d -p 11434:11434 ollama/ollama
curl -X POST localhost:11434/api/pull -d '{"name":"nomic-embed-text"}'

cd backend
export POSTGRES_URL=postgresql://kb_user:pw@localhost:5433/kb_eval
export EVAL_EMBEDDING_BASE_URL=http://localhost:11434/v1
export EVAL_EMBEDDING_MODEL=nomic-embed-text

# 1. measure the baseline — on the branch point, BEFORE your change
npx tsx scripts/run-retrieval-eval.ts --out /tmp/baseline.json

# 2. apply your retrieval change, then measure again and compare
npx tsx scripts/run-retrieval-eval.ts --out /tmp/candidate.json --baseline /tmp/baseline.json
```

CI runs the same script in the `retrieval-eval` job on any PR touching
`rag-service`, `embedding-service`, `llm-provider-resolver` or `eval/`, and
uploads its report as an artifact. Use that artifact to *read* a run, not as a
`--baseline` for a local candidate — see the environment caveat above.

**To compare your change against `dev`, measure both sides yourself, in one
place:** check out the merge base, run with `--out /tmp/baseline.json`, check
out your branch, and run again with `--baseline /tmp/baseline.json`. Same
machine, same Ollama, same index build — which is the only way the paired test
is reading your change rather than the environment.

Re-running against the same database is safe: the script clears the previous
corpus before seeding. It has to — without that, a second run leaves two
identical copies of every page, retrieval splits between the twins, and recall
roughly halves, which the comparison reports as a credible regression caused
by whatever you were testing. That is not hypothetical; it is how the bug was
found. Clearing the corpus also drops the recorded corpus language, so a run
that dies mid-seed leaves *no* claim rather than the previous run's — the
latency benchmark then warns ("seeded before this was recorded") instead of
accepting an English arm over a half-written German corpus.

`--help` prints every flag with its default, and an unrecognised flag is
**refused** rather than ignored: `--fts-langauge german` used to parse cleanly
and spend an hour embedding under the default configuration.

Both spellings work for every value flag — `--out report.json` and
`--out=report.json` — and both scripts read them through the same function.
They did not always: the unknown-flag guard checked the name half of
`--out=…`, while the eval read its values by looking for the exact token
`--out`, so `--baseline=prev.json` was admitted and then dropped, and the run
printed absolute numbers with no comparison at all. The switches
(`--rerank`, `--deep-search`, `--no-assemble`, `--no-pin`, `--mmr`) carry **no**
value and refuse one, because they are read as bare flags: `--rerank=true`
would otherwise have measured plain retrieval under a report saying reranked. A
value flag given without a value is refused too, rather than falling back to a
default nobody typed.

## Which FTS configuration a run measured (#1114)

Retrieval has two legs, and `--fts-language` names the lexical one: the
PostgreSQL text-search configuration that both builds `pages.tsv` at seed time
(migration 049's `BEFORE INSERT` trigger reads `admin_settings.fts_language`
per row) and parses the query at search time (`getFtsLanguage()` in
`keywordSearch`).

```bash
npx tsx scripts/run-retrieval-eval.ts --lang de --fts-language german --out /tmp/de-german.json
```

**The default is `simple` for every language, and is deliberately NOT derived
from `--lang`.** Every baseline ever recorded — CI's included — was measured
under `simple`, and deriving the configuration from the corpus language would
silently re-measure all of them and report the difference as a retrieval
change. Choosing `german` is an explicit act.

**Every German number published on #1114 before the 2026-08-16 re-run — the
*German result* comment of that morning included — was `fts=simple`.**
Nothing in the eval ever wrote `admin_settings.fts_language`, so the row sat at
migration 049's seeded `simple` for every run, and a `--lang de` run scored a
German corpus through a language-neutral stemmer. **The German arms have since
been re-run under `german` (2026-08-16) — the result is below.** The standing
rule is unchanged: **state the configuration in any report**, which the console
header and the report JSON's `ftsLanguage` field both do now.

### The German re-run under `german` (measured 2026-08-16)

Both arms re-seeded on the same 275-page German corpus (`corpusManifestSha
9ee0892c95a7…`, 197 queries, identical `queryId` set), scored and tested with
the repo's own `metrics.ts` — McNemar exact over the discordant pairs, plus the
seed-1102 paired bootstrap for effect size. Page ids differ per seeding, so
everything is paired on per-query hit@K.

**Absolute scores under each configuration:**

| | bge-m3 `simple` | bge-m3 `german` | Qwen3-4B `simple` | Qwen3-4B `german` |
| --- | ---: | ---: | ---: | ---: |
| R@1 | 0.6091 | 0.5939 | 0.6904 | 0.6548 |
| R@3 | 0.7817 | 0.7919 | 0.8680 | 0.8731 |
| R@5 | 0.8528 | 0.8477 | 0.8985 | 0.9036 |
| R@10 | 0.8883 | 0.8883 | 0.9492 | 0.9492 |
| MRR | 0.7119 | 0.7052 | 0.7878 | 0.7702 |

**What the stemmer did — `simple` → `german`, same model, same vectors:**

| | R@1 | R@3 | R@5 | R@10 | MRR |
| --- | ---: | ---: | ---: | ---: | ---: |
| bge-m3 | −0.015 (3W/6L, p = 0.51) | +0.010 (2W/0L, p = 0.50) | −0.005 (0W/1L, p = 1.0) | ±0.000 (0W/0L) | −0.007 |
| Qwen3-4B | −0.036 (1W/8L, **p = 0.039**) | +0.005 (2W/1L, p = 1.0) | +0.005 (1W/0L, p = 1.0) | ±0.000 (0W/0L) | −0.018 |

**R@10 is bit-identical on both models** — 197 ties, zero movement. The stemmer
never changed *which* pages reached the top ten on any query, only their order
within it. The one nominally significant cell is Qwen3's R@1 regression at
p = 0.039, and it should not be leaned on: four correlated tests per pair
(Bonferroni ×4 → 0.156), it rests on **nine** discordant queries out of 197
(one flip takes it to p = 0.18), and the same change on bge-m3 gives 3W/6L,
p = 0.51. Call it **"no detectable effect, possibly a small cost at rank 1"**,
not "German FTS is worse". Post-hoc reading, untested by these runs: this is
technical German **translated from English OSS documentation** (the vendored
MIT docs run through a translation pass, which is what holds content constant
across the two languages), so much of what discriminates is identifiers,
loanwords and code tokens that Snowball German either passes through or
over-truncates, and the lexical leg is mostly doing exact-token work `simple`
already does. **Carry that provenance with the conclusion.** It strengthens the
reading above — translated technical prose is identifier-dense — and it bounds
it: a translation holds systematically less of the compounding and inflection a
German stemmer exists to fold than pages a German speaker wrote, so this is
evidence that `german` is not an assumable recall upgrade, not evidence that it
does nothing on a natively-authored German corpus.

**The model gap is unaffected by the stemmer** — bge-m3 → Qwen3-4B under
`german`:

| | before | after | delta | W/L/T | McNemar exact p | 95% CI |
| --- | ---: | ---: | ---: | :---: | ---: | :---: |
| R@1 | 0.5939 | 0.6548 | +0.0609 | 27/15/155 | 0.0884 | [−0.005, +0.127] |
| R@3 | 0.7919 | 0.8731 | +0.0812 | 22/6/169 | **0.0037** | [+0.031, +0.132] |
| R@5 | 0.8477 | 0.9036 | +0.0558 | 19/8/170 | 0.0522 | [+0.005, +0.102] |
| R@10 | 0.8883 | 0.9492 | +0.0609 | 15/3/179 | **0.0075** | [+0.020, +0.102] |
| MRR | 0.7052 | 0.7702 | +0.0651 | 48/26/123 | — (graded) | [+0.021, +0.110] |

Positive at every K, with R@3 and R@10 clearing Bonferroni ×4 (0.015 and
0.030); under `simple` those two cells were p = 0.0023 and p = 0.0075, so the
comparison reproduces. **One correction in the other direction:** R@1 is no
longer nominally significant under `german` (27W/15L, p = 0.088) where under
`simple` it was (31W/15L, p = 0.026). The point estimate barely moved
(+0.081 → +0.061), so this is not the stemmer eroding the gap — R@1 was always
the weakest of the four, and neither value survives multiplicity correction.

Wall clock, from `run.log`: **4 m 21 s** for the bge-m3 arm and **40 m 55 s**
for the Qwen3 arm (~9.4×), each a full re-seed of the 275-page corpus plus its
197 queries.

**The bottom line for an operator:** `german` is not the missing ingredient for
German retrieval on this corpus, and changing the keyword-index language is not
a way to buy recall. Choose it because it describes your content; budget the
corpus-wide rebuild it costs. That is the wording the Retrieval panel's hint
carries, and it must keep agreeing with this section.

`--baseline` refuses a pair whose configurations differ, in the same style as
its cross-model and cross-language refusals. A baseline that carries no
`ftsLanguage` predates the field and is read as `simple`, because that is what
it was; the refusal message says so rather than reading like a missing-field
bug. The corpus-sha guard does **not** catch this one — two runs over the same
corpus can differ only in their text-search configuration.

The value is validated against the product's own allow-list before anything is
written, because `getFtsLanguage()` answers `simple` for anything Postgres would
not accept: an unchecked flag would produce a run labelled `german` whose
keyword leg was `simple`. After seeding, the run re-derives every page's
tsvector under the requested configuration and refuses if any row disagrees —
the trigger is what actually builds them, and trusting an INSERT ordering is
what produced the bug in the first place.

A successful seed also records **which corpus it wrote**, in
`admin_settings.eval_corpus_language`. Nothing about the seeded rows says what
language they are — the vector width identifies the model, not the text — and
the latency benchmark's `--lang` picks only the question set, so without that
row German questions could be timed against an English corpus and published as
a German measurement. It is written after the seed, never before: it states
what the database holds, so a run that dies halfway must not leave a claim
behind it.

## Reading the verdict

Real output, from re-running the harness against its own baseline with nothing
changed:

```
--- retrieval eval ---
Recall@1: 0.3889
Recall@3: 0.7847
Recall@5: 0.8819
Recall@10: 0.9236
MRR:       0.5837
vector leg participated in 144/144 queries

--- vs baseline (Recall@5) ---
delta +0.0000  (bootstrap interval [0.0000, 0.0000], descriptive)
0 wins · 0 losses · 144 unchanged

McNemar exact over 0 discordant pairs: p = 1.0000
VERDICT: no credible change — too few queries moved, or they moved both ways.
```

**The decision is McNemar's exact test over the discordant pairs** — the
queries the change actually flipped. The bootstrap interval is printed beside
it as a description of effect size, and is deliberately *not* the gate: with
one expected page per label, per-query Recall@K is 0 or 1, and in that discrete
regime the percentile interval fires at **four flipped queries regardless of
fixture size** — at a true two-sided p of 0.125. Growing the fixture would not
have helped; it would only have shrunk the delta printed beside the same
verdict.

The issue's original "regressions > 0.01 fail" rule is unrepresentable for a
different reason: Recall@K over N queries moves in 1/N increments, so at N=144
the smallest possible change is 0.007 and at N=30 it would be 0.033 — a fixed
line fires on noise while the effect it names cannot occur.

What the sign test can and cannot see: 6 discordant pairs all one way is
p=0.031 and fails the run; 4 one way is p=0.125 and does not, because no
honest test can call four coin flips significant. If you need to detect an
effect that small, the fixture needs more queries that the change can move —
not a looser threshold.

**Only a credible regression fails the run.** An improvement and a wash both
pass — this catches retrieval getting worse, it does not demand every PR make
it better. Read the win/loss table either way: a change that wins 14 and loses
9 has moved 23 queries while the mean barely twitched.

## Query-time latency under concurrency (#1114)

`backend/scripts/benchmark-query-latency.ts` answers a question this harness
cannot: what a 2560-dimensional embedding model costs at **query** time when
several people ask at once. The quality eval has no timing field at all,
`runner.ts` is strictly sequential by design (its participation floors assume
exactly one hit per query, which is why the benchmark lives outside `eval/`
rather than growing a concurrency flag there), and `rag-service.ts` puts no
timer around the embedding call.

Two halves, selected with `--mode`:

- **`embedding`** — `POST {base-url}/embeddings`, one request per query, at
  each concurrency level. Note the missing `/v1`: `--base-url` is spelled
  **exactly** as the provider row is (`http://localhost:1234/v1` for LM Studio),
  because `generateEmbedding` appends `/embeddings` to it verbatim and nothing
  guesses a `/v1` for you. The query text is formatted exactly as production
  formats it (`formatQueryForEmbedding`), so Qwen3 pays for its `Instruct`
  preamble. It bypasses `openai-compatible-client.ts` on purpose: that client's
  shared queue and per-provider circuit breaker are the serialisation this
  measurement is trying to look underneath. Touches no database.
- **`search`** — `hybridSearch()` end to end, called the way `runner.ts` calls
  it (rerank off, sibling assembly on, identifier pinning on), timed per call.
  Its vector leg goes **through** that same shared queue, whose width is
  `LLM_CONCURRENCY` (default 4) — so a search rung above 4 measures the
  product's own serialisation rather than N-way parallelism, and the vector leg
  additionally takes a connection from a pool capped at `PG_VECTOR_POOL_MAX`
  (default 5). Both ceilings are recorded in the report's metadata, because
  without them two boxes' numbers are not comparable. It also means the two
  halves of one row at `--concurrency 8` are **not** under the same in-flight
  load: the embedding half really runs 8 wide, the search half does not.

The run is **non-destructive**: it never seeds, and every search runs with
`recordAnalytics: false`, so no replayed fixture query is filed as a question
somebody asked. Warm-up calls are issued and discarded — the first request into
a cold model server carries load time, which is not what a per-query p95 means.

**`--models` selects the model for the embedding half only.** `hybridSearch`
takes no model and no endpoint: `rag-service` resolves both from the database's
`embedding` use-case assignment — the provider row `run-retrieval-eval.ts` wrote
when it last seeded. So a `search` or `both` arm takes **exactly one** model and
is refused unless that model and `--base-url` are what the assignment resolves
to; the resolved pair goes into the report as `searchModel` / `searchBaseUrl`.
Without that, two 1024-dim models would produce two differently-labelled rows
measuring the same thing, and the width probe cannot tell them apart.

The search half needs the database **already seeded for that model and that
corpus**, so run one arm per seeding. `--lang` on the benchmark chooses the
**question set** only — the corpus is whatever was seeded — so seed with
`--lang de` before timing German questions; the seeding records which corpus it
wrote and a mismatched `--lang` is refused (a database seeded before that was
recorded warns instead):

```bash
cd backend
export POSTGRES_URL=postgresql://kb_user:pw@localhost:5433/kb_eval
export EVAL_EMBEDDING_BASE_URL=http://localhost:1234/v1   # LM Studio

# bge-m3 arm — immediately after seeding bge-m3
EVAL_EMBEDDING_MODEL=text-embedding-bge-m3 \
  npx tsx scripts/run-retrieval-eval.ts --out /tmp/bge.json
npx tsx scripts/benchmark-query-latency.ts \
  --models text-embedding-bge-m3 --concurrency 1,4,8 --out /tmp/lat-bge.json

# Qwen3 arm — after re-seeding with Qwen3 (this re-embeds the whole corpus)
EVAL_EMBEDDING_MODEL=text-embedding-qwen3-embedding-4b \
  npx tsx scripts/run-retrieval-eval.ts --out /tmp/qwen.json
npx tsx scripts/benchmark-query-latency.ts \
  --models text-embedding-qwen3-embedding-4b --concurrency 1,4,8 --out /tmp/lat-qwen.json

# German arm — the corpus has to be German too, not only the questions
EVAL_EMBEDDING_MODEL=text-embedding-bge-m3 \
  npx tsx scripts/run-retrieval-eval.ts --lang de --fts-language german --out /tmp/bge-de.json
npx tsx scripts/benchmark-query-latency.ts \
  --models text-embedding-bge-m3 --lang de --concurrency 1,4,8 --out /tmp/lat-bge-de.json

# A pure embedding sweep needs no database, and is the one mode that takes
# several models — nothing is resident that a second load can spoil.
npx tsx scripts/benchmark-query-latency.ts --mode embedding --out /tmp/lat-sweep.json
```

**Do not touch LM Studio during a run.** Loading a second model evicts the one
being measured, and every number after that point is a cold start. That is the
other reason a `search`/`both` arm names one model.

Flags (`--help` prints the same list):

| flag | default | note |
| --- | --- | --- |
| `--base-url` | `$EVAL_EMBEDDING_BASE_URL` | no built-in default; the point is to measure the server you serve from. Spelled **exactly** as the provider row is (`http://localhost:1234/v1` for LM Studio): the request goes to `<base-url>/embeddings`, which is what `generateEmbedding` does — nothing guesses a `/v1` for you, and a search arm whose `--base-url` differs from the assignment's is refused |
| `--models a,b` | `text-embedding-bge-m3,text-embedding-qwen3-embedding-4b` | embedding half only; a `search`/`both` arm takes exactly one |
| `--concurrency` | `1,4,8` | sorted and de-duplicated |
| `--queries N` | `40` | sampled deterministically and evenly across the fixture — it is grouped by style, so a head slice would benchmark one query shape |
| `--lang en\|de` | `en` | which **fixture** the questions come from; never the corpus |
| `--mode` | `both` | `embedding` \| `search` \| `both` |
| `--out` | `query-latency.json` | |

The two defaults do not combine: `--mode both` with the two-model `--models`
default is refused, because the search half times the seeded database's model.
That is deliberate — the refusal names the flag to pass — and an unrecognised
flag is refused too rather than silently running the defaults under it.

The report is self-describing on purpose. Its metadata carries the endpoint, the
question language, **the corpus language the seeding recorded**, **the
`fts_language` the database is actually set to**, the live `page_embeddings`
column type and width, the query count, the **model and endpoint the search half
resolved from the database** (`searchModel` / `searchBaseUrl`), and the
`llmConcurrency` / `vectorPoolMax` ceilings it ran under; each row is keyed by
`{model, concurrency}` and carries `embedding` and/or `search` with
`{n, meanMs, p50Ms, p95Ms}`.

Refusals that matter:

- **Mislabelled search arm.** `--models` / `--base-url` that disagree with the
  database's `embedding` assignment stop the run, because the row would
  attribute one model's latency to another and the width probe below cannot see
  it (two 1024-dim models pass it).
- **Corpus/question-set mismatch.** `--lang de` against an English seeding is
  refused. The dead-vector-leg guard cannot catch it — that fires only at
  exactly zero participation, and a mismatched corpus still returns hits.
- **Uncertified FTS configuration.** The benchmark reports the `fts_language`
  the database is *set* to, so it also certifies the seeded tsvectors were
  *built* under it (`assertSeededFtsLanguage`, one recomputing `SELECT` — the
  run stays read-only). The eval writes that row **before** it truncates the
  corpus, so a failure in between leaves the previous corpus standing under a
  changed configuration; without this the benchmark would report `fts simple`
  over German-built tsvectors, and the keyword leg would genuinely run
  mismatched, so the timing would be wrong too and not only the label. Re-seed
  with `run-retrieval-eval.ts --fts-language <cfg>` to clear it.

- **Dimension mismatch.** Before timing anything, the script embeds one probe
  with the model and compares it against `page_embeddings.embedding`'s width
  from the catalog. If they differ it stops. It has to: seeding is an hour of
  embedding, and `hybridSearch` degrades to keyword-only on an embedding failure
  rather than erroring — so a mismatched arm would happily publish Postgres FTS
  latency as retrieval latency.
- **Dead vector leg.** Each search arm records how many of its queries returned
  at least one vector-scored result. Zero sets a non-zero exit code after the
  report is written — the timing-side form of the silent lie `runner.ts`'s
  participation guard exists for.

## The model must read a whole chunk

The corpus chunks out at up to `CHUNK_HARD_LIMIT` (6000 characters), so the CI
model's context window has to cover that. `all-minilm` does not: its ~256-token
window silently embedded roughly the first sixth of each chunk while the run
still reported "100% embedded" and a confident Recall@K describing text the
model never read.

`assertModelReadsFullChunk` now fails the run when that happens, detected
empirically rather than from a model card — neither the OpenAI-compatible API
nor Ollama's `/v1` exposes a context length. It embeds two chunk-sized texts
differing only in their final word; a model reading the whole input must return
different vectors. `all-minilm` returns byte-identical ones.

## When it fails for a reason that is not quality

- **`Vector leg participated in 0/144 queries`** — the embedding provider is
  unreachable or unconfigured. `hybridSearch` swallows embedding failures into
  a warning and returns keyword-only results, so without this check the run
  would publish a confident score computed entirely from Postgres FTS. Check
  the provider row and that the model is pulled.
- **`Corpus is only N% embedded`** — a partial corpus inflates every metric,
  because queries pointing at unembedded pages are scored against a corpus
  that does not contain their answer.
- **`Baseline was measured against a different corpus`** — the corpus was
  re-vendored. Re-label before comparing; the fixture records the manifest
  hash it was written against.

## These numbers are also shown to admins (#1114)

Settings → AI Models → Embeddings renders a **Model comparison (reference corpus)** table
from `frontend/src/features/settings/panels/embedding-benchmarks.ts`. It is a
hand-maintained copy of results produced by this script, so **the two can
drift** — if you re-measure, update that file in the same PR, including its
`measuredOn` date.

Four things in that file are load-bearing and must survive an edit:

- **`ftsLanguage`, now PER LANGUAGE.** The rule this issue establishes is that
  a retrieval number states the text-search configuration it was measured
  under, and this table is the only surface where these numbers reach a human.
  It was one global field while every run behind the table was `simple`; the
  German re-measurement ended that, so `BenchmarkLanguage.ftsLanguage` carries
  it per block (`german` for German, `simple` for English) and the table renders
  each beside its heading. `BENCHMARK_PROVENANCE.ftsLanguage` survives as the
  headline value — the German one, since those are the rows a cutover decision
  leans on — and a test fails if it drifts from the German block's. It moves in
  the same edit as the scores.

- **`established` per metric.** A mean without its significance is what made
  the English Recall@1 delta look like the headline result; it moves +0.051 and
  does not survive a paired test (p = 0.174). The UI renders "not established"
  next to such a number, and a data edit that drops the flag turns an artifact
  back into a claim. **This flag has already moved once**: German Recall@1 was
  `established: true` under `simple` (p = 0.026) and is `false` under `german`
  (p = 0.088), which is the column doing its job on a re-measurement.
- **Language is a top-level split.** The two models do not rank identically in
  both, and the blocks were not even measured under the same keyword
  configuration. A blended table hides the distinctions most likely to change a
  decision.
- **Indexing speed sits beside quality.** Qwen3 embeds ~10x slower than bge-m3
  on the same corpus and hardware. A quality-only table recommends a model
  while hiding the dominant cost of switching to it.

Absence from that table means "not measured", never "measured badly", and the
UI says so.

**Its German rows are now measured under `fts_language = german`** (2026-08-16
— see *The German re-run under `german`* above). The re-measurement was owed
because RRF fuses a per-model vector leg with a shared keyword leg as
`Σ 1/(k + rank)`, which is nonlinear: a stronger German keyword leg raises both
arms and could have compressed or amplified the gap between them. It did
neither. The absolute scores landed within noise of the `simple` ones, R@10 came
back bit-identical query-for-query on both models, and the model comparison
reproduced — R@3 and R@10 clear a Bonferroni ×4 correction under both
configurations. The one flag that moved is German Recall@1, from
`established: true` (p = 0.026) to `false` (p = 0.088).

Two things follow for anyone editing that file. **Move `measuredOn` and the
block's `ftsLanguage` in the same edit as the scores** — and note that a
`german` label on its own now invites the opposite error from the one this
paragraph used to guard against: a reader who sees the configuration corrected
and nothing else will assume the earlier numbers were understating German. The
panel's closing note therefore states the finding — that `simple` measured
within noise, and that choosing a keyword language is not a way to buy recall —
and `EmbeddingModelBenchmarks.test.tsx` fails if it stops doing so or if it
reverts to calling the rows pending. **The English rows stay `simple`**, and
deliberately: every English baseline, CI's included, was measured under it.

## Changing the corpus or the fixture

The corpus is committed, not fetched: CI has no network for it, and a corpus
that shifted underneath the fixture would silently invalidate every labelled
`query → page` pair. `backend/scripts/vendor-eval-corpus.ts` regenerates it
from pinned upstream commits.

**Re-vendoring obliges a re-label**, and the manifest hash in `fixture.json`
is what enforces that. Labels come from agents that have not seen the
retrieval implementation — the fixture must never be written by whoever is
tuning the thing it scores.

### Page titles

The corpus stands in for a Confluence knowledge base, so a corpus page needs a
**human title** — `pages.title` is half of the `pages.tsv` the keyword leg
scores against, and it is what the identifier short-circuit matches on.
`backend/src/domains/llm/eval/corpus-title.ts` is the single derivation, shared
by the vendor script and by `corpus-title.test.ts`:

1. the front-matter `title`;
2. else the first `#` heading, **ignoring fenced code**;
3. else the de-slugified filename (`Fluent-Schema.md` → `Fluent Schema`),
   unless the filename is positional (`index`, `readme`);
4. else the first heading at any depth.

Rule 3 sits above the deeper headings deliberately: a page with no `#` opens at
some `##` that is its first *section*, not its subject, so `Serverless.md`
would be titled `AWS`. Every title is stripped of VitePress markup — Vue
components with their decorative content, `{#anchor}` suffixes, backticks.

Nothing in `corpus/MANIFEST.json` may be hand-edited: the vendor script rebuilds
it from scratch on every run and would delete the edit without a word. Each
entry records `titleSource`, and `corpus-title.test.ts` re-derives every
`heading` and `filename` title from the committed bytes — so a hand-edit fails
in CI rather than surviving until the next refresh.

Fixture floor is **N ≥ 100**, enforced in `assertFixturePower`. Today: 197
queries over 162 distinct pages, spread across natural questions, bare
keywords, error text and how-to phrasings, because a fixture made of one
phrasing measures half the system — keyword queries flatter FTS, natural
questions flatter the vector leg.

### Image corpus (#1115 P5a)

`backend/src/domains/llm/eval/corpus-de-images/` is a **third** corpus: 65
German Wikipedia articles carrying 187 vendored images (6.2 MB), across four
content shapes — engineering diagrams, scientific figures, process notation and
photographs. It exists because #1115's image retrieval leg cannot be measured on
a corpus with no pictures. Built by `tools/eval-corpus-images/build.py` from
`articles.yaml`, at revisions pinned in the corpus's own `MANIFEST.json`; a
plain re-run reproduces the committed bytes, `--update` moves to current
revisions and obliges a re-label. Read its `README.md` first.

**Nothing here consumes it yet, and that is deliberate.** It is absent from
`CORPUS_DIRS` and from `corpusDirsForLanguage`, so no run this runbook describes
touches it and every recorded baseline stays comparable —
`computeCorpusManifestSha` covers every directory in that list, so wiring it in
invalidates all of them at once. **P5b** adds the `--images` axis and does that
on purpose; **P5c** writes the labels, by an independent vision-capable agent on
a different model from the implementer. `corpus-de-images.test.ts` fails if the
wiring happens by accident first, and is also what keeps the corpus honest:
page bodies carry `![](images/…)` with an **empty alt and no caption**, because
a page that captions its own figures is answerable from text alone and would
score the image leg a win it did not earn. The captions live in the manifest,
for the labeller.

Licences are not the text corpus's. Page text is CC BY-SA 4.0 (adapted);
images are filtered to CC0 / public domain / CC BY x / CC BY-SA x with a named
author each, and the obligations are stated per page and per image in that
directory's `LICENSE-ATTRIBUTION.md`. Where Commons records the licensor's own
credit line (`AttributionRequired`), that string is reproduced verbatim in a
`Required credit` column and is the one to travel with the image — it is
regularly not the bare name in `Author`, and both are kept because `Artist` is
often the fuller of the two. It is a test fixture, licensed separately from
this repository's own **AGPL-3.0** (root `LICENSE`).

## The `vocabulary-gap` slice (#1112)

Every style above was written by an agent **reading the page**, and that
leaves a blind spot the styles cannot see past: the queries reuse the page's
own words. Measured over the shipped fixture, a non-gap label shares **0.58**
of its content words with the target's title and opening ~1500 characters. A
retrieval change whose entire job is to bridge the gap between what a user
types and what a page says therefore has almost nothing to bridge here, and
would score a clean, meaningless wash — the same way a fixture of one phrasing
measures half the system.

The 33 `vocabulary-gap` labels ask for a real corpus page **in words the page
never uses**: terse, abbreviated, synonym-heavy, the way a hurried engineer
types. `eol` for "long term support", `a11y` for "accessibility", "fake dom"
for jsdom, "caller hung up" for "client aborts". Their measured overlap is
**0.13**. Each label's `rationale` names the wording that was deliberately
avoided, which is the audit trail for whether a given label is honest.

Two things follow for anyone editing this slice:

- **It is not a probe.** `identifier` and `diversity` ship 3 labels each and
  get a floor of 3; `vocabulary-gap` takes the core floor of 10 and ships 33,
  because expansion is expected to move a handful of queries and Recall@K over
  three of them moves in thirds — indistinguishable from noise.
- **The low overlap is enforced, not asserted in prose.** A label written from
  the page's sentences would still validate, still score, and quietly make the
  slice look easy. `fixture.test.ts` recomputes the overlap and fails when the
  slice's mean rises above 0.3, when it stops being less than half the rest of
  the fixture, or when any single label passes 0.45 — naming the label and its
  measured number.

**22 of the 33 target a page that already carries an ordinary label**; the
other 11 open pages the fixture had never reached. That pairing is deliberate:
the same page asked for twice, once in its own words and once not, is the only
way to separate "this query is hard" from "this page is hard". A slice built
entirely on previously unlabelled pages would have confounded the two, and any
recall gap it showed could have been the pages rather than the wording.

### Measured headroom

Against today's pipeline (`--rerank`, `nomic-embed-text-v1.5`), measured on the
fixture as it stood when the slice landed — 191 queries, before #1111's six
`ranking-prior` probes merged alongside it:

| slice | n | R@1 | R@5 | R@10 | MRR |
|---|---|---|---|---|---|
| `vocabulary-gap` | 33 | 0.182 | 0.545 | 0.636 | 0.335 |
| every other label | 158 | 0.722 | 0.918 | 0.943 | 0.812 |

The pairing is what makes that readable. Restricted to the 22 pages that carry
labels of both kinds, the ordinary labels score **R@1 0.808 / R@10 0.923** and
the gap labels **R@1 0.182 / R@10 0.682** — the target page is held fixed and
only the wording moves, so the drop is not "these are obscure pages". Nor are
they short ones: the median target behind a gap MISS is 5.1 KB against a corpus
median of 4.4 KB. The 11 gap labels on newly-covered pages score the same R@1
(0.182) as the 22 paired ones, so the slice is not riding on corpus backwaters
either.

Twelve gap queries never surface their page in ten results, and the results
they get instead are not near-misses: "vite paint the markup on the server
first so crawlers see content" returns six **Vitest** pages. That is the
headroom #1112 has to claim, and it did not exist in the fixture before.
