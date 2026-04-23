# Disabling external dependencies for air-gapped deploys

_last-verified: TBD (draft ships with v0.4; founder VM test pending)_

Compendiq's default configuration trusts it has internet access. This reference lists every outbound dependency and how to neutralise it so the stack runs clean inside an air-gapped network.

## Backend

### OpenTelemetry (off by default — verify)

```env
OTEL_ENABLED=false
# The next two are ignored when OTEL_ENABLED is false, but set them
# anyway so a future reviewer can't accidentally flip OTEL_ENABLED=true
# and start leaking spans to an unreachable collector.
OTEL_EXPORTER_OTLP_ENDPOINT=
```

### LLM providers

By default the first-boot code seeds an `llm_providers` row for Ollama (always local). If you also seeded a row for Azure / OpenAI during an earlier test run, delete it from Settings → LLM before running disconnected:

```sql
DELETE FROM llm_providers WHERE base_url ~ '(openai\.com|azure\.com)';
```

After the first boot, the seed-only env vars (`OPENAI_BASE_URL`, `OPENAI_API_KEY`) have no effect. Leaving them unset is still the cleanest configuration.

### Email / SMTP

Compendiq's SMTP client only connects when a user or worker triggers an outbound email. Pointing it at an internal relay is fine:

```env
SMTP_HOST=smtp.corp.example.com
SMTP_PORT=587
SMTP_USER=compendiq-notifier
SMTP_PASS=...
SMTP_FROM=compendiq-notifier@corp.example.com
SMTP_ENABLED=true
```

If you have no internal mail server, leave `SMTP_ENABLED=false` and notifications degrade to in-app only.

### Package-manager probes

Production images never call npm / apt — images are frozen at build time. Double-check by tailing backend logs for `registry.npmjs.org` or `deb.debian.org`:

```bash
docker compose logs backend | grep -E "registry\.npmjs|deb\.debian" || echo "(clean)"
```

`(clean)` is the expected output.

## Frontend

### Update checks

The frontend bundle does not ship an automatic update-check. Nothing to disable.

### Analytics

No third-party analytics are bundled. Nothing to disable.

### CDNs

All fonts, icons, and runtime libraries are self-hosted inside the frontend image. No CDN lookups are issued at runtime. The draw.io webapp is also bundled into the image (see `frontend/Dockerfile`'s draw.io stage).

## MCP docs service

`mcp-docs` is a separate sidecar that fetches documentation from internet sources. For an air-gapped deploy, **comment it out entirely** in `docker/docker-compose.yml`:

```yaml
# services:
#   mcp-docs:
#     image: ghcr.io/compendiq/compendiq-ce-mcp-docs:<version>
#     ...
```

Compendiq runs fine without it — the doc-lookup features gracefully degrade to "not configured".

## SearXNG (optional)

SearXNG is included in the default compose for the web-search feature. Its default engines list includes Google / Bing / etc. which all need internet. For air-gapped:

- Either **disable SearXNG** entirely (comment out the service), or
- **Configure SearXNG to query only internal engines** (a self-hosted Elasticsearch, etc.). The SearXNG admin docs cover this; nothing Compendiq-specific beyond pointing at the internal engine.

## What's left after all of this?

The only remaining outbound connections in a properly-disabled deployment are:

1. **Compendiq backend → Confluence DC** (the customer's own instance — same network usually)
2. **Compendiq backend → Ollama** (same host or internal network)
3. **Compendiq backend → SMTP relay** (if enabled)

Any other outbound connection is a bug — file an issue tagged `air-gapped` with the destination and stack trace.

## Verification

Run the stack idle for 60 seconds, then:

```bash
# Any connection from the backend container to anywhere but the three
# targets above is suspicious. Adjust the grep filter for your internal IPs.
sudo ss -tnp | grep $(docker inspect -f '{{.State.Pid}}' compendiq-backend-1) \
    | awk '{print $5}' | sort -u
```

Expected output: your Ollama IP, your Confluence IP, and optionally your SMTP IP. Nothing else.
