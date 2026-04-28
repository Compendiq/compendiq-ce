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
    backendUrl: get('backend-url', 'http://localhost:3051').replace(/\/$/, ''),
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
 * and keeps the centre node reachable from most others, which is what a
 * focused (`?focus=`) view actually exercises.
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
  centerPageId: number;
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
  await client.query(
    `INSERT INTO user_space_selections (user_id, space_key)
     VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [userId, spaceKey],
  );
}

async function cleanupSize(client: pg.PoolClient, size: number): Promise<void> {
  const spaceKey = `${SPACE_PREFIX}${size}`;
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
      centerPageId: ids[Math.floor(ids.length / 2)]!,
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
  /** Centre page id (the `?focus=` target). */
  centerPageId: number;
  /** Time from navigation to the canvas being mounted, in ms. */
  timeToFirstPaintMs: number;
  /** Time from canvas mount until rAF activity stalls (force layout settles), in ms. */
  layoutConvergenceMs: number;
  /** FPS sampled during the programmatic pan + drag of 3 random nodes. */
  fpsDuringInteraction: number;
  /** `performance.memory.usedJSHeapSize` at the end of the run, in MB. */
  jsHeapUsedMb: number | null;
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
const CONVERGENCE_QUIET_MS = 350;
const FPS_WINDOW_MS = 2_000;

async function runOne(
  page: import('playwright').Page,
  webUrl: string,
  size: number,
  seed: SeedResult,
  accessToken: string,
): Promise<BenchSample> {
  // Inject the auth token + a tiny rAF instrumentation BEFORE the SPA
  // starts up. The instrumentation timestamps every requestAnimationFrame
  // tick — convergence is detected by polling for "no rAF in the last N ms".
  await page.addInitScript(
    ({ token }) => {
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
      const w = window as unknown as Record<string, unknown>;
      w.__bench = {
        rafCount: 0,
        lastRaf: 0,
        startedAt: 0,
      };
      const orig = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (cb) =>
        orig((t) => {
          const data = w.__bench as Record<string, number>;
          data.rafCount++;
          data.lastRaf = performance.now();
          if (data.startedAt === 0) data.startedAt = data.lastRaf;
          return cb(t);
        });
    },
    { token: accessToken },
  );

  const url = `${webUrl}/graph?focus=${seed.centerPageId}&full=1`;
  const navStart = Date.now();
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  // ─ TTFP: wait for the canvas to be in the DOM. react-force-graph-2d
  //   renders a single <canvas> inside [data-testid="graph-container"].
  await page.waitForSelector('[data-testid="graph-container"] canvas', {
    timeout: FIRST_PAINT_TIMEOUT_MS,
  });
  const timeToFirstPaintMs = Date.now() - navStart;

  // ─ Convergence: poll until rAF has been idle for CONVERGENCE_QUIET_MS.
  //   The first paint isn't the start of the simulation — the engine
  //   warms up after the data fetch resolves — so we use the rAF start
  //   timestamp captured inside the page.
  const layoutConvergenceMs = await page.evaluate(
    async ({ quietMs, timeoutMs }) => {
      const w = window as unknown as Record<string, unknown>;
      const data = w.__bench as Record<string, number>;
      const startedAt = data.startedAt || performance.now();
      const deadline = performance.now() + timeoutMs;
      while (performance.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
        if (performance.now() - data.lastRaf >= quietMs) {
          return Math.max(0, data.lastRaf - startedAt);
        }
      }
      // If we never see a quiet window, report the elapsed time so
      // the verdict still flags this size as a Phase-2 candidate.
      return performance.now() - startedAt;
    },
    { quietMs: CONVERGENCE_QUIET_MS, timeoutMs: CONVERGENCE_TIMEOUT_MS },
  );

  // ─ Pan + drag interaction. We sample fps over a short window while
  //   driving programmatic mouse moves on the canvas. The canvas centre
  //   is used as the pan anchor; the drag is a small wiggle on three
  //   random nodes — we don't have node screen positions so the wiggle
  //   is approximated by moves around the canvas centre, which is
  //   representative of "user interacting with the graph".
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
  // 2) Drag 3 "random" nodes. We don't know exact node screen positions
  //    so we issue drag gestures at offsets around the canvas centre.
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
    centerPageId: seed.centerPageId,
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
    console.log(`OK (${seed.pageCount} pages, ${seed.edgeCount} edges, focus=${seed.centerPageId})`);
  }

  const browser = await chromium.launch({ headless: args.headless });
  const samples: BenchSample[] = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const accessToken = await login(page, args.backendUrl, args.username, args.password);

    for (const size of args.sizes) {
      const seed = seeds.get(size)!;
      console.log(`\nMeasuring ${size} nodes...`);
      const sample = await runOne(page, args.webUrl, size, seed, accessToken);
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
