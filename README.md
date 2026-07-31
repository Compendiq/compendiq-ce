<p align="center">
  <img src="frontend/public/logo.svg" alt="Compendiq Logo" width="120" height="120" />
</p>

<h1 align="center">Compendiq</h1>

<p align="center">
  <strong>The Open-Source, Privacy-First AI Knowledge Engine for Confluence Data Center</strong><br />
  <em>Self-hosted. Air-gapped ready. Zero data leaves your network.</em>
</p>

<p align="center">
  <a href="https://github.com/Compendiq/compendiq-ce/actions/workflows/pr-check.yml"><img src="https://img.shields.io/github/actions/workflow/status/Compendiq/compendiq-ce/pr-check.yml?branch=main&style=for-the-badge&logo=github&label=CI" alt="CI Status" /></a>
  <a href="https://www.gnu.org/licenses/agpl-3.0"><img src="https://img.shields.io/badge/License-AGPL_v3-blue.svg?style=for-the-badge&logo=gnu&logoColor=white" alt="License: AGPL v3" /></a>
  <a href="https://github.com/Compendiq/compendiq-ce/releases"><img src="https://img.shields.io/github/v/release/Compendiq/compendiq-ce?style=for-the-badge&logo=git&logoColor=white&label=Release" alt="Release" /></a>
  <a href="https://github.com/Compendiq/compendiq-ce/discussions"><img src="https://img.shields.io/github/discussions/Compendiq/compendiq-ce?style=for-the-badge&logo=github&label=Discussions" alt="Discussions" /></a>
</p>

<p align="center">
  <a href="#-quick-install-in-3-minutes"><b>⚡ Quickstart</b></a> &nbsp;&bull;&nbsp;
  <a href="#-key-features"><b>✨ Features</b></a> &nbsp;&bull;&nbsp;
  <a href="#-why-compendiq"><b>💡 Why Compendiq?</b></a> &nbsp;&bull;&nbsp;
  <a href="#-architecture"><b>🏗️ Architecture</b></a> &nbsp;&bull;&nbsp;
  <a href="docs/USER-GUIDE.md"><b>📚 User Guide</b></a> &nbsp;&bull;&nbsp;
  <a href="docs/integrations/README.md"><b>🔌 Integrations</b></a> &nbsp;&bull;&nbsp;
  <a href="#-community-vs-enterprise"><b>🏢 Enterprise</b></a> &nbsp;&bull;&nbsp;
  <a href="SECURITY.md"><b>🔒 Security</b></a>
</p>

---

> [!IMPORTANT]
> **Stop losing knowledge in stagnant Confluence pages.**  
> Compendiq connects directly to your **Confluence Data Center** instance, syncs your entire workspace, and unleashes hyper-intelligent local AI superpowers — answer complex technical questions across your knowledge base, improve articles in 1 click, auto-generate runbooks & SOPs, and detect critical documentation gaps. All running on hardware **you control**.

---

## ⚡ Quick Install in 3 Minutes

Deploy the complete enterprise stack (Frontend, Fastify API, PostgreSQL 17 + pgvector, Redis 8) with a single command:

```bash
curl -fsSL https://raw.githubusercontent.com/Compendiq/compendiq-ce/main/scripts/install.sh | bash
```

