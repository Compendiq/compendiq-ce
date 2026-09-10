# Synthetic duplicative corpus — #1109

These pages are **hand-authored by this project**, not vendored. Nothing here is
third-party content, so `../corpus/LICENSE-ATTRIBUTION.md` does not apply to it,
and `scripts/vendor-eval-corpus.ts` neither generates nor touches this directory —
that script rebuilds `../corpus/MANIFEST.json` from scratch on every `--update`,
so anything hand-added there would be silently deleted. That is why this is a
separate directory with its own manifest.

## Why it exists

#1109 proposes an MMR diversity pass. Its Corrections require re-checking that
the change still has a target after #1104 (rerank) and #1106 (page-merge), and
the measurement said the target is nearly gone on the vendored corpus:

- mean pairwise trigram similarity among returned results: **0.252**
- pairs above 0.70: **17 of 1,520 (1.1%)**
- queries that both miss at rank 5 **and** contain a near-duplicate: **0**

That last figure is the problem. On public documentation, near-duplicates
cluster in well-covered topics, and well-covered topics are the ones retrieval
already gets right — so no query exists where evicting a redundant result could
free a slot for the right answer. The fixture cannot falsify MMR either way,
which makes "no credible change" an uninformative verdict rather than a passing
one.

A real Confluence knowledge base looks nothing like that. It accumulates copied
runbooks, per-team variants and annual re-issues, because copying a page is
easier than factoring one. These pages reproduce that shape.

## What is here

| Family | Pages | Pattern |
|---|---|---|
| `deployment-runbook` | 6 | The same runbook copied per team, differing only in team name, service, rota and channel — the classic "we forked the template" case. |
| `annual-security-review` | 4 | The same review re-issued yearly, differing in figures and status; older editions retained unedited for audit. |
| `deployment-topic` | 3 | **Distinct** pages on sub-topics the runbooks mention only in passing (rollback, freeze calendar, canary analysis). These are the pages a diversity pass would need to surface. |

The third group is what makes the first two measurable. Each runbook says to
"follow the platform rollback procedure" and to "check the freeze calendar"
without containing those procedures, so a question about rolling back matches
all six runbooks weakly and the one correct page strongly — the crowding
scenario MMR claims to fix.

## What this corpus does and does not measure

It measures **efficacy**: given that near-duplicates crowd a result set, does a
diversity pass recover the distinct page that belongs there? That question is
answerable here and was not answerable before.

It does **not** measure **frequency**: how often real users hit that situation.
These pages were authored to exhibit the condition, so counting how often the
condition occurs in this corpus would be circular. Frequency needs a real
knowledge base, and any claim about production impact has to come from there.

Keeping that distinction explicit is the point of this file. A synthetic corpus
that quietly gets read as evidence of impact is worse than no corpus.
