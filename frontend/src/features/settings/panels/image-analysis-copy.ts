/**
 * #1615 (ADR-027 D7) — the re-analysis disclosure, shared by the assignment
 * save in `LlmTab` and the Re-check in `ImageAnalysisCard`: both routes can
 * adopt a new model identity, and both answer with the count of analyzed rows
 * that adoption invalidated. Amber wherever it is shown — the next run spends
 * a vision call per row — and never shown for a resume (0).
 */
export function reanalysisDisclosure(rows: number): string {
  return `${rows} ${rows === 1 ? 'image analysis is' : 'image analyses are'} no longer valid under the new model identity and will be re-analyzed on the next run. Stored descriptions are kept until then.`;
}

/**
 * #1618 (ADR-027 D7/D13) — the disclosure Re-analyze all shows BEFORE it
 * executes, seeded from the counts the card already holds.
 *
 * Deliberately NOT `reanalysisDisclosure` above. That sentence describes an
 * identity CHANGE, where only the rows a new identity invalidated are
 * re-analyzed and the stored descriptions survive until they are; this action
 * nulls every payload, valid ones included, so the two costs and the two
 * recoveries are different and one sentence cannot carry both.
 *
 * Three facts in the order an operator weighs them: what it will spend, what
 * it destroys, and what keeps working while it runs.
 *
 * `rows === null` is "the status could not be read" — a failed status GET
 * leaves the card's last payload in the cache, and a destructive action's
 * disclosure must not quote a scope off a record the card has declared
 * unobservable. The spend is then stated as the SET it covers rather than as
 * a number, and the operator is sent to the read that can give them the
 * count. The other two facts are properties of the action and hold either
 * way.
 */
export function reanalyzeAllDisclosure(rows: number | null): string {
  const spend =
    rows === null
      ? 'The analysis status could not be read, so how many images this covers is unknown. It re-analyzes every stored, stale, failed and given-up image — one vision call each'
      : `This re-analyzes ${rows} ${rows === 1 ? 'image' : 'images'} — one vision call each`;
  const count = rows === null ? ' Retry the status read first if you need the count.' : '';
  return `${spend} — and clears their stored descriptions first, so image evidence is missing from search until each page is analyzed and re-embedded. Authored page text stays searchable throughout. Use Retry failed instead if you only need the failures.${count}`;
}
