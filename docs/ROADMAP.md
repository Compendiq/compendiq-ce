# Compendiq Public Roadmap

_Maintained alongside v0.4.0 (CE #297)._

The public roadmap lives as a **GitHub Projects v2** board at:

> _[TODO founder — paste the board URL once the org-level project is created, e.g. `https://github.com/orgs/Compendiq/projects/<N>`]_

This file in the repo is the **stable, human-readable index** that survives board renames and URL changes. It documents:

1. where the live board lives,
2. how the columns are organised,
3. what the maintenance cadence is, and
4. how to filter for the slice you care about.

Issue activity itself (the source of truth for "what's planned / what's shipping") always lives on the board.

---

## Columns

| Column   | Criterion                                                                  |
|----------|----------------------------------------------------------------------------|
| **Now**     | Issues tagged `phase-1.2` and open — the release currently in flight.       |
| **Next**    | Issues tagged `phase-1.3` — the release after `Now`.                        |
| **Later**   | Issues tagged `phase-2.0` / `phase-3.0` — 6-month+ horizon.                 |
| **Idea**    | Open enhancements without a phase label — long tail, no schedule.           |
| **Shipped** | Closed issues from the last 90 days — "what landed recently".              |

The column → label mapping is deterministic: when an issue's phase label changes, the board re-sorts it automatically on the next refresh.

## Filters

Use the board's built-in filters to slice by:

- **`label:backend`** / **`label:frontend`** — split by surface area
- **`label:enterprise`** — EE-gated issues only
- **`label:priority:high`** — the hot stuff
- **`is:pr`** — drop issues and see in-flight PRs against the same phase labels

## Cadence

- **Monthly** — the maintainer scrubs the board at the start of each month: retire stale `Idea`s older than 1 year, move anything that's picked up into `Now`, and ensure the `Shipped` column reflects the last 90 days.
- **Per-release** — at every `dev → main` merge, the `Shipped` column is trimmed and the `Now` column is re-populated from the next phase's milestone.
- **Ad-hoc** — contributors adding a new issue should apply the appropriate `phase-*` label at triage; `gh-issue-reviewer` validates label presence during PR review.

## Cross-repo coverage

The org-level project aggregates issues from:
- `Compendiq/compendiq-ce` (this repository, AGPL-3.0)
- `Compendiq/compendiq-enterprise` (private, EE)
- `Compendiq/compendiq-mgmt` (private, multi-instance management)

If a board filter appears to be missing an issue, check the phase label in the originating repo.

## Stewardship link

The public roadmap is part of the open-process commitment documented in [`docs/STEWARDSHIP.md`](./STEWARDSHIP.md). Material changes to CE scope are always announced via the roadmap **before** they ship — see the stewardship doc for the full commitment text.

---

<!--
Founder: to operationalise this file:
  [ ] Create the org-level GitHub Projects v2 board and paste the URL at the top of this file.
  [ ] Configure the 5 columns above using "Group by: label" → phase-* with the column names.
  [ ] Pin the project to the Compendiq org page for discoverability.
  [ ] Pre-create the `phase-1.3`, `phase-2.0`, `phase-3.0` labels in both CE and EE
      (colour #0E8A16 to match existing phase labels).
  [ ] Add a milestone for each future phase and back-label existing open issues.
-->
