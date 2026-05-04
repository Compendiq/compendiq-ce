import { isDbAvailable, setupTestDb, truncateAllTables } from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';
import { createProvider, setDefaultProvider } from './llm-provider-service.js';
import { bumpProviderCacheVersion } from './cache-bus.js';
import type { LlmUsecase } from '@compendiq/contracts';

export const dbAvailable = await isDbAvailable();

export { setupTestDb };

export interface SeedProviderInput {
  name: string;
  baseUrl: string;
  defaultModel?: string | null;
  isDefault?: boolean;
}

export async function seedProvider(input: SeedProviderInput): Promise<string> {
  const provider = await createProvider({
    name: input.name,
    baseUrl: input.baseUrl,
    authType: 'none',
    verifySsl: true,
    defaultModel: input.defaultModel ?? null,
  });
  if (input.isDefault) {
    await setDefaultProvider(provider.id);
  }
  return provider.id;
}

export async function setUsecaseAssignment(
  usecase: LlmUsecase,
  assignment: { providerId: string | null; model: string | null },
): Promise<void> {
  await query(
    `INSERT INTO llm_usecase_assignments (usecase, provider_id, model)
       VALUES ($1, $2, $3)
       ON CONFLICT (usecase) DO UPDATE
         SET provider_id = EXCLUDED.provider_id,
             model = EXCLUDED.model`,
    [usecase, assignment.providerId, assignment.model],
  );
}

export async function resetLlmTables(): Promise<void> {
  await truncateAllTables();
  bumpProviderCacheVersion();
}
