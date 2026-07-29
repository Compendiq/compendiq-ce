# 4. Frontend Structure

Zooms into the `frontend` container. React 19 SPA built with Vite, served
statically in production.

## Provider & feature layout

```mermaid
flowchart TB
    main["main.tsx"]

    subgraph providers["Providers (wrap the app)"]
        direction TB
        qp["QueryClientProvider (TanStack Query)"]
        rp["BrowserRouter"]
        ep["EnterpriseProvider<br/>GET /api/admin/license → isEnterprise"]
    end

    main --> providers
    providers --> app["App.tsx<br/>(routes, SetupRoute gating;<br/>session + token refresh + theme via<br/>useSessionInit · useTokenRefreshTimer · useThemeEffect)"]

    subgraph features["features/ (domain UI)"]
        direction LR
        fAuth["auth/<br/>OidcCallbackPage (EE route)"]
        fPages["pages/<br/>list · view · new · trash · pinned<br/>bulk actions · 404 catch-all<br/>RelocateDialog (#1123)"]
        fSpaces["spaces/<br/>settings · new"]
        fAI["ai/<br/>AiAssistantPage (/ai — no-document home)<br/>dock/ AiDock · DockPanel · AiDockSheet · DockDiffCard (#1126)<br/>column beside /pages/:id, sheet over it below md"]
        fGraph["graph/"]
        fSettings["settings/<br/>LoginPage · user + admin"]
        fAdmin["admin/<br/>LicenseStatusCard<br/>OidcSettingsPage (EE-gated)<br/>analytics/ (AnalyticsPage)"]
    end

    app --> shell["AppLayout (authenticated shell)<br/>mounts AiProvider above the routes (#1126):<br/>conversations keyed by page and retained,<br/>inert until an AI surface consumes it"]
    shell --> features

    subgraph shared["shared/"]
        direction LR
        sEnt["enterprise/<br/>context · loader · types · hook"]
        sComp["components/<br/>layout · article · diagrams · badges ·<br/>banners (TrialBanner · ConfluencePatBanner #771) ·<br/>feedback · effects ·<br/>upload/ DocumentUploadZone — Generate + dock (#1131)"]
        sHooks["hooks/<br/>useSessionInit · useTokenRefreshTimer ·<br/>useThemeEffect · useSetupStatus"]
        sLib["lib/ (api client, utils)"]
    end

    features --> shared

    subgraph stores["stores/ (Zustand)"]
        zAuth["auth"]
        zTheme["theme"]
        zUI["ui (persisted)"]
        zAV["article-view<br/>read-only mirrors"]
        zDock["ai-dock (ephemeral)"]
        zCmd["command-palette"]
        zKb["keyboard-shortcuts"]
    end

    features --> stores

    classDef prov fill:#eef6ff,stroke:#4a90e2
    classDef feat fill:#eefbe8,stroke:#4caf50
    classDef sh fill:#fff4e5,stroke:#e5a23c
    classDef st fill:#f5eafd,stroke:#9b59b6
    class providers,qp,rp,ep,shell prov
    class features,fAuth,fPages,fSpaces,fAI,fGraph,fSettings,fAdmin feat
    class shared,sEnt,sComp,sHooks,sLib sh
    class stores,zAuth,zTheme,zUI,zAV,zDock,zCmd,zKb st
```

## Article route panels (#1126)

On `/pages/:id` the shell renders three siblings in one flex row, so each
panel scrolls independently and the editor column shrinks around them rather
than having anything float above it.

```mermaid
flowchart LR
    main["main<br/>[data-scroll-container]<br/>PageViewPage · TipTap"]
    rail["ArticleRightPane<br/>280px pane ⇄ 40px rail<br/>outline flyout on hover/focus"]
    dock["AiDock<br/>~420px, resizable<br/>chips + composer + inline diff"]

    main --- rail --- dock
```

- Opening the dock **ORs** the pane into its rail; it never writes the user's
  persisted `articleSidebarCollapsed`. `.` closes the dock while it is open,
  so the key is never dead.
- Below `min-width: 1100px` (`useIsDockWideLayout`) the rail is not rendered
  and the dock is capped narrower. That query and `useIsMobileLayout` below are
  the app's only JS *width* queries — `use-can-hover` and three one-shot checks
  read `matchMedia` for pointer and motion capability, but every other
  responsive layout decision is a Tailwind class.
- Below `md` (`useIsMobileLayout`) there is no right side to dock into, so
  `AiDock` swaps containers: `AiDockSheet` renders the same `DockPanel` as a
  drag-to-expand bottom sheet over the article, the way the left sidebar
  already becomes a slide-over there. Two detents (52% / 92% of the viewport),
  dragged with a hand-rolled Pointer Events handler because the app's
  `LazyMotion features={domAnimation}` excludes framer's `drag` feature bundle.
  Unlike the column, the sheet **is** modal — backdrop, `aria-modal`, Tab trap
  — because it occludes the document rather than sitting beside it.
