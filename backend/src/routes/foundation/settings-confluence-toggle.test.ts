import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';

// Default empty rows so GET /settings' extra admin_settings read
// (`client_inference_enabled`) cannot 500 a test that only queued the
// user_settings SELECT — same default as settings.test.ts.
const mockQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });

vi.mock('../../core/db/postgres.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  getPool: vi.fn().mockReturnValue({}),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
}));

vi.mock('../../core/utils/crypto.js', () => ({
  encryptPat: vi.fn().mockReturnValue('encrypted-pat'),
}));

vi.mock('../../core/services/audit-service.js', () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../core/services/rbac-service.js', () => ({
  getUserAccessibleSpaces: vi.fn().mockResolvedValue([]),
  getSelectedSyncSpaces: vi.fn().mockResolvedValue([]),
  invalidateRbacCache: vi.fn().mockResolvedValue(undefined),
}));

const mockIsConfluenceEnabled = vi.fn().mockResolvedValue(true);
const mockGetClientForUser = vi.fn().mockResolvedValue(null);

vi.mock('../../domains/confluence/services/sync-service.js', () => ({
  getClientForUser: (...args: unknown[]) => mockGetClientForUser(...args),
}));

vi.mock('../../core/services/confluence-integration.js', () => ({
  isConfluenceEnabled: (...args: unknown[]) => mockIsConfluenceEnabled(...args),
}));

vi.mock('undici', () => ({
  request: vi.fn(),
}));

vi.mock('../../core/utils/tls-config.js', () => ({
  confluenceDispatcher: { isMockDispatcher: true },
  buildConnectOptions: vi.fn().mockReturnValue(undefined),
}));

import { settingsRoutes } from './settings.js';

/** The single `UPDATE user_settings SET …` statement PUT /settings issues. */
function updateStatement(): { sql: string; values: unknown[] } {
  const calls = mockQuery.mock.calls.filter(
    (call) => typeof call[0] === 'string' && call[0].includes('UPDATE user_settings SET'),
  );
  expect(calls).toHaveLength(1);
  return { sql: calls[0]![0] as string, values: (calls[0]![1] ?? []) as unknown[] };
}

describe('Settings routes – confluenceEnabled (#1623)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);

    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof ZodError) {
        reply.status(400).send({
          error: 'ValidationError',
          message: error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '),
          statusCode: 400,
        });
        return;
      }
      reply.status(error.statusCode ?? 500).send({ error: error.message, statusCode: error.statusCode ?? 500 });
    });

    app.decorate('authenticate', async (request: { userId: string; username: string; userRole: string }) => {
      request.userId = 'test-user-id';
      request.username = 'testuser';
      request.userRole = 'user';
    });

    await app.register(settingsRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockIsConfluenceEnabled.mockResolvedValue(true);
    mockGetClientForUser.mockResolvedValue(null);
  });

  it('GET /settings reports the stored off state', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        confluence_url: 'https://wiki.example.com',
        confluence_pat: 'encrypted-pat',
        theme: 'glass-dark',
        sync_interval_min: 15,
        show_space_home_content: true,
        confluence_enabled: false,
      }],
      rowCount: 1,
    });

    const response = await app.inject({ method: 'GET', url: '/api/settings' });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body.confluenceEnabled).toBe(false);
    // Standalone mode never discards credentials — they must still read back
    // as connected so re-enabling doesn't ask for the PAT again.
    expect(body.confluenceConnected).toBe(true);
  });

  it('GET /settings defaults to enabled when the row predates the column', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        confluence_url: null,
        confluence_pat: null,
        theme: 'glass-dark',
        sync_interval_min: 15,
        show_space_home_content: true,
      }],
      rowCount: 1,
    });

    const response = await app.inject({ method: 'GET', url: '/api/settings' });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).confluenceEnabled).toBe(true);
  });

  it('GET /settings defaults to enabled for a user with no settings row', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const response = await app.inject({ method: 'GET', url: '/api/settings' });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).confluenceEnabled).toBe(true);
  });

  it('GET /settings reads confluence_enabled from the database', async () => {
    await app.inject({ method: 'GET', url: '/api/settings' });

    expect(mockQuery).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('confluence_enabled'),
      ['test-user-id'],
    );
  });

  it('PUT /settings writes confluence_enabled and leaves every sibling column alone', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { confluenceEnabled: false },
    });

    expect(response.statusCode).toBe(200);

    const { sql, values } = updateStatement();
    // Exactly one assignment for the flag, and nothing else but the bookkeeping
    // timestamp — turning the integration off must not clear the URL or PAT.
    expect(sql).toContain('SET confluence_enabled = $1, updated_at = NOW() WHERE user_id = $2');
    expect(sql.match(/confluence_enabled/g)).toHaveLength(1);
    expect(sql).not.toContain('confluence_url');
    expect(sql).not.toContain('confluence_pat');
    expect(values).toEqual([false, 'test-user-id']);
  });

  it('PUT /settings writes confluence_enabled on the way back on', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { confluenceEnabled: true },
    });

    expect(response.statusCode).toBe(200);
    expect(updateStatement().values).toEqual([true, 'test-user-id']);
  });

  it('PUT /settings leaves confluence_enabled untouched when the key is omitted', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { theme: 'glass-light' },
    });

    expect(response.statusCode).toBe(200);

    const { sql, values } = updateStatement();
    expect(sql).not.toContain('confluence_enabled');
    expect(values).toEqual(['glass-light', 'test-user-id']);
  });

  it('PUT /settings refuses a space selection while the integration is off, without blaming credentials', async () => {
    mockIsConfluenceEnabled.mockResolvedValue(false);

    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { selectedSpaces: ['ENG'] },
    });

    expect(response.statusCode).toBe(422);
    const body = JSON.parse(response.body);
    expect(body.error).toContain('Confluence integration is off');
    expect(body.error).not.toContain('not configured');
    expect(mockGetClientForUser).not.toHaveBeenCalled();
  });

  it('PUT /settings still reports missing credentials to a Confluence-enabled user', async () => {
    mockIsConfluenceEnabled.mockResolvedValue(true);
    mockGetClientForUser.mockResolvedValue(null);

    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { selectedSpaces: ['ENG'] },
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toBe('Confluence not configured');
  });
});
