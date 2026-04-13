/**
 * k6 load test for the GET /api/search endpoint.
 *
 * Usage:
 *   k6 run perf/search-load-test.js                                 # defaults
 *   k6 run -e BASE_URL=http://localhost:3051 -e AUTH_TOKEN=<jwt> perf/search-load-test.js
 *
 * The AUTH_TOKEN must be a valid JWT for an authenticated user.
 * Obtain one by logging in via the UI or calling POST /api/auth/login.
 *
 * This script exercises all three search modes (keyword, semantic, hybrid)
 * with a mix of realistic queries to surface latency and throughput issues
 * under ramping load.
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

// ── Custom metrics ──────────────────────────────────────────────────────────

const searchErrors = new Rate('search_errors');
const searchDuration = new Trend('search_duration', true);

// ── Configuration ───────────────────────────────────────────────────────────

export const options = {
  scenarios: {
    search_load: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 10 },   // warm-up
        { duration: '60s', target: 50 },   // sustained load
        { duration: '10s', target: 0 },    // cool-down
      ],
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<300', 'p(99)<500'],
    http_req_failed: ['rate<0.01'],
    search_errors: ['rate<0.02'],
  },
};

// ── Helpers ─────────────────────────────────────────────────────────────────

const BASE = __ENV.BASE_URL || 'http://localhost:3051';
const TOKEN = __ENV.AUTH_TOKEN;

if (!TOKEN) {
  console.warn(
    'AUTH_TOKEN not set. All requests will receive 401. ' +
    'Pass -e AUTH_TOKEN=<jwt> to authenticate.',
  );
}

const SEARCH_QUERIES = [
  'deployment',
  'kubernetes',
  'database',
  'security',
  'monitoring',
  'authentication',
  'docker',
  'api',
  'testing',
  'configuration',
  'backup',
  'migration',
  'network',
  'storage',
  'logging',
];

const SEARCH_MODES = ['keyword', 'keyword', 'keyword', 'semantic', 'hybrid'];

function randomItem(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ── Default function (executed per VU iteration) ────────────────────────────

export default function () {
  const q = randomItem(SEARCH_QUERIES);
  const mode = randomItem(SEARCH_MODES);
  const limit = Math.floor(Math.random() * 10) + 5; // 5..14

  const url = `${BASE}/api/search?q=${encodeURIComponent(q)}&mode=${mode}&limit=${limit}`;

  const params = {
    headers: {},
    tags: { name: 'search', mode: mode },
  };

  if (TOKEN) {
    params.headers['Authorization'] = `Bearer ${TOKEN}`;
  }

  const res = http.get(url, params);

  searchDuration.add(res.timings.duration);

  const passed = check(res, {
    'status is 200': (r) => r.status === 200,
    'response has items array': (r) => {
      try {
        const body = JSON.parse(r.body);
        return Array.isArray(body.items);
      } catch {
        return false;
      }
    },
    'response time < 500ms': (r) => r.timings.duration < 500,
  });

  searchErrors.add(!passed);

  // Simulate realistic user think time between searches (0.5s to 2s)
  sleep(Math.random() * 1.5 + 0.5);
}

// ── Lifecycle hooks ─────────────────────────────────────────────────────────

export function setup() {
  // Verify the target is reachable before starting the test
  const healthRes = http.get(`${BASE}/api/health`);
  if (healthRes.status !== 200) {
    throw new Error(
      `Health check failed (status ${healthRes.status}). ` +
      `Is the backend running at ${BASE}?`,
    );
  }

  // Verify authentication works
  if (TOKEN) {
    const searchRes = http.get(`${BASE}/api/search?q=test&mode=keyword&limit=1`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    if (searchRes.status === 401) {
      throw new Error(
        'AUTH_TOKEN is invalid or expired. ' +
        'Obtain a fresh token by logging in.',
      );
    }
  }

  return {};
}
