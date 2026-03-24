# Performance Baseline & Testing

This document defines the performance testing methodology, key metrics, baseline targets, and how to run performance tests for AtlasMind.

## Test Methodology

### Approach

Performance is measured at three layers:

1. **API latency** -- HTTP round-trip times measured at the backend route level using `pino` request logging and, when enabled, OpenTelemetry spans.
2. **Database query performance** -- Query execution time tracked via `pg` client hooks and `EXPLAIN ANALYZE` for critical paths.
3. **Frontend rendering** -- Time-to-interactive (TTI) and Largest Contentful Paint (LCP) measured via Lighthouse and Playwright performance APIs.

### Test Environment

- **Hardware baseline**: Tests should be run on a consistent environment (CI runner or dedicated machine).
- **Database**: PostgreSQL 17 with pgvector, seeded with a representative dataset (1,000+ pages, 10,000+ embeddings).
- **LLM**: Ollama with a lightweight model (e.g., `qwen3:4b`) for AI response tests, or mock responses for deterministic timing.
- **Concurrency**: Single-user baseline, then 10-user concurrent load for stress tests.

### Measurement Tools

| Tool | Purpose |
|------|---------|
| `pino` request logs | API response times (built into the backend) |
| `pg` query timing | Database query duration |
| OpenTelemetry (`OTEL_ENABLED=true`) | Distributed tracing for end-to-end latency |
| Playwright `performance.measure()` | Frontend rendering and interaction timing |
| `autocannon` / `k6` | HTTP load testing |
| Lighthouse CI | Frontend Core Web Vitals |

## Key Metrics

### Backend API Latency

| Endpoint | Metric | Target |
|----------|--------|--------|
| `GET /api/health/ready` | p99 | < 50ms |
| `POST /api/auth/login` | p99 | < 300ms |
| `GET /api/pages` (list, 50 items) | p99 | < 200ms |
| `GET /api/pages/:id` (single page) | p99 | < 150ms |
| `GET /api/pages?search=...` (full-text search) | p99 | < 500ms |
| `POST /api/pages` (create standalone) | p99 | < 300ms |
| `PUT /api/pages/:id` (update) | p99 | < 300ms |
| `DELETE /api/pages/:id` (soft delete) | p99 | < 200ms |
| `POST /api/llm/embeddings/generate` (single page) | p99 | < 5s |
| `GET /api/llm/search` (RAG vector search) | p99 | < 500ms |

### AI / LLM Streaming

| Metric | Target |
|--------|--------|
| Time to first SSE token (AI chat) | p99 < 2s |
| Total streaming duration (short query) | p99 < 15s |
| Time to first SSE token (improve/summarize) | p99 < 3s |

### Frontend Core Web Vitals

| Metric | Target |
|--------|--------|
| Largest Contentful Paint (LCP) | < 2.5s |
| First Input Delay (FID) | < 100ms |
| Cumulative Layout Shift (CLS) | < 0.1 |
| Time to Interactive (TTI) | < 3.5s |
| Bundle size (gzipped) | < 500 KB |

### Database Query Performance

| Query | Target |
|-------|--------|
| Pages list with filters (50 rows) | < 50ms |
| Full-text search (keyword) | < 100ms |
| Vector similarity search (pgvector HNSW) | < 200ms |
| Hybrid search (vector + keyword) | < 300ms |
| Page tree query (recursive CTE) | < 100ms |

## Baseline Targets Summary

| Category | Critical Threshold | Target |
|----------|-------------------|--------|
| Search (keyword + vector) | p99 < 1s | p99 < 500ms |
| AI response start (first token) | p99 < 5s | p99 < 2s |
| Page CRUD operations | p99 < 500ms | p99 < 300ms |
| Authentication | p99 < 500ms | p99 < 300ms |
| Health check | p99 < 100ms | p99 < 50ms |

## How to Run Performance Tests

### Prerequisites

1. Start the development environment:
   ```bash
   docker compose -f docker/docker-compose.dev.yml up -d
   npm run dev
   ```

