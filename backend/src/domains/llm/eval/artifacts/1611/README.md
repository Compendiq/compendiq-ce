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
| `control-<en\|de>-<A\|B\|C>.json` | `scripts/run-retrieval-eval.ts --lang … --out …` on that arm's revision AND index state | the text-gate reports the pooled non-inferiority controls read — B vs C, and C vs A when `--control-a` is passed. One file per arm per language: the recipe never passes a file it did not produce |

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

## Why this directory is empty (2026-09-15)

No arm can be captured on this checkout today, and none has been:

- **The text embedder is unreachable.** Every arm holds Qwen3-Embedding-4B
  fixed, served by the only configured provider (`RTX3090`,
  `http://192.168.178.47:1234/v1`), which is down. Not even arm C's
  retrieval run (which needs nothing but the text embedder) can be made.
- **Arm A needs a real VL *embedding* endpoint** (production vLLM, ADR-027
  "Arms and revisions"). None exists. The local shim satisfies
  `EVAL_IMAGE_EMBEDDING_*` and **nothing in the harness can tell it apart
  from a production endpoint** — the endpoint is recorded in the report
  (`visionModel`, `imageIndexIdentity`) and pointing arm A at the shim is an
  operator error the artifact makes visible, not a refusal.
- **Arms B and true C need the candidate revision** (post-#1617, with
  `page_image_analyses` and D11's `derived` provenance) and, for B, a vision
  model assigned to `image_analysis` plus a completed backfill. This
  checkout (`dev` @ e398de4a + PR2) has neither, and `--arm B` refuses on it
  right after the migrations — before the corpus is seeded — because the
  table, the assignment and the `image_analysis_max_output_tokens` are read
  there.
- **The image-dependent labels do not exist yet.** O2's 190 image-dependent
  and 48 image-negative labels come from O15's independent labelling pass;
  the fixture carries the fields (`imageDependent`, `class`) and no values,
  and `--unblind` refuses to decide below the counts.

When `RTX3090` is back, the first capture is the **legacy-revision C
control** (`--arm C --control legacy-revision-C` on `dev` @ e398de4a with
`image_embedding` unassigned, plus its EN/DE controls) — a regression
control for #1617's authored-hit change, labelled as such and never
substituted for C. Arm A follows when a VL embedding endpoint exists; B and
true C when #1617 has merged. #1619 runs the protocol.
