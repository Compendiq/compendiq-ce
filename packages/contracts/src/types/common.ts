import { z } from 'zod';

export const PaginatedResponseSchema = <T extends z.ZodType>(itemSchema: T) =>
  z.object({
    items: z.array(itemSchema),
    total: z.number(),
    start: z.number(),
    limit: z.number(),
  });

export const ErrorResponseSchema = z.object({
  error: z.string(),
  message: z.string(),
  statusCode: z.number(),
});

export const SyncStatusSchema = z.object({
  isRunning: z.boolean(),
  lastSyncAt: z.string().nullable(),
  currentUser: z.string().nullable(),
  progress: z.object({
    total: z.number(),
    completed: z.number(),
  }).nullable(),
  error: z.string().nullable(),
});

export const HealthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded', 'error']),
  services: z.object({
    postgres: z.boolean(),
    redis: z.boolean(),
    ollama: z.boolean(),
  }),
  version: z.string(),
  uptime: z.number(),
});

export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
export type SyncStatus = z.infer<typeof SyncStatusSchema>;
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
