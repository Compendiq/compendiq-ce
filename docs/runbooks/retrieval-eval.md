# Runbook — retrieval quality eval (#1102)

Answers one question: **did this change make retrieval better or worse?**

Before this existed, tests covered plumbing (RRF arithmetic, ACL, keyword
fallback) but nothing measured quality, so every retrieval change was argued
rather than measured.

## What it measures, and what it does not

- **Does** detect regressions in retrieval *logic* — the same corpus and the
  same embedding model before and after a change.
- **Does not** judge an embedding-model upgrade. The CI model is small and
  fast on purpose; comparing candidate models needs the real ones, on #1113's
  rig. `--baseline` refuses a cross-model comparison for that reason.
- **Does not** claim your knowledge base scores this well. The corpus is
  vendored MIT documentation (Fastify, Vitest, Vite), not your pages.

## Running it

```bash
# needs a database it may TRUNCATE and RETYPE, plus an embedding endpoint
docker run -d -p 11434:11434 ollama/ollama
curl -X POST localhost:11434/api/pull -d '{"name":"all-minilm"}'

cd backend
export POSTGRES_URL=postgresql://kb_user:pw@localhost:5433/kb_eval
export EVAL_EMBEDDING_BASE_URL=http://localhost:11434/v1
export EVAL_EMBEDDING_MODEL=all-minilm

# 1. measure the baseline — on the branch point, BEFORE your change
npx tsx scripts/run-retrieval-eval.ts --out /tmp/baseline.json

# 2. apply your retrieval change, then measure again and compare
npx tsx scripts/run-retrieval-eval.ts --out /tmp/candidate.json --baseline /tmp/baseline.json
```

CI runs the same script in the `retrieval-eval` job on any PR touching
`rag-service`, `embedding-service`, `llm-provider-resolver` or `eval/`, and
uploads its report as an artifact — download that to use as a baseline.

## Reading the verdict

```
delta +0.0347  95% CI [0.0069, 0.0625]
14 wins · 9 losses · 121 unchanged
VERDICT: credible improvement — the interval excludes zero.
```

The gate is the **paired bootstrap CI**, not a fixed threshold. The issue's
original "regressions > 0.01 fail" rule is unrepresentable: Recall@K over N
queries moves in 1/N increments, so at N=144 the smallest possible change is
0.007 and at N=30 it would be 0.033 — a fixed line fires on noise while the
effect it names cannot occur. The interval answers the right question: is the
movement bigger than the fixture's own sampling variation?

**Only a credible regression fails the run.** An improvement and a wash both
pass — this catches retrieval getting worse, it does not demand every PR make
it better. Read the win/loss table either way: a change that wins 14 and loses
9 has moved 23 queries while the mean barely twitched.

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

Fixture floor is **N ≥ 100**, enforced in `assertFixturePower`. Today: 144
queries over 141 distinct pages, spread across natural questions, bare
keywords, error text and how-to phrasings, because a fixture made of one
phrasing measures half the system — keyword queries flatter FTS, natural
questions flatter the vector leg.
