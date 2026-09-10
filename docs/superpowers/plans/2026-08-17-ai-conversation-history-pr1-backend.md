# Saved Conversations — PR 1 (backend + contracts + migration) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden and widen the conversation persistence behind `POST /llm/ask` and `GET/PATCH/DELETE /llm/conversations` so a per-conversation UI can be built on it — with no UI change in this PR.

**Architecture:** One migration (094) adds `page_ref` (INTEGER FK, replaces the dead `page_id TEXT`), `title_source`, and a `(user_id, updated_at DESC, id DESC)` index. `packages/contracts` gets the conversation schemas the frontend will import. `llm-ask.ts` writes `page_ref` (resolved and authorised) at INSERT, appends turns atomically with `jsonb ||`, persists sources per assistant turn, refuses a stale `conversationId` with a 404 before streaming, titles on a word boundary, and bounds history replay with a pure token-budget walk that also reports `historyTruncated`. `llm-conversations.ts` gains keyset pagination, `PATCH` rename (`title_source = 'user'`, no `updated_at` bump), `.uuid()` id params, `historyTruncated` and read-time `unavailable` source annotation on `GET :id`.

**Tech Stack:** Fastify 5, node-pg (`query` from `core/db/postgres.ts`), Zod (`@compendiq/contracts`), Vitest. Route tests mock `query`; the migration test hits the real Postgres on port 5433.

**Spec:** `docs/superpowers/specs/2026-08-17-ai-conversation-history-design.md` — sections *Backend*, *Read side*, *Migration and contracts*, *PR 1*. Read the spec first; every task below argues from it.

## Global Constraints

- Verified against `origin/dev` `7c3a7bf8`. Line numbers below are from that commit; re-check them if `dev` has moved.
- **Tests required for every change** (CLAUDE.md rule 1). Vitest everywhere. Backend DB tests hit real Postgres (5433, `test-db-helper.ts`); route tests mock `query` (the established idiom in `llm-ask.test.ts` / `llm-conversations.test.ts`). Never `--no-verify`.
- Branch from `dev` as `feature/<desc>`; the PR targets `dev`. Squash-merge; **do not stack** on another open PR.
- **Migration number:** `094` was free on 2026-08-17. Before creating the file run `git ls-tree --name-only origin/dev backend/src/core/db/migrations/ | tail -3` and take the next free number if `094` is taken; `migration-filenames.test.ts` fails on a shared `NNN[letter]` prefix.
- **`packages/contracts` ships a gitignored `dist/`**: after any edit under `packages/contracts/src`, run `npm run build -w @compendiq/contracts` or the backend will not see the new exports.
- Backend ESLint import boundaries: `routes/llm` may import `core/*` and `domains/llm/*`; `domains/llm` may import `core/*` only. `npm run lint -w backend` runs with `--max-warnings=0`, so remove unused imports.
- `HISTORY_REPLAY_TOKEN_BUDGET` is a **plain exported constant** (`4_000`), never an env var (CLAUDE.md: don't add env-driven LLM config).
- No new ADR-021 use case. (Title *generation* is PR 3; this PR only ships the `title_source` column and the PATCH that writes `'user'`.)
- The `.uuid()` id params turn a malformed id into a Zod `400`; route tests must mirror the production `ZodError → 400` handler (copy from `routes/foundation/notifications.test.ts:42-51`).
- Copy in this PR is server-side only: `'Conversation not found'`, `'Untitled conversation'`, `'Invalid cursor'`.
- Local DB caveat (project memory): the local `kb_creator_test` DB may fail migration tests for unrelated reasons (1600-column ceiling). `migration-filenames.test.ts` runs without a DB and must pass locally; `migrations.test.ts` is `describe.skipIf(!dbAvailable)` — if it cannot run locally, CI is the authority, and say so in the PR body.

---

### Task 0: Branch, install, baseline

**Files:**
- none (setup)

- [ ] **Step 1: Create the PR branch from the design branch** (it is `dev` + the spec + this plan)

Run:
```bash
cd /Users/simon/Documents/localGIT/compendiq-ce-wt-1361-design
git fetch origin dev
git checkout -b feature/1361-conversations-backend
git log --oneline -3
```
Expected: HEAD is the design-branch tip (spec + plan commits on top of `origin/dev`).

- [ ] **Step 2: Install workspaces (root only) and build contracts**

Run:
```bash
npm install
npm run build -w @compendiq/contracts
```
Expected: no errors; `packages/contracts/dist/` exists.

- [ ] **Step 3: Baseline the two route suites and the contracts suite**

Run:
```bash
cd backend && npx vitest run src/routes/llm/llm-ask.test.ts src/routes/llm/llm-conversations.test.ts && cd ..
npm run test -w @compendiq/contracts
cd backend && npx vitest run src/core/db/migrations/__tests__/migration-filenames.test.ts && cd ..
```
Expected: all PASS. If `llm-ask.test.ts` is red before you touch anything, stop and report — do not proceed on a red baseline.

- [ ] **Step 4: Confirm the migration number is free**

Run: `git ls-tree --name-only origin/dev backend/src/core/db/migrations/ | grep -E '^backend/src/core/db/migrations/09[0-9]' | tail -3`
Expected: the highest is `093_page_image_embeddings.sql`. If `094` exists, use the next free number everywhere this plan says `094`.

---

### Task 1: Contracts — conversation schemas

**Files:**
- Modify: `packages/contracts/src/schemas/llm.ts:175-185` (replace `ConversationSchema`), `:220` (replace `export type Conversation`)
- Test: `packages/contracts/src/schemas/llm.test.ts`

**Interfaces:**
- Produces (imported by Tasks 3, 6, 7, 11–13 and by PR 2):
  `TITLE_SOURCES`, `TitleSourceSchema`, `type TitleSource`, `SourceSchema`, `type PersistedSource`, `StoredChatMessageSchema`, `type StoredChatMessage`, `ConversationSummarySchema`, `type ConversationSummary`, `ConversationDetailSchema`, `type ConversationDetail`, `ConversationListQuerySchema`, `type ConversationListQuery`, `ConversationListResponseSchema`, `type ConversationListResponse`, `UpdateConversationSchema`, `type UpdateConversationBody`, `ConversationIdParamSchema`.

- [ ] **Step 1: Write the failing tests** — append to `packages/contracts/src/schemas/llm.test.ts`:

```ts
import {
  TITLE_SOURCES,
  SourceSchema,
  StoredChatMessageSchema,
  ConversationSummarySchema,
  ConversationDetailSchema,
  ConversationListQuerySchema,
  ConversationListResponseSchema,
  UpdateConversationSchema,
  ConversationIdParamSchema,
} from './llm.js';

describe('conversation schemas (#1361)', () => {
  const KB_SOURCE = {
    pageTitle: 'Runbook',
    spaceKey: 'ENG',
    pageId: 42,
    confluenceId: '123456789012',
    sectionTitle: 'Rotation',
    similarity: 0.71,
  };
  // The live wire shape for an external doc: no pageId at all (the route's
  // `pageId: 0` sentinel is OMITTED by the persister, Task 7).
  const EXTERNAL_SOURCE = {
    pageTitle: 'Fastify docs',
    spaceKey: 'External',
    confluenceId: 'https://fastify.dev/docs',
    url: 'https://fastify.dev/docs',
    sectionTitle: 'Fastify docs',
    similarity: null,
  };

  it('TITLE_SOURCES is exactly question | generated | user', () => {
    expect([...TITLE_SOURCES]).toEqual(['question', 'generated', 'user']);
  });

  it('SourceSchema round-trips a KB source and an external-doc source', () => {
    expect(SourceSchema.parse(KB_SOURCE)).toEqual(KB_SOURCE);
    expect(SourceSchema.parse(EXTERNAL_SOURCE)).toEqual(EXTERNAL_SOURCE);
    expect(SourceSchema.parse({ ...KB_SOURCE, unavailable: true }).unavailable).toBe(true);
  });

  it('SourceSchema rejects the wire sentinel pageId: 0 — the persister must omit it', () => {
    expect(SourceSchema.safeParse({ ...EXTERNAL_SOURCE, pageId: 0 }).success).toBe(false);
  });

  it('StoredChatMessageSchema accepts refused turns and turns carrying sources', () => {
    expect(() => StoredChatMessageSchema.parse({ role: 'assistant', content: 'no', refused: true })).not.toThrow();
    expect(() => StoredChatMessageSchema.parse({ role: 'assistant', content: 'yes', sources: [KB_SOURCE, EXTERNAL_SOURCE] })).not.toThrow();
    expect(StoredChatMessageSchema.safeParse({ role: 'tool', content: 'x' }).success).toBe(false);
  });

  it('ConversationListQuerySchema defaults limit to 50, coerces, and caps at 100', () => {
    expect(ConversationListQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(ConversationListQuerySchema.parse({ limit: '25', cursor: 'abc' })).toEqual({ limit: 25, cursor: 'abc' });
    expect(ConversationListQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(ConversationListQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
  });

  it('UpdateConversationSchema trims, and rejects blank or over-long titles', () => {
    expect(UpdateConversationSchema.parse({ title: '  PAT rotation  ' })).toEqual({ title: 'PAT rotation' });
    expect(UpdateConversationSchema.safeParse({ title: '   ' }).success).toBe(false);
    expect(UpdateConversationSchema.safeParse({ title: 'x'.repeat(201) }).success).toBe(false);
  });

  it('ConversationIdParamSchema requires a uuid', () => {
    expect(ConversationIdParamSchema.safeParse({ id: 'conv-1' }).success).toBe(false);
    expect(ConversationIdParamSchema.safeParse({ id: '5f0e8f9a-1b2c-4d3e-8f4a-5b6c7d8e9f0a' }).success).toBe(true);
  });

  it('summary / detail / list response round-trip the wire shape', () => {
    const summary = {
      id: '5f0e8f9a-1b2c-4d3e-8f4a-5b6c7d8e9f0a',
      title: 'PAT rotation',
      titleSource: 'question',
      model: 'qwen3:8b',
      pageId: 42,
      pageTitle: 'Runbook',
      createdAt: '2026-08-17T10:00:00.000Z',
      updatedAt: '2026-08-17T11:00:00.000Z',
    };
    expect(ConversationSummarySchema.parse(summary)).toEqual(summary);
    expect(ConversationSummarySchema.parse({ ...summary, pageId: null, pageTitle: null }).pageId).toBeNull();
    const detail = {
      ...summary,
      messages: [
        { role: 'user', content: 'how do we rotate the PAT?' },
        { role: 'assistant', content: 'Under Settings → Confluence.', sources: [KB_SOURCE] },
      ],
      historyTruncated: false,
    };
    expect(ConversationDetailSchema.parse(detail)).toEqual(detail);
    expect(ConversationDetailSchema.safeParse({ ...detail, historyTruncated: undefined }).success).toBe(false);
    expect(ConversationListResponseSchema.parse({ items: [summary], nextCursor: null }).nextCursor).toBeNull();
  });
});
```

- [ ] **Step 2: Run the contracts tests to verify they fail**

Run: `npm run test -w @compendiq/contracts`
Expected: FAIL — `TITLE_SOURCES` (and the others) are not exported.

- [ ] **Step 3: Replace the dead schema** — in `packages/contracts/src/schemas/llm.ts`, delete lines 175–185 (`export const ConversationSchema = …`) and line 220 (`export type Conversation = z.infer<typeof ConversationSchema>;`) and insert in their place:

```ts
/**
 * #1361 — conversation persistence contracts. `title_source` records who
 * named the row: the trimmed first question, the LLM auto-title (PR 3), or
 * a user rename — the last is never overwritten.
 */
export const TITLE_SOURCES = ['question', 'generated', 'user'] as const;
export const TitleSourceSchema = z.enum(TITLE_SOURCES);
export type TitleSource = z.infer<typeof TitleSourceSchema>;

/**
 * A source persisted beside an assistant turn (the wire `Source` allow-listed
 * to what a citation chip renders). `pageId` is a positive internal `pages.id`
 * or ABSENT — the route's `pageId: 0` sentinel for external/web sources is
 * omitted on persist. `unavailable` is a READ-TIME annotation from
 * `GET /llm/conversations/:id` (page trashed or no longer visible to the
 * caller); it is never stored.
 */
export const SourceSchema = z.object({
  pageTitle: z.string(),
  spaceKey: z.string().nullable().optional(),
  pageId: z.number().int().positive().optional(),
  confluenceId: z.string().nullable().optional(),
  url: z.string().optional(),
  sectionTitle: z.string().optional(),
  similarity: z.number().nullable().optional(),
  unavailable: z.literal(true).optional(),
});
export type PersistedSource = z.infer<typeof SourceSchema>;

export const StoredChatMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
  refused: z.boolean().optional(),
  sources: z.array(SourceSchema).optional(),
});
export type StoredChatMessage = z.infer<typeof StoredChatMessageSchema>;

export const ConversationSummarySchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  titleSource: TitleSourceSchema,
  model: z.string(),
  pageId: z.number().int().positive().nullable(),
  pageTitle: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;

export const ConversationDetailSchema = ConversationSummarySchema.extend({
  messages: z.array(StoredChatMessageSchema),
  /** `selectReplayableHistory(messages).truncated` — the reopen-time half of decision 10. */
  historyTruncated: z.boolean(),
});
export type ConversationDetail = z.infer<typeof ConversationDetailSchema>;

export const ConversationListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(200).optional(),
});
export type ConversationListQuery = z.infer<typeof ConversationListQuerySchema>;

export const ConversationListResponseSchema = z.object({
  items: z.array(ConversationSummarySchema),
  nextCursor: z.string().nullable(),
});
export type ConversationListResponse = z.infer<typeof ConversationListResponseSchema>;

export const UpdateConversationSchema = z.object({
  title: z.string().trim().min(1).max(200),
});
export type UpdateConversationBody = z.infer<typeof UpdateConversationSchema>;

export const ConversationIdParamSchema = z.object({ id: z.string().uuid() });
```

- [ ] **Step 4: Run the contracts tests, then build**

Run: `npm run test -w @compendiq/contracts && npm run build -w @compendiq/contracts`
Expected: PASS; `dist/` rebuilt. Also `grep -rn "ConversationSchema\b" backend/src frontend/src packages/contracts/src` must return only the new names (nothing imported the old one).

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/schemas/llm.ts packages/contracts/src/schemas/llm.test.ts
git commit -m "feat(contracts): conversation summary/detail/list/update schemas for #1361"
```

---

### Task 2: Migration 094 — `page_ref`, `title_source`, list index

**Files:**
- Create: `backend/src/core/db/migrations/094_llm_conversations_history.sql`
- Test: `backend/src/core/db/migrations/__tests__/migrations.test.ts:217-227` (extend the `llm_conversations table schema` describe)

- [ ] **Step 1: Write the failing schema assertions** — inside `describe('llm_conversations table schema', …)` after the existing `it('should have messages JSONB column')`:

```ts
    it('has page_ref (INTEGER FK, ON DELETE SET NULL), title_source, and no page_id (#1361)', async () => {
      const cols = await query<{ column_name: string; data_type: string; column_default: string | null }>(
        `SELECT column_name, data_type, column_default
         FROM information_schema.columns
         WHERE table_name = 'llm_conversations'`,
      );
      const byName = Object.fromEntries(cols.rows.map((r) => [r.column_name, r]));
      expect(byName.page_id).toBeUndefined();
      expect(byName.page_ref?.data_type).toBe('integer');
      expect(byName.title_source?.data_type).toBe('text');
      expect(byName.title_source?.column_default).toContain('question');

      const fk = await query<{ confdeltype: string; confrelid: string }>(
        `SELECT confdeltype, confrelid::regclass::text AS confrelid
         FROM pg_constraint
         WHERE conrelid = 'llm_conversations'::regclass AND contype = 'f'
           AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
                               WHERE attrelid = 'llm_conversations'::regclass AND attname = 'page_ref')]`,
      );
      expect(fk.rows).toHaveLength(1);
      expect(fk.rows[0].confrelid).toBe('pages');
      expect(fk.rows[0].confdeltype).toBe('n'); // SET NULL

      const check = await query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
         WHERE conrelid = 'llm_conversations'::regclass AND contype = 'c'`,
      );
      expect(check.rows.some((r) => r.def.includes("'question'") && r.def.includes("'generated'") && r.def.includes("'user'"))).toBe(true);
    });

    it('indexes (user_id, updated_at DESC, id DESC) for the conversation list (#1361)', async () => {
      const idx = await query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes
         WHERE tablename = 'llm_conversations' AND indexname = 'llm_conversations_user_updated_idx'`,
      );
      expect(idx.rows).toHaveLength(1);
      expect(idx.rows[0].indexdef).toMatch(/\(user_id, updated_at DESC, id DESC\)/);
    });
