# Task 4 Report — Final Residual Verification

## Status

Complete with two local corrective commits. The focused residual/prior-backup suites, contracts, typecheck, lint, build, full backend, full frontend, isolated Docker stack, native browser download, localhost S3 rejection, exact queued-job polling, and real PostgreSQL advisory-lock overwrite scenario all pass on the final commit.

The repository Chromium Playwright project remains red for six unrelated/stale authentication and setup assumptions: 1 passed, 6 failed, 63 skipped. No push or remote action occurred. The task brief's delegated review step was not run because the assignment explicitly prohibited subagents.

Starting revision was verified before all other work:

```text
git rev-parse HEAD
# da8177301745f236cb3428d49f6e24877d91e249
```

## Local commits

- `ed2384752472b303b19b668fb034ac281788ae3b` — `fix: satisfy residual concurrency lint contracts`
  - Reworked attachment, backup-snapshot, and Notion advisory-lock cleanup so unlock/reset/release are all attempted without unsafe throws from `finally`.
  - Preserves the primary operation/transaction error while still surfacing cleanup failure when no primary failure exists.
  - Removed two obsolete variables/helpers exposed by the full lint run.
- `6dbfc7f48296b32e13d3a4f8cbe177a4d34c85f4` — `fix(backup): release resources on S3 rejection`
  - Reproduced a real runtime failure: an S3 `CreateMultipartUpload` rejection before stream consumption left the encrypted stream, pg_dump/snapshot resources, and Redis backup lock alive while history was already terminal `failed`.
  - Added an explicit idempotent release handle to encrypted backup streams. S3 orchestration now destroys the stream and awaits resource release before persisting terminal success/failure.
  - Added a regression test that requires Redis lock and PostgreSQL snapshot release before the failed history UPDATE.

Final tracked state:

```text
git status --short --branch
## feature/1420-encrypted-backup...origin/feature/1420-encrypted-backup [ahead 30]
```

## Verification matrix

| Area | Final result | Evidence |
|---|---:|---|
| Focused residual + prior backup backend | PASS | 26 files, 359 tests |
| Focused backup frontend + semantic token contract | PASS | 2 files, 25 tests |
| Contracts | PASS | 15 files, 298 tests |
| Typecheck | PASS | contracts build, backend + scripts, frontend |
| Lint | PASS | backend and frontend, zero warnings allowed |
| Build | PASS | contracts, backend, frontend; CSP hash check; 5,914 Vite modules |
| Full backend | PASS | 382 files; 6,500 passed, 3 skipped; authenticated isolated Redis + existing real PostgreSQL |
| Full frontend | PASS on fresh rerun | 334 files; 5,131 passed |
| Actual overwrite/advisory-lock integration | PASS | 1 selected real-PostgreSQL test passed, 22 skipped |
| Isolated compose | PASS | frontend, backend, mcp-docs, PostgreSQL, Redis, SearxNG healthy; corrected backend rebuilt and healthy |
| Native ticket download | PASS | ticket POST 200; 64-hex same-origin ticket; GET 200 native document navigation; Chromium download event; `.enc`; 0 Blob allocations |
| Localhost S3 rejection | PASS | PUT 400; exact SSRF message visible |
| Exact queued-job correlation | PASS | POST returned job ID `6`; first poll had no matching run; next poll found exact ID `6` terminal `failed`; `lockHeld=false`; exact row rendered |
| Immediate S3 rejection resource cleanup | PASS | Redis `EXISTS worker:lock:backup` returned `0`; run control remained enabled after terminal row |
| Chromium Playwright project | FAIL, unrelated/stale suite assumptions | 72 discovered; 1 passed, 6 failed, 63 skipped; 7.1 minutes |
| Cleanup | PASS | browser killed; compose containers/volumes/networks removed; test Redis removed; `docker/.env` and downloaded files removed |
| Push/remote action | NOT RUN | explicitly prohibited |

## Command ledger

Commands are listed in meaningful execution order. All final commands exited 0 unless explicitly marked otherwise.

### Dependencies and focused suites

1. `docker version --format '{{.Server.Version}}'`
   - Docker server `29.7.2`.
2. `docker ps --filter publish=5433 --format '{{.Names}} {{.Image}} {{.Status}} {{.Ports}}'`
   - Existing `compendiq-test-postgres-test-1`, `pgvector/pgvector:pg17`, healthy on `127.0.0.1:5433`.
