# 4. Frontend Structure

Zooms into the `frontend` container. React 19 SPA built with Vite, served
statically in production.

## Provider & feature layout

```mermaid
flowchart TB
    main["main.tsx"]

    subgraph providers["Providers (wrap the app)"]
        direction TB
        rp["RouterProvider"]
        qp["QueryProvider (TanStack Query)"]
        ap["AuthProvider<br/>(session + token refresh)"]
        ep["EnterpriseProvider<br/>GET /api/admin/license → isEnterprise"]
        tp["ThemeProvider"]
    end

    main --> providers
    providers --> app["App.tsx<br/>(routes, SetupRoute gating)"]

    subgraph features["features/ (domain UI)"]
        direction LR
        fAuth["auth/<br/>LoginPage<br/>OidcCallbackPage (EE route)"]
        fDash["dashboard/"]
        fPages["pages/<br/>list · view · new · trash · pinned"]
        fSpaces["spaces/<br/>settings · new"]
        fAI["ai/<br/>AiAssistantPage<br/>(ask / improve / generate / summarize)"]
        fSearch["search/"]
        fKR["knowledge-requests/"]
        fTempl["templates/"]
        fAnalytics["analytics/"]
        fGraph["graph/"]
        fSettings["settings/<br/>user + admin"]
        fAdmin["admin/<br/>LicenseStatusCard<br/>OidcSettingsPage (EE-gated)"]
    end

    app --> features

    subgraph shared["shared/"]
        direction LR
        sEnt["enterprise/<br/>context · loader · types · hook"]
        sComp["components/<br/>layout · article · diagrams ·<br/>badges · feedback · effects"]
        sHooks["hooks/<br/>useSessionInit · useTokenRefreshTimer ·<br/>useThemeEffect · useSetupStatus"]
        sLib["lib/ (api client, utils)"]
    end

    features --> shared

    subgraph stores["stores/ (Zustand)"]
        zAuth["auth"]
        zTheme["theme"]
        zUI["ui"]
        zAV["article-view"]
        zCmd["command-palette"]
        zKb["keyboard-shortcuts"]
    end

    features --> stores

    classDef prov fill:#eef6ff,stroke:#4a90e2
    classDef feat fill:#eefbe8,stroke:#4caf50
    classDef sh fill:#fff4e5,stroke:#e5a23c
    classDef st fill:#f5eafd,stroke:#9b59b6
    class providers,rp,qp,ap,ep,tp prov
    class features,fAuth,fDash,fPages,fSpaces,fAI,fSearch,fKR,fTempl,fAnalytics,fGraph,fSettings,fAdmin feat
    class shared,sEnt,sComp,sHooks,sLib sh
    class stores,zAuth,zTheme,zUI,zAV,zCmd,zKb st
```

## Enterprise gating

The frontend ships **one image** for both CE and EE. Enterprise UI is gated
at runtime:

```mermaid
sequenceDiagram
    participant UI as React app
    participant EP as EnterpriseProvider
    participant API as Backend /api/admin/license

    UI->>EP: mount
    EP->>API: GET /api/admin/license
    API-->>EP: { edition, tier, valid, features, canUpdate? }
    EP->>EP: isEnterprise = (edition !== 'community' && valid)
    EP-->>UI: context { isEnterprise, features }
    UI->>UI: useEnterprise() hides/shows EE surfaces<br/>(OIDC settings, license form, etc.)
```

See [`10-flow-enterprise-license.md`](./10-flow-enterprise-license.md) for
the backend side.

## Styling

- **TailwindCSS 4** with CSS variables for theming (light/dark/custom).
- **Glassmorphic** dashboard aesthetic (ADR-010): `bg-card/80 backdrop-blur-md border-white/10`.
- **Framer Motion** for entrance animations, wrapped in `LazyMotion`;
  all animations respect `prefers-reduced-motion`.
- **Radix UI** primitives for all interactive elements (menus, dialogs,
  tooltips, dropdowns).
