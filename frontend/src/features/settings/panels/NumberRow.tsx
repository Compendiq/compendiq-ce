import { useState, useEffect } from 'react';

/**
 * A numeric settings field: label, unit, bounds, decimals. `key` doubles as
 * the input id and the `data-testid` suffix, so it must be unique on the page.
 */
export interface NumericField<K extends string = string> {
  key: K;
  label: string;
  /** Unit shown after the input. Empty for a bare ratio. */
  unit?: string;
  min: number;
  max: number;
  step: number;
  /** Decimal places used when resetting / formatting the default. */
  decimals?: number;
}

/** Strips floating-point noise from a stepped input without changing the value. */
function round(value: number, decimals: number | undefined): number {
  if (decimals === undefined) return value;
  return Number(value.toFixed(decimals));
}

/**
 * A number input that clamps on COMMIT, not on keystroke.
 *
 * Clamping in `onChange` — which is what the sibling rate-limits panel does —
 * makes several of these fields untypeable: fetch width has a minimum of 10,
 * so typing "40" snaps to 10 after the first digit and the next keystroke
 * lands on "100". The keystroke belongs to the draft; the range belongs to the
 * committed value, which is also what Save diffs against, so a half-typed
 * number can never enable Save or reach the PUT.
 *
 * Extracted from `RetrievalTab.tsx` for #1615, whose image-analysis card
 * carries the `Max output tokens` row with the same commit semantics; the
 * `testIdPrefix` is what keeps the Retrieval tab's `retrieval-*` ids stable.
 */
export function NumberRow<K extends string>({
  field,
  value,
  onChange,
  defaultValue,
  disabled,
  describedBy,
  children,
  aside,
  testIdPrefix = 'retrieval',
}: {
  field: NumericField<K>;
  value: number;
  onChange: (value: number) => void;
  defaultValue: number;
  disabled?: boolean;
  /**
   * #1284 — the id of the paragraph that becomes this input's accessible
   * description. Today: the row's measured-distribution readout
   * ({@link distributionDescriptionId}).
   *
   * **Opt-in, never panel-wide** (review r1). A description flattens to one
   * string, so the region it names must be PROSE ONLY: three of this panel's
   * rows carry an operable child inside their help — the two wayfinding
   * `<Link>`s to LLM providers and `Use measured value` — and wiring those
   * announces a link and a button as description text with no way to act on
   * them, then repeats them on the next tab stop. The blanket form of this
   * prop shipped in the first cut of #1284 and did exactly that.
   *
   * **And it names ONE paragraph, not the help block** (review r1): the block
   * form made the rerank threshold's description 975 characters, re-read on
   * every focus, with the measurement it exists to carry at the far end of it.
   * `RetrievalTab.test.tsx` sweeps every `[aria-describedby]` the panel
   * renders and fails on any region holding something operable, so the
   * prose-only rule is enforced for all rows rather than spot-checked on one.
   */
  describedBy?: string;
  children?: React.ReactNode;
  /**
   * Everything under the row that is NOT description: an operable control, or
   * a wayfinding sentence pointing at another panel. Rendered in the same
   * muted block, immediately below the description and OUTSIDE it.
   *
   * Review r2 — `aria-describedby` flattens its region to a text string, so a
   * button folded into it announces as prose with no hint it can be pressed,
   * and a link announces as wayfinding the reader cannot act on from the
   * announcement. That is the exact reason the `RAG_EF_SEARCH` note sits
   * outside its row (see its comment in the Candidate pools section); the
   * blanket wiring above would otherwise have re-created it inside three
   * rows. `RetrievalTab.test.tsx` walks the region behind EVERY
   * `aria-describedby` on the panel — not only a field's — and fails if one
   * contains an interactive element; review r3 widened it from inputs and
   * selects after the calibration strip's `Keep` button turned out to be
   * described by a sentence carrying a wayfinding link.
   */
  aside?: React.ReactNode;
  /** Prefix of the input's and reset button's `data-testid`. */
  testIdPrefix?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  // Any committed change — Save's re-hydration, "reset to default", "use
  // measured value" — retires the draft so the field shows the real value.
  useEffect(() => setDraft(null), [value]);

  function commit() {
    if (draft === null) return;
    const raw = Number(draft);
    // An emptied field is not a value: fall back to what is committed rather
    // than inventing a 0 (which several of these knobs read as a kill switch).
    if (draft.trim() === '' || !Number.isFinite(raw)) {
      setDraft(null);
      return;
    }
    const clamped = round(Math.max(field.min, Math.min(field.max, raw)), field.decimals);
    setDraft(null);
    if (clamped !== value) onChange(clamped);
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-start justify-between gap-4">
        <label htmlFor={field.key} className="pt-1.5 text-sm font-medium">
          {field.label}
        </label>
        <div className="flex shrink-0 items-center gap-2">
          <input
            id={field.key}
            type="number"
            min={field.min}
            max={field.max}
            step={field.step}
            disabled={disabled}
            value={draft ?? String(value)}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
            }}
            // #1284/#1285 — confidence thresholds name their one measured
            // readout; every other knob names its prose-only help block. An
            // operable aside must never enter either description region.
            aria-describedby={describedBy ?? (children ? `${field.key}-help` : undefined)}
            className="w-24 rounded-md border border-border-interactive bg-background/50 px-3 py-1.5 text-right text-sm outline-none focus:ring-1 focus:ring-ring disabled:opacity-45"
            data-testid={`${testIdPrefix}-${field.key}`}
          />
          {field.unit && <span className="w-24 text-xs text-muted-foreground">{field.unit}</span>}
        </div>
      </div>
      {(children || aside) && (
        <div className="space-y-1.5 text-xs text-muted-foreground">
          {/* Only this half is the input's description — see `aside`'s JSDoc. */}
          <div id={`${field.key}-help`} className="space-y-1.5">
            {children}
          </div>
          {aside}
        </div>
      )}
      {value !== defaultValue && (
        <button
          type="button"
          onClick={() => onChange(defaultValue)}
          className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          data-testid={`${testIdPrefix}-${field.key}-reset`}
        >
          Reset to default ({defaultValue})
        </button>
      )}
    </div>
  );
}