```

- [ ] **Step 2: Run to verify they fail** (skipped-with-no-DB counts as "cannot verify locally" — then rely on Step 4's filename test and CI)

Run: `cd backend && npx vitest run src/core/db/migrations/__tests__/migrations.test.ts -t "llm_conversations" && cd ..`
Expected: FAIL on `page_ref` (or `skipped` if no local DB — note it).

- [ ] **Step 3: Write the migration** — `backend/src/core/db/migrations/094_llm_conversations_history.sql`:

```sql
-- #1361: saved conversations. Three things this table never had:
--   * a page link the pane can render — page_ref replaces the never-written
--     `page_id TEXT` (house style is INTEGER REFERENCES pages(id); SET NULL
--     because deleting a page must not delete history, cf. notifications);
--   * who named the row — title_source: 'question' (trimmed first question),
--     'generated' (LLM auto-title, PR 3), 'user' (rename — never overwritten);
--   * an index for the per-user list, keyset-paged on (updated_at DESC, id DESC).
ALTER TABLE llm_conversations DROP COLUMN page_id;

ALTER TABLE llm_conversations
  ADD COLUMN page_ref INTEGER REFERENCES pages(id) ON DELETE SET NULL,
  ADD COLUMN title_source TEXT NOT NULL DEFAULT 'question'
    CHECK (title_source IN ('question', 'generated', 'user'));

CREATE INDEX IF NOT EXISTS llm_conversations_user_updated_idx
  ON llm_conversations (user_id, updated_at DESC, id DESC);
```

- [ ] **Step 4: Run the filename discipline test and the schema tests**

Run: `cd backend && npx vitest run src/core/db/migrations/__tests__/migration-filenames.test.ts src/core/db/migrations/__tests__/migrations.test.ts && cd ..`
Expected: filenames PASS; schema tests PASS (or skipped locally — record that in the PR body; CI runs them against a fresh Postgres).

- [ ] **Step 5: Grep for readers of the dropped column** (nothing should read it; this is where you find out)

Run: `grep -rn "page_id" backend/src/routes/llm backend/src/domains/llm | grep -i conversation`
Expected: no hits. Also grep the private `compendiq-enterprise` checkout, if present locally, for `llm_conversations` — report any hit in the PR body.

- [ ] **Step 6: Commit**

```bash
git add backend/src/core/db/migrations/094_llm_conversations_history.sql backend/src/core/db/migrations/__tests__/migrations.test.ts
git commit -m "feat(db): llm_conversations gains page_ref, title_source and the list index (#1361)"
```

---

### Task 3: `history-budget.ts` — the replay walk

**Files:**
- Create: `backend/src/domains/llm/services/history-budget.ts`
- Test: `backend/src/domains/llm/services/history-budget.test.ts`

**Interfaces:**
- Consumes: `estimateTokens(text)` (`llm-audit-hook.ts:114`), `contentToText(content)` (`prompts.ts:35`), `type ChatMessage` (`openai-compatible-client.ts`).
- Produces: `HISTORY_REPLAY_TOKEN_BUDGET = 4_000`; `type ReplayableMessage = ChatMessage & { refused?: boolean; sources?: unknown }`; `selectReplayableHistory(history: ReplayableMessage[], budget?: number): { replay: ChatMessage[]; truncated: boolean }`.

- [ ] **Step 1: Write the failing tests** — `history-budget.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { selectReplayableHistory, HISTORY_REPLAY_TOKEN_BUDGET } from './history-budget.js';

// estimateTokens is ~4 chars/token: a 400-char turn is ~100 tokens.
const chars = (n: number, ch = 'x') => ch.repeat(n);

