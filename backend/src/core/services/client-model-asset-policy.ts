import type { Readable } from 'node:stream';
import type { ClientAssetManifest } from '@compendiq/contracts';

export interface VerifiedClientAsset {
  size: number;
  etag: string;
  stream(range?: { start: number; end: number }): Promise<Readable>;
  dispose(): Promise<void>;
}

interface ClientModelAssetPolicy {
  beforeHubRequest(): Promise<void>;
  resolveFile(modelId: string, file: string): Promise<VerifiedClientAsset | null>;
  listAssets(slmEnabled: boolean): Promise<ClientAssetManifest['models']>;
}

// Registrations belong to app lifetimes. Closing either of two app instances
// removes only its own policy; the other instance stays protected.
const registrations: Array<{ policy: ClientModelAssetPolicy }> = [];

export function setClientModelAssetPolicy(policy: ClientModelAssetPolicy | null): () => void {
  if (policy === null) {
    registrations.length = 0;
    return () => {};
  }
  const registration = { policy };
  registrations.push(registration);
  return () => {
    const index = registrations.indexOf(registration);
    if (index !== -1) registrations.splice(index, 1);
  };
}

export async function assertClientModelHubEgressAllowed(): Promise<void> {
  await registrations.at(-1)?.policy.beforeHubRequest();
}

export async function resolvePolicyClientAsset(
  modelId: string,
  file: string,
): Promise<VerifiedClientAsset | null> {
  return await registrations.at(-1)?.policy.resolveFile(modelId, file) ?? null;
}

export async function listPolicyClientAssets(
  slmEnabled: boolean,
): Promise<ClientAssetManifest['models']> {
  return await registrations.at(-1)?.policy.listAssets(slmEnabled) ?? [];
}
