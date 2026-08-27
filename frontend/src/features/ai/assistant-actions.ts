import { IMPROVEMENT_TYPES, type ImprovementType } from './improvement-types';
import { CREATE_SKILLS } from './create-skills';

/**
 * What the one control beside Send can be set to.
 *
 * The types and the allow-lists live in this leaf module rather than in
 * `AssistantActionSelect.tsx` (which is where the types used to live) because
 * `AssistantActionSelect` imports `AiContext`, and `AiContext` now has to read
 * the `/ai` list to decide which `?mode=` deep links it accepts — putting the
 * list in the component would close that import cycle. Same shape and same
 * argument as `improvement-types.ts`. `create-skills.ts` has no imports at all,
 * so pulling it in here adds no edge.
 */
export type CreateSkillAction = 'create-spec' | 'create-guide' | 'create-notes' | 'create-postmortem' | 'create-custom';
export type AssistantAction = 'ask' | ImprovementType | 'diagram' | 'generate' | CreateSkillAction;

/**
 * The five #1401 create skills, as action ids.
 *
 * Derived from `CREATE_SKILLS` rather than restated, so a sixth skill added
 * there reaches both surfaces without this file changing — the same argument
 * `IMPROVEMENT_TYPES` makes one line down.
 */
export const CREATE_SKILL_ACTIONS: readonly CreateSkillAction[] = CREATE_SKILLS.map(
  (skill) => `create-${skill.id}` as CreateSkillAction,
);

/**
 * `/ai` (#1361, owner ruling 3 of 2026-08-22). Q&A, Generate and the create
 * skills — the actions that do not need an open document. The rewrite skills
 * and Diagram act ON the page you are reading, and `/ai` no longer carries a
 * page scope for them to act on: the Pages tree has left the rail and
 * `resolveAiPageId` answers `null` on an AI route. The create skills are the
 * opposite case — they produce a new page, which is what this surface is for.
 */
export const AI_HOME_ACTIONS: readonly AssistantAction[] = ['ask', 'generate', ...CREATE_SKILL_ACTIONS];

/**
 * The article-side dock acts on the open page. It keeps Q&A, rewrite,
 * Diagram, and plain Generate, but deliberately omits the five create-* menu
 * entries: those named templates remain available from `/ai` and the dock's
 * new-page empty state rather than crowding the in-page Skill menu.
 */
export const DOCK_ACTIONS: readonly AssistantAction[] = [
  'ask', ...IMPROVEMENT_TYPES, 'diagram', 'generate',
];

/**
 * Narrows a raw `?mode=` value to the modes an AI route accepts.
 *
 * A predicate rather than `AI_HOME_ACTIONS.includes(value)` because the caller
 * needs the *type* narrowing, and because the two lists answer different
 * questions: `AI_HOME_ACTIONS` is what the MENU offers, and it carries the five
 * improvement types' shape plus five `create-*` ids, none of which is a `Mode`.
 * A create skill is never a URL value at all — the URL carries `mode=generate`
 * and the skill is picked in-app.
 */
export function isAiHomeAction(value: string): value is 'ask' | 'generate' {
  return value === 'ask' || value === 'generate';
}
