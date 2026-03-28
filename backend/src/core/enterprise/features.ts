/**
 * Enterprise feature flag constants.
 *
 * Defined in the open-source repo so both repos share the same string
 * identifiers. The enterprise package maps these to license tiers.
 *
 * Adding a new constant here does NOT enable any feature — it just
 * reserves the flag name. The enterprise package decides which tiers
 * unlock which features.
 */
export const ENTERPRISE_FEATURES = {
  // ── Identity & Access Management ──
  OIDC_SSO: 'oidc_sso',
  OIDC_GROUP_MAPPINGS: 'oidc_group_mappings',
  SCIM_PROVISIONING: 'scim_provisioning',
  ADVANCED_RBAC: 'advanced_rbac',
  ABAC_PERMISSIONS: 'abac_permissions',
  IP_ALLOWLISTING: 'ip_allowlisting',
  LDAP_GROUP_SYNC: 'ldap_group_sync',

  // ── AI Governance ──
  RAG_PERMISSION_ENFORCEMENT: 'rag_permission_enforcement',
  LLM_AUDIT_TRAIL: 'llm_audit_trail',
  ORG_LLM_POLICY: 'org_llm_policy',
  AI_OUTPUT_REVIEW: 'ai_output_review',
  PII_DETECTION: 'pii_detection',

  // ── Compliance & Audit ──
  AUDIT_LOG_EXPORT: 'audit_log_export',
  DATA_RETENTION_POLICIES: 'data_retention_policies',
  COMPLIANCE_REPORTS: 'compliance_reports',
  VERSION_SNAPSHOT_ARCHIVAL: 'version_snapshot_archival',

  // ── Analytics & Reporting ──
  ADVANCED_ANALYTICS: 'advanced_analytics',
  AI_USAGE_ANALYTICS: 'ai_usage_analytics',

  // ── Organizational Scale ──
  SEAT_ENFORCEMENT: 'seat_enforcement',
  UNLIMITED_SPACES: 'unlimited_spaces',
  MULTI_INSTANCE: 'multi_instance',
  BULK_USER_OPERATIONS: 'bulk_user_operations',
  BATCH_PAGE_OPERATIONS: 'batch_page_operations',

  // ── Integrations ──
  SLACK_TEAMS_DEEP: 'slack_teams_deep',
  WEBHOOK_PUSH: 'webhook_push',
} as const;

export type EnterpriseFeature =
  (typeof ENTERPRISE_FEATURES)[keyof typeof ENTERPRISE_FEATURES];
