# AGENTS.md

This file provides guidance to AI coding assistants (GitHub Copilot, Cursor, Windsurf, Cody, etc.) working with this repository.

**All project rules, architecture, and conventions are defined in `CLAUDE.md`.** This file exists as a pointer — the rules are identical across all AI tools. Read and follow `CLAUDE.md` completely.

## Security (Mandatory)

1. **PAT Encryption** — Confluence PATs are encrypted with AES-256-GCM. Never store plaintext PATs. Never send PATs to the frontend.
2. **Zero Default Secrets** — Production MUST fail to start if `JWT_SECRET` or `PAT_ENCRYPTION_KEY` is default or < 32 characters.
3. **LLM Safety** — All user content must be sanitized before sending to Ollama. Sanitize LLM output before displaying.
4. **Input Validation** — Zod schemas on all API boundaries. Parameterized SQL only.
5. **Auth on all routes** — `fastify.authenticate` on every protected endpoint.
6. **Infrastructure Isolation** — Internal services must not be exposed on `0.0.0.0` in production.

## Testing & Mocks

**Mocks are for CI only.** External services (Confluence API, Ollama, Redis) are unavailable in CI:

- **Backend DB tests**: Use real PostgreSQL via `test-db-helper.ts` (port 5433). Never mock the database.
- **Backend route tests**: Mock only external API calls (Confluence, Ollama) and auth. Use `vi.spyOn()` with passthrough mocks.
- **Frontend tests**: Mock API responses, not internal components.
- **Never mock pure utility functions** — test them directly with real inputs.
- **Keep mocks close to the boundary** — mock the HTTP call, not the service function.
