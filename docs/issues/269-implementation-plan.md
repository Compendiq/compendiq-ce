# Implementation Plan — Issue #269: annotate pre-#256 references in `ai-assistant-qa-internal-server-error.md`

> Docs-only, trivial. Target branch: `feature/269-qa-doc-banner` → PR to `dev`.
> Scope: add a single banner at the top. Body untouched.

---

## 1. ResearchPack

### 1.1 File to edit

| File:line | Observation |
|---|---|
| `docs/issues/ai-assistant-qa-internal-server-error.md:1` | H1 at line 1. Add banner directly under, before `## Bug Description` at line 3. |

### 1.2 Why a banner, not a rewrite

Issue body is explicit: rewriting would falsify the "as observed" state. The symbols referenced (`ollamaBreakers.embed`, `rag-service.ts:197`, `llm-chat.ts:340`) are gone after #256 / #259 / #262 but were real at the time.

### 1.3 Pre-#256 references audited against current tree

| Reference in doc | Current-day status |
|---|---|
| `ollamaBreakers.embed` (doc:42, 109) | Gone — removed by PR #262. Replaced by per-`providerId` breakers at `circuit-breaker.ts:158–211`. |
| `rag-service.ts:197` (doc:46) | File exists; line drifted. `providerGenerateEmbedding()` no longer at :197. |
| `llm-chat.ts:340` / `:347-348` / `:361` (doc:13, 27, 87, 196, 269) | File gone. `/api/llm/ask` handler lives at `routes/llm/llm-ask.ts`. |
| `llm-provider.ts :: providerGenerateEmbedding` (doc:106) | Replaced by `openai-compatible-client.ts :: generateEmbedding` (`:141–158`). |
| `ollama-provider.ts :: generateEmbedding` (doc:107) | File deleted in #256. |
| `app.ts:139` (doc:27) | Error-message-stripping may still exist; line drifted. |

### 1.4 External research

None.

---

## 2. Step-by-step surgical edits

Single file. Single insertion.

Current (lines 1–3):
```
# Issue: AI Assistant Q&A mode returns "Internal Server Error"

## Bug Description
```

Target:
```
# Issue: AI Assistant Q&A mode returns "Internal Server Error"

> **Note:** This report describes pre-#256 (pre-multi-LLM-provider) code paths. File and symbol references below (e.g. `ollamaBreakers.embed`, `llm-chat.ts:340`, `rag-service.ts:197`) reflect the codebase at the time of the incident and may be stale as of the current tree. For the current architecture, see `docs/ARCHITECTURE-DECISIONS.md` (ADR-021) and `docs/architecture/`.

## Bug Description
```

Slight extension of issue's suggested banner with concrete symbol list — heads off "why can't I grep this symbol?" confusion. Defer to reviewer if preference is the shorter version.

No edits below line 3.

---

## 3. Tests / Rollback / AC

- No tests.
- Rollback: `git checkout origin/dev -- docs/issues/ai-assistant-qa-internal-server-error.md`.
- AC: banner added ✓ — body untouched ✓.

---

## 4. Risks + dependencies

1. Short vs extended banner wording. Recommend extended.

- No dependencies. Zero conflicts with #263–#268.

~5 min effort.
