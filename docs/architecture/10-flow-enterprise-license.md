# 10. Enterprise License Flow (Open-Core)

Compendiq ships as an open-core product. CE (this repo) defines the plugin
contract, a noop stub, and the UI surfaces for license management. EE is
published privately as `@compendiq/enterprise` and implements the real
plugin. See `docs/ENTERPRISE-ARCHITECTURE.md` for the full design.

## Boot-time plugin load

```mermaid
sequenceDiagram
    autonumber
    participant I as backend/src/index.ts
    participant A as app.ts
    participant L as core/enterprise/loader.ts
    participant NOOP as noop plugin
    participant EE as @compendiq/enterprise<br/>(optional)
    participant F as Fastify
    participant DB as admin_settings
    participant ENV as env: COMPENDIQ_LICENSE_KEY

    I->>A: buildApp()
    A->>L: loadEnterprisePlugin()
    L->>L: dynamic import('@compendiq/enterprise')
    alt EE installed
        L-->>A: EE plugin instance
        A->>F: decorate license + enterprise
        A->>EE: registerRoutes(fastify)
        EE->>DB: SELECT value FROM admin_settings WHERE key='license_key'
        alt DB row present
            DB-->>EE: licenseKey
        else absent
            EE->>ENV: read COMPENDIQ_LICENSE_KEY (deprecated fallback)
        end
        EE->>EE: verify Ed25519 signature<br/>parse tier/seats/expiry/licenseId
        EE->>F: set app.license = { edition, tier, valid, features, ... }
        Note over EE: Registers PUT/GET /api/admin/license<br/>and feature-gated routes (OIDC, etc.)
    else EE not installed
        L-->>A: noopPlugin
        A->>F: decorate license = { edition:'community', valid:true, features:[] }
        A->>F: register CE fallback GET /api/admin/license<br/>(only when version === 'community')
    end
    I->>F: listen()
```

## Runtime license update (EE only)

```mermaid
sequenceDiagram
    autonumber
    participant Admin as Browser (admin UI)
    participant FE as LicenseStatusCard
    participant BE as PUT /api/admin/license (EE route)
    participant DB as admin_settings
    participant F as app.license (cache)

    Admin->>FE: paste license key
    FE->>BE: PUT /api/admin/license { key }
    BE->>BE: verify Ed25519 signature
    alt invalid
        BE-->>FE: 400 { valid:false, reason }
    else valid
        BE->>DB: UPSERT admin_settings(key='license_key', value=key)
        BE->>F: refresh in-memory license (no restart)
        BE-->>FE: 200 { edition, tier, features, displayKey, canUpdate:true }
        FE->>FE: enter enterprise mode (reload or<br/>re-fetch via EnterpriseProvider)
    end
```

## GET /api/admin/license response shape

| Mode | Response |
|------|----------|
| **CE (noop)** | `{ edition:'community', tier:'community', valid:true, features:[] }` |
| **EE valid**  | `{ edition:'enterprise', tier:'business'\|'enterprise', valid:true, features:[...], displayKey, licenseId, canUpdate:true }` |
| **EE invalid / expired** | `{ edition:'enterprise', valid:false, reason:'expired', canUpdate:true }` |

The frontend uses `canUpdate` to decide whether to render the key-entry
form; CE omits the flag.

## License key format

```
ATM-{tier}-{seats}-{expiryYYYYMMDD}-{licenseId}.{ed25519SignatureBase64url}
```

- **v2** includes `{licenseId}`; **v1** is accepted for backwards compat.
- Signed with an Ed25519 key pair — the public key is compiled into the
  EE plugin; the private key is held by the vendor.
- Persisted in the `admin_settings` table under key `license_key`.
- The `COMPENDIQ_LICENSE_KEY` env var is a **deprecated bootstrap
  fallback** — consulted only when the DB row is absent.

## Frontend gating recap

```mermaid
flowchart LR
    boot(["App mount"]) --> fetch[["GET /api/admin/license"]]
    fetch --> decide{edition !== 'community'<br/>AND valid}
    decide -- yes --> ee["isEnterprise = true<br/>→ show OIDC tab,<br/>license form, EE features"]
    decide -- no  --> ce["isEnterprise = false<br/>→ CE UI only"]
```

CE and EE ship the **same frontend image**. There is no IIFE bundle, no
build-time patch, no separate EE SPA. All gating happens at runtime via
`useEnterprise()`.

## Key files (CE side)

| File | Purpose |
|------|---------|
| `backend/src/core/enterprise/types.ts` | `EnterprisePlugin`, `LicenseInfo`, Fastify augmentation |
| `backend/src/core/enterprise/features.ts` | `ENTERPRISE_FEATURES` constants |
| `backend/src/core/enterprise/noop.ts` | Inert CE stub |
| `backend/src/core/enterprise/loader.ts` | Dynamic import + fallback |
| `backend/src/core/types/compendiq-enterprise.d.ts` | Type declaration for the optional EE package |
| `backend/src/routes/foundation/admin.ts` | CE fallback `GET /api/admin/license` |
| `frontend/src/shared/enterprise/context.tsx` | `EnterpriseProvider` |
| `frontend/src/shared/enterprise/use-enterprise.ts` | `useEnterprise()` hook |
| `frontend/src/features/admin/LicenseStatusCard.tsx` | Admin UI for the license |
| `frontend/src/features/admin/OidcSettingsPage.tsx` | EE-gated OIDC config UI |
| `frontend/src/features/auth/OidcCallbackPage.tsx` | EE-gated OIDC callback handler |
| `docker/Dockerfile.enterprise` | Multi-stage Dockerfile template for EE builds |
