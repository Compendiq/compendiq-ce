# Backup Security and Recovery Remediation Design

**Date:** 2026-08-28  
**PR:** #1497  
**Issue:** #1420

## Purpose

Correct the security, integrity, and large-file failures found in PR #1497 without weakening its streaming backup-generation invariant. A successful backup must contain a complete `pg_dump`; a successful restore must authenticate and validate the complete archive before mutating PostgreSQL or live attachments; S3 endpoints must pass SSRF validation before use; browser downloads must not buffer the archive in a `Blob`.

## Decisions

1. Restore uses secure on-disk staging outside the running Fastify process.
2. Browser download uses a short-lived, single-use bearer ticket followed by native navigation.
3. S3 endpoints are public-network-only. Loopback, link-local, private, internal-hostname, and DNS-to-private destinations are rejected. Private MinIO endpoints are not supported by this change.
4. PostgreSQL restore uses one transaction. Attachment replacement is rename-based with rollback when database restore fails.
5. Existing archive version 1/2 envelope semantics remain; the inner manifest becomes strictly validated without adding compatibility aliases.

## Backup Generation

### `pg_dump` completion contract

`dumpStreamFromProcess` must not expose successful EOF until both conditions hold:

- `pg_dump` stdout ended; and
- the child emitted `close` with exit code `0`.

A non-zero exit or child error destroys the archive member stream before its readable side can complete. Captured stderr is bounded to 4 KiB. Cancellation destroys stdout and terminates the child. Tests must cover the normal event order where stdout ends before a later non-zero `close`.

### Archive generation

Generation remains:

```text
pg_dump + attachment read streams
  -> CPQARC1 frames
  -> gzip
  -> AES-256-GCM
  -> HTTP or S3
```

No complete archive, dump, or attachment is buffered by the backend. Existing cluster locking remains the single-flight guard.

## Restore Pipeline

### Staging location

The standalone CLI creates a mode-`0700` staging directory next to `ATTACHMENTS_DIR`, keeping staged attachments on the same filesystem as the final rename. It contains:

- `database.dump`;
- `attachments/`;
- the parsed manifest;
- computed SHA-256 values and byte counts.

The staging directory is removed on every success and failure path. Decrypted bytes never enter the running backend container.

### Phase A: authenticate and stage

The restore pipeline must fully consume the decrypted stream through AES-GCM finalization before returning from staging. `unpackArchive` must reject trailing decompressed bytes and must wait for source EOF after the archive terminator so an authentication error cannot be skipped.

For every member:

- accept exactly one `database.dump`;
- accept exactly one `manifest.json`;
- accept attachment paths only under `attachments/`;
- reject duplicates and unknown members;
- enforce safe paths;
- stream member bytes to staging while computing SHA-256 and size;
- bound `manifest.json` to 1 MiB;
- never use `readAll` for dumps or attachments, including dry-run.

### Phase B: validate

Parse `manifest.json` with a closed Zod schema. Validate:

- manifest version and archive format;
- required database dump presence;
- no missing or extra checksum entries;
- checksum equality for `database.dump` and every attachment;
- `databaseSizeBytes` equality with the staged dump size;
- `PAT_ENCRYPTION_KEY` fingerprint unless `--force` is present;
- archive migration is not newer than the newest migration shipped by the current binary.

`--force` overrides only the PAT fingerprint mismatch. It never overrides authentication, checksum, path, member, manifest, or forward-schema failures.

Dry-run ends after Phase B and reports the validated manifest. It performs no PostgreSQL or attachment mutation and remains constant-memory.

### Phase C: commit

1. Rename the current attachments root to a uniquely named rollback directory when it exists.
2. Rename the staged attachment tree into place. An empty staged tree is valid and replaces the live tree with an empty directory.
3. Run `pg_restore --clean --if-exists --no-owner --no-acl --single-transaction` from the staged dump.
4. If `pg_restore` fails, remove the staged live attachment tree and rename the rollback directory back.
5. Call the existing `runMigrations()` database runner from the standalone process, require success, and close the pool before exit.
6. Remove the attachment rollback directory only after migrations succeed.

