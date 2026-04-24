# Compendiq Roadmap

This file is the stable, human-readable index for what's in flight on Compendiq, what's queued next, and what recently shipped. It is part of the open-process commitment documented in [`STEWARDSHIP.md`](./STEWARDSHIP.md).

The source of truth is the [issue tracker](https://github.com/Compendiq/compendiq-ce/issues), filtered by phase label. This file exists so that readers have a one-page answer to "where is Compendiq going" without having to learn the label taxonomy first.

## How to browse

| You want to see… | Do this |
|---|---|
| What's shipping in the release currently in flight | `is:issue is:open label:phase-1.2` |
| What's queued for the release after that | `is:issue is:open label:phase-1.3` |
| What's on the 6-month+ horizon | `is:issue is:open label:phase-2.0 label:phase-3.0` |
| Open enhancements without a phase yet | `is:issue is:open label:enhancement -label:phase-1.2 -label:phase-1.3 -label:phase-2.0 -label:phase-3.0` |
| What landed recently | `is:issue is:closed closed:>2026-01-24` (rolling 90 days) |
| In-flight PRs for the current phase | `is:pr is:open label:phase-1.2` |

Ready-made queries live under [`github.com/Compendiq/compendiq-ce/issues`](https://github.com/Compendiq/compendiq-ce/issues); copy the filter above into the search bar.

## Split by surface

- `label:backend` — server-side work
- `label:frontend` — UI work
- `label:enterprise` — EE-gated issues (tracked here or in [`compendiq-enterprise`](https://github.com/Compendiq/compendiq-enterprise) depending on where the implementation lives)
- `label:documentation` — docs-only issues
- `label:priority:high` — the hot stuff

## Cadence

- **Per-release** — at every `dev → main` merge the release epic issue (e.g. `[phase-1.2 epic]`) is closed and the next phase's milestone starts getting populated. Closed release epics are the best summary of what actually shipped.
- **Ad-hoc** — contributors adding a new issue should apply the appropriate `phase-*` label at triage; if the label is missing, the maintainer adds it during the normal triage pass.
- **Stewardship** — material changes to CE scope are always announced on the issue tracker **before** they ship. See [`STEWARDSHIP.md`](./STEWARDSHIP.md) for the full commitment.

## Cross-repo coverage

Issue activity relevant to Compendiq is split across three repositories:

- [`Compendiq/compendiq-ce`](https://github.com/Compendiq/compendiq-ce) — this repository, AGPL-3.0, the Community Edition
- [`Compendiq/compendiq-enterprise`](https://github.com/Compendiq/compendiq-enterprise) — private, EE-only
- `Compendiq/compendiq-mgmt` — private, multi-instance management

If you're hunting an issue that you know is tracked by the Compendiq maintainers but can't find in this repo, it probably lives in one of the other two. Feature parity between repos is not a goal — each repo tracks only work that will land in its own tree.
