#!/usr/bin/env npx tsx
/**
 * Seed script for performance baseline testing.
 *
 * Creates 1,000 test pages with realistic content lengths for measuring:
 * - Pages list query latency
 * - Full-text search performance
 * - Hybrid search (vector + keyword) when embeddings are generated
 *
 * Usage:
 *   npx tsx scripts/seed-perf-data.ts
 *
 * Prerequisites:
 *   - PostgreSQL running (docker compose up -d)
 *   - Migrations applied (npm run dev starts the backend which runs migrations)
 *   - POSTGRES_URL env var set (default: postgresql://kb_user:changeme-postgres@localhost:5432/kb_creator)
 *
 * This script is idempotent — it checks for existing perf-test pages before inserting.
 */

import pg from 'pg';

const POSTGRES_URL = process.env.POSTGRES_URL;
if (!POSTGRES_URL) {
  console.error('Error: POSTGRES_URL environment variable is required.');
  console.error('Example: POSTGRES_URL=postgresql://kb_user:pass@localhost:5432/kb_creator npx tsx scripts/seed-perf-data.ts');
  process.exit(1);
}

const TOTAL_PAGES = 1000;
const BATCH_SIZE = 100;

// Sample content building blocks for realistic pages
const TOPICS = [
  'Kubernetes', 'Docker', 'PostgreSQL', 'Redis', 'Nginx',
  'React', 'TypeScript', 'Node.js', 'GraphQL', 'REST API',
  'CI/CD Pipeline', 'Monitoring', 'Logging', 'Security', 'Authentication',
  'Microservices', 'Load Balancing', 'Caching', 'Database Migration', 'Testing',
];

const SECTIONS = [
  'Overview', 'Getting Started', 'Configuration', 'Deployment',
  'Troubleshooting', 'Best Practices', 'Architecture', 'FAQ',
];

function generateContent(index: number): { title: string; body: string; spaceKey: string } {
  const topic = TOPICS[index % TOPICS.length];
  const section = SECTIONS[index % SECTIONS.length];
  const spaceKey = `PERF${Math.floor(index / 200)}`;

  const title = `${topic} — ${section} (Page ${index + 1})`;

  // Generate 200-2000 word paragraphs
  const paragraphCount = 3 + (index % 5);
  const paragraphs: string[] = [];
  for (let p = 0; p < paragraphCount; p++) {
    const sentences = 5 + (index * p) % 10;
    const lines: string[] = [];
    for (let s = 0; s < sentences; s++) {
      lines.push(
        `This section covers ${topic.toLowerCase()} ${section.toLowerCase()} concepts including setup, configuration, and operational best practices for production environments.`,
      );
    }
    paragraphs.push(lines.join(' '));
  }

  const body = `<h1>${title}</h1>\n${paragraphs.map((p) => `<p>${p}</p>`).join('\n')}`;
  return { title, body, spaceKey };
}

async function main() {
  const pool = new pg.Pool({ connectionString: POSTGRES_URL });

  try {
    // Check if perf-test pages already exist
    const existing = await pool.query(
      "SELECT COUNT(*)::int AS count FROM pages WHERE confluence_id LIKE 'perf-test-%'",
    );

    if (existing.rows[0].count >= TOTAL_PAGES) {
      console.log(`Already have ${existing.rows[0].count} perf-test pages. Skipping seed.`);
      return;
    }

    if (existing.rows[0].count > 0) {
      console.log(`Cleaning up ${existing.rows[0].count} existing perf-test pages...`);
      await pool.query("DELETE FROM pages WHERE confluence_id LIKE 'perf-test-%'");
    }

    console.log(`Seeding ${TOTAL_PAGES} test pages in batches of ${BATCH_SIZE}...`);

    const startTime = Date.now();
    let inserted = 0;

    for (let batch = 0; batch < TOTAL_PAGES / BATCH_SIZE; batch++) {
      const values: unknown[] = [];
      const placeholders: string[] = [];
      let paramIdx = 1;

      for (let i = 0; i < BATCH_SIZE; i++) {
        const pageIndex = batch * BATCH_SIZE + i;
        const { title, body, spaceKey } = generateContent(pageIndex);
        const confluenceId = `perf-test-${pageIndex.toString().padStart(4, '0')}`;

        placeholders.push(
          `($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++})`,
        );
        values.push(
          confluenceId,
          spaceKey,
          title,
          body,       // body_storage (XHTML)
          body,       // body_html
          title,      // body_text (plain)
          1,          // version
          'confluence', // source
        );
      }

      await pool.query(
        `INSERT INTO pages (confluence_id, space_key, title, body_storage, body_html, body_text, version, source)
         VALUES ${placeholders.join(',\n')}
         ON CONFLICT (confluence_id) DO NOTHING`,
        values,
      );

      inserted += BATCH_SIZE;
      process.stdout.write(`\r  Inserted ${inserted}/${TOTAL_PAGES} pages...`);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\nDone! Seeded ${TOTAL_PAGES} pages in ${elapsed}s.`);

    // Verify count
    const count = await pool.query(
      "SELECT COUNT(*)::int AS count FROM pages WHERE confluence_id LIKE 'perf-test-%'",
    );
    console.log(`Verified: ${count.rows[0].count} perf-test pages in database.`);

    // Run basic query benchmarks
    console.log('\nRunning quick latency checks...\n');

    // 1. Pages list query
    const t1 = Date.now();
    await pool.query(
      `SELECT id, title, space_key, updated_at FROM pages WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 50`,
    );
    console.log(`  Pages list (LIMIT 50):          ${Date.now() - t1}ms`);

    // 2. Full-text search (if search_vector is populated)
    const t2 = Date.now();
    await pool.query(
      `SELECT id, title FROM pages WHERE deleted_at IS NULL AND body_text ILIKE '%kubernetes%' ORDER BY updated_at DESC LIMIT 20`,
    );
    console.log(`  Keyword search (ILIKE):          ${Date.now() - t2}ms`);

    // 3. Count query
    const t3 = Date.now();
    await pool.query(`SELECT COUNT(*) FROM pages WHERE deleted_at IS NULL`);
    console.log(`  Count all pages:                 ${Date.now() - t3}ms`);

    console.log('\nTo run the full hybrid search benchmark, generate embeddings first:');
    console.log('  1. Start the backend: npm run dev');
    console.log('  2. Trigger embedding: POST /api/llm/embeddings/generate');
    console.log('  3. Run: autocannon -c 5 -d 10 -H "Authorization=Bearer $TOKEN" "http://localhost:3051/api/pages?search=kubernetes"');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