A migration failure is reported as restore failure and preserves the restored state for operator diagnosis; schema migrations cannot generally be rolled back safely after `pg_restore` commits. Documentation must state this boundary.

## S3 SSRF Policy

`assertSafeS3Endpoint` performs validation before any state mutation:

1. parse URL and require HTTP(S);
2. reject metadata hostnames and link-local ranges;
3. run the shared synchronous private/internal checks;
4. resolve all A/AAAA records and reject when any address is blocked.

The S3 service must not call `addAllowedBaseUrl`. Every public operation validates the endpoint before issuing requests. Tests use the real guard and cover loopback IPv4, loopback IPv6, RFC1918, metadata literals, internal suffixes, and a mocked DNS result containing a private address.

The Settings copy must stop promising private MinIO connectivity. Publicly reachable S3-compatible services remain supported, including path-style addressing.

## Streaming Browser Download

### Ticket creation

Replace the direct export response with:

```text
POST /api/admin/backup/export-ticket
Authorization: Bearer <admin access token>
Body: { passphrase? }
Response: { downloadUrl }
```

The route validates the encryption choice and stores a ticket in Redis with:

- 256-bit random identifier;
- requesting admin ID for audit attribution;
- encryption mode;
- passphrase encrypted with the existing application secret-encryption utility when present;
- 30-second TTL.

The ticket contains no backup bytes. Master-key mode stores only the mode marker.

### Ticket redemption

```text
GET /api/backup/download/:ticket
```