3. `docker run -d --rm --name compendiq-residual-verify-redis -p 127.0.0.1:6383:6379 redis:8-alpine redis-server --requirepass residual-review-redis`
4. `docker exec compendiq-residual-verify-redis redis-cli -a residual-review-redis ping`
   - `PONG`.
5. Focused backend residual/prior-backup command:

```bash
cd backend
REDIS_URL=redis://:residual-review-redis@127.0.0.1:6383 \
npx vitest run --maxWorkers=1 --no-file-parallelism \
  src/core/db/migrations/__tests__/107_backup_settings.test.ts \
  src/core/db/migrations/__tests__/108_backup_run_job_id.test.ts \
  src/core/services/attachment-snapshot-lock.test.ts \
  src/core/services/local-attachment-service.test.ts \
  src/core/services/backup-service.test.ts \
  src/core/services/backup-stream.test.ts \
  src/core/services/backup-restore.test.ts \
  src/core/services/backup-s3.test.ts \
  src/core/services/backup-settings.test.ts \
  src/core/services/backup-export-ticket.test.ts \
  src/core/services/backup-dockerfile.test.ts \
  src/core/services/standalone-attachment-cleanup.integration.test.ts \
  src/core/services/data-retention-service.test.ts \
  src/core/services/data-retention-service.integration.test.ts \
  src/core/services/queue-service.test.ts \
  src/domains/knowledge/services/notion-import-lock.test.ts \
  src/domains/knowledge/services/notion-import-service.test.ts \
  src/domains/confluence/services/attachment-sweep-service.dirty-contract.test.ts \
  src/domains/confluence/services/attachment-sweep-service.lock-order.test.ts \
  src/domains/confluence/services/attachment-sweep-service.test.ts \
  src/domains/confluence/services/attachment-sweep-service.integration.test.ts \
  src/routes/knowledge/pages-relocate.integration.test.ts \
  src/routes/knowledge/pages-crud-hard-delete-attachments.test.ts \
  src/routes/knowledge/pages-crud-delete-atomicity.integration.test.ts \
  src/routes/foundation/admin-backup.test.ts \
  src/routes/foundation/backup-download.test.ts
```

   - Initial: 26 files, 358 tests passed, 17.08s.
   - Final after fixes: 26 files, 359 tests passed, 15.78s.
6. `cd frontend && npx vitest run src/features/settings/panels/BackupTab.test.tsx src/flat-components.test.ts`
   - Final: 2 files, 25 tests passed, 969ms.
7. `npm run test -w @compendiq/contracts`
   - Final: 15 files, 298 tests passed, 372ms.

### Static and full suites

8. `npm run typecheck`
   - Final: contracts, backend including scripts, and frontend passed in 13.32s.
9. `npm run lint`
   - Initial exit 1: seven errors in newly changed residual code (`no-unsafe-finally` x5, unused declarations x2).
   - After `ed238475`: backend and frontend passed with zero warnings in 8.31s.
10. `npm run build`
    - Final: passed in 12.20s; CSP inline hash matched; Vite transformed 5,914 modules. Existing Node `module.register()` deprecation and large-chunk advisory remained.
11. `REDIS_URL=redis://:residual-review-redis@127.0.0.1:6383 npm run test -w backend`
    - Final: 382 files; 6,500 passed, 3 skipped; 58.38s.
12. `npm run test -w frontend`
    - One final-attempt run was intermittently red in two unrelated tests: `AiContext.threads.test.tsx` model text and `PiiPolicyTab.test.tsx` toggle hydration.
    - `npx vitest run src/features/ai/AiContext.threads.test.tsx src/features/admin/PiiPolicyTab.test.tsx`: 2 files, 62 tests passed.
    - Fresh full rerun: 334 files, 5,131 tests passed, 48.56s.

### TDD correction for immediate S3 rejection

13. RED:

```bash
cd backend
npx vitest run src/core/services/backup-service.test.ts \
  -t 'releases backup resources before recording an immediate S3 upload failure'
```

   - Exit 1; one failed, 12 skipped; expected `releaseWorkerLock` once, received zero.
14. GREEN: same command after the fix.
   - 1 passed, 12 skipped.
15. `npx vitest run src/core/services/backup-service.test.ts src/core/services/backup-s3.test.ts src/routes/foundation/backup-download.test.ts`
   - 3 files, 50 tests passed.
16. `npx eslint --max-warnings=0 src/core/services/backup-service.ts src/core/services/backup-service.test.ts`
   - Passed.
17. `npm run typecheck -w backend`
   - Passed.

