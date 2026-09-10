/**
 * Shared schema for the SOC 2 / ISO 27001 compliance-report generator
 * (Compendiq/compendiq-ee#115).
 *
 * Hoisted into `@compendiq/contracts` to deduplicate the report-id union
 * that previously lived in three places:
 *
 *   1. `frontend/src/features/admin/ComplianceReportsTab.tsx` — local
 *      `CATALOGUE` / `ReportId` (UI rendering)
 *   2. `overlay/backend/src/routes/foundation/compliance-reports.ts` —
 *      `REPORT_IDS` const + Zod enum (route validation)
 *   3. `overlay/backend/src/enterprise/compliance-reports/types.ts` —
 *      `ReportId` union (orchestrator + module registry)
 *
 * All three now import this file. New report ids belong in `REPORT_IDS`
 * below; the frontend catalogue supplies their display copy.
 *
 * Wire-shape source of truth: the actual generate route in
 * `overlay/backend/src/routes/foundation/compliance-reports.ts`. The CE
 * side (this contract) is the type-only mirror — the route still owns
 * the orchestration and runs only when the EE overlay is loaded.
 *
 * As with `ai-review.ts`, the schema lives in CE rather than the
 * overlay because the CE frontend ships in both editions and needs the
 * types to compile against (the runtime is gated by
 * `useEnterprise().hasFeature('compliance_reports')`).
 */
import { z } from 'zod';

// ── Report ids ────────────────────────────────────────────────────────
//
// The compliance report catalogue. Adding a new report:
//   1. Add the id here
//   2. Add a module under `overlay/backend/src/enterprise/compliance-reports/
//      reports/<id>.ts` that exports a `ReportModule`
//   3. Register it in `overlay/backend/src/enterprise/compliance-reports/
//      registry.ts`
//   4. Add the corresponding `CatalogueEntry` to the frontend tab
//      (control mapping + display copy)
//
// No change in this file's imports/exports is required — both the EE
// route's request validator and the frontend's catalogue render off this
// const automatically.

export const REPORT_IDS = [
  'user_access',
  'sync_data_flow',
  'rbac_changes',
  'auth_session',
  'ai_usage',
  'data_retention',
  'admin_actions',
  'model_governance',
] as const;

export const ReportIdSchema = z.enum(REPORT_IDS);

export type ReportId = z.infer<typeof ReportIdSchema>;

// ── Generate-request body ─────────────────────────────────────────────
//
// Mirrors the Zod parser in
// `overlay/backend/src/routes/foundation/compliance-reports.ts`. Posted
// by the admin tab; validated by the route. Both sides should reference
// `GenerateComplianceReportSchema` so any drift surfaces at compile time
// rather than as a 400 at runtime.

export const GenerateComplianceReportSchema = z.object({
  reportId: ReportIdSchema,
  /** ISO 8601 datetime, inclusive lower bound. */
  from: z.string().datetime({ offset: true }),
  /** ISO 8601 datetime, exclusive upper bound. */
  to: z.string().datetime({ offset: true }),
});

export type GenerateComplianceReportRequest = z.infer<
  typeof GenerateComplianceReportSchema
>;

// ── Catalogue response ────────────────────────────────────────────────
//
// Returned by `GET /api/admin/compliance-reports`. `catalogue` is the
// canonical report-id list (so older deployments can still render
// unavailable cards for unwired reports). `available` is
// the subset of report ids actually wired in the running merged build's
// registry — driven by the registry, not the catalogue.

export const ComplianceReportCatalogueSchema = z.object({
  catalogue: z.array(ReportIdSchema),
  available: z.array(ReportIdSchema),
});

export type ComplianceReportCatalogue = z.infer<
  typeof ComplianceReportCatalogueSchema
>;
