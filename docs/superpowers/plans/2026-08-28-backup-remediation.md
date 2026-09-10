# Backup Security and Recovery Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make PR #1497 produce complete encrypted backups, reject unsafe S3 endpoints, validate archives before restore mutation, and stream browser downloads without Blob buffering.

**Architecture:** Preserve streaming backup creation but make `pg_dump` exit status part of stream completion. Restore decrypts into a same-filesystem staging directory, authenticates and validates every member, then commits attachments and a single-transaction database restore. Browser downloads use an authenticated ticket-creation POST and a short-lived single-use Redis bearer capability redeemed through native navigation.

**Tech Stack:** TypeScript, Node.js streams and crypto, Fastify 5, Redis 8/node-redis, PostgreSQL 17 tools, Zod, React 19, TanStack Query, Vitest, Testing Library.

**Spec:** `docs/superpowers/specs/2026-08-28-backup-remediation-design.md`

## Global Constraints

- Keep backup generation constant-memory; never buffer a complete dump, attachment, or archive.
- Restore runs outside Fastify and may stage decrypted data on disk with mode `0700`.
- `--force` overrides only `PAT_ENCRYPTION_KEY` fingerprint mismatch.
- S3 endpoints must be public HTTP(S); private MinIO endpoints are intentionally unsupported.
- Export tickets are 256-bit random, single-use, expire after 30 seconds, and never expose a passphrase in their URL.
- Remove the direct `POST /api/admin/backup/export` path; no compatibility alias.
- Update existing architecture documents rather than creating a second diagram convention.
- Every behavior change starts with a failing behavioral test.

---

### Task 1: Make `pg_dump` Exit Status Part of Stream Completion

**Files:**
- Create: `backend/src/core/services/backup-service.test.ts`
- Modify: `backend/src/core/services/backup-service.ts:102-134`

**Interfaces:**
- Produces: `dumpStreamFromProcess(child: ChildProcess): Readable`, exported for direct behavioral testing.
- Invariant: readable EOF occurs only after stdout EOF and child close code `0`.

- [ ] **Step 1: Write failing process-order tests**

Create a child-process harness with `PassThrough` stdout/stderr and an `EventEmitter` child. Add tests equivalent to:

```ts
it('rejects when stdout ends before pg_dump later exits non-zero', async () => {
  const child = fakeChild();
  const result = readAll(dumpStreamFromProcess(child.process));
  child.stdout.end(Buffer.from('partial'));
  child.process.emit('close', 2);
  child.stderr.end(Buffer.from('fatal dump error'));
  await expect(result).rejects.toThrow(/pg_dump exited 2.*fatal dump error/i);
});

it('does not emit EOF before pg_dump closes successfully', async () => {
  const child = fakeChild();
  let settled = false;
  const result = readAll(dumpStreamFromProcess(child.process)).finally(() => { settled = true; });
  child.stdout.end(Buffer.from('complete'));
  await Promise.resolve();
  expect(settled).toBe(false);
  child.process.emit('close', 0);
  await expect(result).resolves.toEqual(Buffer.from('complete'));
});

it('bounds stderr retained for the failure message', async () => {
  const child = fakeChild();
  const result = readAll(dumpStreamFromProcess(child.process));
  child.stderr.write(Buffer.alloc(8 * 1024, 0x61));
  child.stdout.end();
  child.process.emit('close', 1);
  await expect(result).rejects.toThrow(/^pg_dump exited 1: a{4096}$/);
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```bash
cd backend && npx vitest run src/core/services/backup-service.test.ts
```

Expected: the first test resolves partial bytes or the stream finishes before `close`.

- [ ] **Step 3: Implement the completion gate**

Replace `child.stdout.pipe(out)` with explicit `data`, `end`, `error`, and child `close` handling. Keep a 4 KiB stderr accumulator. End `out` only from a shared `maybeComplete()` after `stdoutEnded && childClosed && exitCode === 0`; destroy it immediately on spawn error or non-zero close. On output destruction, destroy stdout and send `SIGTERM` once.

- [ ] **Step 4: Run focused tests and existing stream tests**

```bash
cd backend && npx vitest run src/core/services/backup-service.test.ts src/core/services/backup-stream.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/core/services/backup-service.ts backend/src/core/services/backup-service.test.ts
git commit -m "fix(backup): propagate pg_dump exit failures"
```

---

### Task 2: Authenticate and Validate Restore Before Mutation

**Files:**
- Create: `backend/src/core/services/backup-manifest.ts`
- Rewrite: `backend/src/core/services/backup-restore.ts`
- Modify: `backend/src/core/services/backup-stream.ts:333-433`
- Modify: `backend/scripts/restore-backup.ts`
- Rewrite tests: `backend/src/core/services/backup-restore.test.ts`
- Modify tests: `backend/src/core/services/backup-stream.test.ts`

**Interfaces:**
- Produces:

```ts
export const BackupManifestSchema: z.ZodType<BackupManifest>;
export function parseBackupManifest(raw: string): BackupManifest;

