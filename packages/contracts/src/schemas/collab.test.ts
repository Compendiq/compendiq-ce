import { describe, it, expect } from 'vitest';
import {
  COLLAB_WS_PROTOCOL,
  CollabConfigSchema,
  CollabCommitSchema,
  CollabCommitResponseSchema,
} from './collab.js';

describe('collab contracts (#1444)', () => {
  it('exports the y-websocket subprotocol token', () => {
    expect(COLLAB_WS_PROTOCOL).toBe('compendiq.collab.v1');
  });

  it('parses GET /api/collab/config', () => {
    expect(CollabConfigSchema.parse({ enabled: false })).toEqual({ enabled: false });
    expect(CollabConfigSchema.parse({ enabled: true })).toEqual({ enabled: true });
    expect(() => CollabConfigSchema.parse({})).toThrow();
    expect(() => CollabConfigSchema.parse({ enabled: '1' })).toThrow();
  });

  it('parses POST /api/pages/:id/collab/commit', () => {
    expect(CollabCommitSchema.parse({ title: 'Hello' })).toEqual({ title: 'Hello' });
    expect(() => CollabCommitSchema.parse({})).toThrow();
    expect(() => CollabCommitSchema.parse({ title: '', bodyHtml: '<p>no</p>' })).toThrow();
    expect(
      CollabCommitResponseSchema.parse({
        id: 1,
        title: 'Hello',
        version: 2,
        source: 'standalone',
      }),
    ).toMatchObject({ id: 1, version: 2, source: 'standalone' });
  });
});
