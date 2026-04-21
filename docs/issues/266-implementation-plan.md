# Implementation Plan — Issue #266: rename `/api/ollama/circuit-breaker-status` → `/api/llm/circuit-breaker-status`

> Target branch: `feature/266-route-rename-circuit-breaker-status` → PR to `dev`.
> Scope: add canonical route; keep old as deprecated alias for one release cycle with **RFC 9745 / RFC 8594** headers; update docs. Remove in follow-up PR after sunset.
>
> **Decision locked (v2, 2026-04-21):** the deprecation header is the RFC 9745 Structured Item form `Deprecation: @<epoch-seconds>` — **no `Deprecation: true` emitted anywhere**, not even for back-compat. If the issue body text needs adjusting, update it to match the plan.
>
> **Implementation-time deviations (v3, 2026-04-21, implementer):**
> 1. **Handler migration is done in this PR.** Plan §1 assumed PR #262 had already refactored the handler to use `listProviderBreakers()` and return the `Record<providerId, CircuitBreakerStatus>` shape. Verification on `4625bfc` showed the handler still uses `getOllamaCircuitBreakerStatus()` + `getOpenaiCircuitBreakerStatus()` and returns `{ ollama, openai }`. We therefore migrate the handler here, in the same PR that renames the route. No frontend consumer (verified by grep), only one backend test references the old shape.
> 2. **Grace window is 6 months, not 90 days.** Per implementer directive. `DEPRECATION_EPOCH = 1776729600` (2026-04-21T00:00:00Z), `SUNSET_HTTP_DATE = 'Wed, 21 Oct 2026 00:00:00 GMT'`. The plan's `1745222400` was also arithmetically wrong (it resolves to 2025-04-21, not 2026-04-21).
> 3. **No `Warning: 299` header.** Implementer directive lists exactly three response headers for the alias: `Deprecation`, `Sunset`, `Link`. The non-normative `Warning` header from plan §2 Step 2 is dropped.
> 4. **Follow-up sunset date in §3 is updated to 2026-10-21** to match constant (2).

---

## 1. ResearchPack

Line numbers verified on `feature/258-llm-queue-breakers` (`19b8c87`) — post-PR #262.

### 1.1 Files to edit

| File:line | Why |
|---|---|
| `backend/src/routes/llm/llm-models.ts:104–126` | Current handler at `/ollama/circuit-breaker-status`. Factor into shared fn; register both paths; attach deprecation headers on old. |
| `backend/src/routes/llm/llm-models.test.ts:93–193` | 3 existing tests hit old path. Keep + add parallel cases. |
| `docs/ADMIN-GUIDE.md` | Update if old path mentioned. |
| `docs/PERFORMANCE.md` | Update if old path appears. |
| `docs/issues/258-implementation-plan.md:111` | Historical plan — **do not edit**. |

### 1.2 External research — deprecation headers (decision locked)

**RFC 9745 (July 2024)** — *Deprecation HTTP Response Header Field*: https://www.rfc-editor.org/rfc/rfc9745.html

- `Deprecation` is an Item Structured Header (RFC 8941); value is a **Structured Date** (Unix epoch, `@`-prefixed). Canonical form: `Deprecation: @1745222400`.
- The epoch is **the moment the route was marked deprecated**, not the sunset moment.
- Per RFC 9745 §2: the `Link: <url>; rel="successor-version"` relation points at the replacement endpoint. This is the field successor-tooling SHOULD grep.

**RFC 8594 (May 2019)** — *Sunset HTTP Header Field*: https://www.rfc-editor.org/rfc/rfc8594.html

- `Sunset` is an **HTTP-date** (IMF-fixdate, RFC 7231 §7.1.1.1). Canonical form: `Sunset: Mon, 20 Jul 2026 00:00:00 GMT`.
- Per RFC 9745: Sunset MUST NOT be earlier than Deprecation.

**`Warning` header.** RFC 9111 obsoletes for caching, but many shops still grep for `Warning: 299`. Emit alongside `Link` + structured headers for human/log readability. Non-normative but useful.

### 1.3 References to the old path

```
$ rg 'circuit-breaker-status' --type ts --type md
backend/src/routes/llm/llm-models.ts:113
backend/src/routes/llm/llm-models.test.ts:93,94,173,189
docs/issues/258-implementation-plan.md:111   (historical — don't touch)
```

No frontend consumer: `rg 'circuit-breaker-status' frontend/src/` → 0 matches. Verified 2026-04-21.

### 1.4 Grace window

Pre-1.0 CE releases land via `dev → main` (`CLAUDE.md:216–222`). No hard cadence. **Recommendation: 90 days.**

---

## 2. Step-by-step surgical edits