2. Seed test data (if needed):
   ```bash
   # Create test pages via the API
   node scripts/seed-test-data.js  # (if available)
   ```

### API Latency Tests

Use `autocannon` for HTTP load testing:

```bash
# Install autocannon globally
npm install -g autocannon

# Health endpoint (baseline)
autocannon -c 10 -d 10 http://localhost:3051/api/health/ready

# Authenticated endpoints (replace TOKEN with a valid JWT)
TOKEN=$(curl -s -X POST http://localhost:3051/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"your-password"}' | jq -r '.accessToken')

# Pages list
autocannon -c 10 -d 10 -H "Authorization=Bearer $TOKEN" \
  http://localhost:3051/api/pages

# Search
autocannon -c 5 -d 10 -H "Authorization=Bearer $TOKEN" \
  "http://localhost:3051/api/pages?search=test"
```

### Database Query Analysis

Connect to PostgreSQL and run EXPLAIN ANALYZE on critical queries:

```sql
-- Pages list query performance
EXPLAIN ANALYZE
SELECT id, title, source, updated_at
FROM pages
WHERE deleted_at IS NULL
ORDER BY updated_at DESC
LIMIT 50;

-- Full-text search
EXPLAIN ANALYZE
SELECT id, title, ts_rank(search_vector, plainto_tsquery('english', 'test')) AS rank
FROM pages
WHERE deleted_at IS NULL
  AND search_vector @@ plainto_tsquery('english', 'test')
ORDER BY rank DESC
LIMIT 20;

-- Vector similarity search (requires embeddings)
EXPLAIN ANALYZE
SELECT p.id, p.title, 1 - (e.embedding <=> '[...]'::vector) AS similarity
FROM page_embeddings e
JOIN pages p ON p.id = e.page_id
WHERE p.deleted_at IS NULL
ORDER BY e.embedding <=> '[...]'::vector
LIMIT 10;
```

### Frontend Performance

Use Lighthouse CI:

```bash
# Install Lighthouse CI
npm install -g @lhci/cli

# Run against local dev server
lhci autorun --collect.url=http://localhost:8081/login \
  --collect.url=http://localhost:8081/ \
  --assert.assertions.categories:performance=off
```

Or use Playwright's built-in performance measurement:

```typescript
// In a Playwright test
test('measure page load performance', async ({ page }) => {
  await page.goto('/');

  const metrics = await page.evaluate(() => {
    const entries = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
    const nav = entries[0];
    return {
      domContentLoaded: nav.domContentLoadedEventEnd - nav.startTime,
      loadComplete: nav.loadEventEnd - nav.startTime,
      ttfb: nav.responseStart - nav.requestStart,
    };
  });

  expect(metrics.domContentLoaded).toBeLessThan(3000);
  expect(metrics.ttfb).toBeLessThan(500);
});
```

### OpenTelemetry Tracing

Enable tracing for detailed end-to-end latency analysis:

```bash
# Set environment variables
export OTEL_ENABLED=true
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318

# Start a local Jaeger instance for trace visualization
docker run -d --name jaeger \
  -p 16686:16686 \
  -p 4318:4318 \
  jaegertracing/all-in-one:latest

# Start the backend with tracing enabled
npm run dev

# View traces at http://localhost:16686
```

## Monitoring & Alerting

### Key Indicators to Watch

1. **p99 API latency trending above targets** -- Investigate slow queries or missing indexes.
2. **Embedding generation queue depth** -- If the queue grows faster than it drains, consider scaling workers or reducing batch size.
3. **SSE streaming timeout rate** -- High timeout rates indicate LLM provider issues.
4. **Database connection pool exhaustion** -- Monitor `pg_stat_activity` for idle connections.
5. **Redis memory usage** -- LLM cache and session data can grow; monitor eviction rates.

### Regression Detection

Performance tests should be integrated into CI to detect regressions:

1. Run API latency benchmarks on every PR against `dev`.
2. Compare p50 and p99 against the baseline.
3. Flag PRs that increase p99 latency by more than 20%.
4. Track bundle size changes in frontend builds.
