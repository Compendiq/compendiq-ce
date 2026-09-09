export type ModelKindFilter = 'embedding' | 'rerank';

export function isRerankModel(name: string): boolean {
  return /rerank|cross-encoder|colbert/i.test(name);
}

export function isEmbeddingModel(name: string): boolean {
  return (
    !isRerankModel(name) &&
    /embed|bge-m3|bge-large|bge-small|bge-base|e5-|gte-|minilm|nomic|snowflake-arctic|text-embedding|voyage|instructor|mxbai|granite-embedding/i.test(
      name,
    )
  );
}

export function filterModelsForKind(
  names: readonly string[],
  kind: ModelKindFilter | undefined,
  selected: string | null,
): string[] {
  const matches = !kind ? () => true : kind === 'rerank' ? isRerankModel : isEmbeddingModel;
  const keepSelected = Boolean(selected);
  const filtered = names.filter((n) => matches(n) || (keepSelected && n === selected));
  if (keepSelected && selected && !filtered.includes(selected)) {
    filtered.push(selected);
  }
  return filtered;
}
