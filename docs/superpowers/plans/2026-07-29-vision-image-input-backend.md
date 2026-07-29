# Vision Image Input — Backend Implementation Plan (#1154, PR 1 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the backend accept an image as AI source material for Generate and Improve, sent to a vision-capable `chat` model, with capability detected by probe and enforced fail-closed.

**Architecture:** `ChatMessage.content` widens to `string | ChatContentPart[]` so only the image path builds an array. Images are staged by a multipart `POST /llm/prepare-image` that validates bytes and returns a content-addressed Redis handle; generate/improve reference the handle. Vision capability is probed once per `provider+model` with a known three-band colour image and persisted in `llm_model_capabilities`.

**Tech Stack:** Fastify 5, `@fastify/multipart`, Postgres (`pg`), Redis (`redis`), Zod via `@compendiq/contracts`, Vitest.

**Design of record:** `docs/superpowers/specs/2026-07-29-image-ai-source-material-design.md`

## Global Constraints

- **No new runtime dependencies.** No `sharp`, no `image-size`, no `file-type`, no OCR library. Dimension reads are hand-rolled header parsing.
- **Format is decided by magic bytes, never the client's `Content-Type`.** A mismatch against the claimed extension is a 415.
- **Accepted formats:** `png`, `jpeg`, `webp`, `gif`. **SVG is refused.**
- **Ceilings:** 10 MB file size, 4096×4096 dimensions.
- **Redis handle key:** `llm:img:<userId>:<sha256>`, TTL 900 seconds. Not consumed on use.
- **Fail closed:** an image request is refused unless the resolved model's `vision` is exactly `true`. `null` (unknown) is refused.
- **Exactly one image per request.** `imageHandle` is a single optional string, never an array.
- **`/llm/ask` accepts no image.** `llm_conversations.messages` must never store a content-part array.
- **Zod at every API boundary**, schemas from `@compendiq/contracts`. Parameterized SQL only.
- **Migration number 087** — re-verify it is still unused immediately before opening the PR; parallel branches pick the same next number.
- **Rebuild contracts before running backend tests:** `npm run build -w @compendiq/contracts`. The `dist` is gitignored, and backend tests import from it.
- **Never `--no-verify`.**
- Tests: DB tests hit real Postgres on 5433 via `test-db-helper.ts`. Route tests mock external HTTP and the audit DB write only. Pure utilities are tested with real inputs.

---

### Task 1: Contracts — image schemas and the capability tri-state

**Files:**
- Modify: `packages/contracts/src/schemas/llm.ts`
- Modify: `packages/contracts/src/llm.ts:80-86`
- Create: `packages/contracts/src/schemas/llm.test.ts`
- Modify: `packages/contracts/src/llm.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `SUPPORTED_IMAGE_FORMATS: readonly ['png','jpeg','webp','gif']`, `ImageFormatSchema`, `ImageHandleSchema`, `PrepareImageResponseSchema`, types `ImageFormat` and `PrepareImageResponse`; `imageHandle?: string` on `GenerateRequestSchema` and `ImproveRequestSchema`; `vision: boolean | null` on `UsecaseDefaultSchema`.

- [ ] **Step 1: Write the failing contracts test**

Create `packages/contracts/src/schemas/llm.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  SUPPORTED_IMAGE_FORMATS,
  ImageHandleSchema,
  PrepareImageResponseSchema,
  GenerateRequestSchema,
  ImproveRequestSchema,
} from './llm.js';

const VALID_HANDLE = 'a'.repeat(64);

describe('SUPPORTED_IMAGE_FORMATS', () => {
  it('excludes svg so the sniffing table and UI accept list cannot drift', () => {
    expect(SUPPORTED_IMAGE_FORMATS).not.toContain('svg');
  });

  it('is exactly the four raster formats', () => {
    expect([...SUPPORTED_IMAGE_FORMATS]).toEqual(['png', 'jpeg', 'webp', 'gif']);
  });
});

describe('ImageHandleSchema', () => {
  it('accepts 64 lowercase hex chars', () => {
    expect(() => ImageHandleSchema.parse(VALID_HANDLE)).not.toThrow();
  });

  it('rejects a wrong-length hex string', () => {
    expect(() => ImageHandleSchema.parse('a'.repeat(63))).toThrow();
  });

  it('rejects uppercase hex', () => {
    expect(() => ImageHandleSchema.parse('A'.repeat(64))).toThrow();
  });

  // The handle is interpolated into `llm:img:<userId>:<sha256>`. These are the
  // key-injection cases, not stylistic ones.
  it.each([':', '*', '/', '\n', ' '])('rejects a handle containing %j', (ch) => {
    expect(() => ImageHandleSchema.parse('a'.repeat(63) + ch)).toThrow();
  });
});

describe('PrepareImageResponseSchema', () => {
  it('accepts a well-formed response', () => {
    expect(() => PrepareImageResponseSchema.parse({
      format: 'png', handle: VALID_HANDLE, width: 800, height: 600, fileSize: 1234,
    })).not.toThrow();
  });

  it('rejects svg as a format', () => {
    expect(() => PrepareImageResponseSchema.parse({
      format: 'svg', handle: VALID_HANDLE, width: 8, height: 8, fileSize: 1,
    })).toThrow();
  });

  it('rejects zero or negative dimensions', () => {
    expect(() => PrepareImageResponseSchema.parse({
      format: 'png', handle: VALID_HANDLE, width: 0, height: 600, fileSize: 1,
    })).toThrow();
  });
});

