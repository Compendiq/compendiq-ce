// #350: clickable example prompts shown on the empty state of the Ask mode.
// Extracted from AskMode.tsx so the file only exports React components, which
// keeps `react-refresh/only-export-components` happy (the rule's
// `allowConstantExport` option only whitelists primitives, not arrays).
//
// Each prompt fills the input rather than auto-submits — auto-submit would
// surprise the user.
export const ASK_EXAMPLE_PROMPTS: readonly string[] = [
  'Summarise the most-edited pages in the last 30 days',
  'Find pages that look like duplicates of each other',
  'Draft a how-to from pages tagged "onboarding"',
  'What changed in the engineering space in the last 7 days?',
];
