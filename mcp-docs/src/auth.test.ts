import { describe, it, expect, vi } from 'vitest';
import { makeMcpAuth, MCP_AUTH_HEADER } from './auth.js';

function makeRes() {
  return {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(b: unknown) { this.body = b; return this; },
  };
}

describe('makeMcpAuth', () => {
  it('passes through when no token is configured (backward compatible)', () => {
    const next = vi.fn();
    const res = makeRes();
    makeMcpAuth(undefined)({ headers: {} } as never, res as never, next as never);
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(0);
  });

  it('rejects a missing token with 401 when configured', () => {
    const next = vi.fn();
    const res = makeRes();
    makeMcpAuth('s3cret')({ headers: {} } as never, res as never, next as never);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('rejects a wrong token with 401', () => {
    const next = vi.fn();
    const res = makeRes();
    makeMcpAuth('s3cret')(
      { headers: { [MCP_AUTH_HEADER]: 'nope' } } as never,
      res as never,
      next as never,
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('rejects a token of a different length with 401 (no length leak crash)', () => {
    const next = vi.fn();
    const res = makeRes();
    makeMcpAuth('s3cret')(
      { headers: { [MCP_AUTH_HEADER]: 'x' } } as never,
      res as never,
      next as never,
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('allows a correct token', () => {
    const next = vi.fn();
    const res = makeRes();
    makeMcpAuth('s3cret')(
      { headers: { [MCP_AUTH_HEADER]: 's3cret' } } as never,
      res as never,
      next as never,
    );
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(0);
  });
});