describe('imageHandle on request schemas', () => {
  it('is optional on GenerateRequestSchema', () => {
    expect(() => GenerateRequestSchema.parse({ prompt: 'hi' })).not.toThrow();
  });

  it('is accepted on GenerateRequestSchema', () => {
    const parsed = GenerateRequestSchema.parse({ prompt: 'hi', imageHandle: VALID_HANDLE });
    expect(parsed.imageHandle).toBe(VALID_HANDLE);
  });

  it('rejects a malformed handle on ImproveRequestSchema', () => {
    expect(() => ImproveRequestSchema.parse({
      content: 'x', type: 'clarity', imageHandle: 'nope',
    })).toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/contracts && npx vitest run src/schemas/llm.test.ts`
Expected: FAIL — `SUPPORTED_IMAGE_FORMATS` is not exported from `./llm.js`.

- [ ] **Step 3: Add the schemas**

In `packages/contracts/src/schemas/llm.ts`, directly after the existing `ExtractDocumentResponseSchema` block (ends `:74`):

```ts
/**
 * #1154: the image-staging endpoint accepts four raster formats. Like
 * SUPPORTED_DOCUMENT_FORMATS above, this list is the single source of truth —
 * the backend sniffing table and the upload UI's `accept` list both derive
 * from it, so SVG's exclusion cannot drift between them. SVG is out for two
 * independent reasons: vision encoders need raster, and it carries script and
 * external-entity risk.
 */
export const SUPPORTED_IMAGE_FORMATS = ['png', 'jpeg', 'webp', 'gif'] as const;

export const ImageFormatSchema = z.enum(SUPPORTED_IMAGE_FORMATS);

/**
 * Content-addressed staging id: the sha256 of the validated bytes, lowercase
 * hex. The regex is a security control, not tidiness — the handle is
 * interpolated into the Redis key `llm:img:<userId>:<sha256>`, so a bare
 * z.string() would permit key injection.
 */
export const ImageHandleSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const PrepareImageResponseSchema = z.object({
  /** Format the server *sniffed* from the bytes — never the client's Content-Type. */
  format: ImageFormatSchema,
  handle: ImageHandleSchema,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fileSize: z.number().int().nonnegative(),
});
```

Add `imageHandle: ImageHandleSchema.optional(),` as the last field of both `ImproveRequestSchema` (`:11`) and `GenerateRequestSchema` (`:34`), each with the comment `// #1154: staged image handle from POST /llm/prepare-image`.

Append to the type exports at the bottom of the file:

```ts
export type ImageFormat = z.infer<typeof ImageFormatSchema>;
export type PrepareImageResponse = z.infer<typeof PrepareImageResponseSchema>;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/contracts && npx vitest run src/schemas/llm.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing test for the capability tri-state**

Append to `packages/contracts/src/llm.test.ts`:

```ts
describe('UsecaseDefaultSchema vision tri-state (#1154)', () => {
  const base = {
    usecase: 'chat' as const,
    providerId: '00000000-0000-0000-0000-000000000001',
    providerName: 'local',
    model: 'qwen2.5vl',
  };

  it.each([true, false, null])('accepts vision: %j', (vision) => {
    expect(() => UsecaseDefaultSchema.parse({ ...base, vision })).not.toThrow();
  });

  // null is a real verdict ("probed, couldn't tell") that the composer renders
  // with different copy from false, so it must not collapse with "absent".
  it('rejects vision being absent', () => {
    expect(() => UsecaseDefaultSchema.parse(base)).toThrow();
  });
});
```

Add `UsecaseDefaultSchema` to that file's existing import block.

- [ ] **Step 6: Run it to verify it fails**

Run: `cd packages/contracts && npx vitest run src/llm.test.ts`
Expected: FAIL — the "rejects vision being absent" case passes parse today.

- [ ] **Step 7: Add `vision` to `UsecaseDefaultSchema`**

In `packages/contracts/src/llm.ts`, add to the object at `:80`:

```ts
  /**
   * #1154: whether the resolved model accepts image input. `null` means
   * probed-but-undetermined, which the UI renders differently from `false`
   * — hence nullable rather than optional.
   */
  vision: z.boolean().nullable(),
```

- [ ] **Step 8: Run both contracts test files**

Run: `cd packages/contracts && npx vitest run`
Expected: PASS.

- [ ] **Step 9: Build the contracts package**

Run: `npm run build -w @compendiq/contracts`
Expected: exit 0. Backend imports resolve from `dist`, which is gitignored.

- [ ] **Step 10: Commit**

```bash
git add packages/contracts/src/schemas/llm.ts packages/contracts/src/schemas/llm.test.ts \
        packages/contracts/src/llm.ts packages/contracts/src/llm.test.ts
git commit -m "feat(contracts): image staging schemas and vision tri-state (#1154)"
```

---

### Task 2: Widen `ChatMessage` to a content-part union

**Files:**
- Modify: `backend/src/domains/llm/services/prompts.ts:9-12`
- Modify: `backend/src/domains/llm/services/openai-compatible-client.ts:20`
- Modify: `backend/src/routes/llm/llm-ask.ts:337,339,364,366`
- Create: `backend/src/domains/llm/services/chat-content.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ChatContentPart` (`{type:'text';text:string} | {type:'image_url';image_url:{url:string}}`), `ChatMessage` with `content: string | ChatContentPart[]`, and `contentToText(content: string | ChatContentPart[]): string`. Both exported from `prompts.ts`; `openai-compatible-client.ts` re-exports `ChatMessage` for its existing importers.

- [ ] **Step 1: Write the failing test**

Create `backend/src/domains/llm/services/chat-content.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { contentToText, type ChatContentPart } from './prompts.js';

describe('contentToText', () => {
  it('passes a plain string through unchanged', () => {
    expect(contentToText('hello world')).toBe('hello world');
  });

  it('concatenates text parts and omits image parts', () => {
    const parts: ChatContentPart[] = [
      { type: 'text', text: 'describe this' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      { type: 'text', text: 'in detail' },
    ];
    expect(contentToText(parts)).toBe('describe this\nin detail');
  });

  /**
   * The reason this helper exists. `.length` is valid on both a string and an
   * array, so `m.content.length` keeps compiling under the union while
   * silently changing from a character count to a part count. Audit payloads
   * must report characters.
   */
  it('reports a character count, not a part count', () => {
    const parts: ChatContentPart[] = [
      { type: 'text', text: 'abcdefghij' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ];
    expect(parts.length).toBe(2);
    expect(contentToText(parts).length).toBe(10);
  });

  it('returns an empty string for an image-only array', () => {
    expect(contentToText([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ])).toBe('');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && npx vitest run src/domains/llm/services/chat-content.test.ts`
Expected: FAIL — `contentToText` is not exported from `prompts.js`.

- [ ] **Step 3: Widen the type and add the helper**

Replace `prompts.ts:9-12` with:

```ts
/**
 * #1154: one content part of a multimodal message, in the OpenAI-compatible
 * shape that Ollama's `/v1` shim also accepts (ADR-021: the shim is not a
 * separate protocol). Backend-internal — it is a provider wire shape, not an
 * API boundary, so it does not belong in @compendiq/contracts.
 */
export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  /**
   * A bare string for every text-only call site — which is all of them except
   * the image path in llm-generate / llm-improve.
   */
  content: string | ChatContentPart[];
}

/**
 * Flatten message content to its text for token estimation and audit payloads.
 *
 * Necessary because `.length` exists on both `string` and `Array`, so
 * `msg.content.length` compiles unchanged under the union above while
 * silently becoming a part count. Image parts contribute nothing.
 */
export function contentToText(content: string | ChatContentPart[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p): p is Extract<ChatContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && npx vitest run src/domains/llm/services/chat-content.test.ts`
Expected: PASS.

- [ ] **Step 5: Consolidate the duplicate definition**

In `openai-compatible-client.ts`, delete the local declaration at `:20` and replace it with a re-export so existing importers (`llm-ask.ts:4`) keep working:

```ts
import type { ChatMessage } from './prompts.js';
export type { ChatMessage, ChatContentPart } from './prompts.js';
```

- [ ] **Step 6: Fix the four audit expressions**

In `llm-ask.ts`, add `contentToText` to the import from `prompts.js`, then at both `:337`/`:339` and `:364`/`:366` replace:

```ts
            inputTokens: estimateTokens(messages.map(m => m.content).join('')),
            inputMessages: messages.map(m => ({ role: m.role, contentLength: m.content.length })),
```

with:

```ts
            inputTokens: estimateTokens(messages.map(m => contentToText(m.content)).join('')),
            inputMessages: messages.map(m => ({
              role: m.role,
              contentLength: contentToText(m.content).length,
            })),
```

- [ ] **Step 7: Typecheck the whole backend**

Run: `npm run typecheck -w backend`
Expected: exit 0. Any error here is a call site that reads `content` as a string; fix it with `contentToText`.

- [ ] **Step 8: Run the existing LLM suites for regressions**

Run: `cd backend && npx vitest run src/routes/llm src/domains/llm`
Expected: PASS, no change in count.

- [ ] **Step 9: Commit**

```bash
git add backend/src/domains/llm/services/prompts.ts \
        backend/src/domains/llm/services/openai-compatible-client.ts \
        backend/src/domains/llm/services/chat-content.test.ts \
        backend/src/routes/llm/llm-ask.ts
git commit -m "feat(llm): widen ChatMessage to a content-part union (#1154)"
```

---

### Task 3: Migration 087 — `llm_model_capabilities`

**Files:**
- Create: `backend/src/core/db/migrations/087_llm_model_capabilities.sql`
- Create: `backend/src/core/db/migrations/__tests__/087_llm_model_capabilities.test.ts`

**Interfaces:**
- Consumes: `llm_providers(id)` from migration 054.
- Produces: table `llm_model_capabilities (provider_id UUID, model TEXT, vision BOOLEAN NULL, probed_at TIMESTAMPTZ, probe_error TEXT NULL)`, PK `(provider_id, model)`.

- [ ] **Step 1: Write the failing migration test**

Create `backend/src/core/db/migrations/__tests__/087_llm_model_capabilities.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../../test-db-helper.js';
import { query } from '../../postgres.js';

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('Migration 087 — llm_model_capabilities', () => {
  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });
  beforeEach(async () => { await truncateAllTables(); });

  async function seedProvider(name: string): Promise<string> {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO llm_providers (name, base_url, auth_type, verify_ssl, is_default)
       VALUES ($1,'http://x/v1','none',true,false) RETURNING id`,
      [name],
    );
    return rows[0]!.id;
  }

  it('creates the table', async () => {
    const { rows } = await query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables
       WHERE schemaname='public' AND tablename='llm_model_capabilities'`,
    );
    expect(rows).toHaveLength(1);
  });

  it('allows vision to be NULL, meaning unknown', async () => {
    const id = await seedProvider('P1');
    await query(
      `INSERT INTO llm_model_capabilities (provider_id, model, vision, probe_error)
       VALUES ($1,'mystery',NULL,'connect ECONNREFUSED')`,
      [id],
    );
    const { rows } = await query<{ vision: boolean | null; probe_error: string }>(
      `SELECT vision, probe_error FROM llm_model_capabilities WHERE provider_id=$1`,
      [id],
    );
    expect(rows[0]!.vision).toBeNull();
    expect(rows[0]!.probe_error).toBe('connect ECONNREFUSED');
  });

  it('keys on (provider_id, model) so one host can serve both kinds', async () => {
    const id = await seedProvider('P1');
    await query(
      `INSERT INTO llm_model_capabilities (provider_id, model, vision)
       VALUES ($1,'qwen2.5vl',true), ($1,'llama3.1',false)`,
      [id],
    );
    const { rows } = await query<{ model: string; vision: boolean }>(
      `SELECT model, vision FROM llm_model_capabilities
       WHERE provider_id=$1 ORDER BY model`,
      [id],
    );
    expect(rows).toEqual([
      { model: 'llama3.1', vision: false },
      { model: 'qwen2.5vl', vision: true },
    ]);
  });

  it('rejects a duplicate (provider_id, model)', async () => {
    const id = await seedProvider('P1');
    await query(
      `INSERT INTO llm_model_capabilities (provider_id, model, vision) VALUES ($1,'m',true)`,
      [id],
    );
    await expect(query(
      `INSERT INTO llm_model_capabilities (provider_id, model, vision) VALUES ($1,'m',false)`,
      [id],
    )).rejects.toThrow();
  });

  /**
   * CASCADE, unlike llm_usecase_assignments' RESTRICT: capability is derived
   * data, so it should vanish with its provider rather than block the delete.
   */
  it('CASCADEs on provider delete', async () => {
    const id = await seedProvider('P1');
    await query(
      `INSERT INTO llm_model_capabilities (provider_id, model, vision) VALUES ($1,'m',true)`,
      [id],
    );
    await query(`DELETE FROM llm_providers WHERE id=$1`, [id]);
    const { rows } = await query(`SELECT 1 FROM llm_model_capabilities WHERE provider_id=$1`, [id]);
    expect(rows).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && npx vitest run src/core/db/migrations/__tests__/087_llm_model_capabilities.test.ts`
Expected: FAIL — relation `llm_model_capabilities` does not exist. If instead every test is skipped, Postgres on 5433 is not up; start it before continuing.

- [ ] **Step 3: Write the migration**

Create `backend/src/core/db/migrations/087_llm_model_capabilities.sql`:

```sql
-- #1154: per-model capability verdicts, probed rather than declared.
--
-- An OpenAI-compatible /v1/models response carries no capability field, and
-- Ollama's capability data lives on native /api/show, which ADR-021 puts
-- off-limits ("the /v1 shim is not a separate protocol"). So capability is
-- established by sending a known image and checking the answer.
--
-- Keyed on (provider_id, model), not on the provider: one host commonly
-- serves both a vision model and a text-only one, and use-case assignments
-- pin provider+model.

CREATE TABLE IF NOT EXISTS llm_model_capabilities (
  provider_id UUID        NOT NULL REFERENCES llm_providers(id) ON DELETE CASCADE,
  model       TEXT        NOT NULL,
  -- NULL = probed but undetermined (network error, breaker open). Distinct
  -- from FALSE so a transient outage cannot permanently mark a capable model
  -- blind; the resolver treats NULL as "re-probe", and gating refuses it.
  vision      BOOLEAN     NULL,
  probed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  probe_error TEXT        NULL,
  PRIMARY KEY (provider_id, model)
);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && npx vitest run src/core/db/migrations/__tests__/087_llm_model_capabilities.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/src/core/db/migrations/087_llm_model_capabilities.sql \
        backend/src/core/db/migrations/__tests__/087_llm_model_capabilities.test.ts
git commit -m "feat(db): migration 087 llm_model_capabilities (#1154)"
```

---

### Task 4: Image validator — sniffing and header-only dimensions

**Files:**
- Create: `backend/src/core/services/image-validator.ts`
- Create: `backend/src/core/services/image-validator.test.ts`
- Create: `backend/src/core/services/test-image-fixtures.ts`

**Interfaces:**
- Consumes: `SUPPORTED_IMAGE_FORMATS`, `ImageFormat` from Task 1.
- Produces:
  - `MAX_IMAGE_BYTES = 10 * 1024 * 1024`, `MAX_IMAGE_DIMENSION = 4096`
  - `class ImageValidationError extends Error { kind: 'mediaType' | 'unprocessable' }`
  - `sniffImageFormat(buf: Buffer): ImageFormat | null`
  - `readImageDimensions(buf: Buffer, format: ImageFormat): { width: number; height: number } | null`
  - `validateImage(buf: Buffer, filename: string | undefined): { format: ImageFormat; width: number; height: number }`
- Fixtures produced: `buildPng(w, h)`, `buildGif(w, h)`, `buildWebpVp8x(w, h)`, `buildJpeg(w, h)`, `SVG_BYTES`.

- [ ] **Step 1: Write the fixture builders**

Create `backend/src/core/services/test-image-fixtures.ts`:

```ts
import { deflateSync } from 'zlib';

/**
 * Real bytes, not stubs — the validator's whole job is byte inspection, so
 * fixtures that only look right would make every assertion meaningless. Same
 * principle as test-document-fixtures.ts.
 */

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function buildPng(width: number, height: number): Buffer {
  const raw = Buffer.alloc(height * (1 + width * 3)); // filter byte 0 + RGB, all black
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // colour type: truecolour
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export function buildGif(width: number, height: number): Buffer {
  const buf = Buffer.alloc(13);
  buf.write('GIF89a', 0, 'ascii');
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return buf;
}

/** WebP extended (VP8X): canvas dimensions are 24-bit LE, stored minus one. */
export function buildWebpVp8x(width: number, height: number): Buffer {
  const buf = Buffer.alloc(30);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(22, 4);
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8X', 12, 'ascii');
  buf.writeUInt32LE(10, 16);
  buf.writeUIntLE(width - 1, 24, 3);
  buf.writeUIntLE(height - 1, 27, 3);
  return buf;
}

/** Minimal JPEG: SOI, then an SOF0 frame header carrying the dimensions. */
export function buildJpeg(width: number, height: number): Buffer {
  const sof = Buffer.alloc(11);
  sof.writeUInt16BE(0xffc0, 0);  // SOF0
  sof.writeUInt16BE(8, 2);       // segment length
  sof[4] = 8;                    // sample precision
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 1;                    // component count
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xd9])]);
}

export const SVG_BYTES = Buffer.from(
  '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>',
  'utf8',
);
```

- [ ] **Step 2: Write the failing validator test**

Create `backend/src/core/services/image-validator.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  sniffImageFormat,
  readImageDimensions,
  validateImage,
  ImageValidationError,
  MAX_IMAGE_DIMENSION,
} from './image-validator.js';
import {
  buildPng, buildGif, buildWebpVp8x, buildJpeg, SVG_BYTES,
} from './test-image-fixtures.js';

describe('sniffImageFormat', () => {
  it.each([
    ['png', buildPng(4, 4)],
    ['gif', buildGif(4, 4)],
    ['webp', buildWebpVp8x(4, 4)],
    ['jpeg', buildJpeg(4, 4)],
  ] as const)('identifies %s from its magic bytes', (expected, bytes) => {
    expect(sniffImageFormat(bytes)).toBe(expected);
  });

  it('returns null for SVG — it is not a raster format', () => {
    expect(sniffImageFormat(SVG_BYTES)).toBeNull();
  });

  it('returns null for a PDF', () => {
    expect(sniffImageFormat(Buffer.from('%PDF-1.7\n'))).toBeNull();
  });

  it('returns null for a truncated buffer', () => {
    expect(sniffImageFormat(Buffer.from([0x89, 0x50]))).toBeNull();
  });

  it('does not mistake a RIFF container that is not WEBP', () => {
    const wav = Buffer.alloc(16);
    wav.write('RIFF', 0, 'ascii');
    wav.write('WAVE', 8, 'ascii');
    expect(sniffImageFormat(wav)).toBeNull();
  });
});

describe('readImageDimensions', () => {
  it.each([
    ['png', buildPng(800, 600)],
    ['gif', buildGif(800, 600)],
    ['webp', buildWebpVp8x(800, 600)],
    ['jpeg', buildJpeg(800, 600)],
  ] as const)('reads 800x600 from %s headers', (format, bytes) => {
    expect(readImageDimensions(bytes, format)).toEqual({ width: 800, height: 600 });
  });

  it('returns null when a JPEG has no SOF marker', () => {
    expect(readImageDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 'jpeg')).toBeNull();
  });
});

describe('validateImage', () => {
  it('accepts a well-formed PNG', () => {
    expect(validateImage(buildPng(64, 48), 'shot.png')).toEqual({
      format: 'png', width: 64, height: 48,
    });
  });

  it('rejects SVG as an unsupported media type', () => {
    try {
      validateImage(SVG_BYTES, 'diagram.svg');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ImageValidationError);
      expect((err as ImageValidationError).kind).toBe('mediaType');
    }
  });

  /** The client's claimed extension is never trusted, but a mismatch is a 415. */
  it('rejects PNG bytes claiming a .jpg extension', () => {
    try {
      validateImage(buildPng(8, 8), 'sneaky.jpg');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as ImageValidationError).kind).toBe('mediaType');
    }
  });

  it('accepts a case-insensitive extension match', () => {
    expect(validateImage(buildPng(8, 8), 'SHOT.PNG').format).toBe('png');
  });

  it('accepts bytes with no filename at all', () => {
    expect(validateImage(buildPng(8, 8), undefined).format).toBe('png');
  });

  it('treats .jpeg and .jpg as the same format', () => {
    expect(validateImage(buildJpeg(8, 8), 'a.jpeg').format).toBe('jpeg');
    expect(validateImage(buildJpeg(8, 8), 'a.jpg').format).toBe('jpeg');
  });

  /**
   * A small file can declare enormous dimensions. Rejecting on the declared
   * value means nothing ever expands server-side — we never decode pixels.
   */
  it('rejects declared dimensions above the cap', () => {
    try {
      validateImage(buildPng(MAX_IMAGE_DIMENSION + 1, 8), 'huge.png');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as ImageValidationError).kind).toBe('unprocessable');
      expect((err as Error).message).toMatch(/4096/);
    }
  });

  it('rejects unreadable dimensions', () => {
    try {
      validateImage(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 'broken.jpg');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as ImageValidationError).kind).toBe('unprocessable');
    }
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd backend && npx vitest run src/core/services/image-validator.test.ts`
Expected: FAIL — cannot resolve `./image-validator.js`.

- [ ] **Step 4: Implement the validator**

Create `backend/src/core/services/image-validator.ts`:

```ts
import { SUPPORTED_IMAGE_FORMATS, type ImageFormat } from '@compendiq/contracts';

/**
 * #1154: image validation for AI source material.
 *
 * Deliberately dependency-free. `sharp` and `image-size` would each solve the
 * dimension read, but neither is worth a native build or a supply-chain
 * addition for four header layouts — and the server never decodes pixels, so
 * a declared-dimension bomb is refused before anything expands.
 *
 * Ceilings are lower than the document path's 20 MB: base64 inflates the
 * payload ~1.37x and the result lands in a prompt.
 */

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_DIMENSION = 4096;

export type ImageValidationErrorKind = 'mediaType' | 'unprocessable';

export class ImageValidationError extends Error {
  constructor(public readonly kind: ImageValidationErrorKind, message: string) {
    super(message);
    this.name = 'ImageValidationError';
  }
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Format from the bytes alone. Never consults a filename or Content-Type. */
export function sniffImageFormat(buf: Buffer): ImageFormat | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIG)) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 6) {
    const head = buf.subarray(0, 6).toString('ascii');
    if (head === 'GIF87a' || head === 'GIF89a') return 'gif';
  }
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) return 'webp';
  return null;
}

