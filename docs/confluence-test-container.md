# Confluence test container

A real Confluence Data Center 9.2 instance for integration-testing the sync
pipeline locally. Compose file: `docker/docker-compose.confluence.yml`
(project `compendiq-confluence`: Confluence + its own Postgres 16).

## Start / stop

```bash
# The compose file expects the shared backend network to exist
docker network inspect compendiq_backend-net >/dev/null 2>&1 \
  || docker network create compendiq_backend-net

docker compose -f docker/docker-compose.confluence.yml up -d
# First boot takes several minutes (2 GB JVM). Ready when:
curl -fsS http://localhost:8090/status   # {"state":"FIRST_RUN"} → setup, {"state":"RUNNING"} → ready

docker compose -f docker/docker-compose.confluence.yml down      # keep data
docker compose -f docker/docker-compose.confluence.yml down -v   # wipe data
```

## One-time setup (fresh volume)

The container preconfigures the database via `ATL_*` env vars, so the wizard
only asks for a license, deployment type, and an admin account:

1. Open <http://localhost:8090> → license entry. Use an Atlassian **timebomb
   license for Data Center** (developer.atlassian.com → "Timebomb licenses
   for testing Data Center apps" → "10 user Confluence Data Center license,
   expires in 3 hours"). Copy the key exactly — strip line breaks only.
   After the 3 h expiry the instance keeps running but locks editing; paste a
   fresh timebomb under ⚙ → General Configuration → License Details, or wipe
   the volume and redo setup.
2. Deployment type: **Non-clustered (single node)** → Empty Site →
   "Manage users and groups within Confluence".
3. Admin account: username `admin`, email `admin@compendiq.local`, and a
   throwaway dev-only password of your choice. Record it in the gitignored
   `docker/.env` so the seeding commands below can read it (and so it never
   lands in the repo or your shell history):

   ```bash
   echo 'CONFLUENCE_ADMIN_PASSWORD=<the password you typed>' >> docker/.env
   ```

## Seed test content + PAT (REST)

```bash
source docker/.env
AUTH="admin:${CONFLUENCE_ADMIN_PASSWORD}"
# Space
curl -fsS -u "$AUTH" -X POST http://localhost:8090/rest/api/space \
  -H 'Content-Type: application/json' \
  -d '{"key":"TEST","name":"Compendiq Sync Test"}'
# Page with code block + task list (exercises the content pipeline)
curl -fsS -u "$AUTH" -X POST http://localhost:8090/rest/api/content \
  -H 'Content-Type: application/json' -d '{
    "type":"page","title":"Code and Tasks Sample","space":{"key":"TEST"},
    "body":{"storage":{"representation":"storage","value":"<ac:structured-macro ac:name=\"code\"><ac:plain-text-body><![CDATA[print(1)]]></ac:plain-text-body></ac:structured-macro><ac:task-list><ac:task><ac:task-status>incomplete</ac:task-status><ac:task-body>Check sync</ac:task-body></ac:task></ac:task-list>"}}}'
# Personal Access Token (Bearer auth for Compendiq)
curl -fsS -u "$AUTH" -X POST http://localhost:8090/rest/pat/latest/tokens \
  -H 'Content-Type: application/json' \
  -d '{"name":"compendiq-e2e","expirationDuration":90}'
# → response field "rawToken" is shown ONCE; store it outside the repo.
```

## Reaching Confluence from the app

- **Host / Vite dev / Playwright browser:** `http://localhost:8090`
- **Compendiq backend container:** the Confluence compose joins the external
  `compendiq_backend-net`. If your backend stack uses its own network (the EE
  compose does), bridge it once:
  ```bash
  docker network connect --alias confluence <your-backend-network> \
    compendiq-confluence-confluence-1
  ```
  then configure Compendiq with `http://confluence:8090`. The URL entered in
  Settings → Confluence is used by the **backend**, so it must be resolvable
  from inside the backend container, not (only) from the host.

## Running the sync e2e

`e2e/confluence-sync.spec.ts` skips unless both env vars are set:

```bash
E2E_BASE_URL=http://localhost:8082 \          # your running frontend
E2E_CONFLUENCE_URL=http://confluence:8090 \   # backend-resolvable URL
E2E_CONFLUENCE_PAT=<rawToken> \
npx playwright test e2e/confluence-sync.spec.ts
```

The spec registers a throwaway user, connects the PAT, fetches spaces,
selects + syncs one, and asserts synced Confluence pages are served by
`/api/pages`. The CI-safe variant that needs no Confluence at all is
`e2e/confluence-sync-mock.spec.ts` (route-intercepted fixtures).

## Notes

- Ports bind to `127.0.0.1` only (8090 HTTP, 8091 Synchrony).
- The timebomb license, the dev admin password in `docker/.env`, and seeded
  PATs are throwaway dev credentials for this isolated container — treat
  anything you paste into a real instance differently.
- Confluence DC 9.2 serves XHTML storage format only (see ADR-003); the
  seeded code-block/task-list page exercises the `confluenceToHtml` path.
