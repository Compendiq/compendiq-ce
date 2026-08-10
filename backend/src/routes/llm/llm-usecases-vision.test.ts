import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * #1184 — the vision capability routes, exercised against the **real**
 * `model-capabilities` service and a real Postgres.
 *
 * Deliberately a separate file from `llm-usecases.test.ts`: that one replaces
 * the whole capability module with `vi.mock`, which is the right call for the
 * assignment-CRUD tests but makes it structurally incapable of proving the
 * thing this issue most needs proven — that `probe_error`, which lives in the
 * database, does not reach a non-admin caller. Here the only mock is the
 * outbound HTTP probe.
 */

// Short-circuit the SSRF guard's DNS lookups (see llm-usecases.test.ts).
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => {
    const err = new Error('getaddrinfo ENOTFOUND (mocked)') as NodeJS.ErrnoException;
    err.code = 'ENOTFOUND';
    throw err;
  }),
}));

// The one mock: the outbound probe. Everything below it — the capability
// store, the routes, the schemas — is the real thing.
const mockProbeVision = vi.fn();
vi.mock('../../domains/llm/services/vision-probe.js', () => ({
  probeVision: (...args: unknown[]) => mockProbeVision(...args),
}));

import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../test-db-helper.js';
import { query } from '../../core/db/postgres.js';
import { buildApp } from '../../app.js';
import { generateAccessToken } from '../../core/plugins/auth.js';
import { VisionCapabilityDetailSchema } from '@compendiq/contracts';
import { PROBE_ERROR_MAX_CHARS } from '../../domains/llm/services/model-capabilities.js';
import {
  setLlmAdminAuditHook,
  type LlmAdminAuditEntry,
} from '../../domains/llm/services/llm-audit-hook.js';

/**
 * The provider's raw error body, as `probeVision` would have stored it. Shaped
 * like the disclosure this is guarding against: an internal hostname and a
 * fragment of the request that produced it.
 */
const SECRET_PROBE_ERROR =
  'chat HTTP 401: {"error":"no key for tenant-7 at llm-internal.corp.lan:11434","request_id":"req_9f3"}';

