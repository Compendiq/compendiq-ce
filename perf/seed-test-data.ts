/**
 * Seed script for performance testing.
 *
 * Inserts 1000 standalone pages with realistic text content and random
 * 1024-dimensional embeddings across 5 test spaces. Uses the `pg` driver
 * directly so it runs independently of the backend application.
 *
 * Usage:
 *   npx tsx perf/seed-test-data.ts                          # uses default POSTGRES_URL
 *   POSTGRES_URL=postgresql://... npx tsx perf/seed-test-data.ts
 *
 * Cleanup:
 *   npx tsx perf/seed-test-data.ts --cleanup
 *
 * The script is idempotent: running it again replaces existing test data.
 */

import pg from 'pg';
import pgvector from 'pgvector';

const { Pool } = pg;

// ── Configuration ───────────────────────────────────────────────────────────

const POSTGRES_URL =
  process.env.POSTGRES_URL ??
  'postgresql://kb_user:changeme-postgres@localhost:5432/kb_creator';

const TOTAL_PAGES = 1000;
const CHUNKS_PER_PAGE = 3;
const EMBEDDING_DIMS = 1024;
const BATCH_SIZE = 50;

const TEST_SPACES = [
  'PERF-DEVOPS',
  'PERF-SECURITY',
  'PERF-PLATFORM',
  'PERF-INFRA',
  'PERF-DOCS',
];

// Prefixed with "perf-test-" so cleanup can target them precisely.
const CONFLUENCE_ID_PREFIX = 'perf-test-';

// ── Realistic content generation ────────────────────────────────────────────

const TITLES = [
  'Deployment Pipeline Overview',
  'Kubernetes Cluster Setup Guide',
  'Database Migration Runbook',
  'Security Hardening Checklist',
  'Monitoring and Alerting Strategy',
  'Authentication Flow Architecture',
  'Docker Container Best Practices',
  'API Gateway Configuration',
  'Load Testing Methodology',
  'Configuration Management',
  'Backup and Recovery Procedures',
  'Network Architecture Diagram',
  'Storage Tier Selection Guide',
  'Logging Infrastructure Setup',
  'CI/CD Pipeline Troubleshooting',
  'Incident Response Playbook',
  'Service Mesh Configuration',
  'Secrets Management Policy',
  'Performance Tuning Guide',
  'Capacity Planning Document',
  'Disaster Recovery Plan',
  'Compliance Requirements',
  'Onboarding Developer Guide',
  'Microservices Communication Patterns',
  'Data Retention Policy',
];

