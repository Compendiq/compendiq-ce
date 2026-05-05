/**
 * Shared schemas for the PII detection policy (EE #119, Phase I).
 *
 * The CE side (this PR) defines the wire shape the admin UI submits and the
 * backend overlay validates against. The EE overlay
 * (`overlay/backend/src/enterprise/pii-policy-service.ts`) consumes the
 * schema verbatim — no contract drift between client and server.
 *
 * Why the schema lives in CE rather than the overlay:
 *
 *   1. The CE frontend ships in both editions (single image — see
 *      `ce/CLAUDE.md` → "Frontend (CE image, no overlay)") and needs the
 *      types to compile against, even though the runtime is gated by
 *      `useEnterprise().hasFeature('pii_detection')`.
 *   2. Keeping the contract in `@compendiq/contracts` means the EE overlay
 *      validates inputs against the same shape the UI submits — the
 *      `PUT /api/admin/pii-policy` body is parsed with the same Zod
 *      schema referenced here.
 *
 * Wire-shape source of truth: this file. The overlay's
 * `getPiiPolicy()`/`setPolicy()` map between the snake_case storage form
 * (`admin_settings.pii_policy` JSON) and the snake_case wire form below;
 * the two are identical so no transformation happens at the edge.
 *
 * Notes on the action axis (use-cases):
 *   The PII scanner is invoked from five inference call sites — `chat`,
 *   `improve`, `summary`, `generate`, `auto_tag` — defined as
 *   `PiiScanAction` in `ce/backend/src/core/services/pii-scan-hook.ts`.
 *   The policy admin UI lets operators choose a different action mode for
 *   each call site, so this file mirrors that closed union explicitly.
 *
 * Notes on the LLM-judge use-case dropdown:
 *   The async LLM-as-judge calls go through the existing CE `LlmUsecase`
 *   axis (chat | summary | quality | auto_tag | embedding). Picking which
 *   use-case bills the judge calls lets admins route them to whichever
 *   provider/model the deployment has already configured for that
 *   use-case — usually `quality` (cheap classification model).
 */

import { z } from 'zod';

// ── Use-cases (PII scan call sites) ──────────────────────────────────────
//
// Mirrors `PiiScanAction` from `ce/backend/src/core/services/pii-scan-hook.ts`.
// Adding a new inference call site that runs the scanner means adding it
// here AND to `PiiScanAction`. The closed union keeps the policy editor in
// the admin UI exhaustive — no silent action falls through to the default.

export const PII_USE_CASES = [
  'chat',
  'improve',
  'summary',
  'generate',
  'auto_tag',
] as const;

export const PiiUseCaseSchema = z.enum(PII_USE_CASES);

export type PiiUseCase = z.infer<typeof PiiUseCaseSchema>;

/** Human-readable labels for the policy editor table. */
export const PII_USE_CASE_LABELS: Readonly<Record<PiiUseCase, string>> =
  Object.freeze({
    chat: 'Chat',
    improve: 'Improve',
    summary: 'Summary',
    generate: 'Generate',
    auto_tag: 'Auto-tag',
  });

// ── Per-use-case action modes ────────────────────────────────────────────
//
// Four modes per the EE plan §1.7:
//   - 'off'                 — skip scan entirely for this use-case
//   - 'flag-only'           — record findings; pass content through unmodified
//   - 'redact-and-publish'  — splice spans out of text, replace with
//                              `[REDACTED:CATEGORY]`, persist findings
//   - 'block-publication'   — return 409 to the inference route; the
//                              caller (#120 review queue) catches and queues
//
// `block-publication` requires the AI-output review queue (#120) to be
// fully wired; the docs/ADMIN-GUIDE.md PII section spells out the
// fallback when the queue isn't deployed (the route surfaces a 409 the
// frontend translates to "review required" copy).

export const PII_ACTION_MODES = [
  'off',
  'flag-only',
  'redact-and-publish',
  'block-publication',
] as const;

export const PiiActionModeSchema = z.enum(PII_ACTION_MODES);

export type PiiActionMode = z.infer<typeof PiiActionModeSchema>;

export const PII_ACTION_MODE_LABELS: Readonly<Record<PiiActionMode, string>> =
  Object.freeze({
    off: 'Off',
    'flag-only': 'Flag only',
    'redact-and-publish': 'Redact & publish',
    'block-publication': 'Block publication',
  });

// ── PII categories ───────────────────────────────────────────────────────
//
// Closed union of every span category the scanner can emit. The German
// checksum-validated IDs come from `pii-regex-de.ts`; the generic ones
// (EMAIL_ADDRESS / PHONE_NUMBER / IBAN / CREDIT_CARD) come from
// `pii-regex-generic.ts`; PERSON / LOCATION / ORGANIZATION come from the
// transformers.js NER pipeline (Davlan/distilbert-base-multilingual-cased-ner-hrl).
//
// `URL` is NOT in the v0.4 scanner output — kept off the schema so the UI
// can't offer a checkbox the backend will silently ignore.

export const PII_CATEGORIES = [
  'PERSON',
  'LOCATION',
  'ORGANIZATION',
  'EMAIL_ADDRESS',
  'PHONE_NUMBER',
  'IBAN',
  'CREDIT_CARD',
  'DE_TAX_ID',
  'DE_RVNR',
  'DE_PERSONALAUSWEIS',
] as const;

export const PiiCategorySchema = z.enum(PII_CATEGORIES);

export type PiiCategory = z.infer<typeof PiiCategorySchema>;

