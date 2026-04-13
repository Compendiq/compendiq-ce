# Security Policy

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| 1.0.x   | :white_check_mark: |
| < 1.0   | :x:                |

## Reporting a Vulnerability

**Use [GitHub Security Advisories](https://github.com/Compendiq/compendiq-ce/security/advisories/new) to report vulnerabilities.** This is the sole reporting channel. Do not open a public issue.

GitHub Security Advisories provides a private, encrypted channel between you and the maintainer. Your report stays confidential until a fix is released.

### What to Include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)
- Affected version(s)

### Response Timeline

| Severity | Initial Response | Resolution Target |
|----------|-----------------|-------------------|
| Critical | 24 hours | 72 hours |
| High | 48 hours | 1 week |
| Medium | 1 week | 2 weeks |
| Low | 2 weeks | Next release |

### What to Expect

1. **Acknowledgment** -- confirmation of receipt within the timeframes above.
2. **Assessment** -- severity and impact evaluation.
3. **Fix** -- patch developed and tested.
4. **Disclosure** -- coordinated public disclosure after the fix ships. We follow a 90-day disclosure window.
5. **Credit** -- you will be credited in the release notes unless you prefer anonymity.

## Responsible Disclosure Policy

- Give us reasonable time to address the vulnerability before public disclosure (90 days).
- Do not exploit the vulnerability beyond what is necessary to demonstrate it.
- Do not access or modify other users' data.
- Do not perform denial-of-service attacks.

## Scope

**In scope:**

- Authentication and authorization bypasses
- Data exposure (PATs, passwords, user data)
- SQL injection, XSS, CSRF, SSRF
- Prompt injection leading to data exfiltration
- Privilege escalation
- Cryptographic weaknesses
- Container escape or infrastructure compromise

**Out of scope:**

- Vulnerabilities in third-party dependencies (report to the upstream project)
- Social engineering attacks
- Physical security
- Denial of service through resource exhaustion (rate limiting is in place)
- Issues in the Enterprise Edition (contact us separately via the advisory channel)

## Security Architecture

Compendiq implements defense-in-depth across every layer:

### Authentication & Authorization

- **JWT with rotation** -- short-lived access tokens (15 min) + refresh tokens (7 days) with family-based revocation for reuse detection
- **bcrypt password hashing** with 12 salt rounds
- **RBAC** with custom roles and granular permissions
- **OIDC/SSO** support for enterprise identity providers
- **Rate limiting** -- global (100 req/min) with stricter limits on auth, admin, and LLM endpoints

### Data Protection

- **AES-256-GCM encryption** for Confluence Personal Access Tokens at rest. PATs are never sent to the frontend or logged.
- **Versioned encryption keys** for zero-downtime key rotation
- **Zero default secrets** -- the server refuses to start in production if `JWT_SECRET` or `PAT_ENCRYPTION_KEY` is set to default values or is under 32 characters

### Input Validation & Injection Prevention

- **Zod schema validation** on all API boundaries (shared via `@compendiq/contracts`)
- **Parameterized SQL only** -- no string concatenation in queries
- **SSRF guard** -- user-supplied URLs validated and restricted to configured endpoints
- **Prompt injection guard** -- user content sanitized before sending to LLM providers
- **LLM output sanitization** -- AI responses sanitized before display

### Infrastructure Isolation

- **Docker internal networks** -- PostgreSQL, Redis, and internal services are never exposed on public interfaces
- **TLS support** -- configurable TLS verification for Confluence and LLM connections
- **Custom CA bundle** -- `NODE_EXTRA_CA_CERTS` for environments with self-signed certificates
- **Content Security Policy** -- strict CSP headers on the frontend

## Hardening Checklist

For production deployments:

1. Set `JWT_SECRET` and `PAT_ENCRYPTION_KEY` to unique random strings of 32+ characters
2. Set `NODE_ENV=production` (enforces secret validation at startup)
3. Use strong, unique passwords for PostgreSQL and Redis
4. Do not expose PostgreSQL (5432) or Redis (6379) on public interfaces
5. Use TLS for all external connections (Confluence, LLM providers)
6. Regularly rotate encryption keys using the built-in versioned key rotation
7. Review the audit log in the Admin panel for suspicious activity
8. Keep Compendiq updated -- subscribe to [GitHub releases](https://github.com/Compendiq/compendiq-ce/releases) for security patches