- `Apply` on a proposed change goes through **`POST /llm/improvements/apply`**,
  not a client-side write into the editor. That route runs `protectMedia` /
  `restoreMedia` (#723) and the column-layout realignment that returns **422**
  when the layout is unrecoverable (#781). Those guards live in
  `backend/src/core/services/content-converter.ts` and have no frontend
  counterpart, so a client-side Markdown→HTML round-trip would silently strip
  Confluence macros and media — see
  [`11-content-pipeline.md`](./11-content-pipeline.md). What the dock changes
  is *where the decision happens* — inline in the thread, beside the document —
  not how it is applied. Consequently Apply is unavailable while the editor is
  open: it rewrites the saved page, which an open editor would overwrite on its
  next save. `article-view` therefore stays a set of read-only mirrors.
- `/ai` keeps only the Ask and Generate tabs. The four document actions are
  dock chips; their mode screens still render for `?mode=…` deep links (which
  `SidebarTreeView` and old bookmarks still produce), but nothing offers them.

## Relocating an article across the Confluence boundary (#1123)

`RelocateDialog` (`features/pages/`) is the only surface that moves a page
between `source: 'standalone'` and `source: 'confluence'`. Its entry point is a
single control in the article action strip, gated on
`usePermission('pages:relocate')` and **hidden** when denied — CE ships no UI
for granting permissions, so a denied user has no in-product path to earning
one, and the preview endpoint is gated on the same permission.

```mermaid
sequenceDiagram
    participant D as RelocateDialog
    participant Q as useRelocatePreview
    participant API as /api/pages/:id/relocate

    D->>Q: open (no destination)
    Q->>API: GET …/preview
    API-->>Q: counts + generic access prose, empty principal lists
    D->>Q: user picks spaceKey / visibility
    Q->>API: GET …/preview?spaceKey=… | ?visibility=…
    API-->>Q: accessChange naming real principals (capped, `truncated`)
    D->>API: POST …/relocate  (echoes localVersionCount /<br/>confirmDeleteConfluencePage; 409 on a stale echo)
```

- The preview is a **dependent query** keyed on the destination, not a manual
  refetch. Only the → Confluence direction sends `spaceKey`: the route
  authorises a caller-supplied space key against the user's role-assigned
  *Confluence* spaces (it feeds a membership enumeration), so a local space key
  would 403 for a non-admin.
- Changing the destination **clears the acknowledgements**, and so does the
  409 "reload preview" recovery — a still-ticked box would otherwise re-confirm
  a roster or a version count the user never saw.
- Backend contract and transactional guarantees:
  [`03-backend-domains.md`](./03-backend-domains.md),
  `backend/src/domains/knowledge/services/page-relocate-service.ts`. Design of
  record: `docs/superpowers/specs/2026-07-29-relocate-dialog-design.md`.

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

- **TailwindCSS 4** with CSS variables for theming. Two themes ship —
  **Slate Steel** (dark, default, navy `#0E1220`) and **Frost Steel** (light,
  `#F4F6FA`) — a cool slate-and-steel system in one hue family, with steel
  (`#6EA8FF` / `#2F6BD8`) as the single brand and interaction accent, amber
  reserved for warning/attention, and violet for AI ornament (operable
  things stay steel). Both themes are gradient-lit via `--surface-backdrop`,
  `--surface-card` and `--surface-card-elevated`. Those are background
  *images*, so a `hover:bg-*` utility on a card surface is a silent no-op —
  use `nm-card-hover`. See ADR-010 v0.5 for the palette, and v0.4
  for the neumorphic surface rationale and the migration away from the
  v0.3-era glassmorphic surfaces. This palette replaces the Graphite Honey /
  Honey Linen pair and no longer mirrors the landing page's honey tokens.
- **Two border weights, split by role.** `--color-border` is the quiet
  hairline for separators, panes and prose rules;
  `--color-border-interactive` is the visible edge of anything operable and
  is measured ≥3:1 against every surface it lands on (WCAG 1.4.11). The
  neumorphic recipe leans on shadow for depth, and forced-colors mode
  discards shadow — this border is what survives.
- **Neumorphic** surface system (ADR-010 v0.4): sixteen `nm-*` `@utility`
  classes (`nm-card`, `nm-card-elevated`, `nm-card-interactive`,
  `nm-card-hover`, `nm-toolbar`, `nm-sidebar`, `nm-header`, `nm-pill-active`,
  `nm-button-primary`, `nm-button-destructive`, `nm-button-ghost`,
  `nm-icon-button`, `nm-composer`, `nm-input`, `nm-select`, `nm-select-md`)
  built on theme-tinted shadow recipes plus a mandatory 1px solid border
  for visibility under WCAG 1.4.11 and `forced-colors: active`.
- **Framer Motion** for entrance animations, wrapped in `LazyMotion`;
  all animations respect `prefers-reduced-motion`.
- **Radix UI** primitives for all interactive elements (menus, dialogs,
  tooltips, dropdowns).
