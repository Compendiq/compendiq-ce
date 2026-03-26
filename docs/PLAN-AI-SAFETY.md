# Implementation Plan: AI Safety & Verification (Issues #562, #563, #564)

**Branch**: `feature/ai-safety-guardrails` (from `dev`)
**Status**: APPROVED (post-critic review)
**Last updated**: 2026-03-26

---

## Phase Overview

| Phase | Issues | What | Estimated Files |
|-------|--------|------|-----------------|
| **1** | #562 | System prompt guardrails (admin-configurable no-fabrication instruction) | 6 new, 4 modified |
| **2** | #563 | LLM output post-processing (detect/strip/flag fabricated reference sections) | 2 new, 2 modified |
| **3** | #564 | Wire `searchDocumentation()` into generate/improve with frontend toggle | 0 new, 4 modified |
| **4** | #562+#563 | Unified "AI Safety" admin tab + info banner in AI Prompts tab | 2 new, 1 modified |

## Dependency Graph

```
Phase 1 (guardrails)  ──────┐
                             ├──> Phase 4 (unified UI)
Phase 2 (output rules) ─────┘
Phase 3 (web search)   ──────── independent, integrates with P2 via verifiedSources
```

**Execution order**: Phase 1 -> Phase 2 -> Phase 3 -> Phase 4

---

## Critic Fixes Applied

| # | Finding | Resolution |
|---|---------|------------|
| 1 | `correction` SSE event is bad UX (content silently replaced after streaming) | **Removed**. Post-process in `streamSSE()` before caching. No frontend SSE/AiContext changes. |
| 2 | Cache poisoning (cached content bypasses output sanitizer) | Cache stores **cleaned** content. `sendCachedSSE()` needs no changes. |
| 3 | DB query on every LLM request for guardrail settings | 60s in-process TTL cache in `ai-safety-service.ts`, invalidated on PUT. |
| 4 | `searchDocumentation()` returns snippets, not full content | Explicit `fetchDocumentation()` calls per URL with try/catch and snippet fallback. |
| 5 | Regex heading detection too narrow (only `## Heading`) | Broadened to ATX `#`-`####`, setext underlines, `**Heading:**` bold-colon format. |
| 6 | Admin guardrail text is unvalidated injection surface | Sanitize with `sanitizeLlmInput()` on write + audit log for all guardrail changes. |

---

## Phase 1: System Prompt Guardrails (#562)

### Step 1.1: Database migration

**NEW** `backend/src/core/db/migrations/046_ai_safety_settings.sql`

```sql
INSERT INTO admin_settings (setting_key, setting_value, updated_at)
VALUES
  ('ai_guardrail_no_fabrication', 'IMPORTANT: Do not fabricate, invent, or hallucinate references, sources, URLs, citations, or bibliographic entries. If you do not have a verified source for a claim, say so explicitly. Never generate fake links or made-up author names. Only cite sources that were provided to you in the context.', NOW()),
  ('ai_guardrail_no_fabrication_enabled', 'true', NOW()),
  ('ai_output_rule_strip_references', 'true', NOW()),
  ('ai_output_rule_reference_action', 'flag', NOW())
ON CONFLICT (setting_key) DO NOTHING;
```

- Uses existing `admin_settings` table (migration 023)
- `ON CONFLICT DO NOTHING` makes it idempotent
- Seeds both guardrail AND output rule defaults in one migration (same feature set)

**Test**: `backend/src/core/db/migrations/046_ai_safety_settings.test.ts` (NEW)
- Assert all 4 keys exist after migration
- Assert re-running does not overwrite existing values

---

### Step 1.2: AI safety service (with in-process cache)

**NEW** `backend/src/core/services/ai-safety-service.ts`

