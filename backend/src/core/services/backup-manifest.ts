import { z } from 'zod';

export const BackupManifestSchema = z
  .object({
    version: z.literal(1),
    createdAt: z.string().datetime(),
    schemaMigration: z.string().min(1).max(255),
    patEncryptionKeyFingerprint: z.string().regex(/^sha256:[0-9a-f]{32}$/),
    databaseSizeBytes: z.number().int().nonnegative(),
    checksums: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)),
    format: z.literal('cpqarc1'),
  })
  .strict();

export type BackupManifest = z.infer<typeof BackupManifestSchema>;

export function parseBackupManifest(raw: string): BackupManifest {
  try {
    return BackupManifestSchema.parse(JSON.parse(raw));
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : '';
    throw new Error(`Invalid backup manifest${detail}`, { cause: error });
  }
}