export interface StageBackupOptions {
  encrypted: Readable;
  secret: BackupSecret;
  attachmentsRoot: string;
  force?: boolean;
  newestMigration?: string;
}

export interface CommitBackupOptions {
  attachmentsRoot: string;
  postgresUrl: string;
  spawnFn?: typeof spawn;
  runMigrationsFn?: () => Promise<void>;
}

export interface ValidatedBackupStage {
  root: string;
  dumpPath: string;
  attachmentsPath: string;
  manifest: BackupManifest;
}

export function stageAndValidateBackup(
  opts: StageBackupOptions,
): Promise<ValidatedBackupStage>;
export function commitValidatedBackup(
  stage: ValidatedBackupStage,
  opts: CommitBackupOptions,
): Promise<void>;
export function restoreBackup(opts: RestoreOptions): Promise<BackupManifest>;
```

- Consumes: existing `runMigrations()` from `core/db/postgres.ts`; the CLI owns the matching `closePool()` in `finally`.

- [ ] **Step 1: Add failing no-mutation and integrity tests**

Add fixtures whose member order is attachment, database, then manifest. Tests must assert the spawn stub was not called and an existing attachment remains unchanged after each failure:

```ts
await expect(restoreFixture({ fingerprint: WRONG_FINGERPRINT })).rejects.toThrow(/fingerprint/i);
expect(spawnFn).not.toHaveBeenCalled();
expect(await readFile(existingAttachment, 'utf8')).toBe('original');
```

Repeat for checksum mismatch, missing checksum, extra checksum, duplicate `database.dump`, duplicate attachment name, unknown member, invalid manifest, and archive migration newer than the current binary.

Add a corrupted-auth-tag case with a multi-megabyte incompressible attachment and assert no live file appears. Add a trailing inner-archive byte case and expect rejection.

- [ ] **Step 2: Add failing commit/rollback tests**

Tests must pin:

```ts
expect(spawnFn).toHaveBeenCalledWith(
  'pg_restore',
  expect.arrayContaining(['--single-transaction']),
  expect.anything(),
);
expect(runMigrations).toHaveBeenCalledOnce();
```

For non-zero `pg_restore`, assert the previous attachments directory is restored. For dry-run, use a large generated stream, assert no spawn/migration call, and assert the validated manifest is returned.

- [ ] **Step 3: Run restore tests and confirm RED**

```bash
cd backend && npx vitest run src/core/services/backup-restore.test.ts src/core/services/backup-stream.test.ts
```

Expected: current restore writes before fingerprint failure, ignores checksums, accepts duplicates/trailing data, and omits migrations.

- [ ] **Step 4: Implement the closed manifest schema**

In `backup-manifest.ts`, define a `.strict()` Zod object:

```ts
export const BackupManifestSchema = z.object({
  version: z.literal(1),
  createdAt: z.string().datetime(),
  schemaMigration: z.string().min(1).max(255),
  patEncryptionKeyFingerprint: z.string().regex(/^sha256:[0-9a-f]{32}$/),
  databaseSizeBytes: z.number().int().nonnegative(),
  checksums: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)),
  format: z.literal('cpqarc1'),
}).strict();
```

Export the inferred `BackupManifest` type from this file and import it into `backup-stream.ts`/`backup-service.ts` rather than maintaining a second interface.

- [ ] **Step 5: Make archive termination consume authenticated EOF**

In `unpackArchive`, when the zero-length terminator is read:

1. reject if `leftover.buf` contains bytes;
2. await one final `iterator.next()`;
3. reject if it returns data;
4. return only after `done === true`.

This forces the decrypt/gunzip pipeline through GCM `_flush` and rejects trailing plaintext.

- [ ] **Step 6: Implement staging and validation**

Use `mkdtemp(path.join(path.dirname(attachmentsRoot), '.compendiq-restore-'))`, `chmod(..., 0o700)`, and streaming `pipeline()` into staged files. Track a `Set<string>` of names, a SHA-256 digest, and byte count per member. Bound manifest reads at 1 MiB with a transform that errors once exceeded.

After fully consuming the archive, parse the manifest and require the exact checksum-key set:

```ts
const expectedNames = new Set(['database.dump', ...attachmentNames]);
expectExactSet(Object.keys(manifest.checksums), expectedNames);
```

Compare hashes, dump size, fingerprint, and migration filename against the lexicographically newest shipped `*.sql` migration.

- [ ] **Step 7: Implement commit and rollback**

Rename live attachments to `${attachmentsRoot}.restore-backup-${randomUUID()}`, rename staged attachments to live, then stream the staged dump into:

```ts
spawnFn('pg_restore', [
  '--clean', '--if-exists', '--no-owner', '--no-acl', '--single-transaction',
  `--dbname=${postgresUrl}`,
], { stdio: ['pipe', 'ignore', 'pipe'] });
```

On restore failure, delete the new live tree and rename the rollback tree back. On database success, call the injected/default `runMigrationsFn`. Delete rollback and staging only after success; on migration failure retain the rollback directory and report its path. The CLI closes the shared pool in `finally`.

- [ ] **Step 8: Update the CLI**

Keep `--file`, `--dry-run`, and `--force`. Continue supporting `--passphrase` for compatibility with the issue, but add `BACKUP_PASSPHRASE` as the documented non-process-list input and prefer the environment value when both are absent. Ensure `closePool()` runs in `finally`.

- [ ] **Step 9: Run focused tests**

```bash
cd backend && npx vitest run src/core/services/backup-restore.test.ts src/core/services/backup-stream.test.ts
```

Expected: PASS with no live mutation on all validation/authentication failures.

- [ ] **Step 10: Commit**

```bash
git add backend/src/core/services/backup-manifest.ts backend/src/core/services/backup-restore.ts backend/src/core/services/backup-stream.ts backend/src/core/services/backup-restore.test.ts backend/src/core/services/backup-stream.test.ts backend/scripts/restore-backup.ts
git commit -m "fix(backup): validate archives before restore"
```

---

### Task 3: Enforce S3 SSRF Checks and Atomic Settings Writes

**Files:**
- Modify: `backend/src/core/services/backup-s3.ts`
- Expand: `backend/src/core/services/backup-s3.test.ts`
- Modify: `backend/src/core/services/backup-settings.ts`
- Expand: `backend/src/core/services/backup-settings.test.ts`
- Modify: `frontend/src/features/settings/panels/BackupTab.tsx` copy only in this task if needed by backend contract.

**Interfaces:**
- `assertSafeS3Endpoint(endpoint: string): Promise<URL>` validates without mutating the global allowlist.
- `updateBackupSettings(input): Promise<void>` applies every provided key in one PostgreSQL transaction.

- [ ] **Step 1: Replace mocked-guard tests with real SSRF behavior**

Add tests that reject:

```ts
await expect(assertSafeS3Endpoint('http://127.0.0.1:9000')).rejects.toThrow(/private|internal/i);
await expect(assertSafeS3Endpoint('http://[::1]:9000')).rejects.toThrow(/private|internal/i);
await expect(assertSafeS3Endpoint('http://10.0.0.2:9000')).rejects.toThrow(/private|internal/i);
await expect(assertSafeS3Endpoint('http://169.254.169.254/latest')).rejects.toThrow(/metadata|private/i);
await expect(assertSafeS3Endpoint('http://minio.internal')).rejects.toThrow(/private|internal/i);
```

Spy on DNS lookup through the guard’s existing test seam or add an injectable resolver to `assertNonSsrfUrl`; a public hostname resolving to `10.0.0.2` must reject. Assert `addAllowedBaseUrl` is never called.

- [ ] **Step 2: Add failing settings transaction test**

Mock `getPool().connect()` with `BEGIN`/parameterized upserts/`COMMIT`; force the third upsert to reject and assert `ROLLBACK` and no `COMMIT`.

- [ ] **Step 3: Run focused tests and confirm RED**

```bash
cd backend && npx vitest run src/core/services/backup-s3.test.ts src/core/services/backup-settings.test.ts
```

- [ ] **Step 4: Remove S3 allowlisting and validate every operation**

Delete `addAllowedBaseUrl` from `backup-s3.ts`. Run `await assertNonSsrfUrl(url.toString())` before returning the URL. Keep validation at the start of test, upload, list, and delete operations.

- [ ] **Step 5: Write settings in one transaction**

Refactor `upsert` to accept a `PoolClient`, build the exact provided key/value pairs first (encrypting new credentials before `BEGIN`), then perform all upserts between `BEGIN` and `COMMIT`, with `ROLLBACK` in `catch` and `release()` in `finally`.

- [ ] **Step 6: Run focused tests**

```bash
cd backend && npx vitest run src/core/services/backup-s3.test.ts src/core/services/backup-settings.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/src/core/services/backup-s3.ts backend/src/core/services/backup-s3.test.ts backend/src/core/services/backup-settings.ts backend/src/core/services/backup-settings.test.ts
git commit -m "fix(backup): enforce S3 endpoint isolation"
```

---

### Task 4: Add Single-Use Export Tickets and Correct Audit Lifecycle

**Files:**
- Create: `backend/src/core/services/backup-export-ticket.ts`
- Create: `backend/src/core/services/backup-export-ticket.test.ts`
- Modify: `backend/src/routes/foundation/admin-backup.ts`
- Modify: `backend/src/routes/foundation/admin-backup.test.ts`
- Create: `backend/src/routes/foundation/backup-download.ts`
- Create: `backend/src/routes/foundation/backup-download.test.ts`
- Modify: `backend/src/app.ts`
- Modify: `packages/contracts/src/schemas/backup.ts`
- Modify: `packages/contracts/src/schemas/backup.test.ts`
- Modify: `backend/src/core/services/audit-service.ts`

**Interfaces:**
- `createBackupExportTicket(input: { userId: string; secret: BackupSecret }): Promise<string>`.
- `consumeBackupExportTicket(id: string): Promise<{ userId: string; secret: BackupSecret } | null>`.
- Redis key: `backup:export-ticket:<64 lowercase hex characters>`; TTL 30 seconds.
- Public contract: `BackupExportTicketRequestSchema` and `BackupExportTicketResponseSchema`.

- [ ] **Step 1: Add failing ticket service tests**

Use a fake Redis client and assert:

- ticket IDs match `/^[0-9a-f]{64}$/`;
- Redis value contains no plaintext passphrase;
- TTL is exactly 30;
- atomic consumption returns the value once and null thereafter;
- missing Redis fails closed rather than creating a single-node ticket;
- malformed/decryption-failed values return null and are deleted.

- [ ] **Step 2: Add failing route tests**

Pin the clean cutover:

```ts
expect(await app.inject({ method: 'POST', url: '/api/admin/backup/export' })).toMatchObject({ statusCode: 404 });
```

Authenticated admin `POST /api/admin/backup/export-ticket` returns a same-origin `/api/backup/download/<id>` path. Test `backup-downloadRoutes` separately: redeeming once streams bytes; reuse returns 404. A stream error records `BACKUP_EXPORT_FAILED`, while a completed stream records `BACKUP_EXPORTED` only after completion.

- [ ] **Step 3: Add contracts and verify RED**

```ts
export const BackupExportTicketRequestSchema = z.object({
  passphrase: z.string().min(12).max(1024).optional(),
}).strict();

