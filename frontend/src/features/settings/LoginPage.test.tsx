import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LazyMotion, domAnimation } from 'framer-motion';
import { LoginPage } from './LoginPage';
import { apiFetch, ApiError } from '../../shared/lib/api';
import { useAuthStore } from '../../stores/auth-store';
import { toast } from 'sonner';

vi.mock('../../shared/lib/api', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, apiFetch: vi.fn() };
});

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

type OidcOpt = Record<string, unknown> | 'reject';
type RegOpt = { allowRegistration: boolean } | 'reject';
type LoginVariantOpt = 'local-loop' | 'change-desk' | 'reject';
type EditionOpt = 'community' | 'enterprise' | 'absent';

/** Promise a test can settle by hand, to pin down out-of-order responses. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * URL-keyed apiFetch mock. LoginPage fires three independent probes on mount
 * (`/auth/login-page-config`, `/auth/oidc/config` and
 * `/auth/registration-policy`), so a call-order-based `mockResolvedValueOnce`
 * is brittle — key the resolution on the URL instead.
 */
function mockApi(
  opts: {
    oidc?: OidcOpt;
    registration?: RegOpt;
    loginVariant?: LoginVariantOpt;
    edition?: EditionOpt;
    login?: 'ok' | { statusCode: number; message?: string };
  } = {},
) {
  const oidc = opts.oidc ?? { enabled: false, issuer: null, name: null, enterpriseRequired: false };
  const registration = opts.registration ?? { allowRegistration: false };
  const loginVariant = opts.loginVariant ?? 'local-loop';
  // Default 'absent' mirrors a backend predating the field — the common case
  // on an EE deployment pinning the CE frontend by tag.
  const edition = opts.edition ?? 'absent';
  vi.mocked(apiFetch).mockImplementation(async (url: string) => {
    const u = String(url);
    if (u.includes('/auth/login-page-config')) {
      if (loginVariant === 'reject') throw new Error('no login config');
      return {
        variant: loginVariant,
        ...(edition === 'absent' ? {} : { edition }),
      } as never;
    }
    if (u.includes('/auth/oidc/config')) {
      if (oidc === 'reject') throw new Error('no oidc');
      return oidc as never;
    }
    if (u.includes('/auth/registration-policy')) {
      if (registration === 'reject') throw new Error('policy fetch failed');
      return registration as never;
    }
    if (u.includes('/auth/register')) {
      return { accessToken: 'tok', user: { id: 'u1', username: 'newuser', role: 'user' } } as never;
    }
    if (u.includes('/auth/login')) {
      if (opts.login && opts.login !== 'ok') {
        throw new ApiError(opts.login.statusCode, opts.login.message ?? 'Session expired');
      }
      return { accessToken: 'tok', user: { id: 'u1', username: 'simon', role: 'user' } } as never;
    }
    throw new Error(`unexpected apiFetch url: ${u}`);
  });
}

function renderLoginPage(initialEntry = '/login') {
  return render(
    <LazyMotion features={domAnimation}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <LoginPage />
      </MemoryRouter>
    </LazyMotion>,
  );
}

