import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';
import {
  parseQualityScores,
  processBatch,
  forceQualityRescan,
  startQualityWorker,
  stopQualityWorker,
} from './quality-worker.js';

const dbAvailable = await isDbAvailable();

// Mock the LLM and content converter to avoid real calls in tests
vi.mock('../../llm/services/ollama-service.js', () => ({
  getSystemPrompt: vi.fn().mockReturnValue('You are a quality analyzer.'),
  streamChat: vi.fn().mockImplementation(() => {
    async function* generator() {
      yield {
        content: `## Overall Quality Score: 75/100\n## Completeness: 80/100\n## Clarity: 70/100\n## Structure: 78/100\n## Accuracy: 72/100\n## Readability: 68/100\n## Summary\nDecent article.`,
        done: false,
      };
      yield { content: '', done: true };
    }
    return generator();
  }),
}));

vi.mock('../../../core/utils/sanitize-llm-input.js', () => ({
  sanitizeLlmInput: vi.fn().mockImplementation((input: string) => ({ sanitized: input, wasSanitized: false })),
}));

vi.mock('../../../core/services/content-converter.js', () => ({
  htmlToMarkdown: vi.fn().mockImplementation((html: string) => html),
}));

describe('parseQualityScores', () => {
  it('parses a complete well-formed quality report', () => {
    const text = `
## Overall Quality Score: 75/100

## Completeness: 80/100
- Missing a troubleshooting section
- Could add more examples

## Clarity: 70/100
- Some jargon is undefined
- Complex sentences in section 3

## Structure: 78/100
- Good heading hierarchy
- Missing table of contents

## Accuracy: 72/100
- Some outdated API references

## Readability: 68/100
- Long paragraphs in introduction
- Code blocks lack syntax highlighting

## Summary
This article covers the basics well but needs work on clarity and readability. The main areas for improvement are defining technical jargon and breaking up long paragraphs.
`;

    const result = parseQualityScores(text);
    expect(result).not.toBeNull();
    expect(result!.overall).toBe(75);
    expect(result!.completeness).toBe(80);
    expect(result!.clarity).toBe(70);
    expect(result!.structure).toBe(78);
    expect(result!.accuracy).toBe(72);
    expect(result!.readability).toBe(68);
    expect(result!.summary).toContain('covers the basics well');
  });

  it('returns null when overall score is missing', () => {
    const text = `
## Completeness: 80/100
## Clarity: 70/100
## Structure: 78/100
## Accuracy: 72/100
## Readability: 68/100
## Summary
Some text.
`;
    expect(parseQualityScores(text)).toBeNull();
  });

  it('returns null when a dimension score is missing', () => {
    const text = `
## Overall Quality Score: 75/100
## Completeness: 80/100
## Clarity: 70/100
## Structure: 78/100
## Readability: 68/100
## Summary
Missing accuracy dimension.
`;
    expect(parseQualityScores(text)).toBeNull();
  });

  it('clamps scores above 100 to 100', () => {
    const text = `
## Overall Quality Score: 150/100
## Completeness: 120/100
## Clarity: 200/100
## Structure: 0/100
## Accuracy: 100/100
## Readability: 50/100
## Summary
Edge case scores.
`;
    const result = parseQualityScores(text);
    expect(result).not.toBeNull();
    expect(result!.overall).toBe(100);
    expect(result!.completeness).toBe(100);
    expect(result!.clarity).toBe(100);
    expect(result!.structure).toBe(0);
    expect(result!.accuracy).toBe(100);
    expect(result!.readability).toBe(50);
  });

  it('returns null when score contains negative number (invalid format)', () => {
    const text = `
## Overall Quality Score: 75/100
## Completeness: -10/100
## Clarity: 70/100
## Structure: 60/100
## Accuracy: 65/100
## Readability: 55/100
## Summary
Negative score.
`;
    // -10 won't match the \\d+ regex, so parsing fails
    expect(parseQualityScores(text)).toBeNull();
  });

  it('handles scores with varied whitespace', () => {
    const text = `
##  Overall Quality Score:  82 / 100

## Completeness:  85 / 100
- Good coverage

## Clarity:  79 / 100
- Clear writing

## Structure:  90 / 100
- Well organized

## Accuracy:  75 / 100
- Mostly accurate

## Readability:  80 / 100
- Easy to read

## Summary
Well-written article with solid structure.
`;
    const result = parseQualityScores(text);
    expect(result).not.toBeNull();
    expect(result!.overall).toBe(82);
    expect(result!.completeness).toBe(85);
  });

  it('handles empty summary gracefully', () => {
    const text = `
## Overall Quality Score: 60/100
## Completeness: 55/100
## Clarity: 65/100
## Structure: 60/100
## Accuracy: 58/100
## Readability: 62/100
## Summary
`;
    const result = parseQualityScores(text);
    expect(result).not.toBeNull();
    expect(result!.summary).toBe('');
  });

  it('returns null for completely empty input', () => {
    expect(parseQualityScores('')).toBeNull();
  });

  it('returns null for malformed output', () => {
    expect(parseQualityScores('This is just plain text with no structure.')).toBeNull();
  });
});

