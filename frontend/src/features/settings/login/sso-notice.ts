import type { OidcConfig } from '@compendiq/contracts';

/**
 * Outcome of the `GET /auth/oidc/config` probe. Like the `vision` tri-state on
 * the AI composers, this must never collapse to "config or null": a *failed*
 * probe is not the same answer as "SSO is disabled". Reporting a dead backend
 * as "no SSO here" silently removes the only sign-in path on an SSO-only
 * deployment, and reads to the user as if the button had been deleted.
 *
 * `failed` carries its own in-flight flag rather than dropping back to
 * `pending`: a recheck has to keep the notice — and the button the user just
 * pressed — mounted. Only the first probe of a page load renders nothing.
 */
export type OidcProbe =
  | { status: 'pending' }
  | { status: 'ready'; config: OidcConfig }
  | { status: 'failed'; retrying: boolean };

/**
 * Which failure the notice names. `serverUnreachable` is true once
 * `GET /auth/login-page-config` — an unrelated core route on the same upstream
 * — has failed too, which is what separates "nothing responded" from "the SSO
 * route specifically failed". It matters most on CE, where SSO does not exist
 * at all and an SSO-shaped error is pure noise.
 *
 * The two texts are not interchangeable phrasings of one message: the
 * unreachable branch cannot promise that credential sign-in still works, since
 * the endpoint it posts to is on the same dead upstream.
 */
export function ssoNoticeCopy(serverUnreachable: boolean) {
  return serverUnreachable
    ? {
        heading: 'Cannot reach the server',
        body: 'Nothing on the API responded, so we cannot tell whether single sign-on is configured here. Credential sign-in will likely fail too until the server is back.',
        announcement:
          'Cannot reach the server. Single sign-on availability is unknown, and credential sign-in may fail until it is back.',
      }
    : {
        heading: 'Single sign-on status unavailable',
        body: 'The single sign-on check did not complete, so we cannot tell whether it is configured here.',
        announcement:
          'Single sign-on status unavailable. You can still sign in with credentials below.',
      };
}

/**
 * Text for the login page's live region — empty when there is nothing to say.
 *
 * The two signals behind the notice settle independently, so this stays silent
 * until the attribution one has landed. Announcing on the first signal alone
 * produces a second, contradicting announcement a few frames later ("Cannot
 * reach the server" and then "Single sign-on status unavailable"). The
 * *visible* heading does refine in place — showing the weaker true statement
 * and then the stronger one is honest on screen, and the user can see it
 * change — but a screen reader cannot take back what it has already said.
 */
export function ssoProbeAnnouncement(
  probe: OidcProbe,
  serverUnreachable: boolean,
  attributionPending: boolean,
): string {
  if (probe.status !== 'failed' || probe.retrying || attributionPending) return '';
  return ssoNoticeCopy(serverUnreachable).announcement;
}
