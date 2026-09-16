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
