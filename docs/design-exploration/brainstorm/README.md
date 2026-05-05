# Theme brainstorm prototypes

Exploratory HTML prototypes from the v0.4 premium-themes overhaul (#30).
These are **not** production code — there is no runtime consumer of any
file in this directory. They are kept under `docs/` for reference: the
neumorphic system that shipped (Graphite Honey + Honey Linen) was
distilled from the surfaces, palettes, and shadow recipes explored here.

The two `session-*` folders are the original brainstorm session IDs from
the tooling that produced these files; they are preserved only to keep
the file history consistent with the original commits.

For the actual design system that shipped, see:

- `docs/ARCHITECTURE-DECISIONS.md` → ADR-010 v0.4 (neumorphic theme system)
- `frontend/src/index.css` → `@theme` + `[data-theme="honey-linen"]` blocks
- `frontend/src/stores/theme-store.ts` → THEME_IDS + theme metadata

These prototypes were moved here from `.superpowers/brainstorm/` in the
#30 review (they should never have lived inside the project root).