### Real PostgreSQL attachment barrier

18. Exact real-DB/advisory-lock scenario:

```bash
cd backend
npx vitest run src/core/services/local-attachment-service.test.ts \
  -t 'holds a same-name overwrite until archived bytes have been read, then commits matching metadata'
```

   - 1 passed, 22 skipped, 478ms.
   - The scenario opens the exported backup snapshot on a dedicated PostgreSQL session, identifies its backend PID, observes the overwrite waiting on `ATTACHMENT_SNAPSHOT_LOCK_ID`, verifies archived old bytes while blocked, releases the snapshot, then verifies new filesystem bytes and matching database SHA.

### Isolated compose and browser

19. Created ignored `docker/.env` with isolated review-only PostgreSQL, authenticated Redis, JWT/PAT/backup keys, `FRONTEND_PORT=18082`, `FRONTEND_URL=http://localhost:18082`, and host CA bundle.
20. `docker compose --env-file docker/.env -p compendiq-residual-verify -f docker/docker-compose.yml up -d --build --wait`
    - Rebuilt four local images and brought all six services healthy.
21. `docker compose --env-file docker/.env -p compendiq-residual-verify -f docker/docker-compose.yml ps`
    - Six healthy services; only frontend published on `18082`.
22. Browser created admin through `POST /api/setup/admin`: HTTP 201, role `admin`, token returned; actual `/settings/system/backup` surface loaded.
23. Native download observation:
    - `POST /api/admin/backup/export-ticket` → 200.
    - Returned `/api/backup/download/3150eed0c9ca05f6e8937507ff2a303275f9c78063b4fd14e7dd539d9f8cf5d1` (64 hex).
    - Chromium requested it as `navigation=true`, resource type `document`; GET 200.
    - CDP `Browser.downloadWillBegin` fired with `compendiq-backup-20260828T180737Z.enc`.
    - Instrumented `window.Blob` allocations: `0`; SPA stayed on Backup & Recovery.
24. Localhost S3 UI save:
    - Endpoint `http://127.0.0.1:9000`.
    - PUT `/api/admin/backup` → 400 with `SSRF blocked: cannot connect to internal/private network`.
    - Exact message was visible in the UI.
25. Exact job polling used an intentionally invalid public AWS credential after a valid public endpoint configuration:
    - POST `/api/admin/backup/run` → 200, exact BullMQ job ID `6`.
    - First status GET: matching status absent, history IDs `[5,3]`, `lockHeld=false`.
    - Next 3-second poll: exact ID `6` present as `failed`, history IDs `[6,5,3]`, `lockHeld=false`.
    - Terminal DB/API row: run ID `40c7fbba-7adf-4dbd-8b32-b64d9fc5ab29`, created `2026-08-28T18:13:36.682Z`, finished `2026-08-28T18:13:37.066Z`, destination `s3`, expected invalid-access error, `jobId='6'`.
    - UI history rendered `2026-08-28T18:13:36.682Z — s3 — failed`; Run control was enabled.
26. Runtime regression observation before `6dbfc7f4`:
    - An earlier identical invalid-access job reached terminal `failed`, but `docker exec ... redis-cli EXISTS worker:lock:backup` returned `1`, the UI retained `A backup is already running`, and controls stayed disabled.
    - After corrected backend rebuild and rerun, `EXISTS worker:lock:backup` returned `0` and exact terminal polling reported `lockHeld=false`.
27. Corrected backend rebuild:

```bash
docker compose --env-file docker/.env -p compendiq-residual-verify \
  -f docker/docker-compose.yml up -d --build --wait backend
```

   - Rebuilt and recreated backend; healthy.

### Playwright

28. `E2E_BASE_URL=http://localhost:18082 npx playwright test --project=chromium`
    - Exit 1 after 7.1 minutes: 72 discovered; 1 passed, 6 failed, 63 skipped.
    - Failures:
      1. `auth.spec.ts` registration flow waits for stale `Create your account` copy.
      2. `auth.spec.ts` existing-user flow waits for stale `Create Account` button.
      3. `auth.spec.ts` reload flow waits for the same stale button.
      4. `reload-auth.spec.ts` registration response was non-OK.
      5. `table-tools.spec.ts` could not establish an authenticated editor session; `.tiptap` never appeared / retry redirected to login.
      6. `think-toggle.spec.ts` assumes normal registration creates the first admin; the supported stack uses `/api/setup/admin` and registration is disabled after initial admin setup.
    - Backend logs corroborated registration-disabled and rate-limit responses. No Playwright test covers Backup & Recovery directly; the browser-driven checks above do.