export const BackupExportTicketResponseSchema = z.object({
  downloadUrl: z.string().regex(/^\/api\/backup\/download\/[0-9a-f]{64}$/),
});
```

Run:

```bash
npm run test -w @compendiq/contracts
cd backend && npx vitest run src/core/services/backup-export-ticket.test.ts src/routes/foundation/admin-backup.test.ts src/routes/foundation/backup-download.test.ts
```

- [ ] **Step 4: Implement encrypted ticket storage**

Generate `randomBytes(32).toString('hex')`. Serialize `{ userId, secret }`, encrypt passphrase-bearing payloads with `encryptPat`, and store with Redis `SET ... EX 30 NX`. Consume with a Lua `GET`+`DEL` script so behavior remains atomic on clients without a typed `getDel` method.

- [ ] **Step 5: Split authenticated ticket creation from capability redemption**

Keep admin status/settings/test/run routes in `admin-backup.ts` under `authenticate` + `requireAdmin`. Put `GET /backup/download/:ticket` in the separate `backup-download.ts` plugin with no authentication hook; the ticket is its authorization. Register that plugin in `app.ts` under `/api`. Validate the path parameter as 64 lowercase hex characters before Redis access.

Set:

```ts
reply.header('Referrer-Policy', 'no-referrer');
reply.header('Cache-Control', 'no-store');
reply.header('Content-Type', 'application/octet-stream');
```

Attach audit lifecycle listeners before `reply.send(stream)`. Record success on readable completion and failure on stream error/aborted response, exactly once.

- [ ] **Step 6: Run contracts, ticket, and route tests**

```bash
npm run test -w @compendiq/contracts
cd backend && npx vitest run src/core/services/backup-export-ticket.test.ts src/routes/foundation/admin-backup.test.ts src/routes/foundation/backup-download.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts/src/schemas/backup.ts packages/contracts/src/schemas/backup.test.ts backend/src/core/services/backup-export-ticket.ts backend/src/core/services/backup-export-ticket.test.ts backend/src/routes/foundation/admin-backup.ts backend/src/routes/foundation/admin-backup.test.ts backend/src/routes/foundation/backup-download.ts backend/src/routes/foundation/backup-download.test.ts backend/src/core/services/audit-service.ts backend/src/app.ts
git commit -m "fix(backup): stream downloads through export tickets"
```

---

### Task 5: Fix Backup Settings UI Download and Error States

**Files:**
- Modify: `frontend/src/features/settings/panels/BackupTab.tsx`
- Expand: `frontend/src/features/settings/panels/BackupTab.test.tsx`

**Interfaces:**
- Consumes: `POST /admin/backup/export-ticket -> { downloadUrl: string }`.
- No browser-byte fetch, Blob, or object URL remains.

- [ ] **Step 1: Add failing ticket-navigation test**

Mock ticket creation and a navigation seam (`window.location.assign` through a small exported `navigateToBackupDownload(url)` helper). Assert the passphrase is sent only in the POST body, navigation receives the returned URL, and source contains no `res.blob`, `createObjectURL`, or `Blob`.

- [ ] **Step 2: Add failing query-state tests**

Cover first-load 500 with a visible alert and Retry button; pressing Retry must refetch. Seed cached status, fail a refetch, and assert the status form remains visible with a degraded `role="status"` notice.

- [ ] **Step 3: Add failing prerequisite/unsaved-state tests**

Assert:

- Test connection is disabled while S3 fields differ from saved values and copy says “Save changes before testing”.
- Run now is disabled when the master key is absent, S3 is disabled, or endpoint/bucket/credentials are missing.
- A successful enqueue causes query polling while a returned history row is `running` and stops after terminal state.

- [ ] **Step 4: Run focused UI tests and confirm RED**

```bash
cd frontend && npx vitest run src/features/settings/panels/BackupTab.test.tsx
```

- [ ] **Step 5: Implement ticket navigation and query states**

Use `apiFetch` for ticket creation, clear `passphrase`, then call the navigation helper. Consume `isError`, `error`, `isFetching`, and `refetch`; preserve cached data on background failure. Reuse `useNoticeRetry` for focus-safe retry behavior.

Set `refetchInterval` to `3_000` only when `data.history.some(run => run.status === 'running')`, otherwise `false`.

- [ ] **Step 6: Implement honest control states and copy**

Derive `hasUnsavedS3Changes` from S3-related form keys. Disable Test and Run with visible explanations. Change path-style copy to “Path-style addressing (public S3-compatible endpoints)” and remove private MinIO promises.

- [ ] **Step 7: Run focused tests**

```bash
cd frontend && npx vitest run src/features/settings/panels/BackupTab.test.tsx src/features/settings/SettingsLayout.test.tsx
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/features/settings/panels/BackupTab.tsx frontend/src/features/settings/panels/BackupTab.test.tsx
git commit -m "fix(backup): stream downloads without browser buffering"
```

---

### Task 6: Update Backup Documentation and Architecture Sources

**Files:**
- Modify: `.env.example`
- Modify: `CHANGELOG.md`
- Modify: `docs/ADMIN-GUIDE.md`
- Modify: `docs/architecture/02-container.md`
- Modify: `docs/architecture/03-backend-domains.md`
- Modify: `docs/architecture/05-deployment.md`
- Modify: `docs/architecture/06-data-model.md`
- Modify source-guard tests when those documents already have corresponding assertions.

**Interfaces:**
- Documents the exact behavior delivered by Tasks 1-5; introduces no new runtime API.

- [ ] **Step 1: Update operator documentation**

Document `BACKUP_PASSPHRASE`, public-only S3 endpoints, 30-second single-use downloads, restore staging disk requirements, strict checksum/schema validation, `--single-transaction`, attachment rollback, and the migration-failure recovery boundary. Remove the shell-history-first `--passphrase '…'` example.

- [ ] **Step 2: Update architecture diagrams**

Add:

- ticket service and public capability redemption to `02-container.md`;
- backup worker/ticket/restore module ownership to `03-backend-domains.md`;
- PostgreSQL client and standalone staging boundary to `05-deployment.md`;
- `backup_runs` and `backup_*` settings to `06-data-model.md`.

Use existing Mermaid styles and node naming from each file.

- [ ] **Step 3: Run documentation/source guards**

```bash
cd backend && npx vitest run src/core/services/backup-dockerfile.test.ts
cd .. && npm run typecheck
```

Expected: PASS; Mermaid and documentation changes remain parseable and all documented symbols resolve.

- [ ] **Step 4: Commit**

```bash
git add .env.example CHANGELOG.md docs/ADMIN-GUIDE.md docs/architecture/02-container.md docs/architecture/03-backend-domains.md docs/architecture/05-deployment.md docs/architecture/06-data-model.md
git commit -m "docs(backup): document secure recovery flow"
```

---

### Task 7: End-to-End Verification and PR Update

**Files:**
- Modify only files required by failures attributable to Tasks 1-6.

**Interfaces:**
- No new interfaces; this task proves the complete contract.

- [ ] **Step 1: Run focused remediation suites**

```bash
cd backend && npx vitest run \
  src/core/services/backup-service.test.ts \
  src/core/services/backup-stream.test.ts \
  src/core/services/backup-restore.test.ts \
  src/core/services/backup-s3.test.ts \
  src/core/services/backup-settings.test.ts \
  src/core/services/backup-export-ticket.test.ts \
  src/routes/foundation/admin-backup.test.ts
