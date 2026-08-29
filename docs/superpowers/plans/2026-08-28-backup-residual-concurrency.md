# Backup Residual Concurrency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four final-review races in attachment snapshot consistency, backup lock cleanup, concurrent Notion imports, and queued-run UI correlation.

**Architecture:** PostgreSQL session advisory locks form a read/write barrier between authoritative local-attachment mutation and backup capture. A separate keyed advisory lock serializes each Notion page import. BullMQ job IDs are persisted in backup history and become the exact frontend polling correlation key.

**Tech Stack:** TypeScript, PostgreSQL 17 advisory locks/exported snapshots, Node.js filesystem/streams, BullMQ, Zod contracts, React 19, TanStack Query, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-28-backup-remediation-design.md` — “Residual Concurrency Addendum”.

## Global Constraints

- Hold the backup exclusive attachment lock from before exported snapshot creation until every dump/attachment stream finishes or fails.
- Hold a shared attachment lock across each authoritative filesystem mutation and its related PostgreSQL commit/rollback.
- Cleanup must release the Redis cluster lock even when child reaping, snapshot close, advisory unlock, or client release fails.
- Same-page Notion imports serialize by normalized immutable Notion page ID; only the creator may abandon its incomplete placeholder.
- Poll backup history by the exact returned queue job ID, never by cache novelty or timestamps.
- Pre-appearance polling stops after 60 seconds with a visible degraded status.
- No remote push or PR mutation.

---

### Task 1: Coordinate Attachment Mutation and Backup Snapshot

**Files:**
- Modify: `backend/src/core/db/advisory-locks.ts`
- Create: `backend/src/core/services/attachment-snapshot-lock.ts`
- Create: `backend/src/core/services/attachment-snapshot-lock.test.ts`
- Modify: `backend/src/core/services/local-attachment-service.ts`
- Modify: `backend/src/core/services/local-attachment-service.test.ts`
- Modify: `backend/src/core/services/backup-service.ts`
- Modify: `backend/src/core/services/backup-service.test.ts`

**Interfaces:**

```ts
export const ATTACHMENT_SNAPSHOT_LOCK_ID = 1_420_001;

export async function withLocalAttachmentMutationLock<T>(
  operation: (client: PoolClient) => Promise<T>,
): Promise<T>;

