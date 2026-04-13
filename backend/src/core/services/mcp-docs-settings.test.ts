import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the database module
vi.mock('../db/postgres.js', () => ({
  query: vi.fn(),
  getPool: vi.fn(() => ({
    connect: vi.fn(() => ({
      query: vi.fn(),
      release: vi.fn(),
    })),
  })),
}));

vi.mock('../utils/logger.js', () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { getMcpDocsSettings } from './mcp-docs-settings.js';
import { query } from '../db/postgres.js';

describe('mcp-docs-settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns defaults when no settings exist', async () => {
    vi.mocked(query).mockResolvedValueOnce({ rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] });

    const settings = await getMcpDocsSettings();

    expect(settings.enabled).toBe(false);
    expect(settings.domainMode).toBe('blocklist');
    expect(settings.allowedDomains).toEqual(['*']);
    expect(settings.blockedDomains).toEqual([]);
    expect(settings.cacheTtl).toBe(3600);
    expect(settings.maxContentLength).toBe(50_000);
  });

  it('parses stored settings correctly', async () => {
    vi.mocked(query).mockResolvedValueOnce({
      rows: [
        { setting_key: 'mcp_docs_enabled', setting_value: 'true' },
        { setting_key: 'mcp_docs_url', setting_value: 'http://custom:3100/mcp' },
        { setting_key: 'mcp_docs_domain_mode', setting_value: 'allowlist' },
        { setting_key: 'mcp_docs_allowed_domains', setting_value: '["docs.example.com","*.mozilla.org"]' },
        { setting_key: 'mcp_docs_cache_ttl', setting_value: '7200' },
      ],
      rowCount: 5, command: 'SELECT', oid: 0, fields: [],
    });

    const settings = await getMcpDocsSettings();

    expect(settings.enabled).toBe(true);
    expect(settings.url).toBe('http://custom:3100/mcp');
    expect(settings.domainMode).toBe('allowlist');
    expect(settings.allowedDomains).toEqual(['docs.example.com', '*.mozilla.org']);
    expect(settings.cacheTtl).toBe(7200);
  });

  it('returns defaults on database error', async () => {
    vi.mocked(query).mockRejectedValueOnce(new Error('DB connection failed'));

    const settings = await getMcpDocsSettings();

    expect(settings.enabled).toBe(false);
    expect(settings.domainMode).toBe('blocklist');
  });
});
