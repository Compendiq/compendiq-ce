import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../test-db-helper.js';
import { query } from '../db/postgres.js';
import { logAuditEvent, getAuditLog, AuditAction } from './audit-service.js';

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('Audit Service', () => {
  let testUserId: string;

  beforeAll(async () => {
    await setupTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();

    // Create a test user
    const result = await query<{ id: string }>(
      "INSERT INTO users (username, password_hash, role) VALUES ('audituser', 'fakehash', 'admin') RETURNING id",
    );
    testUserId = result.rows[0].id;
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  describe('logAuditEvent', () => {
    it('should insert an audit log entry', async () => {
      await logAuditEvent(testUserId, 'LOGIN', 'user', testUserId);

      const result = await query<{ action: string; user_id: string }>(
        'SELECT action, user_id FROM audit_log WHERE user_id = $1',
        [testUserId],
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].action).toBe('LOGIN');
      expect(result.rows[0].user_id).toBe(testUserId);
    });

    it('should store metadata as JSON', async () => {
      await logAuditEvent(testUserId, 'SETTINGS_CHANGED', 'settings', testUserId, {
        changedFields: ['confluenceUrl', 'ollamaModel'],
      });

      const result = await query<{ metadata: Record<string, unknown> }>(
        'SELECT metadata FROM audit_log WHERE user_id = $1',
        [testUserId],
      );
      expect(result.rows[0].metadata).toEqual({
        changedFields: ['confluenceUrl', 'ollamaModel'],
      });
    });

    it('should handle null userId (e.g., failed login)', async () => {
      await logAuditEvent(null, 'LOGIN_FAILED', 'user', undefined, {
        username: 'nonexistent',
        reason: 'user_not_found',
      });

      const result = await query<{ user_id: string | null; action: string }>(
        "SELECT user_id, action FROM audit_log WHERE action = 'LOGIN_FAILED'",
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].user_id).toBeNull();
    });

    it('should store resource type and ID', async () => {
      await logAuditEvent(testUserId, 'PAGE_CREATED', 'page', 'page-123');

      const result = await query<{ resource_type: string; resource_id: string }>(
        'SELECT resource_type, resource_id FROM audit_log WHERE user_id = $1',
        [testUserId],
      );
      expect(result.rows[0].resource_type).toBe('page');
      expect(result.rows[0].resource_id).toBe('page-123');
    });

    it('should not throw on database errors (fails silently)', async () => {
      // This should not throw even if there's an issue
      // We test this by ensuring the function completes without error
      await expect(
        logAuditEvent(testUserId, 'LOGIN', 'user', testUserId),
      ).resolves.not.toThrow();
    });

    it('should log multiple event types', async () => {
      const events: AuditAction[] = [
        'LOGIN',
        'SETTINGS_CHANGED',
        'PAGE_CREATED',
        'PAGE_UPDATED',
        'SYNC_STARTED',
      ];

      for (const action of events) {
        await logAuditEvent(testUserId, action, 'test', testUserId);
      }

      const result = await query<{ count: string }>(
        'SELECT COUNT(*) as count FROM audit_log WHERE user_id = $1',
        [testUserId],
      );
      expect(parseInt(result.rows[0].count, 10)).toBe(events.length);
    });
  });

  describe('getAuditLog', () => {
    beforeEach(async () => {
      // Insert some test audit entries
      await logAuditEvent(testUserId, 'LOGIN', 'user', testUserId);
      await logAuditEvent(testUserId, 'SETTINGS_CHANGED', 'settings', testUserId);
      await logAuditEvent(testUserId, 'PAGE_CREATED', 'page', 'page-1');
      await logAuditEvent(testUserId, 'PAGE_UPDATED', 'page', 'page-1');
      await logAuditEvent(null, 'LOGIN_FAILED', 'user', undefined, { username: 'bad' });
    });

    it('should return paginated results', async () => {
      const result = await getAuditLog({ page: 1, limit: 2 });
      expect(result.items).toHaveLength(2);
      expect(result.total).toBe(5);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(2);
    });

    it('should filter by userId', async () => {
      const result = await getAuditLog({ userId: testUserId });
      expect(result.total).toBe(4); // Excludes the LOGIN_FAILED with null userId
      expect(result.items.every((i) => i.userId === testUserId)).toBe(true);
    });

    it('should filter by action', async () => {
      const result = await getAuditLog({ action: 'LOGIN' });
      expect(result.total).toBe(1);
      expect(result.items[0].action).toBe('LOGIN');
    });

    it('should filter by resourceType', async () => {
      const result = await getAuditLog({ resourceType: 'page' });
      expect(result.total).toBe(2);
      expect(result.items.every((i) => i.resourceType === 'page')).toBe(true);
    });

    it('should return results ordered by created_at DESC', async () => {
      const result = await getAuditLog({});
      // Most recent first
      for (let i = 0; i < result.items.length - 1; i++) {
        const current = new Date(result.items[i].createdAt).getTime();
        const next = new Date(result.items[i + 1].createdAt).getTime();
        expect(current).toBeGreaterThanOrEqual(next);
      }
    });

    it('should handle empty results', async () => {
      const result = await getAuditLog({ action: 'NONEXISTENT_ACTION' });
      expect(result.items).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    it('should support pagination offset', async () => {
      const page1 = await getAuditLog({ page: 1, limit: 2 });
      const page2 = await getAuditLog({ page: 2, limit: 2 });

      expect(page1.items).toHaveLength(2);
      expect(page2.items).toHaveLength(2);

      // Different items on different pages
      const page1Ids = page1.items.map((i) => i.id);
      const page2Ids = page2.items.map((i) => i.id);
      expect(page1Ids).not.toEqual(page2Ids);
    });
  });

  // --------------------------------------------------------------------
  // #307 — compliance-report audit events
  // --------------------------------------------------------------------
  describe('#307 compliance audit events', () => {
    // The compliance report (Compendiq/compendiq-ee#115) reads these event
    // types. If any disappear the report breaks. Touch this list only
    // when deliberately changing the compliance contract.
    const REQUIRED: AuditAction[] = [
      'SESSION_CREATED',
      'SESSION_REVOKED',
      'PASSWORD_RESET',
      'MFA_ENROLLED',
      'MFA_DISABLED',
      'ROLE_ASSIGNED',
      'ROLE_REVOKED',
      'GROUP_CREATED',
      'GROUP_UPDATED',
      'GROUP_DELETED',
      'GROUP_MEMBER_ADDED',
      'GROUP_MEMBER_REMOVED',
      'SPACE_ACCESS_GRANTED',
      'SPACE_ACCESS_REVOKED',
      'ACE_GRANTED',
      'ACE_REVOKED',
      'RETENTION_PRUNED',
    ];

    it.each(REQUIRED)('persists %s with the expected action string', async (action) => {
      await logAuditEvent(null, action, 'rt', 'rid', { tag: action });
      const res = await query<{ action: string }>(
        `SELECT action FROM audit_log WHERE action = $1`,
        [action],
      );
      expect(res.rows.length).toBe(1);
    });

    it('login event accepts auth_method metadata for local + oidc', async () => {
      await logAuditEvent(testUserId, 'LOGIN', 'user', testUserId, { auth_method: 'local' });
      await logAuditEvent(testUserId, 'LOGIN', 'user', testUserId, { auth_method: 'oidc' });
      const res = await query<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM audit_log WHERE action = 'LOGIN' ORDER BY created_at`,
      );
      expect(res.rows.map((r) => r.metadata['auth_method'])).toEqual(['local', 'oidc']);
    });

    it('RETENTION_PRUNED captures table + rows_pruned + retention_days', async () => {
      await logAuditEvent(
        null,
        'RETENTION_PRUNED',
        'table',
        'audit_log',
        { table: 'audit_log', rows_pruned: 17, retention_days: 365 },
      );
      const res = await query<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM audit_log WHERE action = 'RETENTION_PRUNED'`,
      );
      expect(res.rows[0]!.metadata).toEqual({
        table: 'audit_log',
        rows_pruned: 17,
        retention_days: 365,
      });
    });
  });
});

// Pure type-level test — no DB required. Guards against accidental removal
// of the v0.4 AI-safety action entries. If the AuditAction union no longer
// accepts one of these literals, this file fails to compile.
describe('AuditAction v0.4 AI safety entries', () => {
  it('accepts PII detection actions (EE #119)', () => {
    const actions: AuditAction[] = ['PII_DETECTED', 'PII_POLICY_CHANGED'];
    expect(actions).toHaveLength(2);
  });

  it('accepts AI output review lifecycle actions (EE #120)', () => {
    const actions: AuditAction[] = [
      'AI_REVIEW_SUBMITTED',
      'AI_REVIEW_APPROVED',
      'AI_REVIEW_REJECTED',
      'AI_REVIEW_EDIT_AND_APPROVED',
      'AI_REVIEW_EXPIRED',
      'AI_REVIEW_POLICY_CHANGED',
    ];
    expect(actions).toHaveLength(6);
  });
});
