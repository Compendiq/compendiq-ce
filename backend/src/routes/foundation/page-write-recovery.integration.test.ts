import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import { ZodError } from 'zod';
import { getPool, query } from '../../core/db/postgres.js';
import { reservePageWriteIntent } from '../../core/services/page-write-admission.js';
import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables } from '../../test-db-helper.js';
import { pageWriteRecoveryRoutes } from './page-write-recovery.js';

const available = await isDbAvailable();

describe.skipIf(!available)('page writer recovery administration', () => {
  let app: FastifyInstance;
  let actorId: string;

  beforeAll(async () => {
    await setupTestDb();
    await truncateAllTables();
    const actor = await query<{ id: string }>(
      "INSERT INTO users (username, password_hash, role) VALUES ('recovery-admin', 'x', 'admin') RETURNING id",
    );
    actorId = actor.rows[0]!.id;
    app = Fastify({ logger: false });
    // Deliberately retains the old admin claim after DB revocation below.
    app.decorate('requireAdmin', async (request: { userId: string; userRole: string }) => {
      request.userId = actorId;
      request.userRole = 'admin';
    });
    app.setErrorHandler((error, _request, reply) => {
      reply.status(error instanceof ZodError ? 400 : error.statusCode ?? 500).send({
        error: error.message,
        reason: 'reason' in error ? error.reason : undefined,
      });
    });
    await app.register(pageWriteRecoveryRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  it('requires live admin authority and exact owner acknowledgment without accepting caller recovery proof', async () => {
    const writer = await query<{ id: string }>(
      `INSERT INTO users (username, password_hash, role)
       VALUES ($1, 'x', 'user') RETURNING id`,
      [`recovery-original-writer-${randomUUID()}`],
    );
    const writerId = writer.rows[0]!.id;
    const page = await query<{ id: number }>(
      `INSERT INTO pages (source, title, body_html, body_storage, body_text, created_by_user_id, visibility)
       VALUES ('standalone', 'Recovery', '<p>Body</p>', '', 'Body', $1, 'shared') RETURNING id`,
      [writerId],
    );
    const pageId = page.rows[0]!.id;
    const intent = await reservePageWriteIntent({
      pageIds: [pageId],
      actorId: writerId,
      kind: 'attachment.local.put',
      effect: { effectClass: 'local', pageId, files: [], operatorPrivateNote: 'do-not-publish-this' },
    });
    const url = '/api/admin/page-write-recovery';
    const state = await app.inject({ method: 'GET', url: `${url}?pageId=${pageId}` });
    expect(state.statusCode, state.body).toBe(200);
    expect(state.json().intents).toEqual([expect.objectContaining({ id: intent.id, pageIds: [pageId] })]);
    expect(state.body).not.toContain('do-not-publish-this');
    expect(state.json().intents[0]).not.toHaveProperty('effect');
    expect(state.json().intents[0]).not.toHaveProperty('actorId');
    expect(state.json().limitPerCollection).toBe(500);
    expect(state.json().truncated).toEqual({ intents: false, admissions: false, runtimes: false });
    await query(
      `INSERT INTO page_writer_runtimes (runtime_id, deployment_identity)
       SELECT gen_random_uuid()::text,
              jsonb_build_object('host', 'status-boundary-fixture', 'pid', 1, 'startedAt', $1::text)
       FROM generate_series(1, 501)`,
      [new Date().toISOString()],
    );
    const otherPage = await query<{ id: number }>(
      `INSERT INTO pages (source, title, visibility, created_by_user_id)
       VALUES ('standalone', 'Other admitted page', 'shared', $1) RETURNING id`,
      [writerId],
    );
    await query(
      `INSERT INTO page_runtime_admissions (runtime_id, page_id, actor_id, lifecycle_revision)
       SELECT runtime_id, $1, $2::uuid, 0 FROM page_writer_runtimes
        WHERE deployment_identity->>'host' = 'status-boundary-fixture'`,
      [otherPage.rows[0]!.id, writerId],
    );
    const bounded = await app.inject({ method: 'GET', url });
    expect(bounded.statusCode, bounded.body).toBe(200);
    expect(bounded.json().runtimes).toHaveLength(500);
    expect(bounded.json().truncated.runtimes).toBe(true);
    const scoped = await app.inject({ method: 'GET', url: `${url}?pageId=${pageId}` });
    expect(scoped.statusCode, scoped.body).toBe(200);
    expect(scoped.json().truncated.runtimes).toBe(false);
    expect(scoped.json().runtimes.map((runtime: { runtimeId: string }) => runtime.runtimeId)).toEqual([intent.runtimeId]);
    await query(`DELETE FROM page_runtime_admissions WHERE runtime_id IN (
      SELECT runtime_id FROM page_writer_runtimes WHERE deployment_identity->>'host' = 'status-boundary-fixture'
    )`);
    await query("DELETE FROM page_writer_runtimes WHERE deployment_identity->>'host' = 'status-boundary-fixture'");

    await query("UPDATE users SET role = 'user' WHERE id = $1", [actorId]);
    const revoked = await app.inject({ method: 'GET', url });
    expect(revoked.statusCode, revoked.body).toBe(403);
    await query("UPDATE users SET role = 'admin' WHERE id = $1", [actorId]);

    const guardedRuntimeId = `route-guard-${randomUUID()}`;
    await query(
      `INSERT INTO page_writer_runtimes (runtime_id, deployment_identity)
       VALUES ($1, $2::jsonb)`,
      [
        guardedRuntimeId,
        JSON.stringify({ host: 'route-guard-fixture', pid: 999999, startedAt: new Date().toISOString() }),
      ],
    );

    const authorityBlocker = await getPool().connect();
    let waitingMutation: Promise<LightMyRequestResponse> | undefined;
    try {
      await authorityBlocker.query('BEGIN');
      await authorityBlocker.query("UPDATE users SET role = 'user' WHERE id = $1", [actorId]);
      const blockerPid = (await authorityBlocker.query<{ pid: number }>(
        'SELECT pg_backend_pid() AS pid',
      )).rows[0]!.pid;
      waitingMutation = app.inject({
        method: 'POST',
        url: `${url}/runtimes/${guardedRuntimeId}/fence`,
        payload: {
          mode: 'durable_no_started_effects',
          reason: 'Route admission cannot outlive committed administrator demotion',
        },
      });
      await vi.waitFor(async () => {
        const wait = await query<{ waiting: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_stat_activity
              WHERE datname = current_database()
                AND wait_event_type = 'Lock'
                AND $1 = ANY(pg_blocking_pids(pid))
           ) AS waiting`,
          [blockerPid],
        );
        expect(wait.rows[0]!.waiting).toBe(true);
      });
      await authorityBlocker.query('COMMIT');
      const demotedMutation = await waitingMutation;
      expect(demotedMutation.statusCode, demotedMutation.body).toBe(403);
      expect(demotedMutation.json().reason).toBe('recovery_admin_required');
      expect((await query<{ retired: boolean }>(
        'SELECT fenced_at IS NOT NULL AS retired FROM page_writer_runtimes WHERE runtime_id = $1',
        [guardedRuntimeId],
      )).rows[0]!.retired).toBe(false);
    } finally {
      await authorityBlocker.query('ROLLBACK').catch(() => undefined);
      authorityBlocker.release();
      await waitingMutation?.catch(() => undefined);
      await query("UPDATE users SET role = 'admin' WHERE id = $1", [actorId]).catch(() => undefined);
      await query('DELETE FROM page_writer_runtimes WHERE runtime_id = $1', [guardedRuntimeId]).catch(() => undefined);
    }

    const forgedProof = await app.inject({
      method: 'POST', url: `${url}/intents/${intent.id}/reconcile`,
      payload: { reason: 'Attempt to invent an external outcome', proof: { applied: true } },
    });
    expect(forgedProof.statusCode, forgedProof.body).toBe(400);
    const forgedAck = await app.inject({
      method: 'POST', url: `${url}/runtimes/${intent.runtimeId}/fence`,
      payload: { mode: 'owner_ack', acknowledgmentId: randomUUID(), reason: 'A forged acknowledgment must not fence the writer' },
    });
    expect(forgedAck.statusCode, forgedAck.body).toBe(409);
    const wrongTarget = await app.inject({
      method: 'POST', url: `${url}/runtime/quiesce`,
      payload: { expectedRuntimeId: randomUUID(), reason: 'Must not drain a different load-balanced backend' },
    });
    expect(wrongTarget.statusCode, wrongTarget.body).toBe(409);
    const inventedIdentity = await app.inject({
      method: 'POST', url: `${url}/runtimes/${intent.runtimeId}/fence`,
      payload: {
        mode: 'verified_local_termination',
        reason: 'A caller must not supply process death evidence',
        deploymentIdentity: { pid: 999999 },
      },
    });
    expect(inventedIdentity.statusCode, inventedIdentity.body).toBe(400);
    const livingOwner = await app.inject({
      method: 'POST', url: `${url}/runtimes/${intent.runtimeId}/fence`,
      payload: { mode: 'verified_local_termination', reason: 'The receiving process is still demonstrably alive' },
    });
    expect(livingOwner.statusCode, livingOwner.body).toBe(409);

    const idleRuntime = 'another-runtime-with-no-started-effects';
    await query(
      `INSERT INTO page_writer_runtimes (runtime_id, deployment_identity)
       VALUES ($1, $2::jsonb)`,
      [idleRuntime, JSON.stringify({ host: 'another-host', pid: 1, startedAt: new Date().toISOString() })],
    );
    const idleFence = await app.inject({
      method: 'POST', url: `${url}/runtimes/${idleRuntime}/fence`,
      payload: { mode: 'durable_no_started_effects', reason: 'Retire an epoch with no dispatched external work' },
    });
    expect(idleFence.statusCode, idleFence.body).toBe(200);
    expect(idleFence.json().unresolvedIntents).toBe(0);

    const quiet = await app.inject({
      method: 'POST',
      url: `${url}/runtime/quiesce`,
      remoteAddress: '203.0.113.17',
      headers: { 'user-agent': 'page-write-recovery-test-agent' },
      payload: { expectedRuntimeId: intent.runtimeId, reason: 'Retire this backend after removing it from service' },
    });
    expect(quiet.statusCode, quiet.body).toBe(200);
    const acknowledgment = quiet.json<{ runtimeId: string; acknowledgmentId: string }>();
    expect(acknowledgment.runtimeId).toBe(intent.runtimeId);
    const fenced = await app.inject({
      method: 'POST', url: `${url}/runtimes/${intent.runtimeId}/fence`,
      payload: { mode: 'owner_ack', acknowledgmentId: acknowledgment.acknowledgmentId, reason: 'Fence the acknowledged retired process epoch' },
    });
    expect(fenced.statusCode, fenced.body).toBe(200);
    expect(fenced.json().unresolvedIntents).toBe(0);
    const settled = await app.inject({ method: 'GET', url: `${url}?pageId=${pageId}` });
    expect(settled.statusCode, settled.body).toBe(200);
    expect(settled.json().intents).toEqual([]);
    const audit = await query<{
      metadata: { reason: string };
      ip_address: string | null;
      user_agent: string | null;
    }>(
      `SELECT metadata, ip_address, user_agent
         FROM audit_log
        WHERE user_id = $1 AND resource_id = $2
          AND metadata->>'action' = 'page_writer_quiesce_requested'`,
      [actorId, intent.runtimeId],
    );
    expect(audit.rows).toEqual([{
      metadata: expect.objectContaining({ reason: 'Retire this backend after removing it from service' }),
      ip_address: '203.0.113.17',
      user_agent: 'page-write-recovery-test-agent',
    }]);
  });
});
