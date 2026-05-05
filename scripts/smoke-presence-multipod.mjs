#!/usr/bin/env node
/**
 * Multi-pod presence smoke test (issue #301 acceptance criterion).
 *
 * Setup (done externally, see docs/releases/v0.4-presence-multipod-smoke.md):
 *   - One shared Postgres (test DB) + one shared Redis
 *   - Two backend processes: pod A on :3100, pod B on :3101 using the same
 *     POSTGRES_URL + REDIS_URL.
 *   - Two seeded users (A, B) with role='admin' and one standalone page with
 *     visibility='shared' so userCanAccessPage() resolves true for both.
 *
 * Env inputs (required):
 *   POD_A_URL       e.g. http://127.0.0.1:3100
 *   POD_B_URL       e.g. http://127.0.0.1:3101
 *   JWT_A           access token for user A (HS256, matches backend JWT_SECRET)
 *   JWT_B           access token for user B
 *   USER_A_ID       uuid of user A (used to assert viewers contains A)
 *   USER_B_ID       uuid of user B
 *   PAGE_ID         integer pages.id used in the presence routes
 *   SSE_WAIT_MS     optional, default 6000 (ms to wait for the fan-out event)
 *
 * Exits 0 on PASS (both directions), 1 on FAIL.
 */

const POD_A_URL = mustEnv('POD_A_URL');
const POD_B_URL = mustEnv('POD_B_URL');
const JWT_A = mustEnv('JWT_A');
const JWT_B = mustEnv('JWT_B');
const USER_A_ID = mustEnv('USER_A_ID');
const USER_B_ID = mustEnv('USER_B_ID');
const PAGE_ID = mustEnv('PAGE_ID');
const SSE_WAIT_MS = parseInt(process.env.SSE_WAIT_MS ?? '6000', 10);

function mustEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`[smoke] missing required env ${name}`);
    process.exit(2);
  }
  return v;
}

/**
 * Open an SSE stream on `baseUrl` for `pageId`, collect presence events,
 * and resolve when `predicate(viewers)` matches or the deadline fires.
 *
 * Returns { matched: boolean, events: Event[], error?: Error }.
 */
async function waitForPresenceEvent(baseUrl, jwt, pageId, predicate, timeoutMs) {
  const controller = new AbortController();
  const events = [];
  let matched = false;
  let settled = false;

  const url = `${baseUrl}/api/pages/${pageId}/presence`;
  const deadline = setTimeout(() => {
    if (!settled) controller.abort();
  }, timeoutMs);

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${jwt}`, Accept: 'text/event-stream' },
      signal: controller.signal,
    });

    if (!res.ok) {
      clearTimeout(deadline);
      return { matched: false, events, error: new Error(`SSE HTTP ${res.status}`) };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      // Split on SSE event boundaries (double newline).
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLine = raw.split('\n').find((l) => l.startsWith('data: '));
        if (!dataLine) continue;
        let parsed;
        try {
          parsed = JSON.parse(dataLine.slice(6));
        } catch (err) {
          continue;
        }
        events.push(parsed);
        if (predicate(parsed.viewers ?? [])) {
          matched = true;
          settled = true;
          controller.abort();
          break;
        }
      }
      if (matched) break;
    }
  } catch (err) {
    if (!matched && err.name !== 'AbortError') {
      clearTimeout(deadline);
      return { matched: false, events, error: err };
    }
  }
  clearTimeout(deadline);
  return { matched, events };
}

async function postHeartbeat(baseUrl, jwt, pageId, isEditing) {
  const res = await fetch(`${baseUrl}/api/pages/${pageId}/presence/heartbeat`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ isEditing }),
  });
  if (res.status !== 204) {
    const body = await res.text().catch(() => '');
    throw new Error(`heartbeat HTTP ${res.status}: ${body}`);
  }
}

async function runDirection(label, ssePod, sseJwt, hbPod, hbJwt, expectUserId) {
  console.log(`\n=== ${label} ===`);
  console.log(`  SSE on ${ssePod}, heartbeat on ${hbPod}, expect viewer ${expectUserId}`);

  // Open SSE first, wait a tick so the subscribe is registered, then heartbeat.
  const ssePromise = waitForPresenceEvent(
    ssePod,
    sseJwt,
    PAGE_ID,
    (viewers) => viewers.some((v) => v.userId === expectUserId),
    SSE_WAIT_MS,
  );

  // Small delay so the SSE stream has issued its initial snapshot and the
  // subscribeToPage() listener is registered before we publish.
  await new Promise((r) => setTimeout(r, 400));

  try {
    await postHeartbeat(hbPod, hbJwt, PAGE_ID, false);
    console.log(`  heartbeat posted to ${hbPod}`);
  } catch (err) {
    console.log(`  heartbeat FAILED: ${err.message}`);
    return false;
  }

  const { matched, events, error } = await ssePromise;
  if (error) {
    console.log(`  SSE error: ${error.message}`);
  }
  console.log(`  received ${events.length} SSE event(s)`);
  for (const e of events) {
    const vs = (e.viewers ?? []).map((v) => v.userId).join(',');
    console.log(`    event: viewers=[${vs}]`);
  }
  console.log(`  ${label}: ${matched ? 'PASS' : 'FAIL'}`);
  return matched;
}

async function main() {
  console.log('[smoke] multi-pod presence smoke test');
  console.log(`  pod A = ${POD_A_URL}, pod B = ${POD_B_URL}, pageId = ${PAGE_ID}`);

  const fwd = await runDirection(
    'DIRECTION 1: SSE on A, heartbeat on B (expect user B in A\'s stream)',
    POD_A_URL,
    JWT_A,
    POD_B_URL,
    JWT_B,
    USER_B_ID,
  );

  // Small gap so the Redis TTLs for the previous heartbeat don't interfere.
  await new Promise((r) => setTimeout(r, 500));

  const rev = await runDirection(
    'DIRECTION 2: SSE on B, heartbeat on A (expect user A in B\'s stream)',
    POD_B_URL,
    JWT_B,
    POD_A_URL,
    JWT_A,
    USER_A_ID,
  );

  console.log('\n=== SUMMARY ===');
  console.log(`  direction 1 (A sees B): ${fwd ? 'PASS' : 'FAIL'}`);
  console.log(`  direction 2 (B sees A): ${rev ? 'PASS' : 'FAIL'}`);
  const ok = fwd && rev;
  console.log(`  overall: ${ok ? 'PASS' : 'FAIL'}`);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error('[smoke] unexpected error', err);
  process.exit(1);
});
