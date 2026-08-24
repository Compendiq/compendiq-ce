import { z } from 'zod';

/**
 * Notion internal integration token — write-only. Never appears on a
 * response schema (issue #1462 / #1459). Same never-echo contract as
 * `confluencePat` / `hasConfluencePat`.
 */
export const ConnectNotionSchema = z.object({
  token: z.string().trim().min(1).max(4096),
});
export type ConnectNotionInput = z.infer<typeof ConnectNotionSchema>;

export const NotionConnectionResponseSchema = z
  .object({
    hasToken: z.boolean(),
  })
  .strict();
export type NotionConnectionResponse = z.infer<typeof NotionConnectionResponseSchema>;
