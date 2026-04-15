# 7. Auth & Login Flow

Compendiq supports two auth modes:

1. **Local credentials** — default in CE. Bcrypt + JWT with refresh tokens.
2. **OIDC SSO** — Enterprise Edition only, gated by
   `ENTERPRISE_FEATURES.OIDC_SSO`.

## Local login (CE + EE)

```mermaid
sequenceDiagram
    autonumber
    participant B as Browser
    participant FE as Frontend (SPA)
    participant BE as Backend /api/auth
    participant DB as Postgres
    participant RL as Redis (rate-limit)

    B->>FE: submit username / password
    FE->>BE: POST /api/auth/login
    BE->>RL: check rate-limit bucket
    alt over limit
        RL-->>BE: 429
        BE-->>FE: 429 Too Many Requests
    else ok
        BE->>DB: SELECT password_hash FROM users
        DB-->>BE: hash
        BE->>BE: bcrypt.compare()
        alt mismatch
            BE-->>FE: 401
        else match
            BE->>BE: generateAccessToken() (HS256, 15m)
            BE->>BE: generateRefreshToken() (7d)
            BE->>DB: INSERT refresh_tokens
            BE->>DB: INSERT audit_log (login_success)
            BE-->>FE: 200 { accessToken }<br/>Set-Cookie: refreshToken (httpOnly)
        end
    end

    FE->>FE: store accessToken in memory
    Note over FE: useTokenRefreshTimer<br/>schedules silent refresh
    FE->>BE: POST /api/auth/refresh (cookie sent)
    BE->>DB: validate refresh_tokens row
    BE-->>FE: 200 { accessToken (new) }
```

### Registration quirks

- `POST /api/auth/register` is rate-limited (5/min).
- **The first successful registration creates an admin.** Subsequent
  registrations create regular users. This transition is atomic
  (single `INSERT … RETURNING role` guarded by a transaction).
- Registration may be disabled by an admin setting (`admin_settings`
  key) once the initial user is created.

### Logout

`POST /api/auth/logout` deletes the refresh token row, clears the cookie,
and records `audit_log(action='logout')`. The access token is short-lived
enough that blacklisting is not needed in CE; EE may add it.

## OIDC flow (Enterprise Edition)

Routes registered only when the EE plugin is loaded **and**
`ENTERPRISE_FEATURES.OIDC_SSO` is enabled in the loaded license.

```mermaid
sequenceDiagram
    autonumber
    participant B as Browser
    participant FE as Frontend
    participant BE as Backend (EE plugin)
    participant IDP as OIDC Provider

    B->>FE: click "Sign in with SSO"
    FE->>BE: GET /auth/oidc/start?provider=okta
    BE->>BE: generate PKCE verifier + state
    BE-->>B: 302 → IdP /authorize
    B->>IDP: login (browser-driven)
    IDP-->>B: 302 → /auth/oidc/callback?code=…&state=…
    B->>BE: GET /auth/oidc/callback
    BE->>IDP: POST /token (exchange code)
    IDP-->>BE: id_token + access_token
    BE->>BE: verify signature + claims
    BE->>BE: upsert users (auth_provider='oidc', oidc_sub)
    BE->>BE: issue short-lived login_code
    BE-->>B: 302 → /auth/oidc/callback?login_code=…
    B->>FE: OidcCallbackPage.tsx loads
    FE->>BE: POST /api/auth/oidc/exchange { login_code }
    BE-->>FE: 200 { accessToken } + refreshToken cookie
    FE->>FE: enter app (AuthProvider hydrated)
```

Why the extra hop via a `login_code`? It keeps tokens out of the URL
fragment that the browser exposes to history/referer. The callback page
posts to a JSON endpoint and only then receives the real JWT.

## Where this lives

| Concern | File |
|---------|------|
| JWT plugin, decorators | `backend/src/core/plugins/auth.ts` |
| Routes (register / login / refresh / logout) | `backend/src/routes/foundation/auth.ts` |
| OIDC routes (EE only) | `@compendiq/enterprise` (loaded via `core/enterprise/loader.ts`) |
| Frontend session init | `frontend/src/shared/hooks/useSessionInit.ts` |
| Refresh timer | `frontend/src/shared/hooks/useTokenRefreshTimer.ts` |
| OIDC callback UI | `frontend/src/features/auth/OidcCallbackPage.tsx` |
| OIDC admin config UI | `frontend/src/features/admin/OidcSettingsPage.tsx` |
