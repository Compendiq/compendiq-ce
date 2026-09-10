import type { ImprovementType } from '@compendiq/contracts';

/**
 * #708 / #1179 — the quick actions and prompt steering shared by every inline
 * "Improve with AI" surface in the editor: the selection bubble menu
 * (`EditorBubbleMenu`) and the block context menu (`EditorBlockMenu`).
 *
 * Kept in a plain `.ts` module rather than exported from either component so
 * neither has to widen its public surface (and so react-refresh keeps treating
 * both files as component-only modules).
 */

export interface QuickAction {
  key: string;
  label: string;
  type: ImprovementType;
  /** Extra instruction passed to `/llm/improve` for tone/length variants. */
  instruction?: string;
}

// Quick actions map onto the backend's five `ImprovementType` values. Tone /
// length variants ride on the optional `instruction` field rather than new
// backend types, keeping v1 within the existing `/llm/improve` contract.
export const QUICK_ACTIONS: readonly QuickAction[] = [
  { key: 'improve', label: 'Improve writing', type: 'clarity' },
  { key: 'grammar', label: 'Fix spelling & grammar', type: 'grammar' },
  {
    key: 'shorter', label: 'Make shorter', type: 'clarity',
    instruction: 'Make the passage more concise while preserving all key information.',
  },
  {
    key: 'longer', label: 'Make longer', type: 'completeness',
    instruction: 'Expand the passage with more detail and helpful examples.',
  },
  {
    key: 'professional', label: 'More professional tone', type: 'clarity',
    instruction: 'Rewrite the passage in a more professional, formal tone.',
  },
];

// Selection-specific prompt steering: the `improve_*` system prompts assume a
// whole article, so we pass an instruction that scopes the model to the passage
// and forbids extra commentary. (#708 — "improve the following passage; return
// only the improved passage, same language".)
export const SELECTION_INSTRUCTION =
  'You are improving a SHORT SELECTED PASSAGE from a larger document, not the whole document. ' +
  'Return ONLY the improved passage with no preamble, headings, or explanation, and keep it in the same language.';

// #1179 — the block menu sends one whole block (a paragraph, heading, quote or
// list item). Same contract as above, but the model is told it is looking at a
// complete block so it does not try to "finish" a sentence it thinks was cut.
export const BLOCK_INSTRUCTION =
  'You are improving ONE COMPLETE BLOCK (a paragraph, heading, quote or list item) from a larger document, ' +
  'not the whole document. Return ONLY the improved block with no preamble, headings, or explanation, ' +
  'and keep it in the same language.';

/**
 * Compose the instruction sent with a quick action: the surface's base scoping
 * sentence, then the action's own steering, then whatever the user typed.
 */
export function buildInstruction(
  action: QuickAction,
  freeForm?: string,
  base: string = SELECTION_INSTRUCTION,
): string {
  const parts = [base];
  if (action.instruction) parts.push(action.instruction);
  if (freeForm?.trim()) parts.push(freeForm.trim());
  return parts.join('\n\n');
}