export const PII_CATEGORY_LABELS: Readonly<Record<PiiCategory, string>> =
  Object.freeze({
    PERSON: 'Person name',
    LOCATION: 'Location',
    ORGANIZATION: 'Organization',
    EMAIL_ADDRESS: 'Email address',
    PHONE_NUMBER: 'Phone number',
    IBAN: 'IBAN',
    CREDIT_CARD: 'Credit card',
    DE_TAX_ID: 'DE Tax ID',
    DE_RVNR: 'DE RVNR (Rentenversicherung)',
    DE_PERSONALAUSWEIS: 'DE Personalausweis',
  });

// ── LLM judge ────────────────────────────────────────────────────────────
//
// Three modes for the async LLM-as-judge enrichment (plan §1.5):
//   - 'off'           — never invoke the judge (policy default)
//   - 'flagged-only'  — invoke only when regex+NER produced findings; reduces
//                       LLM cost while still gating ambiguous cases
//   - 'always'        — invoke on every scan, regardless of findings
//
// The use-case dropdown picks which CE LlmUsecase the judge billing flows
// through. The closed union here mirrors the `llmJudgeUsecase` field in
// the EE `PiiPolicy` interface.

export const PII_LLM_JUDGE_MODES = [
  'off',
  'flagged-only',
  'always',
] as const;

export const PiiLlmJudgeModeSchema = z.enum(PII_LLM_JUDGE_MODES);

export type PiiLlmJudgeMode = z.infer<typeof PiiLlmJudgeModeSchema>;

export const PII_LLM_JUDGE_MODE_LABELS: Readonly<
  Record<PiiLlmJudgeMode, string>
> = Object.freeze({
  off: 'Off',
  'flagged-only': 'When findings are present',
  always: 'Every scan',
});

export const PII_LLM_JUDGE_USECASES = [
  'chat',
  'summary',
  'quality',
  'auto_tag',
  'embedding',
] as const;

export const PiiLlmJudgeUsecaseSchema = z.enum(PII_LLM_JUDGE_USECASES);

export type PiiLlmJudgeUsecase = z.infer<typeof PiiLlmJudgeUsecaseSchema>;

export const PII_LLM_JUDGE_USECASE_LABELS: Readonly<
  Record<PiiLlmJudgeUsecase, string>
> = Object.freeze({
  chat: 'Chat',
  summary: 'Summary',
  quality: 'Quality',
  auto_tag: 'Auto-tag',
  embedding: 'Embedding',
});

// ── Per-use-case actions map ─────────────────────────────────────────────
//
// Zod v4 records over a closed-literal union require every key to be
// present (`.default({})` fails the exhaustiveness check), so we model
// the per-use-case actions as an explicit object with each use-case
// `.optional()`. The UI defaults missing entries to 'flag-only' on
// hydrate; the backend fills the same default in `getPiiPolicy()`.

export const PiiActionsSchema = z.object({
  chat: PiiActionModeSchema.optional(),
  improve: PiiActionModeSchema.optional(),
  summary: PiiActionModeSchema.optional(),
  generate: PiiActionModeSchema.optional(),
  auto_tag: PiiActionModeSchema.optional(),
});

export type PiiActions = z.infer<typeof PiiActionsSchema>;

// ── Full policy ──────────────────────────────────────────────────────────
//
// Snake_case on the wire to match the storage shape in
// `admin_settings.pii_policy`. The UI form state mirrors this 1:1 — no
// camelCase shim layer.

export const PiiPolicySchema = z.object({
  enabled: z.boolean(),
  /**
   * Confidence threshold (0..1) below which NER findings are dropped.
   * Higher = fewer false positives at the cost of more false negatives.
   * Regex findings always emit `confidence: 1.0` so this only affects
   * the NER spans in practice.
   */
  confidenceThreshold: z.number().min(0).max(1),
  llmJudgeMode: PiiLlmJudgeModeSchema,
  llmJudgeUsecase: PiiLlmJudgeUsecaseSchema,
  actions: PiiActionsSchema,
  categoriesToFlag: z.array(PiiCategorySchema),
});

export type PiiPolicy = z.infer<typeof PiiPolicySchema>;

export const PiiPolicyResponseSchema = z.object({
  policy: PiiPolicySchema,
});

export type PiiPolicyResponse = z.infer<typeof PiiPolicyResponseSchema>;

export const PiiPolicyPutBodySchema = z.object({
  policy: PiiPolicySchema,
});

export type PiiPolicyPutBody = z.infer<typeof PiiPolicyPutBodySchema>;

// ── Defaults ─────────────────────────────────────────────────────────────
//
// Mirrors the EE overlay's `DEFAULT_POLICY` in `pii-scanner.ts`. Used by
// the admin UI to seed the form when the GET response omits a field
// (defensive; the overlay always returns a fully-populated object).

export const DEFAULT_PII_POLICY: PiiPolicy = {
  enabled: false,
  confidenceThreshold: 0.7,
  llmJudgeMode: 'off',
  llmJudgeUsecase: 'quality',
  actions: {
    chat: 'flag-only',
    improve: 'flag-only',
    summary: 'flag-only',
    generate: 'flag-only',
    auto_tag: 'flag-only',
  },
  categoriesToFlag: [
    'PERSON',
    'LOCATION',
    'ORGANIZATION',
    'EMAIL_ADDRESS',
    'PHONE_NUMBER',
    'IBAN',
    'CREDIT_CARD',
    'DE_TAX_ID',
    'DE_RVNR',
    'DE_PERSONALAUSWEIS',
  ],
};
