import { z } from 'zod';

/**
 * Query schema for GET /api/notifications.
 * Mirrors the admin pagination convention: limit is coerced and capped at 100,
 * offset is coerced and non-negative, both with sane defaults.
 */
export const NotificationListQuerySchema = z.object({
  unread: z.enum(['true', 'false']).optional(),
  type: z.string().max(64).optional(),
  limit: z.coerce.number().int().positive().max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type NotificationListQuery = z.infer<typeof NotificationListQuerySchema>;

/**
 * Body schema for PUT /api/notification-preferences.
 */
export const NotificationPreferenceUpdateSchema = z.object({
  type: z.string().min(1),
  inApp: z.boolean().optional(),
  email: z.boolean().optional(),
});

export type NotificationPreferenceUpdate = z.infer<typeof NotificationPreferenceUpdateSchema>;
