# Real-Time Collaborative Document Editing (Yjs + TipTap + WebSocket + Redis)

## 1. Executive Summary & Objective

Compendiq currently provides **real-time co-presence indicators** (issue #301) via Server-Sent Events (SSE) and Redis (`presence:viewers:{pageId}`), displaying ghost avatar stacks in the page header and an "editing" pencil badge. However, document editing itself remains **strictly single-user with pessimistic/optimistic version locking**:
- When User A and User B enter edit mode on the same page, each edits a local draft in isolation.
- The first user to save bumps `pages.version`.
- When the second user attempts to save, `PUT /api/pages/:id` triggers a `409 Conflict` ("Version conflict detected — Page has been modified since you loaded it"). The second user must reload and manually reconcile lost changes.

### Objective
Enable **concurrent real-time collaborative editing** where multiple authenticated users with write permissions can simultaneously edit the same document. Collaborators will see real-time character-by-character edits, live cursor positions, selections, and user identity tags without version lockouts or data clobbering.

---

## 2. Current Architecture vs. Target Architecture

```mermaid
flowchart TD
    subgraph Current ["Current Architecture (Single-User Lock)"]
        U1[User A Browser] -->|SSE Presence Stream| P_API[GET /api/pages/:id/presence]
        U2[User B Browser] -->|SSE Presence Stream| P_API
        U1 -.->|PUT /api/pages/:id (v1 -> v2)| DB1[(PostgreSQL)]
        U2 -.->|PUT /api/pages/:id (v1 -> 409 Conflict)| DB1
    end

    subgraph Target ["Target Architecture (Real-Time CRDT Collaboration)"]
        C1[User A TipTap Editor] <-->|WebSocket / Yjs Sync| WS_GW[Fastify / Hocuspocus WS Gateway]
        C2[User B TipTap Editor] <-->|WebSocket / Yjs Sync| WS_GW
        WS_GW <-->|Redis Pub/Sub (Cross-Pod Sync)| REDIS[(Redis Cluster)]
        WS_GW -->|Debounced Snapshots & State Storage| DB2[(PostgreSQL - page_collaborative_docs)]
        WS_GW -.->|On Save / Publish| CONF[Confluence DC REST API]
    end
```

---

## 3. Technology Evaluation & Research

### 3.1 CRDT vs. Operational Transformation (OT)
- **Operational Transformation (OT)** (e.g., Google Docs legacy): Requires a centralized server to order all operations. Complex to maintain, brittle with custom rich-text nodes.
- **CRDT (Conflict-free Replicated Data Type)** (e.g., Yjs, Automerge): Operations are mathematically commutative and converge deterministically on all peers without a centralized transform lock. Local-first, resilient to latency and offline disconnects.
- **Decision**: **Yjs** is the industry standard for rich-text editors and is the native collaboration backend of **TipTap / ProseMirror**.

### 3.2 Backend Collaboration Server Comparison

| Solution | Self-Hosted / Air-Gapped | ProseMirror / TipTap Support | Multi-Pod Scalability (Redis) | Complexity & Maintenance |
| :--- | :--- | :--- | :--- | :--- |
| **Hocuspocus** (TipTap native) | ✅ 100% MIT / Open Source | ✅ First-party TipTap integration | ✅ Built-in `@hocuspocus/extension-redis` | **Low** (purpose-built hooks: auth, load, store, awareness) |
| **Embedded Fastify WebSocket** (`@fastify/websocket` + `y-protocols`) | ✅ 100% Self-Hosted | ✅ Full via `y-protocols` | ⚠️ Custom Redis pub/sub relay needed | **Medium** (requires building custom WS connection pool & debounce persistence) |
| **y-websocket standalone** | ✅ 100% Self-Hosted | ✅ Generic Yjs | ⚠️ Limited multi-pod support out-of-the-box | **Medium** (requires external auth proxy) |
| **Liveblocks / TipTap Cloud** | ❌ Proprietary SaaS | ✅ Yes | ❌ Managed Cloud | ❌ Disqualified by Compendiq on-premise requirement |

**Recommendation**: **Hocuspocus server** integrated either as a Fastify plugin/handler or standalone co-process within the backend container, leveraging Compendiq's existing Redis for multi-pod pub/sub and PostgreSQL for document persistence.

---

## 4. Key Architectural Considerations & Invariants

### 4.1 Access Control & Authorization (RBAC)
1. **Handshake Verification**:
   - WebSocket connections authenticate via JWT bearer token (via subprotocol header `access_token` or query param on initial upgrade).
2. **Permission Check Matrix**:
   - **Standalone Pages**:
     - *Edit Permission*: Allowed if `user.id === page.created_by_user_id` OR `page.visibility === 'shared'` OR user has `admin` / space-write role.
     - *Read-Only Viewer*: Allowed to connect in read-only mode (receives document sync & awareness, but mutation messages are rejected server-side).
   - **Confluence DC Synced Pages**:
     - Verify user has space access via `getUserAccessibleSpaces(userId)`.
   - **Revocation / Trash**: If page is deleted/trashed (`deleted_at IS NOT NULL`), active WebSocket rooms are terminated immediately.

### 4.2 Handling Dual Page Sources (Standalone vs. Confluence Synced)

1. **Standalone Local Pages**:
   - Yjs binary state (`bytea`) is stored in a new `page_collaborative_docs` table.
   - Background snapshot worker debounces and serializes Yjs state to HTML (`body_html`) and plain text (`body_text`) in `pages` for full-text search (FTS) and vector embeddings.
2. **Confluence DC Synced Pages**:
   - Confluence DC REST API only supports full document updates (`storageBody` XHTML format).
   - During live editing sessions in Compendiq, concurrent users edit the live Yjs CRDT session.
   - When users click **Save & Sync** or when all editors disconnect:
     - The Yjs document is converted to Confluence Storage Format XML (`htmlToConfluence`).
     - The snapshot is pushed to Confluence DC via `client.updatePage(confluenceId, title, storageBody, version)`.
   - **External Confluence Conflict Detection**: If Confluence DC is edited externally while a Compendiq collaborative session is active, Compendiq detects the version delta on sync and flags a non-destructive merge alert.

### 4.3 Database Schema Migration

```sql
-- New table for persisting Yjs binary document state
CREATE TABLE page_collaborative_docs (
    page_id INTEGER PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
    doc_state BYTEA NOT NULL,
    state_vector BYTEA,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_page_collaborative_docs_updated ON page_collaborative_docs(updated_at);
```

### 4.4 UI/UX & Awareness Design (ADR-010 Graphite / Paper)

- **TipTap Collaboration Extensions**:
  - `@tiptap/extension-collaboration`: Binds ProseMirror state to Yjs `XmlFragment`.
  - `@tiptap/extension-collaboration-cursor`: Renders remote carets and selection highlights.
- **Cursor Palette & Contrast Invariants**:
  - Remote cursors assign deterministic colors based on `userId`.
  - Cursor label chips use `--color-background` text over high-contrast border colors that comply with WCAG 1.4.11 (3:1) in both **Graphite** (dark) and **Paper** (light) themes.
- **Presence Header Unification**:
  - Unify the existing `PresenceAvatarStack` with Yjs Awareness data so that active editors and viewers are rendered synchronously.

### 4.5 Reverse Proxy & Ingress Compatibility
Update `frontend/nginx.conf` and documentation for external proxies (nginx, Traefik, Caddy) to handle WebSocket upgrades:
```nginx
# WebSocket reverse proxy for real-time collaboration
location ^~ /api/collab/ {
    proxy_pass $backend_upstream;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "Upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
```

---

## 5. Implementation Roadmap

- **Phase 1: Backend Infrastructure & Persistence**
  - DB Migration for `page_collaborative_docs`.
  - WebSocket gateway with JWT authentication and RBAC authorization.
  - Redis pub/sub cross-pod distribution.
  - Document initialization from legacy `body_html` and debounced snapshot storage.

- **Phase 2: Frontend Integration**
  - Integrate `@tiptap/extension-collaboration` and `@tiptap/extension-collaboration-cursor` into `Editor.tsx`.
  - Wire WebSocket provider connection in `PageViewPage.tsx`.
  - Style collaborator cursors and selection overlays for Graphite/Paper themes.

- **Phase 3: Confluence Sync & Conflict Resolution**
  - Hook collaborative commit into `client.updatePage` on Confluence DC.
  - Implement external modification alerts.

- **Phase 4: Testing & Verification**
  - Vitest integration tests for multi-pod Redis sync.
  - E2E Playwright test simulating two concurrent browser sessions editing the same paragraph, list, and table.
