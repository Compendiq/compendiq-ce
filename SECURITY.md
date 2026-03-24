# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.x     | Yes                |

## Reporting a Vulnerability

**Please do NOT open a public GitHub issue for security vulnerabilities.**

If you discover a security vulnerability in AtlasMind, please report it responsibly:

1. **Email**: Send details to the repository owner via GitHub private messaging or the contact methods listed on their profile.
2. **GitHub Security Advisories**: Use [GitHub's private vulnerability reporting](https://github.com/laboef1900/ai-kb-creator/security/advisories/new) to submit a report directly.

### What to include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### Response timeline

- **Acknowledgment**: Within 48 hours
- **Initial assessment**: Within 1 week
- **Fix release**: Depends on severity; critical issues are prioritized

## Security Measures

AtlasMind implements the following security measures:

- **PAT Encryption**: Confluence Personal Access Tokens are encrypted at rest with AES-256-GCM
- **JWT Authentication**: Access tokens (15min) with refresh token rotation and reuse detection
- **Password Hashing**: bcrypt with 12 salt rounds
- **Input Validation**: Zod schemas on all API boundaries; parameterized SQL only
- **Rate Limiting**: Global rate limiting with stricter limits on sensitive endpoints
- **SSRF Protection**: URL validation for Confluence connections
- **Prompt Injection Guard**: User content sanitization before LLM processing
- **Production Secret Enforcement**: Server refuses to start with default or weak secrets

See the [README](README.md#security) for more details.