export interface ExportedBackupSnapshot {
  client: PoolClient;
  snapshotId: string;
  close(): Promise<void>;
}
```

- [ ] Write failing tests proving a shared mutation waits behind an exclusive holder and uses the same client for file-adjacent SQL.
- [ ] Write source/runtime tests covering `putLocalAttachment`, relocate write/remove, sweep removal, and directory removal through `withLocalAttachmentMutationLock`.
- [ ] Add a failing backup test where `snapshot.close()` rejects and assert `releaseWorkerLock` still runs once.
- [ ] Add a failing concurrency test: start backup snapshot/exclusive lock, start same-name overwrite, read archived bytes, release backup, then assert overwrite commits only afterward and DB SHA matches the new file.
- [ ] Run focused tests and confirm RED:

```bash
cd backend && npx vitest run src/core/services/attachment-snapshot-lock.test.ts src/core/services/local-attachment-service.test.ts src/core/services/backup-service.test.ts
```

- [ ] Implement the session shared-lock helper with a dedicated client, `SET statement_timeout = 0`, `pg_advisory_lock_shared`, and nested `try/finally` reset/unlock/release.
- [ ] Route each authoritative local-store mutation and related SQL through the helper/client. Reads remain unlocked.
- [ ] Acquire the exclusive session lock on the exported-snapshot client before `BEGIN`; retain it through stream completion. Refactor release into nested `try/finally` so Redis unlock is last and unconditional.
- [ ] Re-run the focused tests; expected PASS.
- [ ] Commit:

```bash
git add backend/src/core/db/advisory-locks.ts backend/src/core/services/attachment-snapshot-lock.ts backend/src/core/services/attachment-snapshot-lock.test.ts backend/src/core/services/local-attachment-service.ts backend/src/core/services/local-attachment-service.test.ts backend/src/core/services/backup-service.ts backend/src/core/services/backup-service.test.ts
git commit -m "fix(backup): coordinate attachment snapshots"
```

---

### Task 2: Serialize Same-Page Notion Imports

**Files:**
- Modify: `backend/src/core/db/advisory-locks.ts`
- Create: `backend/src/domains/knowledge/services/notion-import-lock.ts`
- Create: `backend/src/domains/knowledge/services/notion-import-lock.test.ts`
- Modify: `backend/src/domains/knowledge/services/notion-import-service.ts`
- Modify: `backend/src/domains/knowledge/services/notion-import-service.test.ts`

**Interfaces:**

```ts
export const NOTION_IMPORT_LOCK_KEY = 1_420_002;
export function notionImportLockId(notionPageId: string): number;
export async function withNotionImportLock<T>(
  notionPageId: string,
  operation: () => Promise<T>,
): Promise<T>;
```

- [ ] Add failing lock tests proving normalized dashed/undashed IDs map identically, different IDs can proceed independently, and same-ID operations serialize.
- [ ] Add a failing two-import behavioral test: importer A completes; importer B had been waiting and then encounters its injected media failure; A’s page and files must remain and B must return/reuse the completed result rather than abandon it.
- [ ] Run focused tests and confirm RED:

```bash
cd backend && npx vitest run src/domains/knowledge/services/notion-import-lock.test.ts src/domains/knowledge/services/notion-import-service.test.ts
```

- [ ] Implement a deterministic signed 32-bit SHA-256-derived second key and session `pg_advisory_lock($1,$2)`/unlock on a dedicated client.
- [ ] Wrap each selected page’s placeholder discovery through completion/cleanup in the keyed lock. Re-read `findImportedPage` after lock acquisition. Track `createdPlaceholder` locally; call `abandonPage` only when this invocation created it and it is still incomplete.
- [ ] Re-run focused tests; expected PASS.
- [ ] Commit:

```bash
git add backend/src/core/db/advisory-locks.ts backend/src/domains/knowledge/services/notion-import-lock.ts backend/src/domains/knowledge/services/notion-import-lock.test.ts backend/src/domains/knowledge/services/notion-import-service.ts backend/src/domains/knowledge/services/notion-import-service.test.ts
git commit -m "fix(notion): serialize page imports"
```

---

### Task 3: Correlate Queued Backup Jobs Through History and UI

**Files:**
- Create: `backend/src/core/db/migrations/108_backup_run_job_id.sql`
- Create: `backend/src/core/db/migrations/__tests__/108_backup_run_job_id.test.ts`
- Modify: `backend/src/core/services/backup-service.ts`
- Modify: `backend/src/core/services/backup-service.test.ts`
- Modify: `backend/src/core/services/backup-worker.ts`
- Modify: `backend/src/core/services/queue-service.ts`
- Modify: `backend/src/core/services/queue-service.test.ts`
- Modify: `packages/contracts/src/schemas/backup.ts`
- Modify: `packages/contracts/src/schemas/backup.test.ts`
- Modify: `frontend/src/features/settings/panels/BackupTab.tsx`
- Modify: `frontend/src/features/settings/panels/BackupTab.test.tsx`
- Modify: `docs/architecture/06-data-model.md`

**Contract:** `BackupRunSchema` adds `jobId: z.string().nullable()`. `runS3Backup(triggeredBy, jobId)` stores that exact ID. Forced and scheduled processors pass `job.id ?? null`.

- [ ] Add failing migration/contract/service/worker tests for nullable persisted `job_id` and exact queue ID forwarding.
- [ ] Add failing UI tests: an unrelated cache-unknown terminal run must not satisfy the queued job; polling continues until matching `jobId` appears and settles; no matching run after 60 seconds stops polling and renders a retry/status notice.
- [ ] Run RED:

```bash
npm run test -w @compendiq/contracts
cd backend && npx vitest run src/core/db/migrations/__tests__/108_backup_run_job_id.test.ts src/core/services/backup-service.test.ts src/core/services/queue-service.test.ts
cd ../frontend && npx vitest run src/features/settings/panels/BackupTab.test.tsx
```

- [ ] Add migration 108 column and index; thread `jobId` through worker/service insert/list and contracts.
- [ ] Replace cache-ID baseline state with `{ jobId, expiresAt }`. `refetchInterval` is 3000 while the exact job is absent before expiry or present/running. Clear on matching terminal row. On expiry render a focus-safe degraded status with manual Retry/refetch.
- [ ] Update data-model documentation for `job_id` correlation.
- [ ] Re-run focused tests; expected PASS.
- [ ] Commit:

```bash
git add backend/src/core/db/migrations/108_backup_run_job_id.sql backend/src/core/db/migrations/__tests__/108_backup_run_job_id.test.ts backend/src/core/services/backup-service.ts backend/src/core/services/backup-service.test.ts backend/src/core/services/backup-worker.ts backend/src/core/services/queue-service.ts backend/src/core/services/queue-service.test.ts packages/contracts/src/schemas/backup.ts packages/contracts/src/schemas/backup.test.ts frontend/src/features/settings/panels/BackupTab.tsx frontend/src/features/settings/panels/BackupTab.test.tsx docs/architecture/06-data-model.md
git commit -m "fix(backup): correlate queued runs by job id"
```

---

### Task 4: Final Residual Verification

- [ ] Run all focused residual and prior backup remediation suites.
- [ ] Run `npm run typecheck`, `npm run lint`, `npm run build`.
- [ ] Run full backend with an isolated authenticated Redis and real PostgreSQL test service; run full frontend.
- [ ] Rebuild the isolated Docker stack and browser-drive ticket download, localhost S3 rejection, exact queued job appearance/terminal polling, and attachment overwrite blocking during a backup fixture.
- [ ] Run the applicable Playwright project and report unrelated failures exactly.
- [ ] Dispatch per-task and final whole-branch reviews; fix confirmed Critical/Important findings under the review loop.
- [ ] Leave all commits local; do not push.