## Cleanup

1. Closed and killed the managed Chromium session.
2. `docker compose --env-file docker/.env -p compendiq-residual-verify -f docker/docker-compose.yml down -v --remove-orphans` removed six containers, three networks, and two volumes.
3. Removed ignored `docker/.env`.
4. `docker rm -f compendiq-residual-verify-redis` removed the isolated full-suite Redis.
5. Removed `/tmp/compendiq-residual-downloads`.
6. Cleanup proofs all returned empty:

```bash
docker ps -a --filter name=compendiq-residual-verify --format '{{.Names}}'
docker volume ls --filter name=compendiq-residual-verify --format '{{.Name}}'
docker network ls --filter name=compendiq-residual-verify --format '{{.Name}}'
```

7. Existing PostgreSQL test service on port 5433 was not modified or removed.

## Concerns

1. The repository Chromium suite is not green on the supported local-loop/setup-admin stack: 6 failed, 63 skipped, 1 passed. These are existing auth/setup/rate-limit assumptions, not backup behavior.
2. Full frontend demonstrated two intermittent unrelated failures on one run; both files passed together (62 tests), and the fresh full rerun passed all 5,131 tests. This is reported as flakiness, not hidden as a clean first attempt.
3. Expected test/runtime notices remain: Node experimental localStorage warnings, happy-dom `scrollTo`/navigation notices, Node `module.register()` deprecation, and Vite chunk-size advisory.
4. Final compose logs include expected Playwright 401/429 registration/rate-limit records. No uncaught/unhandled backup resource error was observed after the corrected S3 run.
5. Review dispatch was intentionally omitted because the user explicitly required no subagents. No push, remote PR update, or remote comment occurred.

## Round 1/5 residual correction

### Status

Complete. S3 upload/prune failures now remain the recorded and rethrown primary failures when backup release also rejects. Attachment snapshot, exported PostgreSQL snapshot, and Notion import lock cleanup now track caught state independently from the caught value, preserving all five falsy JavaScript rejection values.

### Exact TDD evidence

RED, before production changes:

```bash
cd backend
npx vitest run \
  src/core/services/attachment-snapshot-lock.error.test.ts \
  src/core/services/backup-service.test.ts \
  src/domains/knowledge/services/notion-import-lock.error.test.ts
```

- Exit 1: 3 files failed; 35 tests failed.
- All falsy operation/cleanup cases were swallowed, falsy primary failures were replaced by cleanup errors, and both S3 upload/prune primary failures were replaced by the snapshot COMMIT cleanup failure.

GREEN, after the minimal production changes:

```bash
cd backend
npx vitest run \
  src/core/services/attachment-snapshot-lock.error.test.ts \
  src/core/services/backup-service.test.ts \
  src/domains/knowledge/services/notion-import-lock.error.test.ts
```

- Exit 0: 3 files passed; 48 tests passed.

Focused cleanup, backup, and Notion verification:

```bash
cd backend
npx vitest run --maxWorkers=1 --no-file-parallelism \
  src/core/services/attachment-snapshot-lock.error.test.ts \
  src/core/services/attachment-snapshot-lock.test.ts \
  src/core/services/backup-service.test.ts \
  src/core/services/backup-s3.test.ts \
  src/core/services/backup-stream.test.ts \
  src/domains/knowledge/services/notion-import-lock.error.test.ts \
  src/domains/knowledge/services/notion-import-lock.test.ts \
  src/domains/knowledge/services/notion-import-service.test.ts
```

- Exit 0: 8 files passed; 118 tests passed.

Changed-file lint:

```bash
cd backend
npx eslint --max-warnings=0 \
  src/core/services/attachment-snapshot-lock.ts \
  src/core/services/attachment-snapshot-lock.error.test.ts \
  src/core/services/backup-service.ts \
  src/core/services/backup-service.test.ts \
  src/domains/knowledge/services/notion-import-lock.ts \
  src/domains/knowledge/services/notion-import-lock.error.test.ts
```

- Exit 0 with no output.

Backend typecheck:

```bash
npm run typecheck -w backend
```

- Exit 0; both backend application and scripts TypeScript projects passed.

### Concerns

No correction-specific concerns. The focused Notion suite emitted its existing expected API-error and attachment-download warning fixtures; all 118 assertions passed. No push or remote action occurred, and no subagent was used.
