/**
 * Legacy-client guard for the article AI policy switch (#1881, design §2.3;
 * `docs/architecture/article-ai-policy-activation.md`).
 *
 * A pre-#1881 SPA bundle still open in a browser tab can run WebGPU inference
 * without the server-side browser-authorization handshake (gap G2). The server
 * cannot stop what it never hears about, but it does hear every session
 * issuance: such a bundle sends no `X-Compendiq-Client-Protocol` header on
 * `/api/auth/*` and `/api/setup/admin`, while browsers set `Sec-Fetch-Mode` on
 * every request. A request is *legacy* when it carries `Sec-Fetch-Mode` and no
 * marker >= {@link AI_POLICY_CLIENT_PROTOCOL_VERSION}.
 *
 * Two global hooks, scoped to the explicit allow-list of session-issuing POSTs
 * ({@link AI_POLICY_SESSION_ROUTES}); every other request pays a method compare
 * and a Set lookup:
 *
 * - `onRequest`, legacy only: read `ai_policy_activation_state.enabled`
 *   straight from PostgreSQL (never a cache — the rare path must see a
 *   switch-off on the next request). Enabled → 409 `client_reload_required`
 *   before any credential check or token rotation, so EE's single-use OIDC
 *   login code stays unconsumed and reloading signs in. Unreadable → 503
 *   `ai_policy_unavailable` (fail closed). Disabled → continue.
 * - `onSend`, legacy only, 2xx only: safe-parse the serialized body for the
 *   `user.id` every covered route returns and record an attributed observation
 *   (detached upsert, errors caught; it can neither fail nor delay the
 *   response). The activation readiness read turns these rows into the
 *   `legacy_clients_active` blocker. A forged unauthenticated request never
 *   reaches 2xx and records nothing.
 *
 * Non-browser clients (no `Sec-Fetch-Mode`; Playwright's Node-side `request`)
 * and marked clients are never touched, in either switch state.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  AI_POLICY_CLIENT_PROTOCOL_HEADER,
  AI_POLICY_CLIENT_PROTOCOL_VERSION,
  CLIENT_RELOAD_REQUIRED,
} from '@compendiq/contracts';
import { query } from '../db/postgres.js';
import { logger } from '../utils/logger.js';
import { getAccessTokenLifetimeSeconds } from './auth.js';

/**
 * The session-issuing POST routes the guard covers, matched exactly against the
 * routed URL (`request.routeOptions.url`, prefix included, no query string).
 * `/api/auth/oidc/exchange` is registered by the EE overlay after this guard;
 * the GET `/api/auth/oidc/callback` navigation cannot carry a header and is
 * deliberately not covered — the SPA's following exchange is.
 */
export const AI_POLICY_SESSION_ROUTES: readonly string[] = Object.freeze([
  '/api/auth/refresh',
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/oidc/exchange',
  '/api/setup/admin',
]);

const SESSION_ROUTE_SET: ReadonlySet<string> = new Set(AI_POLICY_SESSION_ROUTES);

/** Node lowercases incoming header names. */
const MARKER_HEADER = AI_POLICY_CLIENT_PROTOCOL_HEADER.toLowerCase();

/** Per-user, per-process observation throttle (design §2.3). */
export const LEGACY_CLIENT_OBSERVATION_THROTTLE_MS = 30_000;

/** Lazy sweep bound for the throttle map; distinct legacy users rarely reach it. */
const THROTTLE_SWEEP_SIZE = 1024;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const lastObservationAt = new Map<string, number>();
const inFlightObservations = new Set<Promise<void>>();

function isSessionRoute(request: FastifyRequest): boolean {
  const url = request.routeOptions.url;
  return request.method === 'POST' && url !== undefined && SESSION_ROUTE_SET.has(url);
}

function isLegacyBrowserClient(request: FastifyRequest): boolean {
  if (request.headers['sec-fetch-mode'] === undefined) return false;
  const marker = request.headers[MARKER_HEADER];
  if (typeof marker !== 'string') return true;
  const version = Number.parseInt(marker, 10);
  return !(version >= AI_POLICY_CLIENT_PROTOCOL_VERSION);
}

/**
 * Reads the switch from PostgreSQL. A missing singleton row is a schema
 * invariant violation and is treated like an unreadable switch: the caller
 * fails closed.
 */
