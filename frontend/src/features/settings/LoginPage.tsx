import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  type AppEdition,
  LoginPageConfigResponseSchema,
  OidcConfigSchema,
  RegistrationPolicySchema,
} from '@compendiq/contracts';
import { useAuthStore } from '../../stores/auth-store';
import { apiFetch, ApiError } from '../../shared/lib/api';
import { AuthPanel, type AuthPanelProps } from './login/AuthPanel';
import { ChangeDeskLogin } from './login/ChangeDeskLogin';
import { LocalLoopLogin } from './login/LocalLoopLogin';
import { LoginVariantPicker } from './login/LoginVariantPicker';
import { ssoNoticeCopy, ssoProbeAnnouncement, type OidcProbe } from './login/sso-notice';
import {
  isLoginVariantPickerEnabled,
  resolveLoginVariant,
  type LoginVariant,
} from './login/login-variant';

const OIDC_ERROR_MESSAGES: Record<string, string> = {
  access_denied: 'SSO sign-in was cancelled or denied.',
  login_required: 'SSO sign-in could not be completed. Please try again.',
  interaction_required: 'SSO sign-in could not be completed. Please try again.',
  consent_required: 'Additional consent is required to sign in via SSO.',
  server_error: 'The SSO provider reported an error. Please try again later.',
  temporarily_unavailable: 'SSO is temporarily unavailable. Please try again later.',
};

function credentialErrorCopy(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.statusCode === 401) return "That username and password don't match.";
    if (error.statusCode === 429) return 'Too many attempts. Try again in a few seconds.';
  }
  return ssoNoticeCopy(true).heading;
}

