import { describe, it, expect } from 'vitest';
import {
  COLLAB_WS_PROTOCOL,
  CollabConfigSchema,
  CollabCommitSchema,
  CollabCommitResponseSchema,
  CollabWritableAdmissionControlSchema,
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

  it('requires an exact lifecycle revision on writable admission', () => {
    expect(CollabWritableAdmissionControlSchema.parse({
      type: 'writable_admission',
      lifecycleRevision: '42',
    })).toEqual({
      type: 'writable_admission',
      lifecycleRevision: '42',
    });
    expect(() => CollabWritableAdmissionControlSchema.parse({
      type: 'writable_admission',
      lifecycleRevision: '4.2',
    })).toThrow();
    expect(() => CollabWritableAdmissionControlSchema.parse({
      type: 'writable_admission',
      lifecycleRevision: '42',
      writable: true,
    })).toThrow();
  });

  it('requires the captured lifecycle and document state on collaborative commit', () => {
    const request = {
      title: 'Hello',
      expectedLifecycleRevision: '42',
      expectedDocumentState: 'AAA=',
    };
    expect(CollabCommitSchema.safeParse(request).success).toBe(true);
    expect(CollabCommitSchema.safeParse({ ...request, expectedDocumentState: undefined }).success).toBe(false);
    expect(CollabCommitSchema.safeParse({ ...request, expectedDocumentState: 'not base64' }).success).toBe(false);
    expect(() => CollabCommitSchema.parse({ title: 'Hello' })).toThrow();
    expect(() => CollabCommitSchema.parse({
      title: 'Hello',
      expectedLifecycleRevision: '04',
      expectedDocumentState: 'AAA=',
    })).toThrow();
    expect(() => CollabCommitSchema.parse({
      title: '',
      expectedLifecycleRevision: '42',
      expectedDocumentState: 'AAA=',
      bodyHtml: '<p>no</p>',
    })).toThrow();
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
