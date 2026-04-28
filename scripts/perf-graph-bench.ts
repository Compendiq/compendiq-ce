#!/usr/bin/env npx tsx
/**
 * Graph performance benchmark — issue #380 Phase 1.
 *
 * Generates synthetic graphs at the four target sizes (default
 * 500/1000/2000/5000) with realistic edge density (top-K=5 per node, score
 * >= 0.6 to match the corpus-tiered floor that landed in #378), drives a
 * Playwright session against `/graph?focus=<id>&full=1`, and records:
 *
 *   - layout convergence time (rAF activity stalls)
 *   - fps during a programmatic pan + drag of 3 random nodes
 *   - time-to-first-paint (canvas mounted in DOM)
 *   - JS heap usage from `performance.memory`
 *
 * Output: `perf/graph-bench-results.json`. The script applies the issue's
 * decision rule and prints whether Phase 2 is justified.
 *
 * Usage:
 *   docker compose -f docker/docker-compose.yml up -d --build   # bring up the dev stack
 *   npx tsx scripts/perf-graph-bench.ts                         # full sweep
 *   npx tsx scripts/perf-graph-bench.ts --sizes=500,1000        # subset
 *   npx tsx scripts/perf-graph-bench.ts --cleanup               # remove fixtures
 *
 * Env / flags:
 *   POSTGRES_URL          (default postgresql://kb_user:changeme-postgres@localhost:5432/kb_creator)
 *   --web-url=URL         (default http://localhost:8081)
 *   --backend-url=URL     (default http://localhost:3051)
 *   --username=...        (default benchuser)
 *   --password=...        (default benchpass123)
 *   --headless=true|false (default true; set false to watch the browser)
 *   --keep-fixtures       (skip cleanup at the end so re-runs are faster)
 *
 * The synthetic fixtures live in spaces named `PERF-BENCH-<size>` and pages
 * with `confluence_id` prefix `perf-bench-<size>-`, so cleanup never
 * touches real corpora. The benchmark user is granted access via the
 * existing RBAC seed (`user_space_selections` + `space_admin` role), so
 * the same fixtures show up in the `/api/pages/graph` endpoint without
 * any RBAC monkey-patching.
 */

import pg from 'pg';
import { chromium } from 'playwright';
import { createClient } from 'redis';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const { Pool } = pg;

// ── Configuration ───────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');
const RESULTS_PATH = resolve(REPO_ROOT, 'perf/graph-bench-results.json');

const POSTGRES_URL =
  process.env.POSTGRES_URL ??
  'postgresql://kb_user:changeme-postgres@localhost:5432/kb_creator';

interface Args {
  sizes: number[];
  webUrl: string;
  backendUrl: string;
  username: string;
  password: string;
  cleanup: boolean;
  keepFixtures: boolean;
  headless: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (name: string, fallback: string) => {
    const arg = argv.find((a) => a.startsWith(`--${name}=`));
    return arg ? arg.slice(name.length + 3) : fallback;
  };
  const flag = (name: string) => argv.includes(`--${name}`);
  const sizes = get('sizes', '500,1000,2000,5000')
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  return {
    sizes,
    webUrl: get('web-url', 'http://localhost:8081').replace(/\/$/, ''),
    // Default to :3052 — the dev compose maps backend → host port 3052
    // (BACKEND_HOST_PORT in docker-compose.yml). 3051 is the in-container
    // port, which isn't reachable from a host-side Playwright run.
    backendUrl: get('backend-url', 'http://localhost:3052').replace(/\/$/, ''),
    username: get('username', 'benchuser'),
    password: get('password', 'benchpass123'),
    cleanup: flag('cleanup'),
    keepFixtures: flag('keep-fixtures'),
    headless: get('headless', 'true') !== 'false',
  };
}

// ── Edge density: top-K=5 per node, score floor 0.6 ─────────────────────────

export const EDGES_PER_NODE = 5;
export const MIN_SCORE = 0.6;
export const MAX_SCORE = 0.95;

function randomScore(): number {
  return MIN_SCORE + Math.random() * (MAX_SCORE - MIN_SCORE);
}

