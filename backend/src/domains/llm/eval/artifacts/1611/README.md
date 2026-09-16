# ADR-027 gate artifacts (epic #1611)

The home of every captured run of the pre-registered A/B/C comparison
(`docs/ARCHITECTURE-DECISIONS.md` ADR-027 "Measurement plan"; recipe in
`docs/runbooks/retrieval-eval.md` "Arm protocol"). Files here are evidence,
never inputs: nothing in the harness reads this directory.

## What lives here, and the rule for adding to it

| File | Written by | Carries |
|---|---|---|
| `arm-<A\|B\|C>-<revision>.json` | `scripts/run-retrieval-eval.ts --images --arm X --out …` | `ArmRunReportSchema` (`eval/arms.ts`): the arm, the revision sha, corpus and query-set hashes, embedder identity and width, FTS configuration, rerank and `chat` assignments, vision model, every retrieval knob, `EVAL_HARDWARE`, per-query rows with the arm's image evidence |
| `answers-<runId>.jsonl`, `mapping-<runId>.json`, `provenance-<runId>.json` | `scripts/run-arm-answers.ts` | the arm-blinded answers (no arm, query id, config or chunk provenance), the `itemId → {arm, queryId}` mapping, and both files' sha256 with the answer-model identity and temperature (`provider default`) |
| `answers-<sheet>.jsonl`, `mapping-<sheet>.json`, `sheet-<sheet>.json` | `scripts/judge-arms.ts --merge` | the ONE blinded sheet the judge sees, and the hashes recorded before judging starts |
| `judgments-<sheet>.jsonl` | the judge (the repository owner, O12), by hand | one row per item: `{ itemId, judge, correctness, citationFaithful, unsupportedClaim, notes, judgedAt }` |
| `verdict-<sheet>.json` | `scripts/judge-arms.ts --unblind` | the paired scoring, the decision rule's conditions, the single-judge statement, every un-blinded item |
| `control-<en\|de>-<B\|C\|legacy>.json` | `scripts/run-retrieval-eval.ts --lang … --out …` on that arm's revision AND index state | the text-gate reports the pooled non-inferiority controls read — B vs C, and candidate C vs legacy-revision C when `--control-legacy-c` is passed (the flag that replaced `--control-a`, ADR-027 amendment A-3). One file per arm per language: the recipe never passes a file it did not produce |

Every artifact records the revision it was made on, the command line that
produced it and the hashes of what
it was made from; `judge-arms.ts --unblind` parses all of them — including
each answer run's `provenance-<runId>.json`, which it holds to its arm's
retrieval report — and refuses
one missing or mismatched field rather than annotating it. A file added here by hand,
or one whose sha does not match its provenance, is not evidence. Real-model
numbers are the only numbers this directory may hold: a run through a
mocked chat or embedding boundary verifies tooling and is written to
`/tmp`, never here.

## What is captured here (2026-09-16, #1619)

Two real-model retrieval captures, both on the DE image fixture (309 queries,
65 corpus pages, 187 images), text embedder Qwen3-Embedding-4B at 2560 dims,
rerank off, FTS `german`, hardware
`rtx3090-host · NVIDIA RTX 3090 24 GB · LM Studio openai-compatible /v1`:

| file | what it is |
|---|---|
| `arm-C-7e01cf2e.json` | **arm C** on the candidate revision `7e01cf2e` — `image_analysis` unassigned, no image leg, no derived rows. R@1 .9417 · R@3 .9838 · R@5 .9871 · R@10 .9968 · MRR .9635, vector leg 309/309, image evidence none (by rule), image-negative leakage@1 0 of 24 |
| `arm-C-legacy-7feb4af2.json` | the **legacy-revision C control** — A-3's text-regression detector — at `7feb4af2`, the #1614 merge immediately before #1617. Identical to arm C on every METRIC, query for query (per-query R@1/3/5/10 and reciprocal rank match on all 309), so #1617's lexical chunk resolution is a no-op on this corpus and fixture. The rows are not byte-equal and are not claimed to be: two independent seeds number the same pages differently (a `{2→4, 4→5, 5→2}` page-id cycle explains 308 of 309 rows), and one query — `img-03-016` — genuinely differs in rank ORDER, two pages swapping at ranks 4 and 5 with the expected page at rank 1 on both sides, so no metric moves |

