import { describe, it, expect } from 'vitest';
import {
  ENTERPRISE_FEATURES,
  FEATURE_ID_PATTERN,
  validateFeatureIdentifier,
} from './features.js';
import type { EnterpriseFeature } from './features.js';

describe('ENTERPRISE_FEATURES', () => {
  it('should export a frozen object of feature flag constants', () => {
    expect(typeof ENTERPRISE_FEATURES).toBe('object');
    expect(Object.keys(ENTERPRISE_FEATURES).length).toBeGreaterThanOrEqual(24);
  });

  it('should contain all expected Identity & Access Management features', () => {
    expect(ENTERPRISE_FEATURES.OIDC_SSO).toBe('oidc_sso');
    expect(ENTERPRISE_FEATURES.OIDC_GROUP_MAPPINGS).toBe('oidc_group_mappings');
    expect(ENTERPRISE_FEATURES.SCIM_PROVISIONING).toBe('scim_provisioning');
    expect(ENTERPRISE_FEATURES.ADVANCED_RBAC).toBe('advanced_rbac');
    expect(ENTERPRISE_FEATURES.ABAC_PERMISSIONS).toBe('abac_permissions');
    expect(ENTERPRISE_FEATURES.IP_ALLOWLISTING).toBe('ip_allowlisting');
    expect(ENTERPRISE_FEATURES.LDAP_GROUP_SYNC).toBe('ldap_group_sync');
  });

  it('should contain all expected AI Governance features', () => {
    expect(ENTERPRISE_FEATURES.RAG_PERMISSION_ENFORCEMENT).toBe('rag_permission_enforcement');
    expect(ENTERPRISE_FEATURES.LLM_AUDIT_TRAIL).toBe('llm_audit_trail');
    expect(ENTERPRISE_FEATURES.ORG_LLM_POLICY).toBe('org_llm_policy');
    expect(ENTERPRISE_FEATURES.AI_OUTPUT_REVIEW).toBe('ai_output_review');
    expect(ENTERPRISE_FEATURES.PII_DETECTION).toBe('pii_detection');
  });

  it('should contain all expected Compliance & Audit features', () => {
    expect(ENTERPRISE_FEATURES.AUDIT_LOG_EXPORT).toBe('audit_log_export');
    expect(ENTERPRISE_FEATURES.DATA_RETENTION_POLICIES).toBe('data_retention_policies');
    expect(ENTERPRISE_FEATURES.COMPLIANCE_REPORTS).toBe('compliance_reports');
    expect(ENTERPRISE_FEATURES.VERSION_SNAPSHOT_ARCHIVAL).toBe('version_snapshot_archival');
  });

  it('should contain all expected Organizational Scale features', () => {
    expect(ENTERPRISE_FEATURES.SEAT_ENFORCEMENT).toBe('seat_enforcement');
    expect(ENTERPRISE_FEATURES.UNLIMITED_SPACES).toBe('unlimited_spaces');
    expect(ENTERPRISE_FEATURES.MULTI_INSTANCE).toBe('multi_instance');
    expect(ENTERPRISE_FEATURES.BULK_USER_OPERATIONS).toBe('bulk_user_operations');
    expect(ENTERPRISE_FEATURES.BATCH_PAGE_OPERATIONS).toBe('batch_page_operations');
  });

  it('should contain all expected Integration features', () => {
    expect(ENTERPRISE_FEATURES.SLACK_TEAMS_DEEP).toBe('slack_teams_deep');
    expect(ENTERPRISE_FEATURES.WEBHOOK_PUSH).toBe('webhook_push');
  });

  it('should have unique values (no duplicate feature flags)', () => {
    const values = Object.values(ENTERPRISE_FEATURES);
    const uniqueValues = new Set(values);
    expect(uniqueValues.size).toBe(values.length);
  });

  it('should export the EnterpriseFeature type (compile-time check)', () => {
    const feature: EnterpriseFeature = ENTERPRISE_FEATURES.OIDC_SSO;
    expect(feature).toBe('oidc_sso');
  });

  it('should have ALL values matching snake_case pattern (FEATURE_ID_PATTERN)', () => {
    const values = Object.values(ENTERPRISE_FEATURES);
    for (const value of values) {
      expect(
        FEATURE_ID_PATTERN.test(value),
        `Feature flag "${value}" does not match snake_case pattern ${FEATURE_ID_PATTERN}`,
      ).toBe(true);
    }
  });
});

describe('validateFeatureIdentifier', () => {
  it('should accept valid snake_case identifiers', () => {
    expect(validateFeatureIdentifier('oidc_sso')).toBe(true);
    expect(validateFeatureIdentifier('pii_detection')).toBe(true);
    expect(validateFeatureIdentifier('a')).toBe(true);
    expect(validateFeatureIdentifier('feature123')).toBe(true);
    expect(validateFeatureIdentifier('advanced_rbac')).toBe(true);
  });

  it('should reject identifiers starting with a number', () => {
    expect(validateFeatureIdentifier('1_feature')).toBe(false);
    expect(validateFeatureIdentifier('123')).toBe(false);
  });

  it('should reject identifiers with uppercase letters', () => {
    expect(validateFeatureIdentifier('OIDC_SSO')).toBe(false);
    expect(validateFeatureIdentifier('OidcSso')).toBe(false);
    expect(validateFeatureIdentifier('oidc_SSO')).toBe(false);
  });

  it('should reject identifiers with hyphens or special characters', () => {
    expect(validateFeatureIdentifier('oidc-sso')).toBe(false);
    expect(validateFeatureIdentifier('feature.name')).toBe(false);
    expect(validateFeatureIdentifier('feature name')).toBe(false);
    expect(validateFeatureIdentifier('')).toBe(false);
  });

  it('should reject identifiers starting with underscore', () => {
    expect(validateFeatureIdentifier('_private')).toBe(false);
  });
});