> **Requirements:** Linux / macOS with Docker Engine 24+ & Compose v2, 4 GB RAM, port `8081` available. For local AI inference, [Ollama](https://ollama.ai) running on the host.

### 📥 Model Setup
Once installed, pull your embedding model and chat model via Ollama:

```bash
ollama pull bge-m3          # Required: Embeddings (1024 dimensions)
ollama pull qwen3:4b        # Fast local chat model (or model of your choice)
```

<details>
<summary><strong>🔍 Under the Hood: What the Automated Installer Does</strong></summary>

1. **Cryptographic Security**: Generates high-entropy `JWT_SECRET` and `PAT_ENCRYPTION_KEY` (AES-256-GCM, 32+ chars).
2. **Environment Configuration**: Writes `~/compendiq/docker-compose.yml` with isolated secrets.
3. **Container Orchestration**: Fetches verified images from `ghcr.io/compendiq/compendiq-ce-*`.
4. **Services Initialized**: Spins up 4 core services: Frontend (nginx), Backend (Fastify 5), PostgreSQL 17 (pgvector), and Redis 8.
5. **Health Check & Launch**: Polls the readiness probe and opens `http://localhost:8081` setup wizard.

</details>

<details>
<summary><strong>⚙️ Custom Install Directory & Remote GPU Hosts</strong></summary>

```bash
# Install to custom directory
INSTALL_DIR=~/mydir curl -fsSL https://raw.githubusercontent.com/Compendiq/compendiq-ce/main/scripts/install.sh | bash

# Connect to a remote GPU server for Ollama
OLLAMA_BASE_URL=http://gpu-server:11434 curl -fsSL https://raw.githubusercontent.com/Compendiq/compendiq-ce/main/scripts/install.sh | bash
```

</details>

<details>
<summary><strong>🗑️ Uninstalling</strong></summary>

```bash
bash ~/compendiq/uninstall.sh
```
*Stops containers, purges docker volumes, and safely removes the installation directory.*

</details>

---

## 💡 Why Compendiq?

| Feature / Capability | Traditional Confluence | Cloud AI SaaS Tools | **Compendiq (CE)** |
| :--- | :---: | :---: | :---: |
| **On-Premise Data Center Support** | ⚠️ Native (No AI) | ❌ Cloud Only | ✅ **Full Native Sync** |
| **Zero Data Egress / Air-Gapped** | ✅ | ❌ Data leaves network | ✅ **100% On-Premise (Ollama)** |
| **Hybrid Vector + Keyword Search** | ❌ (Keyword only) | ⚠️ Basic Vector | ✅ **pgvector + FTS + RRF** |
| **Confluence Macro Round-Trip** | ✅ | ❌ Formats break | ✅ **Full XHTML Macro Parity** |
| **Knowledge Gap & Audit Engine** | ❌ | ❌ | ✅ **Automated AI Audits** |
| **Open Source & Extensible** | ❌ | ❌ Proprietary | ✅ **AGPL-3.0 Open Core** |

---

## ✨ Key Features

### 🧠 1. Intelligent RAG Q&A Across Your Knowledge Base
Ask natural language questions and receive accurate, cited answers synthesized from across your Confluence spaces.
* **Hybrid Search Engine**: Combines pgvector cosine similarity, PostgreSQL Full-Text Keyword Search, and Reciprocal Rank Fusion (RRF).
* **Real-time SSE Streaming**: Ultra-fast Server-Sent Events streaming with interactive source citations and deep links back to original pages.

### 🪄 2. 1-Click Document Superpowers
* **AI Article Enhancement**: Fix grammar, restructure layouts, expand technical depth, or adjust tone instantly.
* **Template Generator**: Instantly author standard runbooks, how-to guides, architecture decisions (ADRs), and troubleshooting matrixes.
* **Summarization & Tagging**: Generate concise executive summaries and automated LLM tag classifications.
* **Duplicate & Gap Detection**: Automatically identify duplicated documentation and missing operational guides.

### 🔌 3. Native Confluence Data Center Compatibility
* **Bi-directional Sync**: Continuous background synchronization keeping Compendiq in lockstep with Confluence.
* **XHTML Storage Format Preservation**: Perfect round-trip support for code blocks, task lists, info/warning panels, user mentions, page links, attachments, and draw.io diagrams.

### 📝 4. Power-User Modern Editor
* Built on **TipTap v3 (ProseMirror)** with Vim keybindings, drag-and-drop block reordering, find & replace, image/table captions, header auto-numbering, automatic language syntax detection, and clipboard image pasting.

---

## 🛠️ Complete Feature Matrix

| Category | Highlights & Capabilities |
| :--- | :--- |
| **Editor** | TipTap v3, Vim mode, drag-and-drop blocks, header numbering, code auto-highlighting, direct image paste |
| **AI & RAG** | Multi-provider LLM (Ollama, OpenAI-compatible APIs), pgvector hybrid RAG, SSE streaming, knowledge gap analysis |
| **Security & Access** | AES-256-GCM PAT encryption, JWT with refresh rotation, RBAC, OIDC/SSO (Enterprise), SSRF protection |
| **Analytics & Insights** | Page engagement metrics, search trend analytics, interactive knowledge graph visualization |
| **Operations** | PDF import/export, page verification workflows, OpenTelemetry tracing, BullMQ background job queues, SMTP alerts |

---

## 🏗️ Architecture

Compendiq is engineered for enterprise reliability, high concurrency, and low latency.

```
                     ┌──────────────────────────────────────────┐
                     │ Confluence Data Center (XHTML Storage)   │
                     └────────────────────┬─────────────────────┘
                                          │ REST API v1 (Bearer PAT)
                                          v
                     ┌──────────────────────────────────────────┐
                     │  Backend (Fastify 5 + TS + Node.js 22)   │
                     ├──────────────────────────────────────────┤
                     │ • BullMQ Worker Queue (Sync/AI/Summary)  │
                     │ • Content Converter (XHTML <-> HTML <-> MD)│
                     │ • Embedding Engine (1024d Vectors)       │
                     │ • RAG Search (pgvector + FTS + RRF)      │
                     │ • LLM Queue & Backpressure Controller     │
                     └─────────────┬──────────────────┬─────────┘
                                   │                  │
            ┌──────────────────────┴┐                ┌┴──────────────────────┐
            │ PostgreSQL 17 + pgvector│                │    Redis 8 Cache      │
            └───────────────────────┘                └───────────────────────┘
                                   │                  │
                                   v                  v
                     ┌──────────────────────────────────────────┐
                     │ Frontend (React 19 + Vite + Tailwind 4)  │
                     ├──────────────────────────────────────────┤
                     │ • TipTap v3 Editor + Macro Renderer      │
                     │ • Real-time AI Assistant (SSE Streaming) │
                     │ • Glassmorphic UI (Radix + Framer Motion)│
                     └──────────────────────────────────────────┘
```

### 🧰 Tech Stack Overview

- **Frontend**: React 19, Vite 8, TailwindCSS 4, Radix UI, Zustand, TanStack Query, Framer Motion
- **Backend**: Fastify 5, Node.js 22+, TypeScript, BullMQ Queue System
- **Database & Storage**: PostgreSQL 17 with `pgvector`, Redis 8 Cache
- **AI Infrastructure**: Ollama (Local) or OpenAI-compatible APIs (`bge-m3` 1024d embeddings)
- **Editor Core**: TipTap v3 / ProseMirror

---

## 🏢 Community Edition vs Enterprise

Compendiq Community Edition is **100% free and open-source under AGPL-3.0** with **zero artificial resource limits**.

| Capability | Community Edition (Free) | Enterprise Edition (Paid) |
| :--- | :---: | :---: |
| **Confluence Sync + AI Q&A + Generation** | ✅ Included | ✅ Included |
| **pgvector Hybrid Search (Vector + FTS + RRF)** | ✅ Included | ✅ Included |
| **Multi-Provider LLM Support (Ollama, OpenAI, Azure, vLLM)** | ✅ Included | ✅ Included |
| **TipTap v3 Rich Text Editor with Confluence Macros** | ✅ Included | ✅ Included |
| **PDF Import & Export** | ✅ Included | ✅ Included |
| **Role-Based Access Control (RBAC)** | ✅ Included | ✅ Included |
| **Audit Logging & Security Controls** | ✅ Included | ✅ Included |
| **OIDC / SAML SSO Integration** | ── | ✅ **Enterprise** |
| **Per-Space RAG Fine-Grained Permissions** | ── | ✅ **Enterprise** |
| **Exportable Compliance Audit Logs** | ── | ✅ **Enterprise** |
| **Dedicated SLA & Priority Engineering Support** | ── | ✅ **Enterprise** |

👉 **Interested in Enterprise?** [Open an Enterprise Request](https://github.com/Compendiq/compendiq-ce/issues/new?template=enterprise-interest.md), consult the [Stewardship Guide](docs/STEWARDSHIP.md), or start a conversation on [GitHub Discussions](https://github.com/Compendiq/compendiq-ce/discussions).

---

## 💻 Developer Quick Start

<details>
<summary><strong>🛠️ Full Local Development Setup</strong></summary>

### 1. Clone Repository
```bash
git clone https://github.com/Compendiq/compendiq-ce.git
cd compendiq-ce
npm install
```

### 2. Configure Environment
```bash
cp .env.example .env
# Edit .env and supply required secrets (JWT_SECRET, PAT_ENCRYPTION_KEY, POSTGRES_PASSWORD, REDIS_PASSWORD)
```

### 3. Launch Local Infrastructure
```bash
cp .env docker/.env
docker compose -f docker/docker-compose.yml up -d
```

### 4. Run Development Servers
```bash
npm run dev   # Fastify Backend (3051) + Vite Frontend (5273) with HMR
```

Open `http://localhost:5273` in your browser. The initial account created automatically inherits the Admin role.

</details>

<details>
<summary><strong>🧪 Test Suite & Verification</strong></summary>

```bash
npm test                          # Run all unit & integration tests
npm run test -w backend           # Backend test suite (requires Postgres on 5433)
npm run test -w frontend          # Frontend DOM tests (jsdom)
npm run test:e2e                  # End-to-end tests (Playwright)
npm run lint                      # ESLint check
npm run typecheck                 # Strict TypeScript compilation check
```

</details>

---

## ⚙️ Configuration Reference

Maintained through environment variables:

| Variable | Required | Description |
| :--- | :---: | :--- |
| `JWT_SECRET` | **Yes** | Secret for signing JWT authentication tokens (32+ chars) |
| `PAT_ENCRYPTION_KEY` | **Yes** | AES-256-GCM encryption key for Confluence Personal Access Tokens |
| `POSTGRES_URL` | Optional | Connection string (`postgresql://user:pass@host:5432/db`) |
| `REDIS_URL` | Optional | Redis connection URI (`redis://:pass@host:6379`) |
| `OLLAMA_BASE_URL` | Seed-only | Initial base URL for Ollama host (default: `http://localhost:11434`) |
| `CONFLUENCE_VERIFY_SSL` | Optional | Set to `false` when connecting to self-signed TLS Confluence hosts |

<details>
<summary><strong>📋 Complete Environment Variables Table</strong></summary>

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `JWT_SECRET` | ── | JWT signing secret (32+ chars) |
| `PAT_ENCRYPTION_KEY` | ── | AES-256-GCM secret key (32+ chars) |
| `POSTGRES_USER` | `kb_user` | Database user |
| `POSTGRES_PASSWORD` | ── | Database password |
| `POSTGRES_DB` | `kb_creator` | Database name |
| `POSTGRES_URL` | `postgresql://kb_user:<password>@localhost:5432/kb_creator` | Connection string |
| `REDIS_PASSWORD` | ── | Redis auth password |
| `REDIS_URL` | `redis://:<password>@localhost:6379` | Redis connection URI |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Deprecated seed-only setting for Ollama host |
| `LLM_VERIFY_SSL` | `true` | Enforce SSL verification for LLM endpoints |
| `LLM_STREAM_TIMEOUT_MS` | `300000` | SSE stream timeout limit (ms) |
| `LLM_CACHE_TTL` | `3600` | TTL in seconds for LLM response cache |
| `SYNC_INTERVAL_MIN` | `15` | Polling schedule interval for Confluence sync |
| `NODE_ENV` | `development` | Runtime environment (`development` / `production`) |
| `OTEL_ENABLED` | `false` | Toggle OpenTelemetry instrumentation |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | ── | OTLP collector endpoint |

</details>

---

## 🌐 Enterprise Deployment Topologies

Deploy in demanding corporate enterprise environments:
* 🛡️ [**Behind a Reverse Proxy**](docs/integrations/reverse-proxy/nginx.md) – Nginx / Traefik / Caddy TLS termination and SSE buffering.
* 🔐 [**Self-Signed & Custom CA Certificates**](docs/integrations/self-signed-tls/README.md) – Trust custom corporate PKI CA bundles via `NODE_EXTRA_CA_CERTS`.
* 📦 [**Air-Gapped / Disconnected Environments**](docs/integrations/air-gapped/README.md) – Side-load container images and run offline.

Explore all architecture patterns in [`docs/integrations/README.md`](docs/integrations/README.md).

---

## 🤝 Contributing & Security

- **Contributing**: Check out our [Contributing Guidelines](CONTRIBUTING.md) to get started!
- **Security Policy**: Please review [SECURITY.md](SECURITY.md) to report vulnerabilities privately via GitHub Security Advisories.
- **Roadmap**: Track upcoming features and development phases in [`docs/ROADMAP.md`](docs/ROADMAP.md).

---

<p align="center">
  Built with precision for privacy-conscious teams.<br />
  ⭐ <strong>If Compendiq empowers your organization, <a href="https://github.com/Compendiq/compendiq-ce">star the repo</a> to support open-source AI!</strong>
</p>
