import { common, createLowlight } from 'lowlight';

/**
 * Shared lowlight instance pre-loaded with common language grammars.
 * Reused across Editor and ArticleViewer to avoid parsing 180+ grammars twice.
 */
export const lowlight = createLowlight(common);

/** Sorted list of language names registered in the shared lowlight instance. */
export const supportedLanguages = lowlight.listLanguages().sort();
