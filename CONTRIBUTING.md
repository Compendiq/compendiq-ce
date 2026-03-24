# Contributing to AtlasMind

Thank you for your interest in contributing to AtlasMind! This guide will help you get started.

## Prerequisites

- **Node.js** >= 22.0.0 (24 recommended)
- **Docker** + **Docker Compose** (for PostgreSQL and Redis)
- **Git**

PostgreSQL 17 (with pgvector) and Redis 8 run via Docker Compose -- no manual installation required.

## Local Development Setup

### 1. Clone the repository

```bash
git clone https://github.com/laboef1900/ai-kb-creator.git
cd ai-kb-creator
```

### 2. Install dependencies

Always install from the repo root (npm workspaces):

```bash
npm install
```

### 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and set `JWT_SECRET` and `PAT_ENCRYPTION_KEY` to random strings of at least 32 characters. The other defaults are suitable for local development.

### 4. Start infrastructure services

```bash
docker compose -f docker/docker-compose.yml up -d
```

This starts PostgreSQL 17 (with pgvector, port 5432) and Redis 8 (port 6379). Database migrations run automatically when the backend starts.

### 5. Start development servers

```bash
npm run dev
```

This starts both the backend (port 3051) and frontend (port 5273) with hot reload.

Open http://localhost:5273 to access AtlasMind. The first registered user automatically gets the admin role.

## Branch Workflow

AtlasMind follows a strict branching model:

```
feature/* --> dev --> main
```

1. **Branch from `dev`** as `feature/<description>` (e.g., `feature/add-export-csv`)
2. **PRs must target `dev`**, never `main` directly
3. Only `dev -> main` merges are allowed to target `main`
4. Never push directly to `main`

## Making Changes

### Code Style

- **TypeScript strict mode** -- no `any` types unless absolutely necessary
- **ESLint** -- flat config in each workspace, run `npm run lint` before committing
- **Readability first** -- explicit over clever, descriptive variable names
- **Zod validation** -- use schemas from `@atlasmind/contracts` on all API boundaries
- **Parameterized SQL only** -- never use string concatenation for queries

### Testing

Every change requires tests:

```bash
# Run all tests (contracts + backend + frontend)
npm test

# Backend tests only (uses real PostgreSQL on port 5433)
npm run test -w backend

# Frontend tests only (jsdom environment)
npm run test -w frontend

# Single test file
cd backend && npx vitest run src/path/file.test.ts

# E2E tests (requires running backend + frontend)
npm run test:e2e
```

Backend tests use a real PostgreSQL database (port 5433, configured via `POSTGRES_TEST_URL`). Only external API calls (Confluence, Ollama) should be mocked in tests -- never mock the database or pure utility functions.

### Type Checking

```bash
npm run typecheck
```

## Pull Request Checklist

Before submitting a PR, verify:

- [ ] All tests pass (`npm test`)
- [ ] Type checking passes (`npm run typecheck`)
- [ ] Linting passes (`npm run lint`)
- [ ] Documentation is updated if needed (`docs/`, `.env.example`, `CLAUDE.md`)
- [ ] No secrets committed (`.env`, API keys, PATs, passwords)
- [ ] PR targets `dev`, not `main`
- [ ] Commit messages are concise and describe "why", not "what"

## Project Structure

| Directory | Purpose |
|-----------|---------|
| `backend/src/core/` | Shared infrastructure (no domain imports) |
| `backend/src/domains/` | Domain business logic (confluence, llm, knowledge) |
| `backend/src/routes/` | API route handlers grouped by domain |
| `frontend/src/features/` | Domain-grouped UI components |
| `frontend/src/shared/` | Reusable components, hooks, utilities |
| `packages/contracts/` | Shared Zod schemas + TypeScript types |
| `docker/` | Docker Compose files (dev + production) |
| `docs/` | Architecture decisions and guides |

### Domain Boundary Rules

Import restrictions are enforced by ESLint (`eslint-plugin-boundaries`):

- **core** -- no domain or route imports
- **confluence** -- can import core + llm
- **llm** -- can import core only
- **knowledge** -- can import core + llm + confluence
- **routes** -- can import core + own domain (knowledge routes can access all domains)

## Security

- Never commit `.env` files, API keys, PATs, or passwords
- Confluence PATs must be encrypted with AES-256-GCM (never stored in plaintext)
- All user content sent to LLMs must be sanitized (prompt injection guard)
- All API inputs must be validated with Zod schemas
- Use parameterized SQL only (no string concatenation)

## AI-Assisted Development

This project includes a `CLAUDE.md` file with detailed instructions for AI coding assistants. If you use Claude Code or similar tools, they will automatically pick up these guidelines.

## Architecture Decisions

All architectural decisions are documented in `docs/ARCHITECTURE-DECISIONS.md`. Please review relevant ADRs before making structural changes, and propose new ADRs for significant architectural changes.

## License

By contributing to AtlasMind, you agree that your contributions will be licensed under the [GNU Affero General Public License v3.0](LICENSE).
