# Relocate an article between a local space and Confluence — dialog design (#1123)

Design of record for the **frontend** of #1123. The backend (routes, service,
migration 086, contracts) landed in PR #1164; nothing here proposes a server
change.

Related: [`../../architecture/04-frontend-structure.md`](../../architecture/04-frontend-structure.md),
[`../../architecture/11-content-pipeline.md`](../../architecture/11-content-pipeline.md).

## What the feature is

A page can live in exactly one of two systems. `pages.source` says which.
Relocating moves it across that boundary and is **not** reversible by an undo:

- **standalone → Confluence** creates the page upstream and *deletes every local
  `page_versions` row*. Confluence becomes the historian.
- **Confluence → local** flips the row local and then *deletes the Confluence
  page*, for everyone in Confluence.

Both directions also swap the access model wholesale — standalone
`private`/`shared` on one side, Confluence space RBAC on the other — so the set
of people who can read the article changes.

The UI's whole job is to make those three facts legible **before** the click,
using the numbers and names the server actually holds.

## Entry point

One control in the article action strip on `/pages/:id`, beside Verify / Graph /
Edit. It replaces the `Publish to Confluence coming soon` placeholder.

| `page.source` | Label | Icon |
| --- | --- | --- |
| `standalone` | Move to Confluence | `Upload` |
| `confluence` | Move to local space | `Download` |

**Gated on `usePermission('pages:relocate')`, and hidden — not disabled — when
denied.** `pages:relocate` is a global permission seeded onto `editor` and
`space_admin` by migration 086, and CE ships no admin UI for granting
permissions. A user without it has no in-product path to obtain it, so a
disabled control with a tooltip would be permanently dead chrome in an already
dense strip. The preview endpoint is itself gated on the same permission, so a
rendered control would 403 the moment it was used.

## The dialog

Radix `Dialog` (focus trap, Escape, `aria-modal`). A modal is right here: the
action is irreversible and needs protected focus, which is the one case the
"avoid modals" rule exempts.

### One dialog, not a wizard

Three shapes were considered:

1. **Single flat dialog** — everything at once.
2. **Two-step wizard** — pick destination, then review.
3. **Single dialog with progressive disclosure** — destination first, with the
   consequences panel on screen the whole time, visibly empty until a
   destination resolves it. ← chosen

The contract forces a two-phase fetch: `GET …/relocate/preview` with no
destination returns counts and generic prose, and only a re-fetch carrying the
chosen `spaceKey` / `visibility` names real principals. A wizard would put the
consequences behind a **Next**, and people click Next reflexively. Keeping the
consequence panel permanently visible means picking a destination *visibly
rewrites it* — the causal link is the thing that teaches. It also lets the
dialog carry the density this task needs (destination, four consequence facts,
two principal lists up to 50 entries, two acknowledgements) without a state
machine whose only real step is a `<select>`.

### Structure

```
Dialog (nm-card-elevated, flex column, max-h 85vh)
├── header      title · one-sentence consequence · close
├── body (scrolls)
│   ├── Where it goes        destination picker (+ visibility for → local)
│   ├── What this move does  <dl> ledger: versions · attachments · children · upstream page
│   └── Who can read it      from → to prose, then Gains / Loses principal lists
├── acknowledgements         checkboxes whose labels carry the real numbers/names
└── footer      error region (role="alert") · Cancel · confirm
```

Sections are separated by hairline rules and spacing. **No nested cards** — the
dialog is the card. Counts render in `font-mono tabular-nums`: the type system
reserves JetBrains Mono for data figures.

### Destination

- **→ Confluence**: `<select>` over `useSpaces()` filtered to
  `source === 'confluence'`. Required.
- **→ local**: `<select>` over `useLocalSpaces()` **plus an explicit
  "No space — personal article" option**, because `spaceKey: null` is legal for
  a standalone article; and a required `private` / `shared` radio group. The
  contract makes `visibility` non-defaulted on purpose — Confluence has no
  analogue to inherit from — so the UI starts it unselected rather than guessing.

### The preview re-fetch

`useRelocatePreview(pageId, destination)` keys on the destination, so choosing
one is a genuine dependent query, not a manual refetch.

