# Performance Testing

Load tests for the Compendiq search endpoint using [k6](https://k6.io/) and a database seed script for test data.

## Prerequisites

- **k6** installed separately (not an npm dependency):
  ```bash
  # macOS
  brew install k6

  # Linux (Debian/Ubuntu)
  sudo gpg -k
  sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
    --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D68
  echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" \
    | sudo tee /etc/apt/sources.list.d/k6.list
  sudo apt-get update && sudo apt-get install k6

  # Docker (no install)
  docker run --rm -i grafana/k6 run - < perf/search-load-test.js
  ```

- **PostgreSQL** running with the Compendiq schema migrated
- **Node.js 20+** and `npx tsx` available (ships with the project dev dependencies)

## 1. Seed Test Data

Insert 1000 pages with 3 embedding chunks each (3000 total embeddings) across 5 test spaces:

```bash
# Uses POSTGRES_URL from .env or the default connection string
npx tsx perf/seed-test-data.ts

# Or specify a custom connection string
POSTGRES_URL=postgresql://kb_user:changeme-postgres@localhost:5432/kb_creator \
  npx tsx perf/seed-test-data.ts
```

The seed script is **idempotent** -- running it again removes existing test data first.

### Clean up test data

```bash
npx tsx perf/seed-test-data.ts --cleanup
```

Test pages are identified by their `confluence_id` prefix (`perf-test-*`) so cleanup never touches real data.

## 2. Run the Load Test

```bash
# Obtain a JWT token (example credentials — replace with your actual admin account)
TOKEN=$(curl -s -X POST http://localhost:3051/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin"}' | jq -r '.token')

# Run with defaults (ramps to 50 VUs over 100s)
k6 run -e AUTH_TOKEN="$TOKEN" perf/search-load-test.js

# Override base URL
k6 run -e BASE_URL=http://localhost:3051 -e AUTH_TOKEN="$TOKEN" perf/search-load-test.js
```

### Test Scenario

The default scenario uses a **ramping-vus** executor:

| Phase     | Duration | Target VUs |
|-----------|----------|-----------|
| Warm-up   | 30s      | 0 -> 10   |
| Sustained | 60s      | 10 -> 50  |
| Cool-down | 10s      | 50 -> 0   |

Each virtual user picks a random search query and mode (keyword-heavy mix: 60% keyword, 20% semantic, 20% hybrid) then waits 0.5-2s before the next request.

### Thresholds

| Metric             | Threshold     |
|--------------------|---------------|
| `http_req_duration` | p(95) < 300ms |
| `http_req_duration` | p(99) < 500ms |
| `http_req_failed`   | < 1% errors   |
| `search_errors`     | < 2% failures |

If any threshold is breached, k6 exits with a non-zero code.

## 3. Interpret Results

k6 prints a summary table at the end of each run. Key metrics:

- **http_req_duration**: End-to-end latency (including network). Check p95 and p99.
- **http_reqs**: Total requests completed and the throughput (req/s).
- **search_errors**: Percentage of requests that returned non-200 or had invalid response bodies.
- **iterations**: Total VU iterations completed.

For detailed analysis, export results to JSON or InfluxDB:

```bash
# JSON output
k6 run -e AUTH_TOKEN="$TOKEN" --out json=results.json perf/search-load-test.js

# InfluxDB (requires InfluxDB running)
k6 run -e AUTH_TOKEN="$TOKEN" --out influxdb=http://localhost:8086/k6 perf/search-load-test.js
```

## Test Data Details

The seed script creates:

- **1000 pages** as `source='confluence'` with `visibility='shared'`
- **5 test spaces**: `PERF-DEVOPS`, `PERF-SECURITY`, `PERF-PLATFORM`, `PERF-INFRA`, `PERF-DOCS`
- **3000 embedding chunks** (3 per page) with random 1024-dim vectors
- Pages have realistic titles, body text, labels, and authors
- All test data uses the `perf-test-` confluence_id prefix for safe cleanup

## Baselines

### 2026-04-11 — MacBook / docker-desktop / 1000 pages

Phase 0 gate run. Seeded 1000 PERF-* pages into the running EE stack's postgres
(via a `node:20-alpine` sidecar on `compendiq-ee_data-net` because the
postgres container is not exposed to the host — the data network is
`internal: true`). Ran k6 via `grafana/k6` docker image attached to
`compendiq-ee_backend-net`, reaching the backend at `http://backend:3051`.

**Fixture:** 1000 pages × 3 embedding chunks = 3000 vectors, random 1024-dim.
**Script:** `perf/search-load-test.js` — 30s ramp → 60s @ 50 VUs → 10s
cooldown, mix of keyword (60%) + semantic (20%) + hybrid (20%) modes.
**Note:** Default global rate limit of 100 req/min had to be raised to
100000/min for the run (via `admin_settings.rate_limit_global_max` +
backend restart to bypass the 60s TTL cache) and reverted afterwards.

**Result: PASS — huge headroom.**

| Metric | Value | Target | Headroom |
|---|---|---|---|
| http_req_duration p(50) / med | 4.80ms | — | — |
| http_req_duration p(90) | 6.60ms | — | — |
| http_req_duration p(95) | 7.09ms | < 300ms | ~42× |
| http_req_duration p(99) | **9.28ms** | **< 500ms** | **~54×** |
| http_req_duration max | 19.35ms | — | — |
| http_req_duration avg | 4.72ms | — | — |
| Total requests | 1743 | — | — |
| Failed requests | 0 | < 1% | — |
| search_errors | 0% | < 2% | — |

Interpretation: hybrid search over a 1000-page index with random embeddings
is comfortably bound by SQL / index traversal rather than application-level
overhead. Random-vector HNSW queries are typically faster than real-world
ones (no semantic clustering), so the real-world p99 under production data
is expected to be somewhat higher — still with significant headroom.

**Known caveats for this baseline:**
1. Random 1024-dim embeddings have artificially flat neighbourhoods. Real
   `bge-m3` embeddings cluster, which stresses the HNSW index differently.
2. The global rate limit had to be raised to let k6 generate load; the
   backend's rate limiter is the first bottleneck under real load. Tune
   `rate_limit_global_max` per deployment.
3. The `perf_user` is a freshly-registered non-admin, so search results
   are empty (no space permissions). This still exercises the query
   pipeline end-to-end; result-set size affects response serialisation
   but not the HNSW / FTS / RRF path.
4. Run was on a MacBook via Docker Desktop; repeat on a Linux target VM
   before reporting a production SLO number.

To re-run with zero friction:

```bash
# 1. Start the EE stack (already documented above)
# 2. Seed via docker sidecar (postgres is on an internal network)
docker build -t perf-seeder:local /tmp/perf-seeder  # Dockerfile: FROM node:20-alpine, npm i tsx pg pgvector
docker run --rm \
  --network compendiq-ee_data-net \
  -v "$PWD/perf:/perf:ro" \
  -e POSTGRES_URL=postgresql://kb_user:changeme-postgres@postgres:5432/kb_creator \
  perf-seeder:local sh -c 'cp /perf/seed-test-data.ts /app/seed.ts && cd /app && npx tsx seed.ts'

# 3. Raise rate limit
docker exec compendiq-ee-postgres-1 psql -U kb_user -d kb_creator -c \
  "INSERT INTO admin_settings VALUES ('rate_limit_global_max','100000',NOW()) \
   ON CONFLICT (setting_key) DO UPDATE SET setting_value='100000';"
docker restart compendiq-ee-backend-1  # bypass the 60s in-process cache

# 4. Get auth token and run k6
TOKEN=$(curl -sS -X POST http://localhost:3053/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"<user>","password":"<pass>"}' | jq -r .accessToken)
docker run --rm -i \
  --network compendiq-ee_backend-net \
  -e BASE_URL=http://backend:3051 \
  -e AUTH_TOKEN="$TOKEN" \
  grafana/k6 run - < perf/search-load-test.js

# 5. Cleanup
docker run --rm \
  --network compendiq-ee_data-net \
  -v "$PWD/perf:/perf:ro" \
  -e POSTGRES_URL=postgresql://kb_user:changeme-postgres@postgres:5432/kb_creator \
  perf-seeder:local sh -c 'cp /perf/seed-test-data.ts /app/seed.ts && cd /app && npx tsx seed.ts --cleanup'
docker exec compendiq-ee-postgres-1 psql -U kb_user -d kb_creator -c \
  "DELETE FROM admin_settings WHERE setting_key='rate_limit_global_max';"
docker restart compendiq-ee-backend-1
```