Exports:
- `getAiGuardrails(): Promise<{ noFabricationInstruction: string; noFabricationEnabled: boolean }>`
- `getAiOutputRules(): Promise<{ stripReferences: boolean; referenceAction: 'flag' | 'strip' | 'off' }>`
- `upsertAiGuardrails(updates): Promise<void>`
- `upsertAiOutputRules(updates): Promise<void>`

**Critic fix #3 — In-process cache**:
```typescript
let guardrailCache: { value: AiGuardrails; expiresAt: number } | null = null;
let outputRuleCache: { value: AiOutputRules; expiresAt: number } | null = null;
const CACHE_TTL_MS = 60_000; // 60 seconds

export async function getAiGuardrails(): Promise<AiGuardrails> {
  if (guardrailCache && Date.now() < guardrailCache.expiresAt) {
    return guardrailCache.value;
  }
  const map = await getAdminSettingsMap();
  const value = {
    noFabricationInstruction: map.ai_guardrail_no_fabrication ?? DEFAULT_NO_FABRICATION,
    noFabricationEnabled: map.ai_guardrail_no_fabrication_enabled !== 'false',
  };
  guardrailCache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}

// Invalidate on write
export async function upsertAiGuardrails(updates: Partial<AiGuardrails>): Promise<void> {
  // ... upsert to admin_settings ...
  guardrailCache = null; // invalidate
}
```

Same pattern for output rules.

Follows `admin-settings-service.ts` for DB access, adds module-level TTL cache since these settings change rarely.

**Critic fix #6 — Audit logging**:
Both `upsertAiGuardrails()` and `upsertAiOutputRules()` must call `logAuditEvent()` with field names (redacted values).

**Test**: `backend/src/core/services/ai-safety-service.test.ts` (NEW)
- Returns defaults when no rows exist
- Returns stored values when rows exist
- Upsert creates/updates rows
- Cache returns stale value within TTL
- Cache invalidated after upsert
- Audit event logged on upsert

---

### Step 1.3: Wire guardrail into prompt resolution

**MODIFY** `backend/src/routes/llm/_helpers.ts`

Change `resolveSystemPrompt()` (lines 67-78):

```typescript
export async function resolveSystemPrompt(userId: string, key: SystemPromptKey): Promise<string> {
  const result = await query<{ custom_prompts: Record<string, string> }>(
    'SELECT custom_prompts FROM user_settings WHERE user_id = $1',
    [userId],
  );
  const custom = result.rows[0]?.custom_prompts?.[key];
  let prompt: string;
  if (custom && custom.trim()) {
    prompt = `${custom} ${LANGUAGE_PRESERVATION_INSTRUCTION}`;
  } else {
    prompt = getSystemPrompt(key);
  }

  // Append admin-configured guardrails
  const guardrails = await getAiGuardrails();
  if (guardrails.noFabricationEnabled && guardrails.noFabricationInstruction) {
    prompt += ` ${guardrails.noFabricationInstruction}`;
  }

  return prompt;
}
```

**Also MODIFY** `backend/src/routes/llm/llm-chat.ts`:
- Change `/ask` route (line ~469) to use `resolveSystemPrompt(userId, 'ask')` instead of raw `getSystemPrompt('ask')` — ensures guardrail covers ALL prompt paths consistently.

**Test**: `backend/src/routes/llm/_helpers.test.ts` (NEW or MODIFY)
- Appends no-fabrication instruction when enabled
- Does NOT append when disabled
- Custom user prompt + guardrail + language preservation all coexist
- Uses cached guardrail settings (no extra DB hit within TTL)

---

### Step 1.4: Contracts schema

**MODIFY** `packages/contracts/src/schemas/admin.ts`

Add to both `AdminSettingsSchema` and `UpdateAdminSettingsSchema`:
```typescript
aiGuardrailNoFabrication: z.string().max(5000).optional(),
aiGuardrailNoFabricationEnabled: z.boolean().optional(),
aiOutputRuleStripReferences: z.boolean().optional(),
aiOutputRuleReferenceAction: z.enum(['flag', 'strip', 'off']).optional(),
```