**What is NOT here, and why.** Arm A is permanently unobtainable: it needs a
real VL *embedding* endpoint and the owner declined to stand one up (ADR-027
amendment A-1). Arm B is **NOT captured** — 100 of 187 images carried a valid
analysis when the driver refused the run, because the interleaved re-embed
pass could not load the text embedder on a host that serves one model at a
time; the provider host itself went silent later, during the 43-second re-run,
which is why the run has not been resumed since. The driver's 187/187
completion bar was not relaxed and no `arm-B-*.json` exists anywhere in this
tree. No answer run, sheet, judgments file or verdict document exists either:
no human answer-correctness judging was taken for #1619 (A-5), and O15's
labelling pass has not run, so `--unblind` would refuse the sheet on the
counts. The resume recipe for arm B, including what the eval database must
carry before the run, is in `docs/runbooks/retrieval-eval.md` ("Arm protocol").

## Errata on these two files — read before quoting them

1. **`queryCostMs.p50` and `.p95` are WRONG in both files: each is the
   maximum, not a percentile.** Both captures predate `a34eec38`, which fixed
   the call into `percentile` (it takes a FRACTION; the arm axis passed `50`
   and `95`, and `Math.ceil(309 × 50) − 1` clamps to the last index). Read
   each file's two latency fields as one number — the slowest query, 198.76 ms
   on arm C and 424.21 ms on the legacy revision. The true percentiles,
   re-derived from the 309 per-query `ms` values in the files themselves: arm C
   p50 **45.99** / p95 **62.27** ms; legacy p50 **43.41** / p95 **58.40** ms.
   Nothing else is affected: every recall, MRR and leakage figure re-derives
   exactly under the shipped definitions. The measured rows are left as
   captured — the same note sits beside each file as `<file>.README`, so a
   reader who has only the artefact has the correction too.
2. **`pinParticipatingQueries: 0` beside `rag_pin_identifiers: true`** is
   configuration on, zero in effect. The counter counts queries whose results
   led with a verified identifier pin (#1107), and no query in the DE image
   fixture is an exact identifier, so the pin never fired. These two files are
   therefore not evidence that the pin was exercised; no figure they report
   depends on it.
3. **Commit `a34eec38`'s message says "the three artifacts captured before
   this fix (arm C, arm B, legacy-revision C)".** There is no arm-B artefact:
   there are TWO captures, the two above. The commit message is history and is
   not rewritten; this line is its correction.
4. **The legacy capture's `command` records an absolute developer path**, where
   its sibling records a repo-relative one: `--out` was passed as
   `/Users/simon/localGIT/compendiq/compendiq-ce-1619/backend/src/domains/llm/eval/artifacts/1611/arm-C-legacy-7feb4af2.json`.
   The string is left exactly as the run recorded it. `command` is the
   provenance field the rule above is built on — "Every artifact records … the
   command line that produced it" — so normalising it would make the file
   record a command line that was never run, which is the one thing this
   directory may not hold. #1619's round-1 review fix did rewrite it to the
   repo-relative form (`896d2dfd`, whose message says the capture "now records
   the same form"); round 2 caught that as an edit to committed evidence and
   restored the captured bytes, so the file is byte-identical to its capture
   again and that commit message stands as history, corrected here. Future runs
   should pass a repo-relative `--out` (run from `backend/`, as the sibling
   capture and the runbook recipe do) so the recorded line is portable.

The rule for adding to this directory is the table above and nothing else: a
real-model run, written by the harness, recording its own revision, command
line and hashes. A file added by hand is not evidence.
