# Integration Guides

_Last updated: 2026-04-24_

The `install.sh` quickstart assumes the easiest deployment shape — a reachable Confluence DC on a vanilla HTTPS URL with a public CA cert and unrestricted outbound internet. Real on-prem customers usually run one of three more interesting shapes. This directory documents each one end-to-end.

## Pick your guide

| Your environment looks like… | Guide |
|--|--|
| Compendiq behind corporate nginx (TLS termination, path routing, auth pass-through) | [`reverse-proxy/nginx.md`](./reverse-proxy/nginx.md) |
| Compendiq behind Traefik v3 (Docker Swarm / Compose, label-driven routing, auto-TLS) | [`reverse-proxy/traefik.md`](./reverse-proxy/traefik.md) |
| Compendiq behind Caddy (auto-TLS, minimal config) | [`reverse-proxy/caddy.md`](./reverse-proxy/caddy.md) |
| Confluence DC (or the LLM upstream) uses a self-signed or private-CA cert | [`self-signed-tls/README.md`](./self-signed-tls/README.md) |
| No outbound internet access at all (air-gapped / disconnected) | [`air-gapped/README.md`](./air-gapped/README.md) |

The shapes compose — you can run Compendiq **behind a reverse proxy, with a private-CA Confluence, and no internet egress** all at once. Read the relevant guides in order (reverse-proxy first, then TLS, then air-gapped).

## Conventions

Each guide ships with:

- **Who this is for** — a one-paragraph user story.
- **Architecture sketch** — a Mermaid diagram.
- **Prerequisites** — what you need before starting.
- **Step-by-step** — copy-pasteable commands.
- **Configuration reference** — the exact `.env` vars that matter, with example values.
- **Troubleshooting** — the top things that go wrong.
- **Verification** — how to confirm it's working.

Every guide carries a `_last-verified: YYYY-MM-DD_` stamp at the top. If the stamp is older than ~90 days, assume configuration has drifted and double-check against `.env.example`.

## Found a bug or a missing case?

Open an issue tagged [`integration-guide`](https://github.com/Compendiq/compendiq-ce/issues?q=label%3Aintegration-guide). Pull requests with tested examples from your real environment are especially welcome — they save the next customer the same hours of debugging.
