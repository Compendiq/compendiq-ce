import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Queue } from 'bullmq';
import { createClient } from 'redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { query } from '../db/postgres.js';
import { getRedisConnectionOpts } from '../utils/redis-connection.js';
import { setRedisClient } from './redis-cache.js';
import { startQueueWorkers, stopQueueWorkers } from './queue-service.js';
import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables } from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';

const available = await isDbAvailable() && await isRedisAvailable();
const names = ['sync', 'quality', 'summary', 'maintenance', 'reembed-all', 'shadow-reembed', 'backup'];
const queues: Queue[] = [];
const redis = createClient({ url: process.env.REDIS_URL });
let server: Server;
let rejectRequests = true;

function respond(response: ServerResponse) {
  if (rejectRequests) {
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'Private upstream diagnostic: no models loaded' }));
    return;
  }
  const content = '## Overall Quality Score: 75/100\n## Completeness: 80/100\n## Clarity: 70/100\n## Structure: 78/100\n## Accuracy: 72/100\n## Readability: 68/100\n## Summary\nThe article documents the deployment.';
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`);
}

// Real BullMQ, Redis, PostgreSQL, workers and provider client. Only inference
// is replaced: a failed HTTP response must become a failed job, not success.
describe.skipIf(!available)('quality and summary job outcomes', () => {
  beforeAll(async () => {
    await setupTestDb();
    await truncateAllTables();
    await redis.connect();
    setRedisClient(redis);
    server = createServer((request, response) => {
      request.resume();
      request.on('end', () => respond(response));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    await query("INSERT INTO spaces (space_key, space_name) VALUES ('WORKER', 'Worker regression')");
    // Separate providers prevent one worker's open breaker from hiding the
    // other worker's real HTTP failure/recovery.
    for (const kind of ['quality', 'summary']) {
      const provider = await query<{ id: string }>(
        `INSERT INTO llm_providers (name, base_url, auth_type, verify_ssl)
         VALUES ($1, $2, 'none', TRUE) RETURNING id`, [kind, baseUrl],
      );
      await query(
        'INSERT INTO llm_usecase_assignments (usecase, provider_id, model) VALUES ($1, $2, $3)',
        [kind, provider.rows[0]!.id, 'worker-model'],
      );
    }
    // Keep unrelated schedulers asleep in this worker-isolated test Redis DB.
    for (const name of names) {
      const queue = new Queue(name, { connection: getRedisConnectionOpts() });
      queues.push(queue);
      await queue.pause();
    }
    await startQueueWorkers();
    for (const name of ['quality', 'summary']) {
      const queue = queues.find((item) => item.name === name)!;
      await queue.removeJobScheduler(`${name}-scheduler`);
      await queue.drain(true);
    }
  });

  afterAll(async () => {
    await stopQueueWorkers();
    for (const queue of queues) {
      await queue.obliterate({ force: true });
      await queue.close();
    }
    await redis.quit();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    await teardownTestDb();
  });

  it.each(['quality', 'summary'])('%s records a provider failure and later recovers without reporting false success', async (kind) => {
    await query('DELETE FROM pages');
    await query(
      `INSERT INTO pages (space_key, title, body_text, quality_status, summary_status)
       VALUES ('WORKER', 'Deployment', $1, 'pending', 'pending')`,
      ['The deployment guide explains setup, operation and recovery. '.repeat(8)],
    );
    const queue = queues.find((item) => item.name === kind)!;
    rejectRequests = true;
    await queue.resume();
    const failed = await queue.add('provider-failure', {}, { attempts: 1 });
    await expect.poll(() => failed.getState()).toBe('failed');
    const history = await query<{ status: string; error_message: string; result_summary: string | null }>(
      'SELECT status, error_message, result_summary FROM job_history WHERE queue_name = $1 AND job_id = $2',
      [kind, failed.id],
    );
    expect(history.rows).toEqual([expect.objectContaining({ status: 'failed', result_summary: null })]);
    expect(history.rows[0]!.error_message).toContain('1 failed');
    expect(history.rows[0]!.error_message).not.toContain('Private upstream diagnostic');

    rejectRequests = false;
    const recovered = await queue.add('provider-recovered', {}, { attempts: 1 });
    await expect.poll(() => recovered.getState()).toBe('completed');
    const page = await query<{ quality_status: string; summary_status: string }>(
      'SELECT quality_status, summary_status FROM pages',
    );
    expect(page.rows[0]![kind === 'quality' ? 'quality_status' : 'summary_status'])
      .toBe(kind === 'quality' ? 'analyzed' : 'summarized');
    await queue.pause();
  });
});