cd ../frontend && npx vitest run src/features/settings/panels/BackupTab.test.tsx
cd .. && npm run test -w @compendiq/contracts
```

Expected: PASS.

- [ ] **Step 2: Run repository static validation**

```bash
npm run typecheck
npm run lint
npm run build
```

Expected: PASS with no new warnings attributable to the remediation.

- [ ] **Step 3: Run full workspace tests**

```bash
npm run test -w backend
npm run test -w frontend
```

Expected: PASS. Backend DB tests use the real PostgreSQL test service on port 5433.

- [ ] **Step 4: Run Docker smoke and browser verification**

Start the repository’s supported isolated compose stack with required review-only secrets, create an admin session, open Settings → Backup & Recovery in Chromium, and verify:

- first-load error retry when the API is intercepted once with 500;
- ticket POST followed by native download navigation;
- no browser Blob allocation in the path;
- S3 localhost endpoint is rejected;
- containers stay healthy and backend logs contain no unhandled errors.

Then run the existing Playwright auth/setup/chromium projects and tear down the stack with volumes.

- [ ] **Step 5: Request code review**

Invoke `superpowers:requesting-code-review` against the complete branch diff. Fix every confirmed critical/warning finding with a focused regression test, then rerun the affected focused suite.

- [ ] **Step 6: Commit any review corrections**

When review changes files, stage only the remediation scope and commit:

```bash
git add backend/src/core/services backend/src/routes/foundation/admin-backup.ts frontend/src/features/settings/panels/BackupTab.tsx packages/contracts/src/schemas/backup.ts docs/architecture docs/ADMIN-GUIDE.md .env.example CHANGELOG.md
git commit -m "fix(backup): address remediation review"
```

Skip this commit when review produces no corrections.

- [ ] **Step 7: Push and update PR #1497**

```bash
git push origin feature/1420-encrypted-backup
```

Post a concise PR comment mapping each original review finding to its test and implementation, and request re-review. Do not dismiss the earlier review comment; leave the evidence trail intact.