All `.optional()` — backwards-compatible.

---

### Step 1.5: Admin routes

**MODIFY** `backend/src/routes/foundation/admin.ts`

`GET /api/admin/settings`:
- Import `getAiGuardrails`, `getAiOutputRules`
- Add fields to response object

`PUT /api/admin/settings`:
- Detect AI safety field changes
- **Critic fix #6**: Sanitize guardrail text before storing:
  ```typescript
  if (body.aiGuardrailNoFabrication !== undefined) {
    const { sanitized } = sanitizeLlmInput(body.aiGuardrailNoFabrication);
    await upsertAiGuardrails({ noFabricationInstruction: sanitized });
  }
  ```
- Call `upsertAiGuardrails()` / `upsertAiOutputRules()` (which handle audit logging internally)

**Test**: `backend/src/routes/foundation/admin.test.ts` (MODIFY)
- GET includes AI safety fields
- PUT persists guardrail updates
- PUT sanitizes guardrail text (no prompt injection payloads stored)
- PUT logs audit events

---

### Step 1.6: Public AI safety status endpoint

**MODIFY** `backend/src/routes/foundation/settings.ts`

```typescript
// GET /api/settings/ai-safety — any authenticated user
fastify.get('/settings/ai-safety', async () => {
  const guardrails = await getAiGuardrails();
  const outputRules = await getAiOutputRules();
  return {
    guardrails: { noFabricationEnabled: guardrails.noFabricationEnabled },
    outputRules: {
      stripReferences: outputRules.stripReferences,
      referenceAction: outputRules.referenceAction,
    },
  };
});
```

Returns metadata only — instruction text NOT exposed to non-admins.

**Test**: `backend/src/routes/foundation/settings.test.ts` (MODIFY)
- Returns expected shape
- Non-admin can access
- Does NOT expose instruction text

---

## Phase 2: LLM Output Post-Processing (#563)

### Step 2.1: Output sanitizer

**NEW** `backend/src/core/utils/sanitize-llm-output.ts`

```typescript
export interface OutputSanitizeResult {
  content: string;
  wasModified: boolean;
  strippedSections: string[];   // names of detected sections
  disclaimer: string | null;
}

export interface OutputRules {
  stripReferences: boolean;
  referenceAction: 'flag' | 'strip' | 'off';
  verifiedSources?: string[];   // URLs from RAG/MCP that are real
}

export function sanitizeLlmOutput(output: string, rules: OutputRules): OutputSanitizeResult;
```

**Critic fix #5 — Broadened detection patterns**:
```typescript
// ATX headings: #, ##, ###, ####
/^#{1,4}\s*(References|Sources|Bibliography|Works Cited|Further Reading)\s*$/im

// Setext headings: underlined with === or ---
/^(References|Sources|Bibliography|Works Cited|Further Reading)\s*\n[=-]{3,}$/im

// Bold-colon format: **References:** or **Sources:**
/^\*\*(References|Sources|Bibliography|Works Cited|Further Reading)\*\*:?\s*$/im
```

Logic:
1. If `referenceAction === 'off'` or `!stripReferences` — pass through unchanged
2. Detect reference section(s) using broadened patterns
3. For each detected section, extract URLs and check against `verifiedSources`
4. If ALL URLs in a section are verified — preserve it
5. If ANY URLs are unverified:
   - `strip` — remove the entire section
   - `flag` — prepend disclaimer: `> **Note**: The following references were generated by AI and have not been verified.`
6. Return result with metadata about what was modified

**Test**: `backend/src/core/utils/sanitize-llm-output.test.ts` (NEW)
- Detects `## References` (ATX style)
- Detects `### Sources` (ATX h3)
- Detects setext-style `References\n-----------`
- Detects `**References:**` (bold-colon)
- `strip` action removes the section entirely
- `flag` action prepends disclaimer
- `off` action passes through unchanged
- Verified sources are preserved
- Mixed verified/unverified — section flagged/stripped, verified URLs noted
- No reference section — passes through unchanged
- Empty output — passes through
- Multiple reference sections — all detected
- Non-English heading not detected (documented limitation)
- Case-insensitive matching works (`## REFERENCES`, `## references`)