### Step 1 — single source of truth for header values

`backend/src/routes/llm/llm-models.ts` — near the top of the route-plugin function, declare:

```typescript
// ─── Deprecation header constants — single source of truth (issue #266) ────
//
// The /api/ollama/circuit-breaker-status route is a deprecated alias for
// /api/llm/circuit-breaker-status. These constants MUST stay consistent:
//   - `DEPRECATION_EPOCH` is the deploy date of this alias marking; it is the
//     `@`-prefixed Structured Date value per RFC 9745.
//   - `SUNSET_HTTP_DATE` is the HTTP-date per RFC 8594, strictly later than
//     `DEPRECATION_EPOCH`. After this moment the follow-up PR removes the
//     alias entirely (see §3).
//   - `SUCCESSOR_URL` is the replacement route; surfaced via a
//     `Link: <…>; rel="successor-version"` header per RFC 9745 §2.
//
// Adjust all three before opening the PR to match the actual merge date.
const DEPRECATION_EPOCH = 1745222400;              // 2026-04-21T00:00:00Z
const SUNSET_HTTP_DATE = 'Mon, 20 Jul 2026 00:00:00 GMT'; // +90 days
const SUCCESSOR_URL = '/api/llm/circuit-breaker-status';
```

A `vitest` case below asserts `Sunset > Deprecation`; a future tooling-tooling linter could additionally cross-check that `SUNSET_HTTP_DATE === fromEpoch(DEPRECATION_EPOCH) + 90d`, but that's a nit.

### Step 2 — extract handler body + register both routes

Replace `llm-models.ts:104–126` with:

```typescript
  function buildBreakerStatus(): Record<
    string,
    { state: string; failureCount: number; nextRetryTime: number | null }
  > {
    const out: Record<string, { state: string; failureCount: number; nextRetryTime: number | null }> = {};
    for (const snap of listProviderBreakers()) {
      out[snap.providerId] = {
        state: snap.state,
        failureCount: snap.failureCount,
        nextRetryTime: snap.nextRetryTime,
      };
    }
    return out;
  }

  // Canonical route (issue #266).
  fastify.get('/llm/circuit-breaker-status', async () => buildBreakerStatus());

  // DEPRECATED alias — removed after sunset (see follow-up PR in §3).
  fastify.get('/ollama/circuit-breaker-status', async (_request, reply) => {
    // RFC 9745 §2 Structured Item form — NOT "Deprecation: true".
    reply.header('Deprecation', `@${DEPRECATION_EPOCH}`);
    // RFC 8594 — HTTP-date, strictly later than Deprecation (asserted in tests).
    reply.header('Sunset', SUNSET_HTTP_DATE);
    // RFC 9745 §2 — canonical field for tooling auto-migration.
    reply.header('Link', `<${SUCCESSOR_URL}>; rel="successor-version"`);
    // Non-normative human-readable hint. Grepped by ops log pipelines.
    reply.header(
      'Warning',
      `299 - "Deprecated API. Use ${SUCCESSOR_URL} instead."`,
    );
    return buildBreakerStatus();
  });
```

Notes:
- Dropped the old `rel="deprecation"` Link-relation idea from the v1 plan — RFC 9745 §2 prefers `successor-version` because it names the replacement (more useful than merely flagging deprecation, which the `Deprecation` header already does).
- **No `Deprecation: true` fallback.** Ever. Per decision.

### Step 3 — test additions

Keep the 3 existing tests at `llm-models.test.ts:93, 166–189`. Add:

**RED #1 — canonical path returns identical payload, emits no deprecation headers:**
```typescript
it('GET /api/llm/circuit-breaker-status returns the provider-keyed flat map', async () => {
  mockListProviderBreakers.mockReturnValue([
    { providerId: 'p1', state: 'closed', failureCount: 0, nextRetryTime: null },
    { providerId: 'p2', state: 'open',   failureCount: 3, nextRetryTime: 123 },
  ]);
  const r = await app.inject({
    method: 'GET',
    url: '/api/llm/circuit-breaker-status',
    headers: { authorization: `Bearer ${adminToken}` },
  });
  expect(r.statusCode).toBe(200);
  expect(r.json()).toEqual({
    p1: { state: 'closed', failureCount: 0, nextRetryTime: null },
    p2: { state: 'open',   failureCount: 3, nextRetryTime: 123 },
  });
  expect(r.headers['deprecation']).toBeUndefined();
  expect(r.headers['sunset']).toBeUndefined();
  expect(r.headers['link']).toBeUndefined();
});
```