The ticket is an intentionally unauthenticated, single-use bearer capability because top-level browser navigation cannot attach the access-token header. Redemption uses atomic `GETDEL`; expired, unknown, or reused tickets return `404`. The route sets `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, and attachment headers, then starts `createEncryptedBackupStream` and logs the original admin ID.

A failed stream must not be audited as a completed export. Audit uses distinct started/completed/failed outcomes or records completion only from stream lifecycle events.

### Frontend

`BackupTab` requests a ticket with `apiFetch`, clears the passphrase after ticket creation, and navigates to the returned same-origin URL. It does not call `fetch` for backup bytes and never constructs a `Blob` or object URL.

The status query renders four explicit states:

- loading;
- first-load failure with retry;
- cached data plus degraded refetch notice;
- loaded data.

Retry preserves keyboard focus using the repository’s existing notice/retry pattern.

## Settings and Job UX

- “Test connection” tests the persisted configuration only and is disabled while there are unsaved S3 edits; copy tells the admin to save first.
- “Run backup now” is disabled unless S3 is enabled/configured and a master key exists.
- History invalidates after enqueue and polls while a run is `running`, so the new run and terminal status become visible.
- Settings writes use one database transaction to prevent partially applied configuration.

## API and Contract Changes

- Replace `BackupExportRequestSchema` usage on the streaming route with `BackupExportTicketRequestSchema` and `BackupExportTicketResponseSchema`.
- Add a strict internal `BackupManifestSchema`; it is not a public API schema.
- Keep existing status, settings, S3 test, and run contracts.
- Remove the obsolete direct `POST /api/admin/backup/export` route and migrate its only caller and tests. No compatibility route remains.

## Testing

Tests are behavioral and must fail on the reviewed defects:

1. stdout EOF followed by non-zero `pg_dump` close rejects the backup stream;
2. bounded stderr is included in the failure;
3. fingerprint mismatch leaves PostgreSQL unspawned and live attachments unchanged;
4. checksum, duplicate-member, unknown-member, trailing-data, and forward-schema failures leave state unchanged;
5. dry-run handles a large member without `readAll` or high memory growth;
6. successful restore uses `--single-transaction`, swaps attachments, and runs migrations;
7. failed `pg_restore` restores the previous attachment tree;
8. localhost, private IP, metadata, internal hostname, and DNS-to-private S3 endpoints are rejected before requests;
9. export tickets expire, are single-use, retain audit attribution, and never expose the passphrase in the URL;
10. the frontend navigates to the ticket URL without `Blob` buffering;
11. query failure and retry states render accessibly;
12. existing typecheck, lint, backend, frontend, build, Docker smoke, and Playwright checks remain green.

## Documentation and Architecture

Update:

- `.env.example` and `docs/ADMIN-GUIDE.md` for ticket downloads, public-only S3 endpoints, restore staging, `--single-transaction`, migration behavior, and passphrase handling;
- `docs/architecture/05-deployment.md` for the runtime PostgreSQL client and standalone restore boundary;
- `docs/architecture/06-data-model.md` for `backup_runs` and backup settings;
- `docs/architecture/02-container.md` and `03-backend-domains.md` for the backup worker, ticket service, and standalone restore boundary; scheduled-backup and ticket-redemption sequences live with those components rather than creating a second flow convention;
- `CHANGELOG.md` to describe the delivered behavior accurately.

## Non-goals

- Supporting private-network S3/MinIO endpoints;
- online restore while Fastify is serving traffic;
- cross-database transactional rollback of arbitrary migrations;
- changing the existing encrypted envelope magic or KDF parameters;
- storing backup payloads in Redis or on backend local disk.

## Residual Concurrency Addendum

The final scoped review exposed four races not closed by stream staging alone. These requirements amend the approved design.

### Attachment snapshot barrier

Add `ATTACHMENT_SNAPSHOT_LOCK_ID = 1_420_001` to `core/db/advisory-locks.ts`. Backup capture takes the session-level exclusive PostgreSQL advisory lock on the same dedicated client that exports the repeatable-read snapshot, before `BEGIN`, and holds it until every attachment stream and `pg_dump` has finished or failed.

Every authoritative local-attachment mutation takes the corresponding session-level shared advisory lock on a dedicated client before its first filesystem mutation and holds it through the related PostgreSQL commit/rollback. This includes create, overwrite, delete, directory cleanup, and import-only local-file helpers in `local-attachment-service.ts`. Those functions must route their related SQL through the locked client; a global pool query inside the critical section would separate the DB mutation from the lock owner.

Lock waits use `statement_timeout = 0` on the dedicated session and reset session settings before returning the client. PostgreSQL releases the lock automatically if the process or connection dies. Confluence cache and client-model files are not authoritative `local_attachments` rows and stay outside this barrier.

Backup cleanup always attempts, in order: terminate and reap `pg_dump`, close the snapshot transaction, release the attachment snapshot advisory lock, release its client, then release the Redis cluster backup lock. Each later cleanup step lives in `finally` and runs even when an earlier step fails. A snapshot `COMMIT` failure therefore cannot strand the Redis lock.

### Notion import serialization

Add `NOTION_IMPORT_LOCK_KEY = 1_420_002` as a two-key session advisory-lock namespace. Hash the immutable Notion page ID deterministically to the second signed 32-bit key. Hold that lock across placeholder discovery/creation, media download, local attachment publication, final page update, and failure cleanup.

After a waiter acquires the lock it re-reads import state. It returns an already completed import rather than reusing or deleting it. Only the lock owner that created an incomplete placeholder may abandon that placeholder on failure.

### Backup job correlation

Migration 108 adds nullable `backup_runs.job_id TEXT` plus an index. `enqueueJob`'s returned BullMQ/legacy job ID flows through `backup-worker.ts` into `runS3Backup`, `insertBackupRun`, the status contract, and the admin history response.

`BackupTab` stores the exact returned `jobId`. It polls every three seconds until history contains that job ID and then until that row is terminal. Pre-appearance polling stops after 60 seconds and shows a degraded status explaining that the queued run has not appeared; it never treats an unrelated cache-unknown run as the requested run.

### Residual regression tests

Tests must prove:

1. a local attachment overwrite blocks behind the backup exclusive lock and cannot change bytes between exported snapshot and archive read;
2. create/delete/import-only local attachment mutations use the same shared lock and locked SQL client;
3. snapshot-close failure still releases the Redis backup lock;
4. two same-page Notion imports serialize, and a failing waiter cannot delete the winner's completed page/media;
5. the exact queued job ID appears in history and controls polling; unrelated new runs cannot satisfy it;
6. pre-appearance polling stops at 60 seconds with a visible recoverable status.
