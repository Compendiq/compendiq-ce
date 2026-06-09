# Unit A — #718: Restore the AI Auto-tag button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the AI Auto-tag button reappear in the article right pane (read mode, edit mode, collapsed rail) by removing the legacy `activeModel` gate that ADR-021 / migration 054 emptied.

**Architecture:** Frontend-only. The backend `POST /pages/:id/auto-tag` already resolves the `auto_tag` use-case server-side, so the client needs no model. Drop the legacy `settings.llmProvider/ollamaModel/openaiModel`-derived gate; make `AutoTagger`'s `model` prop optional; gate visibility on a new-source "AI configured" signal (mirroring `AiContext`'s `usecase-default` query) that defaults to *visible*.

**Tech Stack:** React 19, TanStack Query, Vitest + @testing-library/react (jsdom).

**Branch:** `feature/issue-718-autotag-button` off `dev`.

---

### Task 1: Make `AutoTagger`'s `model` prop optional

**Files:**
- Modify: `frontend/src/features/pages/AutoTagger.tsx:14-19` (props), `:27-32` (mutation body)
- Test: `frontend/src/features/pages/AutoTagger.test.tsx` (create if absent)

- [ ] **Step 1: Write the failing test**

Create/extend `frontend/src/features/pages/AutoTagger.test.tsx`:

```tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AutoTagger } from './AutoTagger';

const apiFetch = vi.fn();
vi.mock('../../shared/lib/api', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));
vi.mock('sonner', () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() } }));

function renderWith(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe('AutoTagger', () => {
  beforeEach(() => apiFetch.mockReset());

  it('omits model from the request body when no model prop is given', async () => {
    apiFetch.mockResolvedValue({ suggestedTags: [], existingLabels: [] });
    renderWith(<AutoTagger pageId="42" currentLabels={[]} />);
    fireEvent.click(screen.getByText('Auto-tag'));
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    const [, opts] = apiFetch.mock.calls[0];
    expect(JSON.parse((opts as { body: string }).body)).toEqual({});
  });

  it('still sends model when provided', async () => {
    apiFetch.mockResolvedValue({ suggestedTags: [], existingLabels: [] });
    renderWith(<AutoTagger pageId="42" currentLabels={[]} model="bge-x" />);
    fireEvent.click(screen.getByText('Auto-tag'));
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    const [, opts] = apiFetch.mock.calls[0];
    expect(JSON.parse((opts as { body: string }).body)).toEqual({ model: 'bge-x' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/features/pages/AutoTagger.test.tsx`
Expected: FAIL — `model` is currently required (type error) / body always `{ model: undefined }`.

- [ ] **Step 3: Make the prop optional and conditionally include it**

In `AutoTagger.tsx`, change the interface (`:14-19`):

```tsx
interface AutoTaggerProps {
  pageId: string;
  currentLabels: string[];
  model?: string;
  className?: string;
}
```

And the mutation body (`:27-32`) so `model` is only sent when present:

```tsx
  const autoTagMutation = useMutation({
    mutationFn: () =>
      apiFetch<AutoTagResult>(`/pages/${pageId}/auto-tag`, {
        method: 'POST',
        body: JSON.stringify(model ? { model } : {}),
      }),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/features/pages/AutoTagger.test.tsx`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/pages/AutoTagger.tsx frontend/src/features/pages/AutoTagger.test.tsx
git commit -m "feat(autotag): make AutoTagger model prop optional (#718)"
```

---

### Task 2: Replace the legacy `activeModel` gate in `ArticleRightPane`

**Files:**
- Modify: `frontend/src/shared/components/article/ArticleRightPane.tsx:207-210` (delete `activeModel`), `:511` / `:655` / `:678` (gates)
- Reference pattern: `frontend/src/features/ai/AiContext.tsx:264-272` (the `usecase-default` query)

- [ ] **Step 1: Write the failing test** — see Task 3 (the ArticleRightPane test drives this). Implement Task 2 and Task 3 together; the test in Task 3 is the failing test for this change.

- [ ] **Step 2: Delete the legacy `activeModel` derivation**

Remove `ArticleRightPane.tsx:207-210`:

```tsx
  // Derive the active LLM model from settings for auto-tagging
  const activeModel = settings?.llmProvider === 'openai'
    ? (settings.openaiModel ?? '')
    : (settings?.ollamaModel ?? '');
```

- [ ] **Step 3: Add a new-source "AI configured for auto-tag" gate**

Near the other queries (after `const { data: settings } = useSettings();`, ~`:197`), add a query mirroring `AiContext.tsx:264-272`. Import `useQuery` from `@tanstack/react-query` and `apiFetch` from the shared api lib if not already imported.

```tsx
  // #718: gate the Auto-tag button on the NEW provider source, not the removed
  // legacy settings.llmProvider/ollamaModel/openaiModel fields (ADR-021 / migration
  // 054). The backend resolves the auto_tag use-case itself; we only hide the button
  // when we positively know no provider can serve auto-tag. Default to VISIBLE while
  // the query is in flight so the button never flickers out on load.
  const autoTagDefaultQuery = useQuery<{ model?: string | null }>({
    queryKey: ['llm', 'usecase-default', 'auto_tag'],
    queryFn: () => apiFetch('/llm/usecase-default?usecase=auto_tag'),
    retry: false,
    staleTime: 30_000,
  });
  const aiAutoTagAvailable =
    autoTagDefaultQuery.isLoading || Boolean(autoTagDefaultQuery.data?.model);
