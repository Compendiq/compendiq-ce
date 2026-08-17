/**
 * True for an existing article (`/pages/:id`), never for the create form.
 *
 * `/pages/new` matches the naive `/pages/:id` pattern, so treating it as an
 * article mounted the inspector, the dock, and layout presets on a document
 * that does not exist yet.
 */
export function isExistingArticlePath(pathname: string): boolean {
  return /^\/pages\/(?!new$)[^/]+$/.test(pathname);
}
