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
# Obtain a JWT token (replace credentials as needed)
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