```

- [ ] **Step 4: Update the three render gates**

Collapsed rail (`:511`):

```tsx
                {aiAutoTagAvailable && id && (
                  <AutoTagger
                    pageId={id}
                    currentLabels={page?.labels ?? []}
                    className={`${railIconBtn} [&>span]:hidden`}
                  />
                )}
```

Edit mode (`:655-664`):

```tsx
      {page && id && aiAutoTagAvailable && editing && (
        <div className="p-2 space-y-0.5" data-testid="article-actions-edit">
          <AutoTagger
            pageId={id}
            currentLabels={page?.labels ?? []}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-muted-foreground transition-all duration-200 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-1 focus-visible:ring-offset-background hover:bg-[var(--glass-pill-hover)] hover:text-foreground"
          />
        </div>
      )}
```

Read mode (`:678-685`):

```tsx
          {id && aiAutoTagAvailable && (
            <AutoTagger
              pageId={id}
              currentLabels={page?.labels ?? []}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-muted-foreground transition-all duration-200 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-1 focus-visible:ring-offset-background hover:bg-[var(--glass-pill-hover)] hover:text-foreground"
            />
          )}
```

(The `model={activeModel}` prop is removed from all three.)

- [ ] **Step 5: Typecheck**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors (and no remaining references to `activeModel`).

---

### Task 3: Update `ArticleRightPane.test.tsx` to the new provider model + regression guard

**Files:**
- Modify: `frontend/src/shared/components/article/ArticleRightPane.test.tsx:73-87` (mocks)

- [ ] **Step 1: Update the settings mock and AutoTagger mock**

The `use-settings` mock (`:73-77`) currently feeds legacy `ollamaModel`/`llmProvider`. Remove those fields (keep `confluenceUrl`):

```tsx
vi.mock('../../hooks/use-settings', () => ({
  useSettings: () => ({
    data: { confluenceUrl: 'https://confluence.example.com' },
  }),
}));
```

The component now issues a TanStack Query to `/llm/usecase-default?usecase=auto_tag`. Ensure the test renders within a `QueryClientProvider` and stub `apiFetch` so the query resolves with a model. If the test file does not already wrap in a QueryClientProvider, add a render helper:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
// mock the api module so the usecase-default query resolves "configured"
vi.mock('../../shared/lib/api', () => ({
  apiFetch: vi.fn(async (url: string) =>
    url.includes('usecase-default') ? { provider: 'p1', model: 'bge-x' } : {},
  ),
}));
```

Adjust the existing render calls to wrap with a fresh `QueryClient` (retry:false) if not already done.

The AutoTagger mock (`:83-87`) no longer receives `model`; drop `data-model`:

```tsx
vi.mock('../../../features/pages/AutoTagger', () => ({
  AutoTagger: ({ pageId, currentLabels }: { pageId: string; currentLabels: string[] }) => (
    <div data-testid="auto-tagger" data-page-id={pageId} data-labels={currentLabels.join(',')} />
  ),
}));
```

- [ ] **Step 2: Add a regression test asserting the button renders WITHOUT legacy fields**

```tsx
it('renders the Auto-tag button in read mode without any legacy settings fields (#718 regression)', async () => {
  // settings mock has no ollamaModel/openaiModel/llmProvider; the button must still appear.
  renderRightPane(); // existing helper that renders ArticleRightPane in read mode
  expect(await screen.findByTestId('auto-tagger')).toBeInTheDocument();
});
```

- [ ] **Step 3: Run the full ArticleRightPane suite**

Run: `cd frontend && npx vitest run src/shared/components/article/ArticleRightPane.test.tsx`
Expected: PASS, including the new regression test.

- [ ] **Step 4: Lint + commit**

```bash
cd frontend && npx eslint src/shared/components/article/ArticleRightPane.tsx src/shared/components/article/ArticleRightPane.test.tsx
git add frontend/src/shared/components/article/ArticleRightPane.tsx frontend/src/shared/components/article/ArticleRightPane.test.tsx
git commit -m "fix(autotag): gate Auto-tag on new provider source, not legacy settings (#718)"
```

---

### Task 4: Full verification

- [ ] **Step 1:** `cd frontend && npx vitest run` — all frontend tests pass.
- [ ] **Step 2:** `cd frontend && npx tsc --noEmit && npx eslint src` — clean.
- [ ] **Step 3:** Confirm no remaining references: `git grep -n "activeModel" frontend/src` returns nothing.
- [ ] **Step 4:** Open a PR titled `fix(autotag): restore AI Auto-tag button (#718)` targeting `dev`; body references #718 and lists the acceptance checkboxes.

## Acceptance mapping (#718)
- Button below AI Improve in read/edit/collapsed → Task 2 gates.
- Click calls `/pages/:id/auto-tag` without legacy model → Task 1.
- No dependence on `settings.llmProvider/openaiModel/ollamaModel` → Task 2 deletion + Task 3 mock.
- Regression guard → Task 3 new test.