describe.skipIf(!dbAvailable)('Quality Worker (DB)', () => {
  let testUserId: string;
  const testSpaceKey = 'TEST';

  beforeAll(async () => {
    await setupTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();

    // Create a test user with settings
    const userResult = await query<{ id: string }>(
      "INSERT INTO users (username, password_hash, role) VALUES ('qualityuser', 'fakehash', 'admin') RETURNING id",
    );
    testUserId = userResult.rows[0].id;

    // Create space
    await query(
      "INSERT INTO cached_spaces (space_key, space_name) VALUES ($1, 'Test Space')",
      [testSpaceKey],
    );

    // Link user to space
    await query(
      'INSERT INTO user_space_selections (user_id, space_key) VALUES ($1, $2)',
      [testUserId, testSpaceKey],
    );
  });

  afterAll(async () => {
    stopQualityWorker();
    await teardownTestDb();
  });

  describe('processBatch', () => {
    it('should analyze pending pages', async () => {
      await query(
        `INSERT INTO cached_pages (confluence_id, space_key, title, body_text, body_html, quality_status)
         VALUES ('q1', $1, 'Quality Page', 'Some content for analysis', '<p>Some content for analysis</p>', 'pending')`,
        [testSpaceKey],
      );

      const processed = await processBatch();
      expect(processed).toBe(1);

      const result = await query<{ quality_status: string; quality_score: number; quality_retry_count: number }>(
        "SELECT quality_status, quality_score, quality_retry_count FROM cached_pages WHERE confluence_id = 'q1'",
      );
      expect(result.rows[0].quality_status).toBe('analyzed');
      expect(result.rows[0].quality_score).toBe(75);
      expect(result.rows[0].quality_retry_count).toBe(0);
    });

    it('should not pick up failed pages that have exhausted retries', async () => {
      // Insert a failed page with retry count at MAX_RETRIES (3)
      await query(
        `INSERT INTO cached_pages (confluence_id, space_key, title, body_text, body_html, quality_status, quality_retry_count, quality_analyzed_at)
         VALUES ('exhausted1', $1, 'Exhausted Page', 'Some content', '<p>Some content</p>', 'failed', 3, NOW())`,
        [testSpaceKey],
      );

      const processed = await processBatch();
      expect(processed).toBe(0);

      // Status should remain failed
      const result = await query<{ quality_status: string; quality_retry_count: number }>(
        "SELECT quality_status, quality_retry_count FROM cached_pages WHERE confluence_id = 'exhausted1'",
      );
      expect(result.rows[0].quality_status).toBe('failed');
      expect(result.rows[0].quality_retry_count).toBe(3);
    });

    it('should pick up failed pages that have retries remaining', async () => {
      // Insert a failed page with retry count below MAX_RETRIES
      await query(
        `INSERT INTO cached_pages (confluence_id, space_key, title, body_text, body_html, quality_status, quality_retry_count, quality_analyzed_at)
         VALUES ('retry1', $1, 'Retryable Page', 'Some content for retry', '<p>Some content for retry</p>', 'failed', 1, NOW())`,
        [testSpaceKey],
      );

      const processed = await processBatch();
      expect(processed).toBe(1);

      const result = await query<{ quality_status: string; quality_retry_count: number }>(
        "SELECT quality_status, quality_retry_count FROM cached_pages WHERE confluence_id = 'retry1'",
      );
      // LLM mock returns valid scores, so page should be analyzed
      expect(result.rows[0].quality_status).toBe('analyzed');
      expect(result.rows[0].quality_retry_count).toBe(0); // reset on success
    });
  });

  describe('forceQualityRescan', () => {
    it('should reset all non-pending pages including retry count', async () => {
      await query(
        `INSERT INTO cached_pages (confluence_id, space_key, title, body_text, quality_status, quality_score, quality_retry_count)
         VALUES ('r1', $1, 'Analyzed Page', 'content', 'analyzed', 85, 0),
                ('r2', $1, 'Failed Page', 'content', 'failed', NULL, 3),
                ('r3', $1, 'Pending Page', 'content', 'pending', NULL, 0)`,
        [testSpaceKey],
      );

      const resetCount = await forceQualityRescan();
      expect(resetCount).toBe(2); // r1 and r2, not r3 (already pending)

      const result = await query<{ confluence_id: string; quality_status: string; quality_retry_count: number; quality_score: number | null }>(
        'SELECT confluence_id, quality_status, quality_retry_count, quality_score FROM cached_pages ORDER BY confluence_id',
      );

      // r1: analyzed -> pending, score cleared, retry reset
      expect(result.rows[0].quality_status).toBe('pending');
      expect(result.rows[0].quality_score).toBeNull();
      expect(result.rows[0].quality_retry_count).toBe(0);

      // r2: failed -> pending, retry reset
      expect(result.rows[1].quality_status).toBe('pending');
      expect(result.rows[1].quality_retry_count).toBe(0);

      // r3: already pending, unchanged
      expect(result.rows[2].quality_status).toBe('pending');
    });
  });

  describe('worker lifecycle', () => {
    it('should start and stop without errors', () => {
      startQualityWorker(999); // large interval so it doesn't fire
      stopQualityWorker();
    });

    it('should be idempotent on start', () => {
      startQualityWorker(999);
      startQualityWorker(999); // second call should be a no-op
      stopQualityWorker();
    });
  });
});