export function LoginPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const setAuth = useAuthStore((state) => state.setAuth);
  const usernameInputRef = useRef<HTMLInputElement>(null);

  const [isRegister, setIsRegister] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [oidcProbe, setOidcProbe] = useState<OidcProbe>({ status: 'pending' });
  const [allowRegistration, setAllowRegistration] = useState(false);
  const [runtimeVariant, setRuntimeVariant] = useState<LoginVariant | null>(null);
  const [edition, setEdition] = useState<AppEdition | null>(null);
  // null until the presentation config has settled once. `false` means an
  // unrelated core route on the same upstream failed too, which is how the
  // panel tells "the API is down" apart from "the SSO route failed".
  const [serverReachable, setServerReachable] = useState<boolean | null>(null);
  // Whether that answer is currently being re-established. The visible heading
  // keeps the last known attribution while a recheck runs (reverting it would
  // show a *longer* wrong state), but the live region waits.
  const [attributionPending, setAttributionPending] = useState(true);
  // Set when the user asks for a recheck, and never cleared: it only licenses
  // the panel to claim focus that its own unmount orphaned. Kept here because
  // a late `variant` response remounts the panel.
  const [focusSsoOnRecovery, setFocusSsoOnRecovery] = useState(false);

  // Both probes can be re-run by the user. Without a generation counter a slow
  // failure that resolves after a newer success would overwrite it — the SSO
  // button would appear and then vanish again on its own.
  const configGeneration = useRef(0);
  const oidcGeneration = useRef(0);
  const registrationGeneration = useRef(0);

  const loginVariant = resolveLoginVariant(
    searchParams,
    runtimeVariant ?? undefined,
  );
  const showVariantPicker = isLoginVariantPickerEnabled();

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        (event.key === '/' || (event.key === 'k' && (event.metaKey || event.ctrlKey))) &&
        document.activeElement?.tagName !== 'INPUT' &&
        document.activeElement?.tagName !== 'TEXTAREA'
      ) {
        event.preventDefault();
        usernameInputRef.current?.focus();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    const previous = document.title;
    document.title = 'Sign in · Compendiq';
    return () => {
      document.title = previous;
    };
  }, []);

  const searchError = searchParams.get('error');

  useEffect(() => {
    if (searchError) return;
    usernameInputRef.current?.focus();
  }, [searchError]);

  useEffect(() => {
    if (!loginError) return;
    usernameInputRef.current?.focus();
  }, [loginError]);

  useEffect(() => {
    if (!searchError) return;

    toast.error(
      OIDC_ERROR_MESSAGES[searchError] ?? 'SSO sign-in failed. Please try again or use local login.',
    );

    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete('error');
    setSearchParams(nextParams, { replace: true });
  }, [searchError, searchParams, setSearchParams]);

  const fetchLoginPageConfig = useCallback(async () => {
    const generation = ++configGeneration.current;
    setAttributionPending(true);
    try {
      const config = LoginPageConfigResponseSchema.parse(
        await apiFetch('/auth/login-page-config'),
      );
      if (generation !== configGeneration.current) return;
      setRuntimeVariant(config.variant);
      setEdition(config.edition ?? null);
      setServerReachable(true);
      setAttributionPending(false);
    } catch {
      // Presentation config must never block sign-in; retain the build
      // default and leave the edition unknown (the badge is then omitted).
      // The failure is still worth recording: this route is unrelated to SSO,
      // so losing it too is what identifies a whole-API outage.
      if (generation !== configGeneration.current) return;
      setServerReachable(false);
      setAttributionPending(false);
    }
  }, []);

  const probeOidcConfig = useCallback(async () => {
    const generation = ++oidcGeneration.current;
    // A recheck stays in the `failed` state so the notice — and the button the
    // user just pressed — survives the round trip. Only the first probe of a
    // page load may render nothing at all.
    setOidcProbe((current) =>
      current.status === 'failed' ? { status: 'failed', retrying: true } : { status: 'pending' },
    );
    try {
      const config = OidcConfigSchema.parse(await apiFetch('/auth/oidc/config'));
      if (generation !== oidcGeneration.current) return;
      setOidcProbe({ status: 'ready', config });
    } catch {
      // A failed probe is NOT "SSO is disabled" — the backend may simply be
      // down (a 502 through nginx takes every /api route with it). Swallowing
      // it into a hidden button makes an outage indistinguishable from the
      // button having been removed, which is exactly how #1187 was misread.
      if (generation !== oidcGeneration.current) return;
      setOidcProbe({ status: 'failed', retrying: false });
    }
  }, []);

  const fetchRegistrationPolicy = useCallback(async () => {
    const generation = ++registrationGeneration.current;
    try {
      const policy = RegistrationPolicySchema.parse(await apiFetch('/auth/registration-policy'));
      if (generation !== registrationGeneration.current) return;
      setAllowRegistration(policy.allowRegistration);
    } catch {
      // Fail closed — on every settle, not just the first. A recheck that
      // cannot reach this route must not leave a stale "yes" on screen.
      if (generation !== registrationGeneration.current) return;
      setAllowRegistration(false);
    }
  }, []);

  // "Check again" re-runs everything this page probes, not just SSO — all
  // three requests died with the same upstream. The presentation config
  // carries the edition badge and the layout variant; the registration policy
  // fails closed, so a deployment that allows sign-up would keep hiding its
  // own "Create one" link until the user reloaded.
  const recheckServerState = useCallback(() => {
    setFocusSsoOnRecovery(true);
    void probeOidcConfig();
    void fetchLoginPageConfig();
    void fetchRegistrationPolicy();
  }, [probeOidcConfig, fetchLoginPageConfig, fetchRegistrationPolicy]);

  useEffect(() => {
    void fetchLoginPageConfig();
  }, [fetchLoginPageConfig]);

  useEffect(() => {
    void probeOidcConfig();
  }, [probeOidcConfig]);

  useEffect(() => {
    void fetchRegistrationPolicy();
  }, [fetchRegistrationPolicy]);

  function handleVariantChange(variant: LoginVariant) {
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set('loginVariant', variant);
    setSearchParams(nextParams, { replace: true });
  }

  function handleModeChange(register: boolean) {
    setIsRegister(register);
    setConfirmPassword('');
    setConfirmError(null);
    setLoginError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (isRegister && !allowRegistration) {
      setLoginError('Registration is disabled');
      return;
    }

    if (isRegister && password !== confirmPassword) {
      setConfirmError("Passwords don't match");
      return;
    }

    setConfirmError(null);
    setLoginError(null);
    setLoading(true);

    try {
      const endpoint = isRegister ? '/auth/register' : '/auth/login';
      const data = await apiFetch<{
        accessToken: string;
        user: { id: string; username: string; role: 'user' | 'admin' };
      }>(endpoint, {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });

      setAuth(data.accessToken, data.user);
      toast.success(isRegister ? 'Account created' : 'Welcome back');
      navigate('/');
    } catch (error) {
      setLoginError(credentialErrorCopy(error));
    } finally {
      setLoading(false);
    }
  }

  const authPanelProps: AuthPanelProps = {
    usernameInputRef,
    isRegister,
    username,
    password,
    confirmPassword,
    showPassword,
    confirmError,
    loginError,
    loading,
    oidcProbe,
    onRetryOidc: recheckServerState,
    serverUnreachable: serverReachable === false,
    focusSsoOnRecovery,
    allowRegistration,
    onUsernameChange: (value) => {
      setUsername(value);
      if (loginError) setLoginError(null);
    },
    onPasswordChange: (value) => {
      setPassword(value);
      if (confirmError) setConfirmError(null);
      if (loginError) setLoginError(null);
    },
    onConfirmPasswordChange: (value) => {
      setConfirmPassword(value);
      if (confirmError) setConfirmError(null);
    },
    onShowPasswordChange: setShowPassword,
    onModeChange: handleModeChange,
    onSubmit: handleSubmit,
  };

  const controls = showVariantPicker ? (
    <LoginVariantPicker value={loginVariant} onChange={handleVariantChange} />
  ) : undefined;
  const authPanel = <AuthPanel {...authPanelProps} />;

  return (
    <>
      {/*
        Outside the variant branch, and mounted from the first render. Both
        matter: a live region is announced when its *contents* change, so one
        inserted together with its text is unreliable — and the two shells are
        different component types, so a late `variant` response remounts
        everything inside the branch, which would re-create this region with
        the text already in it.
      */}
      <div role="status" aria-live="polite" data-testid="sso-status-announcer" className="sr-only">
        {ssoProbeAnnouncement(oidcProbe, serverReachable === false, attributionPending)}
      </div>

      {loginVariant === 'change-desk' ? (
        <ChangeDeskLogin authPanel={authPanel} controls={controls} edition={edition} />
      ) : (
        <LocalLoopLogin authPanel={authPanel} controls={controls} edition={edition} />
      )}
    </>
  );
}