async function createUser(username: string, role: 'admin' | 'user'): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO users (username, password_hash, role) VALUES ($1, 'fakehash', $2) RETURNING id`,
    [username, role],
  );
  const userId = rows[0]!.id;
  await query('INSERT INTO user_settings (user_id) VALUES ($1)', [userId]);
  return generateAccessToken({ sub: userId, username, role });
}

const dbAvailable = await isDbAvailable();

let app: FastifyInstance;
let adminToken: string;
let memberToken: string;

beforeAll(async () => {
  if (!dbAvailable) return;
  await setupTestDb();
  app = await buildApp();
  await app.ready();
}, 30_000);

afterAll(async () => {
  if (!dbAvailable) return;
  await app?.close();
  await teardownTestDb();
});

beforeEach(async () => {
  if (!dbAvailable) return;
  await truncateAllTables();
  mockProbeVision.mockReset();
  adminToken = await createUser('vision_admin', 'admin');
  memberToken = await createUser('vision_member', 'user');
});

/** Create a provider, make it the default, and return its id + model. */
async function seedDefaultProvider(model = 'qwen2.5vl'): Promise<{ providerId: string; model: string }> {
  const created = await app.inject({
    method: 'POST',
    url: '/api/admin/llm-providers',
    headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    payload: JSON.stringify({
      name: 'Vision Provider',
      baseUrl: 'http://vision-host/v1',
      authType: 'none',
      verifySsl: true,
      defaultModel: model,
    }),
  });
  const providerId: string = created.json().id;
  await app.inject({
    method: 'POST',
    url: `/api/admin/llm-providers/${providerId}/set-default`,
    headers: { authorization: `Bearer ${adminToken}` },
  });
  return { providerId, model };
}

async function seedCapability(
  providerId: string,
  model: string,
  vision: boolean | null,
  probeError: string | null,
): Promise<void> {
  await query(
    `INSERT INTO llm_model_capabilities (provider_id, model, vision, probed_at, probe_error)
     VALUES ($1, $2, $3, NOW(), $4)`,
    [providerId, model, vision, probeError],
  );
}

describe.skipIf(!dbAvailable)('GET /api/admin/llm-usecases/chat/vision-capability (#1184)', () => {
  it('returns the stored verdict, timestamp and probe error to an admin', async () => {
    const { providerId, model } = await seedDefaultProvider();
    await seedCapability(providerId, model, false, SECRET_PROBE_ERROR);

    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/llm-usecases/chat/vision-capability',
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      providerId,
      model,
      vision: false,
      probedAt: expect.any(String),
      probeError: SECRET_PROBE_ERROR,
    });
    expect(() => VisionCapabilityDetailSchema.parse(res.json())).not.toThrow();
  });

  it('answers with nulls rather than 404 for a pair that has never been probed', async () => {
    const { providerId, model } = await seedDefaultProvider();

    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/llm-usecases/chat/vision-capability',
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      providerId,
      model,
      vision: null,
      probedAt: null,
      probeError: null,
    });
  });

  it('does not probe when read', async () => {
    await seedDefaultProvider();

    await app.inject({
      method: 'GET',
      url: '/api/admin/llm-usecases/chat/vision-capability',
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(mockProbeVision).not.toHaveBeenCalled();
  });

  it('404s with a specific message when no provider is configured', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/llm-usecases/chat/vision-capability',
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain('Settings → AI Models');
  });

  it('rejects a non-admin with 403', async () => {
    const { providerId, model } = await seedDefaultProvider();
    await seedCapability(providerId, model, false, SECRET_PROBE_ERROR);

    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/llm-usecases/chat/vision-capability',
      headers: { authorization: `Bearer ${memberToken}` },
    });

    expect(res.statusCode).toBe(403);
    expect(res.payload).not.toContain('llm-internal.corp.lan');
  });

  it('rejects an unauthenticated caller with 401', async () => {
    await seedDefaultProvider();

    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/llm-usecases/chat/vision-capability',
    });

    expect(res.statusCode).toBe(401);
  });
});

/**
 * The single most important guarantee in #1184. `GET /llm/usecase-default` is
 * `fastify.authenticate` but **not** `requireAdmin`, so every logged-in user
 * can call it. `probe_error` is the provider's raw error body, which
 * `llm-http-error.ts` documents as kept off client-visible paths because it
 * can echo request fragments and internal topology.
 *
 * A row with a probe error is present in the database for the exact pair this
 * route resolves, so the route has it within reach — the assertion is that it
 * still does not come out.
 */
describe.skipIf(!dbAvailable)('probe_error does not leak to non-admin callers (#1184)', () => {
  it('omits probeError from GET /llm/usecase-default for a non-admin', async () => {
    const { providerId, model } = await seedDefaultProvider();
    await seedCapability(providerId, model, false, SECRET_PROBE_ERROR);

    const res = await app.inject({
      method: 'GET',
      url: '/api/llm/usecase-default?usecase=chat',
      headers: { authorization: `Bearer ${memberToken}` },
    });

    expect(res.statusCode).toBe(200);
    // The verdict itself is public — the evidence behind it is not.
    expect(res.json().vision).toBe(false);
    expect(Object.keys(res.json()).sort()).toEqual([
      'model',
      'providerId',
      'providerName',
      'usecase',
      'vision',
    ]);
    // Belt and braces: no substring of the stored error, under any key name.
    expect(res.payload).not.toContain('llm-internal.corp.lan');
    expect(res.payload).not.toContain('tenant-7');
    expect(res.payload).not.toContain('req_9f3');
  });

  it('omits probedAt too — staleness is an admin concern', async () => {
    const { providerId, model } = await seedDefaultProvider();
    await seedCapability(providerId, model, true, null);

    const res = await app.inject({
      method: 'GET',
      url: '/api/llm/usecase-default?usecase=chat',
      headers: { authorization: `Bearer ${memberToken}` },
    });

    expect(res.json()).not.toHaveProperty('probedAt');
  });

  it('refuses a non-admin re-probe outright', async () => {
    await seedDefaultProvider();

    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/llm-usecases/chat/reprobe-vision',
      headers: { authorization: `Bearer ${memberToken}` },
    });

    expect(res.statusCode).toBe(403);
    expect(mockProbeVision).not.toHaveBeenCalled();
  });
});

describe.skipIf(!dbAvailable)('POST /api/admin/llm-usecases/chat/reprobe-vision (#1184)', () => {
  it('re-probes the resolved chat pair and overwrites a stored false verdict', async () => {
    const { providerId, model } = await seedDefaultProvider();
    await seedCapability(providerId, model, false, 'stale rejection');
    mockProbeVision.mockResolvedValue({ vision: true });

    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/llm-usecases/chat/reprobe-vision',
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      providerId,
      model,
      vision: true,
      probedAt: expect.any(String),
      probeError: null,
    });
    // The cached row, not just the response, moved.
    const { rows } = await query<{ vision: boolean; probe_error: string | null }>(
      `SELECT vision, probe_error FROM llm_model_capabilities WHERE provider_id=$1 AND model=$2`,
      [providerId, model],
    );
    expect(rows[0]).toEqual({ vision: true, probe_error: null });
  });

  it('probes even when a fresh verdict is already cached', async () => {
    const { providerId, model } = await seedDefaultProvider();
    await seedCapability(providerId, model, true, null);
    mockProbeVision.mockResolvedValue({ vision: true });

    await app.inject({
      method: 'POST',
      url: '/api/admin/llm-usecases/chat/reprobe-vision',
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(mockProbeVision).toHaveBeenCalledTimes(1);
  });

  it('returns the probe error behind an inconclusive verdict', async () => {
    await seedDefaultProvider();
    mockProbeVision.mockResolvedValue({ vision: null, error: SECRET_PROBE_ERROR });

    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/llm-usecases/chat/reprobe-vision',
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().vision).toBeNull();
    expect(res.json().probeError).toBe(SECRET_PROBE_ERROR);
  });

  /**
   * A non-HTTP failure stores `err.message` verbatim into an untyped TEXT
   * column, so the bound has to be applied on the way out.
   */
  it('truncates an oversized probe error', async () => {
    await seedDefaultProvider();
    mockProbeVision.mockResolvedValue({
      vision: null,
      error: 'z'.repeat(PROBE_ERROR_MAX_CHARS * 4),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/llm-usecases/chat/reprobe-vision',
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(res.json().probeError.length).toBeLessThanOrEqual(PROBE_ERROR_MAX_CHARS);
  });

  it('404s when no provider is configured, without probing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/llm-usecases/chat/reprobe-vision',
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(res.statusCode).toBe(404);
    expect(mockProbeVision).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated caller with 401', async () => {
    await seedDefaultProvider();

    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/llm-usecases/chat/reprobe-vision',
    });

    expect(res.statusCode).toBe(401);
    expect(mockProbeVision).not.toHaveBeenCalled();
  });
});

/**
 * A manual re-probe is an admin mutating shared LLM configuration, so it emits
 * an admin audit event like every other mutating route in this file. Nothing
 * asserted that until now: CE registers no admin hook, so `emitLlmAudit` is a
 * no-op and deleting the call left both route test files green — a refactor
 * could drop the event and EE would silently lose the attestation.
 */
describe.skipIf(!dbAvailable)('the manual re-probe is audited (#1184)', () => {
  const entries: LlmAdminAuditEntry[] = [];
  /** CE registers no admin hook, so "restoring" means going back to a no-op. */
  const noopHook = async () => {};

  beforeEach(() => {
    entries.length = 0;
  });

  async function withRecordingHook(run: () => Promise<void>): Promise<void> {
    setLlmAdminAuditHook(async (entry) => {
      entries.push(entry);
    });
    try {
      await run();
    } finally {
      setLlmAdminAuditHook(noopHook);
    }
  }

  it('emits llm_vision_capability_reprobed naming the pair and the verdict', async () => {
    const { providerId, model } = await seedDefaultProvider();
    mockProbeVision.mockResolvedValue({ vision: true });

    await withRecordingHook(async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/llm-usecases/chat/reprobe-vision',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      // Fire-and-forget by contract, so poll rather than assume it has landed.
      await vi.waitFor(() => expect(entries).toHaveLength(1));
    });

    expect(entries[0]).toMatchObject({
      event: 'llm_vision_capability_reprobed',
      metadata: { providerId, model, vision: true },
    });
    expect(entries[0]!.userId).toEqual(expect.any(String));
  });

  it('records the verdict that was actually reached, not a presumed success', async () => {
    await seedDefaultProvider();
    mockProbeVision.mockResolvedValue({ vision: null, error: SECRET_PROBE_ERROR });

    await withRecordingHook(async () => {
      await app.inject({
        method: 'POST',
        url: '/api/admin/llm-usecases/chat/reprobe-vision',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      await vi.waitFor(() => expect(entries).toHaveLength(1));
    });

    expect(entries[0]!.metadata).toMatchObject({ vision: null });
    // The audit trail is not a back door for the provider's error body either.
    expect(JSON.stringify(entries[0])).not.toContain('llm-internal.corp.lan');
  });

  it('does not emit for the read-only capability route', async () => {
    await seedDefaultProvider();

    await withRecordingHook(async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/llm-usecases/chat/vision-capability',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
    });

    expect(entries).toEqual([]);
  });

  it('does not emit when the re-probe is refused', async () => {
    await seedDefaultProvider();

    await withRecordingHook(async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/llm-usecases/chat/reprobe-vision',
        headers: { authorization: `Bearer ${memberToken}` },
      });
      expect(res.statusCode).toBe(403);
    });

    expect(entries).toEqual([]);
  });
});
