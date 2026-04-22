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

interface RbacScope {
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
 * Enter a fresh RBAC scope on the current async chain. Used from Fastify's
 * `authenticate` hook so that all downstream work for this request (including
 * the route handler) shares the same scope without wrapping the whole pipeline
 * in a callback. Safe to call once per request after authentication succeeds.
 */
export function enterRbacScope(userId: string): void {
  storage.enterWith({ userId });
}

export function getCurrentScope(): RbacScope | undefined {
  return storage.getStore();
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
