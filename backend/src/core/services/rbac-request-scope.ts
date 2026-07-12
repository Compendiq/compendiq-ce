// backend/src/core/services/rbac-request-scope.ts
//
// Per-request AsyncLocalStorage scope for RBAC space-resolution memoisation.
//
// Why: `getUserAccessibleSpaces(userId)` is consulted from multiple paths in a
// single RAG request (vector search, keyword search, and hybrid wrapper).
// Without a request-scoped cache, a single user-facing query triggers N round
// trips to Postgres + N Redis hits for the same answer. The Redis cache helps
// but still costs a socket round-trip per call. AsyncLocalStorage lets us pin
// the resolved set for the lifetime of the Fastify request.
//
// Contract: callers that need the memoised answer use
// `getUserAccessibleSpacesMemoized(userId)` from `rbac-service.ts`, which reads
// from this scope first and falls back to the normal resolver on miss.
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RbacScope {
  userId: string;
  // Undefined until the first resolver call in this request populates it.
  spaces?: string[];
}

const storage = new AsyncLocalStorage<RbacScope>();

/**
 * Run `fn` inside a fresh RBAC scope bound to `userId`. Use this in tests and
 * anywhere you explicitly control the async context boundary.
 */
export function runWithRbacScope<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  return storage.run({ userId }, fn);
}

/**
 * Enter a fresh RBAC scope on the current async chain and return it. Used from
 * Fastify's `authenticate` hook so that all downstream work for this request
 * (including the route handler) shares the same scope without wrapping the
 * whole pipeline in a callback.
 *
 * MUST be called synchronously, before the hook's first `await`. `enterWith`
 * only propagates the store to continuations that descend from the frame it
 * was called in; entering it *after* an await binds the store to a resumed
 * frame the route handler never inherits, so the memo would be dead at runtime
 * (#899). The caller therefore enters an empty scope up front and assigns
 * `userId` on the returned object once authentication succeeds — the transient
 * empty-userId window is safe because `getScopedSpaces` gates on a matching
 * `userId`, returning null (a resolver fall-through) until it is filled in.
 */
export function enterRbacScope(): RbacScope {
  const scope: RbacScope = { userId: '' };
  storage.enterWith(scope);
  return scope;
}

export function setScopedSpaces(spaces: string[]): void {
  const scope = storage.getStore();
  if (scope) scope.spaces = spaces;
}

/**
 * Returns the memoised readable-space list for `userId` if the current scope
 * was opened for that same user, or null when (a) there is no scope (e.g.
 * background worker, test without `runWithRbacScope`), (b) the scope belongs
 * to a different user, or (c) the scope exists but has not yet been populated.
 */
export function getScopedSpaces(userId: string): string[] | null {
  const scope = storage.getStore();
  if (scope && scope.userId === userId && scope.spaces !== undefined) {
    return scope.spaces;
  }
  return null;
}
