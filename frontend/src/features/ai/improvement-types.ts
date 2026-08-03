import { ImprovementTypeSchema, type ImprovementType } from '@compendiq/contracts';

/**
 * The five improvement passes, in the order every picker shows them.
 *
 * Derived from the contract rather than restated. `ImprovementTypeSchema` is
 * what `/llm/improve` validates its `type` against and what the backend
 * resolves `improve_<type>` prompts from, so a sixth pass added there reaches
 * both pickers without either being edited — and, more to the point, a
 * hand-written copy of this list cannot drift out of step with the enum the
 * server enforces.
 */
export const IMPROVEMENT_TYPES = ImprovementTypeSchema.options;

/**
 * What each pass actually changes, in the product's own language.
 *
 * UI copy, so it lives here rather than in the contract — the schema has no
 * business carrying tooltip text. The `Record<ImprovementType, …>` is the point
 * of the file: a type added to the enum fails the build here until somebody
 * says what it does.
 */
export const IMPROVEMENT_DESCRIPTIONS: Record<ImprovementType, string> = {
  grammar: 'Fix spelling, grammar, and punctuation without changing meaning',
  structure: 'Reorganize headings, paragraph flow, and logical order',
  clarity: 'Simplify complex sentences and remove unnecessary jargon',
  technical: 'Fix technical errors and add missing technical details',
  completeness: 'Fill gaps, add missing sections, and include examples',
};

/**
 * The pass every surface starts on.
 *
 * Named rather than inlined because three places have to agree on it:
 * `AiContext`'s initial state, the dock chip's default tooltip, and the dock
 * chip's label — which names the type only when it is *not* this one.
 */
export const DEFAULT_IMPROVEMENT_TYPE: ImprovementType = 'grammar';

export type { ImprovementType };
