/**
 * The settled neutral-chip recipe for CATEGORY and MEASUREMENT chips —
 * Local/Confluence, Shared/Private, Draft, the RBAC principal type, page
 * freshness. One recipe, stated once, because it was measured once:
 *
 * The fill is the compositing tint `bg-foreground/10`, never `bg-muted`.
 * Chips on hoverable rows share their row's `hover:bg-accent` ground, and in
 * Graphite accent == muted (1.00:1 measured), so a bg-muted chip vanished
 * exactly while being pointed at. The tint steps up from ANY ground it lands
 * on — measured 1.29/1.32:1 against Graphite's resting/hovered rows and
 * 1.23/1.22:1 against Paper's — and the `border-border` hairline keeps the
 * shape defined where the step is subtle.
 *
 * The label ink is `text-secondary-foreground`, never muted: the tint darkens
 * the ground under an 11px label, and muted-fg measured 3.85:1 on a hovered
 * Paper row — under AA. The secondary ink measures 8.58/7.31:1 (Graphite
 * resting/hovered) and 9.73/7.98:1 (Paper) — 7.3:1+ on every ground these
 * chips sit on, elevated hover cards included.
 *
 * The one deliberate holdout is EmbeddingStatusBadge's resting states, which
 * keep `bg-muted` on ArticleRightPane's non-hovering nm-card, where muted is a
 * real value step — check the ground before "unifying" in either direction.
 */

/** Just the fill + ink pair, for chips that carry their own geometry. */
export const neutralChipInk = 'bg-foreground/10 text-secondary-foreground';

/** The full row-chip class, as worn by the PagesPage / PageViewPage badges. */
export const neutralChipClass = `inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] font-medium ${neutralChipInk}`;
