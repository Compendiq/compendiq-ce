# Residual plan final fix report

Starting point: required HEAD `a188baae32f49ac6c2bb85a53ba4629a03a86990` was verified before edits. No push or remote action was performed.

## 1. Portable archive and attachment filenames

**Change:** `assertSafeArchivePath` now rejects `\\` instead of normalizing it. Both authoritative attachment filename guards reject backslashes, preventing new database/file references that would restore to another path. An existing on-disk filename containing a backslash reaches `packArchive` and fails explicitly.

**RED:**

```text
npx vitest run src/core/services/backup-stream.test.ts src/core/services/local-attachment-service.test.ts src/core/services/attachment-store.test.ts
Test Files 3 failed (3)
Tests: 3 failed
- archive guard did not throw
- canStoreLocalFilename returned true
- isStorableAttachmentFilename returned true
```

**GREEN:** the same command passed `3` files and `59` tests.

## 2. Page-icon snapshot barrier and shared client

**Change:** page-icon write/delete mutators acquire the shared attachment snapshot barrier when called directly and accept an existing lock-owning `PoolClient`. The icon PATCH and image POST routes now lock at the route mutation boundary, pass that exact client to the filesystem mutator, and execute the related `pages.icon_kind`/`pages.icon_value` update through the same client. Standalone cleanup reuses its caller-owned client rather than taking a leaf lock.

**RED:**

```text
npx vitest run src/routes/knowledge/pages-icon.test.ts src/core/services/attachment-snapshot-lock.test.ts
Test Files 2 failed (2)
Tests: 4 failed
- direct deletion did not wait behind the exclusive snapshot holder
- route barrier was never entered
- delete/write did not receive the update client's identity
```

**GREEN:** the same command passed `2` files and `10` tests. The direct-delete test observes a real PostgreSQL `ShareLock` waiter behind the exclusive backup lock, confirms the icon still exists while blocked, then confirms deletion after unlock. Route tests assert the identical client object reaches delete/write and the `UPDATE pages` query.

## 3. Correlated backup history before preflight

**Change:** `runS3Backup` inserts the correlated running row before reading S3 runtime configuration or requiring the master key. Both preflight steps are inside the common failure boundary, which updates that exact run ID to terminal `failed` with the original error.

**RED:**

```text
npx vitest run src/core/services/backup-service.test.ts
Test Files 1 failed (1)
Tests: 2 failed, 26 passed
- disabled S3 preflight made zero backup_runs queries
- missing master-key preflight made zero backup_runs queries
```

**GREEN:** the same command passed `1` file and `28` tests. Both preflight cases assert INSERT parameters include the exact queue job ID and the following failure UPDATE targets the returned run ID.

## 4. One SigV4 canonical query on the wire

**Change:** S3 requests compute the AWS-encoded, sorted canonical query string once, pass it to signing, and assign that same string to `URL.search`. AWS URI encoding also percent-encodes `!'()*` as required.

**RED:**

```text
npx vitest run src/core/services/backup-s3.test.ts -t "signs and transmits one AWS-encoded query"
Test Files 1 failed (1)
Expected: ...prefix=space%20~%2B%26%2F%C3%BCmlaut
Received: ...prefix=space+%7E%2B%26%2F%C3%BCmlaut
```

**GREEN:** the same command passed the selected test (`1` passed, `27` skipped), including an exact fixed-time Authorization signature assertion.

## 5. S3 XML entity decoding before ownership checks

**Change:** S3 ListObjects text values are decoded with the existing `he` dependency before pagination, ownership filtering, and deletion. This covers named entities plus decimal and hexadecimal numeric references.

**RED:**

```text
npx vitest run src/core/services/backup-s3.test.ts -t "decodes named and numeric XML references"
Test Files 1 failed (1)
Expected three finance&legal owned keys; received []
```

**GREEN:** the same command passed the selected test (`1` passed, `28` skipped). The test also asserts DeleteObjects receives decoded keys and escapes each ampersand exactly once in its XML body.

## Final focused evidence

```text
npx vitest run \
  src/core/services/backup-stream.test.ts \
  src/core/services/local-attachment-service.test.ts \
  src/core/services/attachment-store.test.ts \
  src/core/services/attachment-snapshot-lock.test.ts \
  src/core/services/standalone-attachment-cleanup.integration.test.ts \
  src/routes/knowledge/pages-icon.test.ts \
  src/routes/knowledge/pages-crud-hard-delete-attachments.test.ts \
  src/core/services/backup-service.test.ts \
  src/core/services/backup-s3.test.ts \
  src/core/services/backup-restore.test.ts
Test Files 10 passed (10)
Tests 166 passed (166)
```

```text
npx vitest run src/core/services/backup-export-ticket.test.ts src/routes/foundation/admin-backup.test.ts
Test Files 2 passed (2)
Tests 14 passed (14)
```

```text
# frontend
npx vitest run src/features/settings/panels/BackupTab.test.tsx
Test Files 1 passed (1)
Tests 17 passed (17)
```

Changed-file ESLint completed with exit code `0` across all 15 changed TypeScript source/test files. A temporary TypeScript project rooted only at the 8 changed production files (plus required Fastify declaration augmentations) completed with `npx tsc -p /tmp/compendiq-1420-final-fix-tsconfig.json --pretty false`, exit code `0`; the temporary config was removed.

## Concerns

The focused backend and frontend Vitest runs emit Node's existing experimental `localStorage` warning in some suites; all assertions pass. No remaining implementation concern was observed in this fix wave.