/** JPEG frame-header markers. Excludes 0xC4 (DHT), 0xC8 (JPG), 0xCC (DAC). */
const JPEG_SOF = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function jpegDimensions(buf: Buffer): { width: number; height: number } | null {
  let off = 2; // skip SOI
  while (off + 9 <= buf.length) {
    if (buf[off] !== 0xff) { off++; continue; }
    const marker = buf[off + 1]!;
    // Standalone markers carry no length field.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      off += 2;
      continue;
    }
    const segLen = buf.readUInt16BE(off + 2);
    if (JPEG_SOF.has(marker)) {
      return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
    }
    if (segLen < 2) return null; // malformed; refuse rather than loop
    off += 2 + segLen;
  }
  return null;
}

function webpDimensions(buf: Buffer): { width: number; height: number } | null {
  const chunk = buf.subarray(12, 16).toString('ascii');
  if (chunk === 'VP8X' && buf.length >= 30) {
    return {
      width: buf.readUIntLE(24, 3) + 1,
      height: buf.readUIntLE(27, 3) + 1,
    };
  }
  if (chunk === 'VP8L' && buf.length >= 25) {
    const bits = buf.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }
  if (chunk === 'VP8 ' && buf.length >= 30) {
    return {
      width: buf.readUInt16LE(26) & 0x3fff,
      height: buf.readUInt16LE(28) & 0x3fff,
    };
  }
  return null;
}

export function readImageDimensions(
  buf: Buffer,
  format: ImageFormat,
): { width: number; height: number } | null {
  switch (format) {
    case 'png':
      if (buf.length < 24) return null;
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    case 'gif':
      if (buf.length < 10) return null;
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    case 'jpeg':
      return jpegDimensions(buf);
    case 'webp':
      return webpDimensions(buf);
  }
}

const EXTENSION_TO_FORMAT: Record<string, ImageFormat> = {
  png: 'png', jpg: 'jpeg', jpeg: 'jpeg', webp: 'webp', gif: 'gif',
};