---

### Step 2.2: Wire into streaming pipeline (server-side, before cache)

**MODIFY** `backend/src/routes/llm/_helpers.ts`

**Critic fix #1 + #2 — No correction event, clean before cache**:

Add optional `postProcess` to `streamSSE()`:

```typescript
export async function streamSSE(
  request: ..., reply: ..., generator: ...,
  extras?: Record<string, unknown>,
  options?: {
    llmCache?: LlmCache;
    cacheKey?: string;
    postProcess?: (content: string) => OutputSanitizeResult;
  },
): Promise<string> {
  let fullContent = '';
  for await (const chunk of generator) {
    fullContent += chunk.content;
    reply.raw.write(`data: ${JSON.stringify({ content: chunk.content, done: chunk.done })}\n\n`);
  }

  // Post-process BEFORE caching (critic fix #1 + #2)
  if (options?.postProcess && fullContent) {
    const result = options.postProcess(fullContent);
    if (result.wasModified) {
      fullContent = result.content;
      // Send the cleaned version as a final replacement chunk
      // so the frontend accumulates the correct final content
      reply.raw.write(`data: ${JSON.stringify({
        content: '', done: true,
        finalContent: result.content,
        referencesStripped: result.strippedSections,
      })}\n\n`);
    }
  }

  // Cache the CLEANED content
  if (options?.llmCache && options?.cacheKey && fullContent) {
    await options.llmCache.setCachedResponse(options.cacheKey, fullContent);
  }
  return fullContent;
}
```

Key design decisions:
- Post-processing happens **after** full accumulation, **before** caching
- The cache stores cleaned content — `sendCachedSSE()` needs NO changes
- A `finalContent` field in the last SSE chunk lets the frontend replace accumulated text if needed
- No separate "correction" event — just a final chunk with the cleaned content

**In each route handler** (`/improve`, `/generate`, `/summarize`):
```typescript
const outputRules = await getAiOutputRules();
const postProcess = outputRules.stripReferences
  ? (content: string) => sanitizeLlmOutput(content, {
      ...outputRules,
      verifiedSources: webSources?.map(s => s.url) ?? [],
    })
  : undefined;

await streamSSE(request, reply, generator, extras, { llmCache, cacheKey, postProcess });
```

**Frontend change** (minimal):

**MODIFY** `frontend/src/features/ai/AiContext.tsx`

In `runStream()`, check for `finalContent` in the last chunk:
```typescript
if (chunk.finalContent) {
  accumulated = chunk.finalContent; // replace with cleaned version
}
```

This is a ~3-line change, not the complex correction event handling from the original plan.

**Test**: `backend/src/routes/llm/_helpers.test.ts` (MODIFY)
- `streamSSE` with postProcess that strips references: cached content is cleaned
- `streamSSE` with postProcess that flags: cached content has disclaimer
- `streamSSE` without postProcess: cached content unchanged
- `sendCachedSSE` serves cleaned content (no bypass)

---

## Phase 3: Web Search in Generate/Improve (#564)

### Step 3.1: Contracts

**MODIFY** `packages/contracts/src/schemas/llm.ts`

Add to `GenerateRequestSchema` and `ImproveRequestSchema`:
```typescript
searchWeb: z.boolean().optional(),
searchQuery: z.string().max(500).optional(),
```

---

### Step 3.2: Wire into generate route

**MODIFY** `backend/src/routes/llm/llm-chat.ts`

In `POST /api/llm/generate` handler, after body parsing and sanitization:

**Critic fix #4 — Explicit fetchDocumentation() with error handling**:

