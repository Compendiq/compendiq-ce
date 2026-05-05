/**
 * Shared schemas for the bulk user operations admin API (EE #116).
 *
 * The CE side (this PR) defines the wire shapes the UI submits and renders.
 * The EE overlay (separate PR, ships next) brings the actual server
 * implementation: `overlay/backend/src/enterprise/bulk-user-service.ts`,
 * `overlay/backend/src/routes/admin-users-bulk.ts`. Until that overlay
 * lands, the bulk routes are absent in CE-only deployments and the UI
 * surfaces a "requires Enterprise" message when the preview/apply call
 * 404s.
 *
 * Two reasons the schemas live in CE rather than the overlay:
 *
 *   1. The CE frontend ships in both editions (single image — see
 *      `ce/CLAUDE.md` → "Frontend (CE image, no overlay)") and needs the
 *      types to compile against, even though the runtime is gated by
 *      `useEnterprise().hasFeature('bulk_user_operations')`.
 *   2. Keeping the contract in `@compendiq/contracts` means the EE
 *      overlay validates inputs against the same shape the UI submits —
 *      no drift between client and server.
 *
 * Validation choices:
 *
 *   - CSV rows are validated server-side; the request body itself is the
 *     raw CSV text (so the server controls the parser — `fast-csv` v5).
 *     A purely client-side parse would let a malicious admin send a
 *     hand-crafted preview/apply pair that disagrees on row contents.
 *   - The preview response embeds the parsed-and-validated row alongside
 *     a `null` slot for invalid rows. Invalid rows still surface in the
 *     summary (`invalid` count) so the UI can render them with their
 *     field-level errors next to the valid neighbours.
 *   - Apply mode is a closed enum; a wildcard "do whatever the CSV says"
 *     would make audit-log replay ambiguous (see ADMIN-GUIDE.md → Bulk
 *     user operations).
 */

import { z } from 'zod';

// ── CSV row contract ─────────────────────────────────────────────────────

/**
 * One row of a bulk-user CSV. Header row is required and must match the
 * field names below verbatim. `displayName`, `initialPassword` are
 * optional; if `initialPassword` is blank the server prefers the
 * invitation flow (random temp password + email link via SMTP) when
 * `sendInvitation=true`.
 *
 * `role` is the global role only — per-space role assignments live in
 * the RBAC API and are not configurable through the bulk import in this
 * iteration. (Bulk RBAC moves to v0.5; see roadmap.)
 */
export const BulkUserCsvRowSchema = z.object({
  username: z
    .string()
    .min(1, 'Username is required')
    .max(50, 'Username must be at most 50 characters')
    .regex(
      /^[a-zA-Z0-9_.-]+$/,
      'Username may only contain letters, numbers, dot, underscore, hyphen',
    ),
  email: z.string().email('Invalid email address').max(254),
  displayName: z.string().min(1).max(100).optional(),
  role: z.enum(['admin', 'user']),
  initialPassword: z.string().min(8).max(200).optional(),
  sendInvitation: z.boolean().default(true),
});

export type BulkUserCsvRow = z.infer<typeof BulkUserCsvRowSchema>;

// ── Preview ──────────────────────────────────────────────────────────────

/**
 * Request: the raw CSV text. The server parses, validates, and detects
 * collisions against existing users. No persistence happens at this
 * stage; the apply step takes a fresh CSV and replays the validation.
 */
export const BulkUserImportPreviewRequestSchema = z.object({
  csv: z.string().min(1, 'CSV body is required'),
});

export type BulkUserImportPreviewRequest = z.infer<
  typeof BulkUserImportPreviewRequestSchema
>;

/**
 * One row of the preview response. `row` is null when validation fails
 * (the parser still emits an entry so the UI can render the original
 * line number + the errors). `existing` flags duplicate detection
 * against the live `users` table — `'username'` or `'email'` indicates
 * which column matched an existing row.
 */
export const BulkUserImportPreviewRowSchema = z.object({
  row: BulkUserCsvRowSchema.nullable(),
  errors: z.array(z.string()),
  existing: z.enum(['none', 'username', 'email']),
});

export type BulkUserImportPreviewRow = z.infer<
  typeof BulkUserImportPreviewRowSchema
>;

export const BulkUserImportPreviewSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  valid: z.number().int().nonnegative(),
  invalid: z.number().int().nonnegative(),
  wouldCreate: z.number().int().nonnegative(),
  wouldUpdate: z.number().int().nonnegative(),
  wouldSkip: z.number().int().nonnegative(),
});

export type BulkUserImportPreviewSummary = z.infer<
  typeof BulkUserImportPreviewSummarySchema
>;

export const BulkUserImportPreviewResponseSchema = z.object({
  rows: z.array(BulkUserImportPreviewRowSchema),
  summary: BulkUserImportPreviewSummarySchema,
});

export type BulkUserImportPreviewResponse = z.infer<
  typeof BulkUserImportPreviewResponseSchema
>;

// ── Apply ────────────────────────────────────────────────────────────────

/**
 * Apply request. `mode = 'create-only'` errors on any duplicate; `'upsert'`
 * updates existing users in place. The CSV body is sent again rather
 * than replayed from a server-cached preview — keeps the apply path
 * stateless and forces a re-validation pass against the current DB
 * state (preventing TOCTOU between preview and apply).
 */
export const BulkUserImportApplyRequestSchema = z.object({
  csv: z.string().min(1, 'CSV body is required'),
  mode: z.enum(['create-only', 'upsert']),
});

export type BulkUserImportApplyRequest = z.infer<
  typeof BulkUserImportApplyRequestSchema
>;

// ── Bulk action (multi-select on the user list) ──────────────────────────

/**
 * Discriminated union for the multi-select action menu. Each branch is
 * its own object so the EE overlay can switch on `type` without
 * post-validation checks.
 */
export const BulkUserActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('change-role'),
    role: z.enum(['admin', 'user']),
  }),
  z.object({
    type: z.literal('deactivate'),
    reason: z.string().max(500).optional(),
  }),
  z.object({
    type: z.literal('reactivate'),
  }),
  z.object({
    type: z.literal('add-to-group'),
    groupId: z.string().min(1),
  }),
  z.object({
    type: z.literal('remove-from-group'),
    groupId: z.string().min(1),
  }),
]);

export type BulkUserAction = z.infer<typeof BulkUserActionSchema>;

export const BulkUserBulkActionRequestSchema = z.object({
  userIds: z.array(z.string().uuid()).min(1, 'At least one user must be selected'),
  action: BulkUserActionSchema,
});

export type BulkUserBulkActionRequest = z.infer<
  typeof BulkUserBulkActionRequestSchema
>;
