# Compendiq API Reference

Compendiq provides a RESTful API built on Fastify 5 with auto-generated interactive documentation.

## Interactive API Documentation

The backend serves interactive Swagger UI documentation at:

```
http://localhost:3051/api/docs
```

This is the primary API reference. It is auto-generated from route schemas using `@fastify/swagger` and `@fastify/swagger-ui`, and is always up to date with the running server.

## Authentication

All endpoints except `/api/health` and `/api/auth/*` require a valid JWT Bearer token.

Include the token in the `Authorization` header:

```
Authorization: Bearer <access-token>
```

Access tokens are obtained via the login endpoint and have a configurable expiry (default: 1 hour). Use the refresh endpoint to obtain new access tokens without re-authenticating.

## API Groups

| Prefix | Description |
|--------|-------------|
| `GET /api/health` | Health checks (live, ready, start probes) |
| `POST /api/auth/*` | Authentication (register, login, refresh, logout) |
| `GET/PUT /api/settings` | User settings (Confluence URL, PAT, model selection) |
| `GET/POST/PUT/DELETE /api/pages/*` | Page CRUD, versions, tags, embeddings, duplicates, export/import |
| `GET /api/spaces` | Confluence space listing and selection |
| `POST /api/sync` | Manual sync trigger |
| `POST /api/llm/*` | LLM operations (improve, generate, summarize, ask, PDF extract) |
| `GET /api/embeddings/status` | Embedding pipeline status |
| `GET/POST /api/templates/*` | Knowledge base templates |
| `GET/POST /api/comments/*` | Page comments |
| `GET /api/analytics/*` | Content analytics and search analytics |
| `GET/POST /api/verification/*` | Page verification/review workflow |
| `GET/POST /api/knowledge-requests/*` | Knowledge gap requests |
| `GET/POST /api/notifications/*` | User notifications |
| `GET/POST /api/admin/*` | Admin operations (key rotation, audit log, LLM settings, OIDC, RBAC) |

## Example Requests

### Health Check

```bash
curl http://localhost:3051/api/health
```

Response:

```json
{
  "status": "ok",
  "services": {
    "postgres": true,
    "redis": true,
    "llm": true
  },
  "llmProvider": "ollama",
  "circuitBreakers": {
    "ollama": "closed",
    "openai": "closed"
  },
  "version": "1.0.0",
  "uptime": 3600.123
}
```

### Register a User

```bash
curl -X POST http://localhost:3051/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "username": "admin",
    "email": "admin@example.com",
    "password": "your-secure-password"
  }'
```

Response:

```json
{
  "user": {
    "id": "uuid",
    "username": "admin",
    "email": "admin@example.com",
    "role": "admin"
  },
  "accessToken": "eyJhbG...",
  "refreshToken": "eyJhbG..."
}
```

### Login

```bash
curl -X POST http://localhost:3051/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "username": "admin",
    "password": "your-secure-password"
  }'
```

### Refresh Token

```bash
curl -X POST http://localhost:3051/api/auth/refresh \
  -H "Content-Type: application/json" \
  -d '{
    "refreshToken": "eyJhbG..."
  }'
```

### List Pages

```bash
curl http://localhost:3051/api/pages \
  -H "Authorization: Bearer <access-token>"
```

### Get a Page

```bash
curl http://localhost:3051/api/pages/<page-id> \
  -H "Authorization: Bearer <access-token>"
```

### Search Pages

```bash
curl "http://localhost:3051/api/search?q=deployment&mode=hybrid" \
  -H "Authorization: Bearer <access-token>"
```

### Readiness Probe (for Kubernetes / Docker)

```bash
curl http://localhost:3051/api/health/ready
```

Response:

```json
{
  "status": "ok",
  "services": {
    "postgres": true,
    "redis": true
  },
  "version": "1.0.0",
  "uptime": 3600.123
}
```

## Rate Limiting

The API enforces rate limiting:

- **Global:** 100 requests per minute per IP
- **Admin endpoints:** stricter limits
- **LLM endpoints:** stricter limits (due to resource intensity)

Exceeding the rate limit returns `429 Too Many Requests`.

## Error Responses

Errors follow a consistent format:

```json
{
  "statusCode": 400,
  "error": "Bad Request",
  "message": "Description of what went wrong"
}
```

Common status codes:

| Code | Meaning |
|------|---------|
| `400` | Bad Request -- invalid input |
| `401` | Unauthorized -- missing or invalid token |
| `403` | Forbidden -- insufficient permissions |
| `404` | Not Found |
| `429` | Too Many Requests -- rate limited |
| `500` | Internal Server Error |
| `503` | Service Unavailable -- dependency down |
