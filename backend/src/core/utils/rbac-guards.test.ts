import { describe, it, expect, vi } from 'vitest';
import { requireGlobalPermission } from './rbac-guards.js';

describe('requireGlobalPermission', () => {
  function makeReply() {
    const status = vi.fn().mockReturnThis();
    const send = vi.fn();
    return { status, send } as const;
  }

  it('allows through when userCan resolves true', async () => {
    const handler = requireGlobalPermission('llm:query');
    const request = { userCan: vi.fn().mockResolvedValue(true) };
    const reply = makeReply();

    await handler(
      request as unknown as Parameters<typeof handler>[0],
      reply as unknown as Parameters<typeof handler>[1],
    );

    expect(request.userCan).toHaveBeenCalledWith('llm:query', 'global');
    expect(reply.status).not.toHaveBeenCalled();
    expect(reply.send).not.toHaveBeenCalled();
  });

  it('sends 403 with deterministic envelope when userCan resolves false', async () => {
    const handler = requireGlobalPermission('sync:trigger');
    const request = { userCan: vi.fn().mockResolvedValue(false) };
    const reply = makeReply();

    await handler(
      request as unknown as Parameters<typeof handler>[0],
      reply as unknown as Parameters<typeof handler>[1],
    );

    expect(reply.status).toHaveBeenCalledWith(403);
    expect(reply.send).toHaveBeenCalledWith({
      error: 'Forbidden',
      message: 'Permission "sync:trigger" required',
      statusCode: 403,
    });
  });

  it('uses the specific permission name in the error message', async () => {
    const handler = requireGlobalPermission('pages:delete');
    const request = { userCan: vi.fn().mockResolvedValue(false) };
    const reply = makeReply();

    await handler(
      request as unknown as Parameters<typeof handler>[0],
      reply as unknown as Parameters<typeof handler>[1],
    );

    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Permission "pages:delete" required',
      }),
    );
  });
});
