/**
 * App route paths referenced from more than one module.
 *
 * Lives in `shared/` so both `shared/` components and `features/` code can
 * import it (frontend layering: `features/` → `shared/` only, never the
 * reverse). Most routes are defined once in App.tsx / settings-nav.ts and
 * need no constant — add one here only when a literal would otherwise be
 * duplicated across the `shared/` ↔ `features/` boundary.
 */

/**
 * Settings → Confluence tab — always visible to every role.
 *
 * Must match the path settings-nav.ts derives for the `personal/confluence`
 * nav item (`/settings/<category>/<item>`); settings-nav.test.ts guards the
 * two against drifting apart.
 */
export const CONFLUENCE_SETTINGS_PATH = '/settings/personal/confluence';

/**
 * Rail label of the Settings → AI Models panel (admin LLM / embedding /
 * workers configuration), for `shared/` copy that names the panel without
 * importing `features/settings/settings-nav`.
 *
 * Must match the label of the `ai/models` nav item; settings-nav.test.ts
 * guards the two against drifting apart, and settings-wayfinding.test.ts
 * holds wayfinding copy to it.
 */
export const AI_MODELS_SETTINGS_LABEL = 'AI Models';
