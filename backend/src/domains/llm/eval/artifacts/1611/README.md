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

## What is captured here

### 2026-09-18, #1619 — the B-vs-C pair, both arms on one revision

`a9f0fbb8`, DE image fixture (309 queries, 65 corpus pages, 187 images),
text embedder Qwen3-Embedding-4B **GGUF Q8_0** at 2560 dims, rerank off,
FTS `german`, answer model `qwen3.8-27b`, hardware `rtx3090-host · NVIDIA
RTX 3090 24 GB · LM Studio` behind a local model-residency proxy.

| file | what it is |
|---|---|
| `arm-B-a9f0fbb8.json` | **arm B** — `image_analysis` assigned to `qwen3.8-27b`, **187/187** images analysed under identity `9adc65405eb4…` (prompt v1, schema v1), 187 derived chunks, backfill 67.3 min. R@1 **.9806** · R@3 **1.0000** · R@5 **1.0000** · R@10 **1.0000** · MRR **.9903**, image-evidence R@5 **.6316** over 248/309 queries carrying evidence, image-negative leakage@1 **0** of 24, vector leg 309/309, query cost p50 56.7 / p95 65.5 ms |
| `arm-C-a9f0fbb8.json` | **arm C** on the same revision and the same embedder — `image_analysis` unassigned, no derived rows. R@1 **.9320** · R@3 .9871 · R@5 .9871 · R@10 .9968 · MRR **.9599**, image evidence none (by rule), leakage@1 0 of 24, p50 55.8 / p95 63.7 ms |

**Paired B vs C** (`compareArmRetrieval`, McNemar exact on discordant pairs,
95% bootstrap CI over 65 page clusters, 309 queries):

| endpoint | C | B | δ | discordant | p | 95% CI |
|---|---|---|---|---|---|---|
| page R@1 | .9320 | .9806 | **+4.85 pp** | 16 W / 1 L | **0.000275** | [+2.34, +7.72] pp |
| page R@5 | .9871 | 1.0000 | +1.29 pp | 4 W / 0 L | 0.125 | [+0.32, +2.60] pp |
| page R@10 | .9968 | 1.0000 | +0.32 pp | 1 W / 0 L | 1.0 | — |
| MRR | .9599 | .9903 | +3.04 pp | — | — | [+1.47, +4.84] pp |
| image-negative leakage@1 | 0/24 | 0/24 | 0 | 0 | 1.0 | [0, 0] |

*What this establishes:* on this corpus and fixture, ingestion-time image
analysis retrieves the expected page **better than no image analysis** —
significant at R@1, with R@5 and R@10 saturated at 1.0000 and no added
image-negative leakage. `imageEvidenceRecallAt5` is reported for arm B alone
(.6316): arm C has no image evidence by rule, so the paired guardrail is
`null` and A-2 retires it.

*What this does NOT establish:* anything about **answer** quality, and
anything at all about the retired ADR-025 image leg. The pre-registered
primary endpoint is image-dependent answer correctness, and **no human
judging was taken** (A-5), so this pair is retrieval evidence only and the
gate verdict stays **inconclusive by design**.

### 2026-09-16, #1619 — the earlier captures

Same fixture, embedder identity `text-embedding-qwen3-embedding-4b` at 2560
dims, hardware `rtx3090-host · NVIDIA RTX 3090 24 GB · LM Studio
openai-compatible /v1`:

| file | what it is |
|---|---|
| `arm-C-7e01cf2e.json` | **arm C** on the candidate revision `7e01cf2e` — `image_analysis` unassigned, no image leg, no derived rows. R@1 .9417 · R@3 .9838 · R@5 .9871 · R@10 .9968 · MRR .9635, vector leg 309/309, image evidence none (by rule), image-negative leakage@1 0 of 24. **Not pairable with the 2026-09-18 arms**: different revision, and the embedder was re-downloaded between the two sessions (below) |
| `arm-C-legacy-7feb4af2.json` | the **legacy-revision C control** — A-3's text-regression detector — at `7feb4af2`, the #1614 merge immediately before #1617. Identical to arm C on every METRIC, query for query (per-query R@1/3/5/10 and reciprocal rank match on all 309), so #1617's lexical chunk resolution is a no-op on this corpus and fixture. The rows are not byte-equal and are not claimed to be: two independent seeds number the same pages differently (a `{2→4, 4→5, 5→2}` page-id cycle explains 308 of 309 rows), and one query — `img-03-016` — genuinely differs in rank ORDER, two pages swapping at ranks 4 and 5 with the expected page at rank 1 on both sides, so no metric moves |

### What the 2026-09-18 session had to change to reach 187/187

Recorded because each one is provenance a reader needs, and none of them is
a change to what the product computes:

1. **The held-fixed embedder was missing from the host.** `/v1/models` still
   listed `text-embedding-qwen3-embedding-4b`, but it was absent from LM
   Studio's downloaded models and every load failed. It was re-downloaded as
   `Qwen/Qwen3-Embedding-4B-GGUF` **Q8_0** (4.28 GB), verified at 2560 dims.
   The quantization of the model behind the 2026-09-16 captures is **not
   recorded anywhere**, so it cannot be claimed identical — which is one of
   the two reasons those files are not pairable with these.
2. **A local model-residency proxy.** The host serves one model at a time,
   exposes no HTTP load/unload and does not auto-evict, so with the VL model
   resident `POST /v1/embeddings` answered `Failed to load model`. A proxy in
   front of the host reads `body.model`, makes it resident through LM Studio's
   SDK control plane and forwards the request **unchanged**; it is the
   endpoint recorded in both arms' embedder and vision identities.
3. **The vision candidate is `qwen3.8-27b`, not `gemma-4-26b-a4b-it` (O8).**
   Gemma spends 82–99 % of its output tokens on reasoning and ignores the D8
   erratum's advisory hints: at the 8,192 ceiling it returned
   `truncated:8192`, and at 16,384 the verbose images exceeded the 120 s
   per-image budget (`unavailable`) — 13–16 % permanent failures either way,
   against a completion bar that is not relaxable. `qwen3.8-27b` honours
   `enable_thinking: false` far better and analysed the same images in
   21–46 s. The ceiling in force for arm B is **16,384**.
4. **A product fix, `a9f0fbb8`, is the revision both arms run on.** Nine
   images produced a payload whose only schema violation was inside the
   OPTIONAL `structured` block (`chart.trend` > 120 chars ×6, a
   `diagram.nodes[]` entry > 50, a `diagram.edges[]` entry > 70, 26 nodes
   against a cap of 25) while their descriptions and transcriptions were in
   bounds — and the client discarded the whole analysis, leaving 4.8 % of the
   corpus permanently unanalyzable and its pages *partial* forever. The client
   now drops the offending optional block and keeps the analysis; nothing
   outside `structured` is relaxed.

**What is still NOT here, and why.** Arm A is permanently unobtainable: it
needs a real VL *embedding* endpoint and the owner declined to stand one up
(ADR-027 amendment A-1). No answer run, sheet, judgments file or verdict
document exists: no human answer-correctness judging was taken for #1619
(A-5), and O15's labelling pass has not run, so `--unblind` would refuse the
sheet on the counts.

## Errata on the two 2026-09-16 files — read before quoting them

The 2026-09-18 pair is not affected by either erratum: it was captured after
`a34eec38`, so its `queryCostMs` fields are true percentiles.

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