/**
 * Deterministic neighbour generator — exported for unit tests so the
 * synthetic graph density can be verified without touching Postgres.
 *
 * A node connects to its ±1, ±2 ring plus a `sqrt(n)` long-range hop.
 * That mimics the cluster-with-bridges shape of a real Confluence corpus
 * and keeps the global graph well-connected, which is what the bench
 * actually renders (`?full=1`, no `focus=`).
 */
export function neighbours(i: number, n: number): number[] {
  const offsets = [1, -1, 2, -2, Math.floor(Math.sqrt(n))];
  const seen = new Set<number>();
  const out: number[] = [];
  for (const off of offsets) {
    const j = (i + off + n) % n;
    if (j === i || seen.has(j)) continue;
    seen.add(j);
    out.push(j);
    if (out.length >= EDGES_PER_NODE) break;
  }
  return out;
}

// ── DB helpers ──────────────────────────────────────────────────────────────

interface SeedResult {
  spaceKey: string;
  /** A representative page id from the seed — used as a stable handle in
   *  the JSON output. The bench renders the GLOBAL graph (`?full=1`,
   *  no `focus=`), so this id is not used to route the page. */
  samplePageId: number;
  pageCount: number;
  edgeCount: number;
}

const SPACE_PREFIX = 'PERF-BENCH-';
const PAGE_PREFIX = 'perf-bench-';

async function ensureSpace(client: pg.PoolClient, spaceKey: string): Promise<void> {
  await client.query(
    `INSERT INTO spaces (space_key, space_name, source, last_synced)
     VALUES ($1, $2, 'confluence', NOW())
     ON CONFLICT (space_key) DO NOTHING`,
    [spaceKey, `Bench ${spaceKey}`],
  );
}

async function ensureUser(
  client: pg.PoolClient,
  username: string,
  password: string,
): Promise<string> {
  const existing = await client.query<{ id: string }>(
    'SELECT id FROM users WHERE username = $1',
    [username],
  );
  if (existing.rows.length > 0) return existing.rows[0]!.id;

  // Use bcrypt via the existing column. The benchmark only ever logs in
  // through the real /auth/login flow, so the hash needs to verify against
  // bcrypt — defer to the running backend's /auth/register instead.
  throw new Error(
    `User '${username}' not found. Register them via:\n` +
      `  curl -X POST ${'<backend-url>'}/api/auth/register \\\n` +
      `       -H 'Content-Type: application/json' \\\n` +
      `       -d '{"username":"${username}","password":"${password}"}'`,
  );
}

async function grantSpaceAccess(
  client: pg.PoolClient,
  userId: string,
  spaceKey: string,
): Promise<void> {
  // RBAC space access is determined solely by `space_role_assignments`
  // (see rbac-service.ts:`getUserAccessibleSpaces`, which explicitly
  // states it does NOT consult `user_space_selections`). The earlier
  // version of this script wrote to `user_space_selections` and the
  // bench user got back `[]` accessible spaces → the graph endpoint
  // returned no nodes regardless of how many we seeded. Assign the
  // bench user the `editor` role for read access to the space.
  await client.query(
    `INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
     SELECT $1, 'user', $2::text, r.id
     FROM roles r
     WHERE r.name = 'editor'
     ON CONFLICT (space_key, principal_type, principal_id) DO NOTHING`,
    [spaceKey, userId],
  );
}

async function cleanupSize(client: pg.PoolClient, size: number): Promise<void> {
  const spaceKey = `${SPACE_PREFIX}${size}`;
  // page_relationships cascades on pages.id; pages don't cascade-delete
  // role assignments (different lifecycle), so drop those explicitly.
  await client.query(`DELETE FROM space_role_assignments WHERE space_key = $1`, [spaceKey]);
  await client.query(
    `DELETE FROM pages WHERE confluence_id LIKE $1`,
    [`${PAGE_PREFIX}${size}-%`],
  );
  await client.query(`DELETE FROM spaces WHERE space_key = $1`, [spaceKey]);
}

