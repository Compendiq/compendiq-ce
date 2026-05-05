/**
 * Unit tests for the webhook-emit-hook extension point.
 *
 * These only exercise the CE-side surface (noop-when-unregistered, route-
 * to-registered-hook, exception swallowing). Wire-through to the outbox
 * table is tested in the overlay's integration tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  emitWebhookEvent,
  setWebhookEmitHook,
  _resetWebhookEmitHookForTests,
  type WebhookEvent,
} from './webhook-emit-hook.js';

describe('webhook-emit-hook', () => {
  beforeEach(() => {
    _resetWebhookEmitHookForTests();
  });

  it('is a no-op when no hook is registered (CE default)', () => {
    // Must not throw, must not await, must not do anything visible.
    expect(() =>
      emitWebhookEvent({ eventType: 'page.created', payload: { id: 1 } }),
    ).not.toThrow();
  });

  it('routes the event to the registered hook', () => {
    const hook = vi.fn().mockResolvedValue(undefined);
    setWebhookEmitHook(hook);

    const event: WebhookEvent<{ id: number }> = {
      eventType: 'page.updated',
      payload: { id: 42 },
    };
    emitWebhookEvent(event);

    expect(hook).toHaveBeenCalledWith(event);
  });

  it('is fire-and-forget — never awaits the hook', async () => {
    // If the hook never resolves, the emit call should still return
    // immediately. Using a never-resolving promise guarantees that
    // anything awaiting it would hang, so if the test passes this
    // assertion the emit site did NOT await.
    const hook = vi.fn(() => new Promise<void>(() => {}));
    setWebhookEmitHook(hook);

    const start = Date.now();
    emitWebhookEvent({ eventType: 'page.created', payload: {} });
    expect(Date.now() - start).toBeLessThan(50);
    expect(hook).toHaveBeenCalled();
  });

  it('swallows hook rejections so the emit site never sees them', async () => {
    const hook = vi.fn().mockRejectedValue(new Error('outbox DB down'));
    setWebhookEmitHook(hook);

    expect(() =>
      emitWebhookEvent({ eventType: 'page.deleted', payload: { id: 7 } }),
    ).not.toThrow();

    // Let the microtask queue drain so the .catch() has a chance to run.
    await Promise.resolve();
    await Promise.resolve();
  });

  it('a later setWebhookEmitHook call replaces the prior hook', () => {
    const first = vi.fn().mockResolvedValue(undefined);
    const second = vi.fn().mockResolvedValue(undefined);

    setWebhookEmitHook(first);
    setWebhookEmitHook(second);
    emitWebhookEvent({ eventType: 'sync.completed', payload: {} });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalled();
  });
});