```typescript
import { isEnabled as isMcpDocsEnabled, searchDocumentation, fetchDocumentation } from '../../core/services/mcp-docs-client.js';

const webSources: Array<{ url: string; title: string; snippet: string }> = [];
if (body.searchWeb && await isMcpDocsEnabled()) {
  try {
    const searchQuery = body.searchQuery || sanitized.slice(0, 200);
    const searchResults = await searchDocumentation(searchQuery, userId, 3);

    // Fetch full content for top 2 results (critic fix #4)
    for (const result of searchResults.slice(0, 2)) {
      try {
        const doc = await fetchDocumentation(result.url, userId, 5000);
        const { sanitized: cleanDoc } = sanitizeLlmInput(doc.markdown);
        webSources.push({ url: result.url, title: result.title, snippet: cleanDoc });
      } catch (fetchErr) {
        // Graceful degradation: fall back to search snippet
        logger.warn({ err: fetchErr, url: result.url }, 'Failed to fetch full doc, using snippet');
        webSources.push({ url: result.url, title: result.title, snippet: result.snippet });
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Web search failed for generate route, continuing without');
  }
}

// Inject into user content if we got results
if (webSources.length > 0) {
  const webContext = webSources.map((s, i) =>
    `[Web Source ${i + 1}: "${s.title}" (${s.url})]\n${s.snippet}`
  ).join('\n\n---\n\n');
  userContent = `${userContent}\n\n---\n\nVerified reference material from web search:\n\n${webContext}`;
}

// Pass web source URLs as verifiedSources to output sanitizer (Phase 2 integration)
const postProcess = outputRules.stripReferences
  ? (content: string) => sanitizeLlmOutput(content, {
      ...outputRules,
      verifiedSources: webSources.map(s => s.url),
    })
  : undefined;

// Pass sources as SSE extras for frontend citation display
const extras = webSources.length > 0 ? {
  sources: webSources.map(s => ({
    pageTitle: s.title,
    spaceKey: 'Web',
    confluenceId: s.url,
    score: 1,
  })),
} : undefined;
```

---

### Step 3.3: Wire into improve route

**MODIFY** `backend/src/routes/llm/llm-chat.ts`

Same pattern as generate. Search query defaults to `body.searchQuery || instruction?.slice(0, 200) || 'improve technical documentation'`.

---

### Step 3.4: Frontend toggle (GenerateMode)

**MODIFY** `frontend/src/features/ai/modes/GenerateMode.tsx`

```typescript
const [searchWeb, setSearchWeb] = useState(false);

const { data: mcpSettings } = useQuery<{ enabled: boolean }>({
  queryKey: ['mcp-docs', 'status'],
  queryFn: () => apiFetch('/mcp-docs/status'),
  staleTime: 5 * 60_000,
  retry: false,
});
const mcpEnabled = mcpSettings?.enabled ?? false;
```

Add checkbox (visible only when MCP enabled):
```tsx
{mcpEnabled && (
  <label className="flex items-center gap-2 text-sm text-muted-foreground">
    <input type="checkbox" checked={searchWeb}
      onChange={(e) => setSearchWeb(e.target.checked)}
      disabled={isStreaming} className="rounded border-border/40"
      data-testid="generate-search-web-toggle" />
    Search web for reference material
  </label>
)}
```

In `handleGenerate()`: `if (searchWeb) body.searchWeb = true;`

**Test**: `frontend/src/features/ai/modes/GenerateMode.test.tsx` (MODIFY)
- Toggle hidden when MCP disabled
- Toggle visible when MCP enabled
- `searchWeb: true` included in request when checked

---

### Step 3.5: Frontend toggle (ImproveMode)

**MODIFY** `frontend/src/features/ai/modes/ImproveMode.tsx`

Same pattern as GenerateMode.

**Test**: `frontend/src/features/ai/modes/ImproveMode.test.tsx` (MODIFY)

---

