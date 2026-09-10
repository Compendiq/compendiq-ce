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
 * POST URL for a resource on a stored provider base URL.
 *
 * The row is stored as typed. If it already ends with this resource
 * (`…/v1/embeddings` + `embeddings`), do not append it again. If it ends with
 * a different known resource, swap to this one so Test connection on an
 * embeddings row still hits `/models` on the same `/v1` root. Otherwise append.
 */
export function providerResourceUrl(baseUrl: string, resource: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const path = resource.replace(/^\/+/, '');
  if (base.endsWith(`/${path}`)) return base;
  let root = base;
  for (const suffix of PROVIDER_RESOURCE_SUFFIXES) {
    if (root.endsWith(suffix)) {
      root = root.slice(0, -suffix.length).replace(/\/+$/, '');
      break;
    }
  }
  return `${root}/${path}`;
}
