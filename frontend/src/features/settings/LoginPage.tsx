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
import { apiFetch } from '../../shared/lib/api';
import { AuthPanel, type AuthPanelProps, type OidcProbe } from './login/AuthPanel';
import { ChangeDeskLogin } from './login/ChangeDeskLogin';
import { LocalLoopLogin } from './login/LocalLoopLogin';
import { LoginVariantPicker } from './login/LoginVariantPicker';
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
  const [loading, setLoading] = useState(false);
  const [oidcProbe, setOidcProbe] = useState<OidcProbe>({ status: 'pending' });
  const [allowRegistration, setAllowRegistration] = useState(false);
  const [runtimeVariant, setRuntimeVariant] = useState<LoginVariant | null>(null);
  const [edition, setEdition] = useState<AppEdition | null>(null);

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
    const searchError = searchParams.get('error');
    if (!searchError) return;

    toast.error(
      OIDC_ERROR_MESSAGES[searchError] ?? 'SSO sign-in failed. Please try again or use local login.',
    );

    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete('error');
    setSearchParams(nextParams, { replace: true });
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    async function fetchLoginPageConfig() {
      try {
        const config = LoginPageConfigResponseSchema.parse(
          await apiFetch('/auth/login-page-config'),
        );
        setRuntimeVariant(config.variant);
        setEdition(config.edition ?? null);
      } catch {
        // Presentation config must never block sign-in; retain the build
        // default and leave the edition unknown (the badge is then omitted).
      }
    }

    void fetchLoginPageConfig();
  }, []);

  const probeOidcConfig = useCallback(async () => {
    setOidcProbe({ status: 'pending' });
    try {
      const config = OidcConfigSchema.parse(await apiFetch('/auth/oidc/config'));
      setOidcProbe({ status: 'ready', config });
    } catch {
      // A failed probe is NOT "SSO is disabled" — the backend may simply be
      // down (a 502 through nginx takes every /api route with it). Swallowing
      // it into a hidden button makes an outage indistinguishable from the
      // button having been removed, which is exactly how #1187 was misread.
      setOidcProbe({ status: 'failed' });
    }
  }, []);

  useEffect(() => {
    void probeOidcConfig();
  }, [probeOidcConfig]);

  useEffect(() => {
    async function fetchRegistrationPolicy() {
      try {
        const policy = RegistrationPolicySchema.parse(await apiFetch('/auth/registration-policy'));
        setAllowRegistration(policy.allowRegistration);
      } catch {
        // Fail closed.
      }
    }

    void fetchRegistrationPolicy();
  }, []);

  function handleVariantChange(variant: LoginVariant) {
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set('loginVariant', variant);
    setSearchParams(nextParams, { replace: true });
  }

  function handleModeChange(register: boolean) {
    setIsRegister(register);
    setConfirmPassword('');
    setConfirmError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (isRegister && !allowRegistration) {
      toast.error('Registration is disabled');
      return;
    }

    if (isRegister && password !== confirmPassword) {
      setConfirmError("Passwords don't match");
      return;
    }

    setConfirmError(null);
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
      toast.error(error instanceof Error ? error.message : 'Authentication failed');
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
    loading,
    oidcProbe,
    onRetryOidc: () => void probeOidcConfig(),
    allowRegistration,
    onUsernameChange: setUsername,
    onPasswordChange: (value) => {
      setPassword(value);
      if (confirmError) setConfirmError(null);
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

  return loginVariant === 'change-desk' ? (
    <ChangeDeskLogin authPanel={authPanel} controls={controls} edition={edition} />
  ) : (
    <LocalLoopLogin authPanel={authPanel} controls={controls} edition={edition} />
  );
}
