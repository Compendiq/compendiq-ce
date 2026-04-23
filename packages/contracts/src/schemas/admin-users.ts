/**
 * Admin CRUD schemas for the Settings → Users admin page (#304).
 *
 * These routes are distinct from the RBAC routes in `rbac.ts`:
 *   - RBAC handles role assignment and group memberships (who can do what)
 *   - Admin Users handles lifecycle (exists / active / deleted)
 */

import { z } from 'zod';

const ROLE_SCHEMA = z.enum(['user', 'admin']);
export type AdminUserRole = z.infer<typeof ROLE_SCHEMA>;

/**
 * Request body for POST /api/admin/users.
 *
 * Either `password` or `sendInvitation: true` MUST be provided. When
 * `sendInvitation` is set, the backend generates a random password and
 * emails the user a password-reset link.
 */
export const AdminUserCreateSchema = z
  .object({
    username: z
      .string()
      .min(3, 'Username must be at least 3 characters')
      .max(50, 'Username must be at most 50 characters')
      .regex(/^[a-zA-Z0-9_.-]+$/, 'Username may only contain letters, numbers, dot, underscore, hyphen'),
    email: z.string().email().max(254).optional(),
    displayName: z.string().min(1).max(100).optional(),
    role: ROLE_SCHEMA.default('user'),
    password: z.string().min(8, 'Password must be at least 8 characters').max(200).optional(),
    sendInvitation: z.boolean().optional(),
  })
  .refine((d) => Boolean(d.password) || d.sendInvitation === true, {
    message: 'Provide either password or set sendInvitation=true',
    path: ['password'],
  });

export type AdminUserCreateRequest = z.infer<typeof AdminUserCreateSchema>;

/** Request body for PUT /api/admin/users/:id (all fields optional; at least one required). */
export const AdminUserUpdateSchema = z
  .object({
    email: z.string().email().max(254).nullable().optional(),
    displayName: z.string().min(1).max(100).nullable().optional(),
    role: ROLE_SCHEMA.optional(),
  })
  .refine(
    (d) => d.email !== undefined || d.displayName !== undefined || d.role !== undefined,
    { message: 'At least one field must be provided' },
  );

export type AdminUserUpdateRequest = z.infer<typeof AdminUserUpdateSchema>;

export const AdminUserDeactivateSchema = z.object({
  reason: z.string().max(500).optional(),
});
export type AdminUserDeactivateRequest = z.infer<typeof AdminUserDeactivateSchema>;

/** Response shape from GET /api/admin/users and the mutating endpoints. */
export const AdminUserSchema = z.object({
  id: z.string().uuid(),
  username: z.string(),
  email: z.string().nullable(),
  displayName: z.string().nullable(),
  role: ROLE_SCHEMA,
  authProvider: z.string(),
  deactivatedAt: z.string().nullable(),
  deactivatedBy: z.string().uuid().nullable(),
  deactivatedReason: z.string().nullable(),
  createdAt: z.string(),
});
export type AdminUser = z.infer<typeof AdminUserSchema>;

export const AdminUserListSchema = z.object({
  users: z.array(AdminUserSchema),
});
export type AdminUserList = z.infer<typeof AdminUserListSchema>;