describe('LoginPage', () => {
  beforeEach(() => {
    useAuthStore.getState().clearAuth();
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useAuthStore.getState().clearAuth();
  });

  it('renders the login form', () => {
    mockApi();
    renderLoginPage();
    expect(screen.getByRole('img', { name: 'Compendiq' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Enter username')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Enter password')).toBeInTheDocument();
  });

  it('renders SSO button with the configured IdP display name when OIDC is enabled', async () => {
    mockApi({
      oidc: { enabled: true, issuer: 'https://idp.example.com', name: 'OrgSSO', enterpriseRequired: false },
    });
    renderLoginPage();
    expect(await screen.findByRole('button', { name: 'Sign in with OrgSSO' })).toBeInTheDocument();
    expect(screen.getByText('or continue with credentials')).toBeInTheDocument();
  });

  it('falls back to the generic "SSO" label when no IdP display name is configured', async () => {
    mockApi({
      oidc: { enabled: true, issuer: 'https://idp.example.com', name: null, enterpriseRequired: false },
    });
    renderLoginPage();
    expect(await screen.findByRole('button', { name: 'Sign in with SSO' })).toBeInTheDocument();
  });

  it('does not render SSO button when OIDC is disabled', async () => {
    mockApi({ oidc: { enabled: false, issuer: null, name: null, enterpriseRequired: false } });
    renderLoginPage();
    expect(screen.queryByTestId('sso-login-btn')).not.toBeInTheDocument();
  });

  it('does not render SSO button when OIDC config fetch fails', async () => {
    mockApi({ oidc: 'reject' });
    renderLoginPage();
    expect(screen.queryByTestId('sso-login-btn')).not.toBeInTheDocument();
  });

  // ─── probe failure is not "SSO is disabled" ──────────────────────────────
  // A 502 through nginx (backend down/restarting) used to be swallowed into a
  // hidden button, making an outage indistinguishable from the button having
  // been removed — on an SSO-only deployment that is the entire sign-in path.
  describe('OIDC probe failure', () => {
    it('surfaces an unavailable notice instead of silently hiding SSO', async () => {
      mockApi({ oidc: 'reject' });
      renderLoginPage();

      expect(await screen.findByTestId('sso-probe-failed')).toBeInTheDocument();
      expect(screen.getByText('Single sign-on status unavailable')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument();
      expect(screen.queryByTestId('sso-login-btn')).not.toBeInTheDocument();
    });

    it('stays silent when the probe succeeds and SSO is legitimately disabled', async () => {
      mockApi({ oidc: { enabled: false, issuer: null, name: null, enterpriseRequired: false } });
      renderLoginPage();

      await waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalled());
      expect(screen.queryByTestId('sso-probe-failed')).not.toBeInTheDocument();
      expect(screen.queryByTestId('sso-login-btn')).not.toBeInTheDocument();
    });

    it('recovers the SSO button when the user retries a probe that failed once', async () => {
      let oidcCalls = 0;
      vi.mocked(apiFetch).mockImplementation(async (url: string) => {
        const u = String(url);
        if (u.includes('/auth/oidc/config')) {
          oidcCalls += 1;
          if (oidcCalls === 1) throw new Error('Bad Gateway');
          return { enabled: true, issuer: 'https://idp.example.com', name: 'OrgSSO' } as never;
        }
        if (u.includes('/auth/login-page-config')) return { variant: 'local-loop' } as never;
        if (u.includes('/auth/registration-policy')) return { allowRegistration: false } as never;
        throw new Error(`unexpected apiFetch url: ${u}`);
      });

      renderLoginPage();

      fireEvent.click(await screen.findByRole('button', { name: 'Check again' }));

      expect(await screen.findByRole('button', { name: 'Sign in with OrgSSO' })).toBeInTheDocument();
      expect(screen.queryByTestId('sso-probe-failed')).not.toBeInTheDocument();
    });

    // Dropping back to `pending` on a recheck would unmount the notice — and
    // with it the button the user just pressed. Focus lands on <body>, and a
    // hanging request (the 504 case this whole notice exists for) leaves an
    // empty panel that reads as success.
    it('keeps the notice and its trigger mounted while a recheck is in flight', async () => {
      const slowRecheck = deferred<Record<string, unknown>>();
      let oidcCalls = 0;
      vi.mocked(apiFetch).mockImplementation(async (url: string) => {
        const u = String(url);
        if (u.includes('/auth/oidc/config')) {
          oidcCalls += 1;
          if (oidcCalls === 1) throw new Error('Bad Gateway');
          return slowRecheck.promise as never;
        }
        if (u.includes('/auth/login-page-config')) return { variant: 'local-loop' } as never;
        if (u.includes('/auth/registration-policy')) return { allowRegistration: false } as never;
        throw new Error(`unexpected apiFetch url: ${u}`);
      });

      renderLoginPage();
      fireEvent.click(await screen.findByRole('button', { name: 'Check again' }));

      const busyTrigger = await screen.findByRole('button', { name: /Checking/ });
      expect(screen.getByTestId('sso-probe-failed')).toBeInTheDocument();
      expect(busyTrigger).toHaveAttribute('aria-busy', 'true');
      // aria-disabled, not disabled: a real `disabled` is blurred by the
      // browser and leaves the tab order, dropping the focus of the user who
      // just pressed it.
      expect(busyTrigger).toHaveAttribute('aria-disabled', 'true');
      expect(busyTrigger).not.toBeDisabled();

      await act(async () => {
        slowRecheck.resolve({ enabled: true, issuer: 'https://idp.example.com', name: 'OrgSSO' });
      });
      expect(screen.getByRole('button', { name: 'Sign in with OrgSSO' })).toBeInTheDocument();
    });

    it('moves focus to the recovered SSO button rather than dropping it on <body>', async () => {
      let oidcCalls = 0;
      vi.mocked(apiFetch).mockImplementation(async (url: string) => {
        const u = String(url);
        if (u.includes('/auth/oidc/config')) {
          oidcCalls += 1;
          if (oidcCalls === 1) throw new Error('Bad Gateway');
          return { enabled: true, issuer: 'https://idp.example.com', name: 'OrgSSO' } as never;
        }
        if (u.includes('/auth/login-page-config')) return { variant: 'local-loop' } as never;
        if (u.includes('/auth/registration-policy')) return { allowRegistration: false } as never;
        throw new Error(`unexpected apiFetch url: ${u}`);
      });

      renderLoginPage();
      const retry = await screen.findByRole('button', { name: 'Check again' });
      retry.focus();
      fireEvent.click(retry);

      const ssoButton = await screen.findByRole('button', { name: 'Sign in with OrgSSO' });
      await waitFor(() => expect(ssoButton).toHaveFocus());
    });

    it('announces the failure through a live region present from first paint', async () => {
      mockApi({ oidc: 'reject' });
      renderLoginPage();

      // Empty but mounted: a live region is announced when its *contents*
      // change, and assistive tech is inconsistent about a region inserted at
      // the same moment as its text.
      const announcer = screen.getByTestId('sso-status-announcer');
      expect(announcer.textContent).toBe('');
      expect(announcer).toHaveAttribute('aria-live', 'polite');

      await waitFor(() =>
        expect(announcer).toHaveTextContent(
          'Single sign-on status unavailable. You can still sign in with credentials below.',
        ),
      );
    });

    // The two signals behind the notice settle independently. Announcing on
    // the first one alone means a second, contradicting announcement lands a
    // few frames later — a screen reader cannot take back what it has said.
    it('says nothing until the attribution signal has settled', async () => {
      const slowConfig = deferred<Record<string, unknown>>();
      vi.mocked(apiFetch).mockImplementation(async (url: string) => {
        const u = String(url);
        if (u.includes('/auth/login-page-config')) return slowConfig.promise as never;
        if (u.includes('/auth/oidc/config')) throw new Error('Bad Gateway');
        if (u.includes('/auth/registration-policy')) return { allowRegistration: false } as never;
        throw new Error(`unexpected apiFetch url: ${u}`);
      });

      renderLoginPage();

      // The visible notice is up — the user is never left staring at nothing …
      expect(await screen.findByTestId('sso-probe-failed')).toBeInTheDocument();
      // … but nothing has been announced, because which failure this is
      // depends on a probe that has not answered.
      expect(screen.getByTestId('sso-status-announcer').textContent).toBe('');

      await act(async () => {
        slowConfig.reject(new Error('Bad Gateway'));
      });

      const announcer = screen.getByTestId('sso-status-announcer');
      expect(announcer).toHaveTextContent('Cannot reach the server.');
      // The unreachable wording must not promise credential sign-in works —
      // it posts to the same dead upstream.
      expect(announcer).not.toHaveTextContent('You can still sign in with credentials');
    });

    // The same silence rule has to hold on a *recheck*, not just first paint.
    // Without re-arming it, the region speaks the previous attribution the
    // instant the SSO probe answers, then contradicts itself when the
    // reachability probe lands.
    it('goes silent again while a recheck re-establishes the attribution', async () => {
      const recheckConfig = deferred<Record<string, unknown>>();
      let configCalls = 0;
      vi.mocked(apiFetch).mockImplementation(async (url: string) => {
        const u = String(url);
        if (u.includes('/auth/login-page-config')) {
          configCalls += 1;
          if (configCalls === 1) throw new Error('Bad Gateway');
          return recheckConfig.promise as never;
        }
        if (u.includes('/auth/oidc/config')) throw new Error('Bad Gateway');
        if (u.includes('/auth/registration-policy')) return { allowRegistration: false } as never;
        throw new Error(`unexpected apiFetch url: ${u}`);
      });

      renderLoginPage();
      const announcer = await screen.findByTestId('sso-status-announcer');
      await waitFor(() => expect(announcer).toHaveTextContent('Cannot reach the server.'));

      fireEvent.click(screen.getByRole('button', { name: 'Check again' }));

      // The SSO probe has already failed again, but the reachability probe is
      // still out — so there is nothing trustworthy to say yet.
      await waitFor(() => expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument());
      expect(announcer.textContent).toBe('');

      await act(async () => {
        recheckConfig.resolve({ variant: 'local-loop', edition: 'community' });
      });

      expect(announcer).toHaveTextContent(
        'Single sign-on status unavailable. You can still sign in with credentials below.',
      );
    });
  });

  // ─── which failure actually happened ─────────────────────────────────────
  // `/auth/login-page-config` is an unrelated core route on the same upstream.
  // Losing it too means nothing responded — and a CE deployment that has never
  // had SSO should not be told its single sign-on is unavailable.
  describe('probe failure attribution', () => {
    it('names the outage when the whole API is unreachable, not just SSO', async () => {
      mockApi({ oidc: 'reject', loginVariant: 'reject' });
      renderLoginPage();

      expect(await screen.findByText('Cannot reach the server')).toBeInTheDocument();
      expect(screen.queryByText('Single sign-on status unavailable')).not.toBeInTheDocument();
    });

    it('blames only SSO when the rest of the API is answering', async () => {
      mockApi({ oidc: 'reject' });
      renderLoginPage();

      expect(await screen.findByText('Single sign-on status unavailable')).toBeInTheDocument();
      expect(screen.queryByText('Cannot reach the server')).not.toBeInTheDocument();
    });

    // All three mount requests died with the same upstream. The registration
    // policy fails closed, so a deployment that allows sign-up keeps hiding
    // its own "Create one" link until the page is reloaded.
    it('re-runs the registration policy too, so sign-up reappears after recovery', async () => {
      let policyCalls = 0;
      vi.mocked(apiFetch).mockImplementation(async (url: string) => {
        const u = String(url);
        if (u.includes('/auth/registration-policy')) {
          policyCalls += 1;
          if (policyCalls === 1) throw new Error('Bad Gateway');
          return { allowRegistration: true } as never;
        }
        if (u.includes('/auth/login-page-config')) return { variant: 'local-loop' } as never;
        if (u.includes('/auth/oidc/config')) throw new Error('Bad Gateway');
        throw new Error(`unexpected apiFetch url: ${u}`);
      });

      renderLoginPage();

      const trigger = await screen.findByRole('button', { name: 'Check again' });
      expect(screen.queryByRole('button', { name: 'Create one' })).not.toBeInTheDocument();

      fireEvent.click(trigger);

      expect(await screen.findByRole('button', { name: 'Create one' })).toBeInTheDocument();
      expect(policyCalls).toBe(2);
    });

    it('re-runs the presentation config too, so a recovered backend restores the badge', async () => {
      let configCalls = 0;
      vi.mocked(apiFetch).mockImplementation(async (url: string) => {
        const u = String(url);
        if (u.includes('/auth/login-page-config')) {
          configCalls += 1;
          if (configCalls === 1) throw new Error('Bad Gateway');
          return { variant: 'local-loop', edition: 'enterprise' } as never;
        }
        // SSO stays down: the badge has to recover on its own signal.
        if (u.includes('/auth/oidc/config')) throw new Error('Bad Gateway');
        if (u.includes('/auth/registration-policy')) return { allowRegistration: false } as never;
        throw new Error(`unexpected apiFetch url: ${u}`);
      });

      renderLoginPage();
      expect(await screen.findByText('Cannot reach the server')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Check again' }));

      expect(await screen.findByText('Enterprise Edition')).toBeInTheDocument();
      // API is back, SSO route still is not — the notice narrows accordingly.
      expect(await screen.findByText('Single sign-on status unavailable')).toBeInTheDocument();
    });

    it('ignores a stale presentation-config response that lands after a newer one', async () => {
      const slowFirst = deferred<Record<string, unknown>>();
      let configCalls = 0;
      vi.mocked(apiFetch).mockImplementation(async (url: string) => {
        const u = String(url);
        if (u.includes('/auth/login-page-config')) {
          configCalls += 1;
          if (configCalls === 1) return slowFirst.promise as never;
          throw new Error('Bad Gateway');
        }
        if (u.includes('/auth/oidc/config')) throw new Error('Bad Gateway');
        if (u.includes('/auth/registration-policy')) return { allowRegistration: false } as never;
        throw new Error(`unexpected apiFetch url: ${u}`);
      });

      renderLoginPage();
      fireEvent.click(await screen.findByRole('button', { name: 'Check again' }));
      expect(await screen.findByText('Cannot reach the server')).toBeInTheDocument();

      // The original request finally answers, long after a newer one said the
      // server is down. It must not resurrect a badge or claim reachability.
      await act(async () => {
        slowFirst.resolve({ variant: 'local-loop', edition: 'community' });
      });

      expect(configCalls).toBe(2);
      expect(screen.queryByText('Community Edition · AGPL-3.0')).not.toBeInTheDocument();
      expect(screen.getByText('Cannot reach the server')).toBeInTheDocument();
    });

    // Mirror of the above. The failure direction is the damaging one: nothing
    // serialises the presentation-config probe, so a hung mount request can
    // still reject after a recheck has proved the server is answering.
    it('ignores a stale presentation-config failure that lands after a newer success', async () => {
      const slowFirst = deferred<Record<string, unknown>>();
      let configCalls = 0;
      vi.mocked(apiFetch).mockImplementation(async (url: string) => {
        const u = String(url);
        if (u.includes('/auth/login-page-config')) {
          configCalls += 1;
          if (configCalls === 1) return slowFirst.promise as never;
          return { variant: 'local-loop', edition: 'enterprise' } as never;
        }
        if (u.includes('/auth/oidc/config')) throw new Error('Bad Gateway');
        if (u.includes('/auth/registration-policy')) return { allowRegistration: false } as never;
        throw new Error(`unexpected apiFetch url: ${u}`);
      });

      renderLoginPage();
      fireEvent.click(await screen.findByRole('button', { name: 'Check again' }));
      expect(await screen.findByText('Enterprise Edition')).toBeInTheDocument();

      await act(async () => {
        slowFirst.reject(new Error('Bad Gateway'));
      });

      expect(configCalls).toBe(2);
      expect(screen.queryByText('Cannot reach the server')).not.toBeInTheDocument();
      expect(screen.getByText('Enterprise Edition')).toBeInTheDocument();
    });

    // ChangeDeskLogin and LocalLoopLogin are different component types, so a
    // variant the server reports late remounts the entire auth panel — taking
    // any focus bookkeeping and any live region that lives inside it.
    it('keeps focus and the live region across the layout swap a late variant causes', async () => {
      const recheckConfig = deferred<Record<string, unknown>>();
      let oidcCalls = 0;
      let configCalls = 0;
      vi.mocked(apiFetch).mockImplementation(async (url: string) => {
        const u = String(url);
        if (u.includes('/auth/login-page-config')) {
          configCalls += 1;
          if (configCalls === 1) throw new Error('Bad Gateway');
          return recheckConfig.promise as never;
        }
        if (u.includes('/auth/oidc/config')) {
          oidcCalls += 1;
          if (oidcCalls === 1) throw new Error('Bad Gateway');
          return { enabled: true, issuer: 'https://idp.example.com', name: 'OrgSSO' } as never;
        }
        if (u.includes('/auth/registration-policy')) return { allowRegistration: false } as never;
        throw new Error(`unexpected apiFetch url: ${u}`);
      });

      renderLoginPage();
      const retry = await screen.findByRole('button', { name: 'Check again' });
      retry.focus();
      fireEvent.click(retry);

      const ssoButton = await screen.findByRole('button', { name: 'Sign in with OrgSSO' });
      await waitFor(() => expect(ssoButton).toHaveFocus());
      const announcerBefore = screen.getByTestId('sso-status-announcer');

      await act(async () => {
        recheckConfig.resolve({ variant: 'change-desk', edition: 'enterprise' });
      });

      // Layout really did swap …
      expect(await screen.findByText('Enterprise Edition')).toBeInTheDocument();
      // … and the user is still on the button, not dumped at <body>.
      expect(screen.getByRole('button', { name: 'Sign in with OrgSSO' })).toHaveFocus();
      // Same DOM node, not a re-created one: a live region that is remounted
      // alongside its text is exactly what it was hoisted out of the panel to
      // stop being. Node identity is the only assertion that catches that.
      expect(screen.getByTestId('sso-status-announcer')).toBe(announcerBefore);
    });

    // The only outcome a recovered CE backend can produce: `app.ts` serves a
    // fixed { enabled: false, enterpriseRequired: true } stub in community
    // mode. It collapses the notice without producing an SSO button, so
    // keying the focus restore on that button strands the user on <body>.
    it('re-homes focus on the credential form when a recheck resolves SSO away', async () => {
      let oidcCalls = 0;
      vi.mocked(apiFetch).mockImplementation(async (url: string) => {
        const u = String(url);
        if (u.includes('/auth/oidc/config')) {
          oidcCalls += 1;
          if (oidcCalls === 1) throw new Error('Bad Gateway');
          return { enabled: false, issuer: null, name: null, enterpriseRequired: true } as never;
        }
        if (u.includes('/auth/login-page-config')) return { variant: 'local-loop' } as never;
        if (u.includes('/auth/registration-policy')) return { allowRegistration: false } as never;
        throw new Error(`unexpected apiFetch url: ${u}`);
      });

      renderLoginPage();

      const trigger = await screen.findByRole('button', { name: 'Check again' });
      trigger.focus();
      fireEvent.click(trigger);

      // Focus lands in a passive effect, so it can trail the DOM removal by a
      // tick — assert on the focus itself, not on the unmount that precedes it.
      await waitFor(() => expect(screen.getByPlaceholderText('Enter username')).toHaveFocus());
      expect(screen.queryByTestId('sso-probe-failed')).not.toBeInTheDocument();
      expect(screen.queryByTestId('sso-login-btn')).not.toBeInTheDocument();
    });

    it('leaves focus alone when the user has moved to a field mid-recheck', async () => {
      const slowOidc = deferred<Record<string, unknown>>();
      let oidcCalls = 0;
      vi.mocked(apiFetch).mockImplementation(async (url: string) => {
        const u = String(url);
        if (u.includes('/auth/oidc/config')) {
          oidcCalls += 1;
          if (oidcCalls === 1) throw new Error('Bad Gateway');
          return slowOidc.promise as never;
        }
        if (u.includes('/auth/login-page-config')) return { variant: 'local-loop' } as never;
        if (u.includes('/auth/registration-policy')) return { allowRegistration: false } as never;
        throw new Error(`unexpected apiFetch url: ${u}`);
      });

      renderLoginPage();
      fireEvent.click(await screen.findByRole('button', { name: 'Check again' }));

      const usernameInput = screen.getByPlaceholderText('Enter username');
      usernameInput.focus();

      await act(async () => {
        slowOidc.resolve({ enabled: true, issuer: 'https://idp.example.com', name: 'OrgSSO' });
      });

      expect(screen.getByRole('button', { name: 'Sign in with OrgSSO' })).toBeInTheDocument();
      expect(usernameInput).toHaveFocus();
    });
  });

  // ─── edition badge ───────────────────────────────────────────────────────
  // Both editions ship this same SPA, so the badge must come from the backend.
  describe('edition badge', () => {
    it('badges a community backend', async () => {
      mockApi({ edition: 'community' });
      renderLoginPage();
      expect(await screen.findByText('Community Edition · AGPL-3.0')).toBeInTheDocument();
    });

    it('badges an enterprise backend instead of claiming Community Edition', async () => {
      mockApi({ edition: 'enterprise' });
      renderLoginPage();
      expect(await screen.findByText('Enterprise Edition')).toBeInTheDocument();
      expect(screen.queryByText('Community Edition · AGPL-3.0')).not.toBeInTheDocument();
    });

    it('omits the badge when the backend does not report an edition', async () => {
      mockApi({ edition: 'absent' });
      renderLoginPage();
      await waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalled());
      expect(screen.queryByText('Community Edition · AGPL-3.0')).not.toBeInTheDocument();
      expect(screen.queryByText('Enterprise Edition')).not.toBeInTheDocument();
    });

    it('omits the badge when the presentation config cannot be loaded', async () => {
      mockApi({ loginVariant: 'reject' });
      renderLoginPage();
      await waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalled());
      expect(screen.queryByText('Community Edition · AGPL-3.0')).not.toBeInTheDocument();
    });
  });

  describe('configurable presentation', () => {
    it('uses Local Loop by default', () => {
      mockApi();
      renderLoginPage();

      expect(screen.getByRole('heading', { name: 'See the whole knowledge loop.' })).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'One visible path' })).toBeInTheDocument();
    });

    it('switches to Change Desk through the query-string preview override', () => {
      mockApi();
      renderLoginPage('/login?loginVariant=change-desk');

      expect(screen.getByRole('heading', { name: 'Make the page worth finding.' })).toBeInTheDocument();
      expect(screen.getByText('Illustrative workflow preview')).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'See the whole knowledge loop.' })).not.toBeInTheDocument();
    });

    it('uses the deployment-wide runtime setting when there is no preview override', async () => {
      mockApi({ loginVariant: 'change-desk' });
      renderLoginPage();

      expect(
        await screen.findByRole('heading', { name: 'Make the page worth finding.' }),
      ).toBeInTheDocument();
    });

    it('keeps the build default when the runtime setting cannot be loaded', () => {
      mockApi({ loginVariant: 'reject' });
      renderLoginPage();

      expect(screen.getByRole('heading', { name: 'See the whole knowledge loop.' })).toBeInTheDocument();
    });

    it('falls back safely when the preview override is unknown', () => {
      mockApi();
      renderLoginPage('/login?loginVariant=not-a-real-variant');

      expect(screen.getByRole('heading', { name: 'See the whole knowledge loop.' })).toBeInTheDocument();
    });
  });

  it('shows a mapped error toast when redirected back with a known OIDC error code', async () => {
    const { toast } = await import('sonner');
    mockApi({ oidc: { enabled: false, issuer: null, name: null, enterpriseRequired: true } });

    renderLoginPage('/login?error=access_denied');

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith('SSO sign-in was cancelled or denied.');
    });
  });

  it('shows a generic toast (never the raw param) for an unknown OIDC error code', async () => {
    const { toast } = await import('sonner');
    mockApi({ oidc: { enabled: false, issuer: null, name: null, enterpriseRequired: true } });

    renderLoginPage('/login?error=<script>alert(1)</script>');

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        'SSO sign-in failed. Please try again or use local login.',
      );
    });
    const echoedRaw = vi.mocked(toast.error).mock.calls.some((c) => String(c[0]).includes('<script>'));
    expect(echoedRaw).toBe(false);
  });

  it('renders the SSO button when EE omits optional config fields (fails open)', async () => {
    // EE returns only `enabled` + `name`; issuer and enterpriseRequired are absent.
    mockApi({ oidc: { enabled: true, name: 'OrgSSO' } });
    renderLoginPage();
    expect(await screen.findByRole('button', { name: 'Sign in with OrgSSO' })).toBeInTheDocument();
  });

  // ─── #1051 — signup toggle visibility (fail closed) ──────────────────────
  describe('registration policy gating', () => {
    it('does not render the signup toggle when registration is disabled', async () => {
      mockApi({ oidc: 'reject', registration: { allowRegistration: false } });
      renderLoginPage();
      // Give both mount effects a chance to resolve.
      await waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalled());
      expect(screen.queryByRole('button', { name: 'Create one' })).not.toBeInTheDocument();
    });

    it('renders the signup toggle when registration is allowed', async () => {
      mockApi({ oidc: 'reject', registration: { allowRegistration: true } });
      renderLoginPage();
      expect(await screen.findByRole('button', { name: 'Create one' })).toBeInTheDocument();
    });

    it('does not render the signup toggle when the policy fetch fails (fail closed)', async () => {
      mockApi({ oidc: 'reject', registration: 'reject' });
      renderLoginPage();
      await waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalled());
      expect(screen.queryByRole('button', { name: 'Create one' })).not.toBeInTheDocument();
    });
  });

  describe('registration confirm password', () => {
    async function switchToRegister() {
      // The toggle only appears once the (allowed) policy resolves.
      fireEvent.click(await screen.findByRole('button', { name: 'Create one' }));
    }

    it('shows the confirm-password input and the 8-char hint in register mode only', async () => {
      mockApi({ oidc: 'reject', registration: { allowRegistration: true } });
      renderLoginPage();

      // Login mode: neither the confirm field nor the hint is rendered.
      expect(screen.queryByLabelText('Confirm password')).not.toBeInTheDocument();
      expect(screen.queryByText('At least 8 characters')).not.toBeInTheDocument();
      expect(screen.getByLabelText('Username')).not.toHaveAttribute('minlength');
      expect(screen.getByLabelText('Password')).not.toHaveAttribute('minlength');

      await switchToRegister();

      expect(screen.getByLabelText('Confirm password')).toBeInTheDocument();
      expect(screen.getByText('At least 8 characters')).toBeInTheDocument();
      expect(screen.getByLabelText('Username')).toHaveAttribute('minlength', '3');
      expect(screen.getByLabelText('Password')).toHaveAttribute('minlength', '8');
    });

    it('blocks submit and shows an error when the passwords do not match', async () => {
      mockApi({ oidc: 'reject', registration: { allowRegistration: true } });
      renderLoginPage();
      await switchToRegister();

      fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'newuser' } });
      fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password123' } });
      fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'password124' } });
      fireEvent.click(screen.getByRole('button', { name: 'Create Account' }));

      expect(await screen.findByText("Passwords don't match")).toBeInTheDocument();

      // No registration request was fired.
      const registerCall = vi
        .mocked(apiFetch)
        .mock.calls.find(([url]) => String(url).includes('/auth/register'));
      expect(registerCall).toBeUndefined();
    });

    it('clears the mismatch error as soon as the user retypes either password field', async () => {
      mockApi({ oidc: 'reject', registration: { allowRegistration: true } });
      renderLoginPage();
      await switchToRegister();

      fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'newuser' } });
      fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password123' } });
      fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'password124' } });
      fireEvent.click(screen.getByRole('button', { name: 'Create Account' }));

      expect(await screen.findByText("Passwords don't match")).toBeInTheDocument();

      // Correcting the confirm field must dismiss the stale error immediately.
      fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'password123' } });
      expect(screen.queryByText("Passwords don't match")).not.toBeInTheDocument();

      // Same when editing the password field after a fresh mismatch.
      fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'password124' } });
      fireEvent.click(screen.getByRole('button', { name: 'Create Account' }));
      expect(await screen.findByText("Passwords don't match")).toBeInTheDocument();

      fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password124' } });
      expect(screen.queryByText("Passwords don't match")).not.toBeInTheDocument();
    });

    it('submits the registration when the passwords match', async () => {
      mockApi({ oidc: 'reject', registration: { allowRegistration: true } });
      renderLoginPage();
      await switchToRegister();

      fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'newuser' } });
      fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password123' } });
      fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'password123' } });
      fireEvent.click(screen.getByRole('button', { name: 'Create Account' }));

      await waitFor(() => {
        const registerCall = vi
          .mocked(apiFetch)
          .mock.calls.find(([url]) => String(url).includes('/auth/register'));
        expect(registerCall).toBeDefined();
      });
      expect(screen.queryByText("Passwords don't match")).not.toBeInTheDocument();
    });
  });

  describe('credential error recovery', () => {
    async function submitWrongPassword() {
      fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'simon' } });
      fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong' } });
      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    }

    it('reports a wrong password in the panel, not as Session expired', async () => {
      mockApi({ login: { statusCode: 401, message: 'Session expired' } });
      renderLoginPage();
      await submitWrongPassword();

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent("That username and password don't match.");
      expect(alert).toHaveAttribute('id', 'login-error');
      expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
    });

    it('marks both fields invalid, describes them, and returns focus to username', async () => {
      mockApi({ login: { statusCode: 401, message: 'Session expired' } });
      renderLoginPage();
      await submitWrongPassword();

      await screen.findByRole('alert');
      expect(screen.getByLabelText('Username')).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByLabelText('Password')).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByLabelText('Username')).toHaveAttribute('aria-describedby', 'login-error');
      expect(screen.getByLabelText('Password')).toHaveAttribute('aria-describedby', 'login-error');
      expect(screen.getByLabelText('Username')).toHaveFocus();
    });

    it('clears the credential error as soon as the user edits a field', async () => {
      mockApi({ login: { statusCode: 401, message: 'Session expired' } });
      renderLoginPage();
      await submitWrongPassword();
      expect(await screen.findByRole('alert')).toBeInTheDocument();

      fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'retry' } });
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('names a rate limit instead of a generic failure', async () => {
      mockApi({ login: { statusCode: 429, message: 'Too Many Requests' } });
      renderLoginPage();
      await submitWrongPassword();

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Too many attempts. Try again in a few seconds.',
      );
    });

    it('reuses the unreachable wording when the API is down', async () => {
      mockApi({ login: { statusCode: 502, message: 'Bad Gateway' } });
      renderLoginPage();
      await submitWrongPassword();

      expect(await screen.findByRole('alert')).toHaveTextContent('Cannot reach the server');
    });
  });

  describe('operate layout', () => {
    it('puts the auth panel before the pitch in the document', () => {
      mockApi();
      renderLoginPage();
      const panel = screen.getByRole('heading', { name: 'Sign in to Compendiq' });
      const hero = document.getElementById('local-loop-title');
      expect(hero).not.toBeNull();
      expect(panel.compareDocumentPosition(hero!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('keeps the pitch and topology off the small-screen layout', () => {
      mockApi();
      renderLoginPage();
      expect(document.getElementById('local-loop-title')?.closest('section')).toHaveClass('hidden', 'lg:block');
      expect(document.getElementById('topology-title')?.closest('section')).toHaveClass('hidden', 'lg:block');
    });
  });

  describe('instance facts', () => {
    it('says who creates accounts when registration is closed', async () => {
      mockApi({ registration: { allowRegistration: false } });
      renderLoginPage();
      expect(
        await screen.findByText('Accounts are created by your workspace administrator.'),
      ).toBeInTheDocument();
    });

    it('says credentials are the only method when SSO is off', async () => {
      mockApi({ oidc: { enabled: false, issuer: null, name: null, enterpriseRequired: false } });
      renderLoginPage();
      expect(
        await screen.findByText('This workspace signs in with a username and password.'),
      ).toBeInTheDocument();
    });

    it('does not claim credentials-only when SSO is available', async () => {
      mockApi({
        oidc: { enabled: true, issuer: 'https://idp.example.com', name: 'OrgSSO', enterpriseRequired: false },
      });
      renderLoginPage();
      await screen.findByRole('button', { name: 'Sign in with OrgSSO' });
      expect(
        screen.queryByText('This workspace signs in with a username and password.'),
      ).not.toBeInTheDocument();
    });

    it('keeps the edition badge visible at every width', async () => {
      mockApi({ edition: 'enterprise' });
      renderLoginPage();
      const badge = await screen.findByText('Enterprise Edition');
      expect(badge).not.toHaveClass('hidden');
    });
  });

  describe('arrival polish', () => {
    it('focuses the username field on load', async () => {
      mockApi();
      renderLoginPage();
      await waitFor(() => expect(screen.getByLabelText('Username')).toHaveFocus());
    });

    it('does not advertise a shortcut in the username label row', () => {
      mockApi();
      renderLoginPage();
      expect(screen.queryByText(/Press/)).not.toBeInTheDocument();
    });

    it('names the route in the document title', () => {
      mockApi();
      renderLoginPage();
      expect(document.title).toBe('Sign in · Compendiq');
    });

    it('does not paint non-interactive topology labels as links', () => {
      mockApi();
      renderLoginPage();
      expect(screen.getByText('Local and remote paths')).not.toHaveClass('text-primary-ink');
    });
  });

});
