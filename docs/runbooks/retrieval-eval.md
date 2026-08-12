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
- **Does not** judge an embedding-model upgrade. The CI model is small and
  fast on purpose; comparing candidate models needs the real ones, on #1113's
  rig. `--baseline` refuses a cross-model comparison for that reason.
- **Does not** claim your knowledge base scores this well. The corpus is
  vendored MIT documentation (Fastify, Vitest, Vite), not your pages.

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
found.

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

## Changing the corpus or the fixture

The corpus is committed, not fetched: CI has no network for it, and a corpus
that shifted underneath the fixture would silently invalidate every labelled
`query → page` pair. `backend/scripts/vendor-eval-corpus.ts` regenerates it
from pinned upstream commits.

**Re-vendoring obliges a re-label**, and the manifest hash in `fixture.json`
is what enforces that. Labels come from agents that have not seen the
retrieval implementation — the fixture must never be written by whoever is
tuning the thing it scores.

Fixture floor is **N ≥ 100**, enforced in `assertFixturePower`. Today: 197
queries over 162 distinct pages, spread across natural questions, bare
keywords, error text and how-to phrasings, because a fixture made of one
phrasing measures half the system — keyword queries flatter FTS, natural
questions flatter the vector leg.

## The `vocabulary-gap` slice (#1112)

Every style above was written by an agent **reading the page**, and that
leaves a blind spot the styles cannot see past: the queries reuse the page's
own words. Measured over the shipped fixture, a non-gap label shares **0.57**
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