## Phase 4: Unified AI Safety Settings UI (#562 + #563)

### Step 4.1: Admin "AI Safety" tab

**NEW** `frontend/src/features/settings/AiSafetyTab.tsx`

Two sections:

**Section 1 — AI Guardrails**:
- Toggle: "Enable no-fabrication guardrail" (checkbox)
- Textarea: Custom instruction text (with placeholder showing default)
- "Reset to default" button
- Info text: "This instruction is appended to all LLM system prompts for all users."

**Section 2 — AI Output Rules**:
- Toggle: "Enable reference section detection" (checkbox)
- Radio group: Action when unverified references detected
  - `flag` — Keep but prepend AI disclaimer
  - `strip` — Remove the section entirely
  - `off` — No action
- Info text explaining each action

UI pattern: same as `EmbeddingTab()` — useQuery for GET, local state, useMutation for PUT, toast.

**MODIFY** `frontend/src/features/settings/SettingsPage.tsx`
- Add `'ai-safety'` to tab list (`{ id: 'ai-safety', label: 'AI Safety', adminOnly: true }`)
- Import and render `AiSafetyTab`

**Test**: `frontend/src/features/settings/AiSafetyTab.test.tsx` (NEW)
- Renders guardrail toggle and textarea
- Renders output rule toggle and action selector
- Save calls PUT with correct payload
- Values initialize from admin settings

---

### Step 4.2: Info banner in AI Prompts tab

**MODIFY** `frontend/src/features/settings/SettingsPage.tsx`

In `AiPromptsTab()`, fetch and display active rules:

```tsx
const { data: aiSafety } = useQuery({
  queryKey: ['settings', 'ai-safety'],
  queryFn: () => apiFetch('/settings/ai-safety'),
  staleTime: 60_000,
});

// At top of the tab content:
{aiSafety && (aiSafety.guardrails.noFabricationEnabled || aiSafety.outputRules.stripReferences) && (
  <div className="rounded-lg border border-sky-500/30 bg-sky-500/10 p-3 text-sm text-sky-300">
    <p className="font-medium">Active AI Safety Rules</p>
    <ul className="mt-1 list-disc pl-5 text-xs">
      {aiSafety.guardrails.noFabricationEnabled && (
        <li>No-fabrication guardrail active (prevents hallucinated references)</li>
      )}
      {aiSafety.outputRules.stripReferences && (
        <li>Reference detection active (action: {aiSafety.outputRules.referenceAction})</li>
      )}
    </ul>
  </div>
)}
```

**Test**: `frontend/src/features/settings/SettingsPage.test.tsx` (MODIFY)
- Banner appears when guardrails enabled
- Banner hidden when all disabled
- Correct text for each active rule

---

## Complete File Summary

### New Files (8)

| File | Phase |
|------|-------|
| `backend/src/core/db/migrations/046_ai_safety_settings.sql` | 1 |
| `backend/src/core/db/migrations/046_ai_safety_settings.test.ts` | 1 |
| `backend/src/core/services/ai-safety-service.ts` | 1 |
| `backend/src/core/services/ai-safety-service.test.ts` | 1 |
| `backend/src/core/utils/sanitize-llm-output.ts` | 2 |
| `backend/src/core/utils/sanitize-llm-output.test.ts` | 2 |
| `frontend/src/features/settings/AiSafetyTab.tsx` | 4 |
| `frontend/src/features/settings/AiSafetyTab.test.tsx` | 4 |

### Modified Files (8)