async function readEnforcementEnabled(): Promise<boolean> {
  const result = await query<{ enabled: boolean }>(
    'SELECT enabled FROM ai_policy_activation_state WHERE singleton',
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('ai_policy_activation_state singleton row is missing');
  return row.enabled;
}

/** `user.id` from a serialized `{ accessToken, user }` body, or null. */
function userIdFromSessionPayload(payload: unknown): string | null {
  if (typeof payload !== 'string') return null;
  let body: unknown;
  try {
    body = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof body !== 'object' || body === null || !('user' in body)) return null;
  const user = body.user;
  if (typeof user !== 'object' || user === null || !('id' in user)) return null;
  const id = user.id;
  return typeof id === 'string' && UUID_PATTERN.test(id) ? id : null;
}

function sweepThrottle(now: number): void {
  for (const [userId, at] of lastObservationAt) {
    if (now - at >= LEGACY_CLIENT_OBSERVATION_THROTTLE_MS) lastObservationAt.delete(userId);
  }
}

/**
 * Detached, throttled upsert. `token_expires_at` is stamped with the lifetime
 * this process signs (not the configured string), and never moves backwards:
 * a token issued under a longer lifetime stays visible until it really expires.
 */
function recordLegacyClientObservation(userId: string, route: string): void {
  const now = Date.now();
  const last = lastObservationAt.get(userId);
  if (last !== undefined && now - last < LEGACY_CLIENT_OBSERVATION_THROTTLE_MS) return;
  lastObservationAt.set(userId, now);
  if (lastObservationAt.size > THROTTLE_SWEEP_SIZE) sweepThrottle(now);

  const upsert: Promise<void> = query(
    `INSERT INTO ai_policy_legacy_client_observations (user_id, last_seen_at, token_expires_at, observations)
     VALUES ($1, NOW(), NOW() + ($2::int * interval '1 second'), 1)
     ON CONFLICT (user_id) DO UPDATE
       SET last_seen_at = EXCLUDED.last_seen_at,
           token_expires_at = GREATEST(ai_policy_legacy_client_observations.token_expires_at, EXCLUDED.token_expires_at),
           observations = ai_policy_legacy_client_observations.observations + 1`,
    [userId, getAccessTokenLifetimeSeconds()],
  ).then(
    () => undefined,
    (err: unknown) => {
      // A missed observation; the acknowledgement model covers it. Forget the
      // throttle stamp so the user's next issuance is recorded.
      lastObservationAt.delete(userId);
      logger.warn({ err, userId, route }, 'Failed to record legacy-client observation');
    },
  );
  inFlightObservations.add(upsert);
  void upsert.finally(() => inFlightObservations.delete(upsert));
}

/**
 * Adds the two hooks to `app`. Call on the ROOT instance before any route
 * plugin is registered: Fastify copies the parent's hooks into a child plugin
 * when that child is created, so a root `addHook` made later never reaches a
 * child that already exists (this is why the EE overlay's `registerRoutes`
 * must run after this call).
 */
export function registerLegacyClientGuard(app: FastifyInstance): void {
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isSessionRoute(request) || !isLegacyBrowserClient(request)) return;

    let enabled: boolean;
    try {
      enabled = await readEnforcementEnabled();
    } catch (err) {
      logger.error(
        { err, route: request.routeOptions.url },
        'Article AI policy switch unreadable; refusing legacy-client session issuance (fail closed)',
      );
      return reply.code(503).send({
        error: 'ai_policy_unavailable',
        message: 'The server could not verify this client version. Try again shortly.',
      });
    }
    if (!enabled) return;

    logger.info({ route: request.routeOptions.url }, 'Refused session issuance to a legacy client; reload required');
    return reply.code(409).send({
      error: CLIENT_RELOAD_REQUIRED,
      message: 'Reload this page to continue. This version of the app can no longer sign in.',
    });
  });

  app.addHook('onSend', async (request: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    if (
      reply.statusCode >= 200 &&
      reply.statusCode < 300 &&
      isSessionRoute(request) &&
      isLegacyBrowserClient(request)
    ) {
      const userId = userIdFromSessionPayload(payload);
      if (userId !== null) recordLegacyClientObservation(userId, request.routeOptions.url ?? '');
    }
    return payload;
  });
}

/** Settles every detached observation upsert started so far (tests). */
export async function awaitLegacyClientObservationsForTest(): Promise<void> {
  while (inFlightObservations.size > 0) {
    await Promise.all([...inFlightObservations]);
  }
}

/** Settles in-flight upserts and forgets the per-process throttle (tests). */
export async function resetLegacyClientGuardForTest(): Promise<void> {
  await awaitLegacyClientObservationsForTest();
  lastObservationAt.clear();
}
