import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';

// Mock undici request
const mockUndiciRequest = vi.fn();
vi.mock('undici', () => ({
  request: (...args: unknown[]) => mockUndiciRequest(...args),
}));

// Mock TLS config
vi.mock('../../core/utils/tls-config.js', () => ({
  confluenceDispatcher: { isMockDispatcher: true },
  buildConnectOptions: vi.fn().mockReturnValue(undefined),
}));

// Hoisted query mock so we can reference it in tests
const mockQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });

// Mock external dependencies
vi.mock('../../core/db/postgres.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  getPool: vi.fn().mockReturnValue({}),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
}));

vi.mock('../../core/utils/crypto.js', () => ({
  encryptPat: vi.fn().mockReturnValue('encrypted-pat'),
  decryptPat: vi.fn().mockReturnValue('decrypted-stored-pat'),
}));

vi.mock('../../core/services/audit-service.js', () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const mockGetUserAccessibleSpaces = vi.fn().mockResolvedValue(['DEV', 'DOCS']);
const mockGetSelectedSyncSpaces = vi.fn().mockResolvedValue(['DEV', 'DOCS']);
vi.mock('../../core/services/rbac-service.js', () => ({
  getUserAccessibleSpaces: (...args: unknown[]) => mockGetUserAccessibleSpaces(...args),
  getSelectedSyncSpaces: (...args: unknown[]) => mockGetSelectedSyncSpaces(...args),
  invalidateRbacCache: vi.fn().mockResolvedValue(undefined),
}));

const mockGetSharedLlmSettings = vi.fn().mockResolvedValue({
  llmProvider: 'ollama',
  ollamaModel: 'qwen3.5',
  openaiBaseUrl: null,
  hasOpenaiApiKey: false,
  openaiModel: null,
  embeddingModel: 'bge-m3',
    embeddingDimensions: 1024,
    ftsLanguage: 'simple',
});
vi.mock('../../core/services/admin-settings-service.js', () => ({
  getSharedLlmSettings: (...args: unknown[]) => mockGetSharedLlmSettings(...args),
}));

const mockGetSyncOverview = vi.fn();
vi.mock('../../domains/confluence/services/sync-overview-service.js', () => ({
  getSyncOverview: (...args: unknown[]) => mockGetSyncOverview(...args),
}));

// #815: PUT /settings must validate selectedSpaces against the caller's own
// PAT-visible spaces before self-assigning the editor role.
const mockGetClientForUser = vi.fn();
vi.mock('../../domains/confluence/services/sync-service.js', () => ({
  getClientForUser: (...args: unknown[]) => mockGetClientForUser(...args),
}));

// Spy on ssrf-guard functions to verify allowlist management
const mockAddAllowedBaseUrl = vi.fn();
const mockRemoveAllowedBaseUrl = vi.fn();
// #819: the probe now validates NON-MUTATINGLY via validateUrlSyntaxAndProtocol
// instead of round-tripping the process-global allowlist with validateUrl.
const mockValidateUrlSyntaxAndProtocol = vi.fn();
const mockResolveConfluenceUrl = vi.fn().mockImplementation((url: string) => url);
vi.mock('../../core/utils/ssrf-guard.js', () => ({
  addAllowedBaseUrl: (...args: unknown[]) => mockAddAllowedBaseUrl(...args),
  removeAllowedBaseUrl: (...args: unknown[]) => mockRemoveAllowedBaseUrl(...args),
  validateUrlSyntaxAndProtocol: (...args: unknown[]) => mockValidateUrlSyntaxAndProtocol(...args),
  resolveConfluenceUrl: (...args: unknown[]) => mockResolveConfluenceUrl(...args),
}));

import { settingsRoutes } from './settings.js';

describe('Settings routes – test-confluence', () => {
  let app: ReturnType<typeof Fastify>;

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

    // Mock auth decorator
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
    mockGetSharedLlmSettings.mockResolvedValue({
      llmProvider: 'ollama',
      ollamaModel: 'qwen3.5',
      openaiBaseUrl: null,
      hasOpenaiApiKey: false,
      openaiModel: null,
      embeddingModel: 'bge-m3',
    embeddingDimensions: 1024,
    ftsLanguage: 'simple',
    });
  });

  it('should return success when Confluence responds OK', async () => {
    mockUndiciRequest.mockResolvedValue({
      statusCode: 200,
      body: { dump: vi.fn().mockResolvedValue(undefined) },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/settings/test-confluence',
      payload: { url: 'https://confluence.example.com', pat: 'test-pat' },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
    expect(body.message).toBe('Connection successful');

    // Verify undici was called with correct URL and auth header
    expect(mockUndiciRequest).toHaveBeenCalledWith(
      'https://confluence.example.com/rest/api/space?limit=1',
      expect.objectContaining({
        method: 'GET',
        headers: { Authorization: 'Bearer test-pat' },
      }),
    );
  });

  it('should return a generic failure message on non-2xx response (#819 no oracle)', async () => {
    // #819: the raw HTTP status must NOT be reflected — it would turn the probe
    // into an internal port/host scanner (CWE-918).
    mockUndiciRequest.mockResolvedValue({
      statusCode: 401,
      body: { dump: vi.fn().mockResolvedValue(undefined) },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/settings/test-confluence',
      payload: { url: 'https://confluence.example.com', pat: 'bad-pat' },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(false);
    expect(body.message).toBe('Connection failed');
    expect(body.message).not.toContain('401');
  });

  it('should NOT reflect the raw error/cause on connection failure (#819 no oracle)', async () => {
    // #819: reflecting err.message / err.cause leaks internal reachability
    // (ECONNREFUSED vs cert error vs ENOTFOUND). Return a generic message.
    const fetchError = new TypeError('fetch failed');
    (fetchError as Error & { cause: Error }).cause = new Error('unable to verify the first certificate');
    mockUndiciRequest.mockRejectedValue(fetchError);

    const response = await app.inject({
      method: 'POST',
      url: '/api/settings/test-confluence',
      payload: { url: 'https://confluence.example.com', pat: 'test-pat' },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(false);
    expect(body.message).toBe('Connection failed');
    expect(body.message).not.toContain('fetch failed');
    expect(body.message).not.toContain('certificate');
  });

  it('should allow private network URLs for Confluence (#480 on-prem, non-mutating per #819)', async () => {
    // Private-network Confluence URLs still pass because
    // validateUrlSyntaxAndProtocol does not block private IPs — only non-HTTP(S)
    // protocols. Crucially the probe must NOT allowlist the origin (#819).
    mockUndiciRequest.mockResolvedValue({
      statusCode: 200,
      body: { dump: vi.fn().mockResolvedValue(undefined) },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/settings/test-confluence',
      payload: { url: 'https://192.168.1.1', pat: 'test-pat' },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
    expect(mockUndiciRequest).toHaveBeenCalled();
    expect(mockValidateUrlSyntaxAndProtocol).toHaveBeenCalledWith('https://192.168.1.1');
    expect(mockAddAllowedBaseUrl).not.toHaveBeenCalled();
  });

  it('should still block non-HTTP protocols even for Confluence URLs', async () => {
    mockValidateUrlSyntaxAndProtocol.mockImplementationOnce(() => {
      throw new Error('SSRF blocked');
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/settings/test-confluence',
      payload: { url: 'ftp://192.168.1.1', pat: 'test-pat' },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(false);
    expect(body.message).toContain('URL blocked');
    expect(mockUndiciRequest).not.toHaveBeenCalled();
    // #819: the probe never touches the global allowlist — nothing to remove.
    expect(mockAddAllowedBaseUrl).not.toHaveBeenCalled();
    expect(mockRemoveAllowedBaseUrl).not.toHaveBeenCalled();
  });

  it('should NOT mutate the SSRF allowlist on connection failure (#819)', async () => {
    mockUndiciRequest.mockRejectedValue(new Error('Connection refused'));

    const response = await app.inject({
      method: 'POST',
      url: '/api/settings/test-confluence',
      payload: { url: 'https://confluence.example.com', pat: 'test-pat' },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(false);
    // The probe validates non-mutatingly, so it neither adds nor removes.
    expect(mockAddAllowedBaseUrl).not.toHaveBeenCalled();
    expect(mockRemoveAllowedBaseUrl).not.toHaveBeenCalled();
  });

  it('should NOT mutate the SSRF allowlist on non-2xx response (#819)', async () => {
    mockUndiciRequest.mockResolvedValue({
      statusCode: 401,
      body: { dump: vi.fn().mockResolvedValue(undefined) },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/settings/test-confluence',
      payload: { url: 'https://confluence.example.com', pat: 'bad-pat' },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(false);
    expect(mockAddAllowedBaseUrl).not.toHaveBeenCalled();
    expect(mockRemoveAllowedBaseUrl).not.toHaveBeenCalled();
  });

  it('should NOT poison the SSRF allowlist on a successful probe (#819)', async () => {
    // The core of #819: a 2xx probe against an internal host previously left
    // that origin allowlisted in-memory AND broadcast it cluster-wide, weakening
    // the SSRF guard for every other fetch path until restart. The probe must
    // never add the origin to the allowlist — that is persisted solely by
    // PUT /settings when the URL is saved.
    mockUndiciRequest.mockResolvedValue({
      statusCode: 200,
      body: { dump: vi.fn().mockResolvedValue(undefined) },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/settings/test-confluence',
      payload: { url: 'https://confluence.example.com', pat: 'test-pat' },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
    expect(mockAddAllowedBaseUrl).not.toHaveBeenCalled();
    expect(mockRemoveAllowedBaseUrl).not.toHaveBeenCalled();
  });

  it('should reject invalid payload (missing url)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/settings/test-confluence',
      payload: { pat: 'test-pat' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('should use stored PAT when pat is omitted', async () => {
    // DB returns a stored encrypted PAT
    mockQuery.mockResolvedValueOnce({
      rows: [{ confluence_pat: 'v0:aabbcc:ddeeff:112233' }],
    });
    mockUndiciRequest.mockResolvedValue({
      statusCode: 200,
      body: { dump: vi.fn().mockResolvedValue(undefined) },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/settings/test-confluence',
      payload: { url: 'https://confluence.example.com' },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
    // Should have used the decrypted stored PAT
    expect(mockUndiciRequest).toHaveBeenCalledWith(
      'https://confluence.example.com/rest/api/space?limit=1',
      expect.objectContaining({
        headers: { Authorization: 'Bearer decrypted-stored-pat' },
      }),
    );
  });

  it('should return error when pat is omitted and none is stored', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ confluence_pat: null }] });

    const response = await app.inject({
      method: 'POST',
      url: '/api/settings/test-confluence',
      payload: { url: 'https://confluence.example.com' },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(false);
    expect(body.message).toContain('No PAT saved');
    expect(mockUndiciRequest).not.toHaveBeenCalled();
  });
});

describe('Settings routes – GET/PUT settings (shared tables)', () => {
  let app: ReturnType<typeof Fastify>;

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

    // Provide a fake redis for the invalidateUserData helper (never called in these tests)
    app.decorate('redis', {
      scan: vi.fn().mockResolvedValue({ cursor: '0', keys: [] }),
      del: vi.fn().mockResolvedValue(undefined),
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
    mockGetSelectedSyncSpaces.mockResolvedValue(['DEV', 'DOCS']);
    // #815: default to a PAT-configured user whose Confluence PAT can see DEV/DOCS.
    mockGetClientForUser.mockResolvedValue({
      getAllSpaces: vi.fn().mockResolvedValue([
        { key: 'DEV', name: 'Dev', type: 'global' },
        { key: 'DOCS', name: 'Docs', type: 'global' },
      ]),
    });
  });

  it('GET /settings returns settings from DB with accessible spaces from RBAC', async () => {
    // Query 1: user_settings
    mockQuery.mockResolvedValueOnce({
      rows: [{
        confluence_url: 'https://confluence.example.com',
        confluence_pat: 'encrypted',
        theme: 'glass-dark',
        sync_interval_min: 15,
        show_space_home_content: true,
      }],
    });
    // getUserAccessibleSpaces is mocked to return ['DEV', 'DOCS']

    const response = await app.inject({ method: 'GET', url: '/api/settings' });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.selectedSpaces).toEqual(['DEV', 'DOCS']);
    expect(body.confluenceUrl).toBe('https://confluence.example.com');
    expect(body.confluenceConnected).toBe(true);
  });

  it('GET /settings/sync-overview returns sync overview payload', async () => {
    mockGetSyncOverview.mockResolvedValueOnce({
      sync: { userId: 'test-user-id', status: 'syncing', progress: { current: 2, total: 5, space: 'OPS' } },
      totals: {
        selectedSpaces: 1,
        totalPages: 3,
        pagesWithAssets: 2,
        pagesWithIssues: 1,
        healthyPages: 2,
        images: { expected: 4, cached: 3, missing: 1 },
        drawio: { expected: 1, cached: 1, missing: 0 },
      },
      spaces: [{
        spaceKey: 'OPS',
        spaceName: 'Operations',
        status: 'syncing',
        lastSynced: '2026-03-11T10:00:00.000Z',
        pageCount: 3,
        pagesWithAssets: 2,
        pagesWithIssues: 1,
        images: { expected: 4, cached: 3, missing: 1 },
        drawio: { expected: 1, cached: 1, missing: 0 },
      }],
      issues: [{
        pageId: 'page-1',
        pageTitle: 'Runbook',
        spaceKey: 'OPS',
        missingImages: 1,
        missingDrawio: 0,
        missingFiles: ['missing.png'],
      }],
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/settings/sync-overview',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.sync.status).toBe('syncing');
    expect(body.totals.images.missing).toBe(1);
    expect(body.issues[0].missingFiles).toEqual(['missing.png']);
    expect(mockGetSyncOverview).toHaveBeenCalledWith('test-user-id');
  });

  it('GET /settings returns defaults when no row exists', async () => {
    // No spaces selected for a brand new user (#721: uses getSelectedSyncSpaces)
    mockGetSelectedSyncSpaces.mockResolvedValueOnce([]);
    // Query 1: user_settings -> no row
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // Query 2: INSERT default settings
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const response = await app.inject({ method: 'GET', url: '/api/settings' });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.selectedSpaces).toEqual([]);
    expect(body.theme).toBe('glass-dark');
  });

  it('PUT /settings does not mark pages dirty when only unrelated user settings change', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE user_settings

    await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { theme: 'polar-slate' },
    });

    const dirtyCalls = mockQuery.mock.calls.filter(
      (call) => typeof call[0] === 'string' && (call[0] as string).includes('embedding_dirty = TRUE') && (call[0] as string).includes('pages'),
    );
    expect(dirtyCalls).toHaveLength(0);
  });

  // NOTE: Shared admin LLM settings were removed from /api/settings in ADR-021.
  // Provider + use-case assignments are now served by
  // /api/admin/llm-providers and /api/admin/llm-usecases — see the dedicated
  // tests in `routes/llm/llm-providers.test.ts` + `routes/llm/llm-usecases.test.ts`.

  it('PUT /settings updates selectedSpaces via RBAC space_role_assignments', async () => {
    // Query: get editor role
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 3 }], rowCount: 1 });
    // DELETE old assignments
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // INSERT new assignment
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { selectedSpaces: ['DEV'] },
    });

    expect(response.statusCode).toBe(200);

    const deleteCalls = mockQuery.mock.calls.filter(
      (call) => typeof call[0] === 'string' && (call[0] as string).includes('DELETE FROM space_role_assignments'),
    );
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0][1]).toContain('test-user-id');
  });

  it('PUT /settings rejects selectedSpaces the caller\'s PAT cannot see (#815 privilege escalation)', async () => {
    // Attacker submits a space key that is NOT visible to their own PAT.
    // The PAT only sees DEV/DOCS (default mock), so CONFIDENTIAL must be rejected
    // and NO space_role_assignments row may be inserted.
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 3 }], rowCount: 1 }); // editor role (should not be reached, but safe)

    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { selectedSpaces: ['CONFIDENTIAL'] },
    });

    expect(response.statusCode).toBe(403);

    // The privilege-escalation INSERT must never run for an unauthorized space.
    const insertCalls = mockQuery.mock.calls.filter(
      (call) => typeof call[0] === 'string' && (call[0] as string).includes('INSERT INTO space_role_assignments'),
    );
    expect(insertCalls).toHaveLength(0);
  });

  it('PUT /settings allows selecting spaces the caller\'s PAT can see (#815)', async () => {
    // Query: get editor role
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 3 }], rowCount: 1 });
    // DELETE old assignments
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // INSERT new assignment
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { selectedSpaces: ['DOCS'] },
    });

    expect(response.statusCode).toBe(200);

    const insertCalls = mockQuery.mock.calls.filter(
      (call) => typeof call[0] === 'string' && (call[0] as string).includes('INSERT INTO space_role_assignments'),
    );
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0][1]).toContain('DOCS');
  });

  it('PUT /settings rejects selectedSpaces when the caller has no Confluence PAT (#815)', async () => {
    mockGetClientForUser.mockResolvedValueOnce(null);

    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { selectedSpaces: ['DEV'] },
    });

    expect(response.statusCode).toBe(400);

    const insertCalls = mockQuery.mock.calls.filter(
      (call) => typeof call[0] === 'string' && (call[0] as string).includes('INSERT INTO space_role_assignments'),
    );
    expect(insertCalls).toHaveLength(0);
  });

  it('PUT /settings allows deselecting all spaces without a PAT check (#815 preserves DELETE)', async () => {
    // Empty selection is a pure deselect — must not require a live PAT lookup.
    mockGetClientForUser.mockResolvedValueOnce(null);
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 3 }], rowCount: 1 }); // editor role
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // DELETE

    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { selectedSpaces: [] },
    });

    expect(response.statusCode).toBe(200);
    expect(mockGetClientForUser).not.toHaveBeenCalled();

    const deleteCalls = mockQuery.mock.calls.filter(
      (call) => typeof call[0] === 'string' && (call[0] as string).includes('DELETE FROM space_role_assignments'),
    );
    expect(deleteCalls).toHaveLength(1);
  });

  it('GET /settings returns customPrompts from DB', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        confluence_url: null, confluence_pat: null, theme: 'glass-dark', sync_interval_min: 15,
        show_space_home_content: true,
        custom_prompts: { improve_grammar: 'Fix grammar pls' },
      }],
    });
    // getUserAccessibleSpaces is mocked

    const response = await app.inject({ method: 'GET', url: '/api/settings' });
    const body = JSON.parse(response.body);

    expect(body.customPrompts).toEqual({ improve_grammar: 'Fix grammar pls' });
  });

  it('GET /settings returns empty customPrompts when no row exists', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [] }); // spaces (queried before the empty check)

    const response = await app.inject({ method: 'GET', url: '/api/settings' });
    const body = JSON.parse(response.body);

    expect(body.customPrompts).toEqual({});
  });

  it('PUT /settings rejects invalid customPrompts keys', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { customPrompts: { not_a_valid_key: 'bad' } },
    });

    expect(response.statusCode).toBe(400);
  });

  it('PUT /settings rejects customPrompts values exceeding 5000 chars', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { customPrompts: { improve_grammar: 'x'.repeat(5001) } },
    });

    expect(response.statusCode).toBe(400);
  });


  it('PUT /settings persists customPrompts as JSON', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE

    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { customPrompts: { improve_clarity: 'Be clear!' } },
    });

    expect(response.statusCode).toBe(200);

    const updateCalls = mockQuery.mock.calls.filter(
      (call) => typeof call[0] === 'string' && (call[0] as string).includes('custom_prompts'),
    );
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0][1]).toContain(JSON.stringify({ improve_clarity: 'Be clear!' }));
  });

  it('PUT /settings clears the stored PAT when confluencePat is null (#924)', async () => {
    // #924: confluencePat: null is a valid nullable value meaning "disconnect".
    // The handler must issue `confluence_pat = NULL` so the PAT is actually
    // wiped. Previously null was silently ignored — the PAT survived while
    // invalidateUserData still nuked the user's space_role_assignments, leaving
    // a connected PAT with no space access.
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE user_settings

    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { confluencePat: null },
    });

    expect(response.statusCode).toBe(200);

    // The UPDATE must set confluence_pat = NULL.
    const nullPatUpdate = mockQuery.mock.calls.filter(
      (call) =>
        typeof call[0] === 'string' &&
        (call[0] as string).includes('UPDATE user_settings') &&
        (call[0] as string).includes('confluence_pat = NULL'),
    );
    expect(nullPatUpdate).toHaveLength(1);
    // Must never encrypt a null PAT (no ciphertext bound into the query).
    expect(nullPatUpdate[0][1]).not.toContain('encrypted-pat');
  });

  it('PUT /settings removes old Confluence URL from SSRF allowlist when URL changes (#481)', async () => {
    // Query 1: SELECT old confluence_url
    mockQuery.mockResolvedValueOnce({
      rows: [{ confluence_url: 'https://old-confluence.example.com' }],
    });
    // Query 2: UPDATE user_settings
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { confluenceUrl: 'https://new-confluence.example.com' },
    });

    expect(response.statusCode).toBe(200);
    expect(mockRemoveAllowedBaseUrl).toHaveBeenCalledWith('https://old-confluence.example.com');
    expect(mockAddAllowedBaseUrl).toHaveBeenCalledWith('https://new-confluence.example.com');
  });

  it('PUT /settings removes old Confluence URL from SSRF allowlist when URL is cleared (#481)', async () => {
    // Query 1: SELECT old confluence_url
    mockQuery.mockResolvedValueOnce({
      rows: [{ confluence_url: 'https://old-confluence.example.com' }],
    });
    // Query 2: UPDATE user_settings
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { confluenceUrl: null },
    });

    expect(response.statusCode).toBe(200);
    expect(mockRemoveAllowedBaseUrl).toHaveBeenCalledWith('https://old-confluence.example.com');
    // Should NOT add null to the allowlist
    expect(mockAddAllowedBaseUrl).not.toHaveBeenCalled();
  });

  it('PUT /settings does not remove from allowlist when URL is unchanged (#481)', async () => {
    // Query 1: SELECT old confluence_url (same as new)
    mockQuery.mockResolvedValueOnce({
      rows: [{ confluence_url: 'https://confluence.example.com' }],
    });
    // Query 2: UPDATE user_settings
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { confluenceUrl: 'https://confluence.example.com' },
    });

    expect(response.statusCode).toBe(200);
    // Same URL -- no removal needed
    expect(mockRemoveAllowedBaseUrl).not.toHaveBeenCalled();
    // But still re-register it (idempotent)
    expect(mockAddAllowedBaseUrl).toHaveBeenCalledWith('https://confluence.example.com');
  });

  it('GET /settings returns only explicitly-selected spaces, not all admin-accessible spaces (#721)', async () => {
    // Simulate an admin who has access to two spaces via RBAC (ENG+OPS),
    // but has only explicitly selected ENG (i.e. getSelectedSyncSpaces==['ENG']).
    mockGetSelectedSyncSpaces.mockResolvedValueOnce(['ENG']);

    mockQuery.mockResolvedValueOnce({
      rows: [{
        confluence_url: 'https://confluence.example.com',
        confluence_pat: 'encrypted',
        theme: 'glass-dark',
        sync_interval_min: 15,
        show_space_home_content: true,
        custom_prompts: {},
      }],
    });

    const response = await app.inject({ method: 'GET', url: '/api/settings' });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    // Must be only the explicitly-selected space, NOT all RBAC-accessible spaces.
    expect(body.selectedSpaces).toEqual(['ENG']);
    expect(mockGetSelectedSyncSpaces).toHaveBeenCalled();
    expect(mockGetUserAccessibleSpaces).not.toHaveBeenCalled();
  });
});
