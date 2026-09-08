import { z } from 'zod';

export const BACKUP_SECRET_MASK = '••••••••';

export const BackupDestinationSchema = z.enum(['download', 's3']);
export type BackupDestination = z.infer<typeof BackupDestinationSchema>;

export const BackupRunStatusSchema = z.enum(['running', 'success', 'failed']);
export type BackupRunStatus = z.infer<typeof BackupRunStatusSchema>;

export const BackupRunSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
  destination: BackupDestinationSchema,
  status: BackupRunStatusSchema,
  bytes: z.number().int().nonnegative().nullable(),
  objectKey: z.string().nullable(),
  error: z.string().nullable(),
  triggeredBy: z.string().nullable(),
  jobId: z.string().nullable(),
});
export type BackupRun = z.infer<typeof BackupRunSchema>;

export const BackupS3ConfigSchema = z.object({
  enabled: z.boolean(),
  endpoint: z.string(),
  bucket: z.string(),
  region: z.string(),
  accessKey: z.string(),
  secretKey: z.string(),
  prefix: z.string(),
  forcePathStyle: z.boolean(),
  hasAccessKey: z.boolean(),
  hasSecretKey: z.boolean(),
});
export type BackupS3Config = z.infer<typeof BackupS3ConfigSchema>;

export const BackupScheduleConfigSchema = z.object({
  enabled: z.boolean(),
  intervalHours: z.number().int().min(1).max(168),
  retentionCount: z.number().int().min(1).max(100),
  retentionDays: z.number().int().min(1).max(365),
  lastRunAt: z.string().nullable(),
});
export type BackupScheduleConfig = z.infer<typeof BackupScheduleConfigSchema>;

export const BackupObjectLockConfigSchema = z.object({
  enabled: z.boolean(),
  mode: z.enum(['COMPLIANCE', 'GOVERNANCE']),
  retentionDays: z.number().int().min(1).max(3650),
  legalHold: z.boolean(),
});
export type BackupObjectLockConfig = z.infer<typeof BackupObjectLockConfigSchema>;

export const BackupStatusResponseSchema = z.object({
  hasMasterKey: z.boolean(),
  kmsEnabled: z.boolean().optional(),
  lockHeld: z.boolean(),
  s3: BackupS3ConfigSchema,
  schedule: BackupScheduleConfigSchema,
  objectLock: BackupObjectLockConfigSchema.optional(),
  history: z.array(BackupRunSchema),
});
export type BackupStatusResponse = z.infer<typeof BackupStatusResponseSchema>;

export const UpdateBackupSettingsSchema = z.object({
  s3Enabled: z.boolean().optional(),
  s3Endpoint: z.string().max(2048).optional(),
  s3Bucket: z.string().max(255).optional(),
  s3Region: z.string().max(64).optional(),
  s3AccessKey: z.string().max(256).optional(),
  s3SecretKey: z.string().max(256).optional(),
  s3Prefix: z.string().max(512).optional(),
  s3ForcePathStyle: z.boolean().optional(),
  scheduleEnabled: z.boolean().optional(),
  intervalHours: z.number().int().min(1).max(168).optional(),
  retentionCount: z.number().int().min(1).max(100).optional(),
  retentionDays: z.number().int().min(1).max(365).optional(),
  objectLockEnabled: z.boolean().optional(),
  objectLockMode: BackupObjectLockConfigSchema.shape.mode.optional(),
  objectLockRetentionDays: BackupObjectLockConfigSchema.shape.retentionDays.optional(),
  objectLockLegalHold: z.boolean().optional(),
});
export type UpdateBackupSettingsInput = z.infer<typeof UpdateBackupSettingsSchema>;

export const BackupExportTicketRequestSchema = z
  .object({
    passphrase: z.string().min(12).max(1024).optional(),
  })
  .strict();
export type BackupExportTicketRequest = z.infer<typeof BackupExportTicketRequestSchema>;

export const BackupExportTicketResponseSchema = z.object({
  downloadUrl: z.string().regex(/^\/api\/backup\/download\/[0-9a-f]{64}$/),
});
export type BackupExportTicketResponse = z.infer<typeof BackupExportTicketResponseSchema>;

export const BackupTestS3ResponseSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
});
export type BackupTestS3Response = z.infer<typeof BackupTestS3ResponseSchema>;

export const BackupTriggerResponseSchema = z.object({
  jobId: z.string(),
});
export type BackupTriggerResponse = z.infer<typeof BackupTriggerResponseSchema>;

export const UpdateBackupKmsSchema = z.object({
  provider: z.enum(['none', 'aws', 'vault']).optional(),
  keyId: z.string().max(2048).optional(),
  awsRegion: z.string().max(64).optional(),
  vaultAddr: z.string().max(2048).optional(),
  vaultNamespace: z.string().max(256).optional(),
}).strict();
export type UpdateBackupKmsInput = z.infer<typeof UpdateBackupKmsSchema>;

export const BackupKmsConfigSchema = UpdateBackupKmsSchema.required().extend({
  credentialsPresent: z.boolean(),
});
export type BackupKmsConfig = z.infer<typeof BackupKmsConfigSchema>;

export const BackupKmsTestResponseSchema = z.object({
  ok: z.literal(true),
  keyArn: z.string(),
});
export const BackupKmsRotateResponseSchema = z.object({
  ok: z.literal(true),
});