| File | Phase | Changes |
|------|-------|---------|
| `packages/contracts/src/schemas/admin.ts` | 1 | Add AI safety fields (all optional) |
| `packages/contracts/src/schemas/llm.ts` | 3 | Add `searchWeb`, `searchQuery` fields (optional) |
| `backend/src/routes/llm/_helpers.ts` | 1, 2 | Guardrails in `resolveSystemPrompt()`, `postProcess` in `streamSSE()` |
| `backend/src/routes/llm/llm-chat.ts` | 1, 2, 3 | Fix `/ask` to use `resolveSystemPrompt()`, wire web search + output sanitizer into generate/improve |
| `backend/src/routes/foundation/admin.ts` | 1 | AI safety fields in GET/PUT with sanitization + audit |
| `backend/src/routes/foundation/settings.ts` | 1 | New `GET /api/settings/ai-safety` endpoint |
| `frontend/src/features/ai/modes/GenerateMode.tsx` | 3 | searchWeb toggle |
| `frontend/src/features/ai/modes/ImproveMode.tsx` | 3 | searchWeb toggle |
| `frontend/src/features/settings/SettingsPage.tsx` | 4 | AI Safety tab + info banner |
| `frontend/src/features/ai/AiContext.tsx` | 2 | Handle `finalContent` in last SSE chunk (~3 lines) |

### Modified Test Files (5-6)

| File | Phase |
|------|-------|
| `backend/src/routes/llm/_helpers.test.ts` | 1, 2 |
| `backend/src/routes/foundation/admin.test.ts` | 1 |
| `backend/src/routes/foundation/settings.test.ts` | 1 |
| `frontend/src/features/ai/modes/GenerateMode.test.tsx` | 3 |
| `frontend/src/features/ai/modes/ImproveMode.test.tsx` | 3 |
| `frontend/src/features/settings/SettingsPage.test.tsx` | 4 |

---

## Rollback Procedure

Each phase is independently reversible:

**Phase 1**: Revert `_helpers.ts`, `admin.ts`, `settings.ts`, `llm-chat.ts` changes. Remove `ai-safety-service.ts`. Delete seeded rows:
```sql
DELETE FROM admin_settings WHERE setting_key LIKE 'ai_guardrail_%' OR setting_key LIKE 'ai_output_rule_%';
```

**Phase 2**: Revert `_helpers.ts` (remove postProcess), `llm-chat.ts` (remove postProcess construction), `AiContext.tsx`. Remove `sanitize-llm-output.ts`.

**Phase 3**: Revert `llm-chat.ts` (remove web search blocks), `GenerateMode.tsx`, `ImproveMode.tsx`. Revert contract changes.

**Phase 4**: Remove `AiSafetyTab.tsx`. Revert `SettingsPage.tsx`.

**Full rollback**: Revert all modified files, delete all new files, run SQL cleanup above.

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Guardrail inflates prompt tokens | Low | Low | ~85 tokens; admin can shorten or disable |
| Output sanitizer latency | Very Low | Low | Sub-ms regex on accumulated text; runs once per request |
| Web search adds latency to generate/improve | Medium | Low | Opt-in toggle; ~500ms worst case; graceful degradation to snippets |
| Reference detection false positives | Low | Medium | Conservative heading patterns; verified sources whitelisted; admin can set `flag` (keep with disclaimer) |
| Non-English reference headings missed | Medium | Low | Documented limitation; admin can customize patterns in future iteration |
| Breaking contract changes | None | High | All new fields `.optional()` |
| Admin prompt injection via guardrail text | Low | High | `sanitizeLlmInput()` on write + audit logging |
| Cache serves stale guardrail settings | Low | Low | 60s TTL; max 60s delay for admin changes to take effect |

---

## Known Limitations (Documented)

1. **Non-English reference headings**: The output sanitizer detects English heading patterns only. German ("Quellenangaben"), Dutch ("Referenties"), etc. are not covered. This can be addressed in a future iteration by making patterns admin-configurable.
2. **Inline reference lists**: References formatted as inline text (not under a heading) are not detected. The guardrail (#562) is the primary defense; the output sanitizer (#563) is best-effort fallback.
3. **60-second guardrail cache**: Admin changes to guardrail text/enabled state take up to 60 seconds to propagate to LLM requests. Acceptable for an admin-set-once configuration.