**RED #2 — alias emits RFC 9745 / 8594 headers + parity payload:**
```typescript
it('GET /api/ollama/circuit-breaker-status is a deprecated alias with RFC 9745 / 8594 headers', async () => {
  mockListProviderBreakers.mockReturnValue([
    { providerId: 'p1', state: 'closed', failureCount: 0, nextRetryTime: null },
  ]);
  const r = await app.inject({
    method: 'GET',
    url: '/api/ollama/circuit-breaker-status',
    headers: { authorization: `Bearer ${adminToken}` },
  });
  expect(r.statusCode).toBe(200);
  // Payload parity.
  expect(r.json()).toEqual({ p1: { state: 'closed', failureCount: 0, nextRetryTime: null } });
  // RFC 9745 Structured Item — `@`-prefixed Unix epoch. NOT "true".
  expect(r.headers['deprecation']).toMatch(/^@\d+$/);
  expect(r.headers['deprecation']).not.toBe('true');
  // RFC 8594 IMF-fixdate.
  expect(r.headers['sunset']).toMatch(/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/);
  // RFC 9745 §2 successor link.
  expect(r.headers['link']).toBe('</api/llm/circuit-breaker-status>; rel="successor-version"');
  expect(r.headers['warning']).toContain('/api/llm/circuit-breaker-status');
});
```

**RED #3 — Sunset > Deprecation (RFC 9745 constraint):**
```typescript
it('Sunset date is strictly after Deprecation date', async () => {
  const r = await app.inject({
    method: 'GET',
    url: '/api/ollama/circuit-breaker-status',
    headers: { authorization: `Bearer ${adminToken}` },
  });
  const depEpochMs = parseInt((r.headers['deprecation'] as string).slice(1), 10) * 1000;
  const sunsetEpochMs = new Date(r.headers['sunset'] as string).getTime();
  expect(Number.isFinite(sunsetEpochMs)).toBe(true);
  expect(sunsetEpochMs).toBeGreaterThan(depEpochMs);
});
```

Add `mockListProviderBreakers` following existing test mock shape at `llm-models.test.ts:166–189`.

### Step 4 — docs

- `docs/ADMIN-GUIDE.md`: replace old path with new + footnote: *"Older versions used `/api/ollama/…`; removed after 2026-07-20. See [issue #266]. The deprecated alias emits RFC 9745 `Deprecation` + RFC 8594 `Sunset` + `Link: …; rel="successor-version"` headers during the grace window."*
- `docs/PERFORMANCE.md`: same replacement if path appears.
- `docs/ARCHITECTURE-DECISIONS.md`: annotate if mentioned in an ADR; don't replace (preserve history).

### Step 5 — OpenAPI / contracts / app.ts / migration / Zod

None. No OpenAPI file in repo; `packages/contracts/` is Zod for request bodies (not URLs); `app.ts:266` already registers `llm-models.ts` under `/api`. **No migration, no Zod schema change.**

---

## 3. Follow-up (separate PR, after 2026-07-20)

Remove the alias (~10 LoC). Track as a GH issue "Remove deprecated `/api/ollama/circuit-breaker-status` alias" with due date 2026-07-20.

---

## 4. Rollback

Single-commit revert. Zero user-visible impact.

```bash
git revert <commit-sha>
```

---

## 5. Acceptance criteria mapped to issue body

- [x] **"Both paths return the same response during grace window"** — shared `buildBreakerStatus()`.
- [x] **"Old path sends deprecation headers"** — `Deprecation` (RFC 9745), `Sunset` (RFC 8594), `Link: ...; rel="successor-version"` (RFC 9745 §2), `Warning: 299` (non-normative human hint).
- [x] **"New path documented"** — Step 4. OpenAPI n/a.
- [x] **"Alias removed in follow-up PR"** — §3.

> **Deviation from issue body wording:** the issue says *"emit `Deprecation: true`"*. This plan emits the RFC 9745-compliant form instead. Reviewer: please update the issue body to match or accept this deviation in the PR description.

---

## 6. Risks and open questions

1. **Operator tooling greps for old path?** Unknown; grace window mitigates. `Link: …; rel="successor-version"` gives tooling a machine-readable redirect hint — encourage any operator scripts to follow it.
2. **Browser caching?** Authenticated route, not cached. Non-issue.
3. **Exact merge date for `DEPRECATION_EPOCH`?** Bake in at PR time. Left as `1745222400` (2026-04-21) placeholder; PR author adjusts.

---

## 7. Dependencies and ordering

- **File conflicts:** none — `llm-models.ts` unique to this plan.
- **Sequencing:** parallel with all others.
- **Test fixtures:** independent.

---

## 8. Estimated effort

~45 minutes. ~35 LoC (3 constants + extracted helper + 2 registrations) + 3 tests + small docs. One follow-up PR later.
