/**
 * OpenAI-compatible resource paths an operator may paste as a full endpoint.
 * Longer suffixes first so `/chat/completions` wins over `/completions`.
 */
export const PROVIDER_RESOURCE_SUFFIXES = [
  '/chat/completions',
  '/embeddings',
  '/completions',
  '/models',
  '/rerank',
] as const;

export type ListedModelKind = 'embeddings' | 'rerank';

/**
 * POST/GET URL for a resource on a stored provider base URL.
 *
 * The row is stored as typed. If it already ends with this resource
 * (`…/v1/embeddings` + `embeddings`), do not append it again. Otherwise append.
 * Nested catalogs stay nested: `…/v1/embeddings` + `models` is
 * `…/v1/embeddings/models` (OpenRouter), not `…/v1/models`.
 */
export function providerResourceUrl(baseUrl: string, resource: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const path = resource.replace(/^\/+/, '');
  if (base.endsWith(`/${path}`)) return base;
  return `${base}/${path}`;
}

export function listedModelKindForUrl(baseUrl: string): ListedModelKind | null {
  const base = baseUrl.replace(/\/+$/, '');
  if (base.endsWith('/rerank')) return 'rerank';
  if (base.endsWith('/embeddings')) return 'embeddings';
  return null;
}

function apiRootForResourceUrl(baseUrl: string): string | null {
  const base = baseUrl.replace(/\/+$/, '');
  for (const suffix of PROVIDER_RESOURCE_SUFFIXES) {
    if (suffix === '/models') continue;
    if (!base.endsWith(suffix)) continue;
    return base.slice(0, -suffix.length).replace(/\/+$/, '');
  }
  return null;
}

/**
 * URLs to try for GET /models.
 *
 * Nested first (`…/embeddings/models`). For a stored rerank/embeddings
 * endpoint, the unfiltered sibling `/models` is the chat catalog (OpenRouter
 * returns hundreds of text models). Ask for the matching output modality
 * before falling back to that unfiltered list.
 */
export function listModelsCandidateUrls(baseUrl: string): string[] {
  const nested = providerResourceUrl(baseUrl, 'models');
  const urls = [nested];
  const root = apiRootForResourceUrl(baseUrl);
  if (!root) return urls;
  const kind = listedModelKindForUrl(baseUrl);
  if (kind) {
    const filtered = `${root}/models?output_modalities=${kind}`;
    if (!urls.includes(filtered)) urls.push(filtered);
  }
  const sibling = `${root}/models`;
  if (!urls.includes(sibling)) urls.push(sibling);
  return urls;
}

const RERANK_NAME = /rerank|cross-encoder|colbert/i;
const EMBEDDING_NAME =
  /embed|bge-m3|bge-large|bge-small|bge-base|e5-|gte-|minilm|nomic|snowflake-arctic|text-embedding|voyage|instructor|mxbai|granite-embedding/i;

export function listedModelMatchesKind(kind: ListedModelKind, name: string): boolean {
  if (kind === 'rerank') return RERANK_NAME.test(name);
  return !RERANK_NAME.test(name) && EMBEDDING_NAME.test(name);
}

export type ListedModelRow = {
  id: string;
  architecture?: { output_modalities?: string[] };
};

/** Drop chat models when the stored URL is an embeddings or rerank endpoint. */
export function filterListedModels(
  baseUrl: string,
  rows: readonly ListedModelRow[],
): { name: string }[] {
  const kind = listedModelKindForUrl(baseUrl);
  if (!kind) return rows.map((row) => ({ name: row.id }));
  const modality = kind;
  const byModality = rows.filter((row) =>
    row.architecture?.output_modalities?.includes(modality),
  );
  const kept = byModality.length > 0
    ? byModality
    : rows.filter((row) => listedModelMatchesKind(kind, row.id));
  return kept.map((row) => ({ name: row.id }));
}