async function seedSize(
  pool: pg.Pool,
  size: number,
  userId: string,
): Promise<SeedResult> {
  const spaceKey = `${SPACE_PREFIX}${size}`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await cleanupSize(client, size);
    await ensureSpace(client, spaceKey);
    await grantSpaceAccess(client, userId, spaceKey);

    // Bulk-insert pages. parent_id stays NULL so there's no parent_child
    // edges to confuse the embedding-similarity layout numbers — Phase 1
    // is measuring the renderer + force layout under a known edge type.
    const ids: number[] = [];
    for (let batchStart = 0; batchStart < size; batchStart += 500) {
      const batchEnd = Math.min(batchStart + 500, size);
      const values: string[] = [];
      const params: unknown[] = [];
      let p = 1;
      for (let i = batchStart; i < batchEnd; i++) {
        const cid = `${PAGE_PREFIX}${size}-${i.toString().padStart(6, '0')}`;
        values.push(
          `($${p++}, $${p++}, $${p++}, '', '', 1, ARRAY[]::text[], 'bench', NOW(), NOW(), false, 'embedded', NOW(), 'confluence', 'shared', 'page')`,
        );
        params.push(cid, spaceKey, `Bench page ${i}`);
      }
      const res = await client.query<{ id: number }>(
        `INSERT INTO pages (
            confluence_id, space_key, title, body_text, body_html,
            version, labels, author, last_modified_at, last_synced,
            embedding_dirty, embedding_status, embedded_at,
            source, visibility, page_type
          ) VALUES ${values.join(',')} RETURNING id`,
        params,
      );
      ids.push(...res.rows.map((r) => r.id));
    }

    // Build the edge list — top-K=5 neighbours per node, all
    // `embedding_similarity` with score >= 0.6.
    const edgeRows: Array<{ a: number; b: number; score: number }> = [];
    const seenPair = new Set<string>();
    for (let i = 0; i < ids.length; i++) {
      for (const j of neighbours(i, ids.length)) {
        const a = ids[i]!;
        const b = ids[j]!;
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        if (lo === hi) continue;
        const key = `${lo}-${hi}`;
        if (seenPair.has(key)) continue;
        seenPair.add(key);
        edgeRows.push({ a: lo, b: hi, score: randomScore() });
      }
    }

    // Bulk insert edges. The unique constraint is
    // (page_id_1, page_id_2, relationship_type) — pairs are normalised to
    // (lo, hi) so each undirected edge appears once.
    for (let batchStart = 0; batchStart < edgeRows.length; batchStart += 1000) {
      const batchEnd = Math.min(batchStart + 1000, edgeRows.length);
      const values: string[] = [];
      const params: unknown[] = [];
      let p = 1;
      for (let i = batchStart; i < batchEnd; i++) {
        const e = edgeRows[i]!;
        values.push(
          `($${p++}, $${p++}, 'embedding_similarity', $${p++}, NOW())`,
        );
        params.push(e.a, e.b, e.score);
      }
      await client.query(
        `INSERT INTO page_relationships
            (page_id_1, page_id_2, relationship_type, score, created_at)
          VALUES ${values.join(',')}
          ON CONFLICT DO NOTHING`,
        params,
      );
    }

    await client.query('COMMIT');

    return {
      spaceKey,
      samplePageId: ids[Math.floor(ids.length / 2)]!,
      pageCount: ids.length,
      edgeCount: edgeRows.length,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Browser instrumentation ─────────────────────────────────────────────────

export interface BenchSample {
  size: number;
  pageCount: number;
  edgeCount: number;
  /** A representative seeded page id, retained as a stable handle in
   *  the JSON output. The bench renders the GLOBAL graph; this id is
   *  not used to route the page. */
  samplePageId: number;
  /** Time from navigation to the canvas being mounted, in ms. */
  timeToFirstPaintMs: number;
  /** Time from canvas mount until rAF activity stalls (force layout settles), in ms. */
  layoutConvergenceMs: number;
  /** FPS sampled during programmatic pan + drag interaction across the
   *  canvas. Drives simulation + render workload regardless of where
   *  individual nodes happen to land in screen space (the renderer's
   *  internal node positions aren't exposed to the page). */
  fpsDuringInteraction: number;
  /** `performance.memory.usedJSHeapSize` at the end of the run, in MB. */
  jsHeapUsedMb: number | null;
}

/**
 * Best-effort flush of the bench user's RBAC space-list cache.
 * `getUserAccessibleSpaces` caches under `rbac:spaces:<userId>` for 60 s
 * (rbac-service.ts:14). If the previous run granted access to a different
 * set of `PERF-BENCH-<size>` spaces, the cached list can be stale and the
 * global graph endpoint will surface rows from spaces not in this run's
 * seed. Falls back to a no-op when REDIS_URL is unset / unreachable —
 * the bench README documents the manual workaround in that case.
 */
async function flushRbacCache(userId: string): Promise<void> {
  const url = process.env.REDIS_URL;
  if (!url) {
    console.log('  (REDIS_URL unset — skipped RBAC cache flush; wait 60 s if re-running with different sizes)');
    return;
  }
  const client = createClient({ url });
  client.on('error', () => { /* swallow — handled below */ });
  try {
    await client.connect();
    await client.del(`rbac:spaces:${userId}`);
    await client.del(`rbac:admin:${userId}`);
    await client.del(`rbac:global:${userId}`);
    console.log(`  Flushed RBAC cache for user ${userId}.`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  (RBAC cache flush skipped: ${msg})`);
  } finally {
    try {
      await client.quit();
    } catch {
      /* ignore quit errors */
    }
  }
}

async function login(
  page: import('playwright').Page,
  backendUrl: string,
  username: string,
  password: string,
): Promise<string> {
  const res = await page.request.post(`${backendUrl}/api/auth/login`, {
    data: { username, password },
  });
  if (!res.ok()) {
    throw new Error(`Login failed: ${res.status()} ${await res.text()}`);
  }
  const body = (await res.json()) as { accessToken: string };
  return body.accessToken;
}

const FIRST_PAINT_TIMEOUT_MS = 30_000;
// The simulation uses cooldownTicks=100 with d3AlphaDecay=0.03 — convergence
// settles in ~1–3 s on small graphs, ~5–10 s once the node count climbs.
// 30 s is a generous upper bound for the 5000-node case.
const CONVERGENCE_TIMEOUT_MS = 30_000;
// Convergence is detected when the rAF rate drops below `IDLE_RATE_HZ` for
// `CONVERGENCE_QUIET_MS` consecutive sampling. The page has continuous
// background rAF activity (Framer Motion, Radix transitions, layout
// reflows) at ~5–15 Hz, so "rAF goes fully quiet" never trips. The force
// simulation drives rAF at the screen rate (~60 Hz) while running, so a
// drop below 25 Hz reliably signals "force layout has stopped".
const CONVERGENCE_SAMPLE_MS = 100;
const CONVERGENCE_QUIET_MS = 500;
const IDLE_RATE_HZ = 25;
const FPS_WINDOW_MS = 2_000;

/**
 * Install the auth token + rAF instrumentation ONCE for the lifetime of
 * the page. Playwright's `addInitScript` is replayed on every navigation
 * and registrations stack up — calling it inside the per-size loop
 * meant the rAF wrapper was double/triple/quadruple-installed and the
 * fps reading was inflated by the same factor (3× at the 2000-node
 * decision sample, hiding any Phase-2-justifying regression). The
 * inner `__benchInstalled` guard belt-and-braces against a re-add if
 * this function is ever called twice by mistake.
 *
 * The body is exported as `benchInitScriptBody` so a unit test can
 * exercise the single-shot guarantee against a JSDOM-style fake `window`
 * — Playwright's `addInitScript` runs this code as-is on every nav.
 */
export function benchInitScriptBody(this: unknown, { token }: { token: string }): void {
  const w = window as unknown as Record<string, unknown>;
  try {
    // The auth store hydrates from localStorage on mount.
    localStorage.setItem(
      'compendiq-auth',
      JSON.stringify({
        state: { accessToken: token, isAuthenticated: true, user: null },
        version: 0,
      }),
    );
  } catch {
    /* localStorage may be unavailable in some contexts */
  }
  // Reset the counters on every navigation; only wrap rAF on the
  // first install so iterations N>1 don't accumulate wrappers.
  w.__bench = { rafCount: 0, lastRaf: 0, startedAt: 0 };
  if (w.__benchInstalled) return;
  w.__benchInstalled = true;
  const orig = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) =>
    orig((t) => {
      const data = w.__bench as Record<string, number>;
      data.rafCount++;
      data.lastRaf = performance.now();
      if (data.startedAt === 0) data.startedAt = data.lastRaf;
      return cb(t);
    });
}

async function installBenchInit(
  page: import('playwright').Page,
  accessToken: string,
): Promise<void> {
  await page.addInitScript(benchInitScriptBody, { token: accessToken });
}

async function runOne(
  page: import('playwright').Page,
  webUrl: string,
  size: number,
  seed: SeedResult,
): Promise<BenchSample> {
  // The bench renders the GLOBAL graph (`?full=1`, no `focus=`) and
  // restricts it to THIS iteration's seeded space via `&space=`. On
  // origin/dev (#360 / #375), the GraphPage routes
  //   wantsGlobal = !focusPageId && showFullGraph
  // so combining `focus=…&full=1` would silently downgrade to the
  // ego-graph endpoint (`/pages/{id}/graph/local?hops=2`), which caps
  // at ~30 nodes regardless of seeded corpus size.
  //
  // The `&space=` filter is load-bearing for the size sweep: `main()`
  // seeds all four sizes upfront and grants the bench user editor
  // access to every `PERF-BENCH-<size>` space, so without the filter
  // the global endpoint would return the union (~8500 nodes) on every
  // iteration and the four "size buckets" would all measure the same
  // graph. With `space=` set, the GraphPage forwards `spaceKey=…` to
  // `/api/pages/graph` and the seeded-size invariant is preserved.
  const url = `${webUrl}/graph?full=1&space=${encodeURIComponent(seed.spaceKey)}`;
  const navStart = Date.now();
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  // ─ TTFP: wait for the canvas to be in the DOM. react-force-graph-2d
  //   renders a single <canvas> inside [data-testid="graph-container"].
  await page.waitForSelector('[data-testid="graph-container"] canvas', {
    timeout: FIRST_PAINT_TIMEOUT_MS,
  });
  const timeToFirstPaintMs = Date.now() - navStart;

  // ─ Convergence: sample the rAF rate over short windows and declare
  //   the force layout settled when the rate falls below `IDLE_RATE_HZ`
  //   for `CONVERGENCE_QUIET_MS` of consecutive low samples.
  //
  //   The earlier "rAF goes fully quiet" approach didn't work on the
  //   real page — Framer Motion + Radix transitions + occasional
  //   reflows keep rAF firing at ~5–15 Hz indefinitely, so the quiet
  //   window never opens and convergence pegs at the timeout. The
  //   force simulation drives rAF at the screen rate while running,
  //   so a drop below 25 Hz reliably distinguishes "simulation
  //   stopped" from "page is otherwise idle but never silent".
  const layoutConvergenceMs = await page.evaluate(
    async ({ quietMs, timeoutMs, sampleMs, idleRateHz }) => {
      const w = window as unknown as Record<string, unknown>;
      const data = w.__bench as Record<string, number>;
      const startedAt = data.startedAt || performance.now();
      const deadline = performance.now() + timeoutMs;

      let prevCount = data.rafCount;
      let prevAt = performance.now();
      let quietSince: number | null = null;

      while (performance.now() < deadline) {
        await new Promise((r) => setTimeout(r, sampleMs));
        const now = performance.now();
        const elapsed = now - prevAt;
        const rate = elapsed > 0 ? ((data.rafCount - prevCount) * 1000) / elapsed : 0;
        prevCount = data.rafCount;
        prevAt = now;

        if (rate < idleRateHz) {
          if (quietSince === null) quietSince = now - elapsed;
          if (now - quietSince >= quietMs) {
            return Math.max(0, quietSince - startedAt);
          }
        } else {
          quietSince = null;
        }
      }
      return performance.now() - startedAt;
    },
    {
      quietMs: CONVERGENCE_QUIET_MS,
      timeoutMs: CONVERGENCE_TIMEOUT_MS,
      sampleMs: CONVERGENCE_SAMPLE_MS,
      idleRateHz: IDLE_RATE_HZ,
    },
  );

  // ─ Pan + drag interaction. Drives the renderer + simulation under
  //   load while we sample fps over a short window. We don't reach
  //   inside react-force-graph-2d for actual node screen positions —
  //   the gestures land on whatever the canvas is showing at the time.
  //   That's deliberate: the metric is "rAF rate while the user is
  //   interacting with the graph", which is what determines whether
  //   the page feels smooth. The renderer redraws on every tick of the
  //   force simulation regardless of which pixel the cursor is over,
  //   so the fps reading is dominated by simulation cost, not by
  //   whether we happened to grab a node.
  const box = await page
    .locator('[data-testid="graph-container"] canvas')
    .boundingBox();
  if (!box) throw new Error('Could not measure canvas bounding box');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // Reset the rAF counter to measure fps during the interaction window.
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const data = w.__bench as Record<string, number>;
    data.rafCount = 0;
  });
  const fpsStart = performance.now();
  // 1) Pan: mouse-down + drag from centre.
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let s = 0; s < 10; s++) {
    await page.mouse.move(cx + s * 12, cy + s * 7, { steps: 4 });
    await page.waitForTimeout(20);
  }
  await page.mouse.up();
  // 2) Three drag gestures at random canvas offsets — see the comment
  //    above; these intentionally don't target specific nodes.
  for (let n = 0; n < 3; n++) {
    const dx = (Math.random() - 0.5) * box.width * 0.6;
    const dy = (Math.random() - 0.5) * box.height * 0.6;
    await page.mouse.move(cx + dx, cy + dy);
    await page.mouse.down();
    for (let s = 0; s < 6; s++) {
      await page.mouse.move(cx + dx + s * 10, cy + dy + s * 5, { steps: 4 });
      await page.waitForTimeout(25);
    }
    await page.mouse.up();
  }
  // Pad out to FPS_WINDOW_MS so the sample is over a stable window.
  const elapsed = performance.now() - fpsStart;
  if (elapsed < FPS_WINDOW_MS) {
    await page.waitForTimeout(FPS_WINDOW_MS - elapsed);
  }

  const fpsDuringInteraction = await page.evaluate((windowMs) => {
    const w = window as unknown as Record<string, unknown>;
    const data = w.__bench as Record<string, number>;
    return (data.rafCount * 1000) / windowMs;
  }, FPS_WINDOW_MS);

  // ─ Memory (Chrome only). Wrapped in a try/catch because a strict
  //   Content-Security-Policy can disable `performance.memory`.
  const jsHeapUsedMb = await page.evaluate(() => {
    type ChromePerformance = Performance & { memory?: { usedJSHeapSize: number } };
    const mem = (performance as ChromePerformance).memory;
    return mem ? Math.round((mem.usedJSHeapSize / (1024 * 1024)) * 10) / 10 : null;
  });

  return {
    size,
    pageCount: seed.pageCount,
    edgeCount: seed.edgeCount,
    samplePageId: seed.samplePageId,
    timeToFirstPaintMs,
    layoutConvergenceMs: Math.round(layoutConvergenceMs),
    fpsDuringInteraction: Math.round(fpsDuringInteraction * 10) / 10,
    jsHeapUsedMb,
  };
}

// ── Decision rule (issue #380) ──────────────────────────────────────────────

export interface Verdict {
  phase2Justified: boolean;
  reasons: string[];
}

/**
 * Apply the issue-#380 decision rule to a set of samples. Exported for
 * unit tests so the threshold logic can be exercised without booting a
 * browser.
 */
export function decide(samples: BenchSample[]): Verdict {
  const reasons: string[] = [];
  const target = samples.find((s) => s.size === 2000);
  if (!target) {
    return {
      phase2Justified: false,
      reasons: ['No 2000-node sample collected — verdict cannot be applied.'],
    };
  }
  if (target.fpsDuringInteraction < 30) {
    reasons.push(
      `2000-node drag fps = ${target.fpsDuringInteraction} (< 30 fps threshold).`,
    );
  }
  if (target.layoutConvergenceMs > 5000) {
    reasons.push(
      `2000-node layout convergence = ${target.layoutConvergenceMs} ms (> 5000 ms threshold).`,
    );
  }
  return { phase2Justified: reasons.length > 0, reasons };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();
  const pool = new Pool({ connectionString: POSTGRES_URL });

  if (args.cleanup) {
    const client = await pool.connect();
    try {
      for (const size of args.sizes) await cleanupSize(client, size);
      console.log(`Cleaned up sizes ${args.sizes.join(', ')}.`);
    } finally {
      client.release();
      await pool.end();
    }
    return;
  }

  const userClient = await pool.connect();
  let userId: string;
  try {
    userId = await ensureUser(userClient, args.username, args.password);
  } finally {
    userClient.release();
  }

  console.log(`Bench user: ${args.username} (${userId})`);
  console.log(`Sizes: ${args.sizes.join(', ')}`);

  const seeds = new Map<number, SeedResult>();
  for (const size of args.sizes) {
    process.stdout.write(`Seeding ${size} pages... `);
    const seed = await seedSize(pool, size, userId);
    seeds.set(size, seed);
    console.log(`OK (${seed.pageCount} pages, ${seed.edgeCount} edges, sample=${seed.samplePageId})`);
  }

  // Best-effort RBAC cache flush so consecutive runs that change the
  // bench user's space access don't read a stale 60 s-cached space list
  // from `getUserAccessibleSpaces`. If REDIS_URL is unset or the broker
  // is unreachable, the script just logs and proceeds — not an error.
  await flushRbacCache(userId);

  const browser = await chromium.launch({ headless: args.headless });
  const samples: BenchSample[] = [];
  try {
    // `reducedMotion: 'no-preference'` — important. The GraphPage uses
    // `cooldownTicks={prefersReducedMotion ? 0 : 100}` (and similarly
    // bumps warmupTicks). If the host's `prefers-reduced-motion: reduce`
    // setting leaks through, the force simulation runs zero ticks → the
    // convergence sample bottoms out at 0 ms regardless of corpus size.
    // Pin the value so the bench measures the rendering path users with
    // motion enabled actually see.
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      reducedMotion: 'no-preference',
    });
    const page = await context.newPage();
    const accessToken = await login(page, args.backendUrl, args.username, args.password);
    // Install the auth-token + rAF instrumentation ONCE for the lifetime
    // of the page. Calling it inside the iteration loop accumulates
    // wrappers; see installBenchInit.
    await installBenchInit(page, accessToken);

    for (const size of args.sizes) {
      const seed = seeds.get(size)!;
      console.log(`\nMeasuring ${size} nodes...`);
      const sample = await runOne(page, args.webUrl, size, seed);
      samples.push(sample);
      console.log(
        `  ttfp=${sample.timeToFirstPaintMs}ms  conv=${sample.layoutConvergenceMs}ms` +
          `  fps=${sample.fpsDuringInteraction}  heap=${sample.jsHeapUsedMb ?? 'n/a'}MB`,
      );
    }
  } finally {
    await browser.close();
    if (!args.keepFixtures) {
      const client = await pool.connect();
      try {
        for (const size of args.sizes) await cleanupSize(client, size);
      } finally {
        client.release();
      }
    }
    await pool.end();
  }

  const verdict = decide(samples);
  const report = {
    schemaVersion: 1,
    issue: '#380',
    runAt: new Date().toISOString(),
    config: {
      sizes: args.sizes,
      edgesPerNode: EDGES_PER_NODE,
      minScore: MIN_SCORE,
      maxScore: MAX_SCORE,
    },
    samples,
    verdict,
  };

  await mkdir(dirname(RESULTS_PATH), { recursive: true });
  await writeFile(RESULTS_PATH, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(`\nWrote ${RESULTS_PATH}`);

  console.log('\n── Verdict ────────────────────────────────────────────');
  if (verdict.phase2Justified) {
    console.log('Phase 2 is JUSTIFIED:');
    for (const r of verdict.reasons) console.log(`  - ${r}`);
  } else {
    console.log('Phase 2 is NOT justified — per-hop cap + tiered threshold');
    console.log('from #378 are sufficient at the measured corpus shape.');
  }
}

// Only auto-run when invoked directly (`npx tsx scripts/perf-graph-bench.ts`).
// Importing this module from a test (perf-graph-bench.test.ts) won't trip
// the bench, since vitest passes a different entry URL for test runners.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('perf-graph-bench.ts')) {
  main().catch((err) => {
    console.error('perf-graph-bench failed:', err);
    process.exit(1);
  });
}
