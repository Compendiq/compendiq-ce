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

/**
 * URLs to try for GET /models. Nested first (`…/embeddings/models`), then the
 * sibling root (`…/v1/models`) when the stored URL is a resource endpoint.
 */
export function listModelsCandidateUrls(baseUrl: string): string[] {
  const nested = providerResourceUrl(baseUrl, 'models');
  const urls = [nested];
  const base = baseUrl.replace(/\/+$/, '');
  for (const suffix of PROVIDER_RESOURCE_SUFFIXES) {
    if (suffix === '/models') continue;
    if (!base.endsWith(suffix)) continue;
    const sibling = `${base.slice(0, -suffix.length).replace(/\/+$/, '')}/models`;
    if (sibling !== nested) urls.push(sibling);
    break;
  }
  return urls;
}