const PARAGRAPHS = [
  'This document outlines the standard operating procedures for deploying services to production. All deployments must go through the staging environment first and pass automated smoke tests before promotion.',
  'Kubernetes clusters are provisioned using Infrastructure as Code with Terraform. Each environment (dev, staging, production) has its own cluster with dedicated node pools for compute-intensive workloads.',
  'Database migrations should be backward-compatible to support zero-downtime deployments. Always test migrations against a copy of production data before applying them to the live database.',
  'Security scanning is integrated into the CI pipeline. All container images are scanned for known vulnerabilities, and any critical or high severity findings block the deployment.',
  'The monitoring stack consists of Prometheus for metrics collection, Grafana for visualization, and Alertmanager for notification routing. Custom dashboards are version-controlled alongside the application code.',
  'Authentication uses JWT tokens with short-lived access tokens (15 minutes) and longer-lived refresh tokens (7 days). Tokens are rotated automatically on each refresh to prevent replay attacks.',
  'Docker images follow a multi-stage build pattern to minimize the final image size. Base images are pinned to specific digest hashes to ensure reproducible builds across environments.',
  'The API gateway handles rate limiting, request routing, and TLS termination. Rate limits are configured per-endpoint based on expected traffic patterns and resource consumption.',
  'Load tests simulate realistic user behavior with ramping virtual users. Tests run in a dedicated environment that mirrors production infrastructure to ensure accurate results.',
  'Configuration is managed through environment variables with sensible defaults. Sensitive values are stored in a secrets manager and injected at runtime, never committed to source control.',
  'Backups are taken every six hours with point-in-time recovery enabled. Recovery procedures are tested quarterly to ensure the documented RPO and RTO targets can be met.',
  'The network architecture uses a hub-and-spoke model with private subnets for databases and internal services. Only the load balancer and bastion host are exposed to the public internet.',
  'Storage tiers are selected based on access patterns. Frequently accessed data uses SSD-backed volumes, while archival data is moved to object storage with lifecycle policies.',
  'Structured logging in JSON format enables efficient querying and analysis. Log levels are configurable at runtime without requiring a service restart.',
  'The CI/CD pipeline uses GitHub Actions with self-hosted runners for builds that require access to internal resources. Pipeline definitions are stored in the repository alongside the application code.',
  'Incident response follows a structured process: detect, triage, mitigate, resolve, and post-mortem. All incidents above severity 2 require a written post-mortem within 48 hours.',
  'The service mesh provides mutual TLS between services, traffic management, and observability. Service-to-service communication is encrypted by default with certificates rotated automatically.',
  'Secrets are rotated on a regular schedule and are never stored in plain text. Access to secrets is audited and follows the principle of least privilege.',
  'Performance tuning starts with profiling to identify bottlenecks. Common optimizations include connection pooling, query optimization, caching strategies, and horizontal scaling.',
  'Capacity planning uses historical metrics to forecast resource requirements. Autoscaling policies are configured with appropriate cooldown periods to prevent thrashing.',
];

const LABELS_POOL = [
  'deployment', 'kubernetes', 'database', 'security', 'monitoring',
  'authentication', 'docker', 'api', 'testing', 'configuration',
  'backup', 'network', 'storage', 'logging', 'ci-cd',
  'incident-response', 'service-mesh', 'secrets', 'performance', 'capacity',
  'devops', 'sre', 'platform', 'infrastructure', 'compliance',
];

const AUTHORS = [
  'alice.johnson', 'bob.smith', 'carol.williams', 'dave.brown',
  'eve.davis', 'frank.miller', 'grace.wilson', 'hank.moore',
];

