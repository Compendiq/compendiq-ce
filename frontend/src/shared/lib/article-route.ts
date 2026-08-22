/**
 * True for an article route (`/pages/:id` or `/pages/new`) that hosts
 * the article chassis, inspector rail, and layout controls.
 */
export function isArticlePath(pathname: string): boolean {
  return /^\/pages\/[^/]+$/.test(pathname);
}

/**
 * True for an existing article (`/pages/:id`), never for the create form.
 */
export function isExistingArticlePath(pathname: string): boolean {
  return /^\/pages\/(?!new$)[^/]+$/.test(pathname);
}

