import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { query } from '../../../core/db/postgres.js';
import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables } from '../../../test-db-helper.js';
import { getSummaryStatus, runSummaryBatch, triggerSummaryBatch } from './summary-worker.js';

// Real persistence, resolver, streaming client, breaker, and no-Redis locking.
// Only the external provider is replaced by a local HTTP endpoint.
const dbAvailable = await isDbAvailable();
const MODEL = 'summary-integration-model';
const PRIVATE_PROVIDER_BODY = 'No models loaded; private provider internals';
// Lock, resolver, sweep and candidate queries run against a shared CI Postgres
// before the provider request lands; the default 1s wait is too tight there.
const HELD_WAIT = { timeout: 10_000 };
let server: Server;
let baseUrl: string;
let calls = 0;
let respond: (response: ServerResponse) => void;

function sendSummary(response: ServerResponse, content = 'The deployment runs nightly.') {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`);
}

async function seedPage(title: string, body = 'Deployment documentation. '.repeat(10), modifiedAt = '2026-01-01') {
  const result = await query<{ id: number }>(
    `INSERT INTO pages (space_key, title, body_text, summary_status, last_modified_at)
     VALUES ('SUMMARY', $1, $2, 'pending', $3) RETURNING id`,
    [title, body, modifiedAt],
  );
  return result.rows[0]!.id;
}

async function readPage(id: number) {
  const result = await query<{
    summary_status: string;
    summary_text: string | null;
    summary_error: string | null;
    summary_retry_count: number;
    summary_model: string | null;
  }>(
    `SELECT summary_status, summary_text, summary_error, summary_retry_count, summary_model
     FROM pages WHERE id = $1`,
    [id],
  );
  return result.rows[0]!;
}

describe.skipIf(!dbAvailable)('summary worker batch outcomes and exclusion', () => {
  beforeAll(async () => {
    await setupTestDb();
    server = createServer((request, response) => {
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
        response.writeHead(404);
        response.end();
        return;
      }
      request.on('data', () => undefined);
      request.on('end', () => {
        calls++;
        respond(response);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });

  beforeEach(async () => {
    await truncateAllTables();
    calls = 0;
    respond = (response) => sendSummary(response);
    await query("INSERT INTO spaces (space_key, space_name) VALUES ('SUMMARY', 'Summary tests')");
    const provider = await query<{ id: string }>(
      `INSERT INTO llm_providers (name, base_url, auth_type, verify_ssl, default_model)
       VALUES ('summary-test', $1, 'none', TRUE, $2) RETURNING id`,
      [baseUrl, MODEL],
    );
    await query(
      `INSERT INTO llm_usecase_assignments (usecase, provider_id, model) VALUES ('summary', $1, $2)`,
      [provider.rows[0]!.id, MODEL],
    );
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
    await teardownTestDb();
  });

  it('counts a provider HTTP failure as failed, persists retry state, and withholds its raw body', async () => {
    const id = await seedPage('Provider failure');
    respond = (response) => {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: PRIVATE_PROVIDER_BODY }));
    };

    expect(await runSummaryBatch()).toEqual({ processed: 0, errors: 1 });
    const failed = await readPage(id);
    expect(failed).toMatchObject({ summary_status: 'failed', summary_retry_count: 1, summary_text: null });
    expect(failed.summary_error).toContain('HTTP 400');
    expect(failed.summary_error).not.toContain(PRIVATE_PROVIDER_BODY);
    expect((await getSummaryStatus()).isProcessing).toBe(false);

    respond = (response) => sendSummary(response);
    expect(await runSummaryBatch('manual-model')).toEqual({ processed: 1, errors: 0 });
    expect(await readPage(id)).toMatchObject({
      summary_status: 'summarized', summary_retry_count: 0, summary_error: null, summary_model: 'manual-model',
    });
  });

  it('continues after a failed page and counts successful and deliberately short pages separately', async () => {
    const failed = await seedPage('Fails first', undefined, '2026-01-03');
    const success = await seedPage('Succeeds next', undefined, '2026-01-02');
    const skipped = await seedPage('Short last', 'short', '2026-01-01');
    respond = (response) => {
      if (calls === 1) {
        response.writeHead(400);
        response.end(PRIVATE_PROVIDER_BODY);
      } else {
        sendSummary(response);
      }
    };

    expect(await runSummaryBatch()).toEqual({ processed: 2, errors: 1 });
    expect(await readPage(failed)).toMatchObject({ summary_status: 'failed', summary_retry_count: 1 });
    expect(await readPage(success)).toMatchObject({ summary_status: 'summarized', summary_text: 'The deployment runs nightly.' });
    expect(await readPage(skipped)).toMatchObject({ summary_status: 'skipped', summary_retry_count: 0 });
    expect(calls).toBe(2);
  });

  it('counts circuit-breaker rejections as failures without draining beyond the five-page batch', async () => {
    for (let index = 0; index < 6; index++) await seedPage(`Failure ${index}`);
    respond = (response) => {
      response.writeHead(400);
      response.end(PRIVATE_PROVIDER_BODY);
    };

    expect(await runSummaryBatch()).toEqual({ processed: 0, errors: 5 });
    const status = await getSummaryStatus();
    expect(status.failedPages).toBe(5);
    expect(status.pendingPages).toBe(1);
    expect(calls).toBe(3); // Remaining failures are real breaker rejections, not HTTP requests.
  });

  it('counts an empty successful HTTP stream as a failed candidate', async () => {
    const id = await seedPage('Empty response');
    respond = (response) => sendSummary(response, '');

    expect(await runSummaryBatch()).toEqual({ processed: 0, errors: 1 });
    expect(await readPage(id)).toMatchObject({ summary_status: 'failed', summary_retry_count: 1, summary_text: null });
  });

  it.each(['direct', 'manual'] as const)('protects a live summarizing page when the owner is a %s batch', async (owner) => {
    const id = await seedPage('Live article');
    let heldResponse: ServerResponse | undefined;
    respond = (response) => {
      if (calls === 1) heldResponse = response;
      else sendSummary(response);
    };
    const first = owner === 'direct' ? runSummaryBatch() : triggerSummaryBatch();
    try {
      await vi.waitFor(() => expect(heldResponse).toBeDefined(), HELD_WAIT);
      expect((await getSummaryStatus()).isProcessing).toBe(true);
      expect((await readPage(id)).summary_status).toBe('summarizing');

      expect(await runSummaryBatch()).toEqual({ processed: 0, errors: 0 });
      await triggerSummaryBatch();
      expect((await readPage(id)).summary_status).toBe('summarizing');
      expect((await getSummaryStatus()).isProcessing).toBe(true);
      expect(calls).toBe(1);
    } finally {
      if (heldResponse) sendSummary(heldResponse);
      await first;
    }

    expect(await readPage(id)).toMatchObject({ summary_status: 'summarized', summary_retry_count: 0 });
    expect((await getSummaryStatus()).isProcessing).toBe(false);
    expect(await runSummaryBatch()).toEqual({ processed: 0, errors: 0 });
    expect(calls).toBe(1);
  });
});