function randomItem<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function randomSubset<T>(arr: T[], min: number, max: number): T[] {
  const count = Math.floor(Math.random() * (max - min + 1)) + min;
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

function generateBodyText(index: number): string {
  // Combine 3-5 paragraphs for each page to create realistic content length
  const count = Math.floor(Math.random() * 3) + 3;
  const selected: string[] = [];
  for (let i = 0; i < count; i++) {
    selected.push(PARAGRAPHS[(index + i) % PARAGRAPHS.length]!);
  }
  return selected.join('\n\n');
}

function generateRandomEmbedding(): number[] {
  // Generate a normalized random vector (unit length) to mimic real embeddings
  const vec = new Array(EMBEDDING_DIMS);
  let norm = 0;
  for (let i = 0; i < EMBEDDING_DIMS; i++) {
    // Box-Muller transform for normally distributed values
    const u1 = Math.random();
    const u2 = Math.random();
    vec[i] = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    norm += vec[i] * vec[i];
  }
  norm = Math.sqrt(norm);
  for (let i = 0; i < EMBEDDING_DIMS; i++) {
    vec[i] /= norm;
  }
  return vec;
}

function randomDate(daysBack: number): Date {
  const now = Date.now();
  const offset = Math.floor(Math.random() * daysBack * 24 * 60 * 60 * 1000);
  return new Date(now - offset);
}

// ── Database operations ─────────────────────────────────────────────────────

async function cleanup(pool: pg.Pool): Promise<void> {
  console.log('Cleaning up existing test data...');

  // page_embeddings cascade-deletes when pages are deleted
  const result = await pool.query(
    `DELETE FROM pages WHERE confluence_id LIKE $1 RETURNING id`,
    [`${CONFLUENCE_ID_PREFIX}%`],
  );

  console.log(`  Removed ${result.rowCount} test pages (and their embeddings).`);
}

async function seed(pool: pg.Pool): Promise<void> {
  await cleanup(pool);

  console.log(`Seeding ${TOTAL_PAGES} pages across ${TEST_SPACES.length} spaces...`);

  let pagesInserted = 0;
  let embeddingsInserted = 0;

  for (let batch = 0; batch < TOTAL_PAGES; batch += BATCH_SIZE) {
    const batchEnd = Math.min(batch + BATCH_SIZE, TOTAL_PAGES);

    // Use a transaction per batch for atomicity and performance
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      for (let i = batch; i < batchEnd; i++) {
        const confluenceId = `${CONFLUENCE_ID_PREFIX}${i.toString().padStart(5, '0')}`;
        const spaceKey = TEST_SPACES[i % TEST_SPACES.length]!;
        const title = `${TITLES[i % TITLES.length]} (#${i})`;
        const bodyText = generateBodyText(i);
        const labels = randomSubset(LABELS_POOL, 1, 5);
        const author = randomItem(AUTHORS);
        const lastModifiedAt = randomDate(180);

        // Insert the page.
        // The tsv column is maintained by a trigger (trg_pages_tsv) and computed automatically.
        const pageResult = await client.query(
          `INSERT INTO pages (
            confluence_id, space_key, title, body_text, body_html,
            version, labels, author, last_modified_at, last_synced,
            embedding_dirty, embedding_status, embedded_at,
            source, visibility, page_type
          ) VALUES (
            $1, $2, $3, $4, $5,
            1, $6, $7, $8, NOW(),
            FALSE, 'embedded', NOW(),
            'confluence', 'shared', 'page'
          ) RETURNING id`,
          [
            confluenceId,
            spaceKey,
            title,
            bodyText,
            `<p>${bodyText.replace(/\n\n/g, '</p><p>')}</p>`,
            labels,
            author,
            lastModifiedAt,
          ],
        );

        const pageId = pageResult.rows[0]!.id as number;
        pagesInserted++;

        // Insert embedding chunks for this page
        for (let chunk = 0; chunk < CHUNKS_PER_PAGE; chunk++) {
          const chunkStart = Math.floor((bodyText.length / CHUNKS_PER_PAGE) * chunk);
          const chunkEnd = Math.floor((bodyText.length / CHUNKS_PER_PAGE) * (chunk + 1));
          const chunkText = bodyText.slice(chunkStart, chunkEnd);
          const embedding = generateRandomEmbedding();

          await client.query(
            `INSERT INTO page_embeddings (page_id, chunk_index, chunk_text, embedding, metadata)
             VALUES ($1, $2, $3, $4, $5)`,
            [
              pageId,
              chunk,
              chunkText,
              pgvector.toSql(embedding),
              JSON.stringify({ source: 'perf-test', chunk_method: 'fixed' }),
            ],
          );

          embeddingsInserted++;
        }
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const progress = Math.round((batchEnd / TOTAL_PAGES) * 100);
    process.stdout.write(`\r  Progress: ${progress}% (${batchEnd}/${TOTAL_PAGES} pages)`);
  }

  console.log(''); // newline after progress
  console.log(`  Inserted ${pagesInserted} pages and ${embeddingsInserted} embedding chunks.`);
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: POSTGRES_URL });

  try {
    // Verify connection
    const result = await pool.query('SELECT NOW() AS now');
    console.log(`Connected to PostgreSQL at ${new Date(result.rows[0]!.now as string).toISOString()}`);

    if (process.argv.includes('--cleanup')) {
      await cleanup(pool);
    } else {
      await seed(pool);
    }

    console.log('Done.');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Seed script failed:', err);
  process.exit(1);
});