export function validateImage(
  buf: Buffer,
  filename: string | undefined,
): { format: ImageFormat; width: number; height: number } {
  const format = sniffImageFormat(buf);
  if (!format) {
    throw new ImageValidationError(
      'mediaType',
      `Unsupported image format. Supported: ${SUPPORTED_IMAGE_FORMATS.join(', ')}. SVG is not accepted.`,
    );
  }

  // The extension never decides the format, but disagreeing with the bytes is
  // itself a signal worth refusing.
  const ext = filename?.split('.').pop()?.toLowerCase();
  if (ext && EXTENSION_TO_FORMAT[ext] && EXTENSION_TO_FORMAT[ext] !== format) {
    throw new ImageValidationError(
      'mediaType',
      `File claims .${ext} but the bytes are ${format}`,
    );
  }

  const dims = readImageDimensions(buf, format);
  if (!dims || dims.width <= 0 || dims.height <= 0) {
    throw new ImageValidationError('unprocessable', `Could not read ${format} dimensions`);
  }
  if (dims.width > MAX_IMAGE_DIMENSION || dims.height > MAX_IMAGE_DIMENSION) {
    throw new ImageValidationError(
      'unprocessable',
      `Image is ${dims.width}x${dims.height}; the maximum is ${MAX_IMAGE_DIMENSION} on each edge. Resize it and try again.`,
    );
  }
  return { format, ...dims };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd backend && npx vitest run src/core/services/image-validator.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/core/services/image-validator.ts \
        backend/src/core/services/image-validator.test.ts \
        backend/src/core/services/test-image-fixtures.ts
git commit -m "feat(llm): dependency-free image sniffing and dimension limits (#1154)"
```

---

### Task 5: Vision probe

**Files:**
- Create: `backend/src/domains/llm/services/vision-probe.ts`
- Create: `backend/src/domains/llm/services/vision-probe.test.ts`

**Interfaces:**
- Consumes: `chat`, `ProviderConfig` from `openai-compatible-client.js`; `ChatMessage` from Task 2.
- Produces: `PROBE_IMAGE_BASE64`, `PROBE_BANDS: readonly ['yellow','purple','green']`, `PROBE_PROMPT`, and `probeVision(cfg, model): Promise<{ vision: boolean | null; error?: string }>`.

- [ ] **Step 1: Write the failing test**

Create `backend/src/domains/llm/services/vision-probe.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockChat = vi.fn();
vi.mock('./openai-compatible-client.js', () => ({
  chat: (...args: unknown[]) => mockChat(...args),
}));

vi.mock('../../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { probeVision, PROBE_IMAGE_BASE64, PROBE_BANDS } from './vision-probe.js';

const CFG = {
  providerId: 'p1', baseUrl: 'http://x/v1', apiKey: null,
  authType: 'none' as const, verifySsl: true,
};

beforeEach(() => { mockChat.mockReset(); });

describe('probe image', () => {
  it('is a valid PNG under 1 KB', () => {
    const bytes = Buffer.from(PROBE_IMAGE_BASE64, 'base64');
    expect(bytes.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(bytes.length).toBeLessThan(1024);
  });

  it('declares 64x96 in its IHDR', () => {
    const bytes = Buffer.from(PROBE_IMAGE_BASE64, 'base64');
    expect(bytes.readUInt32BE(16)).toBe(64);
    expect(bytes.readUInt32BE(20)).toBe(96);
  });

  /**
   * "red green blue" is the sequence a text-only model is most likely to guess,
   * which would hand us a false positive for free.
   */
  it('does not use the canonical red/green/blue order', () => {
    expect([...PROBE_BANDS]).not.toEqual(['red', 'green', 'blue']);
  });
});

describe('probeVision', () => {
  it('sends the image as a content part on a user message', async () => {
    mockChat.mockResolvedValue('yellow purple green');
    await probeVision(CFG, 'qwen2.5vl');

    const messages = mockChat.mock.calls[0]![2];
    const user = messages.find((m: { role: string }) => m.role === 'user');
    expect(Array.isArray(user.content)).toBe(true);
    const imagePart = user.content.find(
      (p: { type: string }) => p.type === 'image_url',
    );
    expect(imagePart.image_url.url).toBe(`data:image/png;base64,${PROBE_IMAGE_BASE64}`);
  });

  it('returns vision:true when the reply names all three bands in order', async () => {
    mockChat.mockResolvedValue('yellow purple green');
    expect(await probeVision(CFG, 'm')).toEqual({ vision: true });
  });

  it('tolerates punctuation and filler around the answer', async () => {
    mockChat.mockResolvedValue('Sure! The bands are yellow, purple, and green.');
    expect(await probeVision(CFG, 'm')).toEqual({ vision: true });
  });

  it('is case-insensitive', async () => {
    mockChat.mockResolvedValue('YELLOW PURPLE GREEN');
    expect(await probeVision(CFG, 'm')).toEqual({ vision: true });
  });

  it('returns vision:false when the bands are named out of order', async () => {
    mockChat.mockResolvedValue('green purple yellow');
    expect((await probeVision(CFG, 'm')).vision).toBe(false);
  });

  /**
   * The failure mode a blank 1x1 pixel cannot detect: the model accepted the
   * part, ignored it, and answered anyway. Known content turns that into a
   * correct negative instead of a false positive.
   */
  it('returns vision:false when the model answers without reading the image', async () => {
    mockChat.mockResolvedValue('I cannot see any image.');
    expect((await probeVision(CFG, 'm')).vision).toBe(false);
  });

  it('returns vision:false when the provider rejects the image part', async () => {
    mockChat.mockRejectedValue(new Error('chat HTTP 400'));
    const result = await probeVision(CFG, 'm');
    expect(result.vision).toBe(false);
    expect(result.error).toMatch(/400/);
  });

  it.each([415, 422])('treats HTTP %i as a definitive text-only verdict', async (status) => {
    mockChat.mockRejectedValue(new Error(`chat HTTP ${status}`));
    expect((await probeVision(CFG, 'm')).vision).toBe(false);
  });

  /** A transient outage must not permanently mark a capable model blind. */
  it('returns vision:null on a network error', async () => {
    mockChat.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:11434'));
    const result = await probeVision(CFG, 'm');
    expect(result.vision).toBeNull();
    expect(result.error).toMatch(/ECONNREFUSED/);
  });

  it('returns vision:null when the breaker is open', async () => {
    mockChat.mockRejectedValue(new Error('Circuit breaker is OPEN for provider p1'));
    expect((await probeVision(CFG, 'm')).vision).toBeNull();
  });

  it('returns vision:null on HTTP 500', async () => {
    mockChat.mockRejectedValue(new Error('chat HTTP 500'));
    expect((await probeVision(CFG, 'm')).vision).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && npx vitest run src/domains/llm/services/vision-probe.test.ts`
Expected: FAIL — cannot resolve `./vision-probe.js`.

- [ ] **Step 3: Implement the probe**

Create `backend/src/domains/llm/services/vision-probe.ts`:

```ts
import { chat, type ProviderConfig } from './openai-compatible-client.js';
import type { ChatMessage } from './prompts.js';
import { logger } from '../../../core/utils/logger.js';

/**
 * #1154: establish whether a model accepts image input by asking it something
 * only a model that read the pixels can answer.
 *
 * A blank 1x1 pixel cannot distinguish "read the image" from "accepted the
 * part and ignored it" — the second case would probe as capable and then fail
 * at real use. Known visual content converts that into a correct negative.
 *
 * The image is three colour bands. Three bands from a six-colour vocabulary
 * puts a blind guesser at 1 in 216, so the residual false-positive rate is
 * ~0.5%, confined to models that both ignore the image and answer in the
 * required format. No probe reaches zero; this is the accepted trade for
 * needing no admin configuration.
 */

/** 64x96 PNG: yellow, purple, then green horizontal bands. 163 bytes. */
export const PROBE_IMAGE_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABgCAIAAAAip+O/AAAAaklEQVR42u3PQQkAAAgEsItuc81wT2Gw' +
  'AstuXouAgICAgICAgICAgICAgICAgICAgICAQB2YzGsCAgICAgICAgICAgICAgICAgICAgICAn3gPQEB' +
  'AQEBAQEBAQEBAQEBAQEBAQEBAQGB1gFiAfGWnsvsZAAAAABJRU5ErkJggg==';

/**
 * Deliberately not red/green/blue — that is the sequence a text-only model is
 * most likely to emit when guessing, which would be a free false positive.
 */
export const PROBE_BANDS = ['yellow', 'purple', 'green'] as const;

const PROBE_VOCABULARY = ['red', 'green', 'blue', 'yellow', 'orange', 'purple'];

export const PROBE_PROMPT =
  'This image has three horizontal colour bands. Name them from top to bottom, ' +
  `using only these words: ${PROBE_VOCABULARY.join(', ')}. ` +
  'Reply with the three words and nothing else.';

/**
 * Match by ordered appearance rather than exact equality: models answer
 * "Sure! The bands are yellow, purple, and green." at least as often as
 * "yellow purple green", and rejecting that would be a false negative.
 */
function replyNamesBandsInOrder(reply: string): boolean {
  const lower = reply.toLowerCase();
  let cursor = 0;
  for (const band of PROBE_BANDS) {
    const at = lower.indexOf(band, cursor);
    if (at === -1) return false;
    cursor = at + band.length;
  }
  return true;
}

/**
 * A 4xx means the provider understood the request and refused the image part:
 * definitive. A 5xx, timeout, or open breaker means we never got an answer.
 */
function isDefinitiveRejection(message: string): boolean {
  return /HTTP 4\d\d/.test(message);
}

export async function probeVision(
  cfg: ProviderConfig,
  model: string,
): Promise<{ vision: boolean | null; error?: string }> {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'Answer with three words only.' },
    {
      role: 'user',
      content: [
        { type: 'text', text: PROBE_PROMPT },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${PROBE_IMAGE_BASE64}` } },
      ],
    },
  ];

  try {
    // Routed through chat(), so the probe inherits the queue and the
    // per-provider breaker rather than bypassing backpressure.
    const reply = await chat(cfg, model, messages, { maxTokens: 16 });
    const vision = replyNamesBandsInOrder(reply);
    logger.debug(
      { providerId: cfg.providerId, model, vision, reply: reply.slice(0, 120) },
      'Vision probe completed',
    );
    return vision ? { vision: true } : { vision: false, error: undefined };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isDefinitiveRejection(message)) {
      logger.debug({ providerId: cfg.providerId, model, message }, 'Vision probe refused');
      return { vision: false, error: message };
    }
    logger.warn({ providerId: cfg.providerId, model, message }, 'Vision probe inconclusive');
    return { vision: null, error: message };
  }
}
```

- [ ] **Step 4: Check `chat()` accepts a `maxTokens` option**

Run: `cd backend && grep -n "StreamChatOptions" -A 12 src/domains/llm/services/openai-compatible-client.ts | head -20`

If `StreamChatOptions` has no `maxTokens`, add `maxTokens?: number` to it and map it to `max_tokens` in the request body beside the existing option handling. Respect the `STRICT_HOSTS` logic already in that file — hosts that reject unknown fields must not receive it.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd backend && npx vitest run src/domains/llm/services/vision-probe.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/domains/llm/services/vision-probe.ts \
        backend/src/domains/llm/services/vision-probe.test.ts \
        backend/src/domains/llm/services/openai-compatible-client.ts
git commit -m "feat(llm): vision capability probe with known-content image (#1154)"
```

---

### Task 6: Capability store and probe wiring

**Files:**
- Create: `backend/src/domains/llm/services/model-capabilities.ts`
- Create: `backend/src/domains/llm/services/model-capabilities.test.ts`
- Modify: `backend/src/routes/llm/llm-usecases.ts` (the `PUT /admin/llm-usecases` handler at `:70`)
- Modify: `backend/src/domains/llm/services/llm-provider-service.ts` (the update path)

**Interfaces:**
- Consumes: `probeVision` from Task 5; `resolveUsecase` from `llm-provider-resolver.js`; migration 087.
- Produces:
  - `CAPABILITY_MAX_AGE_DAYS = 30`
  - `getVisionCapability(providerId: string, model: string): Promise<boolean | null>` — reads the row; probes and persists when missing, `NULL`, or older than the max age
  - `refreshVisionCapability(providerId: string, model: string): Promise<boolean | null>` — always probes and persists
  - `invalidateProviderCapabilities(providerId: string): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `backend/src/domains/llm/services/model-capabilities.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

const mockProbeVision = vi.fn();
vi.mock('./vision-probe.js', () => ({
  probeVision: (...args: unknown[]) => mockProbeVision(...args),
}));

vi.mock('../../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';
import {
  getVisionCapability,
  refreshVisionCapability,
  invalidateProviderCapabilities,
} from './model-capabilities.js';

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('model capabilities', () => {
  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });
  beforeEach(async () => {
    await truncateAllTables();
    mockProbeVision.mockReset();
  });

  async function seedProvider(): Promise<string> {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO llm_providers (name, base_url, auth_type, verify_ssl, is_default)
       VALUES ('P','http://x/v1','none',true,true) RETURNING id`,
    );
    return rows[0]!.id;
  }

  it('probes and persists on a cache miss', async () => {
    const id = await seedProvider();
    mockProbeVision.mockResolvedValue({ vision: true });

    expect(await getVisionCapability(id, 'qwen2.5vl')).toBe(true);
    expect(mockProbeVision).toHaveBeenCalledTimes(1);

    const { rows } = await query<{ vision: boolean }>(
      `SELECT vision FROM llm_model_capabilities WHERE provider_id=$1 AND model='qwen2.5vl'`,
      [id],
    );
    expect(rows[0]!.vision).toBe(true);
  });

  it('reads a fresh row without probing again', async () => {
    const id = await seedProvider();
    mockProbeVision.mockResolvedValue({ vision: false });

    await getVisionCapability(id, 'llama3.1');
    await getVisionCapability(id, 'llama3.1');

    expect(mockProbeVision).toHaveBeenCalledTimes(1);
  });

  it('caches a false verdict rather than re-probing it', async () => {
    const id = await seedProvider();
    mockProbeVision.mockResolvedValue({ vision: false });

    expect(await getVisionCapability(id, 'llama3.1')).toBe(false);
    mockProbeVision.mockResolvedValue({ vision: true });
    expect(await getVisionCapability(id, 'llama3.1')).toBe(false);
  });

  it('re-probes a NULL verdict, since unknown is not an answer', async () => {
    const id = await seedProvider();
    mockProbeVision.mockResolvedValue({ vision: null, error: 'ECONNREFUSED' });

    expect(await getVisionCapability(id, 'm')).toBeNull();
    mockProbeVision.mockResolvedValue({ vision: true });
    expect(await getVisionCapability(id, 'm')).toBe(true);
    expect(mockProbeVision).toHaveBeenCalledTimes(2);
  });

  it('persists the probe error alongside a NULL verdict', async () => {
    const id = await seedProvider();
    mockProbeVision.mockResolvedValue({ vision: null, error: 'connect ECONNREFUSED' });
    await getVisionCapability(id, 'm');

    const { rows } = await query<{ probe_error: string }>(
      `SELECT probe_error FROM llm_model_capabilities WHERE provider_id=$1`,
      [id],
    );
    expect(rows[0]!.probe_error).toBe('connect ECONNREFUSED');
  });

  it('re-probes a row older than the max age', async () => {
    const id = await seedProvider();
    await query(
      `INSERT INTO llm_model_capabilities (provider_id, model, vision, probed_at)
       VALUES ($1,'m',true, NOW() - INTERVAL '31 days')`,
      [id],
    );
    mockProbeVision.mockResolvedValue({ vision: false });

    expect(await getVisionCapability(id, 'm')).toBe(false);
    expect(mockProbeVision).toHaveBeenCalledTimes(1);
  });

  it('keeps verdicts independent per model on one provider', async () => {
    const id = await seedProvider();
    mockProbeVision.mockResolvedValueOnce({ vision: true });
    mockProbeVision.mockResolvedValueOnce({ vision: false });

    expect(await getVisionCapability(id, 'qwen2.5vl')).toBe(true);
    expect(await getVisionCapability(id, 'llama3.1')).toBe(false);
  });

  it('refreshVisionCapability probes even when a fresh row exists', async () => {
    const id = await seedProvider();
    mockProbeVision.mockResolvedValue({ vision: false });
    await getVisionCapability(id, 'm');

    mockProbeVision.mockResolvedValue({ vision: true });
    expect(await refreshVisionCapability(id, 'm')).toBe(true);
  });

  it('invalidateProviderCapabilities drops every row for that provider', async () => {
    const id = await seedProvider();
    mockProbeVision.mockResolvedValue({ vision: true });
    await getVisionCapability(id, 'a');
    await getVisionCapability(id, 'b');

    await invalidateProviderCapabilities(id);

    const { rows } = await query(
      `SELECT 1 FROM llm_model_capabilities WHERE provider_id=$1`, [id],
    );
    expect(rows).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && npx vitest run src/domains/llm/services/model-capabilities.test.ts`
Expected: FAIL — cannot resolve `./model-capabilities.js`.

- [ ] **Step 3: Implement the store**

Create `backend/src/domains/llm/services/model-capabilities.ts`:

```ts
import { query } from '../../../core/db/postgres.js';
import { loadProviderConfig } from './llm-provider-resolver.js';
import { probeVision } from './vision-probe.js';
import { logger } from '../../../core/utils/logger.js';

/**
 * #1154: persisted per-model capability verdicts (migration 087).
 *
 * Reads never block on a probe when a usable row exists, which is what keeps
 * GET /llm/usecase-default fast enough for AiContext's mount-time fetch.
 */

export const CAPABILITY_MAX_AGE_DAYS = 30;

interface CapabilityRow {
  vision: boolean | null;
  stale: boolean;
}

async function readRow(providerId: string, model: string): Promise<CapabilityRow | null> {
  const { rows } = await query<CapabilityRow>(
    `SELECT vision,
            (probed_at < NOW() - ($3 || ' days')::INTERVAL) AS stale
       FROM llm_model_capabilities
      WHERE provider_id = $1 AND model = $2`,
    [providerId, model, String(CAPABILITY_MAX_AGE_DAYS)],
  );
  return rows[0] ?? null;
}

async function persist(
  providerId: string,
  model: string,
  vision: boolean | null,
  error: string | undefined,
): Promise<void> {
  await query(
    `INSERT INTO llm_model_capabilities (provider_id, model, vision, probed_at, probe_error)
     VALUES ($1, $2, $3, NOW(), $4)
     ON CONFLICT (provider_id, model) DO UPDATE
       SET vision = EXCLUDED.vision,
           probed_at = EXCLUDED.probed_at,
           probe_error = EXCLUDED.probe_error`,
    [providerId, model, vision, error ?? null],
  );
}

/** Always probes, then persists. Used by admin save and the re-probe action. */
export async function refreshVisionCapability(
  providerId: string,
  model: string,
): Promise<boolean | null> {
  const cfg = await loadProviderConfig(providerId);
  const { vision, error } = await probeVision(cfg, model);
  await persist(providerId, model, vision, error);
  return vision;
}

/**
 * Returns the cached verdict, probing only when there is nothing usable:
 * no row, an unknown (NULL) verdict, or a row past CAPABILITY_MAX_AGE_DAYS.
 * A cached `false` is an answer and is not re-probed.
 */
export async function getVisionCapability(
  providerId: string,
  model: string,
): Promise<boolean | null> {
  const row = await readRow(providerId, model);
  if (row && row.vision !== null && !row.stale) return row.vision;

  try {
    return await refreshVisionCapability(providerId, model);
  } catch (err) {
    // Probing is best-effort on the read path: a resolver failure must not
    // turn a capability question into a 500 on the caller.
    logger.warn(
      { providerId, model, err: err instanceof Error ? err.message : String(err) },
      'Vision capability refresh failed',
    );
    return row?.vision ?? null;
  }
}

/**
 * Drop a provider's verdicts. Called from the cache-bus path, because a
 * changed base_url or key can put an entirely different model behind the
 * same name.
 */
export async function invalidateProviderCapabilities(providerId: string): Promise<void> {
  await query(`DELETE FROM llm_model_capabilities WHERE provider_id = $1`, [providerId]);
}
```

- [ ] **Step 4: Confirm or add `loadProviderConfig`**

Run: `cd backend && grep -n "export .*loadProviderConfig\|export .*loadProviderFromRow" src/domains/llm/services/llm-provider-resolver.ts`

If only `loadProviderFromRow` is exported, add a `loadProviderConfig(providerId)` that selects the provider row by id using the same column aliases as the existing override query (`:90-101`) and returns `loadProviderFromRow(row)`, throwing when the row is absent.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd backend && npx vitest run src/domains/llm/services/model-capabilities.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 6: Wire invalidation into the provider update path**

**Amended before execution (2026-07-29).** The first draft said to hook this into
`bumpProviderCacheVersion` in `cache-bus.ts`. That is not implementable:
`bumpProviderCacheVersion()` takes **no** `providerId` — it is a global bump
(`cache-bus.ts:172`), so it cannot scope a delete to one provider.

Wire it where the id is actually known: `domains/llm/services/llm-provider-service.ts`
owns provider create/update/delete and calls `bumpProviderCacheVersion()` at
`:91`, `:115`, `:138` and `:151`. In the **update** path, after the DB write and
beside the existing bump:

```ts
  // #1154: a changed base_url or api_key can put an entirely different model
  // behind the same name, so the cached capability verdicts for this provider
  // are no longer trustworthy. Drop them and let the read path re-probe.
  await invalidateProviderCapabilities(id);
```

The other two paths need nothing: **create** has no rows to invalidate, and
**delete** is already handled by migration 087's `ON DELETE CASCADE`. Add a test
asserting the delete path leaves no capability rows, so the CASCADE reliance is
explicit rather than incidental.

- [ ] **Step 7: Probe on admin save**

In the `PUT /admin/llm-usecases` handler (`llm-usecases.ts:70`), after the upsert succeeds and the cache version is bumped, resolve the affected use case and refresh its capability without blocking the response:

```ts
      // #1154: refresh the capability verdict for the newly assigned
      // provider+model so Settings shows it immediately. Fire-and-forget —
      // the admin's save must not wait on an LLM round-trip, and the read
      // path probes lazily if this hasn't landed yet.
      void resolveUsecase('chat')
        .then((r) => refreshVisionCapability(r.config.providerId, r.model))
        .catch((err) => logger.warn({ err }, 'Post-save vision probe failed'));
```

Add `logger` and `refreshVisionCapability` to that file's imports.

- [ ] **Step 8: Run the use-case route suite**

Run: `cd backend && npx vitest run src/routes/llm/llm-usecases.test.ts`
Expected: PASS. If a test asserts on the exact set of calls made during save, extend it to tolerate the fire-and-forget probe rather than deleting the assertion.

- [ ] **Step 9: Commit**

```bash
git add backend/src/domains/llm/services/model-capabilities.ts \
        backend/src/domains/llm/services/model-capabilities.test.ts \
        backend/src/domains/llm/services/cache-bus.ts \
        backend/src/domains/llm/services/llm-provider-resolver.ts \
        backend/src/routes/llm/llm-usecases.ts \
        backend/src/routes/llm/llm-usecases.test.ts
git commit -m "feat(llm): persist and refresh per-model vision capability (#1154)"
```

---

### Task 7: Expose `vision` on `/llm/usecase-default`

**Files:**
- Modify: `backend/src/routes/llm/llm-usecases.ts:23-38`
- Modify: `backend/src/routes/llm/llm-usecases.test.ts`

**Interfaces:**
- Consumes: `getVisionCapability` from Task 6; `UsecaseDefaultSchema` from Task 1.
- Produces: `GET /llm/usecase-default?usecase=…` responses carrying `vision: boolean | null`.

- [ ] **Step 1: Write the failing test**

Add to `backend/src/routes/llm/llm-usecases.test.ts`:

```ts
describe('GET /llm/usecase-default vision field (#1154)', () => {
  it('returns the cached capability verdict', async () => {
    mockGetVisionCapability.mockResolvedValue(true);
    const res = await app.inject({ method: 'GET', url: '/llm/usecase-default?usecase=chat' });
    expect(res.statusCode).toBe(200);
    expect(res.json().vision).toBe(true);
  });

  it('passes null through rather than coercing it to false', async () => {
    mockGetVisionCapability.mockResolvedValue(null);
    const res = await app.inject({ method: 'GET', url: '/llm/usecase-default?usecase=chat' });
    expect(res.json().vision).toBeNull();
  });

  it('validates the response against UsecaseDefaultSchema', async () => {
    mockGetVisionCapability.mockResolvedValue(false);
    const res = await app.inject({ method: 'GET', url: '/llm/usecase-default?usecase=chat' });
    expect(() => UsecaseDefaultSchema.parse(res.json())).not.toThrow();
  });
});
```

Add the module mock beside the file's existing mocks:

```ts
const mockGetVisionCapability = vi.fn();
vi.mock('../../domains/llm/services/model-capabilities.js', () => ({
  getVisionCapability: (...args: unknown[]) => mockGetVisionCapability(...args),
}));
```

and `UsecaseDefaultSchema` to its `@compendiq/contracts` import.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && npx vitest run src/routes/llm/llm-usecases.test.ts`
Expected: FAIL — `vision` is `undefined`.

- [ ] **Step 3: Return `vision` and validate the response**

Replace the return in the `/llm/usecase-default` handler (`:27-33`) with:

```ts
      const resolved = await resolveUsecase(usecase);
      // #1154: read-only — never probes on this path, so AiContext's
      // mount-time fetch is not gated on an LLM round-trip.
      const vision = await getVisionCapability(resolved.config.providerId, resolved.model);
      return UsecaseDefaultSchema.parse({
        usecase,
        providerId: resolved.config.providerId,
        providerName: resolved.config.name,
        model: resolved.model,
        vision,
      });
```

Add `getVisionCapability` and `UsecaseDefaultSchema` to the imports.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && npx vitest run src/routes/llm/llm-usecases.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/llm/llm-usecases.ts backend/src/routes/llm/llm-usecases.test.ts
git commit -m "feat(llm): expose vision capability on usecase-default (#1154)"
```

---

### Task 8: Image staging — Redis store and `POST /llm/prepare-image`

**Files:**
- Create: `backend/src/core/services/image-staging.ts`
- Create: `backend/src/routes/llm/prepare-image.ts`
- Create: `backend/src/routes/llm/prepare-image.test.ts`
- Modify: wherever `extractDocumentRoutes` is registered (find with the grep in Step 6)

**Interfaces:**
- Consumes: `validateImage`, `MAX_IMAGE_BYTES` from Task 4; `getRedisClient` from `core/services/redis-cache.js`; `PrepareImageResponseSchema` from Task 1.
- Produces:
  - `stageImage(userId: string, buf: Buffer, format: ImageFormat): Promise<string>` returning the sha256 handle
  - `loadStagedImage(userId: string, handle: string): Promise<{ bytes: Buffer; format: ImageFormat } | null>`
  - `STAGED_IMAGE_TTL_SECONDS = 900`
  - `prepareImageRoutes(fastify)` registering `POST /llm/prepare-image`

- [ ] **Step 1: Write the failing staging-store test**

Create `backend/src/core/services/image-staging.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = new Map<string, string>();
const mockRedis = {
  set: vi.fn(async (k: string, v: string) => { store.set(k, v); return 'OK'; }),
  get: vi.fn(async (k: string) => store.get(k) ?? null),
};
let redisAvailable = true;

vi.mock('./redis-cache.js', () => ({
  getRedisClient: () => (redisAvailable ? mockRedis : null),
}));

import { stageImage, loadStagedImage, STAGED_IMAGE_TTL_SECONDS } from './image-staging.js';
import { buildPng } from './test-image-fixtures.js';

beforeEach(() => {
  store.clear();
  mockRedis.set.mockClear();
  redisAvailable = true;
});

describe('image staging', () => {
  it('returns a 64-char lowercase hex handle', async () => {
    const handle = await stageImage('u1', buildPng(8, 8), 'png');
    expect(handle).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is content-addressed — identical bytes yield the same handle', async () => {
    const a = await stageImage('u1', buildPng(8, 8), 'png');
    const b = await stageImage('u1', buildPng(8, 8), 'png');
    expect(a).toBe(b);
  });

  it('gives different handles to different images', async () => {
    const a = await stageImage('u1', buildPng(8, 8), 'png');
    const b = await stageImage('u1', buildPng(16, 16), 'png');
    expect(a).not.toBe(b);
  });

  it('scopes the key by user id', async () => {
    const handle = await stageImage('u1', buildPng(8, 8), 'png');
    expect(mockRedis.set.mock.calls[0]![0]).toBe(`llm:img:u1:${handle}`);
  });

  it('sets the TTL', async () => {
    await stageImage('u1', buildPng(8, 8), 'png');
    expect(mockRedis.set.mock.calls[0]![2]).toEqual({ EX: STAGED_IMAGE_TTL_SECONDS });
  });

  it('round-trips bytes and format', async () => {
    const png = buildPng(8, 8);
    const handle = await stageImage('u1', png, 'png');
    const loaded = await loadStagedImage('u1', handle);
    expect(loaded!.format).toBe('png');
    expect(loaded!.bytes.equals(png)).toBe(true);
  });

  /** One user must never be able to reference another's staged bytes. */
  it('does not load another user\'s handle', async () => {
    const handle = await stageImage('u1', buildPng(8, 8), 'png');
    expect(await loadStagedImage('u2', handle)).toBeNull();
  });

  it('returns null for an unknown handle', async () => {
    expect(await loadStagedImage('u1', 'f'.repeat(64))).toBeNull();
  });

  it('does not consume the entry on load, so a retry works', async () => {
    const handle = await stageImage('u1', buildPng(8, 8), 'png');
    expect(await loadStagedImage('u1', handle)).not.toBeNull();
    expect(await loadStagedImage('u1', handle)).not.toBeNull();
  });

  it('throws when Redis is unavailable', async () => {
    redisAvailable = false;
    await expect(stageImage('u1', buildPng(8, 8), 'png')).rejects.toThrow(/unavailable/i);
  });

  it('returns null on load when Redis is unavailable', async () => {
    redisAvailable = false;
    expect(await loadStagedImage('u1', 'a'.repeat(64))).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && npx vitest run src/core/services/image-staging.test.ts`
Expected: FAIL — cannot resolve `./image-staging.js`.

- [ ] **Step 3: Implement the staging store**

Create `backend/src/core/services/image-staging.ts`:

```ts
import { createHash } from 'crypto';
import type { ImageFormat } from '@compendiq/contracts';
import { getRedisClient } from './redis-cache.js';

/**
 * #1154: short-lived staging for an image awaiting a generate/improve call.
 *
 * Content-addressed and scoped by user: `llm:img:<userId>:<sha256>`. The user
 * scope is what makes cross-user reference impossible, so a handle leak can't
 * expose another user's bytes and the 410/422 paths can't probe for them.
 *
 * The entry is NOT consumed on read — a regenerate or retry inside the TTL
 * should not require re-uploading. Expiry is the only removal path.
 */

export const STAGED_IMAGE_TTL_SECONDS = 900; // 15 minutes

export class ImageStagingUnavailableError extends Error {
  constructor() {
    super('Image staging is unavailable because Redis is not reachable');
    this.name = 'ImageStagingUnavailableError';
  }
}

function keyFor(userId: string, handle: string): string {
  return `llm:img:${userId}:${handle}`;
}

interface StoredImage {
  format: ImageFormat;
  base64: string;
}

export async function stageImage(
  userId: string,
  bytes: Buffer,
  format: ImageFormat,
): Promise<string> {
  const redis = getRedisClient();
  if (!redis) throw new ImageStagingUnavailableError();

  const handle = createHash('sha256').update(bytes).digest('hex');
  const payload: StoredImage = { format, base64: bytes.toString('base64') };
  await redis.set(keyFor(userId, handle), JSON.stringify(payload), {
    EX: STAGED_IMAGE_TTL_SECONDS,
  });
  return handle;
}

export async function loadStagedImage(
  userId: string,
  handle: string,
): Promise<{ bytes: Buffer; format: ImageFormat } | null> {
  const redis = getRedisClient();
  if (!redis) return null;

  const raw = await redis.get(keyFor(userId, handle));
  if (!raw) return null;

  const parsed = JSON.parse(raw) as StoredImage;
  return { bytes: Buffer.from(parsed.base64, 'base64'), format: parsed.format };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && npx vitest run src/core/services/image-staging.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Write the failing route test**

Create `backend/src/routes/llm/prepare-image.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import multipart from '@fastify/multipart';

const mockLogAuditEvent = vi.fn();
vi.mock('../../core/services/audit-service.js', () => ({
  logAuditEvent: (...args: unknown[]) => mockLogAuditEvent(...args),
}));

vi.mock('../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../core/services/rate-limit-service.js', () => ({
  getRateLimits: async () => ({ llmEmbedding: { max: 1000 } }),
}));

const mockStageImage = vi.fn();
vi.mock('../../core/services/image-staging.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/services/image-staging.js')>();
  return { ...actual, stageImage: (...args: unknown[]) => mockStageImage(...args) };
});

import { prepareImageRoutes } from './prepare-image.js';
import { createMultipartPayload } from '../../core/services/test-document-fixtures.js';
import { buildPng, buildJpeg, SVG_BYTES } from '../../core/services/test-image-fixtures.js';
import { ImageStagingUnavailableError } from '../../core/services/image-staging.js';

const HANDLE = 'a'.repeat(64);

async function startApp() {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  await app.register(multipart, {
    limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 0 },
  });
  app.decorate('authenticate', async () => {});
  app.decorateRequest('userId', '');
  app.addHook('onRequest', async (req) => { (req as { userId: string }).userId = 'u1'; });
  await app.register(prepareImageRoutes);
  await app.ready();
  return app;
}

async function post(app: Awaited<ReturnType<typeof startApp>>, filename: string, content: Buffer) {
  const { body, boundary } = createMultipartPayload(filename, content);
  return app.inject({
    method: 'POST',
    url: '/llm/prepare-image',
    payload: body,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  });
}

beforeEach(() => {
  mockStageImage.mockReset().mockResolvedValue(HANDLE);
  mockLogAuditEvent.mockReset();
});

describe('POST /llm/prepare-image', () => {
  it('accepts a PNG and returns the handle with sniffed metadata', async () => {
    const app = await startApp();
    const res = await post(app, 'shot.png', buildPng(800, 600));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      handle: HANDLE, format: 'png', width: 800, height: 600,
      fileSize: buildPng(800, 600).length,
    });
  });

  it('accepts a JPEG', async () => {
    const app = await startApp();
    const res = await post(app, 'photo.jpg', buildJpeg(64, 48));
    expect(res.statusCode).toBe(200);
    expect(res.json().format).toBe('jpeg');
  });

  it('refuses SVG with 415', async () => {
    const app = await startApp();
    const res = await post(app, 'diagram.svg', SVG_BYTES);
    expect(res.statusCode).toBe(415);
  });

  it('refuses a PDF with 415', async () => {
    const app = await startApp();
    const res = await post(app, 'doc.pdf', Buffer.from('%PDF-1.7\n'));
    expect(res.statusCode).toBe(415);
  });

  it('refuses PNG bytes claiming .jpg with 415', async () => {
    const app = await startApp();
    const res = await post(app, 'sneaky.jpg', buildPng(8, 8));
    expect(res.statusCode).toBe(415);
  });

  it('refuses oversized dimensions with 422', async () => {
    const app = await startApp();
    const res = await post(app, 'huge.png', buildPng(5000, 10));
    expect(res.statusCode).toBe(422);
  });

  it('returns 400 when no file is uploaded', async () => {
    const app = await startApp();
    const res = await app.inject({
      method: 'POST', url: '/llm/prepare-image',
      payload: '', headers: { 'content-type': 'multipart/form-data; boundary=x' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 503 when staging is unavailable', async () => {
    mockStageImage.mockRejectedValue(new ImageStagingUnavailableError());
    const app = await startApp();
    const res = await post(app, 'shot.png', buildPng(8, 8));
    expect(res.statusCode).toBe(503);
  });

  it('audits a successful staging without logging bytes', async () => {
    const app = await startApp();
    await post(app, 'shot.png', buildPng(8, 8));

    const [, action, , , meta] = mockLogAuditEvent.mock.calls[0]!;
    expect(action).toBe('IMAGE_PREPARED');
    expect(meta).toMatchObject({ format: 'png', width: 8, height: 8 });
    expect(JSON.stringify(meta)).not.toContain('base64');
  });
});
```

- [ ] **Step 6: Find the route registration site**

Run: `cd backend && grep -rn "extractDocumentRoutes" src/ --include=*.ts | grep -v test`
Note the file and pattern — the new route registers the same way.

- [ ] **Step 7: Implement the route**

Create `backend/src/routes/llm/prepare-image.ts`:

```ts
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { PrepareImageResponseSchema } from '@compendiq/contracts';
import { logAuditEvent } from '../../core/services/audit-service.js';
import { logger } from '../../core/utils/logger.js';
import { getRateLimits } from '../../core/services/rate-limit-service.js';
import {
  validateImage,
  ImageValidationError,
  MAX_IMAGE_BYTES,
} from '../../core/services/image-validator.js';
import {
  stageImage,
  ImageStagingUnavailableError,
} from '../../core/services/image-staging.js';

const PREPARE_IMAGE_PATH = '/llm/prepare-image';

/**
 * Stages an uploaded image for use as LLM source material (#1154).
 *
 * Structured exactly like extract-document.ts: this handler owns only the HTTP
 * concerns — upload limits, status mapping, audit, rate limiting — while the
 * byte rules live in core/services/image-validator.ts. Unlike the document
 * path there is no text to sanitise: prompt injection rendered as pixels
 * bypasses sanitizeLlmInput entirely, which is a documented accepted risk in
 * the design of record, not something this route can mitigate.
 */
export async function prepareImageRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  const handler = async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.userId;

    const data = await request.file({
      limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 0 },
    });
    if (!data) throw fastify.httpErrors.badRequest('No file uploaded');

    let buffer: Buffer;
    try {
      buffer = await data.toBuffer();
    } catch {
      throw fastify.httpErrors.payloadTooLarge('Image exceeds 10 MB limit');
    }
    if (data.file.truncated) {
      throw fastify.httpErrors.payloadTooLarge('Image exceeds 10 MB limit');
    }

    // The validator decides the format from the bytes; `data.mimetype` is
    // client-supplied and deliberately never consulted.
    let validated;
    try {
      validated = validateImage(buffer, data.filename);
    } catch (err) {
      if (err instanceof ImageValidationError) {
        if (err.kind === 'mediaType') {
          throw fastify.httpErrors.unsupportedMediaType(err.message);
        }
        logger.warn({ filename: data.filename, reason: err.message }, 'Image rejected');
        throw fastify.httpErrors.unprocessableEntity(err.message);
      }
      logger.error({ err }, 'Image validation failed');
      throw fastify.httpErrors.unprocessableEntity('Failed to validate image');
    }

    let handle: string;
    try {
      handle = await stageImage(userId, buffer, validated.format);
    } catch (err) {
      if (err instanceof ImageStagingUnavailableError) {
        throw fastify.httpErrors.serviceUnavailable(err.message);
      }
      throw err;
    }

    await logAuditEvent(userId, 'IMAGE_PREPARED', 'llm', undefined, {
      filename: data.filename,
      format: validated.format,
      width: validated.width,
      height: validated.height,
      fileSize: buffer.length,
    }, request);

    return reply.send(PrepareImageResponseSchema.parse({
      handle,
      format: validated.format,
      width: validated.width,
      height: validated.height,
      fileSize: buffer.length,
    }));
  };

  fastify.post(PREPARE_IMAGE_PATH, {
    config: {
      rateLimit: {
        max: async () => (await getRateLimits()).llmEmbedding.max,
        timeWindow: '1 minute',
      },
    },
  }, handler);
}
```

- [ ] **Step 8: Register the route**

Register `prepareImageRoutes` alongside `extractDocumentRoutes` at the site found in Step 6.

- [ ] **Step 9: Run the route test**

Run: `cd backend && npx vitest run src/routes/llm/prepare-image.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 10: Commit**

```bash
git add backend/src/core/services/image-staging.ts \
        backend/src/core/services/image-staging.test.ts \
        backend/src/routes/llm/prepare-image.ts \
        backend/src/routes/llm/prepare-image.test.ts
git add -u
git commit -m "feat(llm): POST /llm/prepare-image with per-user staged handles (#1154)"
```

---

### Task 9: Consume the image in generate and improve

**Files:**
- Modify: `backend/src/domains/llm/services/llm-cache.ts:38-48`
- Modify: `backend/src/routes/llm/_helpers.ts`
- Modify: `backend/src/routes/llm/llm-generate.ts:44,133,148,150-152`
- Modify: `backend/src/routes/llm/llm-improve.ts:48,168,176,222`
- Create: `backend/src/routes/llm/resolve-image-part.test.ts`
- Create: `backend/src/routes/llm/generate-with-image.test.ts`
- Create: `backend/src/routes/llm/improve-with-image.test.ts`
- Modify: `backend/src/domains/llm/services/llm-cache.test.ts`

**Interfaces:**
- Consumes: `loadStagedImage` (Task 8), `getVisionCapability` (Task 6), `ChatContentPart` (Task 2).
- Produces:
  - `buildLlmCacheKey(..., options?: { thinking?: boolean; imageHash?: string })`
  - `resolveImagePart(fastify, userId, imageHandle, providerId, model): Promise<{ part: ChatContentPart; hash: string }>` in `_helpers.ts`
  - both routes accept `imageHandle`

**Amended before execution (2026-07-29).** The first draft of this task inlined
the same ~20-line gate-and-load block into both routes and copied the test file.
That is duplication of a logic block, and it would let the 422 and 410 semantics
drift between Generate and Improve. The gate now lives once, in `_helpers.ts`
beside the other shared route helpers.

- [ ] **Step 1: Write the failing cache-key test**

Add to `backend/src/domains/llm/services/llm-cache.test.ts`:

```ts
describe('buildLlmCacheKey imageHash (#1154)', () => {
  /**
   * Without the image in the key, two different images sharing one prompt
   * collide and the second request is served the first image's answer.
   */
  it('produces different keys for different images with one prompt', () => {
    const a = buildLlmCacheKey('m', 'sys', 'user', 'p', { imageHash: 'a'.repeat(64) });
    const b = buildLlmCacheKey('m', 'sys', 'user', 'p', { imageHash: 'b'.repeat(64) });
    expect(a).not.toBe(b);
  });

  it('differs from the same prompt with no image', () => {
    const withImage = buildLlmCacheKey('m', 'sys', 'user', 'p', { imageHash: 'a'.repeat(64) });
    const without = buildLlmCacheKey('m', 'sys', 'user', 'p');
    expect(withImage).not.toBe(without);
  });

  it('is stable for the same image', () => {
    const opts = { imageHash: 'a'.repeat(64) };
    expect(buildLlmCacheKey('m', 'sys', 'user', 'p', opts))
      .toBe(buildLlmCacheKey('m', 'sys', 'user', 'p', opts));
  });

  it('leaves existing text-only keys unchanged', () => {
    expect(buildLlmCacheKey('m', 'sys', 'user', 'p'))
      .toBe(buildLlmCacheKey('m', 'sys', 'user', 'p', {}));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && npx vitest run src/domains/llm/services/llm-cache.test.ts`
Expected: FAIL — `imageHash` is not part of the key, so the first two cases produce equal keys.

- [ ] **Step 3: Fold the image hash into the key**

In `llm-cache.ts`, extend the options type and the hash inputs:

```ts
export function buildLlmCacheKey(
  model: string,
  systemPrompt: string,
  userContent: string,
  provider?: string,
  options?: { thinking?: boolean; imageHash?: string },
): string {
  const providerSuffix = provider ? `provider:${provider}` : '';
  const thinkingSuffix = options?.thinking ? 'think:1' : '';
  // #1154: without this, two different images sharing a prompt collide and
  // the second caller is served the first image's answer.
  const imageSuffix = options?.imageHash ? `img:${options.imageHash}` : '';
  return KEY_PREFIX + hashLlmInputs(
    model, systemPrompt, userContent, providerSuffix, thinkingSuffix, imageSuffix,
  );
}
```

- [ ] **Step 4: Run the cache test to verify it passes**

Run: `cd backend && npx vitest run src/domains/llm/services/llm-cache.test.ts`
Expected: PASS.

- [ ] **Step 4a: Write the failing helper test**

Create `backend/src/routes/llm/resolve-image-part.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetVisionCapability = vi.fn();
vi.mock('../../domains/llm/services/model-capabilities.js', () => ({
  getVisionCapability: (...args: unknown[]) => mockGetVisionCapability(...args),
}));

const mockLoadStagedImage = vi.fn();
vi.mock('../../core/services/image-staging.js', () => ({
  loadStagedImage: (...args: unknown[]) => mockLoadStagedImage(...args),
}));

import { resolveImagePart } from './_helpers.js';

const HANDLE = 'a'.repeat(64);

/** Minimal stand-in for the httpErrors decorator the routes rely on. */
class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const fastify = {
  httpErrors: {
    unprocessableEntity: (m: string) => new HttpError(422, m),
    gone: (m: string) => new HttpError(410, m),
  },
} as never;

beforeEach(() => {
  mockGetVisionCapability.mockReset().mockResolvedValue(true);
  mockLoadStagedImage.mockReset().mockResolvedValue({
    bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]), format: 'png',
  });
});

describe('resolveImagePart', () => {
  it('returns an image_url part with a data URI of the staged bytes', async () => {
    const { part } = await resolveImagePart(fastify, 'u1', HANDLE, 'p1', 'qwen2.5vl');
    expect(part.type).toBe('image_url');
    expect((part as { image_url: { url: string } }).image_url.url)
      .toBe(`data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')}`);
  });

  it('returns the handle as the cache hash', async () => {
    const { hash } = await resolveImagePart(fastify, 'u1', HANDLE, 'p1', 'm');
    expect(hash).toBe(HANDLE);
  });

  it('uses the staged format in the data URI, not the extension', async () => {
    mockLoadStagedImage.mockResolvedValue({ bytes: Buffer.from([0xff]), format: 'webp' });
    const { part } = await resolveImagePart(fastify, 'u1', HANDLE, 'p1', 'm');
    expect((part as { image_url: { url: string } }).image_url.url).toMatch(/^data:image\/webp;/);
  });

  it('throws 422 when the model is text-only', async () => {
    mockGetVisionCapability.mockResolvedValue(false);
    await expect(resolveImagePart(fastify, 'u1', HANDLE, 'p1', 'llama3.1'))
      .rejects.toMatchObject({ status: 422 });
  });

  /** Fail closed: unknown is refused, not attempted. */
  it('throws 422 when capability is unknown', async () => {
    mockGetVisionCapability.mockResolvedValue(null);
    await expect(resolveImagePart(fastify, 'u1', HANDLE, 'p1', 'm'))
      .rejects.toMatchObject({ status: 422 });
  });

  it('names the offending model in the 422 message', async () => {
    mockGetVisionCapability.mockResolvedValue(false);
    await expect(resolveImagePart(fastify, 'u1', HANDLE, 'p1', 'llama3.1'))
      .rejects.toThrow(/llama3\.1/);
  });

  it('does not load the image when the gate refuses', async () => {
    mockGetVisionCapability.mockResolvedValue(false);
    await resolveImagePart(fastify, 'u1', HANDLE, 'p1', 'm').catch(() => {});
    expect(mockLoadStagedImage).not.toHaveBeenCalled();
  });

  it('throws 410 when the handle has expired', async () => {
    mockLoadStagedImage.mockResolvedValue(null);
    await expect(resolveImagePart(fastify, 'u1', HANDLE, 'p1', 'm'))
      .rejects.toMatchObject({ status: 410 });
  });

  it('scopes the staged lookup to the calling user', async () => {
    await resolveImagePart(fastify, 'u7', HANDLE, 'p1', 'm');
    expect(mockLoadStagedImage).toHaveBeenCalledWith('u7', HANDLE);
  });
});
```

- [ ] **Step 4b: Run it to verify it fails**

Run: `cd backend && npx vitest run src/routes/llm/resolve-image-part.test.ts`
Expected: FAIL — `resolveImagePart` is not exported from `./_helpers.js`.

- [ ] **Step 4c: Implement the shared helper**

Append to `backend/src/routes/llm/_helpers.ts`:

```ts
/**
 * #1154: gate on vision capability, then load the staged image as a content
 * part.
 *
 * Shared by /llm/generate and /llm/improve so the 422 and 410 semantics exist
 * in exactly one place — an earlier draft inlined this in both routes, which
 * would have let the two drift apart.
 *
 * Order matters: the capability check runs before the Redis lookup, so a
 * refusal costs neither a load nor a provider round-trip.
 */
export async function resolveImagePart(
  fastify: FastifyInstance,
  userId: string,
  imageHandle: string,
  providerId: string,
  model: string,
): Promise<{ part: ChatContentPart; hash: string }> {
  const vision = await getVisionCapability(providerId, model);
  if (vision !== true) {
    throw fastify.httpErrors.unprocessableEntity(
      `The model assigned to chat (${model}) cannot accept images. ` +
      'Assign a vision-capable model in Settings → LLM.',
    );
  }

  const staged = await loadStagedImage(userId, imageHandle);
  if (!staged) {
    throw fastify.httpErrors.gone('The staged image has expired. Attach it again.');
  }

  return {
    part: {
      type: 'image_url',
      image_url: {
        url: `data:image/${staged.format};base64,${staged.bytes.toString('base64')}`,
      },
    },
    // The handle *is* the sha256 of the bytes, so it doubles as the cache
    // input. If handles ever stop being content-addressed, hash the bytes here.
    hash: imageHandle,
  };
}
```

Add the imports it needs: `FastifyInstance` from `fastify`, `ChatContentPart` from `../../domains/llm/services/prompts.js`, `getVisionCapability` from `../../domains/llm/services/model-capabilities.js`, `loadStagedImage` from `../../core/services/image-staging.js`.

- [ ] **Step 4d: Run the test to verify it passes**

Run: `cd backend && npx vitest run src/routes/llm/resolve-image-part.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Write the failing route test**

Create `backend/src/routes/llm/generate-with-image.test.ts`, modelled on the existing `generate-with-document.test.ts` harness (read it first and copy its app setup and mock layout verbatim, adding these mocks):

```ts
const mockGetVisionCapability = vi.fn();
vi.mock('../../domains/llm/services/model-capabilities.js', () => ({
  getVisionCapability: (...args: unknown[]) => mockGetVisionCapability(...args),
}));

const mockLoadStagedImage = vi.fn();
vi.mock('../../core/services/image-staging.js', () => ({
  loadStagedImage: (...args: unknown[]) => mockLoadStagedImage(...args),
}));
```

with these cases:

```ts
const HANDLE = 'a'.repeat(64);

describe('POST /llm/generate with an image (#1154)', () => {
  beforeEach(() => {
    mockGetVisionCapability.mockReset().mockResolvedValue(true);
    mockLoadStagedImage.mockReset().mockResolvedValue({
      bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]), format: 'png',
    });
  });

  it('sends the image as a content part on the user message', async () => {
    await inject({ prompt: 'describe this', imageHandle: HANDLE });

    const messages = mockStreamChat.mock.calls[0]![2];
    const user = messages.find((m: { role: string }) => m.role === 'user');
    expect(Array.isArray(user.content)).toBe(true);
    expect(user.content.some((p: { type: string }) => p.type === 'image_url')).toBe(true);
  });

  it('keeps the system message a plain string', async () => {
    await inject({ prompt: 'x', imageHandle: HANDLE });
    const messages = mockStreamChat.mock.calls[0]![2];
    expect(typeof messages.find((m: { role: string }) => m.role === 'system').content).toBe('string');
  });

  it('sends a bare string when no image is attached', async () => {
    await inject({ prompt: 'x' });
    const messages = mockStreamChat.mock.calls[0]![2];
    expect(typeof messages.find((m: { role: string }) => m.role === 'user').content).toBe('string');
  });

  it('422s when the resolved model is text-only', async () => {
    mockGetVisionCapability.mockResolvedValue(false);
    const res = await inject({ prompt: 'x', imageHandle: HANDLE });
    expect(res.statusCode).toBe(422);
  });

  /** Fail closed: unknown is refused, not attempted. */
  it('422s when capability is unknown', async () => {
    mockGetVisionCapability.mockResolvedValue(null);
    const res = await inject({ prompt: 'x', imageHandle: HANDLE });
    expect(res.statusCode).toBe(422);
  });

  it('does not call the provider when the gate refuses', async () => {
    mockGetVisionCapability.mockResolvedValue(false);
    await inject({ prompt: 'x', imageHandle: HANDLE });
    expect(mockStreamChat).not.toHaveBeenCalled();
  });

  it('410s when the handle has expired', async () => {
    mockLoadStagedImage.mockResolvedValue(null);
    const res = await inject({ prompt: 'x', imageHandle: HANDLE });
    expect(res.statusCode).toBe(410);
  });

  it('400s on a malformed handle before any lookup', async () => {
    const res = await inject({ prompt: 'x', imageHandle: 'not-a-handle' });
    expect(res.statusCode).toBe(400);
    expect(mockLoadStagedImage).not.toHaveBeenCalled();
  });

  it('does not check capability when no image is attached', async () => {
    await inject({ prompt: 'x' });
    expect(mockGetVisionCapability).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cd backend && npx vitest run src/routes/llm/generate-with-image.test.ts`
Expected: FAIL — `imageHandle` is ignored, so the user content is still a string.

- [ ] **Step 7: Implement the image path in `llm-generate.ts`**

Destructure `imageHandle` at `:44`. After the `resolveUsecase('chat')` call at `:133`, insert:

```ts
    // #1154: gate and load before the cache lookup, so the key can include
    // the image and a refusal never costs a provider round-trip.
    let imagePart: ChatContentPart | undefined;
    let imageHash: string | undefined;
    if (imageHandle) {
      const resolved = await resolveImagePart(
        fastify, userId, imageHandle, chatConfig.providerId, resolvedModel,
      );
      imagePart = resolved.part;
      imageHash = resolved.hash;
    }
```

Pass `imageHash` into the cache key at `:141`, and build the messages at `:148-151` as:

```ts
    const generateMessages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: imagePart
          ? [{ type: 'text', text: userContent }, imagePart]
          : userContent,
      },
    ];
```

Add `ChatContentPart` and `ChatMessage` from `prompts.js`, and `resolveImagePart` from `./_helpers.js`, to the imports.

- [ ] **Step 8: Run the test to verify it passes**

Run: `cd backend && npx vitest run src/routes/llm/generate-with-image.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 9: Wire `llm-improve.ts` through the same helper**

Destructure `imageHandle` at `:48`; call `resolveImagePart` after `:168` exactly as
Generate does; pass `imageHash` into the cache key at `:176`; build
`improveMessages` at `:222` with the same conditional array.

Then create `improve-with-image.test.ts`. It covers **only the wiring** — the gate
and expiry semantics are already tested once in `resolve-image-part.test.ts` and
must not be re-asserted here. Four cases, on the existing improve test harness:

```ts
describe('POST /llm/improve with an image (#1154)', () => {
  it('sends the image as a content part on the user message', async () => {
    await inject({ content: 'x', type: 'clarity', imageHandle: HANDLE });
    const user = mockStreamChat.mock.calls[0]![2]
      .find((m: { role: string }) => m.role === 'user');
    expect(user.content.some((p: { type: string }) => p.type === 'image_url')).toBe(true);
  });

  it('sends a bare string when no image is attached', async () => {
    await inject({ content: 'x', type: 'clarity' });
    const user = mockStreamChat.mock.calls[0]![2]
      .find((m: { role: string }) => m.role === 'user');
    expect(typeof user.content).toBe('string');
  });

  it('propagates the helper refusal as a 422', async () => {
    mockGetVisionCapability.mockResolvedValue(false);
    const res = await inject({ content: 'x', type: 'clarity', imageHandle: HANDLE });
    expect(res.statusCode).toBe(422);
  });

  it('folds the image into the cache key', async () => {
    await inject({ content: 'x', type: 'clarity', imageHandle: HANDLE });
    const withImage = mockCheckCacheWithLock.mock.calls[0]![1];
    mockCheckCacheWithLock.mockClear();
    await inject({ content: 'x', type: 'clarity' });
    expect(mockCheckCacheWithLock.mock.calls[0]![1]).not.toBe(withImage);
  });
});
```

If the improve harness does not already spy on the cache lookup, drop the fourth
case rather than restructuring the harness — `llm-cache.test.ts` already proves
the key diverges.

- [ ] **Step 10: Run both image route suites**

Run: `cd backend && npx vitest run src/routes/llm/generate-with-image.test.ts src/routes/llm/improve-with-image.test.ts`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add backend/src/domains/llm/services/llm-cache.ts \
        backend/src/domains/llm/services/llm-cache.test.ts \
        backend/src/routes/llm/llm-generate.ts \
        backend/src/routes/llm/llm-improve.ts \
        backend/src/routes/llm/generate-with-image.test.ts \
        backend/src/routes/llm/improve-with-image.test.ts
git commit -m "feat(llm): accept a staged image in generate and improve (#1154)"
```

---

### Task 10: Persist the model that actually ran

**Files:**
- Modify: `backend/src/routes/llm/llm-ask.ts:262`
- Modify: `backend/src/routes/llm/llm-improve.ts:199`
- Modify: `backend/src/routes/llm/llm-ask.test.ts`

**Interfaces:**
- Consumes: `resolvedModel`, already in scope at both sites.
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

Add to `backend/src/routes/llm/llm-ask.test.ts`:

```ts
describe('conversation records the model that ran (#1154)', () => {
  /**
   * Ignoring body.model is deliberate (#929, ADR-021: resolved server-side).
   * Persisting the ignored value is not — it makes the row name a model that
   * did not produce the output, and disagrees with what the vision gate reads.
   */
  it('stores resolvedModel, not the ignored body model', async () => {
    await inject({ question: 'hi', model: 'client-picked-model' });

    const insert = mockQuery.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO llm_conversations'),
    );
    expect(insert![1]).toContain(RESOLVED_MODEL);
    expect(insert![1]).not.toContain('client-picked-model');
  });
});
```

Use whatever the file's harness already names the resolved model as `RESOLVED_MODEL`.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && npx vitest run src/routes/llm/llm-ask.test.ts`
Expected: FAIL — the params contain `client-picked-model`.

- [ ] **Step 3: Persist the resolved model**

At `llm-ask.ts:262` and `llm-improve.ts:199`, replace the `model` parameter passed to the INSERT with `resolvedModel`, adding at each site:

```ts
      // #1154: the body `model` is ignored on the call path by design (#929),
      // so persisting it would name a model that never ran. Record what did.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && npx vitest run src/routes/llm/llm-ask.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the improve suites for regressions**

Run: `cd backend && npx vitest run src/routes/llm/improve-instruction.test.ts src/routes/llm/improve-page-id.test.ts src/routes/llm/apply-improvement.test.ts`
Expected: PASS. A test asserting the old body-model value should be updated to the resolved model, not deleted.

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/llm/llm-ask.ts backend/src/routes/llm/llm-improve.ts
git add -u backend/src/routes/llm/
git commit -m "fix(llm): record the resolved model on conversations and improvements (#1154)"
```

---

### Task 11: Documentation

**Files:**
- Modify: `docs/ARCHITECTURE-DECISIONS.md` (ADR-021, from `:1164`)
- Modify: `docs/architecture/06-data-model.md`
- Modify: `docs/architecture/03-backend-domains.md`
- Modify: `docs/architecture/09-flow-rag-chat.md`
- Modify: `CLAUDE.md`
- Modify: `.env.example` only if a tunable was added (none is expected)

**Interfaces:** none.

- [ ] **Step 1: Amend ADR-021**

Append a "#1154 — image input and model capability" subsection recording: capability is per `(provider_id, model)` and never per provider; it is probed with a known-content image because `/v1/models` has no capability field and native `/api/show` is off-limits; `null` means undetermined and is refused; and **prompt injection rendered as pixels bypasses `sanitizeLlmInput` and is an accepted risk** with no mitigation short of OCR.

- [ ] **Step 2: Add the table to the data model diagram**

Add `llm_model_capabilities` to `06-data-model.md` with its FK to `llm_providers` marked `CASCADE`, contrasted against `llm_usecase_assignments`' `RESTRICT`.

- [ ] **Step 3: Add the new services to the domains diagram**

In `03-backend-domains.md`, add `core/services/image-validator.ts` and `core/services/image-staging.ts` under `core`, and `domains/llm/services/vision-probe.ts` and `model-capabilities.ts` under `llm`. Confirm no arrow implies `llm → confluence`.

- [ ] **Step 4: Add the staging hop to the chat flow diagram**

In `09-flow-rag-chat.md`, add the `prepare-image` → Redis handle → generate/improve hop, including the 422 gate and the 410 expiry branch.

- [ ] **Step 5: Update CLAUDE.md**

Extend the Content Pipeline section's uploaded-documents paragraph with a sibling note: images enter via `POST /api/llm/prepare-image`, are staged in Redis under a per-user content-addressed handle, are refused unless the resolved `chat` model probes vision-capable, and SVG is never accepted.

- [ ] **Step 6: Verify the whole suite and the gates**

```bash
npm run build -w @compendiq/contracts
npm run lint && npm run typecheck
npm test
```
Expected: all green. The ESLint boundaries plugin must report no violation — `domains/llm` importing `core/services/image-staging.js` is legal; `core` importing anything from `domains/` is not.

- [ ] **Step 7: Commit**

```bash
git add docs/ CLAUDE.md
git commit -m "docs(ai): record image input in ADR-021 and the architecture diagrams (#1154)"
```

---

## Self-Review

**Spec coverage.** Every section of the design of record maps to a task: the type change → 2; staging endpoint and its 503 → 8; single-image and non-consuming-handle rules → 8; contracts → 1; probe, verdict table, residual rate → 5; storage and migration 087 → 3; probe timing and cache-bus invalidation → 6; gating and the fail-closed backend re-check → 7 and 9; "the model shown is the model used" → 10; formats, SVG refusal, dimensions, ceilings → 4; per-user handle scoping and audit → 8; the pixel-injection accepted risk → 8's route comment and 11's ADR amendment; the cache-key trap → 9; delivery and docs → 11.

Two spec items are deliberately **not** in this plan because they are PR 2 (frontend): the client-side canvas downscale, and the Settings → LLM capability badge with its re-probe action. `refreshVisionCapability` is exported in Task 6 specifically so PR 2's re-probe action has an entry point.

**Placeholder scan.** No TBD/TODO, no "add error handling", no "similar to Task N". Three steps direct the implementer to read an existing file before writing (Task 5 Step 4 on `StreamChatOptions`, Task 6 Step 4 on `loadProviderConfig`, Task 8 Step 6 on the registration site, Task 9 Step 5 on the generate harness) — these are verification steps against code whose exact current shape must be confirmed, not deferred decisions, and each states what to do in both outcomes.

**Type consistency.** `ImageFormat` from contracts is used in `image-validator.ts`, `image-staging.ts` and the route. `ChatContentPart` is defined once in Task 2 and consumed by Tasks 5 and 9. `getVisionCapability` / `refreshVisionCapability` / `invalidateProviderCapabilities` are named identically in Tasks 6, 7 and 9. `loadStagedImage` and `stageImage` match between Task 8's definition and Task 9's use. `imageHash` is the option name in both `llm-cache.ts` and both route call sites. `ImageValidationError.kind` uses the same `'mediaType' | 'unprocessable'` union as `DocumentExtractionErrorKind`, so the route's status mapping mirrors `extract-document.ts`.

One naming decision worth flagging for the implementer: the route passes `imageHandle` as the `imageHash` cache input because the handle *is* the sha256 of the bytes. If a future change makes the handle non-content-addressed, that equivalence breaks and the cache key must hash the bytes separately.