**Only the → Confluence direction sends `spaceKey`.** The preview route
authorises a caller-supplied `spaceKey` against `getUserAccessibleSpaces`
(it feeds a space-membership enumeration, so the check is deliberate), and that
list is role-assigned *Confluence* spaces — a local space key would 403 for a
non-admin. The → local direction sends `visibility` alone, which is the only
field its `accessChange` depends on. The destination local space is displayed
from component state, and `subtreeEffect.childrenDetachFromOriginTree` is
already `true` for that direction because the page leaves its Confluence space
regardless.

### Access change

`accessChange.from` → `accessChange.to` as prose, then two lists side by side:

- **Gains access (n)** — `--color-success`, `UserPlus`.
- **Loses access (n)** — `--color-destructive`, `UserMinus`.

Each principal renders its `kind` with a distinct icon: `user` → `User`,
`group` → `Users`, `everyone` → `Globe`, `owner` → `KeyRound`. An empty list
reads **"Nobody"**, never an empty box. Each list scrolls inside its own
`max-h`, so 50 entries do not blow the dialog out.

`truncated` gets its own warning line — *"Only the first 50 assignments in this
space are listed. More people may be affected than shown."* — in
`--color-warning`, which is the palette's reserved warning role and therefore a
legitimate amber use.

Until a destination resolves, the section shows *"Choose a destination to see
exactly who gains and loses access."* rather than pretending the empty lists are
an answer.

### Acknowledgements

Both are `z.literal(true)` / echo-back fields the server re-verifies, so the
dialog's job is to make the labels carry the fact:

| Direction | Checkbox |
| --- | --- |
| both | *I understand this changes who can read the article.* → `acknowledgeAccessChange` |
| → Confluence, `localVersionCount > 0` | *Permanently delete this article's N local version(s). Confluence becomes its only history.* → `acknowledgeDiscardedVersions: N` |
| → local | *Delete "T" from Confluence space K. Everyone in Confluence loses the page.* → `confirmDeleteConfluencePage: { confluenceId, spaceKey }` |

When `localVersionCount === 0` the versions checkbox is **not rendered** — there
is nothing to destroy on that axis, and asking someone to tick "delete 0
versions" is noise. The request still echoes `acknowledgeDiscardedVersions: 0`,
so a race that creates a version between preview and submit still 409s. The
ledger states *"No local version history to discard"* so the absence is visible
rather than silent.

A type-to-confirm was rejected: the server already enforces the echo, and the
labels above already name what is destroyed. Adding one would be theatre.

### Confirm button weight

`isDestructive = target === 'local' || localVersionCount > 0`.

Destructive gets `nm-button-destructive`; otherwise `nm-button-primary`. Moving
a draft with no history into Confluence destroys nothing on our side, and
painting that red spends the meaning of red on a publish. A move to local always
deletes an upstream page, so it is always red.

### Errors

The server's message renders **inside** the dialog in a `role="alert"` region —
not a toast, which is easy to miss behind a modal. Every documented failure
lands here: 409 sync-in-flight, 409 stale version count, 409 mismatched
confirmation, 409 ambiguous identifier / attachment-name collision, 403 space
access, 400 not-configured / wrong-source-space, 404.

On a **409** the dialog also offers **Reload preview**, which refetches and
**clears both acknowledgements**. That second half is the point: after a stale
409 the numbers may have changed, so a still-ticked box would re-submit the same
stale echo and 409 again.

### Success

Invalidate `['pages']` (prefix-covers the list, the tree and `['pages', id]`),
`['spaces']` and `['local-spaces']` — page counts and the source badge all move.
The route is unchanged (`/pages/:id` still resolves), so the dialog closes and
the refetched detail re-renders the new location; no navigation. `warnings[]`
and `upstreamDeleted === false` surface as warning toasts, because both mean
"it worked, but read this".

## Files

| Path | Role |
| --- | --- |
| `frontend/src/shared/hooks/use-relocate.ts` | `useRelocatePreview` (dependent query) + `useRelocatePage` (mutation + invalidation) |
| `frontend/src/features/pages/RelocateDialog.tsx` | the dialog |
| `frontend/src/features/pages/PageViewPage.tsx` | permission-gated entry point |

## Testing

Network boundary only (`fetch` stubbed), per CLAUDE.md. The load-bearing cases:
counts + access prose + both principal lists incl. `truncated` and empty; the
dependent re-fetch firing on destination choice; the **exact request body** for
both arms of the discriminated union; permission gating; every error path; the
409 recovery clearing acknowledgements; and success invalidation.
