import { describe, it, expect } from 'vitest';
import {
  COLLAB_UPGRADE_WINDOW_SEC,
  COLLAB_WS_PROTOCOL,
  CollabConfigSchema,
  CollabCommitConflictSchema,
  CollabCommitSchema,
  CollabCommitUnknownControlSchema,
  CollabDocEpochControlSchema,
  CollabDocEpochSchema,
  CollabCommitResponseSchema,
  CollabRefusalReasonSchema,
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

  it('names the 4403 refusal reasons and the upgrade window (#1895)', () => {
    expect(CollabRefusalReasonSchema.options).toEqual(['forbidden', 'readonly', 'rate_limited', 'flag_off']);
    expect(CollabRefusalReasonSchema.safeParse('rate_limited').success).toBe(true);
    // A reason the client does not know must not be mapped to a relaxed state.
    expect(CollabRefusalReasonSchema.safeParse('denied').success).toBe(false);
    expect(CollabRefusalReasonSchema.safeParse('').success).toBe(false);
    // The client's rate-limit Retry waits exactly this long; its copy says "a minute".
    expect(COLLAB_UPGRADE_WINDOW_SEC).toBe(60);
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

  it('accepts only a UUID as a document epoch (#2034)', () => {
    const epoch = '7b0f4c1e-52a8-4d3f-9c6b-1a2b3c4d5e6f';
    expect(CollabDocEpochSchema.parse(epoch)).toBe(epoch);
    for (const malformed of ['', ' ', 'null', '7b0f4c1e52a84d3f9c6b1a2b3c4d5e6f', `${epoch} `, `${epoch},${epoch}`]) {
      expect(CollabDocEpochSchema.safeParse(malformed).success, malformed).toBe(false);
    }
    // A repeated query parameter reaches the route as an array.
    expect(CollabDocEpochSchema.safeParse([epoch, epoch]).success).toBe(false);
    expect(CollabDocEpochSchema.safeParse(undefined).success).toBe(false);
  });

  it('parses the doc_epoch control strictly (#2034)', () => {
    const epoch = '7b0f4c1e-52a8-4d3f-9c6b-1a2b3c4d5e6f';
    expect(CollabDocEpochControlSchema.parse({ type: 'doc_epoch', epoch })).toEqual({ type: 'doc_epoch', epoch });
    expect(CollabDocEpochControlSchema.safeParse({ type: 'doc_epoch' }).success).toBe(false);
    expect(CollabDocEpochControlSchema.safeParse({ type: 'doc_epoch', epoch: 'not-a-uuid' }).success).toBe(false);
    expect(CollabDocEpochControlSchema.safeParse({ type: 'doc_reset', epoch }).success).toBe(false);
    // Strict: a frame that carries anything else is not this control.
    expect(CollabDocEpochControlSchema.safeParse({ type: 'doc_epoch', epoch, writable: true }).success).toBe(false);
  });

  it('parses the payload-free commit_unknown control strictly (#2035)', () => {
    expect(CollabCommitUnknownControlSchema.parse({ type: 'commit_unknown' })).toEqual({ type: 'commit_unknown' });
    // Strict: no payload, so a frame that carries anything else is not this control.
    for (const extra of [{ intentId: 'a' }, { writable: true }, { reason: 'commit_unknown' }, { version: 1 }]) {
      expect(
        CollabCommitUnknownControlSchema.safeParse({ type: 'commit_unknown', ...extra }).success,
        JSON.stringify(extra),
      ).toBe(false);
    }
    for (const malformed of [
      {}, { type: 'commit-unknown' }, { type: 'COMMIT_UNKNOWN' }, { type: 'permission_loss' },
      { type: ['commit_unknown'] }, { type: null }, 'commit_unknown', null, ['commit_unknown'],
    ]) {
      expect(CollabCommitUnknownControlSchema.safeParse(malformed).success, JSON.stringify(malformed)).toBe(false);
    }
  });

  it('types the 409 confluence_modified body with an additive save outcome (#2035)', () => {
    const base = { code: 'confluence_modified', remoteVersion: 9, localVersion: 4 };
    // The error envelope around the typed part is ignored.
    expect(CollabCommitConflictSchema.parse({
      error: 'Conflict', message: 'x', statusCode: 409, ...base, saveOutcome: 'unknown',
    })).toEqual({ ...base, saveOutcome: 'unknown' });
    expect(CollabCommitConflictSchema.parse({ ...base, saveOutcome: 'not_dispatched' }).saveOutcome)
      .toBe('not_dispatched');
    // A server that predates the field: the body still parses, without an outcome.
    expect(CollabCommitConflictSchema.parse(base)).toEqual(base);
    // An outcome the client does not know is not read as either.
    expect(CollabCommitConflictSchema.safeParse({ ...base, saveOutcome: 'saved' }).success).toBe(false);
    expect(CollabCommitConflictSchema.safeParse({ ...base, saveOutcome: true }).success).toBe(false);
    expect(CollabCommitConflictSchema.safeParse({ ...base, code: 'collab_session_active' }).success).toBe(false);
  });
});
