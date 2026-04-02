# Security Policy

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| 1.0.x   | :white_check_mark: |
| < 1.0   | :x:                |

## Reporting a Vulnerability

If you discover a security vulnerability in Compendiq, please report it responsibly.

### How to Report

**Email:** [security@compendiq.app](mailto:security@compendiq.app)

Include the following in your report:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### Response Timeline

| Severity | Initial Response | Resolution Target |
|----------|-----------------|-------------------|
| Critical | 24 hours | 72 hours |
| High | 48 hours | 1 week |
| Medium | 1 week | 2 weeks |
| Low | 2 weeks | Next release |

We will acknowledge receipt of your report and keep you informed of progress toward a fix.

### What to Expect

1. **Acknowledgment** -- We will confirm receipt of your report within the timeframes above.
2. **Assessment** -- We will evaluate the severity and impact of the vulnerability.
3. **Fix** -- We will develop and test a patch.
4. **Disclosure** -- We will coordinate with you on public disclosure timing.
5. **Credit** -- We will credit you in the release notes (unless you prefer anonymity).

## Responsible Disclosure Policy

- Please give us reasonable time to address the vulnerability before public disclosure.
- Do not exploit the vulnerability beyond what is necessary to demonstrate it.
- Do not access or modify other users' data.
- Do not perform denial-of-service attacks.

## Security Measures

Compendiq implements multiple layers of security:

### Authentication and Authorization

- **JWT authentication** with short-lived access tokens and refresh token rotation
- **bcrypt password hashing** with 12 salt rounds
- **RBAC** with custom roles and granular permissions
- **OIDC/SSO** support for enterprise identity providers
- **Rate limiting** -- global (100 req/min) with stricter limits on admin and LLM endpoints

### Data Protection

- **PAT encryption** -- Confluence Personal Access Tokens are encrypted at rest with AES-256-GCM. PATs are never sent to the frontend or logged.
- **Encryption key rotation** -- Supports versioned encryption keys for zero-downtime rotation.
- **Zero default secrets** -- Server refuses to start in production if `JWT_SECRET` or `PAT_ENCRYPTION_KEY` is default or under 32 characters.

### Input Validation and Injection Prevention

- **Zod schema validation** on all API boundaries (shared via `@compendiq/contracts`)
- **Parameterized SQL only** -- no string concatenation in queries
- **SSRF guard** -- Confluence URLs are validated and restricted to user-configured endpoints
- **Prompt injection guard** -- user content is sanitized before sending to LLM providers
- **LLM output sanitization** -- AI responses are sanitized before display

### Infrastructure

- **Docker internal networks** -- PostgreSQL, Redis, and other internal services are not exposed on public interfaces
- **TLS support** -- configurable TLS verification for Confluence and LLM connections
- **Custom CA bundle support** -- `NODE_EXTRA_CA_CERTS` for self-signed certificates
- **Content Security Policy** -- strict CSP headers on the frontend

## Security Configuration

For production deployments, ensure the following:

1. Set `JWT_SECRET` and `PAT_ENCRYPTION_KEY` to unique random strings of 32+ characters
2. Set `NODE_ENV=production` (enforces secret validation at startup)
3. Use strong passwords for PostgreSQL and Redis
4. Do not expose PostgreSQL (5432) or Redis (6379) on public interfaces
5. Use TLS for all external connections (Confluence, LLM providers)
6. Regularly rotate encryption keys using the versioned key rotation feature
7. Review audit logs in the Admin panel for suspicious activity

## Scope

The following are in scope for security reports:

- Authentication and authorization bypasses
- Data exposure (PATs, passwords, user data)
- SQL injection, XSS, CSRF, SSRF
- Prompt injection leading to data exfiltration
- Privilege escalation
- Cryptographic weaknesses

The following are out of scope:

- Vulnerabilities in third-party dependencies (report these to the upstream project)
- Social engineering attacks
- Physical security
- Denial of service through resource exhaustion (rate limiting is in place)
