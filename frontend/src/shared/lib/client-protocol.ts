import {
  AI_POLICY_CLIENT_PROTOCOL_HEADER,
  AI_POLICY_CLIENT_PROTOCOL_VERSION,
  ClientReloadRequiredSchema,
} from '@compendiq/contracts';

/**
 * The legacy-client marker (#1881, design §2.3).
 *
 * A browser tab still running a bundle from before article AI policy keeps
 * running client-side inference the server never hears about, so once
 * enforcement is on the backend refuses to issue a session to a browser
 * request that does not carry `X-Compendiq-Client-Protocol: 1` on the
 * session-issuing routes (`/api/auth/refresh`, `/login`, `/register`,
 * `/oidc/exchange`, `/api/setup/admin`). This helper is the ONE place the
 * header is written: every `fetch` to one of those routes builds its headers
 * through it, and `client-protocol.test.ts` enumerates the call sites.
 *
 * It returns a `Headers` instance so a caller can keep setting headers on
 * it (`apiFetch` adds `Authorization` and `Content-Type` afterwards).
 */
export function withClientProtocol(headers?: HeadersInit): Headers {
  const marked = new Headers(headers);
  marked.set(AI_POLICY_CLIENT_PROTOCOL_HEADER, String(AI_POLICY_CLIENT_PROTOCOL_VERSION));
  return marked;
}

/**
 * The message for a 409 `client_reload_required`. It is deliberately not a
 * login failure: the credentials were never checked. Reloading loads the
 * policy-aware bundle (`index.html` is never cached), and a policy-aware
 * bundle that still sees this message points at a proxy stripping the header.
 */
export const CLIENT_RELOAD_REQUIRED_MESSAGE = 'This page is out of date. Reload to continue.';

/** True when a decoded error body is the backend's `client_reload_required` refusal. */
export function isClientReloadRequired(body: unknown): boolean {
  return ClientReloadRequiredSchema.safeParse(body).success;
}

/**
 * The recovery every `client_reload_required` surface offers (login, OIDC
 * callback, setup). One function so the three controls cannot drift, and so
 * a test can observe the call — jsdom's `location.reload` is unforgeable
 * and cannot be spied on directly.
 */
export function reloadPage(): void {
  window.location.reload();
}