describe('selectReplayableHistory', () => {
  it('replays everything oldest→newest as {role, content} when under budget', () => {
    const { replay, truncated } = selectReplayableHistory([
      { role: 'user', content: 'q1', sources: [] },
      { role: 'assistant', content: 'a1', sources: [{ pageTitle: 'P', pageId: 1 }] },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a2' },
    ]);
    expect(replay).toEqual([
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a2' },
    ]);
    expect(replay.some((m) => 'sources' in m || 'refused' in m)).toBe(false);
    expect(truncated).toBe(false);
  });

  it('never replays a refused turn NOR the orphan question it leaves behind, and that is not truncation', () => {
    const { replay, truncated } = selectReplayableHistory([
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'weak question' },
      { role: 'assistant', content: 'I am not answering', refused: true },
      { role: 'user', content: 'q3' },
      { role: 'assistant', content: 'a3' },
    ]);
    expect(replay.map((m) => m.content)).toEqual(['q1', 'a1', 'q3', 'a3']);
    expect(truncated).toBe(false);
  });

  it('keeps pairing aligned across an orphan when the budget bites (drops oldest exchanges first)', () => {
    // Each exchange = 2 × 400 chars ≈ 200 tokens; budget 450 keeps two exchanges.
    const { replay, truncated } = selectReplayableHistory(
      [
        { role: 'user', content: chars(400, 'a') },
        { role: 'assistant', content: chars(400, 'b') },
        { role: 'user', content: chars(400, 'c') },        // refused exchange → orphan
        { role: 'assistant', content: 'refused', refused: true },
        { role: 'user', content: chars(400, 'd') },
        { role: 'assistant', content: chars(400, 'e') },
        { role: 'user', content: chars(400, 'f') },
        { role: 'assistant', content: chars(400, 'g') },
      ],
      450,
    );
    expect(replay.map((m) => m.content[0])).toEqual(['d', 'e', 'f', 'g']);
    expect(truncated).toBe(true);
  });

  it('drops a single exchange larger than the budget and reports truncation', () => {
    const { replay, truncated } = selectReplayableHistory(
      [{ role: 'user', content: chars(4_000) }, { role: 'assistant', content: chars(4_000) }],
      100,
    );
    expect(replay).toEqual([]);
    expect(truncated).toBe(true);
  });

  it('an assistant turn with no user before it is replayed alone (defensive)', () => {
    const { replay } = selectReplayableHistory([{ role: 'assistant', content: 'a0' }, { role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' }]);
    expect(replay.map((m) => m.content)).toEqual(['a0', 'q1', 'a1']);
  });

  it('exports the default budget as a plain constant', () => {
    expect(HISTORY_REPLAY_TOKEN_BUDGET).toBe(4_000);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx vitest run src/domains/llm/services/history-budget.test.ts && cd ..`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `history-budget.ts`:

```ts
import type { ChatMessage } from './openai-compatible-client.js';
import { contentToText } from './prompts.js';
import { estimateTokens } from './llm-audit-hook.js';

/**
 * Token budget for replaying STORED turns into the model (#1361, decision 10).
 * A plain constant, not an env var: ~4 chars/token is a rough estimator, and
 * 4,000 is conservative for 8k-context local models sitting beside retrieved
 * context. A follow-up may derive it from the provider's window.
 */
export const HISTORY_REPLAY_TOKEN_BUDGET = 4_000;

/** A stored turn as read back from `llm_conversations.messages`. */
export type ReplayableMessage = ChatMessage & { refused?: boolean; sources?: unknown };

export interface ReplaySelection {
  /** Oldest → newest, `{ role, content }` only — the shape the provider wire takes. */
  replay: ChatMessage[];
  /** True when at least one EXCHANGE was left out for budget. Refused turns and
   *  orphan questions are never replay material and do not count. */
  truncated: boolean;
}

const strip = ({ role, content }: ChatMessage): ChatMessage => ({ role, content });

/**
 * Select the newest whole exchanges that fit the budget.
 *
 * Pairing is by ROLE, not by index stride: an assistant turn and the user turn
 * immediately before it are one exchange. A user turn with no assistant after
 * it — exactly what a refused exchange leaves behind once the refused
 * assistant half is filtered — is dropped unconditionally and never counted
 * (some providers reject consecutive same-role messages, and the honest-refusal
 * gate's history exemption never counted it either). Walk newest → oldest,
 * stop before the exchange that would exceed the budget, restore order.
 */
export function selectReplayableHistory(
  history: ReplayableMessage[],
  budget: number = HISTORY_REPLAY_TOKEN_BUDGET,
): ReplaySelection {
  const live = history.filter((m) => !m.refused);

  const exchangesNewestFirst: ChatMessage[][] = [];
  let i = live.length - 1;
  while (i >= 0) {
    const m = live[i]!;
    if (m.role === 'assistant') {
      const prev = live[i - 1];
      if (prev && prev.role === 'user') {
        exchangesNewestFirst.push([strip(prev), strip(m)]);
        i -= 2;
      } else {
        exchangesNewestFirst.push([strip(m)]);
        i -= 1;
      }
    } else {
      i -= 1; // orphan user/system turn: dropped, not counted
    }
  }

  const kept: ChatMessage[][] = [];
  let used = 0;
  let truncated = false;
  for (const exchange of exchangesNewestFirst) {
    const cost = exchange.reduce((n, m) => n + estimateTokens(contentToText(m.content)), 0);
    if (used + cost > budget) {
      truncated = true;
      break;
    }
    used += cost;
    kept.push(exchange);
  }

  return { replay: kept.reverse().flat(), truncated };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && npx vitest run src/domains/llm/services/history-budget.test.ts && cd ..`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/domains/llm/services/history-budget.ts backend/src/domains/llm/services/history-budget.test.ts
git commit -m "feat(llm): selectReplayableHistory — role-paired, budgeted replay of stored turns (#1361)"
```

---

### Task 4: `conversation-title.ts` — word-boundary initial title

**Files:**
- Create: `backend/src/domains/llm/services/conversation-title.ts`
- Test: `backend/src/domains/llm/services/conversation-title.test.ts`

**Interfaces:**
- Produces: `CONVERSATION_TITLE_MAX = 80`; `initialTitleFromQuestion(question: string): string`. (PR 3 adds `normalizeGeneratedTitle` and `generateConversationTitle` to this same file.)

- [ ] **Step 1: Write the failing tests** — `conversation-title.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { initialTitleFromQuestion, CONVERSATION_TITLE_MAX } from './conversation-title.js';

describe('initialTitleFromQuestion', () => {
  it('passes a short question through, whitespace collapsed', () => {
    expect(initialTitleFromQuestion('  how do we\n\n rotate   the PAT? ')).toBe('how do we rotate the PAT?');
  });

  it('cuts a long question at a word boundary, strips trailing punctuation, appends an ellipsis', () => {
    const q = 'What is the recommended procedure for rotating the Confluence personal access token, and who owns it?';
    const t = initialTitleFromQuestion(q);
    expect(t.length).toBeLessThanOrEqual(CONVERSATION_TITLE_MAX + 1);
    expect(t.endsWith('…')).toBe(true);
    // never mid-word: the char before the ellipsis is a word char, and the
    // title without the ellipsis is a prefix of the question ending at a space
    const stem = t.slice(0, -1);
    expect(q.startsWith(stem)).toBe(true);
    expect(q[stem.length]).toBe(' ');
    expect(stem).not.toMatch(/[,;:.!?…-]$/u);
  });

  it('hard-cuts at the maximum when no word boundary sits past the minimum', () => {
    const t = initialTitleFromQuestion('a'.repeat(120));
    expect(t).toBe('a'.repeat(CONVERSATION_TITLE_MAX) + '…');
  });

  it('returns an empty string for a whitespace-only question (the read side COALESCEs it)', () => {
    expect(initialTitleFromQuestion('   \n ')).toBe('');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx vitest run src/domains/llm/services/conversation-title.test.ts && cd ..`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `conversation-title.ts`:

```ts
/** Longest title the row carries (initial, generated or renamed all respect it). */
export const CONVERSATION_TITLE_MAX = 80;
/** A word boundary this far back is preferred over a hard cut. */
const MIN_WORD_BOUNDARY = 40;

/**
 * The initial title of a new conversation: the first question, whitespace
 * collapsed, cut on a word boundary at ≤ 80 chars with an ellipsis (#1361).
 * Replaces the mid-word `question.slice(0, 100)`. PR 3's auto-title
 * overwrites it only while `title_source = 'question'`.
 */
export function initialTitleFromQuestion(question: string): string {
  const collapsed = question.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= CONVERSATION_TITLE_MAX) return collapsed;
  let cut = collapsed.slice(0, CONVERSATION_TITLE_MAX);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace >= MIN_WORD_BOUNDARY) cut = cut.slice(0, lastSpace);
  cut = cut.replace(/[\s,;:.!?…-]+$/u, '');
  return `${cut}…`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && npx vitest run src/domains/llm/services/conversation-title.test.ts && cd ..`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/domains/llm/services/conversation-title.ts backend/src/domains/llm/services/conversation-title.test.ts
git commit -m "feat(llm): initialTitleFromQuestion — word-boundary conversation titles (#1361)"
```

---

### Task 5: `persisted-source.ts` — the allow-list

**Files:**
- Create: `backend/src/domains/llm/services/persisted-source.ts`
- Test: `backend/src/domains/llm/services/persisted-source.test.ts`

**Interfaces:**
- Consumes: `type PersistedSource` from `@compendiq/contracts` (Task 1).
- Produces: `type WireSource` (the shape `llm-ask.ts` builds at `:445-495`); `toPersistedSources(sources: WireSource[]): PersistedSource[]`.

- [ ] **Step 1: Write the failing tests** — `persisted-source.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { toPersistedSources } from './persisted-source.js';

describe('toPersistedSources', () => {
  it('keeps the chip fields of a KB source and drops the sort/rerank scores', () => {
    const [s] = toPersistedSources([{
      pageId: 42, pageTitle: 'Runbook', spaceKey: 'ENG', confluenceId: '123', sectionTitle: 'Rotation',
      score: 0.9, similarity: 0.71, rerankScore: 0.3,
    }]);
    expect(s).toEqual({ pageTitle: 'Runbook', spaceKey: 'ENG', pageId: 42, confluenceId: '123', sectionTitle: 'Rotation', similarity: 0.71 });
    expect(s).not.toHaveProperty('score');
    expect(s).not.toHaveProperty('rerankScore');
  });

  it('omits the pageId: 0 sentinel of external/web sources and keeps their url', () => {
    const [s] = toPersistedSources([{
      pageId: 0, pageTitle: 'Fastify docs', spaceKey: 'External', confluenceId: 'https://fastify.dev', url: 'https://fastify.dev',
      sectionTitle: 'Fastify docs', score: 1, similarity: null,
    }]);
    expect(s).toEqual({ pageTitle: 'Fastify docs', spaceKey: 'External', confluenceId: 'https://fastify.dev', url: 'https://fastify.dev', sectionTitle: 'Fastify docs', similarity: null });
    expect(s).not.toHaveProperty('pageId');
  });

  it('preserves order (order is the ranking)', () => {
    const out = toPersistedSources([{ pageId: 2, pageTitle: 'B' }, { pageId: 1, pageTitle: 'A' }]);
    expect(out.map((s) => s.pageId)).toEqual([2, 1]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx vitest run src/domains/llm/services/persisted-source.test.ts && cd ..`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `persisted-source.ts`:

```ts
import type { PersistedSource } from '@compendiq/contracts';

/** The union `llm-ask.ts` builds from search results, external docs and web hits. */
export interface WireSource {
  pageId?: number;
  pageTitle: string;
  spaceKey?: string | null;
  confluenceId?: string | null;
  url?: string;
  sectionTitle?: string;
  score?: number;
  similarity?: number | null;
  rerankScore?: number | null;
}

/**
 * The persisted shape of a source (#1361): what a citation chip renders, and
 * nothing that only orders or thresholds. `pageId: 0` is the wire's
 * "not a knowledge-base page" sentinel and is OMITTED — the contract's
 * `SourceSchema.pageId` is positive-or-absent, and the read side annotates
 * only sources that carry a real page id.
 */
export function toPersistedSources(sources: WireSource[]): PersistedSource[] {
  return sources.map((s) => ({
    pageTitle: s.pageTitle,
    ...(s.spaceKey !== undefined ? { spaceKey: s.spaceKey } : {}),
    ...(typeof s.pageId === 'number' && s.pageId > 0 ? { pageId: s.pageId } : {}),
    ...(s.confluenceId !== undefined ? { confluenceId: s.confluenceId } : {}),
    ...(s.url ? { url: s.url } : {}),
    ...(s.sectionTitle ? { sectionTitle: s.sectionTitle } : {}),
    similarity: s.similarity ?? null,
  }));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && npx vitest run src/domains/llm/services/persisted-source.test.ts && cd ..`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/domains/llm/services/persisted-source.ts backend/src/domains/llm/services/persisted-source.test.ts
git commit -m "feat(llm): toPersistedSources — the chip allow-list for stored turns (#1361)"
```

---

### Task 6: `llm-ask.ts` — stale `conversationId` → 404 before streaming

**Files:**
- Modify: `backend/src/routes/llm/llm-ask.ts:169-181`
- Test: `backend/src/routes/llm/llm-ask.test.ts` (new `describe`)

- [ ] **Step 1: Write the failing test** — add near the other conversation tests (e.g. after the `describe` that ends around line 950):

```ts
  describe('stale conversationId (#1361)', () => {
    it('answers 404 before retrieval or any SSE header when the conversation is not the caller\'s', async () => {
      mockQuery.mockImplementation(async (sql: string) => {
        if (typeof sql === 'string' && sql.includes('SELECT messages FROM llm_conversations')) {
          return { rows: [] };
        }
        return { rows: [{ id: 'test-conv-id' }] };
      });
      const response = await app.inject({
        method: 'POST', url: '/api/llm/ask',
        payload: { question: 'follow-up', conversationId: '5f0e8f9a-1b2c-4d3e-8f4a-5b6c7d8e9f0a' },
      });
      expect(response.statusCode).toBe(404);
      expect(response.headers['content-type']).toContain('application/json');
      expect(JSON.parse(response.body).message).toContain('Conversation not found');
      expect(mockHybridSearch).not.toHaveBeenCalled();
      expect(mockStreamChatClient).not.toHaveBeenCalled();
    });
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx vitest run src/routes/llm/llm-ask.test.ts -t "stale conversationId" && cd ..`
Expected: FAIL — status 200 (today the 0-row lookup is silently accepted).

- [ ] **Step 3: Implement** — replace lines 173–181 with:

```ts
    if (convId) {
      const conv = await query<{ messages: StoredChatMessage[] }>(
        'SELECT messages FROM llm_conversations WHERE id = $1 AND user_id = $2',
        [convId, userId],
      );
      // #1361: a stale or foreign id is a 404 BEFORE retrieval and before any
      // SSE header, never a silent 0-row UPDATE later. Foreign ids get the
      // same answer — do not reveal existence.
      if (conv.rows.length === 0) {
        throw fastify.httpErrors.notFound('Conversation not found');
      }
      conversationHistory = conv.rows[0]!.messages;
    }
```

- [ ] **Step 4: Run the whole file**

Run: `cd backend && npx vitest run src/routes/llm/llm-ask.test.ts && cd ..`
Expected: PASS. (Every existing test that sends a `conversationId` already mocks the `SELECT messages` row.)

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/llm/llm-ask.ts backend/src/routes/llm/llm-ask.test.ts
git commit -m "fix(llm): a stale conversationId is a 404 before streaming, not a silent no-op (#1361)"
```

---

### Task 7: `llm-ask.ts` — atomic append, sources persisted, `conversationId: null` on 0 rows

**Files:**
- Modify: `backend/src/routes/llm/llm-ask.ts:1-13` (type), `:440-444` (stale comment), `:497-522` (`saveConversation`), `:678`, `:693`, `:708-713`, `:781`, `:801-806` (call sites / final frames)
- Test: `backend/src/routes/llm/llm-ask.test.ts` (`:496-523`, `:722-744` gain source assertions; new tests)

**Interfaces:**
- Consumes: `toPersistedSources` (Task 5), `type PersistedSource` (Task 1).
- Produces: `saveConversation(answer, opts?) → Promise<{ id: string | null; inserted: boolean }>` (used by Task 8 and PR 3).

- [ ] **Step 1: Write the failing tests**

(a) Extend the existing test at `:496-523` (`gate ON + weak similarity below threshold: refuses with the weak sources attached`) — after `expect(persistedTurn.refused).toBe(true);` add:

```ts
      // #1361: the weak sources are persisted as structured data beside the
      // prose (which still does not promise a list).
      const persistedSources = persistedTurn.sources as Array<Record<string, unknown>>;
      expect(Array.isArray(persistedSources)).toBe(true);
      expect(persistedSources.length).toBeGreaterThan(0);
      expect(persistedSources[0]).toHaveProperty('pageId');
      expect(persistedSources[0]).not.toHaveProperty('score');
```

(b) Add a new `describe` beside the stale-id one:

```ts
  describe('persistence shape (#1361)', () => {
    it('appends a continuation turn atomically with jsonb || and RETURNING id', async () => {
      mockQuery.mockImplementation(async (sql: string) => {
        if (typeof sql === 'string' && sql.includes('SELECT messages FROM llm_conversations')) {
          return { rows: [{ messages: [{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' }] }] };
        }
        return { rows: [{ id: '5f0e8f9a-1b2c-4d3e-8f4a-5b6c7d8e9f0a' }] };
      });
      mockHybridSearch.mockResolvedValue([]);
      mockBuildRagContext.mockReturnValue('ctx');
      mockStreamChatClient.mockReturnValue(singleChunkGenerator('a2'));

      const response = await app.inject({
        method: 'POST', url: '/api/llm/ask',
        payload: { question: 'q2', conversationId: '5f0e8f9a-1b2c-4d3e-8f4a-5b6c7d8e9f0a' },
      });
      expect(response.statusCode).toBe(200);
      const update = mockQuery.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('UPDATE llm_conversations'),
      )!;
      expect(update[0]).toContain('messages = messages || $3::jsonb');
      expect(update[0]).toContain('RETURNING id');
      const appended = JSON.parse((update[1] as unknown[])[2] as string) as Array<{ role: string; content: string }>;
      // Only the NEW pair travels — no read-modify-write of the whole array.
      expect(appended.map((m) => m.role)).toEqual(['user', 'assistant']);
      expect(appended[1].content).toBe('a2');
      const finals = parseSseBody(response.body) as Array<Record<string, unknown>>;
      expect(finals.find((f) => f.final === true)!.conversationId).toBe('5f0e8f9a-1b2c-4d3e-8f4a-5b6c7d8e9f0a');
    });

    it('carries conversationId: null on the final frame when the append hits 0 rows (deleted mid-answer)', async () => {
      mockQuery.mockImplementation(async (sql: string) => {
        if (typeof sql === 'string' && sql.includes('SELECT messages FROM llm_conversations')) {
          return { rows: [{ messages: [{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' }] }] };
        }
        if (typeof sql === 'string' && sql.includes('UPDATE llm_conversations')) {
          return { rows: [] };
        }
        return { rows: [{ id: 'test-conv-id' }] };
      });
      mockHybridSearch.mockResolvedValue([]);
      mockBuildRagContext.mockReturnValue('ctx');
      mockStreamChatClient.mockReturnValue(singleChunkGenerator('a2'));

      const response = await app.inject({
        method: 'POST', url: '/api/llm/ask',
        payload: { question: 'q2', conversationId: '5f0e8f9a-1b2c-4d3e-8f4a-5b6c7d8e9f0a' },
      });
      const finals = parseSseBody(response.body) as Array<Record<string, unknown>>;
      const final = finals.find((f) => f.final === true)!;
      expect('conversationId' in final).toBe(true);
      expect(final.conversationId).toBeNull();
      // Nothing was re-INSERTed: the deleted conversation is not resurrected.
      expect(mockQuery.mock.calls.some((c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO llm_conversations'))).toBe(false);
    });

    it('persists KB sources on the streamed turn without the deprecated score, and omits pageId for an external doc', async () => {
      mockMcpIsEnabled.mockResolvedValue(true);
      mockMcpFetchDocumentation.mockResolvedValue({ url: 'https://example.com/doc', title: 'Doc', markdown: 'body' });
      mockHybridSearch.mockResolvedValue([{
        pageId: 42, pageTitle: 'Runbook', spaceKey: 'ENG', confluenceId: '123', sectionTitle: 'Rotation',
        score: 0.9, vectorScore: 0.71, content: 'chunk',
      }]);
      mockBuildRagContext.mockReturnValue('ctx');
      mockStreamChatClient.mockReturnValue(singleChunkGenerator('answer'));

      await app.inject({
        method: 'POST', url: '/api/llm/ask',
        payload: { question: 'how do we rotate the PAT?', externalUrls: ['https://example.com/doc'] },
      });
      const insert = mockQuery.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO llm_conversations'),
      )!;
      const messages = JSON.parse((insert[1] as unknown[])[3] as string) as Array<{ role: string; sources?: Array<Record<string, unknown>> }>;
      const assistant = messages.find((m) => m.role === 'assistant')!;
      expect(assistant.sources).toBeDefined();
      const kb = assistant.sources!.find((s) => s.pageId === 42)!;
      expect(kb).toEqual({ pageTitle: 'Runbook', spaceKey: 'ENG', pageId: 42, confluenceId: '123', sectionTitle: 'Rotation', similarity: 0.71 });
      const ext = assistant.sources!.find((s) => s.url === 'https://example.com/doc')!;
      expect(ext).not.toHaveProperty('pageId');
      expect(messages.find((m) => m.role === 'user')).not.toHaveProperty('sources');
      mockMcpIsEnabled.mockResolvedValue(false);
    });

    it('persists sources on a cache-hit turn too', async () => {
      mockGetCachedResponse.mockResolvedValueOnce({ content: 'cached answer' });
      mockHybridSearch.mockResolvedValue([{ pageId: 7, pageTitle: 'P', spaceKey: 'S', confluenceId: null, score: 0.5, vectorScore: 0.6, content: 'c' }]);
      mockBuildRagContext.mockReturnValue('ctx');

      await app.inject({ method: 'POST', url: '/api/llm/ask', payload: { question: 'cached question' } });
      expect(mockStreamChatClient).not.toHaveBeenCalled();
      const insert = mockQuery.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO llm_conversations'),
      )!;
      const messages = JSON.parse((insert[1] as unknown[])[3] as string) as Array<{ role: string; sources?: unknown[] }>;
      expect(messages.find((m) => m.role === 'assistant')!.sources).toHaveLength(1);
    });
  });
```

Check how existing cache-hit tests arm the cache (grep `mockGetCachedResponse.mockResolvedValue` in the file) and match their shape for `cached` (`{ content }` is what `checkCacheWithLock` returns; adjust if the helper expects more fields).

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && npx vitest run src/routes/llm/llm-ask.test.ts -t "persistence shape|weak similarity below threshold" && cd ..`
Expected: FAIL (no `sources` on persisted turns; UPDATE SQL is `SET messages = $3`).

- [ ] **Step 3: Implement**

(a) Line 4 area — add imports:
```ts
import type { PersistedSource } from '@compendiq/contracts';
import { toPersistedSources } from '../../domains/llm/services/persisted-source.js';
```
and widen the local type at line 13:
```ts
type StoredChatMessage = ChatMessage & { refused?: boolean; sources?: PersistedSource[] };
```

(b) Replace the stale comment at `:441-444` ("`sources` is never persisted …") with:
```ts
    // Note the two are separate FIELDS rather than one redefined field purely
    // for legibility. `sources` IS persisted per assistant turn since #1361 —
    // through `toPersistedSources`, which keeps what a chip renders and drops
    // `score`/`rerankScore` — so a reopened conversation renders its chips and
    // confidence badge (computed client-side from `similarity`).
```

(c) Replace `saveConversation` (`:497-522`) with:
```ts
    // Helper to save/create conversation from a streamed, cached, or refused
    // answer. The row's `model` column is the THREAD's configured model, not
    // an attestation that it was invoked — a refusal writes it without a call.
    // Returns the id the final frame must carry (null when the row vanished
    // under us) and whether this call INSERTed (PR 3's auto-title trigger).
    const persistedSources = toPersistedSources(sources);
    const saveConversation = async (
      answer: string,
      opts?: { refused?: boolean },
    ): Promise<{ id: string | null; inserted: boolean }> => {
      const assistantTurn: StoredChatMessage = {
        role: 'assistant',
        content: answer,
        ...(opts?.refused ? { refused: true } : {}),
        ...(persistedSources.length > 0 ? { sources: persistedSources } : {}),
      };
      const newTurns: StoredChatMessage[] = [{ role: 'user', content: question }, assistantTurn];

      if (convId) {
        // #1361: atomic append. Two tabs asking concurrently interleave at
        // pair granularity, so history stays well-formed; the whole array is
        // never read-modify-written. 0 rows means the row was deleted since
        // the 404 check above — do not resurrect it.
        const updated = await query<{ id: string }>(
          `UPDATE llm_conversations
              SET messages = messages || $3::jsonb, updated_at = NOW()
            WHERE id = $1 AND user_id = $2
            RETURNING id`,
          [convId, userId, JSON.stringify(newTurns)],
        );
        if (updated.rows.length === 0) {
          logger.warn({ conversationId: convId, userId }, 'Conversation vanished mid-answer; exchange not persisted');
          convId = null;
          return { id: null, inserted: false };
        }
        return { id: convId, inserted: false };
      }

      const insertResult = await query<{ id: string }>(
        `INSERT INTO llm_conversations (user_id, model, title, messages)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [userId, resolvedModel, question.slice(0, 100), JSON.stringify(newTurns)],
      );
      convId = insertResult.rows[0]!.id;
      return { id: convId, inserted: true };
    };
```
(Title and `page_ref` change in Tasks 9 and 10; keep `question.slice(0, 100)` and four columns here so this task's diff is one concern.)

Change `let convId = conversationId;` (`:171`) to `let convId: string | null | undefined = conversationId;`.

(d) The three final frames must serialise `null` explicitly (an `undefined` is dropped by `JSON.stringify`): at `:693` and `:711` and `:804` write `conversationId: convId ?? null,`.

- [ ] **Step 4: Run the file**

Run: `cd backend && npx vitest run src/routes/llm/llm-ask.test.ts && cd ..`
Expected: PASS, including `:1021-1022` (`conversationId` is `'test-conv-id'` from the INSERT).

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/llm/llm-ask.ts backend/src/routes/llm/llm-ask.test.ts
git commit -m "feat(llm): persist sources per turn, append atomically, null id when the row vanished (#1361)"
```

---

### Task 8: `llm-ask.ts` — bounded history replay + `historyTruncated`

**Files:**
- Modify: `backend/src/routes/llm/llm-ask.ts:736-747` (messages), `:801-806` (final frame)
- Test: `backend/src/routes/llm/llm-ask.test.ts`

**Interfaces:**
- Consumes: `selectReplayableHistory` (Task 3).

- [ ] **Step 1: Write the failing tests** — inside the `persistence shape (#1361)` describe:

```ts
    it('replays only the newest exchanges within the token budget and flags historyTruncated on the final frame', async () => {
      // 6 exchanges × (4,000 + 4,000 chars) ≈ 2,000 tokens each; the 4,000-token
      // budget keeps exactly the newest two.
      const history: Array<{ role: string; content: string }> = [];
      for (let n = 1; n <= 6; n++) {
        history.push({ role: 'user', content: `Q${n} ` + 'x'.repeat(3_996) });
        history.push({ role: 'assistant', content: `A${n} ` + 'y'.repeat(3_996) });
      }
      mockQuery.mockImplementation(async (sql: string) => {
        if (typeof sql === 'string' && sql.includes('SELECT messages FROM llm_conversations')) {
          return { rows: [{ messages: history }] };
        }
        return { rows: [{ id: '5f0e8f9a-1b2c-4d3e-8f4a-5b6c7d8e9f0a' }] };
      });
      mockHybridSearch.mockResolvedValue([]);
      mockBuildRagContext.mockReturnValue('ctx');
      mockStreamChatClient.mockReturnValue(singleChunkGenerator('A7'));

      const response = await app.inject({
        method: 'POST', url: '/api/llm/ask',
        payload: { question: 'Q7', conversationId: '5f0e8f9a-1b2c-4d3e-8f4a-5b6c7d8e9f0a' },
      });
      const [, , messages] = mockStreamChatClient.mock.calls[0] as [unknown, unknown, Array<{ role: string; content: string }>];
      const replayed = messages.filter((m) => m.role !== 'system').map((m) => m.content.slice(0, 2));
      expect(replayed).toEqual(['Q5', 'A5', 'Q6', 'A6', 'Co']); // 'Co' = "Context from knowledge base…" (the current turn)
      const final = (parseSseBody(response.body) as Array<Record<string, unknown>>).find((f) => f.final === true)!;
      expect(final.historyTruncated).toBe(true);
    });

    it('omits historyTruncated when the whole history fits', async () => {
      mockQuery.mockImplementation(async (sql: string) => {
        if (typeof sql === 'string' && sql.includes('SELECT messages FROM llm_conversations')) {
          return { rows: [{ messages: [{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' }] }] };
        }
        return { rows: [{ id: '5f0e8f9a-1b2c-4d3e-8f4a-5b6c7d8e9f0a' }] };
      });
      mockHybridSearch.mockResolvedValue([]);
      mockBuildRagContext.mockReturnValue('ctx');
      mockStreamChatClient.mockReturnValue(singleChunkGenerator('a2'));
      const response = await app.inject({
        method: 'POST', url: '/api/llm/ask',
        payload: { question: 'q2', conversationId: '5f0e8f9a-1b2c-4d3e-8f4a-5b6c7d8e9f0a' },
      });
      const final = (parseSseBody(response.body) as Array<Record<string, unknown>>).find((f) => f.final === true)!;
      expect('historyTruncated' in final).toBe(false);
    });
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && npx vitest run src/routes/llm/llm-ask.test.ts -t "token budget|whole history fits" && cd ..`
Expected: FAIL (all six exchanges replayed; no `historyTruncated`).

- [ ] **Step 3: Implement**

Import: `import { selectReplayableHistory } from '../../domains/llm/services/history-budget.js';`

Replace `:736-747` with:
```ts
      // #1361 (decision 10): replay the newest whole exchanges within a token
      // budget. Refusal turns never reach the wire (they are persistence/UI
      // records), and neither do the `refused`/`sources` fields — the walk
      // strips both. `historyTruncated` rides the final frame so the client
      // can say older messages are no longer sent.
      const { replay, truncated: historyTruncated } = selectReplayableHistory(conversationHistory);
      const messages: ChatMessage[] = [
        { role: 'system', content: askPrompt + multiPageSuffix },
        ...replay,
        {
          role: 'user',
          content: userContent,
        },
      ];
```

Final frame (`:801-806`):
```ts
          reply.raw.write(`data: ${JSON.stringify({
            done: true,
            final: true,
            conversationId: convId ?? null,
            sources,
            ...(historyTruncated ? { historyTruncated: true } : {}),
          })}\n\n`);
```

- [ ] **Step 4: Run the file** — the pinned tests at `:694-720` (history grounds the gate) and `:920-950` (refused turns stripped) must stay green: `hasSubstantiveHistory` still reads `conversationHistory`, and the walk still strips refusals.

Run: `cd backend && npx vitest run src/routes/llm/llm-ask.test.ts && cd ..`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/llm/llm-ask.ts backend/src/routes/llm/llm-ask.test.ts
git commit -m "feat(llm): bound history replay by token budget and report historyTruncated (#1361)"
```

---

### Task 9: `llm-ask.ts` — word-boundary initial title

**Files:**
- Modify: `backend/src/routes/llm/llm-ask.ts` (INSERT in `saveConversation`)
- Test: `backend/src/routes/llm/llm-ask.test.ts`

**Interfaces:**
- Consumes: `initialTitleFromQuestion` (Task 4).

- [ ] **Step 1: Write the failing test** — in `persistence shape (#1361)`:

```ts
    it('titles a new conversation on a word boundary, never mid-word (#1361)', async () => {
      mockHybridSearch.mockResolvedValue([]);
      mockBuildRagContext.mockReturnValue('ctx');
      mockStreamChatClient.mockReturnValue(singleChunkGenerator('ok'));
      const question = 'What is the recommended procedure for rotating the Confluence personal access token, and who owns it?';
      await app.inject({ method: 'POST', url: '/api/llm/ask', payload: { question } });
      const insert = mockQuery.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO llm_conversations'),
      )!;
      const title = (insert[1] as unknown[])[2] as string;
      expect(title.length).toBeLessThanOrEqual(81);
      expect(title.endsWith('…')).toBe(true);
      expect(question[title.length - 1]).toBe(' '); // the cut fell on a space
    });
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx vitest run src/routes/llm/llm-ask.test.ts -t "word boundary" && cd ..`
Expected: FAIL (`question.slice(0, 100)`).

- [ ] **Step 3: Implement** — import `initialTitleFromQuestion` from `'../../domains/llm/services/conversation-title.js'` and in the INSERT replace `question.slice(0, 100)` with `initialTitleFromQuestion(question)`.

- [ ] **Step 4: Run the file**

Run: `cd backend && npx vitest run src/routes/llm/llm-ask.test.ts && cd ..`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/llm/llm-ask.ts backend/src/routes/llm/llm-ask.test.ts
git commit -m "feat(llm): word-boundary initial conversation title (#1361)"
```

---

### Task 10: `llm-ask.ts` — `page_ref` resolved and authorised at INSERT

**Files:**
- Modify: `backend/src/routes/llm/llm-ask.ts:264-305` (hoist the sub-page resolution), `saveConversation`'s INSERT
- Test: `backend/src/routes/llm/llm-ask.test.ts`

**Interfaces:**
- Consumes: `resolvePageRef` (`_helpers.ts:69`, already imported), `userCanAccessPage` (`rbac-service.ts`, already imported), `type ResolvedPageRef` (`_helpers.ts:53`).

- [ ] **Step 1: Write the failing tests** — new `describe`:

```ts
  describe('page_ref at INSERT (#1361)', () => {
    function armInsertProbe(opts: { pageRow?: { id: number; confluence_id: string | null; title: string } | null; canAccess: boolean }) {
      mockQuery.mockImplementation(async (sql: string) => {
        if (typeof sql === 'string' && sql.includes('FROM pages WHERE id = $1')) {
          return { rows: opts.pageRow ? [opts.pageRow] : [] };
        }
        if (typeof sql === 'string' && sql.includes('FROM pages WHERE confluence_id')) {
          return { rows: [] };
        }
        return { rows: [{ id: 'test-conv-id' }] };
      });
      mockUserCanAccessPage.mockResolvedValue(opts.canAccess);
      mockHybridSearch.mockResolvedValue([]);
      mockBuildRagContext.mockReturnValue('ctx');
      mockStreamChatClient.mockReturnValue(singleChunkGenerator('ok'));
    }
    function insertParams(): unknown[] {
      const insert = mockQuery.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO llm_conversations'),
      )!;
      expect(insert[0]).toContain('page_ref');
      return insert[1] as unknown[];
    }

    it('writes the resolved internal id when the caller may see the page', async () => {
      armInsertProbe({ pageRow: { id: 42, confluence_id: '123', title: 'Doc' }, canAccess: true });
      await app.inject({ method: 'POST', url: '/api/llm/ask', payload: { question: 'q', pageId: '42' } });
      expect(insertParams()[4]).toBe(42);
      expect(mockUserCanAccessPage).toHaveBeenCalledWith('test-user-123', 42);
    });

    it('writes NULL when the caller may not see the page (no title oracle through the list)', async () => {
      armInsertProbe({ pageRow: { id: 42, confluence_id: '123', title: 'Doc' }, canAccess: false });
      await app.inject({ method: 'POST', url: '/api/llm/ask', payload: { question: 'q', pageId: '42' } });
      expect(insertParams()[4]).toBeNull();
    });

    it('writes NULL for a Confluence-length id that resolves to nothing, and never int-parses it', async () => {
      armInsertProbe({ pageRow: null, canAccess: true });
      const response = await app.inject({ method: 'POST', url: '/api/llm/ask', payload: { question: 'q', pageId: '12345678901' } });
      expect(response.statusCode).toBe(200);
      expect(insertParams()[4]).toBeNull();
      // resolvePageRef skips the int4 lookup for an 11-digit id
      expect(mockQuery.mock.calls.some((c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('FROM pages WHERE id = $1'))).toBe(false);
    });

    it('writes NULL when the ask carries no pageId', async () => {
      armInsertProbe({ pageRow: null, canAccess: true });
      await app.inject({ method: 'POST', url: '/api/llm/ask', payload: { question: 'q' } });
      expect(insertParams()[4]).toBeNull();
      expect(mockUserCanAccessPage).not.toHaveBeenCalled();
    });
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && npx vitest run src/routes/llm/llm-ask.test.ts -t "page_ref at INSERT" && cd ..`
Expected: FAIL (INSERT has no `page_ref`).

- [ ] **Step 3: Implement**

(a) Just above `let multiPageSuffix = '';` (`:266`) add:
```ts
    // #1361: the page a dock conversation started from, written at INSERT.
    // Resolved through resolvePageRef (internal id first, then confluence_id,
    // int4-safe) and AUTHORISED with userCanAccessPage — the ask route never
    // gated a bare `pageId` before, and the conversation list will read the
    // page title back. Reused by the includeSubPages branch below when it ran.
    let resolvedPageRef: ResolvedPageRef | undefined;
```
and in the includeSubPages branch change `const resolved = await resolvePageRef(body.pageId);` to `const resolved = await resolvePageRef(body.pageId); resolvedPageRef = resolved;` (keep the rest of that block as is).

Import the type: add `type ResolvedPageRef` to the `_helpers.js` import list.

(b) Add beside `saveConversation`:
```ts
    const pageRefForInsert = async (): Promise<number | null> => {
      if (!body.pageId) return null;
      const resolved = resolvedPageRef ?? (await resolvePageRef(body.pageId));
      if (!resolved) return null;
      return (await userCanAccessPage(userId, resolved.id)) ? resolved.id : null;
    };
```
and change the INSERT to:
```ts
      const pageRef = await pageRefForInsert();
      const insertResult = await query<{ id: string }>(
        `INSERT INTO llm_conversations (user_id, model, title, messages, page_ref)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [userId, resolvedModel, initialTitleFromQuestion(question), JSON.stringify(newTurns), pageRef],
      );
```
(`messages` stays `$4` — every existing assertion reads `insert[1][3]`.)

- [ ] **Step 4: Run the file** — watch the `includeSubPages RBAC gate` describe: its `seedPageQueries` returns rows for `FROM pages WHERE confluence_id` and `[]` otherwise, so `pageRefForInsert` reuses `resolvedPageRef` when the branch ran, and `mockUserCanAccessPage` is armed there already.

Run: `cd backend && npx vitest run src/routes/llm/llm-ask.test.ts && cd ..`
Expected: PASS. If a test asserts an exact `mockQuery` call count, update it for the one extra `resolvePageRef` lookup on asks that carry `pageId` without `includeSubPages`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/llm/llm-ask.ts backend/src/routes/llm/llm-ask.test.ts
git commit -m "feat(llm): write page_ref at INSERT — resolved via resolvePageRef and authorised (#1361)"
```

---

### Task 11: `llm-conversations.ts` — uuid params, keyset list, ISO timestamps

**Files:**
- Modify: `backend/src/routes/llm/llm-conversations.ts:1-33`
- Test: `backend/src/routes/llm/llm-conversations.test.ts:114-196` (list tests), plus the test-app error handler

**Interfaces:**
- Consumes: `ConversationListQuerySchema`, `ConversationIdParamSchema`, `type ConversationSummary`, `type TitleSource` (Task 1).
- Produces (module-private, reused by Tasks 12–13): `type ConversationRow`, `SUMMARY_COLUMNS`, `toSummary(row)`, `encodeCursor`, `decodeCursor`.

- [ ] **Step 1: Prepare the test app** — in `describe('llm-conversations routes - CRUD')`'s `beforeAll`, after `app.addHook('onRequest', …)` add the production Zod mapping (import `ZodError` from `'zod'` at the top of the test file):

```ts
    // Mirror the production app's Zod error handling (ZodError → 400) — the
    // .uuid() id params (#1361) must answer 400, not 500.
    app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
      if (error instanceof ZodError) {
        return reply.status(400).send({ error: 'ValidationError', statusCode: 400 });
      }
      return reply.status(error.statusCode ?? 500).send({
        error: error.name,
        message: error.message,
        statusCode: error.statusCode ?? 500,
      });
    });
```

Then add a shared fixture near the top of the file:
```ts
const CONV_1 = '5f0e8f9a-1b2c-4d3e-8f4a-5b6c7d8e9f0a';
const CONV_2 = '6a1f9f0b-2c3d-4e4f-9a5b-6c7d8e9f0a1b';
```

- [ ] **Step 2: Rewrite the list tests (they fail now)** — replace `it('should return a list of conversations')` and `it('should return an empty list…')` with:

```ts
  it('returns { items, nextCursor } with page chip data and ISO timestamps (#1361)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: CONV_1, title: 'First conversation', title_source: 'question', model: 'llama3', page_ref: 42, page_title: 'Runbook',
          created_at: new Date('2026-01-01T10:00:00Z'), updated_at: new Date('2026-01-01T11:00:00Z') },
        { id: CONV_2, title: 'Second conversation', title_source: 'user', model: 'qwen3:32b', page_ref: null, page_title: null,
          created_at: new Date('2026-01-02T10:00:00Z'), updated_at: new Date('2026-01-02T12:00:00Z') },
      ],
    });
    const response = await app.inject({ method: 'GET', url: '/api/llm/conversations' });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.items).toHaveLength(2);
    expect(body.items[0]).toEqual({
      id: CONV_1, title: 'First conversation', titleSource: 'question', model: 'llama3', pageId: 42, pageTitle: 'Runbook',
      createdAt: '2026-01-01T10:00:00.000Z', updatedAt: '2026-01-01T11:00:00.000Z',
    });
    expect(body.items[1].pageId).toBeNull();
    expect(body.nextCursor).toBeNull(); // 2 rows < limit + 1
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('LEFT JOIN pages p ON p.id = c.page_ref AND p.deleted_at IS NULL');
    expect(sql).toContain("COALESCE(NULLIF(trim(c.title), ''), 'Untitled conversation')");
    expect(sql).toContain('ORDER BY c.updated_at DESC, c.id DESC');
    expect(params).toEqual(['test-user-123', null, null, 51]);
  });

  it('pages with a keyset cursor: limit + 1 rows → nextCursor, and the cursor round-trips into $2/$3', async () => {
    const rows = [0, 1, 2].map((n) => ({
      id: [CONV_1, CONV_2, '7b2a0a1c-3d4e-4f50-8b6c-7d8e9f0a1b2c'][n], title: `c${n}`, title_source: 'question', model: 'm', page_ref: null, page_title: null,
      created_at: new Date('2026-01-01T00:00:00Z'), updated_at: new Date(`2026-01-0${3 - n}T00:00:00Z`),
    }));
    mockQuery.mockResolvedValueOnce({ rows });
    const first = await app.inject({ method: 'GET', url: '/api/llm/conversations?limit=2' });
    const page1 = JSON.parse(first.body);
    expect(page1.items).toHaveLength(2);
    expect(typeof page1.nextCursor).toBe('string');

    mockQuery.mockResolvedValueOnce({ rows: [rows[2]] });
    const second = await app.inject({ method: 'GET', url: `/api/llm/conversations?limit=2&cursor=${encodeURIComponent(page1.nextCursor)}` });
    expect(second.statusCode).toBe(200);
    const [, params] = mockQuery.mock.calls[1] as [string, unknown[]];
    expect(params).toEqual(['test-user-123', '2026-01-02T00:00:00.000Z', CONV_2, 3]);
    expect(JSON.parse(second.body).nextCursor).toBeNull();
  });

  it('answers 400 for a garbage cursor and for limit > 100', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/llm/conversations?cursor=not-base64-json' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/llm/conversations?limit=101' })).statusCode).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns an empty page when the user has no conversations', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const response = await app.inject({ method: 'GET', url: '/api/llm/conversations' });
    expect(JSON.parse(response.body)).toEqual({ items: [], nextCursor: null });
  });

  it('answers 400 for a non-uuid id on GET and DELETE (#1361)', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/llm/conversations/conv-1' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'DELETE', url: '/api/llm/conversations/conv-1' })).statusCode).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });
```

And in the existing GET-by-id / 404 / DELETE tests replace every `'conv-1'` / `'nonexistent-id'` URL segment and expected param with `CONV_1` / `CONV_2` (the auth-suite URLs may keep `conv-1`: the 401 fires in `onRequest` before parsing).

- [ ] **Step 3: Run to verify they fail**

Run: `cd backend && npx vitest run src/routes/llm/llm-conversations.test.ts && cd ..`
Expected: FAIL on the list shape / 400s.

- [ ] **Step 4: Implement** — replace lines 1–33 of `llm-conversations.ts` with:

```ts
import { FastifyInstance } from 'fastify';
import { query } from '../../core/db/postgres.js';
import { RedisCache } from '../../core/services/redis-cache.js';
import {
  ApplyImprovementRequestSchema,
  ConversationIdParamSchema,
  ConversationListQuerySchema,
  type ConversationSummary,
  type StoredChatMessage,
  type TitleSource,
} from '@compendiq/contracts';
import { confluenceToHtml, htmlToConfluence, htmlToText, markdownToHtml, protectMedia, restoreMedia, extractLayoutSkeleton, LayoutRecoveryError } from '../../core/services/content-converter.js';
import { getClientForUser } from '../../domains/confluence/services/sync-service.js';
import { logAuditEvent } from '../../core/services/audit-service.js';
import { ImprovementsQuerySchema } from './_helpers.js';

/** One row of the conversation list / detail SELECTs (#1361). */
type ConversationRow = {
  id: string;
  title: string;
  title_source: TitleSource;
  model: string;
  page_ref: number | null;
  page_title: string | null;
  created_at: Date;
  updated_at: Date;
};

/**
 * The summary columns every conversation route returns. `title` is COALESCEd
 * on read (a whitespace-only first question yields '' — the DB column stays
 * nullable so the migration cannot fail on a legacy row); the page join is
 * `deleted_at IS NULL` because pages are SOFT deleted and the FK's SET NULL
 * only fires on a hard delete. No visibility predicate on the join: page_ref
 * was authorised at write time (llm-ask.ts), and the row records where the
 * user started a conversation they were allowed to have.
 */
const SUMMARY_COLUMNS = `c.id, COALESCE(NULLIF(trim(c.title), ''), 'Untitled conversation') AS title,
       c.title_source, c.model, c.page_ref, p.title AS page_title, c.created_at, c.updated_at`;
const SUMMARY_FROM = `FROM llm_conversations c
    LEFT JOIN pages p ON p.id = c.page_ref AND p.deleted_at IS NULL`;
// (`SUMMARY_FROM` is used by the list route below and by GET :id in Task 12.)

function toSummary(r: ConversationRow): ConversationSummary {
  return {
    id: r.id,
    title: r.title,
    titleSource: r.title_source,
    model: r.model,
    pageId: r.page_ref,
    pageTitle: r.page_title,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

// Keyset cursor: the (updated_at, id) of the last row served. Keyset rather
// than offset because this list is prepended-to on every ask (updated_at
// bumps), so an offset page shifts under the reader; rename does NOT bump
// updated_at, so paging is stable through it.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function encodeCursor(updatedAtIso: string, id: string): string {
  return Buffer.from(JSON.stringify([updatedAtIso, id])).toString('base64url');
}
function decodeCursor(raw: string | undefined): { updatedAt: string; id: string } | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      Array.isArray(parsed) && parsed.length === 2
      && typeof parsed[0] === 'string' && !Number.isNaN(Date.parse(parsed[0]))
      && typeof parsed[1] === 'string' && UUID_RE.test(parsed[1])
    ) {
      return { updatedAt: new Date(parsed[0]).toISOString(), id: parsed[1] };
    }
  } catch {
    // fall through
  }
  throw Object.assign(new Error('Invalid cursor'), { statusCode: 400 });
}

export async function llmConversationRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // GET /api/llm/conversations?limit&cursor — the user's list, newest first (#1361)
  fastify.get('/llm/conversations', async (request) => {
    const { limit, cursor } = ConversationListQuerySchema.parse(request.query);
    let after: { updatedAt: string; id: string } | null;
    try {
      after = decodeCursor(cursor);
    } catch {
      throw fastify.httpErrors.badRequest('Invalid cursor');
    }
    const result = await query<ConversationRow>(
      `SELECT ${SUMMARY_COLUMNS}
       ${SUMMARY_FROM}
       WHERE c.user_id = $1
         AND ($2::timestamptz IS NULL OR (c.updated_at, c.id) < ($2::timestamptz, $3::uuid))
       ORDER BY c.updated_at DESC, c.id DESC
       LIMIT $4`,
      [request.userId, after?.updatedAt ?? null, after?.id ?? null, limit + 1],
    );
    const page = result.rows.slice(0, limit);
    const last = page[page.length - 1];
    const nextCursor = result.rows.length > limit && last ? encodeCursor(last.updated_at.toISOString(), last.id) : null;
    return { items: page.map(toSummary), nextCursor };
  });
```
Keep the rest of the file (`GET :id`, `DELETE`, improvements, apply) below for now — Tasks 12 and 13 replace `GET :id` and add `PATCH`. In `DELETE` replace `IdParamSchema.parse` with `ConversationIdParamSchema.parse` (the `IdParamSchema` import is removed above; `ChatMessage` import from `prompts.js` is removed too — `GET :id` will use `StoredChatMessage`).

For `GET :id` (Task 12 rewrites it fully) make the minimal edit now so the file typechecks: change its `IdParamSchema.parse` to `ConversationIdParamSchema.parse` and its row type's `messages: ChatMessage[]` to `messages: StoredChatMessage[]`. (`UpdateConversationSchema` is imported in Task 13, where it is first used — `@typescript-eslint/no-unused-vars` is `error` under `--max-warnings=0`, so every commit imports only what it uses.)

- [ ] **Step 5: Run the file and typecheck**

Run: `cd backend && npx vitest run src/routes/llm/llm-conversations.test.ts && npx tsc --noEmit && npm run lint && cd ..`
Expected: PASS; no TS errors; lint clean. (`decodeCursor` throws a 400-shaped error that the route converts to `httpErrors.badRequest` — the test's error handler maps either.)

- [ ] **Step 6: Keep the one live frontend caller tolerant** — `frontend/src/features/ai/AiContext.tsx:607-613` reads this endpoint as a bare array (`apiFetch<Conversation[]>`), and `apiFetch<T>` is an unchecked assertion, so neither typecheck nor the frontend suites (which mock the endpoint with arrays) would notice the `{ items, nextCursor }` shape. Nothing renders `conversations` yet (PR 2 deletes this mirror), so this is a shim, not UI. Replace the `queryFn` line with:

```ts
    // #1361 PR 1: the list endpoint now returns { items, nextCursor }; this
    // mirror is deleted in PR 2 (the pane owns the query). Tolerate both.
    queryFn: async () => {
      const r = await apiFetch<Conversation[] | { items: Conversation[] }>('/llm/conversations');
      return Array.isArray(r) ? r : r.items;
    },
```

Run: `npm run typecheck -w frontend && cd frontend && npx vitest run src/features/ai/AiContext.threads.test.tsx && cd ..`
Expected: clean / PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/src/routes/llm/llm-conversations.ts backend/src/routes/llm/llm-conversations.test.ts frontend/src/features/ai/AiContext.tsx
git commit -m "feat(llm): keyset-paged conversation list with page chip data, uuid id params (#1361)"
```

---

### Task 12: `GET /llm/conversations/:id` — full detail, `historyTruncated`, `unavailable` annotation

**Files:**
- Modify: `backend/src/routes/llm/llm-conversations.ts` (`GET :id`)
- Test: `backend/src/routes/llm/llm-conversations.test.ts` (mock `rbac-service`; extend GET-by-id tests)

**Interfaces:**
- Consumes: `annotateUnavailableSources`, `SUMMARY_COLUMNS`, `SUMMARY_FROM`, `toSummary` (Task 11), `selectReplayableHistory` (Task 3).

- [ ] **Step 1: Write the failing tests**

Add the rbac mock beside the other module mocks at the top of the test file (before the route import):
```ts
// --- Mock: rbac-service (the read-time source annotation binds the caller's spaces) ---
const mockAccessibleSpaces = vi.fn(async (_userId: string) => ['ENG']);
vi.mock('../../core/services/rbac-service.js', () => ({
  getUserAccessibleSpacesMemoized: (userId: string) => mockAccessibleSpaces(userId),
}));
```

Replace `it('should return a specific conversation by ID')` with:
```ts
  it('returns the detail: summary columns, messages with refused/sources, historyTruncated (#1361)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: CONV_1, title: 'Docker questions', title_source: 'generated', model: 'llama3', page_ref: null, page_title: null,
        messages: [
          { role: 'user', content: 'What is Docker?' },
          { role: 'assistant', content: 'A container platform.', sources: [{ pageTitle: 'Intro', pageId: 7, similarity: 0.8 }] },
          { role: 'user', content: 'and 2027 revenue?' },
          { role: 'assistant', content: 'I am not answering.', refused: true },
        ],
        created_at: new Date('2026-01-01T10:00:00Z'), updated_at: new Date('2026-01-01T11:00:00Z'),
      }],
    });
    // the visibility probe for pageId 7 → visible
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 7 }] });

    const response = await app.inject({ method: 'GET', url: `/api/llm/conversations/${CONV_1}` });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toMatchObject({
      id: CONV_1, title: 'Docker questions', titleSource: 'generated', model: 'llama3', pageId: null, pageTitle: null,
      createdAt: '2026-01-01T10:00:00.000Z', updatedAt: '2026-01-01T11:00:00.000Z', historyTruncated: false,
    });
    expect(body.messages).toHaveLength(4);
    expect(body.messages[1].sources[0]).toEqual({ pageTitle: 'Intro', pageId: 7, similarity: 0.8 });
    expect(body.messages[3].refused).toBe(true);
    const [detailSql, detailParams] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(detailSql).toContain('c.messages');
    expect(detailSql).toContain('LEFT JOIN pages p ON p.id = c.page_ref AND p.deleted_at IS NULL');
    expect(detailParams).toEqual([CONV_1, 'test-user-123']);
    const [visSql, visParams] = mockQuery.mock.calls[1] as [string, unknown[]];
    expect(visSql).toContain('deleted_at IS NULL');
    expect(visParams).toEqual([['ENG'], 'test-user-123', [7]]);
  });

  it('marks a source unavailable when its page is trashed or no longer visible, and leaves url sources alone', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: CONV_1, title: 't', title_source: 'question', model: 'm', page_ref: null, page_title: null,
        messages: [
          { role: 'user', content: 'q' },
          { role: 'assistant', content: 'a', sources: [
            { pageTitle: 'Gone', pageId: 9, similarity: 0.5 },
            { pageTitle: 'Still here', pageId: 7, similarity: 0.6 },
            { pageTitle: 'Web', url: 'https://example.com', similarity: null },
          ] },
        ],
        created_at: new Date('2026-01-01T10:00:00Z'), updated_at: new Date('2026-01-01T11:00:00Z'),
      }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 7 }] }); // 9 is not visible

    const body = JSON.parse((await app.inject({ method: 'GET', url: `/api/llm/conversations/${CONV_1}` })).body);
    const [gone, here, web] = body.messages[1].sources;
    expect(gone.unavailable).toBe(true);
    expect(here).not.toHaveProperty('unavailable');
    expect(web).not.toHaveProperty('unavailable');
  });

  it('reports historyTruncated: true for a conversation longer than the replay budget', async () => {
    const messages: Array<{ role: string; content: string }> = [];
    for (let n = 0; n < 6; n++) {
      messages.push({ role: 'user', content: 'x'.repeat(4_000) }, { role: 'assistant', content: 'y'.repeat(4_000) });
    }
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: CONV_1, title: 't', title_source: 'question', model: 'm', page_ref: null, page_title: null, messages,
        created_at: new Date('2026-01-01T10:00:00Z'), updated_at: new Date('2026-01-01T11:00:00Z') }],
    });
    const body = JSON.parse((await app.inject({ method: 'GET', url: `/api/llm/conversations/${CONV_1}` })).body);
    expect(body.historyTruncated).toBe(true);
    expect(body.messages).toHaveLength(12); // stored messages are untouched
  });
```
Keep `it('should return 404 for a non-existent conversation')` but with `CONV_2` in the URL.

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && npx vitest run src/routes/llm/llm-conversations.test.ts -t "detail|unavailable|historyTruncated" && cd ..`
Expected: FAIL.

- [ ] **Step 3: Implement** — add the three imports the detail route needs (they were not imported in Task 11 so that commit stays lint-clean):

```ts
import { getUserAccessibleSpacesMemoized } from '../../core/services/rbac-service.js';
import { visiblePagesPredicate } from '../../core/services/page-visibility.js';
import { selectReplayableHistory } from '../../domains/llm/services/history-budget.js';
```

add the module-level helper (below `decodeCursor`):

```ts
/**
 * Read-time source annotation (#1361): mark a KB source `unavailable` when its
 * page is trashed or no longer visible to the caller — the retrieval path's
 * own predicate, bound the same way rag-service binds it. External/web
 * sources carry no pageId and are never annotated. Nothing is written back.
 */
async function annotateUnavailableSources(messages: StoredChatMessage[], userId: string): Promise<StoredChatMessage[]> {
  const ids = new Set<number>();
  for (const m of messages) for (const s of m.sources ?? []) if (typeof s.pageId === 'number' && s.pageId > 0) ids.add(s.pageId);
  if (ids.size === 0) return messages;
  const spaces = await getUserAccessibleSpacesMemoized(userId);
  const visible = await query<{ id: number }>(
    `SELECT cp.id FROM pages cp
      WHERE cp.id = ANY($3::int[]) AND ${visiblePagesPredicate(1, 2)} AND cp.deleted_at IS NULL`,
    [spaces, userId, [...ids]],
  );
  const ok = new Set(visible.rows.map((r) => r.id));
  return messages.map((m) => (
    m.sources
      ? { ...m, sources: m.sources.map((s) => (typeof s.pageId === 'number' && s.pageId > 0 && !ok.has(s.pageId) ? { ...s, unavailable: true as const } : s)) }
      : m
  ));
}
```

and replace the `GET :id` handler with:

```ts
  // GET /api/llm/conversations/:id — full detail for reopening (#1361)
  fastify.get('/llm/conversations/:id', async (request) => {
    const { id } = ConversationIdParamSchema.parse(request.params);
    const result = await query<ConversationRow & { messages: StoredChatMessage[] }>(
      `SELECT ${SUMMARY_COLUMNS}, c.messages
       ${SUMMARY_FROM}
       WHERE c.id = $1 AND c.user_id = $2`,
      [id, request.userId],
    );
    if (result.rows.length === 0) {
      throw fastify.httpErrors.notFound('Conversation not found');
    }
    const row = result.rows[0]!;
    const messages = await annotateUnavailableSources(row.messages, request.userId);
    return {
      ...toSummary(row),
      messages,
      // The reopen-time half of decision 10: the same walk the ask route runs,
      // so a long conversation says so the moment it opens.
      historyTruncated: selectReplayableHistory(row.messages).truncated,
    };
  });
```

- [ ] **Step 4: Run the file**

Run: `cd backend && npx vitest run src/routes/llm/llm-conversations.test.ts && cd ..`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/llm/llm-conversations.ts backend/src/routes/llm/llm-conversations.test.ts
git commit -m "feat(llm): conversation detail returns historyTruncated and read-time unavailable sources (#1361)"
```

---

### Task 13: `PATCH /llm/conversations/:id` — rename, `title_source = 'user'`, no `updated_at` bump

**Files:**
- Modify: `backend/src/routes/llm/llm-conversations.ts` (add the route after `GET :id`)
- Test: `backend/src/routes/llm/llm-conversations.test.ts` (both suites: 401 + CRUD)

- [ ] **Step 1: Write the failing tests**

In the auth suite:
```ts
  it('should return 401 for PATCH /api/llm/conversations/:id without auth', async () => {
    const response = await app.inject({ method: 'PATCH', url: '/api/llm/conversations/conv-1', payload: { title: 'x' } });
    expect(response.statusCode).toBe(401);
  });
```
In the CRUD suite:
```ts
  // --- PATCH /api/llm/conversations/:id ---

  it('renames: title_source becomes user, updated_at is NOT bumped, returns the summary (#1361)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: CONV_1, title: 'PAT rotation', title_source: 'user', model: 'llama3', page_ref: null, page_title: null,
        created_at: new Date('2026-01-01T10:00:00Z'), updated_at: new Date('2026-01-01T11:00:00Z') }],
    });
    const response = await app.inject({ method: 'PATCH', url: `/api/llm/conversations/${CONV_1}`, payload: { title: '  PAT rotation  ' } });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ id: CONV_1, title: 'PAT rotation', titleSource: 'user' });
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("title_source = 'user'");
    expect(sql).not.toMatch(/updated_at\s*=/);
    expect(params).toEqual([CONV_1, 'test-user-123', 'PAT rotation']);
  });

  it('PATCH answers 404 for another user\'s or a missing conversation', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const response = await app.inject({ method: 'PATCH', url: `/api/llm/conversations/${CONV_2}`, payload: { title: 'x' } });
    expect(response.statusCode).toBe(404);
  });

  it('PATCH answers 400 for a blank title, an over-long title, or a non-uuid id', async () => {
    expect((await app.inject({ method: 'PATCH', url: `/api/llm/conversations/${CONV_1}`, payload: { title: '   ' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: `/api/llm/conversations/${CONV_1}`, payload: { title: 'x'.repeat(201) } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: '/api/llm/conversations/conv-1', payload: { title: 'x' } })).statusCode).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && npx vitest run src/routes/llm/llm-conversations.test.ts -t "PATCH|renames" && cd ..`
Expected: FAIL (404 route-not-found).

- [ ] **Step 3: Implement** — add `UpdateConversationSchema` to the `@compendiq/contracts` import list, then after the `GET :id` handler:

```ts
  // PATCH /api/llm/conversations/:id — rename (#1361). Sets title_source =
  // 'user', which the auto-title (PR 3) never overwrites. Deliberately does
  // NOT bump updated_at: that would re-bucket the row into "Today".
  fastify.patch('/llm/conversations/:id', async (request) => {
    const { id } = ConversationIdParamSchema.parse(request.params);
    const { title } = UpdateConversationSchema.parse(request.body);
    const result = await query<ConversationRow>(
      `UPDATE llm_conversations c
          SET title = $3, title_source = 'user'
        WHERE c.id = $1 AND c.user_id = $2
        RETURNING c.id, c.title, c.title_source, c.model, c.page_ref,
                  (SELECT p.title FROM pages p WHERE p.id = c.page_ref AND p.deleted_at IS NULL) AS page_title,
                  c.created_at, c.updated_at`,
      [id, request.userId, title],
    );
    if (result.rows.length === 0) {
      throw fastify.httpErrors.notFound('Conversation not found');
    }
    return toSummary(result.rows[0]!);
  });
```

- [ ] **Step 4: Run the file, then lint and typecheck the backend**

Run: `cd backend && npx vitest run src/routes/llm/llm-conversations.test.ts && npx tsc --noEmit && npm run lint && cd ..`
Expected: PASS; no lint warnings (unused imports removed).

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/llm/llm-conversations.ts backend/src/routes/llm/llm-conversations.test.ts
git commit -m "feat(llm): PATCH /llm/conversations/:id renames and locks title_source (#1361)"
```

---

### Task 14: Docs (CLAUDE.md rule 6 — same PR)

**Files:**
- Modify: `docs/architecture/09-flow-rag-chat.md:115`, `:193-196`, `:791-799`, `:1519-1524`, new subsection before `## Cache + stampede protection` (`:1530`)
- Modify: `frontend/src/features/ai/source-target.ts:44-46` (comment only)
- Modify: `frontend/src/features/ai/AiContext.tsx:676-679` (comment only)
- Modify: `CLAUDE.md:355` (last clause of the "An honest refusal is a verdict" paragraph)
- Modify: `docs/architecture/06-data-model.md:131-139`
- Modify: `docs/ARCHITECTURE-DECISIONS.md:498-508` (ADR-006: annotate + add snapshot) and ADR-021 (new `### #1361` subsection after `### #1115 — the image_embedding use case (Phase 2)`, `:1812`)

- [ ] **Step 1: 09-flow sequence step (`:115`)** — replace
  `        BE->>CONV: upsert message + answer + sources`
  with
  `        BE->>CONV: append user turn + answer + sources (atomic jsonb ||)`

- [ ] **Step 2: 09-flow score-semantics paragraph (`:193-196`)** — replace the sentence from `And \`sources\` are never persisted` to `regardless of any of this.` with:

```
And `sources` ARE persisted per assistant turn since #1361 — `saveConversation`
writes `{role, content, refused?, sources?}` through `toPersistedSources`
(the chip allow-list: no `score`, no `rerankScore`, `pageId` omitted for
external/web sources) on the stream, cache-hit and refusal paths alike — so a
reopened conversation renders its citation chips and its confidence badge
(computed client-side from `similarity`) exactly as the live answer did; a
refusal still shows no badge (#1119). `GET /llm/conversations/:id` annotates a
source `unavailable: true` at read time when its page is trashed or no longer
visible to the caller (`visiblePagesPredicate`, the retrieval path's own rule).
```

- [ ] **Step 3: 09-flow refusal parenthetical (`:796-798`)** — replace
  `live text names the attached sources, the persisted text — which has no source list on reload — does not)`
  with
  `live text names the attached sources; the persisted text does not, but since #1361 the weak sources ride the persisted turn as structured data and reopen under the same "Closest matches — not used" heading)`

- [ ] **Step 4: 09-flow source-objects paragraph (`:1519-1524`)** — replace from `Nothing needs the fallback:` to `sources to serve.` with:

```
Nothing needs the fallback: `/llm/ask` has always emitted `pageId` on
knowledge-base hits, and the other three routes emit only web sources (which
carry the URL). Persisted sources (#1361) carry the same `pageId`, so the
back-catalogue has no `pageId`-less KB source either — the rule stands on that
ground now that sources are stored.
```
And in `frontend/src/features/ai/source-target.ts:44-46` the same claim is wrapped across three JSDoc lines (` *     … and sources are not persisted with a` / ` *     conversation — \`llm_conversations.messages\` is \`{role, content}\` only,` / ` *     so there is no stored back-catalogue of \`pageId\`-less sources to serve.`) — this is a prose-level rewrite, not a literal string match. Replace those three lines with:

```
 *     web sources (which carry the URL), and persisted sources (#1361) carry
 *     the same `pageId`, so the stored back-catalogue has no `pageId`-less KB
 *     source either.
```
(keep the ` *     \`pageId\` on knowledge-base hits, the other three routes only ever emit` line above them intact).

- [ ] **Step 4b: `AiContext.tsx:676-679` comment** — the `loadConversation` doc comment says *"Note the persisted turn has no `sources`: the backend stores only {role, content, refused} and drops the "closest matches attached" sentence with them, so the reloaded turn claims nothing it cannot show."* Replace that sentence (four wrapped comment lines) with:

```
      // Since #1361 the persisted turn carries its `sources` (the chip
      // allow-list) — the mapping below reads them; the persisted PROSE still
      // omits the "closest matches attached" sentence, so a reloaded refusal
      // never names a list it does not show.
```

- [ ] **Step 4c: `CLAUDE.md:355`** — the paragraph "An honest refusal is a verdict, and it is neutral (#1119)" ends: *"…the persisted turn deliberately carries no sources, so the reloaded copy claims none."* Replace that clause with: *"…the persisted turn carries its weak sources as structured data since #1361 (`toPersistedSources` — the prose still names no list), so a reloaded refusal shows them under the same `Closest matches — not used` heading, and `GET /llm/conversations/:id` marks any whose page is trashed or no longer visible as `unavailable`."* (CLAUDE.md is a mandatory same-PR update for a behaviour change — Code Quality section.)

- [ ] **Step 5: 09-flow new subsection** — insert before `## Cache + stampede protection`:

```markdown
## Conversation persistence (#1361)

`llm_conversations` is the row behind `/ai/c/:id`. What `POST /llm/ask` writes,
in order:

- **Stale id → 404, early.** A `conversationId` that is not the caller's answers
  404 before retrieval and before any SSE header (foreign ids get the same
  answer). The client drops the id; its next ask starts a fresh row.
- **`page_ref` at INSERT.** The page a dock conversation started from, resolved
  through `resolvePageRef` (internal id first, `confluence_id` second,
  int4-safe) and authorised with `userCanAccessPage`; anything unresolved or
  unauthorised stores `NULL`. The list joins `pages` (`deleted_at IS NULL`) for
  `pageTitle`; a trashed page yields no chip. Retrieval never falls back to
  `page_ref` — origin, not live scope.
- **Atomic append.** `UPDATE … SET messages = messages || $3::jsonb … RETURNING id`
  with the new `(user, assistant)` pair only. Concurrent tabs interleave at pair
  granularity. Zero rows (deleted mid-answer) → the final frame carries
  `conversationId: null` and the exchange is not resurrected.
- **Sources per turn** — see *Score semantics* above.
- **Initial title** — the first question, whitespace-collapsed, cut on a word
  boundary at ≤ 80 chars with an ellipsis (`initialTitleFromQuestion`);
  `title_source = 'question'`. `PATCH /llm/conversations/:id { title }` sets
  `'user'` and does not bump `updated_at` (it would re-bucket the row). Auto-title
  (PR 3 of #1361) writes only while `title_source = 'question'`.
- **Replay budget (decision 10).** `selectReplayableHistory` replays the newest
  whole exchanges within `HISTORY_REPLAY_TOKEN_BUDGET` (4,000 tokens by
  `estimateTokens`, a constant — not an env var). Pairing is by role: an
  assistant turn and the user turn before it; a user turn with no assistant after
  it (what a refused exchange leaves behind) is dropped and never counted. The
  stream-path final frame carries `historyTruncated: true` when an exchange was
  dropped, and `GET /llm/conversations/:id` returns the same verdict on reopen.

The read side: `GET /llm/conversations?limit&cursor` is keyset-paged on
`(updated_at DESC, id DESC)` (`llm_conversations_user_updated_idx`), returns
`{ items, nextCursor }` with ISO timestamps, `titleSource`, `pageId`, `pageTitle`;
`GET :id` returns the summary plus `messages` and `historyTruncated`; `DELETE`
stays idempotent. All history routes are `fastify.authenticate` only — reading or
deleting your own history is not model consumption, and a user stripped of
`llm:query` cannot append. Contracts: `ConversationSummarySchema`,
`ConversationDetailSchema`, `ConversationListQuerySchema`,
`ConversationListResponseSchema`, `UpdateConversationSchema`, `SourceSchema`,
`StoredChatMessageSchema` in `@compendiq/contracts`. Design of record:
`docs/superpowers/specs/2026-08-17-ai-conversation-history-design.md`.
```

- [ ] **Step 6: 06-data-model ERD (`:131-139`)** — replace the `llm_conversations` block with:

```
    llm_conversations {
        uuid id PK
        uuid user_id FK
        int page_ref FK "ON DELETE SET NULL — page a dock conversation started from (#1361)"
        text model
        text title
        text title_source "question | generated | user (#1361)"
        jsonb messages "[{role, content, refused?, sources?}]"
        timestamptz created_at
        timestamptz updated_at
    }
```
and add a one-line note under the diagram (find the prose that lists indexes for other tables, or add after the mermaid block): `llm_conversations` carries `llm_conversations_user_updated_idx (user_id, updated_at DESC, id DESC)` for the keyset-paged list (migration 094).

- [ ] **Step 7: ADR-006 snapshot (`:498-508`)** — change the two comments to
  `page_id    TEXT,                     -- never written; dropped by 094 (page_ref)` and
  `title      TEXT,                     -- first question, trimmed; auto-title lands in #1361 PR 3`
  and add after the `007` block:

```sql
-- 094_llm_conversations_history.sql (#1361)
ALTER TABLE llm_conversations DROP COLUMN page_id;
ALTER TABLE llm_conversations
  ADD COLUMN page_ref INTEGER REFERENCES pages(id) ON DELETE SET NULL,
  ADD COLUMN title_source TEXT NOT NULL DEFAULT 'question'
    CHECK (title_source IN ('question', 'generated', 'user'));
CREATE INDEX IF NOT EXISTS llm_conversations_user_updated_idx
  ON llm_conversations (user_id, updated_at DESC, id DESC);
```

- [ ] **Step 7b: ADR-021 `### #1361` subsection** — append after the `### #1115 — the image_embedding use case (Phase 2)` block (structure of `### #1104`, `docs/ARCHITECTURE-DECISIONS.md:1760`):

```markdown
### #1361 — conversation persistence adds no use case

ADR-021 is NOT amended with a new use case by #1361. Conversation persistence
(`page_ref`, per-turn `sources`, atomic append, the `title_source` column, the
keyset-paged list, `PATCH` rename, the history replay budget) is storage and
routing, not an outbound model call. The one model call #1361 adds — the
auto-title (PR 3) — resolves `resolveUsecase('chat')` deliberately, the #1112
argument: a one-line title is a rewrite any chat model can do, and a seventh
assignment would be a knob every operator must set before titles work at all.
It runs after the answer's terminal frame, never in front of it, sanitises its
inputs, constrains its output, and soft-fails to the word-boundary-trimmed
question. Design of record: `docs/superpowers/specs/2026-08-17-ai-conversation-history-design.md`.
```
(PR 3 extends this note with the generation mechanics; PR 1 creates it so the ADR set records #1361.)

- [ ] **Step 8: Verify nothing else states the old claims**

Run: `grep -rn "sources are never persisted\|are not persisted with a conversation\|not persisted\*\* with a conversation\|is \`{role, content}\` only\|carries no sources\|has no \`sources\`\|stores only" docs frontend/src backend/src CLAUDE.md | grep -v superpowers`
Expected: no hits (the `stores only` pattern may surface unrelated lines — read each; the two known ones are `AiContext.tsx:676-679` and `CLAUDE.md:355`, both edited above).

- [ ] **Step 9: Commit**

```bash
git add docs/architecture/09-flow-rag-chat.md docs/architecture/06-data-model.md docs/ARCHITECTURE-DECISIONS.md CLAUDE.md frontend/src/features/ai/source-target.ts frontend/src/features/ai/AiContext.tsx
git commit -m "docs(architecture): conversation persistence — sources, page_ref, atomic append, replay budget (#1361)"
```

---

### Task 15: Final verification and PR

**Files:**
- none

- [ ] **Step 1: Full backend gates for the touched surfaces**

Run:
```bash
npm run build -w @compendiq/contracts && npm run test -w @compendiq/contracts
cd backend && npx vitest run src/routes/llm src/domains/llm/services/history-budget.test.ts src/domains/llm/services/conversation-title.test.ts src/domains/llm/services/persisted-source.test.ts src/core/db/migrations/__tests__ && npx tsc --noEmit && npm run lint && cd ..
```
Expected: all PASS, typecheck clean, lint clean. Then the whole backend suite once: `npm test -w backend` (needs Redis reachable via `REDIS_URL` for the full-app suites — see project memory; if a full-app suite fails only for Redis, say so in the PR body).

- [ ] **Step 2: Frontend gates** — the frontend consumes `@compendiq/contracts` (the old exported `Conversation`/`ConversationSchema` had no importer — `AiContext.tsx:46` declares its own local interface), and the two RUNTIME callers of these endpoints are `AiContext.tsx`'s list mirror (made shape-tolerant in Task 11 Step 6) and `loadConversation` (`:670-698`, which reads `messages`/`model`/`id` — all still present on the detail response, `refused`/`sources` now real).

Run: `npm run typecheck -w frontend && cd frontend && npx vitest run src/features/ai && cd ..`
Expected: clean / PASS.

- [ ] **Step 3: Review the diff against the spec** — `git diff origin/dev --stat` and skim `git diff origin/dev -- backend/src/routes/llm/llm-ask.ts`: INSERT keeps `messages` at `$4`; three final frames carry `conversationId: convId ?? null`; the 404 precedes `hybridSearch`; `selectReplayableHistory` is the only replay path.

- [ ] **Step 4: Open the PR** (targets `dev`; do not stack). Body: the three PRs' sequencing, the migration number check, the local-DB caveat if migrations tests were skipped, the EE grep result for `llm_conversations`, and a link to the spec. Title: `feat(llm): conversation persistence hardening — page_ref, sources per turn, atomic append, keyset list, PATCH rename (#1361, PR 1/3)`.

---

## Self-review (done while writing)

- **Spec coverage (PR 1 section):** migration ✓ (T2), contracts ✓ (T1), `.uuid()` ✓ (T11), `page_ref` resolved + authorised ✓ (T10), sources on all three paths ✓ (T7 — one `persistedSources` computed once, used by every save), atomic append + `RETURNING` + null id ✓ (T7), stale-id 404 ✓ (T6), `initialTitleFromQuestion` ✓ (T4, T9), budget + `historyTruncated` ✓ (T3, T8), keyset list + `pageTitle` + `titleSource` + ISO ✓ (T11), `GET :id` fields + `historyTruncated` + annotation with the memoized spaces + test mocks ✓ (T12), `PATCH` writes `'user'`, no `updated_at` ✓ (T13), `DELETE` idempotent under uuid ✓ (T11), `selectReplayableHistory` in `history-budget.ts` ✓ (T3), docs incl. the drifted anchors and `source-target.ts:45` ✓ (T14). ADR-021 `### #1361` note created ✓ (T14 Step 7b; PR 3 extends it with the generation mechanics). CLAUDE.md:355 and `AiContext.tsx:676-679` — the two other in-repo statements of "no persisted sources" — ✓ (T14 Steps 4b/4c). The one live frontend caller of the list endpoint is made shape-tolerant ✓ (T11 Step 6).
- **Placeholders:** none — every step carries its code or its exact edit.
- **Type consistency:** `saveConversation` returns `{ id: string | null; inserted: boolean }` (T7, used by PR 3); `toPersistedSources(WireSource[]) → PersistedSource[]` (T5 → T7); `selectReplayableHistory(ReplayableMessage[]) → { replay, truncated }` (T3 → T8, T12); `ConversationRow`/`toSummary`/`SUMMARY_COLUMNS`/`SUMMARY_FROM` (T11 → T12, T13); `initialTitleFromQuestion` (T4 → T9/T10); the INSERT's `messages` param index stays `3` throughout.
