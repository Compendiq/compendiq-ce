/**
 * #1444 — collab JWTs arrive on Authorization and Sec-WebSocket-Protocol.
 * A fixture token must never appear in a serialized log line.
 */
import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import pino from 'pino';
import { PINO_REDACT_PATHS } from './logger.js';

const FIXTURE_JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.collab-redact-fixture.signature';

describe('pino redact (#1444)', () => {
  it('redacts authorization and sec-websocket-protocol paths', () => {
    expect(PINO_REDACT_PATHS).toEqual(
      expect.arrayContaining([
        'req.headers.authorization',
        'req.headers["sec-websocket-protocol"]',
      ]),
    );
  });

  it('does not emit a fixture JWT when those headers are logged', () => {
    let buf = '';
    const dest = new Writable({
      write(chunk, _enc, cb) {
        buf += String(chunk);
        cb();
      },
    });
    const log = pino({ redact: { paths: [...PINO_REDACT_PATHS] } }, dest);
    log.info({
      req: {
        headers: {
          authorization: `Bearer ${FIXTURE_JWT}`,
          'sec-websocket-protocol': `compendiq.collab.v1, ${FIXTURE_JWT}`,
        },
      },
    }, 'collab handshake');
    expect(buf).not.toContain(FIXTURE_JWT);
    expect(buf).toMatch(/Redact|\[redacted\]/i);
  });
});
