# Saved Conversations on `/ai` — PR 2 (frontend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/ai` gets a per-conversation URL (`/ai/c/:id`), a conversations pane in the shell's left rail (replacing the Pages tree on AI routes), reopenable history, rename/delete, and a simplified `/ai` page — the frontend half of #1361, on top of PR 1's backend (#1365).

**Architecture:** Threads in `AiContext` are re-keyed from *page* to *location* (`draft` / `conv:<id>` / `page:<id>`) and every thread carries an **identity** so stream writers follow re-keys and drop orphans; the pane is the third arm of `AppLayout`'s sidebar ternary and copies the Pages tree's chassis (ADR-010 v0.6) with a `SidebarSessionChrome` footer; server data lives in TanStack Query (`useInfiniteQuery` over PR 1's keyset list) and `AiContext`'s `useState` mirror is deleted; the New chat control lives in the 48px header slot via `HeaderHost`; `SourceThumbnail` is viewport-gated.

**Tech Stack:** React 19, react-router (`NavLink`, `useLocation`, `useNavigate`), TanStack Query v5 (`useInfiniteQuery`, `useMutation`), Radix `DropdownMenu`, TailwindCSS 4 + the `nm-*` utilities, Zustand `ui-store`, Vitest + jsdom + `@testing-library/react`, `@compendiq/contracts` (`ConversationSummary`, `ConversationDetail`, `ConversationListResponseSchema`, `ATTACHMENT_URL_PATTERN`).

**Spec:** `docs/superpowers/specs/2026-08-17-ai-conversation-history-design.md` — sections *Direction*, *Routing and thread identity*, *The conversation pane*, *`/ai` page changes*, *Accessibility*, *Scope*, *PR 2 — frontend*, **and the `Amendment (2026-08-18, dev drift before PR 2)` block at the top, which supersedes three body sentences (Chassis footer, New chat placement, thumbnails).** Executors read both. Where the body and the amendment disagree, the amendment wins.

## Global Constraints

- Branch `feature/1361-conversations-frontend` from `dev` after #1365 (already cut in the worktree `/Users/simon/Documents/localGIT/compendiq-ce-wt-1361-design`); PR targets `dev`; squash-merge; not stacked.
- Tests required for every task (CLAUDE.md rule 1): Vitest + jsdom + `@testing-library/react`; mock at the network boundary (`fetch` / MSW), never internal components except where the existing test file already stubs a sibling (`SidebarTreeView.test.tsx:19-20` stubs `SidebarSessionChrome` — the pane's own test file does the same; `AppLayout.test.tsx` mocks `SidebarTreeView`, `ArticleRightPane`, `CommandPalette`, `ServiceStatus`, `ThemeToggle`, `use-media-query` and deliberately **not** `SettingsSidebar` — do the same for the pane so its "exactly one `/llm/conversations` request" test observes a real query).
- **Bootstrap (once per worktree, before Task 1):** this worktree may be fresh — `node_modules/` and `packages/contracts/dist/` are both gitignored, so a newly created worktree has neither and `npx vitest` / `npx tsc --noEmit` cannot resolve `@compendiq/contracts` until they exist. Run `npm install` from the repo root (workspaces share one lockfile) — or link the main checkout's `node_modules` per the documented worktree-link recipe — then `npm run build -w packages/contracts`. PR 1's `ConversationSummary` / `ConversationDetail` reach the frontend only through that build.
- Run from `frontend/`: `npx vitest run <file>`; `npx tsc --noEmit`; `npm run lint` (`eslint --max-warnings=0`). Contracts are consumed via built `dist/` — after any `packages/contracts/src` edit run `npm run build -w packages/contracts` from the repo root (see Bootstrap above — this PR edits no contracts source, but it consumes PR 1's).
- **Line numbers in `**Files:**` blocks are navigational hints** against the branch base and may drift by a few lines; the authoritative anchor is always the verbatim `old` code block. If an `old` block does not match the file byte-for-byte, STOP and re-read the surrounding task and the file — never fuzzy-apply an edit.
- Guard suites that must stay green at the end of every task that touches their subject and at the end of the plan: `src/ui-text-legibility.test.ts` (12px uppercase floor, 11px body floor), `src/flat-components.test.ts`, `src/destructive-treatment.test.ts` (ratchet ≤ 21 hand-rolled destructive callsites — use `nm-action-destructive`, never `text-destructive` + `hover:bg-destructive/NN`), `src/focus-ring-contrast.test.ts`, `src/workspace-themes.test.ts`, `src/ai-scroll-chain.test.ts`, `src/toolbar-rule-alignment.test.ts`, `src/docs-image-retrieval-record.test.ts` (**no CLAUDE.md paragraph this PR adds may contain the string `#1115`** unless it opens with a declared prefix), `src/scroll-padding-mask.test.ts`.
- ADR-010 v0.6: flat surfaces, one shadow (`nm-card-elevated` for the kebab menu only), teal only on actions, the neutral pressed recipe (`nav-selection font-medium`) for the active row, amber only for degraded (`role="status"` failed-with-cache strip), red only for failure (`role="alert"` block), no per-row icon, `SECTION_LABEL` (12px uppercase `tracking-[0.08em]`) for group headings.
- Copy is exact where the spec quotes it: *Loading conversation…*, *Conversation not found*, *This conversation no longer exists — your next question starts a new one.*, *Older messages in this conversation are no longer sent to the model.*, *Your conversations will appear here. Only Q&A is saved.*, *No matching conversations*, *Couldn't load conversations*, *The request did not complete.*, *Showing the last loaded conversations*, *Delete conversation?*, *"<title>" will be permanently deleted. This can't be undone.*, *This page is no longer available to you*, "New chat", "Filter conversations", "Show more", "Loading…", "Try again", "Retry", "Rename", "Delete", `Actions for ${title}`, `Rename ${title}`, "Expand sidebar (,)", "Collapse sidebar (,)".
- Test ids and labels: `data-testid="ai-conversations-sidebar"` on **both** branches of the pane; `data-testid="conversations-new-chat"` (pane), `data-testid="ai-new-chat"` (header slot), `data-testid="conversations-show-more"`, `data-testid="sidebar-session-chrome"` (from the shared component); `<aside aria-label="Conversations">` both branches; `<nav aria-label="Conversation history">`; `aria-current="page"` on the active row; `data-row-id` on the row link.
- Constants: `MAX_RETAINED_THREADS = 12` (unchanged); `CONVERSATION_FILTER_THRESHOLD = 8`; query key `['llm', 'conversations', 'list']` for the list, invalidate `['llm', 'conversations']`; `AI_HOME_PATH = '/ai'`; `AI_HOME_ACTIONS = ['ask', 'generate']`; the recency labels *Today* / *Yesterday* / *Previous 7 days* / *Previous 30 days* / `Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' })`.
- Commit after every task with a message in the repo's style (`feat(ai): …`, `refactor(ui): …`, `test(ai): …`, `docs(…): …`), and end every commit message with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Stage by name — never `git add -A`.
- Never touch the main checkout `/Users/simon/Documents/localGIT/compendiq-ce`; work only in the worktree.

---

## File structure

**Create**

| File | Responsibility |
|---|---|
| `frontend/src/shared/lib/ai-routes.ts` (+ `.test.ts`) | The AI-route predicates: `AI_HOME_PATH`, `isAiRoute`, `conversationIdFromPath`, `conversationPath`. Shell plumbing (`AppLayout` and `AiContext` both need it; `shared/lib/article-route.ts` is the precedent). |
| `frontend/src/features/ai/assistant-actions.ts` (+ `.test.ts`) | Leaf module: `AssistantAction`, `AI_HOME_ACTIONS`, `DOCK_ACTIONS`, `isAiHomeAction`. Lives apart from `AssistantActionSelect.tsx` so `AiContext` can import it without a cycle. |
| `frontend/src/features/ai/conversations/group-by-recency.ts` (+ `.test.ts`) | Pure `groupByRecency(items, now)`. |
| `frontend/src/shared/hooks/use-list-roving-focus.ts` (+ `.test.ts`) | Flat vertical roving tabindex, `useTreeRovingFocus`'s contract shape. |
| `frontend/src/features/ai/conversations/use-conversation-list.ts` (+ `.test.tsx`) | `useConversationList()` — `useInfiniteQuery` over `GET /llm/conversations`, flattened `rows`. |
| `frontend/src/features/ai/conversations/use-conversation-mutations.ts` (+ `.test.tsx`) | `useRenameConversation()`, `useDeleteConversation()`. |
| `frontend/src/features/ai/conversations/ConversationRowMenu.tsx` | Kebab trigger + `DropdownMenu` (Rename / Delete) + delete `ConfirmDialog`. |
| `frontend/src/features/ai/conversations/ConversationRow.tsx` (+ `.test.tsx`, covering the menu too) | One `<li>`: `NavLink`, page chip, kebab, inline rename. |
| `frontend/src/features/ai/conversations/ConversationList.tsx` (+ `.test.tsx`) | `<nav>` → recency groups → rows; roving focus; three list states; Show more. |
| `frontend/src/features/ai/conversations/AiConversationsSidebar.tsx` (+ `.test.tsx`) | Chassis: `<aside>` both branches, resize handle, nav row, New chat, filter, list, footer, collapsed rail. |
| `docs/superpowers/plans/2026-08-18-ai-conversation-history-pr2-frontend.md` | This plan. |

**Modify**

| File | What changes |
|---|---|
| `frontend/src/App.tsx` (`:214`) | `<Route path="/ai/c/:conversationId" element={<AiAssistantPage />} />` beside `/ai`. |
| `frontend/src/shared/components/layout/PageTransition.tsx` (`:15`) | `routeDepth` uses `isAiRoute`. |
| `frontend/src/features/ai/AiContext.tsx` | Thread keys by location; `AiThread` identity/loadState/loadError/historyTruncated; `seedFor`, `nextIdentity`; `activeThreadId`, `streamingThreadId`; identity-bound writers; promotion / 404 / null-frame / mirror; hydration; `startNewConversation` / `purgeConversation` / `retryThreadLoad` / `composerFocusRequest`; mirror deleted; `resolveAiPageId` null on AI routes; URL-mode allow-list on AI routes; `conversations`/`setConversations`/`loadConversation`/`deleteConversation` removed. |
| `frontend/src/features/ai/AiContext.threads.test.tsx` | Every state-machine cell; delete `:196-209` (the `/ai?pageId=x ↔ /pages/x` shared-thread contract) and the `context-page` assertion at `:344`. |
| `frontend/src/features/ai/AiAssistantPage.tsx` (+ `.test.tsx`) | `HeaderHost` (title + New chat) first inside the root `<m.div>`; delete model select, context chip, `+ Sub-pages`, divider, `flex-1` spacer; loading/error states for `conv:` threads; `MessageBubble` gates streaming on `streamingThreadId`; `AssistantActionSelect actions={AI_HOME_ACTIONS}`. |
| `frontend/src/features/ai/AssistantActionSelect.tsx` | `actions: readonly AssistantAction[]` replaces `includeGenerate`. |
| `frontend/src/features/ai/modes/AskMode.tsx` (+ `.test.tsx`) | `DeepSearchToggle` reset keyed on `activeThreadId`; `externalUrls` reset on `activeThreadId`; history note; composer focus on `composerFocusRequest`; Send disabled while loading. |
| `frontend/src/features/ai/AssistantAttachments.tsx` | Scope clears on `activeThreadId`, not `pageId`. |
| `frontend/src/features/ai/DockPanel.tsx` (+ tests) / `DockMessage` | History note; typing indicator gated on `streamingThreadId`. |
| `frontend/src/features/ai/source-target.ts` (+ `.test.ts`), `SourceCitations.tsx` (`Source` gains `unavailable?: true`), `CitationChips.tsx` | `unavailable` → `{ kind: 'none' }` + `title="This page is no longer available to you"`; card thumbnail gated on `target.kind !== 'none'`. |
| `frontend/src/features/ai/SourceThumbnail.tsx` (+ `CitationChips.test.tsx`, `SourceCitations.test.tsx`) | Viewport gate (`IntersectionObserver` sentinel, `useAuthenticatedSrc(null)` until intersected). |
| `frontend/src/shared/components/layout/AppLayout.tsx` (+ `.test.tsx`) | Third arm of the sidebar ternary in the drawer (`:500-502`) and the desktop slot (`:519-528`), gated on `isAiRoute(location.pathname)`. |
| `frontend/src/shared/components/layout/SidebarTreeView.tsx` (+ `.test.tsx`) | `isAiRoute` prop and every branch keyed on it deleted; `SECTION_LABEL` exported. |
| `frontend/src/shared/components/layout/DndLocalSpaceTree.tsx` (+ `.test.tsx`) | `isAiRoute` prop and branches deleted. |
| `frontend/src/index.css` (`:925-943`) | `nm-action-destructive` gains `&[data-highlighted]` mirroring `&:hover:not(:disabled)`. |
| `frontend/src/toolbar-rule-alignment.test.ts` | `SELF_BORDERED` gains the pane. |
| `frontend/src/shared/components/layout/MainNavStrip.tsx` (`:6-15`) | Comment: `/ai` and `/ai/c/:id` both light the AI pill (code unchanged). |
| Docs | `docs/architecture/04-frontend-structure.md`, `docs/architecture/09-flow-rag-chat.md`, `docs/architecture/README.md`, `docs/superpowers/specs/2026-07-28-docked-ai-assistant-design.md`, `docs/superpowers/specs/2026-08-17-ai-conversation-history-design.md`, `docs/USER-GUIDE.md`, `CLAUDE.md`. |

**Delete (tests only)** — `AiAssistantPage.test.tsx` "no conversations sidebar" pin (`:433-437`) and the context-chip test (`:394-415`) and #355 AC-4's model-reset test (`:2230-2296`); `AiContext.threads.test.tsx:196-209`; every `isAiRoute` occurrence in `SidebarTreeView.test.tsx` (26, incl. both `#417` tests at `:368`/`:374` and the `#960` comparator test); `modes/AskMode.test.tsx:783-791` `ConversationSwitcher` stub.

---

## Task map and shared interfaces

Tasks are ordered so the branch is green and the app usable after each. Parts: **A** routing + thread identity (Tasks 1–6), **B** the pane (7–13), **C** tree removal + `/ai` simplification (14–17), **D** docs + final verification (18).

Interfaces every task must use verbatim (defined by the task named, consumed by the rest):

```ts
// Task 1 — frontend/src/shared/lib/ai-routes.ts
export const AI_HOME_PATH = '/ai';
export function isAiRoute(pathname: string): boolean;              // '/ai' and '/ai/c/<id>' only
export function conversationIdFromPath(pathname: string): string | null;
export function conversationPath(id: string): string;              // `/ai/c/${encodeURIComponent(id)}`

// Task 2 — AiContext.tsx (module-private unless stated)
type ThreadKey = 'draft' | `conv:${string}` | `page:${string}`;
function threadKeyFor(pathname: string): ThreadKey;               // replaces threadKeyFor(pageId)
interface AiThread { …existing…; identity: number; loadState: 'ready' | 'loading' | 'error'; loadError: string | null; historyTruncated: boolean }
const EMPTY_THREAD: AiThread;                                     // identity: 0, never observed
function nextIdentity(): number;                                  // module counter, starts at 1
function seedFor(key: string): AiThread;                          // { ...EMPTY_THREAD, loadState: key.startsWith('conv:') ? 'loading' : 'ready' } — identity stamped by the FILER
// AiContextValue additions (Task 2 unless noted):
activeThreadId: string;                                           // String(threads.get(threadKey)?.identity ?? threadKey)
streamingThreadId: string | null;                                 // Task 3
threadLoadState: 'ready' | 'loading' | 'error';                   // Task 5
threadLoadError: string | null;                                   // Task 5
retryThreadLoad: () => void;                                      // Task 5
historyTruncated: boolean;                                        // Task 5
startNewConversation: () => void;                                 // Task 2 (new semantics)
purgeConversation: (id: string) => void;                          // Task 4
composerFocusRequest: number;                                     // Task 2
// AiContextValue removals (Task 2): conversations, setConversations, loadConversation, deleteConversation
// StreamChunk.conversationId: string | null (Task 4)

// Task 7 — group-by-recency.ts
export interface RecencyGroup<T> { label: string; items: T[] }
export function groupByRecency<T extends { updatedAt: string }>(items: readonly T[], now: Date): RecencyGroup<T>[];

// Task 8 — shared/hooks/use-list-roving-focus.ts
export function useListRovingFocus(opts: { ids: readonly string[]; activeId: string | null; containerRef: React.RefObject<HTMLElement | null>; itemAttr: string })
  : { rovingId: string | undefined; handleRowFocus: (id: string) => void; handleRowKeyDown: (event: React.KeyboardEvent, id: string) => void };

// Task 9 — use-conversation-list.ts / use-conversation-mutations.ts
export const CONVERSATIONS_LIST_KEY = ['llm', 'conversations', 'list'] as const;
export function useConversationList(): { query: UseInfiniteQueryResult<InfiniteData<ConversationListResponse>, ApiError>; rows: ConversationSummary[] };
export function useRenameConversation(): UseMutationResult<ConversationSummary, ApiError, { id: string; title: string }>;
export function useDeleteConversation(): UseMutationResult<void, ApiError, { id: string; title: string }>;   // onSuccess: purgeConversation(id), invalidate ['llm','conversations'], toast.success

// Task 10 — ConversationRow.tsx / ConversationRowMenu.tsx
export interface ConversationRowProps { conversation: ConversationSummary; tabIndex: 0 | -1; onRowFocus: (id: string) => void; onRowKeyDown: (event: React.KeyboardEvent, id: string) => void; onNavigate?: () => void }
export function ConversationRow(props: ConversationRowProps): JSX.Element;         // renders the <li>
interface ConversationRowMenuProps { conversation: ConversationSummary; open: boolean; onOpenChange: (open: boolean) => void; onRename: () => void; triggerRef: React.RefObject<HTMLButtonElement | null>; visible: boolean }
export function ConversationRowMenu(props: ConversationRowMenuProps): JSX.Element; // kebab + menu + confirm

// Task 11 — ConversationList.tsx
export interface ConversationListProps { list: ReturnType<typeof useConversationList>; filter: string; onNavigate?: () => void }
export function ConversationList(props: ConversationListProps): JSX.Element;

// Task 12 — AiConversationsSidebar.tsx
export const CONVERSATION_FILTER_THRESHOLD = 8;
export function AiConversationsSidebar(props: { onNavigate?: () => void }): JSX.Element;
// SidebarTreeView.tsx: `export const SECTION_LABEL` (was module-private at :149)

// Task 15 — assistant-actions.ts / AssistantActionSelect.tsx
export type AssistantAction = 'ask' | ImprovementType | 'diagram' | 'generate';    // moved here from AssistantActionSelect.tsx (re-exported there for existing importers)
export const AI_HOME_ACTIONS: readonly AssistantAction[] = ['ask', 'generate'];
export const DOCK_ACTIONS: readonly AssistantAction[] = ['ask', ...IMPROVEMENT_TYPES, 'diagram'];
export function isAiHomeAction(value: string): value is 'ask' | 'generate';
// AssistantActionSelect props: { actions: readonly AssistantAction[]; … } — `includeGenerate` removed

// Task 16 — SourceCitations.tsx / source-target.ts
// Source gains `unavailable?: true`; resolveSourceTarget(source) returns { kind: 'none' } when source.unavailable === true, before every other rule.
```

---

## Part A — Routing and thread identity (Tasks 1–6)

### Task 1: AI route predicates and the `/ai/c/:conversationId` route

Implements spec §*Routing and thread identity* → *Routes and predicates*
(`docs/superpowers/specs/2026-08-17-ai-conversation-history-design.md`, the
"Routes and predicates" bullets), plus amendment item 8's citation of
`shared/lib/article-route.ts` as the module shape to copy.

**Files:**
- Create: `frontend/src/shared/lib/ai-routes.ts`
- Test: `frontend/src/shared/lib/ai-routes.test.ts`
- Modify: `frontend/src/App.tsx:214`
- Test: `frontend/src/App.test.tsx` (new `describe` at the end of the file)
- Modify: `frontend/src/shared/components/layout/PageTransition.tsx:1-22`
- Test: `frontend/src/shared/components/layout/PageTransition.test.tsx:12-40`
- Modify: `frontend/src/features/ai/AiContext.tsx:343-353` (`resolveAiPageId`), `:532-533` (the `?q=` route guard)
- Test: `frontend/src/features/ai/AiContext.threads.test.tsx` (harness route, the `?q=` group, the `resolveAiPageId` group, and the `/ai?pageId=` thread cases retargeted onto `/pages/:id`)
- Modify (test fallout only): `frontend/src/features/ai/AiAssistantPage.test.tsx`, `frontend/src/features/ai/modes/DiagramMode.test.tsx`, `frontend/src/features/ai/modes/ImproveMode.test.tsx`, `frontend/src/features/ai/modes/ImproveMode.attachments.test.tsx`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `AI_HOME_PATH`, `isAiRoute(pathname)`, `conversationIdFromPath(pathname)`, `conversationPath(id)` from `frontend/src/shared/lib/ai-routes.ts` — Tasks 2, 4, 5, 11, 12, 13 all import from here. `resolveAiPageId(pathname, searchParams)` keeps its signature and now answers `null` on every AI route.

**Pinned here (decisions the spec leaves open):**
- **`/ai/` (trailing slash) is NOT an AI route.** react-router normalises the
  trailing slash away before anything reads `location.pathname`, so the only
  way to observe `'/ai/'` is a hand-built string; accepting it would invent a
  second spelling of `/ai` that no navigation can produce and that
  `conversationIdFromPath` would then have to answer for.
- **`/ai/c/` (empty id) is NOT an AI route.** The regex segment is `[^/]+`, so
  an empty id falls through to `App.tsx`'s `*` route and gets the real 404 —
  the honest answer for "open the conversation named nothing".
- **`conversationIdFromPath` decodes**, because `conversationPath` encodes, and
  a malformed escape (`%zz`) returns the raw segment rather than throwing out
  of the provider that reads the location on every render.
- **The route-registration test is a source guard**, not a full-app render:
  `App.test.tsx` mounts the real lazy tree behind `Suspense`, so a behavioural
  assertion for `/ai/c/:id` would have to wait out `AiAssistantPage`'s whole
  query fan-out to be non-vacuous. The repo already tests structure this way
  (`PageTransition.test.tsx:86-108`, `ai-scroll-chain.test.ts`), and the
  behavioural coverage of `/ai/c/:id` arrives in Task 2 (thread keys) and
  Task 5 (hydration), which drive their own `MemoryRouter` routes.

- [ ] **Step 1: Write the failing test for the route module**

Create `frontend/src/shared/lib/ai-routes.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  AI_HOME_PATH,
  isAiRoute,
  conversationIdFromPath,
  conversationPath,
} from './ai-routes';

describe('AI route predicates (#1361)', () => {
  it('names the bare assistant route', () => {
    expect(AI_HOME_PATH).toBe('/ai');
  });

  describe('isAiRoute', () => {
    it('is true for the bare route and for one conversation', () => {
      expect(isAiRoute('/ai')).toBe(true);
      expect(isAiRoute('/ai/c/conv-1')).toBe(true);
      expect(isAiRoute('/ai/c/018f2d3c-9a1b-7c4e-8f00-2b6a1f0e5d33')).toBe(true);
    });

    it('is false for a trailing slash', () => {
      // react-router normalises `/ai/` to `/ai` before anything reads
      // location.pathname, so accepting it would only invent a second spelling
      // of the same route for hand-built strings.
      expect(isAiRoute('/ai/')).toBe(false);
    });

    it('is false for an empty conversation id', () => {
      // There is no conversation to open; App.tsx's `*` route and its real 404
      // are the honest answer.
      expect(isAiRoute('/ai/c/')).toBe(false);
      expect(isAiRoute('/ai/c')).toBe(false);
    });

    it('is false for anything deeper, adjacent, or differently cased', () => {
      expect(isAiRoute('/ai/c/conv-1/edit')).toBe(false);
      expect(isAiRoute('/ai-reviews')).toBe(false);
      expect(isAiRoute('/AI')).toBe(false);
      expect(isAiRoute('/pages/abc')).toBe(false);
      expect(isAiRoute('/')).toBe(false);
      expect(isAiRoute('')).toBe(false);
    });
  });

  describe('conversationIdFromPath', () => {
    it('reads the id off /ai/c/:id', () => {
      expect(conversationIdFromPath('/ai/c/conv-1')).toBe('conv-1');
    });

    it('is null on the bare route and off the family', () => {
      expect(conversationIdFromPath('/ai')).toBeNull();
      expect(conversationIdFromPath('/ai/c/')).toBeNull();
      expect(conversationIdFromPath('/pages/abc')).toBeNull();
    });

    it('decodes the segment, so it round-trips with conversationPath', () => {
      const id = 'a/b c#1';
      expect(conversationIdFromPath(conversationPath(id))).toBe(id);
    });

    it('returns the raw segment when the escape is malformed', () => {
      // decodeURIComponent throws on '%zz'. The provider reads this on every
      // render, so a hand-typed URL must yield a lookup that 404s rather than
      // an exception out of AiProvider.
      expect(conversationIdFromPath('/ai/c/%zz')).toBe('%zz');
    });
  });

  describe('conversationPath', () => {
    it('builds the per-conversation URL', () => {
      expect(conversationPath('conv-1')).toBe('/ai/c/conv-1');
    });

    it('percent-encodes the id', () => {
      expect(conversationPath('a/b')).toBe('/ai/c/a%2Fb');
      expect(conversationPath('a b')).toBe('/ai/c/a%20b');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/shared/lib/ai-routes.test.ts`
Expected: FAIL with `Failed to resolve import "./ai-routes"` — the module does not exist yet.

- [ ] **Step 3: Write the route module**

Create `frontend/src/shared/lib/ai-routes.ts`:

```ts
/**
 * The `/ai` route family (#1361).
 *
 * `AiProvider` sits ABOVE `<Routes>` (`AppLayout.tsx`), so it cannot use
 * `useParams`: it reads the conversation id out of `location.pathname`, exactly
 * as `resolveAiPageId` reads the article id. `AppLayout` lives in `shared/` and
 * `AiContext` in `features/`, and both need these predicates, so they belong in
 * `shared/lib` beside `article-route.ts` — the same shape of module, extracted
 * for the same reason.
 */

/** The bare assistant route: a new, unsaved chat. */
export const AI_HOME_PATH = '/ai';

/**
 * `/ai` and `/ai/c/<id>`, and nothing else.
 *
 * A trailing slash is deliberately not matched: react-router normalises `/ai/`
 * to `/ai` before anything reads `location.pathname`, so accepting it would
 * only add a second spelling of the same route for hand-built strings. Neither
 * is an empty id (`/ai/c/`) — the segment is `[^/]+`, so it falls through to
 * `App.tsx`'s `*` route and gets the real 404.
 */
const AI_ROUTE = /^\/ai(?:\/c\/([^/]+))?$/;

export function isAiRoute(pathname: string): boolean {
  return AI_ROUTE.test(pathname);
}

/**
 * The conversation id on `/ai/c/:id`; `null` on `/ai` and off the family.
 *
 * The segment is decoded because `conversationPath` encodes it. A malformed
 * escape makes `decodeURIComponent` throw, and this runs on every render of the
 * provider, so the raw segment is returned instead: a hand-typed URL yields a
 * lookup that 404s rather than an exception out of `AiProvider`.
 */
export function conversationIdFromPath(pathname: string): string | null {
  const raw = AI_ROUTE.exec(pathname)?.[1];
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** The URL of one conversation. */
export function conversationPath(id: string): string {
  return `/ai/c/${encodeURIComponent(id)}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/shared/lib/ai-routes.test.ts`
Expected: PASS (14 assertions across 4 groups).

- [ ] **Step 5: Write the failing test for the route registration**

Append to `frontend/src/App.test.tsx` (after the final `});` of the last
`describe`):

```tsx
describe('App routes — the AI family (#1361)', () => {
  // A source guard rather than a render: this file mounts the real lazy tree
  // behind Suspense, so a behavioural assertion for /ai/c/:id would have to
  // wait out AiAssistantPage's whole query fan-out to be non-vacuous — and
  // would pass on the fallback either way. The route's BEHAVIOUR is covered
  // where the provider reads it (AiContext.threads.test.tsx) and where the
  // conversation is fetched (the hydration tests). What this pins is that the
  // path exists at all, i.e. that a pasted /ai/c/<id> is not a 404.
  // Precedent: PageTransition.test.tsx:86-108, src/ai-scroll-chain.test.ts.
  it('registers /ai/c/:conversationId beside /ai, on the same component', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const url = await import('node:url');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const src = await fs.readFile(path.join(here, 'App.tsx'), 'utf-8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    expect(code).toMatch(/path="\/ai"\s+element=\{<AiAssistantPage \/>\}/);
    expect(code).toMatch(
      /path="\/ai\/c\/:conversationId"[\s\S]{0,80}element=\{<AiAssistantPage \/>\}/,
    );
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/App.test.tsx -t "registers /ai/c"`
Expected: FAIL — `expected '…' to match /path="\/ai\/c\/:conversationId"…/`; the route is not registered.

- [ ] **Step 7: Register the route**

`frontend/src/App.tsx:214` — old:

```tsx
                            <Route path="/ai" element={<AiAssistantPage />} />
```

new:

```tsx
                            <Route path="/ai" element={<AiAssistantPage />} />
                            {/* #1361: one conversation, one URL. The same lazy
                                component — the provider derives which thread is
                                on screen from location.pathname, so Back and
                                Forward walk conversations for free. */}
                            <Route
                              path="/ai/c/:conversationId"
                              element={<AiAssistantPage />}
                            />
```

- [ ] **Step 8: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/App.test.tsx`
Expected: PASS (the whole file, including the pre-existing ProtectedRoute cases).

- [ ] **Step 9: Write the failing test for `PageTransition.routeDepth`**

In `frontend/src/shared/components/layout/PageTransition.test.tsx`, inside
`describe('routeDepth', …)`, replace:

```tsx
  it('returns 0 for /ai', () => {
    expect(routeDepth('/ai')).toBe(0);
  });
```

with:

```tsx
  it('returns 0 for /ai', () => {
    expect(routeDepth('/ai')).toBe(0);
  });

  it('returns 0 for a conversation URL', () => {
    // Documents intent; it is `routeDepth`'s catch-all that makes it pass
    // today. The assertion that fails before the change is the source guard
    // below — one predicate, not a second copy of the route test.
    expect(routeDepth('/ai/c/conv-1')).toBe(0);
  });

  it('is defined by the shared AI-route predicate, not a second copy of it', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const url = await import('node:url');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const src = await fs.readFile(path.join(here, 'PageTransition.tsx'), 'utf-8');
    // Strip comments so the explanatory block above routeDepth (which names
    // the routes) cannot satisfy or trip either matcher.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).toMatch(/isAiRoute\(pathname\)/);
    expect(code).not.toMatch(/pathname === '\/ai'/);
  });
```

- [ ] **Step 10: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/shared/components/layout/PageTransition.test.tsx`
Expected: FAIL with `expected '…' to match /isAiRoute\(pathname\)/` — `routeDepth` still compares `pathname === '/ai'` itself.

- [ ] **Step 11: Point `routeDepth` at the predicate**

`frontend/src/shared/components/layout/PageTransition.tsx:1-22` — old:

```tsx
import type { ReactNode } from 'react';

/**
 * Route-depth ordering preserved for tests + any future use. Not currently
 * consumed by this component because the AnimatePresence-based slide+fade
 * was removed (see below).
 *
 *   /          -> 0  (Pages list)
 *   /pages/new -> 1  (New page)
 *   /pages/:id -> 1  (Page view)
 *   /ai        -> 0  (AI assistant)
 *   /settings  -> 0  (Settings)
 */
function routeDepth(pathname: string): number {
  if (pathname === '/' || pathname === '/ai' || pathname === '/settings' || pathname === '/login') {
    return 0;
  }
```

new:

```tsx
import type { ReactNode } from 'react';
import { isAiRoute } from '../../lib/ai-routes';

/**
 * Route-depth ordering preserved for tests + any future use. Not currently
 * consumed by this component because the AnimatePresence-based slide+fade
 * was removed (see below).
 *
 *   /            -> 0  (Pages list)
 *   /pages/new   -> 1  (New page)
 *   /pages/:id   -> 1  (Page view)
 *   /ai          -> 0  (AI assistant)
 *   /ai/c/:id    -> 0  (one saved conversation — same surface, #1361)
 *   /settings    -> 0  (Settings)
 */
function routeDepth(pathname: string): number {
  if (pathname === '/' || isAiRoute(pathname) || pathname === '/settings' || pathname === '/login') {
    return 0;
  }
```

- [ ] **Step 12: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/shared/components/layout/PageTransition.test.tsx`
Expected: PASS — including the pre-existing "no AnimatePresence / motion machinery" source guard, which the new import does not trip.

- [ ] **Step 13: Write the failing tests for `resolveAiPageId` on AI routes**

In `frontend/src/features/ai/AiContext.threads.test.tsx`, inside
`describe('resolveAiPageId', …)`, insert after the "prefers an explicit
?pageId= over the route" case:

```tsx
  it('resolves to no document on an AI route, even with ?pageId=', () => {
    // #1361: `/ai` and `/ai/c/:id` are conversation routes, not document ones.
    // A legacy `/ai?pageId=…` bookmark therefore opens a plain new chat rather
    // than a page-scoped one — the three producers of that URL go in Task 14.
    expect(resolveAiPageId('/ai', new URLSearchParams('pageId=explicit'))).toBeNull();
    expect(resolveAiPageId('/ai', new URLSearchParams())).toBeNull();
    expect(resolveAiPageId('/ai/c/conv-1', new URLSearchParams('pageId=explicit'))).toBeNull();
  });
```

and, in the `describe('?q= composer prefill is scoped to /ai', …)` group,
insert after the "consumes ?q= on /ai" case:

```tsx
    it('consumes ?q= on a conversation URL too', () => {
      // The guard is the route FAMILY, not the literal '/ai': CommandPalette's
      // two producers both land on bare /ai, but the prefill has to survive a
      // user pasting ?q= onto the conversation they already have open.
      renderThreadApp('/ai/c/conv-1?q=how do I rotate the PAT');

      expect(screen.getByTestId('draft')).toHaveTextContent('how do I rotate the PAT');
      expect(screen.getByTestId('location')).toHaveTextContent('/ai/c/conv-1');
      expect(screen.getByTestId('location').textContent).not.toContain('q=');
    });
```

The harness needs the new route for that second case. In `renderThreadApp`,
old:

```tsx
          <Routes>
            <Route path="/" element={<div>pages list</div>} />
            <Route path="/ai" element={<ThreadProbe />} />
            <Route path="/pages/:id" element={<ThreadProbe />} />
          </Routes>
```

new:

```tsx
          <Routes>
            <Route path="/" element={<div>pages list</div>} />
            <Route path="/ai" element={<ThreadProbe />} />
            <Route path="/ai/c/:conversationId" element={<ThreadProbe />} />
            <Route path="/pages/:id" element={<ThreadProbe />} />
          </Routes>
```

- [ ] **Step 14: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/features/ai/AiContext.threads.test.tsx`
Expected: FAIL twice — `resolveAiPageId('/ai', pageId=explicit)` returns `'explicit'` instead of `null`, and the `/ai/c/conv-1?q=` case leaves the draft empty (today's guard is `location.pathname === '/ai'`, so it never claims the param).

- [ ] **Step 15: Make AI routes document-free and widen the `?q=` guard**

`frontend/src/features/ai/AiContext.tsx` — add the import beside the existing
`shared/lib` imports (after line 7, `import { streamSSE } from '../../shared/lib/sse';`):

```tsx
import { isAiRoute } from '../../shared/lib/ai-routes';
```

`frontend/src/features/ai/AiContext.tsx:343-353` — old:

```tsx
/**
 * Resolve which page the assistant is talking about. `?pageId=` is one *input*
 * to this, not the definition of it: on an article route the open document is
 * the context, which is what lets a thread follow the page being read. An
 * explicit `?pageId=` still wins, so `/ai?pageId=…` keeps working unchanged.
 */
export function resolveAiPageId(pathname: string, searchParams: URLSearchParams): string | null {
  const explicit = searchParams.get('pageId');
  if (explicit) return explicit;
  const routeId = ARTICLE_ROUTE.exec(pathname)?.[1];
  // /pages/new is the create route, not a document.
  return routeId && routeId !== 'new' ? routeId : null;
}
```

new:

```tsx
/**
 * Resolve which page the assistant is talking about — the dock's context, and
 * nothing else since #1361.
 *
 * An AI route has no document. `/ai` and `/ai/c/:id` are conversation routes:
 * the left rail there lists conversations, not pages, so nothing can set a page
 * context and nothing would clear one. A legacy `/ai?pageId=…` bookmark
 * therefore opens a plain new chat rather than silently scoping answers to a
 * page the UI does not mention — which is the state the context chip existed to
 * paper over. Off the AI routes an explicit `?pageId=` still wins over the
 * article route, which is what lets a thread follow the page being read.
 */
export function resolveAiPageId(pathname: string, searchParams: URLSearchParams): string | null {
  if (isAiRoute(pathname)) return null;
  const explicit = searchParams.get('pageId');
  if (explicit) return explicit;
  const routeId = ARTICLE_ROUTE.exec(pathname)?.[1];
  // /pages/new is the create route, not a document.
  return routeId && routeId !== 'new' ? routeId : null;
}
```

`frontend/src/features/ai/AiContext.tsx:528-533` — old:

```tsx
  // Scoped to /ai, which is the only route CommandPalette ever puts ?q= on
  // (CommandPalette.tsx:134). The provider mounts app-wide now, so without the
  // guard it would claim `q` from ANY route carrying it — silently rewriting
  // that page's URL and stuffing its search term into the AI composer.
  const isAiRoute = location.pathname === '/ai';
  const urlQuestion = isAiRoute ? searchParams.get('q') : null;
```

new:

```tsx
  // Scoped to the AI route FAMILY. CommandPalette's two producers both land on
  // bare /ai (its AI mode and #1364's no-results recovery item), but the guard
  // is about which routes may have their `q` claimed, and `/ai/c/:id` is the
  // same surface. The provider mounts app-wide, so without it the prefill would
  // claim `q` from ANY route carrying it — silently rewriting that page's URL
  // and stuffing its search term into the AI composer.
  //
  // The local is `onAiRoute` because `isAiRoute` is now the imported predicate.
  const onAiRoute = isAiRoute(location.pathname);
  const urlQuestion = onAiRoute ? searchParams.get('q') : null;
```

- [ ] **Step 16: Run test to verify the two new cases pass**

Run: `cd frontend && npx vitest run src/features/ai/AiContext.threads.test.tsx`
Expected: the two new cases PASS; six pre-existing cases now FAIL, which is Step 17's subject —
`swaps threads on a page change instead of destroying them`,
`gives the no-document case a thread a real page cannot collide with`,
`shares one thread between /ai?pageId=x and the article route for x`,
`clears only the active thread on a deliberate new conversation`,
`evicts the least recently used thread once the retention cap is exceeded`,
`commits an aborted stream to the thread that started it, not the one navigated to`,
plus the last assertion of `clears an active mode when a navigation carries none…`.
All seven are `/ai?pageId=` cases: with no document on an AI route they now
address one and the same thread.

- [ ] **Step 17: Retarget the per-page thread cases onto the route that still has a document**

Every one of these is about the DOCK's per-page threads (#1126), and the dock
lives on `/pages/:id`. The harness already routes it.

`frontend/src/features/ai/AiContext.threads.test.tsx:149-175` — old:

```tsx
  it('swaps threads on a page change instead of destroying them', () => {
    // The sidebar navigates exactly like this while on /ai — the click that
    // used to silently discard an in-progress conversation.
    renderThreadApp('/ai?pageId=page-a', ['/ai?pageId=page-a', '/ai?pageId=page-b']);

    fireEvent.click(screen.getByText('add message'));
    expect(threadContents()).toEqual(['question about page-a']);

    // A -> B: B starts empty and must not show A's messages.
    goTo('/ai?pageId=page-b');
    expect(screen.getByTestId('context-page')).toHaveTextContent('page-b');
    expect(threadContents()).toEqual([]);
    expect(screen.getByTestId('conversation-id')).toHaveTextContent('none');

    fireEvent.click(screen.getByText('add message'));
    expect(threadContents()).toEqual(['question about page-b']);

    // B -> A: A's thread comes back intact, and is still distinct from B's.
    goTo('/ai?pageId=page-a');
    expect(threadContents()).toEqual(['question about page-a']);
    expect(screen.getByTestId('conversation-id')).toHaveTextContent('conv-page-a');
    expect(screen.getByTestId('draft')).toHaveTextContent('draft for page-a');

    goTo('/ai?pageId=page-b');
    expect(threadContents()).toEqual(['question about page-b']);
    expect(screen.getByTestId('conversation-id')).toHaveTextContent('conv-page-b');
  });
```

new:

```tsx
  it('swaps threads on a page change instead of destroying them', () => {
    // The dock's contract (#1126): walking the page tree with the assistant
    // open swaps which thread is on screen and destroys none of them. Since
    // #1361 a page context comes only from the article route — `/ai?pageId=`
    // resolves to no document — so this is now written where the dock lives.
    renderThreadApp('/pages/page-a', ['/pages/page-a', '/pages/page-b']);

    fireEvent.click(screen.getByText('add message'));
    expect(threadContents()).toEqual(['question about page-a']);

    // A -> B: B starts empty and must not show A's messages.
    goTo('/pages/page-b');
    expect(screen.getByTestId('context-page')).toHaveTextContent('page-b');
    expect(threadContents()).toEqual([]);
    expect(screen.getByTestId('conversation-id')).toHaveTextContent('none');

    fireEvent.click(screen.getByText('add message'));
    expect(threadContents()).toEqual(['question about page-b']);

    // B -> A: A's thread comes back intact, and is still distinct from B's.
    goTo('/pages/page-a');
    expect(threadContents()).toEqual(['question about page-a']);
    expect(screen.getByTestId('conversation-id')).toHaveTextContent('conv-page-a');
    expect(screen.getByTestId('draft')).toHaveTextContent('draft for page-a');

    goTo('/pages/page-b');
    expect(threadContents()).toEqual(['question about page-b']);
    expect(screen.getByTestId('conversation-id')).toHaveTextContent('conv-page-b');
  });
```

`:177-194` — old:

```tsx
  it('gives the no-document case a thread a real page cannot collide with', () => {
    // A page whose id is literally the no-document key is the adversarial case
    // for the thread-key scheme.
    renderThreadApp('/ai', ['/ai', '/ai?pageId=no-page']);

    fireEvent.click(screen.getByText('add message'));
    expect(threadContents()).toEqual(['question about no page']);

    goTo('/ai?pageId=no-page');
    expect(screen.getByTestId('context-page')).toHaveTextContent('no-page');
    expect(threadContents()).toEqual([]);

    fireEvent.click(screen.getByText('add message'));
    expect(threadContents()).toEqual(['question about no-page']);

    goTo('/ai');
    expect(threadContents()).toEqual(['question about no page']);
  });
```

new:

```tsx
  it('gives the no-document case a thread a real page cannot collide with', () => {
    // Pages whose ids are literally the sentinel keys are the adversarial case
    // for the thread-key scheme. Both spellings are checked — 'no-page' is
    // today's sentinel and 'draft' is Task 2's — so renaming it cannot quietly
    // open a collision.
    renderThreadApp('/ai', ['/ai', '/pages/no-page', '/pages/draft']);

    fireEvent.click(screen.getByText('add message'));
    expect(threadContents()).toEqual(['question about no page']);

    goTo('/pages/no-page');
    expect(screen.getByTestId('context-page')).toHaveTextContent('no-page');
    expect(threadContents()).toEqual([]);
    fireEvent.click(screen.getByText('add message'));
    expect(threadContents()).toEqual(['question about no-page']);

    goTo('/pages/draft');
    expect(screen.getByTestId('context-page')).toHaveTextContent('draft');
    expect(threadContents()).toEqual([]);
    fireEvent.click(screen.getByText('add message'));
    expect(threadContents()).toEqual(['question about draft']);

    goTo('/ai');
    expect(threadContents()).toEqual(['question about no page']);
  });
```

`:196-209` — **delete this test outright**:

```tsx
  it('shares one thread between /ai?pageId=x and the article route for x', () => {
    // ?pageId= is an input to context resolution, not its definition: the open
    // document resolves to the same thread.
    renderThreadApp('/pages/page-a', ['/pages/page-a', '/ai?pageId=page-a']);

    expect(screen.getByTestId('context-page')).toHaveTextContent('page-a');
    fireEvent.click(screen.getByText('add message'));

    goTo('/ai?pageId=page-a');
    expect(threadContents()).toEqual(['question about page-a']);

    goTo('/pages/page-a');
    expect(threadContents()).toEqual(['question about page-a']);
  });
```

It pinned the exact contract this task reverses: `/ai?pageId=x` and
`/pages/x` shared one thread. From here they cannot — `/ai?pageId=x` has no
document at all, and Task 2 keys the two locations differently by construction.
Nothing replaces it; the new behaviour is pinned by the `resolveAiPageId` case
added in Step 13.

`:211-227` — old first line:

```tsx
    renderThreadApp('/ai?pageId=page-a', ['/ai?pageId=page-a', '/ai?pageId=page-b']);
```

new:

```tsx
    renderThreadApp('/pages/page-a', ['/pages/page-a', '/pages/page-b']);
```

and, in the same test, `goTo('/ai?pageId=page-b')` → `goTo('/pages/page-b')`
and `goTo('/ai?pageId=page-a')` → `goTo('/pages/page-a')`.

`:231` — old:

```tsx
    const urls = Array.from({ length: 13 }, (_, i) => `/ai?pageId=page-${i}`);
```

new:

```tsx
    const urls = Array.from({ length: 13 }, (_, i) => `/pages/page-${i}`);
```

`:264-281` — old:

```tsx
    renderThreadApp('/ai?pageId=page-a', ['/ai?pageId=page-a', '/ai?pageId=page-b']);
```

new:

```tsx
    renderThreadApp('/pages/page-a', ['/pages/page-a', '/pages/page-b']);
```

and in the same test `goTo('/ai?pageId=page-b')` → `goTo('/pages/page-b')`,
`goTo('/ai?pageId=page-a')` → `goTo('/pages/page-a')`.

`:335-345` — old:

```tsx
    goTo('/ai?pageId=page-b');

    expect(screen.getByTestId('mode')).toHaveTextContent('ask');
    // The page context still follows the URL — only the mode was dropped.
    expect(screen.getByTestId('context-page')).toHaveTextContent('page-b');
  });
```

new:

```tsx
    goTo('/ai?pageId=page-b');

    expect(screen.getByTestId('mode')).toHaveTextContent('ask');
  });
```

The deleted assertion said the page context still follows the URL on `/ai`. It
does not any more, and that is this task's point: the mode-clearing half of the
contract is what the case exists for, and it stands.

- [ ] **Step 18: Run the thread suite**

Run: `cd frontend && npx vitest run src/features/ai/AiContext.threads.test.tsx`
Expected: PASS — 12 cases.

- [ ] **Step 19: Repoint the page-scoped tests in the other AI suites**

Every remaining failure is a test that mounts an AI surface at `/ai?pageId=…`
to give it a document. Those tests are about page-scoped ACTIONS (Improve,
Diagram, Apply), and the article route is now the only place a document comes
from — so the wrapper moves rather than the assertion. Run each file to see the
failure first.

Run: `cd frontend && npx vitest run src/features/ai/modes/ImproveMode.test.tsx src/features/ai/modes/ImproveMode.attachments.test.tsx src/features/ai/modes/DiagramMode.test.tsx src/features/ai/AiAssistantPage.test.tsx`
Expected: FAIL — e.g. `expected "/llm/improve" to have been called with … { pageId: 'p1' }` (the body now carries `pageId: undefined`), and DiagramMode's insert control missing because it renders on `page && pageId`.

`frontend/src/features/ai/modes/ImproveMode.test.tsx:54` — old:

```tsx
function createWrapper(initialEntries = ['/ai?pageId=page-1&mode=improve']) {
```

new:

```tsx
// #1361: a document comes from the article route now — `/ai?pageId=` resolves
// to no page. Improve is a page-scoped action, so its tests mount where the
// page is.
function createWrapper(initialEntries = ['/pages/page-1?mode=improve']) {
```

`frontend/src/features/ai/modes/ImproveMode.attachments.test.tsx:100` — old:

```tsx
        <MemoryRouter initialEntries={['/ai?pageId=page-1&mode=improve']}>
```

new:

```tsx
        <MemoryRouter initialEntries={['/pages/page-1?mode=improve']}>
```

`frontend/src/features/ai/modes/DiagramMode.test.tsx` — replace **all three**
occurrences (`:121`, `:160`, `:197`) of:

```tsx
      render(<DiagramModeInput />, { wrapper: createWrapper(['/ai?pageId=p1']) });
```

with:

```tsx
      render(<DiagramModeInput />, { wrapper: createWrapper(['/pages/p1']) });
```

`frontend/src/features/ai/AiAssistantPage.test.tsx` — replace **all fifteen**
occurrences of the string:

```tsx
createWrapper(['/ai?mode=improve&pageId=p1'])
```

with:

```tsx
createWrapper(['/pages/p1?mode=improve'])
```

replace **both** occurrences of:

```tsx
createWrapper(['/ai?mode=diagram&pageId=p1'])
```

with:

```tsx
createWrapper(['/pages/p1?mode=diagram'])
```

and the single occurrence of:

```tsx
createWrapper(['/ai?mode=improve&pageId=p2'])
```

with:

```tsx
createWrapper(['/pages/p2?mode=improve'])
```

Leave the three bare `createWrapper(['/ai?pageId=p1'])` wrappers at `:200`,
`:277` and `:329` alone: those tests exercise composer attachments and assert
no `pageId`, so the param is simply inert there. Leave the two at `:1620` and
`:1635` for the same reason, and leave `:1553`'s deliberately — the context-chip
case is *about* that legacy param and still passes (the chip renders off `page`,
which `usePage` is mocked to supply, and clicking it still strips the param).
Task 15 deletes that test with the chip.

- [ ] **Step 20: Delete the one test whose premise this task removes**

`frontend/src/features/ai/AiAssistantPage.test.tsx:381-419` — delete the whole
case:

```tsx
  it('clears staged attachments when the page context changes', async () => {
```
…through its closing…
```tsx
    expect(revokePreview).toHaveBeenCalledWith('blob:assistant-preview');
  });
```

It stages attachments on `/ai?pageId=p1`, clicks `ai-context-chip` to drop the
param, and asserts `AssistantAttachmentsScope` cleared them. On `/ai` there is
no page context to change any more, so the click is a no-op for scope and the
case can only fail. The behaviour it guarded is not lost: Task 6 re-pins
attachment clearing on the thing that actually changes now — `activeThreadId` —
and Task 15 deletes the chip itself. (The PR plan's *Delete (tests only)* list
attributes this case to Task 15 as "the context-chip test (`:394-415`)"; it has
to go here instead, because it is red from this task onward.)

- [ ] **Step 21: Run the four repointed suites**

Run: `cd frontend && npx vitest run src/features/ai/modes/ImproveMode.test.tsx src/features/ai/modes/ImproveMode.attachments.test.tsx src/features/ai/modes/DiagramMode.test.tsx src/features/ai/AiAssistantPage.test.tsx`
Expected: PASS.

- [ ] **Step 22: Run the guard suites this task touches, plus the whole frontend suite**

Run:
```bash
cd frontend && npx vitest run src/ai-scroll-chain.test.ts src/scroll-padding-mask.test.ts src/flat-components.test.ts
cd frontend && npx vitest run
cd frontend && npx tsc --noEmit
cd frontend && npm run lint
```
Expected: all green. `ai-scroll-chain.test.ts` names `PageTransition` by file
and is the one that would catch a broken edit there.

- [ ] **Step 23: Commit**

```bash
cd /Users/simon/Documents/localGIT/compendiq-ce-wt-1361-design
git add frontend/src/shared/lib/ai-routes.ts \
        frontend/src/shared/lib/ai-routes.test.ts \
        frontend/src/App.tsx \
        frontend/src/App.test.tsx \
        frontend/src/shared/components/layout/PageTransition.tsx \
        frontend/src/shared/components/layout/PageTransition.test.tsx \
        frontend/src/features/ai/AiContext.tsx \
        frontend/src/features/ai/AiContext.threads.test.tsx \
        frontend/src/features/ai/AiAssistantPage.test.tsx \
        frontend/src/features/ai/modes/ImproveMode.test.tsx \
        frontend/src/features/ai/modes/ImproveMode.attachments.test.tsx \
        frontend/src/features/ai/modes/DiagramMode.test.tsx
git commit -m "feat(ai): add /ai/c/:conversationId and one AI-route predicate

One conversation, one URL. `shared/lib/ai-routes.ts` is the single definition
of the route family (AppLayout and AiContext both need it, and AiProvider sits
above <Routes> so it cannot use useParams); an AI route now resolves to no
document, so a legacy /ai?pageId= bookmark opens a plain new chat instead of
silently scoping answers to a page the pane no longer lists.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Thread keys by location, identity, `activeThreadId`, `startNewConversation`, and the mirror deleted

Implements spec §*Thread keys* (the key table, `AiThread`'s four new fields,
*Filing and identity*), §*`activeThreadId`*, the **New chat** row of §*The state
machine*, and §*`AiContextValue` changes*.

**Files:**
- Modify: `frontend/src/features/ai/AiContext.tsx` — `Conversation` (`:46-51`), `AiContextValue` (`:80-92`), `AiThread` (`:266-283`), `EMPTY_THREAD` (`:284-294`), the key sentinel + `threadKeyFor` (`:296-306`), `touchThread` (`:318-333`), the provider's thread state and read path (`:391-397`), the conversations mirror (`:403`, `:606-621`), `startNewConversation` (`:660-673`), `loadConversation` / `deleteConversation` (`:675-716`), the value object (`:964-968`)
- Test: `frontend/src/features/ai/AiContext.threads.test.tsx`
- Modify (test fallout): `frontend/src/features/ai/AiAssistantPage.test.tsx` (`:2230-2296`, `:2588-2637` deleted)

**Interfaces:**
- Consumes: `AI_HOME_PATH`, `isAiRoute`, `conversationIdFromPath` (Task 1).
- Produces, module-private in `AiContext.tsx`: `type ThreadKey = 'draft' | \`conv:${string}\` | \`page:${string}\``; `threadKeyFor(pathname: string): ThreadKey`; `nextIdentity(): number`; `seedFor(key: string): AiThread`; `fileThread(threads, key)`; `evictOldest(next)`; `touchThread(threads, key, patch)` (same signature, now files a missing key with `nextIdentity()` and re-pins an existing identity); `updateThread(key, patch)` (same signature); `AiThread` gains `identity: number`, `loadState: 'ready' | 'loading' | 'error'`, `loadError: string | null`, `historyTruncated: boolean`.
- Produces, on `AiContextValue`: `activeThreadId: string`, `composerFocusRequest: number`, `startNewConversation: () => void` (new semantics).
- Removes from `AiContextValue`: `conversations`, `setConversations`, `loadConversation`, `deleteConversation`.

**Pinned here:**
- **`threadKeyFor` reads the pathname only.** The binding interface is
  `threadKeyFor(pathname: string)`, so `?pageId=` selects no thread anywhere any
  more; on an article route the key is derived from the same `[^/]+` segment
  `resolveAiPageId` uses, so `pageId` and `threadKey` cannot disagree where the
  dock mounts. An off-route `?pageId=` (e.g. `/graph?pageId=x`) still resolves a
  `pageId` for the ask body but files the `draft` thread — nothing produces such
  a URL, and the dock only mounts on `/pages/:id`.
- **A patch may never change an identity.** `touchThread` re-pins
  `identity: base.identity` *after* spreading the patch, so "a write is not a
  filing" is enforced rather than merely documented; the two functions that
  legitimately stamp a new identity (`fileThread`) or move an existing one
  (Task 4's `rekeyThread`) are separate.
- **The read path is memoised.** `seedFor` builds a fresh object per call, so
  `threads.get(key) ?? seedFor(key)` inline would hand a new `messages: []`
  array to the auto-scroll effect on every render of an unfiled thread.
  `useMemo` on `[threads, threadKey]` keeps today's referential stability.
- **A `conv:` thread seeded here stays `loadState: 'loading'` forever.** Nothing
  reads `loadState` until Task 5 exposes it and adds the hydration effect; the
  field is introduced here because `seedFor` is the one function that knows what
  an unfiled thread looks like, and splitting it across two tasks is how the
  `?q=` prefill would file `'ready'` and suppress hydration for good.

- [ ] **Step 1: Write the failing tests**

In `frontend/src/features/ai/AiContext.threads.test.tsx`, extend the harness.
`ThreadProbe` — old:

```tsx
function ThreadProbe() {
  const {
    pageId, mode, messages, conversationId, input,
    setMessages, setConversationId, setInput, startNewConversation, runStream,
  } = useAiContext();
  const label = pageId ?? 'no page';

  return (
    <div>
      <span data-testid="context-page">{label}</span>
      <span data-testid="mode">{mode}</span>
      <span data-testid="conversation-id">{conversationId ?? 'none'}</span>
      <span data-testid="draft">{input}</span>
```

new:

```tsx
function ThreadProbe() {
  const {
    pageId, mode, setMode, messages, conversationId, input, activeThreadId, composerFocusRequest,
    setMessages, setConversationId, setInput, startNewConversation, runStream,
  } = useAiContext();
  const label = pageId ?? 'no page';

  return (
    <div>
      <span data-testid="context-page">{label}</span>
      <span data-testid="mode">{mode}</span>
      <span data-testid="conversation-id">{conversationId ?? 'none'}</span>
      <span data-testid="draft">{input}</span>
      {/* The identity every switch-sensitive effect keys on (#1361). Read as an
          opaque token: the tests compare it against itself across a gesture,
          never against a literal. */}
      <span data-testid="active-thread">{activeThreadId}</span>
      <span data-testid="focus-request">{composerFocusRequest}</span>
```

and, in the same component, after the `new conversation` button — old:

```tsx
      <button onClick={startNewConversation}>new conversation</button>
    </div>
  );
}
```

new:

```tsx
      <button onClick={startNewConversation}>new conversation</button>
      <button onClick={() => setMode('generate')}>go generate</button>
    </div>
  );
}
```

Add a Back control beside `NavButton` (a conversation URL is a history entry,
so New chat's "do not stack dead entries" rule is only observable by walking
back):

```tsx
/** Walks one entry back, so a test can count what New chat pushed. */
function BackButton() {
  const navigate = useNavigate();
  return <button onClick={() => navigate(-1)}>back</button>;
}
```

Give the harness a history behind the entry point — old:

```tsx
function renderThreadApp(initialEntry: string, destinations: string[] = []) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <AiProvider>
          <LocationDisplay />
          {destinations.map((to) => (
            <NavButton key={to} to={to} />
          ))}
```

new:

```tsx
function renderThreadApp(
  initialEntry: string,
  destinations: string[] = [],
  entriesBefore: string[] = [],
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const entries = [...entriesBefore, initialEntry];
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
        <AiProvider>
          <LocationDisplay />
          <BackButton />
          {destinations.map((to) => (
            <NavButton key={to} to={to} />
          ))}
```

Add `useNavigate` — it is already imported in this file (`:10`), so no import
change is needed.

Now the new cases. Append these two `describe` blocks after the closing `});`
of `describe('AiContext per-page threads (#1126)', …)` and before
`describe('resolveAiPageId', …)`:

```tsx
describe('thread keys follow the location (#1361)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiFetchMock.mockResolvedValue([]);
  });

  it('gives the draft and each conversation its own thread', () => {
    renderThreadApp('/ai', ['/ai', '/ai/c/conv-a', '/ai/c/conv-b']);

    fireEvent.click(screen.getByText('add message'));
    expect(threadContents()).toEqual(['question about no page']);

    // Opening a conversation is a switch onto a thread of its own — the draft
    // is not "the current thread" that a conversation is loaded into.
    goTo('/ai/c/conv-a');
    expect(threadContents()).toEqual([]);
    fireEvent.click(screen.getByText('add message'));
    expect(threadContents()).toEqual(['question about no page']);
    expect(screen.getByTestId('conversation-id')).toHaveTextContent('conv-no page');

    // Two conversations are two threads.
    goTo('/ai/c/conv-b');
    expect(threadContents()).toEqual([]);

    // …and the draft is still where it was left.
    goTo('/ai');
    expect(threadContents()).toEqual(['question about no page']);
  });

  it('keeps the dock thread separate from the draft', () => {
    renderThreadApp('/pages/page-a', ['/pages/page-a', '/ai']);

    fireEvent.click(screen.getByText('add message'));
    goTo('/ai');
    expect(threadContents()).toEqual([]);
    goTo('/pages/page-a');
    expect(threadContents()).toEqual(['question about page-a']);
  });
});

describe('activeThreadId (#1361)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiFetchMock.mockResolvedValue([]);
  });

  function activeThread(): string {
    return screen.getByTestId('active-thread').textContent ?? '';
  }

  it('changes when a conversation is opened', () => {
    renderThreadApp('/ai', ['/ai/c/conv-a']);
    const before = activeThread();
    goTo('/ai/c/conv-a');
    expect(activeThread()).not.toBe(before);
  });

  it('changes on New chat even when the draft is already empty', () => {
    // The AC that makes Deep Search and staged attachments clear on new->new:
    // a fresh identity is what every composer reset keys on.
    renderThreadApp('/ai');
    const before = activeThread();
    fireEvent.click(screen.getByText('new conversation'));
    expect(activeThread()).not.toBe(before);
  });

  it('changes on a dock page change', () => {
    renderThreadApp('/pages/page-a', ['/pages/page-b']);
    const before = activeThread();
    goTo('/pages/page-b');
    expect(activeThread()).not.toBe(before);
  });

  it('does not change while the user types', () => {
    renderThreadApp('/ai');
    const before = activeThread();
    fireEvent.click(screen.getByText('add message'));
    expect(screen.getByTestId('draft')).toHaveTextContent('draft for no page');
    expect(activeThread()).toBe(before);
  });

  it('does not change when the ?q= prefill writes the composer', () => {
    // A write is not a filing: the prefill lands through the same updateThread
    // path a keystroke does, and must leave the identity alone or every
    // composer reset would fire on a deep link.
    renderThreadApp('/ai', ['/ai?q=how do I rotate the PAT']);
    const before = activeThread();
    goTo('/ai?q=how do I rotate the PAT');
    expect(screen.getByTestId('draft')).toHaveTextContent('how do I rotate the PAT');
    expect(activeThread()).toBe(before);
  });
});
```

And, in `describe('AiContext per-page threads (#1126)', …)`, replace the New
chat case — old:

```tsx
  it('clears only the active thread on a deliberate new conversation', () => {
    renderThreadApp('/pages/page-a', ['/pages/page-a', '/pages/page-b']);

    fireEvent.click(screen.getByText('add message'));
    goTo('/pages/page-b');
    fireEvent.click(screen.getByText('add message'));

    fireEvent.click(screen.getByText('new conversation'));
    expect(threadContents()).toEqual([]);
    expect(screen.getByTestId('conversation-id')).toHaveTextContent('none');
    expect(screen.getByTestId('draft')).toHaveTextContent('');

    // A is untouched — a reset is scoped to the thread you are looking at.
    goTo('/pages/page-a');
    expect(threadContents()).toEqual(['question about page-a']);
    expect(screen.getByTestId('conversation-id')).toHaveTextContent('conv-page-a');
  });
```

new:

```tsx
  it('starts a fresh draft on New chat and leaves every other thread alone', () => {
    // #1361 changed what New chat means: it is not "clear the thread you are
    // looking at" any more, it is "put a brand-new draft on screen". From a
    // dock thread that means going to /ai; the dock thread itself is untouched.
    renderThreadApp('/pages/page-a', ['/pages/page-a', '/ai']);

    goTo('/ai');
    fireEvent.click(screen.getByText('add message'));
    goTo('/pages/page-a');
    fireEvent.click(screen.getByText('add message'));

    fireEvent.click(screen.getByText('new conversation'));

    expect(screen.getByTestId('location')).toHaveTextContent('/ai');
    expect(threadContents()).toEqual([]);
    expect(screen.getByTestId('conversation-id')).toHaveTextContent('none');
    expect(screen.getByTestId('draft')).toHaveTextContent('');

    goTo('/pages/page-a');
    expect(threadContents()).toEqual(['question about page-a']);
    expect(screen.getByTestId('conversation-id')).toHaveTextContent('conv-page-a');
  });

  it('does not stack a history entry when New chat is pressed on /ai', () => {
    // react-router pushes even for a same-path navigate, so an unguarded
    // navigate(AI_HOME_PATH) would bury the page the user came from under n
    // dead /ai entries.
    renderThreadApp('/ai', [], ['/']);

    fireEvent.click(screen.getByText('new conversation'));
    fireEvent.click(screen.getByText('new conversation'));
    fireEvent.click(screen.getByText('back'));

    expect(screen.getByTestId('location')).toHaveTextContent('/');
  });

  it('navigates home when New chat is pressed on a conversation URL', () => {
    renderThreadApp('/ai/c/conv-a');

    fireEvent.click(screen.getByText('new conversation'));

    expect(screen.getByTestId('location')).toHaveTextContent('/ai');
    expect(screen.getByTestId('location').textContent).not.toContain('/c/');
  });

  it('lands a New chat on Ask, whatever action was selected', () => {
    // `mode` is provider-wide and the URL-mode effect does not fire on a
    // same-path navigation, so New chat has to set it itself — otherwise a
    // fresh chat opens on Generate and the composer the focus request is aimed
    // at is not on screen.
    renderThreadApp('/ai');

    fireEvent.click(screen.getByText('go generate'));
    expect(screen.getByTestId('mode')).toHaveTextContent('generate');

    fireEvent.click(screen.getByText('new conversation'));
    expect(screen.getByTestId('mode')).toHaveTextContent('ask');
  });

  it('bumps the composer focus request on New chat', () => {
    renderThreadApp('/ai');
    const before = screen.getByTestId('focus-request').textContent;

    fireEvent.click(screen.getByText('new conversation'));

    expect(screen.getByTestId('focus-request').textContent).not.toBe(before);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/features/ai/AiContext.threads.test.tsx`
Expected: FAIL — TypeScript/runtime errors on `activeThreadId` and
`composerFocusRequest` (`Property 'activeThreadId' does not exist on type
'AiContextValue'`), plus `gives the draft and each conversation its own thread`
showing the draft's message on `/ai/c/conv-a` (one `no-page` thread today).

- [ ] **Step 3: Rewrite the thread model**

`frontend/src/features/ai/AiContext.tsx:2` — old:

```tsx
import { createContext, useContext, useState, useRef, useEffect, useCallback, type ReactNode } from 'react';
```

new:

```tsx
import { createContext, useContext, useState, useRef, useEffect, useMemo, useCallback, type ReactNode } from 'react';
```

`:1-13` imports — add beside Task 1's `isAiRoute` import:

```tsx
import { AI_HOME_PATH, isAiRoute, conversationIdFromPath } from '../../shared/lib/ai-routes';
```

(replacing Task 1's `import { isAiRoute } from '../../shared/lib/ai-routes';`).

`:46-51` — delete the now-unused local shape:

```tsx
interface Conversation {
  id: string;
  title: string;
  model: string;
  createdAt: string;
}
```

`:266-306` — old:

```tsx
interface AiThread {
  messages: Message[];
  conversationId: string | null;
  input: string;
  showDiffView: boolean;
  improvedContent: string;
  originalMarkdown: string;
  layoutTokensLost: boolean | undefined;
  diagramCode: string;
  /**
   * `page.version` at the moment the pending improvement was produced (#1126).
   * The dock compares it against the live version to detect that the document
   * moved under an un-applied diff, which is the difference between offering a
   * re-run and silently overwriting someone else's edit.
   */
  diffBaseVersion: number | null;
}

const EMPTY_THREAD: AiThread = {
  messages: [],
  conversationId: null,
  input: '',
  showDiffView: false,
  improvedContent: '',
  originalMarkdown: '',
  layoutTokensLost: undefined,
  diagramCode: '',
  diffBaseVersion: null,
};

/**
 * Thread key for the no-document case (`/ai` with no page context). The
 * `page:` prefix on every real key makes a collision with a page id — even a
 * page literally called `no-page` — impossible.
 */
const NO_PAGE_THREAD_KEY = 'no-page';

function threadKeyFor(pageId: string | null): string {
  return pageId ? `page:${pageId}` : NO_PAGE_THREAD_KEY;
}
```

new:

```tsx
interface AiThread {
  messages: Message[];
  conversationId: string | null;
  input: string;
  showDiffView: boolean;
  improvedContent: string;
  originalMarkdown: string;
  layoutTokensLost: boolean | undefined;
  diagramCode: string;
  /**
   * `page.version` at the moment the pending improvement was produced (#1126).
   * The dock compares it against the live version to detect that the document
   * moved under an un-applied diff, which is the difference between offering a
   * re-run and silently overwriting someone else's edit.
   */
  diffBaseVersion: number | null;
  /**
   * Stamped when the thread is FILED (#1361), never by a write.
   *
   * Keys move — the first answer on a draft re-keys it to `conv:<id>` — so a
   * stream writer bound to a key would either miss its own thread after the
   * re-key or, worse, land an orphan turn in whatever now sits under the old
   * key. Writers bind to this instead: a re-key is followed for free, and a
   * thread that has since been REPLACED (New chat while its stream was
   * running) simply is not found, so the write drops.
   */
  identity: number;
  /** `conv:` hydration only; `'ready'` for `draft` and `page:` threads. */
  loadState: 'ready' | 'loading' | 'error';
  loadError: string | null;
  /** Last final frame, or `GET /llm/conversations/:id` on reopen (decision 10). */
  historyTruncated: boolean;
}

/**
 * A TEMPLATE, not an entry. `identity: 0` is never observed on a filed thread —
 * identities start at 1 — so a writer that finds 0 has found nothing.
 */
const EMPTY_THREAD: AiThread = {
  messages: [],
  conversationId: null,
  input: '',
  showDiffView: false,
  improvedContent: '',
  originalMarkdown: '',
  layoutTokensLost: undefined,
  diagramCode: '',
  diffBaseVersion: null,
  identity: 0,
  loadState: 'ready',
  loadError: null,
  historyTruncated: false,
};

let threadIdentityCounter = 0;
/** Module counter, starting at 1. Opaque: only equality is ever read. */
function nextIdentity(): number {
  return ++threadIdentityCounter;
}

/**
 * One function knows what an unfiled thread looks like, so the answer is the
 * same whichever of its three callers runs first: the read path, `touchThread`
 * when a write arrives for a missing key, and provider init for `draft`.
 *
 * The `conv:` seed is the load-bearing half. The read path yields it on the
 * FIRST render of `/ai/c/X`, so that render shows *Loading conversation…* and
 * never the Ask empty state; and a write arriving before the filing effect —
 * the widened `/ai/c/X?q=` prefill is exactly such a write — files `'loading'`
 * rather than a `'ready'` thread that hydration would then skip for good.
 *
 * Identity is deliberately NOT stamped here: the filer stamps it, because
 * filing is what creates an entry and `seedFor` is also used to READ one that
 * does not exist yet.
 */
function seedFor(key: string): AiThread {
  return { ...EMPTY_THREAD, loadState: key.startsWith('conv:') ? 'loading' : 'ready' };
}

/**
 * Where the thread on screen comes from (#1361). The location, not a page id:
 *
 *   /ai            -> 'draft'      (exactly one, filed at provider init)
 *   /ai/c/<id>     -> 'conv:<id>'  (filed on activation, hydrated into)
 *   /pages/:id     -> 'page:<id>'  (the dock, unchanged)
 *
 * Everything else gets the draft. `?pageId=` selects no thread any more — an AI
 * route has no document (`resolveAiPageId`), and the three producers of
 * `/ai?pageId=` go with the page tree. The `conv:` / `page:` prefixes are what
 * make a collision with a page or conversation literally called `draft`
 * impossible.
 */
type ThreadKey = 'draft' | `conv:${string}` | `page:${string}`;

function threadKeyFor(pathname: string): ThreadKey {
  const conversationId = conversationIdFromPath(pathname);
  if (conversationId) return `conv:${conversationId}`;
  if (isAiRoute(pathname)) return 'draft';
  const routeId = ARTICLE_ROUTE.exec(pathname)?.[1];
  // /pages/new is the create route, not a document.
  return routeId && routeId !== 'new' ? `page:${routeId}` : 'draft';
}
```

`ARTICLE_ROUTE` is declared below this point today (`:342`). Move its
declaration up so `threadKeyFor` can use it — cut this line from `:342`:

```tsx
const ARTICLE_ROUTE = /^\/pages\/([^/]+)$/;
```

and paste it immediately above the `type ThreadKey` block.

`:318-333` (`touchThread`) — old:

```tsx
/**
 * Apply `patch` to one thread and mark it most-recently-used. A Map iterates
 * in insertion order, so delete-then-set moves the touched key to the end and
 * the first key is always the least recently used thread.
 */
function touchThread(
  threads: Map<string, AiThread>,
  key: string,
  patch: (thread: AiThread) => Partial<AiThread>,
): Map<string, AiThread> {
  const current = threads.get(key) ?? EMPTY_THREAD;
  const next = new Map(threads);
  next.delete(key);
  next.set(key, { ...current, ...patch(current) });
  while (next.size > MAX_RETAINED_THREADS) {
    const oldest = next.keys().next().value;
    if (oldest === undefined) break;
    next.delete(oldest);
  }
  return next;
}
```

new:

```tsx
/** LRU eviction, shared by the two writers below. */
function evictOldest(next: Map<string, AiThread>): Map<string, AiThread> {
  while (next.size > MAX_RETAINED_THREADS) {
    const oldest = next.keys().next().value;
    if (oldest === undefined) break;
    next.delete(oldest);
  }
  return next;
}

/**
 * File a FRESH thread under `key`, replacing whatever was there, and stamp a
 * new identity. This is the only way an entry is created (provider init, the
 * filing effect, New chat) — and stamping here is what makes New chat's
 * "new -> new" case work: the old object is gone, so a stream still writing
 * into it drops rather than landing in the fresh draft.
 */
function fileThread(threads: Map<string, AiThread>, key: string): Map<string, AiThread> {
  const next = new Map(threads);
  next.delete(key);
  next.set(key, { ...seedFor(key), identity: nextIdentity() });
  return evictOldest(next);
}

/**
 * Apply `patch` to one thread and mark it most-recently-used. A Map iterates
 * in insertion order, so delete-then-set moves the touched key to the end and
 * the first key is always the least recently used thread.
 *
 * A write is NOT a filing (#1361). A missing key is filed through `seedFor` +
 * `nextIdentity()` — `EMPTY_THREAD` was wrong here, because it would file a
 * `conv:` thread as `'ready'` and silently suppress its hydration — and an
 * existing entry KEEPS its identity: the patch's `identity` is re-pinned after
 * the spread, so no writer can renumber the thread its own stream is bound to.
 */
function touchThread(
  threads: Map<string, AiThread>,
  key: string,
  patch: (thread: AiThread) => Partial<AiThread>,
): Map<string, AiThread> {
  const base = threads.get(key) ?? { ...seedFor(key), identity: nextIdentity() };
  const next = new Map(threads);
  next.delete(key);
  next.set(key, { ...base, ...patch(base), identity: base.identity });
  return evictOldest(next);
}
```

- [ ] **Step 4: Wire the provider to the new model**

`frontend/src/features/ai/AiContext.tsx:391-397` — old:

```tsx
  // Conversations keyed by page and retained (#1126). Changing pages swaps
  // which thread is on screen; it never destroys one.
  const threadKey = threadKeyFor(pageId);
  const [threads, setThreads] = useState<Map<string, AiThread>>(() => new Map());
  const {
    messages, conversationId, input, showDiffView,
    improvedContent, originalMarkdown, layoutTokensLost, diagramCode, diffBaseVersion,
  } = threads.get(threadKey) ?? EMPTY_THREAD;
```

new:

```tsx
  // Threads keyed by LOCATION and retained (#1126, re-keyed in #1361). Changing
  // where you are swaps which thread is on screen; it never destroys one.
  const threadKey = threadKeyFor(location.pathname);
  // The draft is filed at init, so `/ai` never renders an unfiled active key.
  const [threads, setThreads] = useState<Map<string, AiThread>>(() => fileThread(new Map(), 'draft'));
  // Memoised because `seedFor` builds a new object per call: an inline
  // `?? seedFor(key)` would hand a fresh `messages: []` to the auto-scroll
  // effect on every render of a not-yet-filed thread.
  const activeThread = useMemo(() => threads.get(threadKey) ?? seedFor(threadKey), [threads, threadKey]);
  const {
    messages, conversationId, input, showDiffView,
    improvedContent, originalMarkdown, layoutTokensLost, diagramCode, diffBaseVersion,
  } = activeThread;
  /**
   * The one thing every switch-sensitive effect keys on (#1361): the filed
   * identity, or the bare key for the one render before the entry is filed (so
   * two unfiled keys still differ). It changes on every switch — open, New
   * chat, dock page change, delete-of-active — and on nothing else: not on a
   * keystroke, not on a `?q=` prefill, not while streaming, and not on the
   * promotion re-key, which moves the same object.
   */
  const activeThreadId = String(threads.get(threadKey)?.identity ?? threadKey);
  const [composerFocusRequest, setComposerFocusRequest] = useState(0);

  // File the active key if it is absent. On STATE, not on presence: this is
  // what stamps the identity, and the hydration effect (which keys on
  // `loadState`) needs the entry to exist with the seed `seedFor` chose. The
  // key -> identity transition therefore happens exactly once, at activation,
  // within the first effect flush — before a person can type.
  useEffect(() => {
    setThreads((prev) => (prev.has(threadKey) ? prev : fileThread(prev, threadKey)));
  }, [threadKey]);
```

`:403` — delete:

```tsx
  const [conversations, setConversations] = useState<Conversation[]>([]);
```

`:606-621` — delete the list query and its mirror effect:

```tsx
  const conversationsQuery = useQuery<Conversation[]>({
    queryKey: ['llm', 'conversations'],
    // #1361 PR 1: the list endpoint now returns { items, nextCursor }; this
    // mirror is deleted in PR 2 (the pane owns the query). Tolerate both.
    queryFn: async () => {
      const r = await apiFetch<Conversation[] | { items: Conversation[] }>('/llm/conversations');
      return Array.isArray(r) ? r : r.items;
    },
    retry: false,
    staleTime: 30_000,
    enabled: hasConsumers,
  });
  useEffect(() => {
    if (conversationsQuery.data) setConversations(conversationsQuery.data);
  }, [conversationsQuery.data]);
```

replacing it with the note that says why nothing took its place:

```tsx
  // The conversation list is TanStack Query state owned by the pane
  // (`useConversationList`, key ['llm','conversations','list']) since #1361.
  // The provider used to hold a useState mirror of it, which meant two copies
  // of the same server data and a provider-wide fetch on every route.
```

`:660-673` (`startNewConversation`) — old:

```tsx
  // Deliberate reset of the *active* thread. Threads are no longer discarded
  // by navigation (#1126), so this is the one way a user clears one — other
  // pages' threads are untouched.
  const startNewConversation = useCallback(() => {
    updateThread(threadKey, () => ({ messages: [], conversationId: null, input: '' }));
    // #355 (Finding 2, AC-4): reset the model selector to the current chat
    // default so a per-conversation override (set via loadConversation or the
    // dropdown) doesn't leak into newly-started conversations. We read from
    // the live TanStack Query result so admin-side changes are picked up
    // without remounting.
    if (chatDefault?.model) {
      setModel(chatDefault.model);
    }
  }, [chatDefault, threadKey, updateThread]);
```

new:

```tsx
  /**
   * New chat (#1361). Not "clear the thread you are looking at" any more — it
   * puts a brand-new draft on screen, wherever you pressed it.
   *
   * Four things, in this order:
   *  - abort explicitly. The identity braces already drop the aborted commit
   *    (the old draft object is gone below), but a stream left running would
   *    keep the provider's `isStreaming` lit over a thread it does not belong
   *    to. This is the belt.
   *  - file a FRESH `draft`: a new identity, so every composer reset keyed on
   *    `activeThreadId` fires even on the already-empty draft (Deep Search and
   *    staged attachments clear — the "new -> new" AC).
   *  - `setMode('ask')`: a new chat is a question, and it is what puts
   *    `AskModeInput` on screen for the focus request below. `mode` is
   *    provider-wide and the URL-mode effect does not fire on a same-path
   *    navigation, so nothing else would do it.
   *  - navigate home ONLY when not already there. react-router pushes even for
   *    a same-path `navigate`, so pressing New chat n times on /ai would
   *    otherwise bury the page the user came from under n dead entries. Push,
   *    not replace: Back returns to the conversation.
   *
   * No model reset. #355 AC-4 reset it because `/ai`'s dropdown could put a
   * per-conversation override on the provider; that dropdown is gone and
   * nothing on `/ai` writes `model` any more.
   */
  const startNewConversation = useCallback(() => {
    abortRef.current?.abort();
    setThreads((prev) => fileThread(prev, 'draft'));
    setMode('ask');
    if (location.pathname !== AI_HOME_PATH) navigate(AI_HOME_PATH);
    setComposerFocusRequest((n) => n + 1);
  }, [location.pathname, navigate]);
```

`:675-716` — delete `loadConversation` and `deleteConversation` whole (from
`const loadConversation = useCallback(async (id: string) => {` through the
closing `}, [conversationId, startNewConversation]);` of `deleteConversation`),
and leave the reason in their place:

```tsx
  // `loadConversation` is route-driven and internal since #1361: opening a row
  // navigates to `/ai/c/:id` and the hydration effect fetches into `conv:<id>`,
  // never into "the current thread". `deleteConversation` belongs to the pane's
  // mutation, which calls `purgeConversation` here when the server confirms.
```

`AiContextValue` (`:80-92`) — old:

```tsx
  // Conversation & messages
  messages: Message[];
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  conversationId: string | null;
  setConversationId: (id: string | null) => void;
  conversations: Conversation[];
  setConversations: React.Dispatch<React.SetStateAction<Conversation[]>>;
  startNewConversation: () => void;
  loadConversation: (id: string) => Promise<void>;
  deleteConversation: (id: string) => Promise<void>;
```

new:

```tsx
  // Conversation & messages
  messages: Message[];
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  conversationId: string | null;
  setConversationId: (id: string | null) => void;
  /**
   * Identity of the thread on screen, as a string (#1361). Opaque — only
   * equality is meaningful. Every switch-sensitive effect keys on it: the
   * abort-on-switch effect, `DeepSearchToggle`, `AssistantAttachmentsScope`,
   * and the Ask composer's `externalUrls`.
   */
  activeThreadId: string;
  startNewConversation: () => void;
  /**
   * Bumped by `startNewConversation`. The composer focuses its textarea
   * whenever this changes — a counter rather than a boolean, because two New
   * chats in a row have to be two focus requests.
   */
  composerFocusRequest: number;
```

The value object (`:964-968`) — old:

```tsx
    conversationId,
    setConversationId,
    conversations,
    setConversations,
    startNewConversation,
    loadConversation,
    deleteConversation,
```

new:

```tsx
    conversationId,
    setConversationId,
    activeThreadId,
    startNewConversation,
    composerFocusRequest,
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/features/ai/AiContext.threads.test.tsx`
Expected: PASS — 22 cases.

- [ ] **Step 6: Delete the two tests whose subjects this task removes**

Run: `cd frontend && npx vitest run src/features/ai/AiAssistantPage.test.tsx`
Expected: FAIL twice —
`startNewConversation resets model to the current chat default (Finding 2, AC-4)`
(`expected 'gpt-4o-mini' to be 'qwen3:8b'`), and
`survives a reload of the conversation`
(`Property 'loadConversation' does not exist on type 'AiContextValue'`).

Delete `frontend/src/features/ai/AiAssistantPage.test.tsx:2230-2296` — the whole
case from:

```tsx
    it('startNewConversation resets model to the current chat default (Finding 2, AC-4)', async () => {
```
through its closing:
```tsx
      expect(captured?.model).toBe('qwen3:8b');
    });
```

Why: #355 AC-4 existed because `/ai`'s model dropdown could pin a
per-conversation override onto the provider, which then leaked into the next
conversation. The spec retires that reset with the dropdown that made it
necessary (§*`AiContextValue` changes*), and `model` now only ever holds the
chat default. A test asserting the reset would pin behaviour the design
removed. (The PR plan's *Delete (tests only)* list attributes this case to
Task 15; it has to go here, because `startNewConversation` stops resetting the
model in this task.)

Delete `frontend/src/features/ai/AiAssistantPage.test.tsx:2588-2637` — the whole
case from:

```tsx
    it('survives a reload of the conversation', async () => {
```
through its closing:
```tsx
      expect(screen.queryByTestId('refusal-sources-label')).not.toBeInTheDocument();
    });
```

Why: it drives `useAiContext().loadConversation`, which is removed here. The
behaviour it guards — a reopened `refused` turn still renders as a refusal, with
no sources claimed — is re-pinned in Task 5 against the route-driven successor
(`hydrateThread`), which is the only way a conversation is reopened from here
on. The `useAiContext` import stays: `:1603` and `:2400` still use it.

- [ ] **Step 7: Run the AI suites**

Run: `cd frontend && npx vitest run src/features/ai`
Expected: PASS.

- [ ] **Step 8: Run the guard suites and the whole frontend suite**

Run:
```bash
cd frontend && npx vitest run src/ai-scroll-chain.test.ts src/scroll-padding-mask.test.ts src/flat-components.test.ts
cd frontend && npx vitest run
cd frontend && npx tsc --noEmit
cd frontend && npm run lint
```
Expected: all green. `AppLayout.test.tsx:628-643` ("issues no AI requests") is
the one to watch — this task removes a provider-wide fetch, so it can only get
greener.

- [ ] **Step 9: Commit**

```bash
cd /Users/simon/Documents/localGIT/compendiq-ce-wt-1361-design
git add frontend/src/features/ai/AiContext.tsx \
        frontend/src/features/ai/AiContext.threads.test.tsx \
        frontend/src/features/ai/AiAssistantPage.test.tsx
git commit -m "refactor(ai): key threads by location and give each one an identity

Threads move from page keys to location keys (draft / conv:<id> / page:<id>)
and every filed thread carries an identity, which is what a re-key can be
followed by and a replaced thread dropped by. activeThreadId is the one token
switch-sensitive effects key on; New chat files a fresh draft rather than
clearing the thread on screen. The useState conversations mirror and its
provider-wide fetch are gone — the pane owns that query.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Identity-bound stream writers, `streamingThreadId`, abort on `activeThreadId`

Implements spec §*Thread keys* → *"Writers are bound to identity, not to key"*
(including the streaming-buffer paragraph and `streamingThreadId`) and
§*`activeThreadId`* → the abort-on-switch effect.

**Files:**
- Modify: `frontend/src/features/ai/AiContext.tsx` — `AiContextValue` streaming block (`:117-131`), the thread helpers (beside `touchThread`), the provider's writers block (`:407-412`), the abort effect (`:493-503`), `runStream` (`:741-947`), the value object
- Modify: `frontend/src/features/ai/AiAssistantPage.tsx:219-220` (context destructure) and `:520-534` (the `MessageBubble` props)
- Modify: `frontend/src/features/ai/dock/DockPanel.tsx:93-97` (context destructure) and `:322-331` (the `DockMessage` props)
- Test: `frontend/src/features/ai/AiContext.threads.test.tsx`
- Test: `frontend/src/features/ai/AiAssistantPage.test.tsx` (new `describe` at the end)
- Test: `frontend/src/features/ai/dock/AiDock.test.tsx` (harness probes + one case)

**Interfaces:**
- Consumes: `AiThread.identity`, `seedFor`, `touchThread`, `updateThread`, `activeThreadId`, `fileThread` (Task 2).
- Produces, module-private: `findThreadKeyByIdentity(threads: Map<string, AiThread>, identity: number): string | undefined`; provider-level `updateThreadByIdentity(identity: number, patch: (t: AiThread) => Partial<AiThread>): void` (a missing identity is a silent DROP); `runStream` locals `originKey` / `originIdentity`; the refs `threadsRef` / `threadKeyRef`; `prevActiveThreadIdRef`.
- Produces, on `AiContextValue`: `streamingThreadId: string | null`.

**Pinned here:**
- **`originHadId` is captured in Task 4, not here.** The brief lists all three
  captures in this task, but nothing in Task 3 reads it and
  `eslint --max-warnings=0` fails on an unused const. Task 4 adds it on the line
  above the promotion guard that is its only consumer.
- **`streamingThreadId` mirrors `activeThreadId`'s own fallback.** It is
  `String(originIdentity)` normally, and the bare `originKey` in the one render
  window where the active key is not yet filed — because `activeThreadId` is
  `String(identity ?? key)` there too, and a `'0'` would make the two never
  compare equal and blank the typing indicator.
- **The gate is applied at the two call sites, not inside the memoised
  components.** `MessageBubble`'s comparator (`AiAssistantPage.tsx:165-182`)
  already diffs `isStreaming` and `isThinking`, so passing them pre-gated needs
  no new prop and no new comparator line; adding a third prop would mean a third
  thing to keep in step. Everything else those two flags drive on each surface —
  the violet hairline, the Stop control, the disabled composer — stays
  provider-wide, because a stream really is running somewhere.
- **The latest-value refs are assigned during render**, which is this repo's
  existing pattern for exactly this (`EmbeddingShadowMigrationCard.tsx:89-90`,
  with the same one-line reason). The alternative — putting `threads` in
  `runStream`'s dependency list — rebuilds `runStream` on every keystroke and
  with it every composer handler that depends on it.

- [ ] **Step 1: Write the failing context tests**

In `frontend/src/features/ai/AiContext.threads.test.tsx`, extend `ThreadProbe`
once more. Old (as left by Task 2):

```tsx
  const {
    pageId, mode, setMode, messages, conversationId, input, activeThreadId, composerFocusRequest,
    setMessages, setConversationId, setInput, startNewConversation, runStream,
  } = useAiContext();
```

new:

```tsx
  const {
    pageId, mode, setMode, messages, conversationId, input, activeThreadId, composerFocusRequest,
    streamingThreadId, setMessages, setConversationId, setInput, startNewConversation, runStream,
  } = useAiContext();
```

Old:

```tsx
      <span data-testid="active-thread">{activeThreadId}</span>
      <span data-testid="focus-request">{composerFocusRequest}</span>
```

new:

```tsx
      <span data-testid="active-thread">{activeThreadId}</span>
      <span data-testid="focus-request">{composerFocusRequest}</span>
      <span data-testid="streaming-thread">{streamingThreadId ?? 'none'}</span>
```

and add a write that is not a message, so a test can prove a plain write does
not abort without tripping `commitToMessages`' "the placeholder is last"
assumption. Old:

```tsx
      <button onClick={() => setMode('generate')}>go generate</button>
```

new:

```tsx
      <button onClick={() => setMode('generate')}>go generate</button>
      <button onClick={() => setInput(`typing on ${label}`)}>type</button>
```

Append this `describe` after `describe('activeThreadId (#1361)', …)`:

```tsx
describe('identity-bound stream writers (#1361)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiFetchMock.mockResolvedValue([]);
  });

  /** A stream that yields once, then waits for the test to release it. */
  function gatedStream() {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    streamSSEMock.mockImplementation((_endpoint: string, _body: unknown, signal: AbortSignal) =>
      (async function* () {
        yield { content: 'partial answer' };
        await gate;
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        yield { content: ' and the rest' };
      })(),
    );
    return () => release();
  }

  it('drops the aborted answer when New chat replaced the thread that asked', async () => {
    // The whole reason writers bind to identity rather than key: `draft` still
    // exists after New chat, so a key-bound commit would land the abandoned
    // half-answer in the brand-new draft the user is looking at.
    const release = gatedStream();
    renderThreadApp('/ai');

    fireEvent.click(screen.getByText('stream'));
    await waitFor(() => expect(streamSSEMock).toHaveBeenCalled());

    fireEvent.click(screen.getByText('new conversation'));
    await act(async () => { release(); await Promise.resolve(); });

    expect(threadContents()).toEqual([]);
    expect(screen.getByTestId('conversation-id')).toHaveTextContent('none');
  });

  it('does not abort on a write to the thread that is already active', async () => {
    // A re-key and a write are both non-switches. This pins the write half;
    // the re-key half arrives with the promotion in the next task, which is
    // the first thing that can produce one.
    const release = gatedStream();
    renderThreadApp('/ai');

    fireEvent.click(screen.getByText('stream'));
    await waitFor(() => expect(streamSSEMock).toHaveBeenCalled());

    fireEvent.click(screen.getByText('type'));
    expect(screen.getByTestId('draft')).toHaveTextContent('typing on no page');

    await act(async () => { release(); await Promise.resolve(); });

    await waitFor(() => {
      expect(threadContents()).toEqual([
        'streamed question about no page',
        'partial answer and the rest',
      ]);
    });
  });

  it('names the thread whose answer is streaming, and clears it when the stream ends', async () => {
    const release = gatedStream();
    renderThreadApp('/ai', ['/pages/page-b', '/ai']);

    expect(screen.getByTestId('streaming-thread')).toHaveTextContent('none');

    fireEvent.click(screen.getByText('stream'));
    await waitFor(() => expect(streamSSEMock).toHaveBeenCalled());

    const streaming = screen.getByTestId('streaming-thread').textContent;
    expect(streaming).not.toBe('none');
    expect(streaming).toBe(screen.getByTestId('active-thread').textContent);

    // Switching does not move the marker: it still names the thread that asked,
    // which is what stops the other surface painting this partial answer into
    // whatever bubble happens to be last there.
    goTo('/pages/page-b');
    expect(screen.getByTestId('streaming-thread').textContent).toBe(streaming);
    expect(screen.getByTestId('active-thread').textContent).not.toBe(streaming);

    await act(async () => { release(); await Promise.resolve(); });
    await waitFor(() => {
      expect(screen.getByTestId('streaming-thread')).toHaveTextContent('none');
    });
  });

  it('aborts an in-flight stream when the active thread changes', async () => {
    // The abort effect keys on activeThreadId now, not on the key.
    const release = gatedStream();
    renderThreadApp('/ai', ['/pages/page-b', '/ai']);

    fireEvent.click(screen.getByText('stream'));
    await waitFor(() => expect(streamSSEMock).toHaveBeenCalled());

    goTo('/pages/page-b');
    await act(async () => { release(); await Promise.resolve(); });

    // The partial is committed to the thread that asked, and only there.
    expect(threadContents()).toEqual([]);
    goTo('/ai');
    await waitFor(() => {
      expect(threadContents()).toEqual([
        'streamed question about no page',
        'partial answer',
      ]);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/features/ai/AiContext.threads.test.tsx`
Expected: FAIL — `Property 'streamingThreadId' does not exist on type 'AiContextValue'`, and
`drops the aborted answer when New chat replaced the thread that asked` shows
`['streamed question about no page', 'partial answer']` (today's key-bound
commit lands the orphan in the fresh draft).

- [ ] **Step 3: Add the identity lookup and the identity-bound writer**

`frontend/src/features/ai/AiContext.tsx` — insert immediately after
`touchThread` (i.e. after the block Task 2 rewrote):

```tsx
/**
 * The key a given identity currently sits under, or undefined if the thread is
 * gone. A ≤ 12-entry scan: `MAX_RETAINED_THREADS` is the whole map, so an index
 * would be a second thing to keep in step for no measurable gain.
 */
function findThreadKeyByIdentity(
  threads: Map<string, AiThread>,
  identity: number,
): string | undefined {
  for (const [key, thread] of threads) {
    if (thread.identity === identity) return key;
  }
  return undefined;
}
```

In the provider, beside `updateThread` (`:407-412`) — old:

```tsx
  const updateThread = useCallback(
    (key: string, patch: (thread: AiThread) => Partial<AiThread>) => {
      setThreads((prev) => touchThread(prev, key, patch));
    },
    [],
  );
```

new:

```tsx
  const updateThread = useCallback(
    (key: string, patch: (thread: AiThread) => Partial<AiThread>) => {
      setThreads((prev) => touchThread(prev, key, patch));
    },
    [],
  );
  /**
   * Write to a thread by identity rather than key (#1361).
   *
   * A missing identity is a silent DROP, and that is the feature: it means the
   * thread that started this stream has been replaced (New chat) or evicted, so
   * there is nothing this write could correctly land on. Landing it on whatever
   * now holds the old key is the defect.
   */
  const updateThreadByIdentity = useCallback(
    (identity: number, patch: (thread: AiThread) => Partial<AiThread>) => {
      setThreads((prev) => {
        const key = findThreadKeyByIdentity(prev, identity);
        if (key === undefined) return prev;
        return touchThread(prev, key, patch);
      });
    },
    [],
  );
```

Add the two latest-value refs immediately after the filing effect Task 2 added:

```tsx
  // Through refs so `runStream` can read the map and the active key at CALL
  // time without taking `threads` as a dependency — which would rebuild it, and
  // every composer handler that depends on it, on each keystroke. Same pattern
  // and same reason as `EmbeddingShadowMigrationCard.tsx:89-90`.
  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  const threadKeyRef = useRef(threadKey);
  threadKeyRef.current = threadKey;
```

Add the streaming marker beside the other streaming state (after
`const [isStreaming, setIsStreaming] = useState(false);` at `:398`):

```tsx
  /**
   * Identity of the thread whose answer is in flight (#1361), or null.
   *
   * `streamingContent`, `isStreaming` and `isThinking` are one provider-wide
   * value each and cannot be bound to a thread, while both renderers decide
   * "this bubble is the in-flight answer" from `isStreaming && isLast`. Without
   * this marker, switching to a retained conversation mid-stream repaints ITS
   * last answer with the other thread's partial text.
   */
  const [streamingThreadId, setStreamingThreadId] = useState<string | null>(null);
```

- [ ] **Step 4: Key the abort effect on `activeThreadId`**

`frontend/src/features/ai/AiContext.tsx:493-503` — old:

```tsx
  // Changing the AI context page swaps threads (#1126) — it no longer clears
  // messages, conversation id or diff/diagram state, which is what silently
  // discarded an in-progress conversation on a sidebar click. The one thing a
  // switch still does is stop an in-flight stream; its partial answer is
  // committed to the thread that started it, not to the one being switched to,
  // because runStream captured that thread's writers.
  const prevThreadKeyRef = useRef(threadKey);
  useEffect(() => {
    if (threadKey === prevThreadKeyRef.current) return;
    prevThreadKeyRef.current = threadKey;
    abortRef.current?.abort();
  }, [threadKey]);
```

new:

```tsx
  // Changing which thread is on screen swaps threads (#1126) — it no longer
  // clears messages, conversation id or diff/diagram state, which is what
  // silently discarded an in-progress conversation on a sidebar click. The one
  // thing a switch still does is stop an in-flight stream; its partial answer
  // is committed to the thread that started it, located by identity, and
  // dropped if that thread is gone.
  //
  // Keyed on `activeThreadId`, not on the key (#1361). A RE-KEY is not a
  // switch: the first answer on a draft moves the same object to `conv:<id>`
  // and replaces the URL, and aborting the very stream that produced the id
  // would kill the answer mid-flight. The identity does not move, so this
  // effect does not fire.
  const prevActiveThreadIdRef = useRef(activeThreadId);
  useEffect(() => {
    if (activeThreadId === prevActiveThreadIdRef.current) return;
    prevActiveThreadIdRef.current = activeThreadId;
    abortRef.current?.abort();
  }, [activeThreadId]);
```

- [ ] **Step 5: Bind `runStream`'s writers to the origin identity**

`frontend/src/features/ai/AiContext.tsx` — five edits inside `runStream`, plus
its dependency list.

(a) the capture. Old:

```tsx
    if (isStreamingRef.current) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
```

new:

```tsx
    if (isStreamingRef.current) return;

    // Bind this stream to the thread that started it (#1361). The KEY is kept
    // for the fallback below; the IDENTITY is what every write dispatches on,
    // so a re-key is followed (the promotion moves the same object) and a
    // thread that has since been REPLACED — New chat while this stream was
    // running — is not found at all, so the write drops instead of landing an
    // orphan turn in the fresh draft.
    const originKey = threadKeyRef.current;
    const originIdentity = threadsRef.current.get(originKey)?.identity ?? 0;
    // 0 means the active key was not filed yet — reachable only in the render
    // before the filing effect runs, i.e. before anyone could have clicked.
    // Fall back to a key-bound write rather than dispatching on an identity no
    // entry carries, which would silently drop the entire answer.
    const writeOrigin = (patch: (thread: AiThread) => Partial<AiThread>) => {
      if (originIdentity === 0) updateThread(originKey, patch);
      else updateThreadByIdentity(originIdentity, patch);
    };
    const setThreadMessages = (action: React.SetStateAction<Message[]>) =>
      writeOrigin((thread) => ({
        messages: typeof action === 'function' ? action(thread.messages) : action,
      }));

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
```

(b) the seeded user turn and the streaming marker. Old:

```tsx
    const seededUserMessage = opts?.userMessage;
    const seededUserMsgId = seededUserMessage ? nextMessageId() : null;
    if (seededUserMessage && seededUserMsgId) {
      setMessages((prev) => [...prev, { id: seededUserMsgId, role: 'user', content: seededUserMessage }]);
    }

    opts?.onBeforeStream?.();
    isStreamingRef.current = true;
    setIsStreaming(true);
    setIsThinking(true);
```

new:

```tsx
    const seededUserMessage = opts?.userMessage;
    const seededUserMsgId = seededUserMessage ? nextMessageId() : null;
    if (seededUserMessage && seededUserMsgId) {
      setThreadMessages((prev) => [...prev, { id: seededUserMsgId, role: 'user', content: seededUserMessage }]);
    }

    opts?.onBeforeStream?.();
    isStreamingRef.current = true;
    setIsStreaming(true);
    setIsThinking(true);
    // Mirrors `activeThreadId`'s own fallback: the bare key in the one render
    // window where the thread is not filed yet, so the two can still compare
    // equal and the renderers do not blank the typing indicator.
    setStreamingThreadId(originIdentity === 0 ? originKey : String(originIdentity));
```

(c) the placeholder, the commit and the failure. Old:

```tsx
    const assistantMsgId = nextMessageId();
    setMessages((prev) => [...prev, { id: assistantMsgId, role: 'assistant', content: '' }]);
    streamingStart();
```

new:

```tsx
    const assistantMsgId = nextMessageId();
    setThreadMessages((prev) => [...prev, { id: assistantMsgId, role: 'assistant', content: '' }]);
    streamingStart();
```

Old:

```tsx
    const commitToMessages = () => {
      setMessages((prev) => {
```

new:

```tsx
    const commitToMessages = () => {
      setThreadMessages((prev) => {
```

Old:

```tsx
    const failLastMessage = (text: string) => {
      setMessages((prev) => {
```

new:

```tsx
    const failLastMessage = (text: string) => {
      setThreadMessages((prev) => {
```

(d) the conversation id off the frame, and the caller's rollback. Old:

```tsx
        if (chunk.conversationId) {
          setConversationId(chunk.conversationId);
        }
```

new:

```tsx
        if (chunk.conversationId) {
          const id = chunk.conversationId;
          writeOrigin(() => ({ conversationId: id }));
        }
```

Old:

```tsx
      if (opts?.onError?.(err)) {
        setMessages((prev) => prev.filter(
          (m) => m.id !== assistantMsgId && m.id !== seededUserMsgId,
        ));
        return;
      }
```

new:

```tsx
      if (opts?.onError?.(err)) {
        setThreadMessages((prev) => prev.filter(
          (m) => m.id !== assistantMsgId && m.id !== seededUserMsgId,
        ));
        return;
      }
```

(e) the `finally` and the dependency list. Old:

```tsx
    } finally {
      streamingFinish();
      isStreamingRef.current = false;
      setIsStreaming(false);
      setIsThinking(false);
    }
  }, [streamingStart, streamingAppend, streamingReplace, streamingFinish, setMessages, setConversationId]);
```

new:

```tsx
    } finally {
      streamingFinish();
      isStreamingRef.current = false;
      setIsStreaming(false);
      setIsThinking(false);
      setStreamingThreadId(null);
    }
  }, [streamingStart, streamingAppend, streamingReplace, streamingFinish, updateThread, updateThreadByIdentity]);
```

`setMessages` and `setConversationId` leave the dependency list because
`runStream` no longer calls them — they are the ACTIVE thread's writers, and
that is precisely what a stream must not use. They remain on the context for
every other caller.

Finally, expose the marker. `AiContextValue` — old:

```tsx
  isStreaming: boolean;
  setIsStreaming: (v: boolean) => void;
```

new:

```tsx
  isStreaming: boolean;
  setIsStreaming: (v: boolean) => void;
  /**
   * Identity of the thread whose answer is streaming, or null (#1361).
   * `isStreaming` is provider-wide; the two renderers gate "this bubble is the
   * in-flight answer" on `streamingThreadId === activeThreadId` so a stream on
   * one thread cannot repaint another thread's last answer.
   */
  streamingThreadId: string | null;
```

and in the value object — old:

```tsx
    isStreaming,
    setIsStreaming,
```

new:

```tsx
    isStreaming,
    setIsStreaming,
    streamingThreadId,
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/features/ai/AiContext.threads.test.tsx`
Expected: PASS — 26 cases.

- [ ] **Step 7: Write the failing renderer test for `/ai`**

In `frontend/src/features/ai/AiAssistantPage.test.tsx`, widen the router import
— old:

```tsx
import { MemoryRouter, useLocation } from 'react-router-dom';
```

new:

```tsx
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
```

and append this `describe` before the file's final `});`:

```tsx
  describe('cross-thread streaming (#1361)', () => {
    /** Navigates the hoisted provider, which is what changes the thread. */
    function AiNavProbe({ to }: { to: string }) {
      const navigate = useNavigate();
      return <button onClick={() => navigate(to)}>{`go ${to}`}</button>;
    }

    /** Puts a finished answer on one thread and starts a stream on another. */
    function ThreadTools() {
      const { setMessages, runStream } = useAiContext();
      return (
        <>
          <button
            onClick={() =>
              setMessages([
                { id: 'seed-user', role: 'user', content: 'what changed in the runbook?' },
                { id: 'seed-answer', role: 'assistant', content: 'answer one' },
              ])
            }
          >
            seed answered thread
          </button>
          <button onClick={() => void runStream('/llm/ask', { question: 'about the article' })}>
            ask here
          </button>
        </>
      );
    }

    it("does not paint another thread's in-flight answer onto this one", async () => {
      apiFetchMock.mockImplementation((path: string) => {
        if (path === '/llm/usecase-default?usecase=chat') {
          return Promise.resolve({
            usecase: 'chat', providerId: 'p1', providerName: 'Local', model: 'llama3', vision: false,
          });
        }
        if (path.startsWith('/ollama/models')) return Promise.resolve([{ name: 'llama3' }]);
        return Promise.resolve([]);
      });
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => { release = resolve; });
      streamSSEMock.mockImplementation((_endpoint: string, _body: unknown, signal: AbortSignal) =>
        (async function* () {
          yield { content: 'partial from the other thread' };
          await gate;
          if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        })(),
      );

      render(
        <>
          <ThreadTools />
          <AiNavProbe to="/pages/p9" />
          <AiNavProbe to="/ai" />
          <AiAssistantPage />
        </>,
        { wrapper: createWrapper(['/ai']) },
      );

      // The draft already holds a finished answer.
      fireEvent.click(screen.getByText('seed answered thread'));
      expect(screen.getByText('answer one')).toBeInTheDocument();

      // Ask on the article thread, then come back to the draft mid-stream.
      fireEvent.click(screen.getByText('go /pages/p9'));
      fireEvent.click(screen.getByText('ask here'));
      await waitFor(() => expect(streamSSEMock).toHaveBeenCalled());
      fireEvent.click(screen.getByText('go /ai'));

      // Its own last answer, not the other thread's partial text — and it is
      // not "typing", because nothing here is.
      await waitFor(() => expect(screen.getByText('answer one')).toBeInTheDocument());
      expect(screen.queryByText('partial from the other thread')).not.toBeInTheDocument();
      expect(screen.queryByTestId('typing-indicator')).not.toBeInTheDocument();

      await act(async () => { release(); await Promise.resolve(); });
    });
  });
```

- [ ] **Step 8: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/features/ai/AiAssistantPage.test.tsx -t "does not paint"`
Expected: FAIL — `Unable to find an element with the text: answer one`. The draft's
last bubble is an assistant turn and `isStreaming` is provider-wide true, so
`MessageBubble` renders the other thread's buffer (or, before the first rAF
flush, an empty `StreamingMessage`) in its place.

- [ ] **Step 9: Gate the `/ai` bubble on the streaming thread**

`frontend/src/features/ai/AiAssistantPage.tsx:216-224` — old:

```tsx
  const {
    mode, page, pageHasChildren,
    messages, messagesEndRef, isStreaming, isThinking, thinkingElapsed,
    streamingContent,
    model, models, setModel, modelsError, refetchModels, isLight,
    includeSubPages, setIncludeSubPages,
    thinkingMode, setThinkingMode,
    embeddingStatus,
  } = ctx;
```

new:

```tsx
  const {
    mode, page, pageHasChildren,
    messages, messagesEndRef, isStreaming, isThinking, thinkingElapsed,
    streamingContent, streamingThreadId, activeThreadId,
    model, models, setModel, modelsError, refetchModels, isLight,
    includeSubPages, setIncludeSubPages,
    thinkingMode, setThinkingMode,
    embeddingStatus,
  } = ctx;

  // #1361: `isStreaming` / `isThinking` / `streamingContent` are one
  // provider-wide value each, and this renderer decides "the last bubble is the
  // in-flight answer" from `isStreaming && isLast`. A question asked on another
  // thread — the dock on an article, or a conversation left running — would
  // therefore repaint THIS thread's last answer with that thread's partial
  // text. `streamingThreadId` is the identity of the thread that asked.
  //
  // Only the message bubbles are gated. The announcer, the composer's disabled
  // state and the Stop control stay provider-wide: a stream really is running.
  const streamingHere = isStreaming && streamingThreadId === activeThreadId;
  const thinkingHere = isThinking && streamingThreadId === activeThreadId;
```

`:520-534` — old:

```tsx
            <MessageBubble
              key={msg.id}
              msg={msg}
              index={i}
              isLast={i === messages.length - 1}
              isStreaming={isStreaming}
              isThinking={isThinking}
              thinkingElapsed={thinkingElapsed}
```

new:

```tsx
            <MessageBubble
              key={msg.id}
              msg={msg}
              index={i}
              isLast={i === messages.length - 1}
              isStreaming={streamingHere}
              isThinking={thinkingHere}
              thinkingElapsed={thinkingElapsed}
```

and, on the same element — old:

```tsx
              streamingContent={i === messages.length - 1 ? streamingContent : undefined}
```

new:

```tsx
              streamingContent={
                streamingHere && i === messages.length - 1 ? streamingContent : undefined
              }
```

- [ ] **Step 10: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/features/ai/AiAssistantPage.test.tsx`
Expected: PASS (whole file).

- [ ] **Step 11: Write the failing dock test**

`frontend/src/features/ai/dock/AiDock.test.tsx` — widen two imports. Old:

```tsx
import { MemoryRouter, Routes, Route } from 'react-router-dom';
```

new:

```tsx
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
```

Old:

```tsx
import { AiProvider } from '../AiContext';
```

new:

```tsx
import { AiProvider, useAiContext } from '../AiContext';
```

Add the probe above `renderDock`:

```tsx
/**
 * Reaches the hoisted provider the way a sibling surface would, so a test can
 * put a finished answer on one page's thread and a running stream on another —
 * the only way to observe which thread the in-flight bubble belongs to (#1361).
 */
function DockThreadTools() {
  const navigate = useNavigate();
  const { setMessages, runStream } = useAiContext();
  return (
    <>
      <button
        data-testid="dock-seed-answer"
        onClick={() =>
          setMessages([
            { id: 'seed-user', role: 'user', content: 'what changed here?' },
            { id: 'seed-answer', role: 'assistant', content: 'answer one' },
          ])
        }
      >
        seed
      </button>
      <button data-testid="dock-ask-here" onClick={() => void runStream('/llm/ask', { question: 'q' })}>
        ask
      </button>
      <button data-testid="dock-go-page-2" onClick={() => navigate('/pages/page-2')}>page 2</button>
      <button data-testid="dock-go-page-1" onClick={() => navigate('/pages/page-1')}>page 1</button>
    </>
  );
}
```

and mount it in `renderDock` — old:

```tsx
          <AiProvider>
            <button data-testid="dock-trigger">AI Assistant</button>
            <Routes>
              <Route path="/pages/:id" element={<div>article</div>} />
              <Route path="/ai" element={<div>ai page</div>} />
            </Routes>
```

new:

```tsx
          <AiProvider>
            <button data-testid="dock-trigger">AI Assistant</button>
            <DockThreadTools />
            <Routes>
              <Route path="/pages/:id" element={<div>article</div>} />
              <Route path="/ai" element={<div>ai page</div>} />
            </Routes>
```

Append the case inside `describe('AiDock (#1126)', …)`:

```tsx
  it("does not paint another page's in-flight answer onto this thread (#1361)", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    streamSSEMock.mockImplementation((_endpoint: string, _body: unknown, signal: AbortSignal) =>
      (async function* () {
        yield { content: 'partial from the other page' };
        await gate;
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      })(),
    );

    renderDock();
    await openAndSettle();

    fireEvent.click(screen.getByTestId('dock-seed-answer'));
    expect(await screen.findByText('answer one')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('dock-go-page-2'));
    fireEvent.click(screen.getByTestId('dock-ask-here'));
    await waitFor(() => expect(streamSSEMock).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId('dock-go-page-1'));

    expect(await screen.findByText('answer one')).toBeInTheDocument();
    expect(screen.queryByText('partial from the other page')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ai-dock-typing')).not.toBeInTheDocument();

    await act(async () => { release(); await Promise.resolve(); });
  });
```

- [ ] **Step 12: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/features/ai/dock/AiDock.test.tsx -t "does not paint"`
Expected: FAIL — `Unable to find an element with the text: answer one`; `DockMessage`
reads the provider-wide flags exactly as `MessageBubble` did.

- [ ] **Step 13: Gate the dock bubble on the streaming thread**

`frontend/src/features/ai/dock/DockPanel.tsx:93-97` — old:

```tsx
  const {
    page, pageId, messages, messagesEndRef, isStreaming, isThinking, thinkingElapsed,
    streamingContent, input, setInput, modelsError, refetchModels, model, chatVision,
    chatVisionModel, mode, setMode, improvementType, abortRef,
  } = useAiContext();
```

new:

```tsx
  const {
    page, pageId, messages, messagesEndRef, isStreaming, isThinking, thinkingElapsed,
    streamingContent, streamingThreadId, activeThreadId, input, setInput, modelsError,
    refetchModels, model, chatVision, chatVisionModel, mode, setMode, improvementType, abortRef,
  } = useAiContext();

  // #1361: the streaming buffer and both busy flags are provider-wide, and this
  // renderer decides "the last bubble is the in-flight answer" from
  // `isStreaming && isLast` — so a question asked on `/ai`, or on another
  // article, would repaint this page's last answer with that thread's partial
  // text. Only the turns are gated; the violet hairline, the disabled composer
  // and Stop stay provider-wide, because a stream really is running.
  const streamingHere = isStreaming && streamingThreadId === activeThreadId;
  const thinkingHere = isThinking && streamingThreadId === activeThreadId;
```

`:322-331` — old:

```tsx
              <DockMessage
                key={msg.id}
                msg={msg}
                isLast={i === messages.length - 1}
                isStreaming={isStreaming}
                isThinking={isThinking}
                thinkingElapsed={thinkingElapsed}
                streamingContent={i === messages.length - 1 ? streamingContent : undefined}
              />
```

new:

```tsx
              <DockMessage
                key={msg.id}
                msg={msg}
                isLast={i === messages.length - 1}
                isStreaming={streamingHere}
                isThinking={thinkingHere}
                thinkingElapsed={thinkingElapsed}
                streamingContent={
                  streamingHere && i === messages.length - 1 ? streamingContent : undefined
                }
              />
```

- [ ] **Step 14: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/features/ai/dock`
Expected: PASS — all six dock suites.

- [ ] **Step 15: Run the guard suites and the whole frontend suite**

Run:
```bash
cd frontend && npx vitest run src/ai-scroll-chain.test.ts src/scroll-padding-mask.test.ts src/flat-components.test.ts src/ui-text-legibility.test.ts
cd frontend && npx vitest run
cd frontend && npx tsc --noEmit
cd frontend && npm run lint
```
Expected: all green.

- [ ] **Step 16: Commit**

```bash
cd /Users/simon/Documents/localGIT/compendiq-ce-wt-1361-design
git add frontend/src/features/ai/AiContext.tsx \
        frontend/src/features/ai/AiContext.threads.test.tsx \
        frontend/src/features/ai/AiAssistantPage.tsx \
        frontend/src/features/ai/AiAssistantPage.test.tsx \
        frontend/src/features/ai/dock/DockPanel.tsx \
        frontend/src/features/ai/dock/AiDock.test.tsx
git commit -m "fix(ai): bind stream writers to thread identity, gate the in-flight bubble

runStream captures the identity of the thread that asked and dispatches every
write on it, so a re-key is followed and a replaced thread drops the write
instead of landing an orphan turn in the fresh draft. The abort effect keys on
activeThreadId, which a re-key does not move. streamingThreadId lets both
renderers tell their own in-flight answer from another thread's, which the
provider-wide streaming buffer cannot.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: The state machine — promotion, stale 404, the `conversationId: null` frame, the mirror rule, `purgeConversation`

Implements the spec's *The state machine* table (`docs/superpowers/specs/2026-08-17-ai-conversation-history-design.md`, the rows **Ask on an AI-route thread with no `conversationId`**, **Ask on `conv:<id>`**, **Ask on `page:<id>`**, **Delete succeeds**, **Ask returns 404 (stale id)**, **Final frame carries `conversationId: null`**, **A completed exchange on a thread with id `C`**) plus *Invalidation*.

> **Anchor note.** Every `old →` block below is quoted as **Tasks 2 and 3 leave the file**. Where Task 2/3 already rewrote the quoted line the paragraph above the block says so. Two facts from Tasks 2–3 this task builds on, both from the plan's shared-interface block: `runStream` has captured `originKey`, `originIdentity` and `originHadId` before the fetch, and it binds its four writers (`setMessages`, `setConversationId`, `commitToMessages`, `failLastMessage`) to `originIdentity` **by shadowing** — i.e. `runStream` declares its own `const setMessages = …` / `const setConversationId = …` inside its body, so every call site *inside* `runStream` (including the two closures) is textually unchanged from today. If Task 3 bound them under different local names, this task's edits are the same statements with that writer renamed; nothing else moves.

**Pinned here** (decisions the spec leaves to the implementer):

- **"a `conversationId` in the body" is the REQUEST body.** `streamSSE` throws `new ApiError(res.status, errorBody.message ?? …)` (`shared/lib/sse.ts:42-47`) — an `ApiError` carries a status and a message and never the response payload. The only place the client holds the id this 404 is about is `runStream`'s own `body` argument, so the guard is `typeof body.conversationId === 'string'`. A 404 from any other route, or an ask that carried no id, is left to the existing inline-error path.
- **The mismatch guard is applied at the frame read, not after the commit.** A frame naming a different row is never written to the thread at all, so `frameConversationId` stays `undefined` and the exchange promotes nothing, mirrors nothing and invalidates nothing. Adopting it and then undoing it would flash the wrong id through `conversationId`, which `AskMode` reads into the next request body.
- **Invalidation is gated on `frameConversationId !== undefined`.** That is exactly "this stream was `/llm/ask`": Improve, Generate, Diagram and Summarize emit no `conversationId` frame, and a `page:` thread that happens to carry an id from an earlier dock ask must not refetch the list every time someone runs Improve on that page.
- **The mirror is gated on `typeof frameConversationId === 'string'`.** A `null` frame means the row is gone — there is nothing to keep two views of — and a non-ask stream was never saved to the conversation at all.
- **The two mirror message ids are minted before the state updater.** React may invoke an updater twice; an updater that calls `nextMessageId()` is not pure. Two ids is the whole mirror (the pair is at most `(user, assistant)`), and reusing the same two across two target threads is correct because a message id only has to be unique inside its own list.
- **`setThreads` and `navigate` are queued in the same synchronous block** so React batches them into one render. That is what keeps `activeThreadId` from dipping through the fresh draft's identity between the re-key and the URL landing — a dip would fire the abort effect and clear both composers. The test *the promotion leaves `activeThreadId` unchanged* is what pins it.

**Files:**
- Modify: `frontend/src/features/ai/AiContext.tsx` (`StreamChunk` `:214-232`; `touchThread`'s eviction loop `:322-334`; new module helper `trimThreads`; new provider callbacks `completeExchange` / `purgeConversation` + `activeKeyRef`; `runStream` `:869-872`, `:903-916`, `:940-946`; the value object `:963-…`)
- Test: `frontend/src/features/ai/AiContext.threads.test.tsx`

**Interfaces:**
- Consumes (Task 1): `AI_HOME_PATH`, `conversationPath(id)`, `conversationIdFromPath(pathname)` from `shared/lib/ai-routes`. (Task 2): `AiThread` with `identity` / `loadState` / `loadError` / `historyTruncated`, `seedFor(key)`, `nextIdentity()`, `threadKey`, `updateThread(key, patch)`, `MAX_RETAINED_THREADS`. (Task 3): `updateThreadByIdentity(identity, patch)`, `findThreadKeyByIdentity(threads, identity)`, `rekeyThread(prev, fromKey, toKey)`, and `runStream`'s `originKey` / `originIdentity` / `originHadId`.
- Produces: `purgeConversation: (id: string) => void` on `AiContextValue` (Task 9's `useDeleteConversation` calls it; Task 12/13 mount the pane that triggers it); `StreamChunk.conversationId: string | null`; module-private `trimThreads(map)` and `completeExchange(args)`; `activeKeyRef`. Task 5 extends `completeExchange`'s argument object with `historyTruncated`.

---

- [ ] **Step 1: Write the failing tests for promotion, the dock row and the abort row**

Append a new top-level `describe` to `frontend/src/features/ai/AiContext.threads.test.tsx`, after the existing `describe('resolveAiPageId', …)` block. It brings its own probe and render helper: these cells read fields (`activeThreadId`, later `threadLoadState`, `historyTruncated`) and drive actions (`purgeConversation`, an ask that carries the thread's own id) that the #1126 retention cells have no use for, and the two sets of assertions fail for different reasons.

Also add `ApiError` to the file's imports — the module is mocked with `apiModuleMock`, which spreads the real module, so this is the real class `runStream` branches on:

```tsx
// old (top of file, after the react-router import)
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AiProvider, useAiContext, nextMessageId, resolveAiPageId } from './AiContext';

// new
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from '../../shared/lib/api';
import { AiProvider, useAiContext, nextMessageId, resolveAiPageId } from './AiContext';
```

```tsx
// ---------------------------------------------------------------------------
// #1361 — the conversation state machine
// ---------------------------------------------------------------------------

/**
 * Reads the state-machine surface of the context and drives the four gestures
 * the table's rows are about: an ask that carries the thread's own id (what
 * `AskMode` builds), a typed draft, a claimed id (what a dock answer leaves
 * behind), and a delete.
 *
 * Deliberately a second probe rather than a grown `ThreadProbe`: the #1126
 * cells above are about retention across page changes and fail for entirely
 * different reasons than these do.
 */
function StateProbe() {
  const {
    messages, conversationId, input, mode, model, activeThreadId,
    setInput, setConversationId, purgeConversation, runStream,
  } = useAiContext();
  const navigate = useNavigate();

  return (
    <div>
      <span data-testid="conversation-id">{conversationId ?? 'none'}</span>
      <span data-testid="active-thread-id">{activeThreadId}</span>
      <span data-testid="draft">{input}</span>
      <span data-testid="mode">{mode}</span>
      <span data-testid="model">{model}</span>
      <ul data-testid="thread">
        {messages.map((msg) => (
          <li
            key={msg.id}
            data-refusal={msg.isRefusal ? 'yes' : 'no'}
            data-error={msg.isError ? 'yes' : 'no'}
          >
            {msg.content}
          </li>
        ))}
      </ul>
      <button
        onClick={() =>
          runStream(
            '/llm/ask',
            { question: 'q', conversationId: conversationId ?? undefined },
            { userMessage: 'q' },
          )
        }
      >
        ask
      </button>
      <button onClick={() => setInput('half-typed question')}>type</button>
      <button onClick={() => setConversationId('c-1')}>claim c-1</button>
      <button onClick={() => purgeConversation('c-1')}>purge c-1</button>
      <button onClick={() => navigate(-1)}>back</button>
      <button onClick={() => navigate(1)}>forward</button>
    </div>
  );
}

function renderStateApp(initialEntry: string, destinations: string[] = []) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <AiProvider>
          <LocationDisplay />
          {destinations.map((to) => (
            <NavButton key={to} to={to} />
          ))}
          <Routes>
            <Route path="/ai" element={<StateProbe />} />
            <Route path="/ai/c/:conversationId" element={<StateProbe />} />
            <Route path="/pages/:id" element={<StateProbe />} />
          </Routes>
        </AiProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, queryClient, invalidate };
}

/** An /llm/ask stream whose final frame carries `id`. */
function askStreamReturning(id: string | null, answer = 'the answer') {
  return async function* fakeStream() {
    yield { content: answer };
    yield { done: true, final: true, conversationId: id, sources: [] };
  };
}

describe('AiContext conversation state machine (#1361)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/llm/usecase-default?usecase=chat') {
        return Promise.resolve({ model: 'llama3', vision: null });
      }
      if (path.startsWith('/ollama/models')) return Promise.resolve([{ name: 'llama3' }]);
      return Promise.resolve([]);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('promotes the first answer on /ai: re-keys the draft, replaces the URL, files a fresh draft', async () => {
    streamSSEMock.mockImplementation(askStreamReturning('c-1'));
    const { invalidate } = renderStateApp('/ai', ['/ai']);

    fireEvent.click(screen.getByText('ask'));

    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent('/ai/c/c-1');
    });
    expect(screen.getByTestId('conversation-id')).toHaveTextContent('c-1');
    expect(threadContents()).toEqual(['q', 'the answer']);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['llm', 'conversations'] });

    // A fresh draft was filed under `draft`, so /ai is a new chat again rather
    // than a second view of the conversation that just grew out of it.
    goTo('/ai');
    expect(threadContents()).toEqual([]);
    expect(screen.getByTestId('conversation-id')).toHaveTextContent('none');
  });

  it('leaves activeThreadId unchanged across the promotion', async () => {
    streamSSEMock.mockImplementation(askStreamReturning('c-1'));
    renderStateApp('/ai');

    const before = screen.getByTestId('active-thread-id').textContent;
    expect(before).toBeTruthy();

    fireEvent.click(screen.getByText('ask'));
    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent('/ai/c/c-1');
    });

    // A re-key is not a switch: the same object moved keys, so every
    // switch-sensitive effect (abort, Deep Search, attachments) must sit still.
    // This also pins that the map write and the navigation land in ONE render —
    // an unbatched pair would show the fresh draft's identity in between.
    expect(screen.getByTestId('active-thread-id')).toHaveTextContent(before!);
  });

  it('does not promote a first answer that was stopped', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    streamSSEMock.mockImplementation((_endpoint: string, _body: unknown, signal: AbortSignal) =>
      (async function* () {
        yield { content: 'partial' };
        await gate;
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        yield { done: true, final: true, conversationId: 'c-1', sources: [] };
      })(),
    );

    const { invalidate } = renderStateApp('/ai', ['/pages/p1', '/ai']);
    fireEvent.click(screen.getByText('ask'));
    await waitFor(() => expect(streamSSEMock).toHaveBeenCalled());

    goTo('/pages/p1');
    await act(async () => { release(); await Promise.resolve(); });

    goTo('/ai');
    // Decision 9: the partial stays under the origin key with no id, and the
    // URL never became a conversation URL.
    expect(screen.getByTestId('location')).toHaveTextContent('/ai');
    expect(screen.getByTestId('location').textContent).not.toContain('/ai/c/');
    expect(screen.getByTestId('conversation-id')).toHaveTextContent('none');
    expect(threadContents()).toEqual(['q', 'partial']);
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['llm', 'conversations'] });
  });

  it('re-keys but does not navigate when a completion outruns its own abort', async () => {
    // The `activeKeyRef` guard is belt-and-braces behind the abort effect, so
    // this is the synthetic race that reaches it: a stream that ignores its
    // signal and finishes after the user has already moved. The thread is
    // still promoted (the answer is real and the server saved it); the user is
    // not dragged back to it.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    streamSSEMock.mockImplementation(() =>
      (async function* () {
        yield { content: 'the answer' };
        await gate;
        yield { done: true, final: true, conversationId: 'c-1', sources: [] };
      })(),
    );

    renderStateApp('/ai', ['/pages/p1', '/ai/c/c-1']);
    fireEvent.click(screen.getByText('ask'));
    await waitFor(() => expect(streamSSEMock).toHaveBeenCalled());

    goTo('/pages/p1');
    await act(async () => { release(); await Promise.resolve(); });

    expect(screen.getByTestId('location')).toHaveTextContent('/pages/p1');
    goTo('/ai/c/c-1');
    await waitFor(() => {
      expect(threadContents()).toEqual(['q', 'the answer']);
    });
    expect(screen.getByTestId('conversation-id')).toHaveTextContent('c-1');
  });

  it('sets the id on a fresh page: thread without re-keying or navigating', async () => {
    streamSSEMock.mockImplementation(askStreamReturning('c-dock', 'dock answer'));
    const { invalidate } = renderStateApp('/pages/p1', ['/ai']);

    fireEvent.click(screen.getByText('ask'));
    await waitFor(() => {
      expect(screen.getByTestId('conversation-id')).toHaveTextContent('c-dock');
    });

    // `runStream` is shared by both surfaces; without the key half of the
    // promotion guard the dock's first answer would re-key its thread out from
    // under /pages/p1 and teleport the user to /ai.
    expect(screen.getByTestId('location')).toHaveTextContent('/pages/p1');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['llm', 'conversations'] });

    goTo('/ai');
    expect(threadContents()).toEqual([]);
    expect(screen.getByTestId('conversation-id')).toHaveTextContent('none');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/features/ai/AiContext.threads.test.tsx`

Expected: FAIL — `purgeConversation` is not on the context (`TypeError: purgeConversation is not a function` when `StateProbe` renders its button handler is created; the property is `undefined` in the destructure), and the promotion cells fail with `expected element to have text content /ai/c/c-1, received /ai` because nothing re-keys or navigates.

- [ ] **Step 3: Widen `StreamChunk.conversationId` and add the eviction helper**

`frontend/src/features/ai/AiContext.tsx` — the `StreamChunk` field (`:220`):

```ts
// old
  conversationId?: string;

// new
  /**
   * #1361: `string | null`. The ask route's final frame is
   * `conversationId: convId ?? null` (`llm-ask.ts`), and `null` is a fact, not
   * an absence — the append hit zero rows because the conversation was deleted
   * in another tab while the answer was streaming. Absent (`undefined`) still
   * means "this stream is not about a conversation at all", which is every
   * other `/llm/*` route.
   */
  conversationId?: string | null;
```

Add `trimThreads` immediately above `touchThread` (after the `MAX_RETAINED_THREADS` doc comment block, `:322`):

```ts
/**
 * Evict least-recently-used entries down to the cap, in place. A Map iterates
 * in insertion order, so the first key is always the oldest touch.
 *
 * Extracted because the promotion (#1361) files a fresh `draft` beside the
 * thread it just re-keyed and can therefore push the map one over the cap —
 * a second copy of this loop is how the two would drift.
 */
function trimThreads(threads: Map<string, AiThread>): Map<string, AiThread> {
  while (threads.size > MAX_RETAINED_THREADS) {
    const oldest = threads.keys().next().value;
    if (oldest === undefined) break;
    threads.delete(oldest);
  }
  return threads;
}
```

and collapse `touchThread`'s tail onto it (this is the one part of `touchThread` Task 2 does not rewrite):

```ts
// old
  while (next.size > MAX_RETAINED_THREADS) {
    const oldest = next.keys().next().value;
    if (oldest === undefined) break;
    next.delete(oldest);
  }
  return next;
}

// new
  return trimThreads(next);
}
```

- [ ] **Step 4: Add `activeKeyRef`, `completeExchange` and `purgeConversation` to the provider**

Task 2 already imports `AI_HOME_PATH`, `isAiRoute` and `conversationIdFromPath` from
`../../shared/lib/ai-routes`; the one name this task adds is `conversationPath` — amend that
existing line (never add a second import of the module, which is a TS2300 duplicate under
`--max-warnings=0`):

```ts
// old (as Task 2 leaves it)
import { AI_HOME_PATH, isAiRoute, conversationIdFromPath } from '../../shared/lib/ai-routes';

// new
import { AI_HOME_PATH, isAiRoute, conversationIdFromPath, conversationPath } from '../../shared/lib/ai-routes';
```

Insert the following immediately after the `startNewConversation` callback (Task 2 rewrote that callback; this block goes directly below it, where today's `loadConversation` / `deleteConversation` used to sit — Task 2 deleted both):

```tsx
  /**
   * The LIVE active thread key, for callbacks captured before a navigation.
   *
   * The promotion has to answer "is the thread I started in still the one on
   * screen?". A `threadKey` captured when the stream started answers "was it,
   * when I started" — always yes — and would drag a user who navigated away
   * mid-answer back onto the promoted conversation.
   */
  const activeKeyRef = useRef(threadKey);
  useEffect(() => {
    activeKeyRef.current = threadKey;
  }, [threadKey]);

  /**
   * Everything that happens once a completed exchange lands: the three
   * post-commit rows of #1361's state machine, plus list invalidation.
   *
   * One `setThreads` pass, so a promotion and the mirror can never be observed
   * half-applied — and `navigate` is queued in the same synchronous block, so
   * React batches the map write and the URL change into ONE render. That is
   * what keeps `activeThreadId` from dipping through the fresh draft's
   * identity between the re-key and the URL landing; a dip would fire the
   * abort effect and clear both composers on a promotion, which is a re-key
   * and explicitly not a switch.
   */
  const completeExchange = useCallback((args: {
    originKey: string;
    originIdentity: number;
    originHadId: boolean;
    assistantMsgId: string;
    frameConversationId: string | null | undefined;
  }) => {
    const { originKey, originIdentity, originHadId, assistantMsgId, frameConversationId } = args;

    // Nothing on this stream concerns conversations: Improve, Generate,
    // Diagram and Summarize emit no `conversationId` frame at all. Returning
    // here is also what keeps an Improve run on a page thread that happens to
    // carry an id from refetching the conversation list.
    if (frameConversationId === undefined) return;

    // Promotion guard, both halves. The key half is what stops the dock: a
    // `page:` origin never promotes, never re-keys and never navigates. The
    // id half is what stops a follow-up: only a thread that had NO id when the
    // stream started is a conversation being born.
    const promotedId =
      typeof frameConversationId === 'string'
      && !originHadId
      && (originKey === 'draft' || originKey.startsWith('conv:'))
        ? frameConversationId
        : null;

    // Minted OUTSIDE the updater: React may invoke a state updater twice, and
    // an updater that allocates ids is not pure. Two is the whole mirror — the
    // pair is at most (user, assistant) — and reusing them across two target
    // threads is correct, because a message id only has to be unique inside
    // its own list.
    const mirrorUserId = nextMessageId();
    const mirrorAssistantId = nextMessageId();
    const freshDraftIdentity = promotedId !== null && originKey === 'draft' ? nextIdentity() : 0;

    setThreads((prev) => {
      const fromKey = findThreadKeyByIdentity(prev, originIdentity);
      // The thread that asked has been replaced (New chat while its stream was
      // running). Its content write was dropped upstream; so is this.
      if (fromKey === undefined) return prev;
      const origin = prev.get(fromKey)!;

      // The mirror pair. Only a SAVED exchange mirrors: a `null` frame means
      // the row is gone, so there is no second view of it to keep in step.
      const pair: Message[] = [];
      if (typeof frameConversationId === 'string') {
        const at = origin.messages.findIndex((msg) => msg.id === assistantMsgId);
        if (at >= 0) {
          const before = origin.messages[at - 1];
          if (before && before.role === 'user') pair.push({ ...before, id: mirrorUserId });
          pair.push({ ...origin.messages[at]!, id: mirrorAssistantId });
        }
      }
      const mirrorTargets = pair.length > 0
        ? Array.from(prev).filter(([, thread]) =>
            thread.identity !== originIdentity && thread.conversationId === frameConversationId)
        : [];

      if (promotedId === null && mirrorTargets.length === 0) return prev;

      let next = new Map(prev);
      if (promotedId !== null) {
        next = rekeyThread(next, fromKey, `conv:${promotedId}`);
        if (fromKey === 'draft') {
          // Exactly one draft exists. The promoted object took its content
          // with it, so the draft slot is re-seeded with a fresh identity —
          // which is what makes /ai a new chat again.
          next.set('draft', { ...seedFor('draft'), identity: freshDraftIdentity });
          next = trimThreads(next);
        }
      }
      for (const [key] of mirrorTargets) {
        const thread = next.get(key);
        // Evicted by the trim above; nothing to keep in step.
        if (!thread) continue;
        // Map.set on an existing key keeps its position, so the mirror never
        // reorders the LRU and never promotes a stale thread out of eviction.
        next.set(key, { ...thread, messages: [...thread.messages, ...pair] });
      }
      return next;
    });

    if (promotedId !== null && activeKeyRef.current === originKey) {
      // replace, not push: Back returns to where the user came from, not to
      // the empty draft this conversation grew out of.
      navigate(conversationPath(promotedId), { replace: true });
    }
    // Every completed ask moves a row or its position — a promotion creates
    // one, a follow-up bumps `updated_at`, a null frame means it is gone.
    queryClient.invalidateQueries({ queryKey: ['llm', 'conversations'] });
  }, [navigate, queryClient]);

  /**
   * Delete succeeded — the pane owns the mutation (`useDeleteConversation`),
   * this is the thread-side half.
   *
   * The conversation's own thread goes. Every OTHER retained thread carrying
   * the id — the dock's `page:` thread on the page the conversation started
   * from — keeps its messages and loses the id, so its next question starts a
   * fresh row instead of 404-looping against a row that is gone.
   */
  const purgeConversation = useCallback((id: string) => {
    setThreads((prev) => {
      const next = new Map(prev);
      next.delete(`conv:${id}`);
      for (const [key, thread] of next) {
        if (thread.conversationId === id) next.set(key, { ...thread, conversationId: null });
      }
      return next;
    });
    // The open URL is dead. `replace`, so it is not one Back press away.
    if (conversationIdFromPath(location.pathname) === id) {
      navigate(AI_HOME_PATH, { replace: true });
    }
  }, [location.pathname, navigate]);
```

Expose `purgeConversation` on the value object, beside `startNewConversation`:

```ts
// old
    startNewConversation,

// new
    startNewConversation,
    purgeConversation,
```

and on the `AiContextValue` interface, beside `startNewConversation` (Task 2 removed `loadConversation` / `deleteConversation` from both):

```ts
// old
  startNewConversation: () => void;

// new
  startNewConversation: () => void;
  /**
   * #1361: the delete mutation succeeded. Removes `conv:<id>`, clears the id
   * from every other retained thread that carried it (keeping their messages),
   * and leaves a dead URL with a `replace` navigation to `/ai`.
   */
  purgeConversation: (id: string) => void;
```

- [ ] **Step 5: Read the frame with the null-safe guard and wire `completeExchange` into `runStream`**

Declare the frame local beside `refusedTurn` (`:804-810`):

```ts
// old
    let streamLayoutTokensLost: boolean | undefined;
    // #1119: the #1105 refusal verdict, read off the final frame. Local rather
    // than state because it is committed with the content in one update below.
    let refusedTurn = false;

// new
    let streamLayoutTokensLost: boolean | undefined;
    // #1119: the #1105 refusal verdict, read off the final frame. Local rather
    // than state because it is committed with the content in one update below.
    let refusedTurn = false;
    /**
     * #1361: the id the server named on this stream. Three distinct values,
     * and the state machine reads all three — `undefined` (no frame: not an
     * ask), a string (saved to that row), `null` (the append hit zero rows).
     */
    let frameConversationId: string | null | undefined;
```

Replace the truthiness guard (`:869-872`):

```ts
// old
        if (chunk.conversationId) {
          setConversationId(chunk.conversationId);
        }

// new
        // `in` plus an explicit undefined check, NOT truthiness: the final
        // frame is `conversationId: convId ?? null`, and the truthiness guard
        // swallowed exactly the `null` — leaving the client holding an id for
        // a row that was deleted mid-answer in another tab.
        if ('conversationId' in chunk && chunk.conversationId !== undefined) {
          const frameId = chunk.conversationId;
          if (
            frameId !== null
            && originHadId
            && originKey.startsWith('conv:')
            && frameId !== originKey.slice('conv:'.length)
          ) {
            // Defensive: the server answered about a different row than the
            // one this thread is pinned to. Adopting it would silently move
            // the user's conversation, and `AskMode` reads this id straight
            // into the next request body. Log and keep the thread where it is.
            console.warn('[ai] final frame named a different conversation; ignored', {
              originKey,
              frameId,
            });
          } else {
            frameConversationId = frameId;
            setConversationId(frameId);
          }
        }
```

Call `completeExchange` on the normal path only, immediately after the commit (`:903`):

```ts
// old
      commitToMessages();
      opts?.onComplete?.(

// new
      commitToMessages();
      // Promotion, the mirror and list invalidation — the NORMAL path only.
      // An aborted or errored first answer is never promoted (decision 9): the
      // abort branch below commits its partial and returns before reaching
      // here, and so does every error branch.
      completeExchange({
        originKey,
        originIdentity,
        originHadId,
        assistantMsgId,
        frameConversationId,
      });
      opts?.onComplete?.(
```

Handle the stale-404 inside the catch, ahead of `onError` (`:911-916`):

```ts
// old
      if (err instanceof DOMException && err.name === 'AbortError') {
        // Keep whatever was streamed before the abort (matches the previous
        // per-chunk-commit behavior).
        commitToMessages();
        return;
      }
      // The caller may claim the error (#1154). It has then already told the

// new
      if (err instanceof DOMException && err.name === 'AbortError') {
        // Keep whatever was streamed before the abort (matches the previous
        // per-chunk-commit behavior).
        commitToMessages();
        return;
      }
      // #1361: a stale conversation id. The server refuses BEFORE any SSE
      // header, so this arrives as a thrown ApiError rather than an in-band
      // error frame, and it is handled here — ahead of `onError` — so both
      // surfaces get it from the one helper they share.
      //
      // The id is read off the REQUEST body: `ApiError` carries a status and a
      // message and never the response payload (`shared/lib/sse.ts`), so the
      // body is the only place the client holds the id this 404 is about.
      if (
        err instanceof ApiError
        && err.statusCode === 404
        && typeof body.conversationId === 'string'
      ) {
        // No toast — the sentence IS the turn. No re-key and no navigation
        // either: re-keying onto `draft` would clobber the incumbent draft,
        // and the promotion rule already gives the next question a fresh row
        // and a fresh URL. Never auto-resend (#1176).
        failLastMessage('This conversation no longer exists — your next question starts a new one.');
        setConversationId(null);
        queryClient.invalidateQueries({ queryKey: ['llm', 'conversations'] });
        return;
      }
      // The caller may claim the error (#1154). It has then already told the
```

Add the two new dependencies to `runStream`'s dependency array (Task 3 rewrote this array when it bound the writers by identity — add the entries, do not rewrite the rest):

```ts
// old
  }, [streamingStart, streamingAppend, streamingReplace, streamingFinish, setMessages, setConversationId]);

// new
  }, [streamingStart, streamingAppend, streamingReplace, streamingFinish, setMessages, setConversationId, completeExchange, queryClient]);
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/features/ai/AiContext.threads.test.tsx`

Expected: PASS for the five cells added in Step 1.

- [ ] **Step 7: Write the failing tests for the stale 404, the null frame, the mismatch and the mirror**

Append these cells inside the same `describe('AiContext conversation state machine (#1361)', …)`:

```tsx
  it('clears the id and stays put on a stale 404, then the next ask promotes with the draft untouched', async () => {
    streamSSEMock.mockImplementation(askStreamReturning('c-1'));
    const { invalidate } = renderStateApp('/ai');

    fireEvent.click(screen.getByText('ask'));
    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent('/ai/c/c-1');
    });

    // Someone deleted the row in another tab. The server refuses before the
    // SSE header, so this is a thrown ApiError, not an in-band error frame.
    streamSSEMock.mockImplementation(() => { throw new ApiError(404, 'Conversation not found'); });
    fireEvent.click(screen.getByText('type'));
    fireEvent.click(screen.getByText('ask'));

    await waitFor(() => {
      expect(screen.getByTestId('conversation-id')).toHaveTextContent('none');
    });
    // The turn explains itself; the URL does not move and no re-key happens.
    expect(threadContents()).toContain(
      'This conversation no longer exists — your next question starts a new one.',
    );
    expect(screen.getByTestId('location')).toHaveTextContent('/ai/c/c-1');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['llm', 'conversations'] });
    // The user turn is never marked as the error.
    const rows = Array.from(screen.getByTestId('thread').querySelectorAll('li'));
    expect(rows.filter((li) => li.getAttribute('data-error') === 'yes')).toHaveLength(1);
    expect(screen.getByTestId('draft')).toHaveTextContent('half-typed question');

    // The next ask is a fresh conversation, and it promotes the SAME thread —
    // origin key `conv:c-1` with no id — onto the new row.
    streamSSEMock.mockImplementation(askStreamReturning('c-2', 'a fresh answer'));
    fireEvent.click(screen.getByText('ask'));
    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent('/ai/c/c-2');
    });
    expect(screen.getByTestId('conversation-id')).toHaveTextContent('c-2');
    // The half-typed draft is composer state on a thread that was re-keyed,
    // not switched — it survives untouched.
    expect(screen.getByTestId('draft')).toHaveTextContent('half-typed question');
  });

  it('clears the id on a final frame carrying conversationId: null, keeping the messages', async () => {
    streamSSEMock.mockImplementation(askStreamReturning('c-1'));
    const { invalidate } = renderStateApp('/ai');

    fireEvent.click(screen.getByText('ask'));
    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent('/ai/c/c-1');
    });
    invalidate.mockClear();

    // Deleted in another tab mid-answer: the append hit zero rows.
    streamSSEMock.mockImplementation(askStreamReturning(null, 'answered anyway'));
    fireEvent.click(screen.getByText('ask'));

    await waitFor(() => {
      expect(screen.getByTestId('conversation-id')).toHaveTextContent('none');
    });
    // The on-screen exchange stays; history does not get it; nothing navigates
    // and the deleted conversation is not resurrected.
    expect(threadContents()).toEqual(['q', 'the answer', 'q', 'answered anyway']);
    expect(screen.getByTestId('location')).toHaveTextContent('/ai/c/c-1');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['llm', 'conversations'] });
  });

  it('ignores a final frame naming a different conversation', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    streamSSEMock.mockImplementation(askStreamReturning('c-1'));
    renderStateApp('/ai');

    fireEvent.click(screen.getByText('ask'));
    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent('/ai/c/c-1');
    });

    streamSSEMock.mockImplementation(askStreamReturning('c-999', 'answer from elsewhere'));
    fireEvent.click(screen.getByText('ask'));
    await waitFor(() => {
      expect(threadContents()).toContain('answer from elsewhere');
    });

    expect(screen.getByTestId('conversation-id')).toHaveTextContent('c-1');
    expect(screen.getByTestId('location')).toHaveTextContent('/ai/c/c-1');
    expect(warn).toHaveBeenCalledWith(
      '[ai] final frame named a different conversation; ignored',
      { originKey: 'conv:c-1', frameId: 'c-999' },
    );
  });

  it('mirrors a completed exchange into every other retained thread carrying the id', async () => {
    streamSSEMock.mockImplementation(askStreamReturning('c-1'));
    renderStateApp('/ai', ['/pages/p1', '/ai/c/c-1']);

    fireEvent.click(screen.getByText('ask'));
    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent('/ai/c/c-1');
    });

    // The dock's thread on the page this conversation started from holds the
    // same server row.
    goTo('/pages/p1');
    fireEvent.click(screen.getByText('claim c-1'));
    expect(screen.getByTestId('conversation-id')).toHaveTextContent('c-1');

    goTo('/ai/c/c-1');
    streamSSEMock.mockImplementation(askStreamReturning('c-1', 'follow-up answer'));
    fireEvent.click(screen.getByText('ask'));
    await waitFor(() => {
      expect(threadContents()).toEqual(['q', 'the answer', 'q', 'follow-up answer']);
    });

    // Server history is the truth; a second view of it that silently lags is
    // what the mirror prevents.
    goTo('/pages/p1');
    expect(threadContents()).toEqual(['q', 'follow-up answer']);
  });

  it('purges a deleted conversation: its thread goes, other threads keep their messages and lose the id', async () => {
    streamSSEMock.mockImplementation(askStreamReturning('c-1'));
    renderStateApp('/ai', ['/pages/p1', '/ai/c/c-1']);

    fireEvent.click(screen.getByText('ask'));
    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent('/ai/c/c-1');
    });

    goTo('/pages/p1');
    fireEvent.click(screen.getByText('claim c-1'));
    fireEvent.click(screen.getByText('ask'));
    await waitFor(() => {
      expect(threadContents()).toEqual(['q', 'the answer']);
    });

    fireEvent.click(screen.getByText('purge c-1'));

    // The page thread keeps its messages and loses the id, so its next
    // question starts a fresh row instead of 404-looping.
    await waitFor(() => {
      expect(screen.getByTestId('conversation-id')).toHaveTextContent('none');
    });
    expect(threadContents()).toEqual(['q', 'the answer']);
    // Not open, so nothing navigated.
    expect(screen.getByTestId('location')).toHaveTextContent('/pages/p1');

    // And `conv:c-1` really is gone from the map — reopening it is a blank
    // placeholder, not the retained copy.
    goTo('/ai/c/c-1');
    expect(threadContents()).toEqual([]);
  });

  it('leaves the dead URL with a replace navigation when the purged conversation is open', async () => {
    streamSSEMock.mockImplementation(askStreamReturning('c-1'));
    renderStateApp('/ai');

    fireEvent.click(screen.getByText('ask'));
    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent('/ai/c/c-1');
    });

    fireEvent.click(screen.getByText('purge c-1'));
    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent('/ai');
    });
    expect(screen.getByTestId('location').textContent).not.toContain('/ai/c/');
  });
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/features/ai/AiContext.threads.test.tsx`

Expected: PASS. (Step 7's cells were written after Steps 3–5 landed the mechanism, so run them once against the implementation and once with the `completeExchange` call commented out to confirm the mirror and null-frame cells fail without it: `expected [ 'q', 'follow-up answer' ] to equal []` and `expected element to have text content none, received c-1`.)

- [ ] **Step 9: Run the guard suites this task touches** and `npx tsc --noEmit`

Run:
```bash
cd frontend && npx vitest run src/features/ai
cd frontend && npx vitest run src/ai-scroll-chain.test.ts
cd frontend && npx tsc --noEmit
cd frontend && npm run lint
```
Expected: all green. `ai-scroll-chain.test.ts` is unaffected (no JSX moved) and is run because `AiContext` is one of the three modules it names.

- [ ] **Step 10: Commit**

```bash
git add frontend/src/features/ai/AiContext.tsx frontend/src/features/ai/AiContext.threads.test.tsx
git commit -m "feat(ai): promotion, stale-404 recovery, null-frame and the mirror rule (#1361)

The first answer on /ai re-keys its draft onto conv:<id> and replaces the URL;
a page: thread never promotes. A 404 on a stale id becomes an inline turn with
the id cleared and the URL left alone, a final frame carrying conversationId:
null clears the id without resurrecting the row, and a completed exchange is
mirrored into every other retained thread holding the same id.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Hydration of `conv:` threads — load states, `retryThreadLoad`, `historyTruncated`

Implements the spec's *Thread keys* → **Filing and identity** (the hydration effect keyed on state, not presence), the state-machine rows **Open a row** and **Load fails**, and the *`/ai` page changes* bullets **History note** (the flag's two sources), **Loading and error states** and **Reopened answers render as live ones**.

> **Anchor note.** Same convention as Task 4: `old →` blocks are quoted as Tasks 2–4 leave the file. Task 2 deleted `loadConversation` from the context and from `AiContextValue`; this task brings its body back as the module-internal `hydrateThread`, which is exported nowhere.

**Pinned here:**

- **`loadError` holds the curated `ApiError.message`, or `null` for anything else.** That is the tree's own rule (`SidebarTreeView.tsx:1387-1392` renders `treeError instanceof ApiError ? treeError.message : '<fallback sentence>'`): `api.ts`'s `failureMessage` composes prose carrying the status code, while a raw network `TypeError` reads "Failed to fetch" and is not a sentence to show anyone. Task 15 renders the fallback line when `threadLoadError` is `null`.
- **The 404/400 branch deletes the placeholder thread and navigates in the same tick**, so the two land in one render and the read path never re-seeds `conv:<id>` as `loading` behind the redirect. Without the delete, a Back onto the dead URL would show a `ready` empty thread instead of re-attempting the fetch.
- **`historyTruncated` is written only for an exchange that carried a `conversationId` frame** — the same gate `completeExchange` already applies. An Improve run on a page thread must not clear a flag that describes the conversation's replay budget.
- **The toast copy is exactly `Conversation not found`** (Global Constraints), and there is no toast on the network branch: the in-pane error with **Retry** is the whole treatment, and redirecting on a network blip would lose a URL the user typed.

**Files:**
- Modify: `frontend/src/features/ai/AiContext.tsx` (`AiContextValue` additions; the active-thread destructure (`activeThread`, introduced by Task 2); `StreamChunk`; `hydrateThread` + the hydration effect + `retryThreadLoad`; `completeExchange`'s argument object; `runStream`'s frame loop; the value object)
- Test: `frontend/src/features/ai/AiContext.threads.test.tsx`

**Interfaces:**
- Consumes: Task 1's `AI_HOME_PATH` / `conversationIdFromPath`; Task 2's `seedFor`, `updateThread`, `threadKey`, `AiThread.loadState` / `loadError` / `historyTruncated`; Task 3's `updateThreadByIdentity`; Task 4's `completeExchange`; `ConversationDetail` from `@compendiq/contracts`.
- Produces on `AiContextValue`: `threadLoadState: 'ready' | 'loading' | 'error'`, `threadLoadError: string | null`, `retryThreadLoad: () => void`, `historyTruncated: boolean`. Task 6 reads `threadLoadState`; Task 15 renders all three; Task 16 renders `historyTruncated`.

---

- [ ] **Step 1: Extend the probe and write the failing hydration tests**

`frontend/src/features/ai/AiContext.threads.test.tsx` — grow `StateProbe` (Task 4) with the load surface:

```tsx
// old
  const {
    messages, conversationId, input, mode, model, activeThreadId,
    setInput, setConversationId, purgeConversation, runStream,
  } = useAiContext();
  const navigate = useNavigate();

// new
  const {
    messages, conversationId, input, mode, model, activeThreadId,
    threadLoadState, threadLoadError, historyTruncated, retryThreadLoad,
    setInput, setConversationId, purgeConversation, runStream,
  } = useAiContext();
  const navigate = useNavigate();
```

```tsx
// old
      <span data-testid="mode">{mode}</span>
      <span data-testid="model">{model}</span>

// new
      <span data-testid="mode">{mode}</span>
      <span data-testid="model">{model}</span>
      <span data-testid="load-state">{threadLoadState}</span>
      <span data-testid="load-error">{threadLoadError ?? 'none'}</span>
      <span data-testid="history-truncated">{historyTruncated ? 'yes' : 'no'}</span>
```

```tsx
// old
      <button onClick={() => purgeConversation('c-1')}>purge c-1</button>

// new
      <button onClick={() => purgeConversation('c-1')}>purge c-1</button>
      <button onClick={retryThreadLoad}>retry</button>
```

Add the fixture helper and the cells, inside the same `describe`:

```tsx
  /** A `GET /llm/conversations/:id` payload shaped like PR 1's contract. */
  function conversationDetail(id: string, overrides: Record<string, unknown> = {}) {
    return {
      id,
      title: `Conversation ${id}`,
      titleSource: 'question',
      model: 'a-model-nobody-selected',
      pageId: null,
      pageTitle: null,
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T11:00:00.000Z',
      historyTruncated: false,
      messages: [
        { role: 'user', content: `question in ${id}` },
        { role: 'assistant', content: `answer in ${id}` },
      ],
      ...overrides,
    };
  }

  /** Route `/llm/conversations/:id` to `detail`, leaving the model queries alone. */
  function withConversations(detail: (id: string) => unknown) {
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/llm/usecase-default?usecase=chat') {
        return Promise.resolve({ model: 'llama3', vision: null });
      }
      if (path.startsWith('/ollama/models')) return Promise.resolve([{ name: 'llama3' }]);
      if (path.startsWith('/llm/conversations/')) {
        return Promise.resolve(detail(path.slice('/llm/conversations/'.length)));
      }
      return Promise.resolve([]);
    });
  }

  it('shows the loading state on the first render of /ai/c/X, never the Ask empty state', async () => {
    withConversations(() => new Promise(() => {}));
    renderStateApp('/ai/c/c-1');

    // The read path yields `seedFor('conv:c-1')`, so the very first paint is
    // already `loading` — the empty state renders only on `ready`.
    expect(screen.getByTestId('load-state')).toHaveTextContent('loading');
    expect(threadContents()).toEqual([]);
    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith('/llm/conversations/c-1');
    });
  });

  it('fetches into conv:<id>, never into the thread that was on screen', async () => {
    withConversations((id) => conversationDetail(id));
    renderStateApp('/ai', ['/ai', '/ai/c/c-1']);

    fireEvent.click(screen.getByText('type'));
    expect(screen.getByTestId('draft')).toHaveTextContent('half-typed question');

    goTo('/ai/c/c-1');
    await waitFor(() => {
      expect(threadContents()).toEqual(['question in c-1', 'answer in c-1']);
    });
    expect(screen.getByTestId('conversation-id')).toHaveTextContent('c-1');
    expect(screen.getByTestId('load-state')).toHaveTextContent('ready');
    // Opening loads, never sends (#1176), and sets the action to Q&A…
    expect(screen.getByTestId('mode')).toHaveTextContent('ask');
    // …but never the model: the per-conversation dropdown is gone (#355 AC-4).
    expect(screen.getByTestId('model')).toHaveTextContent('llama3');

    // The draft it was fetched next to is untouched.
    goTo('/ai');
    expect(threadContents()).toEqual([]);
    expect(screen.getByTestId('draft')).toHaveTextContent('half-typed question');
  });

  it('renders a reopened refusal as a refusal, not as an ordinary answer', async () => {
    withConversations((id) => conversationDetail(id, {
      messages: [
        { role: 'system', content: 'you are a helpful assistant' },
        { role: 'user', content: 'what is the retention window?' },
        { role: 'assistant', content: 'I am not answering that.', refused: true },
      ],
    }));
    renderStateApp('/ai/c/c-1');

    await waitFor(() => {
      expect(threadContents()).toEqual([
        'what is the retention window?',
        'I am not answering that.',
      ]);
    });
    const rows = Array.from(screen.getByTestId('thread').querySelectorAll('li'));
    expect(rows[1]!.getAttribute('data-refusal')).toBe('yes');
  });

  it('toasts and redirects to /ai when the id is unknown', async () => {
    const { toast } = await import('sonner');
    withConversations(() => Promise.reject(new ApiError(404, 'Conversation not found')));
    renderStateApp('/ai/c/gone');

    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent('/ai');
    });
    expect(screen.getByTestId('location').textContent).not.toContain('/ai/c/');
    expect(toast.error).toHaveBeenCalledWith('Conversation not found');
    // The placeholder thread is removed, so /ai is the ordinary draft.
    expect(screen.getByTestId('load-state')).toHaveTextContent('ready');
    expect(threadContents()).toEqual([]);
  });

  it('keeps the URL and records the error on a network failure, then retries', async () => {
    const { toast } = await import('sonner');
    withConversations(() => Promise.reject(new ApiError(503, 'Service Unavailable (HTTP 503)')));
    renderStateApp('/ai/c/c-1');

    await waitFor(() => {
      expect(screen.getByTestId('load-state')).toHaveTextContent('error');
    });
    // Redirecting on a blip would lose a URL the user typed.
    expect(screen.getByTestId('location')).toHaveTextContent('/ai/c/c-1');
    expect(screen.getByTestId('load-error')).toHaveTextContent('Service Unavailable (HTTP 503)');
    expect(toast.error).not.toHaveBeenCalled();

    withConversations((id) => conversationDetail(id));
    fireEvent.click(screen.getByText('retry'));
    await waitFor(() => {
      expect(threadContents()).toEqual(['question in c-1', 'answer in c-1']);
    });
    expect(screen.getByTestId('load-state')).toHaveTextContent('ready');
  });

  it('still hydrates when the URL also carries a ?q= prefill', async () => {
    withConversations((id) => conversationDetail(id));
    renderStateApp('/ai/c/c-1?q=and one more thing');

    expect(screen.getByTestId('load-state')).toHaveTextContent('loading');
    await waitFor(() => {
      expect(threadContents()).toEqual(['question in c-1', 'answer in c-1']);
    });
    // The prefill is a WRITE to `conv:c-1`, which files the key — and files it
    // through `seedFor`, so hydration is not suppressed by the write arriving
    // first. Both landed.
    expect(screen.getByTestId('draft')).toHaveTextContent('and one more thing');
  });

  it('walks two conversations with Back and Forward', async () => {
    withConversations((id) => conversationDetail(id));
    renderStateApp('/ai/c/c-1', ['/ai/c/c-2']);

    await waitFor(() => {
      expect(threadContents()).toEqual(['question in c-1', 'answer in c-1']);
    });
    goTo('/ai/c/c-2');
    await waitFor(() => {
      expect(threadContents()).toEqual(['question in c-2', 'answer in c-2']);
    });

    fireEvent.click(screen.getByText('back'));
    await waitFor(() => {
      expect(threadContents()).toEqual(['question in c-1', 'answer in c-1']);
    });
    fireEvent.click(screen.getByText('forward'));
    await waitFor(() => {
      expect(threadContents()).toEqual(['question in c-2', 'answer in c-2']);
    });
    // Retained, so walking back and forward costs one fetch each, not four.
    expect(apiFetchMock.mock.calls.filter(
      (call) => String(call[0]).startsWith('/llm/conversations/'),
    )).toHaveLength(2);
  });

  it('treats an evicted conversation reopened as a switch and refetches it', async () => {
    withConversations((id) => conversationDetail(id));
    const pages = Array.from({ length: 12 }, (_, i) => `/pages/p${i}`);
    renderStateApp('/ai/c/c-1', [...pages, '/ai/c/c-1']);

    await waitFor(() => {
      expect(threadContents()).toEqual(['question in c-1', 'answer in c-1']);
    });
    const firstIdentity = screen.getByTestId('active-thread-id').textContent;

    // draft + conv:c-1 + twelve page threads is fourteen entries against a cap
    // of twelve, so the two oldest go.
    for (const page of pages) goTo(page);

    goTo('/ai/c/c-1');
    await waitFor(() => {
      expect(threadContents()).toEqual(['question in c-1', 'answer in c-1']);
    });
    expect(apiFetchMock.mock.calls.filter(
      (call) => call[0] === '/llm/conversations/c-1',
    )).toHaveLength(2);
    // A re-filed thread is a new identity, and opening is a switch by
    // definition — Deep Search and staged attachments clear.
    expect(screen.getByTestId('active-thread-id').textContent).not.toBe(firstIdentity);
  });

  it('reads historyTruncated from the reopen and from each ask’s final frame', async () => {
    withConversations((id) => conversationDetail(id, { historyTruncated: true }));
    renderStateApp('/ai/c/c-1');

    // Decision 10's reopen half: a long conversation says so the moment it
    // opens, not after the next question has already been clipped.
    await waitFor(() => {
      expect(screen.getByTestId('history-truncated')).toHaveTextContent('yes');
    });

    // …and the live half, which can also take it back down: the frame omits
    // the field when the whole history fitted.
    streamSSEMock.mockImplementation(askStreamReturning('c-1', 'shorter now'));
    fireEvent.click(screen.getByText('ask'));
    await waitFor(() => {
      expect(screen.getByTestId('history-truncated')).toHaveTextContent('no');
    });

    streamSSEMock.mockImplementation(async function* () {
      yield { content: 'clipped' };
      yield { done: true, final: true, conversationId: 'c-1', sources: [], historyTruncated: true };
    });
    fireEvent.click(screen.getByText('ask'));
    await waitFor(() => {
      expect(screen.getByTestId('history-truncated')).toHaveTextContent('yes');
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/features/ai/AiContext.threads.test.tsx -t "#1361"`

Expected: FAIL — `threadLoadState` is `undefined` so `expect(element).toHaveTextContent('loading')` reports an empty node, and no `/llm/conversations/c-1` request is ever made (`expected "apiFetch" to have been called with ['/llm/conversations/c-1']`).

- [ ] **Step 3: Declare the load fields on the context and read them off the active thread**

`frontend/src/features/ai/AiContext.tsx` — `AiContextValue`, directly under the `purgeConversation` entry Task 4 added:

```ts
// old
  purgeConversation: (id: string) => void;

// new
  purgeConversation: (id: string) => void;
  /**
   * #1361: hydration state of the ACTIVE thread. `draft` and `page:` threads
   * are always `'ready'`; a `conv:` thread is `'loading'` from the first paint
   * of `/ai/c/:id` until `GET /llm/conversations/:id` answers.
   */
  threadLoadState: 'ready' | 'loading' | 'error';
  /**
   * The curated `ApiError.message` behind a `'error'` load, or `null` for a
   * failure that produced no prose worth showing (a raw network `TypeError`).
   * The page renders its own sentence in that case — `SidebarTreeView`'s rule.
   */
  threadLoadError: string | null;
  /** Re-arm the hydration effect for the open conversation. */
  retryThreadLoad: () => void;
  /**
   * Decision 10: the server dropped older exchanges from the replay budget for
   * this conversation. Two sources — each ask's final frame, and
   * `GET /llm/conversations/:id` on reopen — or the note is invisible in
   * exactly the case it exists for.
   */
  historyTruncated: boolean;
```

The active-thread destructure (Task 2 replaced the inline `?? EMPTY_THREAD` read with the
memoised `activeThread` — do NOT reintroduce an inline `threads.get(...) ?? seedFor(...)`
here, which would hand a fresh `messages: []` identity to the auto-scroll effect on every
render of an unfiled thread, the exact thing Task 2's memoisation pins):

```ts
// old (as Task 2 leaves it)
  const {
    messages, conversationId, input, showDiffView,
    improvedContent, originalMarkdown, layoutTokensLost, diagramCode, diffBaseVersion,
  } = activeThread;

// new
  const {
    messages, conversationId, input, showDiffView,
    improvedContent, originalMarkdown, layoutTokensLost, diagramCode, diffBaseVersion,
    loadState, loadError, historyTruncated,
  } = activeThread;
```

`StreamChunk` gains the flag, beside `refused`:

```ts
// old
  refused?: boolean;
}

// new
  refused?: boolean;
  /**
   * Ask route (#1361, decision 10): the replay budget dropped older exchanges
   * from what the model was shown. Omitted entirely when the whole history
   * fitted, so ABSENT means false.
   */
  historyTruncated?: boolean;
}
```

- [ ] **Step 4: Add `hydrateThread`, the state-keyed effect and `retryThreadLoad`**

Import the detail type at the top of `AiContext.tsx`:

```ts
// old
import type { UsecaseDefault } from '@compendiq/contracts';

// new
import type { ConversationDetail, UsecaseDefault } from '@compendiq/contracts';
```

Insert the following immediately below `purgeConversation` (Task 4):

```tsx
  /**
   * Keys with a `GET /llm/conversations/:id` in flight. A ref, not state: it
   * exists only to stop the effect firing twice for the same key, and putting
   * it in state would re-run the effect it guards.
   */
  const hydratingRef = useRef<Set<string>>(new Set());

  /**
   * Fetch one conversation INTO its own key — never into "the current thread".
   * The internal successor of #1126's `loadConversation`, exported nowhere:
   * opening a row is a navigation now, and the route is the only caller.
   */
  const hydrateThread = useCallback(async (key: string, id: string) => {
    if (hydratingRef.current.has(key)) return;
    hydratingRef.current.add(key);
    try {
      const conv = await apiFetch<ConversationDetail>(`/llm/conversations/${id}`);
      updateThread(key, () => ({
        // `refused` is what `saveConversation` writes onto a #1105 refusal
        // turn, and the route returns the messages JSONB verbatim — so a
        // reopened thread has to carry the marker across or the refusal
        // silently downgrades to an ordinary answer, which is precisely the
        // state #1119 exists to stop rendering. Since PR 1 the persisted turn
        // carries its `sources` (the chip allow-list) too.
        messages: conv.messages
          .filter((msg) => msg.role !== 'system')
          .map((msg) => ({
            id: nextMessageId(),
            role: msg.role as 'user' | 'assistant',
            content: msg.content,
            ...(msg.sources ? { sources: msg.sources as Source[] } : {}),
            ...(msg.refused === true ? { isRefusal: true } : {}),
          })),
        conversationId: conv.id,
        historyTruncated: conv.historyTruncated,
        loadState: 'ready',
        loadError: null,
      }));
      // Opening loads, never sends (#1176), and puts the Ask composer on
      // screen. It deliberately does NOT call setModel: the per-conversation
      // dropdown is gone, and a stored model would silently repoint every
      // later question on the instance.
      setMode('ask');
    } catch (err) {
      const status = err instanceof ApiError ? err.statusCode : 0;
      if (status === 404 || status === 400) {
        toast.error('Conversation not found');
        // Remove the placeholder in the same tick as the navigation, so the
        // two batch into one render and the read path never re-seeds
        // `conv:<id>` as `loading` behind the redirect.
        setThreads((prev) => {
          const next = new Map(prev);
          next.delete(key);
          return next;
        });
        navigate(AI_HOME_PATH, { replace: true });
        return;
      }
      // Anything else stays put with an in-pane error and a Retry: redirecting
      // on a network blip would lose a URL the user typed.
      updateThread(key, () => ({
        loadState: 'error',
        loadError: err instanceof ApiError ? err.message : null,
      }));
    } finally {
      hydratingRef.current.delete(key);
    }
  }, [navigate, updateThread]);

  /**
   * Hydration is keyed on STATE, not on presence: whenever the active thread
   * says `loading` and no fetch is in flight for its key, fetch. Effect order
   * therefore cannot break it — a `?q=` prefill that files the key first files
   * it through `seedFor`, which is what keeps `loading` on the entry.
   */
  useEffect(() => {
    if (loadState !== 'loading') return;
    const id = conversationIdFromPath(location.pathname);
    if (!id) return;
    const key = `conv:${id}`;
    if (hydratingRef.current.has(key)) return;
    void hydrateThread(key, id);
  }, [loadState, location.pathname, hydrateThread]);

  /**
   * The error state's remedy. Setting `loadState` back to `'loading'` is the
   * whole mechanism — the effect above is armed by state, so this re-arms it.
   */
  const retryThreadLoad = useCallback(() => {
    const id = conversationIdFromPath(location.pathname);
    if (!id) return;
    updateThread(`conv:${id}`, () => ({ loadState: 'loading', loadError: null }));
  }, [location.pathname, updateThread]);
```

Expose the four on the value object, beside `purgeConversation`:

```ts
// old
    purgeConversation,

// new
    purgeConversation,
    threadLoadState: loadState,
    threadLoadError: loadError,
    retryThreadLoad,
    historyTruncated,
```

- [ ] **Step 5: Run the hydration tests to verify they pass**

Run: `cd frontend && npx vitest run src/features/ai/AiContext.threads.test.tsx -t "#1361"`

Expected: PASS for every cell except *reads historyTruncated from the reopen and from each ask's final frame*, whose second half still fails with `expected element to have text content no, received yes` — the frame half lands in Step 6.

- [ ] **Step 6: Write the flag's live half into `completeExchange`**

`runStream`'s locals, beside `frameConversationId` (Task 4):

```ts
// old
    let frameConversationId: string | null | undefined;

// new
    let frameConversationId: string | null | undefined;
    /**
     * Decision 10's live half. Absent on the frame ⇒ false: the backend omits
     * the field when the whole history fitted.
     */
    let frameHistoryTruncated = false;
```

The frame loop, directly after the refusal read (`:882-885` today):

```ts
// old
        if (chunk.final && chunk.refused === true) {
          refusedTurn = true;
        }

// new
        if (chunk.final && chunk.refused === true) {
          refusedTurn = true;
        }
        if (chunk.final) {
          frameHistoryTruncated = chunk.historyTruncated === true;
        }
```

`completeExchange`'s argument type and destructure gain the flag:

```ts
// old
  const completeExchange = useCallback((args: {
    originKey: string;
    originIdentity: number;
    originHadId: boolean;
    assistantMsgId: string;
    frameConversationId: string | null | undefined;
  }) => {
    const { originKey, originIdentity, originHadId, assistantMsgId, frameConversationId } = args;

// new
  const completeExchange = useCallback((args: {
    originKey: string;
    originIdentity: number;
    originHadId: boolean;
    assistantMsgId: string;
    frameConversationId: string | null | undefined;
    historyTruncated: boolean;
  }) => {
    const {
      originKey, originIdentity, originHadId, assistantMsgId,
      frameConversationId, historyTruncated,
    } = args;
```

and the write goes directly after the early return, so it is applied only to an exchange that really was an ask:

```ts
// old
    if (frameConversationId === undefined) return;

    // Promotion guard, both halves.

// new
    if (frameConversationId === undefined) return;

    // Decision 10: the flag describes THIS conversation's replay budget, so it
    // is written only for an exchange that was saved to one. Its own update —
    // the big pass below returns `prev` untouched when nothing was promoted
    // and nothing was mirrored, and this must land either way.
    updateThreadByIdentity(originIdentity, () => ({ historyTruncated }));

    // Promotion guard, both halves.
```

Add `updateThreadByIdentity` to `completeExchange`'s dependency array:

```ts
// old
  }, [navigate, queryClient]);

// new
  }, [navigate, queryClient, updateThreadByIdentity]);
```

And pass the flag at the call site in `runStream`:

```ts
// old
      completeExchange({
        originKey,
        originIdentity,
        originHadId,
        assistantMsgId,
        frameConversationId,
      });

// new
      completeExchange({
        originKey,
        originIdentity,
        originHadId,
        assistantMsgId,
        frameConversationId,
        historyTruncated: frameHistoryTruncated,
      });
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/features/ai/AiContext.threads.test.tsx`

Expected: PASS, whole file.

- [ ] **Step 8: Run the guard suites this task touches** and `npx tsc --noEmit`

Run:
```bash
cd frontend && npx vitest run src/features/ai
cd frontend && npx vitest run src/ai-scroll-chain.test.ts
cd frontend && npx tsc --noEmit
cd frontend && npm run lint
```
Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/features/ai/AiContext.tsx frontend/src/features/ai/AiContext.threads.test.tsx
git commit -m "feat(ai): hydrate conv: threads from the route, with load states and Retry (#1361)

Opening /ai/c/:id fetches GET /llm/conversations/:id into that key — never into
the thread that was on screen — keyed on loadState rather than presence, so a
?q= prefill filing the key first cannot suppress it. 404/400 toasts and returns
to /ai; anything else records the curated ApiError message and offers Retry.
historyTruncated now has both its sources: the reopen and each ask's final frame.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Composer resets keyed on `activeThreadId`; `AskMode` tests

Implements the spec's *`activeThreadId`* section (the four switch-sensitive consumers: the abort effect — Task 3 — `DeepSearchToggle`, `AssistantAttachmentsScope` and the Ask composer's `externalUrls`) and the *`/ai` page changes* bullets **Composer focus** and **Loading and error states** (Send disabled while `threadLoadState === 'loading'`).

**Pinned here:**

- **`showUrlInput` resets with `externalUrls`.** The spec names `externalUrls`; the row that adds them is the same piece of per-send composer state, and a URL bar left open over a conversation the user just switched to is the same carried-over choice.
- **`handleAsk` is guarded on `threadLoadState` as well as the Send button.** The textarea is not disabled while a conversation loads, so Enter reaches `handleSubmit` and would post an ask against a thread whose history has not arrived. Disabling the button alone leaves the keyboard path open.
- **The composer focus effect is the existing mount-focus effect with `composerFocusRequest` added to its deps** — one effect, not two. The mount case is `composerFocusRequest`'s initial value; every later bump is New chat landing the caret where the next question goes.

**Files:**
- Modify: `frontend/src/features/ai/modes/AskMode.tsx` (`:37-40` destructure, `:66-79` the reset effect, `:117-122` the focus effect, `:139-140` the ask guard, `:344-346` Send)
- Modify: `frontend/src/features/ai/AssistantAttachments.tsx` (`:25-27`, `:38-43`)
- Test: `frontend/src/features/ai/modes/AskMode.test.tsx`

**Interfaces:**
- Consumes: `activeThreadId` (Task 2), `composerFocusRequest` (Task 2), `startNewConversation` (Task 2), `threadLoadState` (Task 5).
- Produces: nothing new — this task moves three existing resets onto `activeThreadId` and adds two composer behaviours. Task 16 adds the history note to this same composer.

---

- [ ] **Step 1: Replace the `ConversationSwitcher` stub with the real switches, and write the failing reset cells**

`frontend/src/features/ai/modes/AskMode.test.tsx` — the stub at `:783-791` no longer describes a switch: since #1361 a promotion writes the id onto the **same** thread, so `setConversationId` moves nothing and the old stub would go green against a composer that never cleared.

```tsx
// old (:783-791)
    /**
     * Stands in for the conversation sidebar, which lives in `AiAssistantPage`
     * and is not rendered here. What matters is the shape it produces: the
     * thread underneath changes while the composer stays mounted, so no
     * unmount tidies the toggle away.
     */
    function ConversationSwitcher() {
      const { setConversationId } = useAiContext();
      return <button onClick={() => setConversationId('conv-2')}>switch</button>;
    }

// new
    /**
     * The two gestures that really change the active thread now that threads
     * are keyed by location (#1361): New chat, which files a fresh draft
     * identity, and opening another conversation, which is a route change.
     *
     * `setConversationId` is deliberately NOT one of them any more — a
     * promotion writes the id onto the SAME thread, so the old stub would go
     * green against a composer that never cleared.
     */
    function ThreadSwitcher() {
      const { startNewConversation } = useAiContext();
      const navigate = useNavigate();
      return (
        <>
          <button onClick={startNewConversation}>new chat</button>
          <button onClick={() => navigate('/ai/c/conv-2')}>open conv-2</button>
        </>
      );
    }
```

`withModel()` has to answer the conversation-detail route, or opening `conv-2` lands the thread in the error state instead of hydrating (`:742-759`):

```tsx
// old
        if (path === '/llm/conversations') {
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      });

// new
        if (path.startsWith('/llm/conversations/')) {
          return Promise.resolve({
            id: 'conv-2',
            title: 'Another conversation',
            titleSource: 'question',
            model: 'llama3',
            pageId: null,
            pageTitle: null,
            createdAt: '2026-08-01T10:00:00.000Z',
            updatedAt: '2026-08-01T11:00:00.000Z',
            historyTruncated: false,
            messages: [],
          });
        }
        if (path === '/llm/conversations') {
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      });
```

Replace the last cell of the deep-search describe (`:919-937`) and add the two new ones:

```tsx
// old (:919-937)
    // #1119 review: the sidebar swaps the thread under a mounted composer, so
    // this boundary is not covered by the remount test above.
    it('clears an unconsumed toggle when the conversation changes', async () => {
      withModel();
      render(
        <>
          <ConversationSwitcher />
          <AskModeInput />
        </>,
        { wrapper: createWrapper() },
      );

      fireEvent.click(screen.getByTestId('ask-deep-search'));
      expect(screen.getByTestId('ask-deep-search')).toBeChecked();

      fireEvent.click(screen.getByText('switch'));
      await waitFor(() => {
        expect(screen.getByTestId('ask-deep-search')).not.toBeChecked();
      });
    });

// new
    // #1119 review: a switch swaps the thread under a mounted composer, so
    // this boundary is not covered by the remount test above. Since #1361 the
    // boundary is `activeThreadId`, not `conversationId`.
    it('clears an unconsumed toggle when another conversation is opened', async () => {
      withModel();
      render(
        <>
          <ThreadSwitcher />
          <AskModeInput />
        </>,
        { wrapper: createWrapper() },
      );

      fireEvent.click(screen.getByTestId('ask-deep-search'));
      expect(screen.getByTestId('ask-deep-search')).toBeChecked();

      fireEvent.click(screen.getByText('open conv-2'));
      await waitFor(() => {
        expect(screen.getByTestId('ask-deep-search')).not.toBeChecked();
      });
    });

    // NON-STICKINESS TEST 3 — new -> new. Pressing New chat on an already
    // empty draft files a fresh identity precisely so this clears; keyed on
    // `conversationId` it would not, because both drafts carry `null`.
    it('clears an unconsumed toggle when New chat is pressed on an empty draft', async () => {
      withModel();
      render(
        <>
          <ThreadSwitcher />
          <AskModeInput />
        </>,
        { wrapper: createWrapper() },
      );

      fireEvent.click(screen.getByTestId('ask-deep-search'));
      expect(screen.getByTestId('ask-deep-search')).toBeChecked();

      fireEvent.click(screen.getByText('new chat'));
      await waitFor(() => {
        expect(screen.getByTestId('ask-deep-search')).not.toBeChecked();
      });
    });
  });

  // -------------------------------------------------------------------------
  // #1361 — the composer follows the active thread
  // -------------------------------------------------------------------------
  describe('composer state is scoped to the active thread', () => {
    function withModel() {
      apiFetchMock.mockImplementation((path: string) => {
        if (path === '/settings') {
          return Promise.resolve({ llmProvider: 'ollama', ollamaModel: 'llama3', openaiModel: null });
        }
        if (path.startsWith('/ollama/models')) return Promise.resolve([{ name: 'llama3' }]);
        if (path === '/mcp-docs/status') return Promise.resolve({ enabled: true });
        return Promise.resolve([]);
      });
      streamSSEMock.mockImplementation(async function* fakeStream() {
        yield { content: 'Answer' };
      });
    }

    function ThreadSwitcher() {
      const { startNewConversation } = useAiContext();
      return <button onClick={startNewConversation}>new chat</button>;
    }

    it('drops attached external URLs when the active thread changes', async () => {
      withModel();
      render(
        <>
          <ThreadSwitcher />
          <AskModeInput />
        </>,
        { wrapper: createWrapper() },
      );

      fireEvent.click(await screen.findByTestId('attach-url-button'));
      fireEvent.change(screen.getByTestId('external-url-input'), {
        target: { value: 'https://docs.example.com/runbook' },
      });
      fireEvent.click(screen.getByLabelText('Add URL'));
      expect(await screen.findByText('docs.example.com')).toBeInTheDocument();

      fireEvent.click(screen.getByText('new chat'));

      // The URLs describe the question they were attached to, and the row that
      // adds them is the same per-send state.
      await waitFor(() => {
        expect(screen.queryByText('docs.example.com')).not.toBeInTheDocument();
      });
      expect(screen.queryByTestId('external-url-input')).not.toBeInTheDocument();
    });

    it('clears staged attachments when the active thread changes', async () => {
      withModel();
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
        format: 'txt',
        text: 'The rollout requires two approvals.',
        fileSize: 35,
        preview: 'The rollout requires two approvals.',
      }), { headers: { 'Content-Type': 'application/json' } }));

      render(
        <>
          <ThreadSwitcher />
          <AskModeInput />
        </>,
        { wrapper: createWrapper() },
      );

      fireEvent.change(screen.getByTestId('ask-doc-file-input'), {
        target: { files: [new File(['policy'], 'policy.txt', { type: 'text/plain' })] },
      });
      await screen.findByTestId('ask-doc-attachment-card');

      fireEvent.click(screen.getByText('new chat'));

      // `AssistantAttachmentsScope` cleared on `pageId` before #1361, which on
      // /ai is null for every thread — so nothing cleared between conversations
      // and an uploaded source crossed into the next one.
      await waitFor(() => {
        expect(screen.queryByTestId('ask-doc-attachment-card')).not.toBeInTheDocument();
      });
    });

    it('focuses the textarea on every composer focus request', async () => {
      withModel();
      render(
        <>
          <ThreadSwitcher />
          <AskModeInput />
        </>,
        { wrapper: createWrapper() },
      );

      const input = screen.getByTestId('ask-input');
      (screen.getByText('new chat') as HTMLButtonElement).focus();
      expect(document.activeElement).not.toBe(input);

      fireEvent.click(screen.getByText('new chat'));

      // New chat lands the caret where the next question goes (the #1176 dock
      // convention). Opening a row deliberately does not.
      await waitFor(() => {
        expect(document.activeElement).toBe(input);
      });
    });

    it('disables Send while the open conversation is still loading', async () => {
      apiFetchMock.mockImplementation((path: string) => {
        if (path === '/settings') {
          return Promise.resolve({ llmProvider: 'ollama', ollamaModel: 'llama3', openaiModel: null });
        }
        if (path.startsWith('/ollama/models')) return Promise.resolve([{ name: 'llama3' }]);
        if (path.startsWith('/llm/conversations/')) return new Promise(() => {});
        return Promise.resolve([]);
      });
      streamSSEMock.mockImplementation(async function* fakeStream() {
        yield { content: 'Answer' };
      });

      render(<AskModeInput />, { wrapper: createWrapper(['/ai/c/pending?q=already typed']) });

      const input = await screen.findByTestId('ask-input');
      await waitFor(() => {
        expect((input as HTMLTextAreaElement).value).toBe('already typed');
      });

      // A ?q= prefill is exactly the case where the composer has text before
      // the history has arrived, so "empty input" is not the guard.
      expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();

      // …and Enter must not slip past it: the textarea is not disabled.
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => {
        expect(streamSSEMock).not.toHaveBeenCalled();
      });
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/features/ai/modes/AskMode.test.tsx`

Expected: FAIL — `ThreadSwitcher` is fine, but the resets are still keyed on the old inputs: *clears an unconsumed toggle when New chat is pressed on an empty draft* fails with `expected element to be checked: false, received true` (both drafts carry `conversationId: null`), *drops attached external URLs* fails with `expected null not to be null` for `docs.example.com`, *clears staged attachments* fails the same way for `ask-doc-attachment-card`, *focuses the textarea* fails with `expected <button> to be <textarea>`, and *disables Send* fails with `expected element to be disabled`.

- [ ] **Step 3: Key the Ask composer's resets and focus on the context**

`frontend/src/features/ai/modes/AskMode.tsx` — the destructure (`:36-40`):

```tsx
// old
  const {
    input, setInput, isStreaming, model, conversationId, pageId,
    includeSubPages, thinkingMode, setMessages, runStream,
    chatVision, chatVisionModel,
  } = useAiContext();

// new
  const {
    input, setInput, isStreaming, model, conversationId, pageId,
    includeSubPages, thinkingMode, setMessages, runStream,
    chatVision, chatVisionModel,
    activeThreadId, composerFocusRequest, threadLoadState,
  } = useAiContext();
```

The reset effect (`:66-79`):

```tsx
// old
  // The one boundary a remount does not cover. Switching threads from the
  // conversation sidebar — or starting a new one — swaps the conversation under
  // a composer that stays mounted, so an unconsumed toggle would carry a choice
  // made about one conversation into the first question of another. That is the
  // per-conversation stickiness this state's placement exists to prevent,
  // arrived at from the other side; the dock clears its own slots at its pageId
  // boundary for the same reason.
  //
  // Harmless on the id the server assigns mid-answer: `handleAsk` has already
  // cleared the flag by then, and the toggle is disabled while streaming.
  useEffect(() => {
    setDeepSearch(false);
  }, [conversationId]);

// new
  // The one boundary a remount does not cover. Opening another conversation —
  // or starting a new one — swaps the thread under a composer that stays
  // mounted, so an unconsumed toggle would carry a choice made about one
  // conversation into the first question of another.
  //
  // Keyed on `activeThreadId` (#1361), NOT on `conversationId`: a promotion
  // writes the id onto the SAME thread, which is a re-key and not a switch, so
  // the id both fires when it must not (mid-answer) and stays put when it must
  // fire (New chat on an already-empty draft — both drafts carry `null`).
  //
  // `externalUrls` is the same per-send state and goes with it, along with the
  // row that adds them: a URL bar left open over a conversation the user has
  // just switched to is the same carried-over choice.
  useEffect(() => {
    setDeepSearch(false);
    setExternalUrls((prev) => (prev.length === 0 ? prev : []));
    setShowUrlInput(false);
  }, [activeThreadId]);
```

The focus effect (`:117-122`) — one effect, not two: mount focus is `composerFocusRequest`'s initial value:

```tsx
// old
  // #350: focus input on mount so the user can type immediately. Use a ref +
  // useEffect rather than autoFocus so it survives StrictMode double-mount and
  // route transitions reliably.
  useEffect(() => {
    inputRef.current?.focus();
  }, [inputRef]);

// new
  // #350: focus input on mount so the user can type immediately. Use a ref +
  // useEffect rather than autoFocus so it survives StrictMode double-mount and
  // route transitions reliably.
  //
  // #1361: the same effect answers `composerFocusRequest`, which
  // `startNewConversation` bumps — New chat lands the caret where the next
  // question goes (the #1176 dock convention). Opening a row deliberately does
  // NOT bump it: a keyboard user is mid-list and `aria-current` tells them
  // where they are.
  useEffect(() => {
    inputRef.current?.focus();
  }, [inputRef, composerFocusRequest]);
```

The ask guard (`:139-140`):

```tsx
// old
  const handleAsk = useCallback(async () => {
    if (!input.trim() || isStreaming || isBusy) return;

// new
  const handleAsk = useCallback(async () => {
    // `threadLoadState` is checked here as well as on Send: the textarea is not
    // disabled while a conversation loads, so Enter reaches this handler and
    // would post a question against a thread whose history has not arrived.
    if (!input.trim() || isStreaming || isBusy || threadLoadState === 'loading') return;
```

and its dependency array (`:194-197`):

```tsx
// old
  }, [
    input, model, isStreaming, isBusy, conversationId, pageId, includeSubPages, thinkingMode,
    deepSearch, documents, image, externalUrls, setInput, setMessages, removeImage, runStream,
  ]);

// new
  }, [
    input, model, isStreaming, isBusy, conversationId, pageId, includeSubPages, thinkingMode,
    deepSearch, documents, image, externalUrls, setInput, setMessages, removeImage, runStream,
    threadLoadState,
  ]);
```

Send (`:344-346`):

```tsx
// old
          disabled={isStreaming || isBusy || !input.trim() || !model}

// new
          disabled={isStreaming || isBusy || !input.trim() || !model || threadLoadState === 'loading'}
```

- [ ] **Step 4: Key the attachment scope on the active thread**

`frontend/src/features/ai/AssistantAttachments.tsx` — `pageId` was this boundary's only consumer, so it leaves the destructure with it:

```tsx
// old
  const {
    mode, pageId, isStreaming, chatVision, chatVisionModel,
  } = useAiContext();

// new
  const {
    mode, activeThreadId, isStreaming, chatVision, chatVisionModel,
  } = useAiContext();
```

```tsx
// old
  const { clearAll } = attachments;
  useEffect(() => {
    // Uploaded sources describe the page/request they were prepared beside.
    // Do not let them silently cross into another page context.
    clearAll();
  }, [pageId, clearAll]);

// new
  const { clearAll } = attachments;
  useEffect(() => {
    // Uploaded sources describe the request they were prepared beside. Do not
    // let them silently cross into another one.
    //
    // Keyed on `activeThreadId` (#1361), not `pageId`: on /ai every thread
    // resolves to no document, so `pageId` was `null` for all of them and
    // nothing cleared between conversations. It still covers the dock's
    // boundary — a page change is a different `page:` key and therefore a
    // different identity.
    clearAll();
  }, [activeThreadId, clearAll]);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/features/ai/modes/AskMode.test.tsx`

Expected: PASS, whole file — including the four pre-existing non-stickiness cells, which are unchanged.

- [ ] **Step 6: Run the neighbouring composer suites**

Run:
```bash
cd frontend && npx vitest run src/features/ai src/shared/hooks/use-attachments.test.ts
```
Expected: green. `ImproveMode.attachments.test.tsx`, `GenerateMode.image.test.tsx`, `AiDock.upload.test.tsx` and `AiDock.image.test.tsx` all mount `AssistantAttachmentsScope`; they mount it once per test and never change threads, so the boundary change is inert for them — a failure here means `activeThreadId` is unstable across ordinary renders, which is a Task 2 defect, not this one.

- [ ] **Step 7: Run the guard suites this task touches** and `npx tsc --noEmit`

Run:
```bash
cd frontend && npx vitest run src/flat-components.test.ts src/ui-text-legibility.test.ts src/focus-ring-contrast.test.ts
cd frontend && npx tsc --noEmit
cd frontend && npm run lint
```
Expected: all green. No class strings changed in this task, so the three visual guards are a regression check rather than a subject.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/features/ai/modes/AskMode.tsx frontend/src/features/ai/modes/AskMode.test.tsx frontend/src/features/ai/AssistantAttachments.tsx
git commit -m "feat(ai): scope composer state to activeThreadId, focus on New chat (#1361)

Deep Search, external URLs and the assistant attachment scope now reset on
activeThreadId instead of conversationId/pageId — a promotion is a re-key and
must not clear them, while New chat on an empty draft must. The composer
focuses on every composerFocusRequest, and Send (and Enter) are refused while
the open conversation is still loading.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

## Part B — The conversation pane (Tasks 7–13)

### Task 7: Recency groups (`groupByRecency`)

Implements spec §*Recency groups* (`docs/superpowers/specs/2026-08-17-ai-conversation-history-design.md`,
the paragraph beginning "`groupByRecency(items, now)` buckets by `updatedAt` against the viewer's
**local** calendar"). Pure leaf module: no React, no network, no contract import.

**Files:**
- Create: `frontend/src/features/ai/conversations/group-by-recency.ts`
- Test: `frontend/src/features/ai/conversations/group-by-recency.test.ts`

**Interfaces:**
- Consumes: nothing. `ConversationSummary` satisfies `{ updatedAt: string }` structurally, so the
  module deliberately imports no contract type and stays testable with two-field fixtures.
- Produces:
  ```ts
  export interface RecencyGroup<T> { label: string; items: T[] }
  export function groupByRecency<T extends { updatedAt: string }>(items: readonly T[], now: Date): RecencyGroup<T>[];
  ```
  Consumed by Task 11 (`ConversationList` groups the filtered rows and renders one `<section>` per
  returned group, in the returned order).

**Pinned here (decisions the spec leaves open):**
- **Fixtures are built with the LOCAL-time `Date(y, m, d, h, min)` constructor, not `Date.UTC`.**
  The function is specified against the *viewer's local calendar*; a fixture built in UTC only
  agrees with that calendar in the zones where the two coincide, so a UTC-built suite is green on
  CI (UTC) and red for a developer in `Europe/Berlin`. `vi.stubEnv('TZ', …)` does not help — Node
  reads `TZ` once at process start and `Date`'s zone is fixed for the run, which is exactly why the
  brief warns against it. Local constructors make the suite zone-independent, which is strictly
  better than fixing one zone.
- **Day arithmetic goes through the constructor's own normalisation** (`new Date(y, m, d - 7)`),
  never `now.getTime() - 7 * 86_400_000`: the millisecond form is an hour out across a DST change,
  which would silently mis-bucket one week per year.
- **An unparseable `updatedAt` lands in `Today`.** `new Intl.DateTimeFormat(...).format(new Date(NaN))`
  throws `RangeError: Invalid time value`, so leaving it to fall through to the month bucket turns
  one bad row into a blank pane. Dropping the row is worse — it hides a conversation. `Today` is
  where an undatable row is least surprising in a list the server hands over newest-first.
- **One `Intl.DateTimeFormat` per call, constructed lazily** when the first month bucket appears —
  constructing the Intl object is the expensive part and most panes never reach a month bucket.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/features/ai/conversations/group-by-recency.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { groupByRecency } from './group-by-recency';

/**
 * `groupByRecency` buckets against the VIEWER'S LOCAL calendar, so every
 * timestamp here is built with the local-time `Date(y, m, d, h, min)`
 * constructor and serialised with `toISOString()` — the round trip preserves
 * the instant, and the expectations are stated in local calendar terms, which
 * is what the function is specified in. A fixture built with `Date.UTC` would
 * pass on CI (UTC) and fail in `Europe/Berlin`; `vi.stubEnv('TZ', …)` cannot
 * rescue it either, because Node reads TZ once at process start and `Date`'s
 * zone is fixed for the whole run.
 *
 * `now` is midday so no boundary this file asserts on can land on a DST
 * transition (those happen at or near midnight), and the day arithmetic in
 * both the test and the implementation goes through the constructor's own
 * normalisation rather than subtracting 86_400_000 ms per day.
 *
 * Fixed now: Tue 18 Aug 2026, 12:00 local.
 *   start of today      = Tue 18 Aug 2026 00:00
 *   start of yesterday  = Mon 17 Aug 2026 00:00
 *   start of today - 7d = Tue 11 Aug 2026 00:00
 *   start of today -30d = Sun 19 Jul 2026 00:00
 */
const NOW = new Date(2026, 7, 18, 12, 0, 0);

/** A local-calendar instant as the wire carries it. */
function at(year: number, monthIndex: number, day: number, hour = 12, minute = 0): string {
  return new Date(year, monthIndex, day, hour, minute, 0, 0).toISOString();
}

function row(id: string, updatedAt: string): { id: string; updatedAt: string } {
  return { id, updatedAt };
}

const monthLabel = (d: Date): string =>
  new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(d);

describe('groupByRecency', () => {
  it('buckets one item per label and returns the buckets in fixed order', () => {
    const items = [
      row('today-midday', at(2026, 7, 18, 11, 0)),
      row('today-midnight', at(2026, 7, 18, 0, 0)),
      row('yesterday-late', at(2026, 7, 17, 23, 59)),
      row('yesterday-early', at(2026, 7, 17, 0, 1)),
      row('seven-boundary', at(2026, 7, 11, 0, 0)),
      row('just-past-seven', at(2026, 7, 10, 23, 59)),
      row('thirty-boundary', at(2026, 6, 19, 0, 0)),
      row('july', at(2026, 6, 18, 23, 59)),
      row('june', at(2026, 5, 2, 9, 0)),
    ];

    const groups = groupByRecency(items, NOW);

    expect(groups.map((g) => g.label)).toEqual([
      'Today',
      'Yesterday',
      'Previous 7 days',
      'Previous 30 days',
      monthLabel(new Date(2026, 6, 18)),
      monthLabel(new Date(2026, 5, 2)),
    ]);
    expect(groups.map((g) => g.items.map((i) => i.id))).toEqual([
      ['today-midday', 'today-midnight'],
      ['yesterday-late', 'yesterday-early'],
      ['seven-boundary'],
      ['just-past-seven', 'thirty-boundary'],
      ['july'],
      ['june'],
    ]);
  });

  it('puts an item at 00:00 today in Today and 23:59 yesterday in Yesterday', () => {
    const groups = groupByRecency(
      [row('midnight-today', at(2026, 7, 18, 0, 0)), row('last-minute-yesterday', at(2026, 7, 17, 23, 59))],
      NOW,
    );
    expect(groups).toEqual([
      { label: 'Today', items: [row('midnight-today', at(2026, 7, 18, 0, 0))] },
      { label: 'Yesterday', items: [row('last-minute-yesterday', at(2026, 7, 17, 23, 59))] },
    ]);
  });

  it('treats start-of-today minus seven days as inclusive and the minute before it as older', () => {
    const groups = groupByRecency(
      [row('on-the-boundary', at(2026, 7, 11, 0, 0)), row('one-minute-older', at(2026, 7, 10, 23, 59))],
      NOW,
    );
    expect(groups.map((g) => g.label)).toEqual(['Previous 7 days', 'Previous 30 days']);
    expect(groups[0]?.items.map((i) => i.id)).toEqual(['on-the-boundary']);
    expect(groups[1]?.items.map((i) => i.id)).toEqual(['one-minute-older']);
  });

  it('treats start-of-today minus thirty days as inclusive and the minute before it as a month bucket', () => {
    const groups = groupByRecency(
      [row('on-the-boundary', at(2026, 6, 19, 0, 0)), row('one-minute-older', at(2026, 6, 18, 23, 59))],
      NOW,
    );
    expect(groups.map((g) => g.label)).toEqual(['Previous 30 days', monthLabel(new Date(2026, 6, 18))]);
  });

  it('labels month buckets with month + numeric year and keeps them newest first', () => {
    const groups = groupByRecency(
      [
        row('july-late', at(2026, 6, 18, 10, 0)),
        row('july-early', at(2026, 6, 2, 10, 0)),
        row('june', at(2026, 5, 20, 10, 0)),
        row('december', at(2025, 11, 24, 10, 0)),
      ],
      NOW,
    );
    expect(groups.map((g) => g.label)).toEqual([
      monthLabel(new Date(2026, 6, 18)),
      monthLabel(new Date(2026, 5, 20)),
      monthLabel(new Date(2025, 11, 24)),
    ]);
    expect(groups[0]?.items.map((i) => i.id)).toEqual(['july-late', 'july-early']);
    // The label carries a four-digit year, so December 2025 can never read the
    // same as December 2026 in a pane that has both.
    expect(groups[2]?.label).toContain('2025');
    expect(groups[0]?.label).toContain('2026');
  });

  it('omits empty buckets', () => {
    const groups = groupByRecency([row('june', at(2026, 5, 2, 9, 0))], NOW);
    expect(groups.map((g) => g.label)).toEqual([monthLabel(new Date(2026, 5, 2))]);
  });

  it('returns nothing for an empty list', () => {
    expect(groupByRecency([], NOW)).toEqual([]);
  });

  it('puts a future updatedAt (clock skew) in Today', () => {
    const groups = groupByRecency([row('skewed', at(2026, 7, 19, 9, 0))], NOW);
    expect(groups.map((g) => g.label)).toEqual(['Today']);
    expect(groups[0]?.items.map((i) => i.id)).toEqual(['skewed']);
  });

  it('puts an unparseable updatedAt in Today rather than throwing out of Intl', () => {
    const groups = groupByRecency([row('broken', 'not-a-date')], NOW);
    expect(groups.map((g) => g.label)).toEqual(['Today']);
    expect(groups[0]?.items.map((i) => i.id)).toEqual(['broken']);
  });

  it('preserves the server order inside a bucket', () => {
    const groups = groupByRecency(
      [
        row('first', at(2026, 7, 18, 11, 0)),
        row('second', at(2026, 7, 18, 10, 0)),
        row('third', at(2026, 7, 18, 9, 0)),
      ],
      NOW,
    );
    expect(groups[0]?.items.map((i) => i.id)).toEqual(['first', 'second', 'third']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/features/ai/conversations/group-by-recency.test.ts`

Expected: FAIL — `Failed to resolve import "./group-by-recency" from "src/features/ai/conversations/group-by-recency.test.ts". Does the file exist?`

- [ ] **Step 3: Write the implementation**

Create `frontend/src/features/ai/conversations/group-by-recency.ts`:

```ts
/**
 * Recency buckets for the conversations pane (#1361 PR 2).
 *
 * The group heading IS the timestamp — rows carry no date of their own — so the
 * buckets are read against the viewer's LOCAL calendar rather than against a
 * rolling 24-hour window: a conversation from 23:50 last night belongs under
 * "Yesterday" at 00:10 this morning, not under "Today".
 *
 * Items arrive `updated_at DESC` from the keyset list, so this is a single pass
 * that appends and never sorts: order inside a bucket is the server's, and the
 * month buckets come out newest-first because that is the order they are first
 * encountered in.
 */

export interface RecencyGroup<T> {
  label: string;
  items: T[];
}

const TODAY_LABEL = 'Today';
const YESTERDAY_LABEL = 'Yesterday';
const PREVIOUS_7_LABEL = 'Previous 7 days';
const PREVIOUS_30_LABEL = 'Previous 30 days';

/**
 * Local midnight `days` calendar days before `d`'s day. The constructor
 * normalises out-of-range day numbers (`new Date(2026, 7, -12)` is 19 Jul 2026)
 * and re-resolves the zone offset for the resulting day, which subtracting
 * `days * 86_400_000` ms does not — that form is an hour out across every DST
 * change and would mis-bucket one week a year.
 */
function startOfDayBefore(d: Date, days: number): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - days).getTime();
}

export function groupByRecency<T extends { updatedAt: string }>(
  items: readonly T[],
  now: Date,
): RecencyGroup<T>[] {
  const startToday = startOfDayBefore(now, 0);
  const startYesterday = startOfDayBefore(now, 1);
  const startPrevious7 = startOfDayBefore(now, 7);
  const startPrevious30 = startOfDayBefore(now, 30);

  const today: T[] = [];
  const yesterday: T[] = [];
  const previous7: T[] = [];
  const previous30: T[] = [];
  const months = new Map<string, T[]>();

  // One formatter for the whole pass, built only if a month bucket is reached —
  // constructing an Intl object is the expensive part, and most panes never
  // hold anything older than thirty days.
  let monthFormat: Intl.DateTimeFormat | undefined;

  for (const item of items) {
    const at = new Date(item.updatedAt);
    const time = at.getTime();

    // A row whose timestamp does not parse must not take the pane down:
    // `Intl.DateTimeFormat.format(new Date(NaN))` throws RangeError. Today is
    // where an undatable row is least surprising in a newest-first list, and it
    // is the same bucket clock skew lands in.
    if (Number.isNaN(time) || time >= startToday) {
      today.push(item);
      continue;
    }
    if (time >= startYesterday) {
      yesterday.push(item);
      continue;
    }
    if (time >= startPrevious7) {
      previous7.push(item);
      continue;
    }
    if (time >= startPrevious30) {
      previous30.push(item);
      continue;
    }

    monthFormat ??= new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });
    const label = monthFormat.format(at);
    const bucket = months.get(label);
    if (bucket) bucket.push(item);
    else months.set(label, [item]);
  }

  const groups: RecencyGroup<T>[] = [];
  if (today.length > 0) groups.push({ label: TODAY_LABEL, items: today });
  if (yesterday.length > 0) groups.push({ label: YESTERDAY_LABEL, items: yesterday });
  if (previous7.length > 0) groups.push({ label: PREVIOUS_7_LABEL, items: previous7 });
  if (previous30.length > 0) groups.push({ label: PREVIOUS_30_LABEL, items: previous30 });
  // Map preserves insertion order, and insertion order is encounter order,
  // which is newest-first for a `updated_at DESC` list.
  for (const [label, bucket] of months) groups.push({ label, items: bucket });
  return groups;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/features/ai/conversations/group-by-recency.test.ts`

Expected: PASS — 10 tests.

- [ ] **Step 5: Typecheck and lint**

Run:
```bash
cd frontend && npx tsc --noEmit
npx eslint --max-warnings=0 src/features/ai/conversations/group-by-recency.ts src/features/ai/conversations/group-by-recency.test.ts
```
Expected: both clean. (`tsconfig.json` excludes `src/**/*.test.ts`, so `tsc` covers the module only;
eslint covers both.)

No guard suite reads this task's subject: `flat-components.test.ts`, `destructive-treatment.test.ts`,
`ui-text-legibility.test.ts` and `toolbar-rule-alignment.test.ts` all scan component markup and this
task adds none.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/features/ai/conversations/group-by-recency.ts frontend/src/features/ai/conversations/group-by-recency.test.ts
git commit -m "feat(ai): bucket conversations by recency for the history pane

The pane's group heading is the row's only timestamp, so the buckets read the
viewer's local calendar rather than a rolling 24h window, and a single pass over
the already-DESC list keeps server order inside every bucket.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: `useListRovingFocus`

Implements spec §*List semantics and keyboard* — "New hook `useListRovingFocus({ ids, activeId,
containerRef, itemAttr: 'data-row-id' })` returning `{ rovingId, handleRowFocus, handleRowKeyDown }`
— the same contract shape as `useTreeRovingFocus`, the same tie-break (last explicit choice if still
present, else the active id, else the first), and `ArrowUp`/`ArrowDown`/`Home`/`End`. The tree hook
is over-fit for a flat list (expand/collapse, `parentId`, `data-page-id` hardcoded) and is left
alone."

**Files:**
- Create: `frontend/src/shared/hooks/use-list-roving-focus.ts`
- Test: `frontend/src/shared/hooks/use-list-roving-focus.test.ts`
- Read (do not modify): `frontend/src/shared/components/layout/sidebar-tree-keyboard.ts:47-139`
  (the contract being mirrored) and
  `frontend/src/shared/components/article/use-toolbar-roving-focus.ts:96-126`
  (the `root.contains(event.target)` replay guard being borrowed).

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export function useListRovingFocus(opts: {
    ids: readonly string[];
    activeId: string | null;
    containerRef: React.RefObject<HTMLElement | null>;
    itemAttr: string;
  }): {
    rovingId: string | undefined;
    handleRowFocus: (id: string) => void;
    handleRowKeyDown: (event: React.KeyboardEvent, id: string) => void;
  };
  ```
  Consumed by Task 11 (`ConversationList` calls it with the visible ids across all groups after
  filtering, `activeId` from `conversationIdFromPath(location.pathname)`, its `<nav>` ref, and
  `itemAttr: 'data-row-id'`), and its two handlers are threaded to Task 10's `ConversationRow`
  as `onRowFocus` / `onRowKeyDown`.

**Pinned here (decisions the spec leaves open):**
- **Arrows CLAMP, they do not wrap.** Verified by reading `useTreeRovingFocus`
  (`sidebar-tree-keyboard.ts:97-103`): `moveTo(flat[index + 1]?.id)` and `moveTo` returns early on
  `undefined`, so the last row's ArrowDown is a no-op. `useToolbarRovingFocus` wraps, but that is
  the *toolbar* pattern (a short horizontal strip); a vertical list of history rows is the tree's
  pattern, and the two rails must not disagree about what ArrowDown at the bottom does.
  `event.preventDefault()` is still called on the clamped press — the tree does the same, and it
  is what stops the arrow scrolling the pane out from under a stationary tab stop.
- **The replay guard returns early when `containerRef.current` is null**, mirroring
  `useToolbarRovingFocus`'s `if (!root) return;` — no container means no rendered list, so there is
  nothing to move.
- **The test file is `use-list-roving-focus.test.ts`** (the name the spec at §PR 2 and the plan's
  File structure table both give it), so its harness is built with `createElement` rather than JSX.
  `src/shared/hooks/use-permission.test.ts` is the precedent in the same directory.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/shared/hooks/use-list-roving-focus.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { createElement, useRef, type ReactElement, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useListRovingFocus } from './use-list-roving-focus';

/**
 * A minimal stand-in for `ConversationList`: a container holding one focusable
 * row per id, plus one control OUTSIDE the container wired to the same handler.
 * That outside control is how the Radix replay case is exercised — portalled
 * menu content is a React child of the row but not a DOM descendant of the
 * list, so React replays its keydowns up to this handler.
 */
function Harness({ ids, activeId }: { ids: readonly string[]; activeId: string | null }): ReactElement {
  const containerRef = useRef<HTMLUListElement>(null);
  const { rovingId, handleRowFocus, handleRowKeyDown } = useListRovingFocus({
    ids,
    activeId,
    containerRef,
    itemAttr: 'data-row-id',
  });

  return createElement(
    'div',
    null,
    createElement('span', { 'data-testid': 'roving' }, rovingId ?? 'none'),
    createElement(
      'button',
      {
        type: 'button',
        'data-testid': 'outside',
        onKeyDown: (event: ReactKeyboardEvent) => handleRowKeyDown(event, ids[0] ?? ''),
      },
      'outside',
    ),
    createElement(
      'ul',
      { ref: containerRef },
      ids.map((id) =>
        createElement(
          'li',
          { key: id },
          createElement(
            'a',
            {
              href: '#',
              'data-row-id': id,
              'data-testid': `row-${id}`,
              tabIndex: rovingId === id ? 0 : -1,
              onFocus: () => handleRowFocus(id),
              onKeyDown: (event: ReactKeyboardEvent) => handleRowKeyDown(event, id),
            },
            id,
          ),
        ),
      ),
    ),
  );
}

const IDS = ['a', 'b', 'c'];

function renderHarness(props: { ids?: readonly string[]; activeId?: string | null } = {}) {
  const { ids = IDS, activeId = null } = props;
  return render(createElement(Harness, { ids, activeId }));
}

const roving = () => screen.getByTestId('roving').textContent;

describe('useListRovingFocus', () => {
  it('makes the first row the tab stop when nothing is active', () => {
    renderHarness();
    expect(roving()).toBe('a');
  });

  it('makes the active row the tab stop when it is in the list', () => {
    renderHarness({ activeId: 'c' });
    expect(roving()).toBe('c');
  });

  it('falls back to the first row when the active id is not in the list', () => {
    renderHarness({ activeId: 'zzz' });
    expect(roving()).toBe('a');
  });

  it('is undefined for an empty list, so nothing claims a tab stop', () => {
    renderHarness({ ids: [] });
    expect(roving()).toBe('none');
  });

  it('moves the tab stop with ArrowDown and gives the row real DOM focus', () => {
    renderHarness();
    fireEvent.keyDown(screen.getByTestId('row-a'), { key: 'ArrowDown' });
    expect(roving()).toBe('b');
    expect(document.activeElement).toBe(screen.getByTestId('row-b'));
  });

  it('moves the tab stop back with ArrowUp', () => {
    renderHarness({ activeId: 'c' });
    fireEvent.keyDown(screen.getByTestId('row-c'), { key: 'ArrowUp' });
    expect(roving()).toBe('b');
    expect(document.activeElement).toBe(screen.getByTestId('row-b'));
  });

  it('clamps at the end: ArrowDown on the last row does not wrap to the first', () => {
    renderHarness({ activeId: 'c' });
    fireEvent.keyDown(screen.getByTestId('row-c'), { key: 'ArrowDown' });
    expect(roving()).toBe('c');
  });

  it('clamps at the start: ArrowUp on the first row does not wrap to the last', () => {
    renderHarness();
    fireEvent.keyDown(screen.getByTestId('row-a'), { key: 'ArrowUp' });
    expect(roving()).toBe('a');
  });

  it('Home goes to the first row and End to the last', () => {
    renderHarness({ activeId: 'b' });
    fireEvent.keyDown(screen.getByTestId('row-b'), { key: 'End' });
    expect(roving()).toBe('c');
    expect(document.activeElement).toBe(screen.getByTestId('row-c'));

    fireEvent.keyDown(screen.getByTestId('row-c'), { key: 'Home' });
    expect(roving()).toBe('a');
    expect(document.activeElement).toBe(screen.getByTestId('row-a'));
  });

  it('takes the tab stop from a row that receives focus directly', () => {
    renderHarness();
    fireEvent.focus(screen.getByTestId('row-c'));
    expect(roving()).toBe('c');
  });

  it('keeps an explicit choice across a list change while the row is still present', () => {
    const { rerender } = renderHarness();
    fireEvent.keyDown(screen.getByTestId('row-a'), { key: 'ArrowDown' });
    expect(roving()).toBe('b');

    rerender(createElement(Harness, { ids: ['b', 'c'], activeId: null }));
    expect(roving()).toBe('b');
  });

  it('falls back to the active row when the explicit choice leaves the list', () => {
    const { rerender } = renderHarness({ activeId: 'c' });
    fireEvent.keyDown(screen.getByTestId('row-c'), { key: 'Home' });
    expect(roving()).toBe('a');

    rerender(createElement(Harness, { ids: ['b', 'c'], activeId: 'c' }));
    expect(roving()).toBe('c');
  });

  it('falls back to the first row when the explicit choice leaves and nothing is active', () => {
    const { rerender } = renderHarness();
    fireEvent.keyDown(screen.getByTestId('row-a'), { key: 'End' });
    expect(roving()).toBe('c');

    rerender(createElement(Harness, { ids: ['a', 'b'], activeId: null }));
    expect(roving()).toBe('a');
  });

  it('ignores a keydown whose target is outside the container (Radix replays through the React tree)', () => {
    renderHarness();
    fireEvent.keyDown(screen.getByTestId('outside'), { key: 'ArrowDown' });
    expect(roving()).toBe('a');
  });

  it('ignores a key it does not own, so ArrowRight stays available to the row', () => {
    renderHarness();
    const event = fireEvent.keyDown(screen.getByTestId('row-a'), { key: 'ArrowRight', cancelable: true });
    expect(roving()).toBe('a');
    // `fireEvent` returns false when a handler called preventDefault.
    expect(event).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/shared/hooks/use-list-roving-focus.test.ts`

Expected: FAIL — `Failed to resolve import "./use-list-roving-focus" from "src/shared/hooks/use-list-roving-focus.test.ts". Does the file exist?`

- [ ] **Step 3: Write the implementation**

Create `frontend/src/shared/hooks/use-list-roving-focus.ts`:

```ts
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';

interface UseListRovingFocusOptions {
  /** The visible rows, in render order — across every group, after filtering. */
  ids: readonly string[];
  /** The row the route currently shows, if it is in `ids`. */
  activeId: string | null;
  /** Scopes both the post-navigation `.focus()` and the replay guard to this list. */
  containerRef: RefObject<HTMLElement | null>;
  /** The attribute the rows carry their id in — `data-row-id` for the pane. */
  itemAttr: string;
}

/**
 * ARIA APG roving tabindex for a FLAT vertical list (#1361 PR 2), the
 * conversations pane's counterpart to `useTreeRovingFocus`.
 *
 * The list is one tab stop: Up/Down/Home/End move it, Tab leaves the list
 * entirely, so a fifty-row history costs a keyboard user one stop rather than
 * fifty. It is a separate hook rather than a widened tree hook because the tree
 * one is over-fit — expand/collapse, `parentId`, a hardcoded `data-page-id` —
 * and none of that has a meaning here.
 *
 * Two details are load-bearing:
 *
 * 1. **The `contains` guard.** Each row hosts a Radix `DropdownMenu`, and
 *    portalled Radix content is a React child of the row even though it is not
 *    a DOM descendant of the list. React replays events up the *React* tree, so
 *    an ArrowDown pressed inside an open row menu arrives here. Without the
 *    guard it would move the list's tab stop out from under an open menu.
 *    `container.contains(event.target)` is false for portalled content, which
 *    is exactly the discrimination needed (`useToolbarRovingFocus` guards the
 *    editor toolbar the same way, for the same reason).
 *
 * 2. **Horizontal arrows are not claimed.** `ArrowRight` moves focus to the
 *    row's kebab and `ArrowLeft` brings it back; both belong to the row, which
 *    handles them before delegating everything else here.
 *
 * Arrows CLAMP rather than wrap, matching `useTreeRovingFocus` — the two rails
 * must not disagree about what ArrowDown at the bottom does.
 */
export function useListRovingFocus({
  ids,
  activeId,
  containerRef,
  itemAttr,
}: UseListRovingFocusOptions): {
  rovingId: string | undefined;
  handleRowFocus: (id: string) => void;
  handleRowKeyDown: (event: React.KeyboardEvent, id: string) => void;
} {
  const [explicitRovingId, setExplicitRovingId] = useState<string | undefined>(undefined);
  const pendingFocusRef = useRef(false);

  // The tab-stoppable row: the user's last explicit choice if it survived the
  // last list change, else the open conversation, else the first row — never
  // "nothing" while there are rows, or Tab would skip the list entirely.
  const rovingId = useMemo(() => {
    if (explicitRovingId && ids.includes(explicitRovingId)) return explicitRovingId;
    if (activeId && ids.includes(activeId)) return activeId;
    return ids[0];
  }, [explicitRovingId, ids, activeId]);

  // Arrow moves set `explicitRovingId` and mark a DOM focus() pending — React
  // re-renders the new row's tabIndex to 0 first, then this effect moves real
  // focus onto it. A click already carries native focus (routed through
  // `handleRowFocus`), so it never sets the flag.
  useEffect(() => {
    if (!pendingFocusRef.current) return;
    pendingFocusRef.current = false;
    const container = containerRef.current;
    if (!container || !rovingId) return;
    const row = container.querySelector<HTMLElement>(`[${itemAttr}="${CSS.escape(rovingId)}"]`);
    row?.focus();
  }, [rovingId, containerRef, itemAttr]);

  const moveTo = useCallback((id: string | undefined) => {
    if (!id) return;
    pendingFocusRef.current = true;
    setExplicitRovingId(id);
  }, []);

  const handleRowFocus = useCallback((id: string) => {
    setExplicitRovingId(id);
  }, []);

  const handleRowKeyDown = useCallback(
    (event: React.KeyboardEvent, id: string) => {
      const container = containerRef.current;
      if (!container || !container.contains(event.target as Node)) return;

      const index = ids.indexOf(id);
      if (index === -1) return;

      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          moveTo(ids[index + 1]);
          break;
        case 'ArrowUp':
          event.preventDefault();
          moveTo(ids[index - 1]);
          break;
        case 'Home':
          event.preventDefault();
          moveTo(ids[0]);
          break;
        case 'End':
          event.preventDefault();
          moveTo(ids[ids.length - 1]);
          break;
        default:
          break;
      }
    },
    [ids, containerRef, moveTo],
  );

  return { rovingId, handleRowFocus, handleRowKeyDown };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/shared/hooks/use-list-roving-focus.test.ts`

Expected: PASS — 15 tests.

- [ ] **Step 5: Confirm the tree hook was not disturbed**

Run: `cd frontend && npx vitest run src/shared/components/layout/SidebarTreeView.test.tsx`

Expected: PASS. The new hook is additive — `sidebar-tree-keyboard.ts` is read, never edited — and
this run is the evidence for that, since the two hooks share a rail and a contract shape.

- [ ] **Step 6: Typecheck and lint**

Run:
```bash
cd frontend && npx tsc --noEmit
npx eslint --max-warnings=0 src/shared/hooks/use-list-roving-focus.ts src/shared/hooks/use-list-roving-focus.test.ts
```
Expected: both clean. No guard suite reads this task's subject (no markup, no CSS, no docs).

- [ ] **Step 7: Commit**

```bash
git add frontend/src/shared/hooks/use-list-roving-focus.ts frontend/src/shared/hooks/use-list-roving-focus.test.ts
git commit -m "feat(ui): flat-list roving tabindex hook for the conversations pane

One tab stop for a fifty-row history, with the tree hook's tie-break and clamp
so the two rails behave the same, and the toolbar hook's contains() guard so an
open row menu's arrows never move the list under it.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: `useConversationList` and the rename / delete mutations

Implements spec §*The conversation pane* table rows `use-conversation-list.ts` and
`use-conversation-mutations.ts`, §*Invalidation*, §*Inline rename* (the commit rules the mutation
owns) and §*Delete*. This is the pane's server state: `AiContext`'s `useState` mirror and its
`conversationsQuery` are gone as of Task 2, so this query is the only reader of
`GET /llm/conversations` (ADR-009 — server data lives in TanStack Query).

**Files:**
- Create: `frontend/src/features/ai/conversations/use-conversation-list.ts`
- Test: `frontend/src/features/ai/conversations/use-conversation-list.test.tsx`
- Create: `frontend/src/features/ai/conversations/use-conversation-mutations.ts`
- Test: `frontend/src/features/ai/conversations/use-conversation-mutations.test.tsx`
- Read (do not modify): `packages/contracts/src/schemas/llm.ts:251-287`
  (`ConversationSummarySchema`, `ConversationListQuerySchema`, `ConversationListResponseSchema`,
  `UpdateConversationSchema`), `frontend/src/shared/lib/api.ts:69-165` (`apiFetch`, `ApiError`,
  `failureMessage`), `backend/src/routes/llm/llm-conversations.ts:115-186` (the four routes and
  their exact response shapes).

**Interfaces:**
- Consumes: `purgeConversation: (id: string) => void` from `useAiContext()` (Task 4) — the delete
  mutation's success step.
- Produces:
  ```ts
  // use-conversation-list.ts
  export const CONVERSATIONS_LIST_KEY = ['llm', 'conversations', 'list'] as const;
  export interface ConversationListResult {
    query: UseInfiniteQueryResult<InfiniteData<ConversationListResponse>, ApiError>;
    rows: ConversationSummary[];
  }
  export function useConversationList(): ConversationListResult;

  // use-conversation-mutations.ts
  export interface RenameConversationVariables { id: string; title: string }
  export interface DeleteConversationVariables { id: string; title: string }
  export function useRenameConversation(): UseMutationResult<ConversationSummary, ApiError, RenameConversationVariables>;
  export function useDeleteConversation(): UseMutationResult<void, ApiError, DeleteConversationVariables>;
  ```
  Consumed by Task 11 (`ConversationListProps.list: ReturnType<typeof useConversationList>`), Task 12
  (the chassis calls `useConversationList()` once and threads it down, and measures
  `rows.length` against `CONVERSATION_FILTER_THRESHOLD`) and Task 10 (the row's rename commit and
  the delete confirm).

**Pinned here (decisions the spec leaves open):**
- **`retry: false`, `staleTime: 30_000`.** `retry: false` is what makes Task 11's failure state
  reachable promptly instead of after three silent retries; `30_000` is the deleted mirror query's
  own staleTime (`AiContext.tsx:607-618`), so the pane costs no more requests than the mirror did.
  PR 3's pending-title `refetchInterval` goes beside these, not in this PR.
- **The exported return type is named `ConversationListResult`** — the plan's interface block writes
  the shape inline; naming it is what lets Tasks 11/12 write
  `list: ReturnType<typeof useConversationList>` and read `list.rows` without restating it.
- **The variables types are named `RenameConversationVariables` / `DeleteConversationVariables`**;
  `DeleteConversationVariables.title` is carried but unused by the request — it is the confirm
  dialog's copy (Task 10, *"&lt;title&gt;" will be permanently deleted.*), and one variables object
  is what keeps the dialog, the mutation and any later optimistic update reading the same thing.
- **The rename mutation is SILENT on failure.** The spec puts the remedy in the row — "on failure
  `toast.error` and stay in edit mode" — so a toast here would fire a second one over Task 10's,
  and the row would have no way to keep the user's text on screen while a generic toast claims the
  rename is over.
- **The delete failure copy is `error.message || 'Failed to delete conversation'`.** Nothing in the
  spec's exact-copy list covers it; `ApiError.message` is already the curated backend sentence
  (`api.ts:150` returns a JSON `message` verbatim), and the fallback covers a bodyless failure.
- **`encodeURIComponent` on both the cursor and the id.** Real cursors are `base64url`
  (`llm-conversations.ts:67-69`), which needs no escaping, and ids are UUIDs — but the encoder is
  one call and it is what stops a future cursor format from silently truncating the query string.
- **The invalidation key is a module-private `CONVERSATIONS_KEY = ['llm','conversations']`**, not a
  new export: `AiContext` invalidates the same prefix as a literal (Task 4/5), and two literals in
  two modules is what the plan's interface block already pins.

- [ ] **Step 1: Write the failing list test**

Create `frontend/src/features/ai/conversations/use-conversation-list.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { ConversationListResponse, ConversationSummary } from '@compendiq/contracts';
import { ApiError } from '../../../shared/lib/api';
import { useConversationList, CONVERSATIONS_LIST_KEY } from './use-conversation-list';

function summary(id: string, title: string): ConversationSummary {
  return {
    id,
    title,
    titleSource: 'question',
    model: 'test-model',
    pageId: null,
    pageTitle: null,
    createdAt: '2026-08-18T09:00:00.000Z',
    updatedAt: '2026-08-18T09:00:00.000Z',
  };
}

function jsonResponse(body: ConversationListResponse): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function createWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useConversationList', () => {
  it('is keyed under the invalidation prefix the rest of the app uses', () => {
    expect(CONVERSATIONS_LIST_KEY).toEqual(['llm', 'conversations', 'list']);
    // A prefix invalidation of ['llm','conversations'] must reach this key, or
    // every ask, rename and delete would leave a stale list behind.
    expect(CONVERSATIONS_LIST_KEY.slice(0, 2)).toEqual(['llm', 'conversations']);
  });

  it('fetches the first page with no cursor and flattens its items into rows', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ items: [summary('a', 'Alpha'), summary('b', 'Beta')], nextCursor: null }));

    const { result } = renderHook(() => useConversationList(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    expect(result.current.rows.map((r) => r.id)).toEqual(['a', 'b']);
    expect(result.current.query.hasNextPage).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/llm/conversations');
  });

  it('pages the server with ?cursor= and appends the second page to rows', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ items: [summary('a', 'Alpha')], nextCursor: 'cur-1' }))
      .mockResolvedValueOnce(jsonResponse({ items: [summary('b', 'Beta')], nextCursor: null }));

    const { result } = renderHook(() => useConversationList(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    expect(result.current.query.hasNextPage).toBe(true);

    await act(async () => {
      await result.current.query.fetchNextPage();
    });

    await waitFor(() => expect(result.current.rows).toHaveLength(2));
    expect(result.current.rows.map((r) => r.id)).toEqual(['a', 'b']);
    expect(result.current.query.hasNextPage).toBe(false);
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/llm/conversations?cursor=cur-1');
  });

  it('percent-encodes the cursor into the query string', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ items: [summary('a', 'Alpha')], nextCursor: 'a+b/c=' }))
      .mockResolvedValueOnce(jsonResponse({ items: [], nextCursor: null }));

    const { result } = renderHook(() => useConversationList(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));

    await act(async () => {
      await result.current.query.fetchNextPage();
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/llm/conversations?cursor=a%2Bb%2Fc%3D');
  });

  it('surfaces a failed fetch as an ApiError and does not retry', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ message: 'Database unavailable' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const { result } = renderHook(() => useConversationList(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.query.isError).toBe(true));
    expect(result.current.query.error).toBeInstanceOf(ApiError);
    expect(result.current.query.error?.message).toBe('Database unavailable');
    // Task 11 renders the failed-with-nothing-cached block off exactly this.
    expect(result.current.rows).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the loaded rows when a later page fails, so the list can degrade rather than disappear', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ items: [summary('a', 'Alpha')], nextCursor: 'cur-1' }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'Database unavailable' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    const { result } = renderHook(() => useConversationList(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));

    await act(async () => {
      await result.current.query.fetchNextPage();
    });

    await waitFor(() => expect(result.current.query.isError).toBe(true));
    expect(result.current.rows.map((r) => r.id)).toEqual(['a']);
  });
});
```

- [ ] **Step 2: Run the list test to verify it fails**

Run: `cd frontend && npx vitest run src/features/ai/conversations/use-conversation-list.test.tsx`

Expected: FAIL — `Failed to resolve import "./use-conversation-list" from "src/features/ai/conversations/use-conversation-list.test.tsx". Does the file exist?`

- [ ] **Step 3: Write `use-conversation-list.ts`**

Create `frontend/src/features/ai/conversations/use-conversation-list.ts`:

```ts
import { useMemo } from 'react';
import {
  useInfiniteQuery,
  type InfiniteData,
  type UseInfiniteQueryResult,
} from '@tanstack/react-query';
import type { ConversationListResponse, ConversationSummary } from '@compendiq/contracts';
import { apiFetch, type ApiError } from '../../../shared/lib/api';

/**
 * The conversations pane owns its server state (#1361 PR 2). `AiContext`'s
 * `useState` mirror and its `['llm','conversations']` query are deleted, so
 * this is the single reader of `GET /llm/conversations` (ADR-009).
 *
 * The key is three segments deep on purpose. Everything that moves a row or its
 * position invalidates the PREFIX `['llm','conversations']` — every ask that
 * carries or acquires a conversation id, the stale-404 recovery, rename and
 * delete — so one invalidation reaches this list and anything later work keys
 * beneath the same prefix (PR 3's pending-title poll) without either side
 * naming the other.
 */
export const CONVERSATIONS_LIST_KEY = ['llm', 'conversations', 'list'] as const;

export interface ConversationListResult {
  query: UseInfiniteQueryResult<InfiniteData<ConversationListResponse>, ApiError>;
  /** Every loaded page's items, flattened, in server order (`updated_at DESC`). */
  rows: ConversationSummary[];
}

export function useConversationList(): ConversationListResult {
  const query = useInfiniteQuery<
    ConversationListResponse,
    ApiError,
    InfiniteData<ConversationListResponse>,
    typeof CONVERSATIONS_LIST_KEY,
    string | undefined
  >({
    queryKey: CONVERSATIONS_LIST_KEY,
    queryFn: ({ pageParam }) =>
      apiFetch<ConversationListResponse>(
        pageParam === undefined
          ? '/llm/conversations'
          : `/llm/conversations?cursor=${encodeURIComponent(pageParam)}`,
      ),
    initialPageParam: undefined,
    // The route answers `nextCursor: null` on the last page; TanStack reads
    // `undefined` as "no next page" and would take a null for a real page param.
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    // A failed list is a FAILURE the pane renders (the three list states), not
    // something to hide behind three silent retries — the tree learned this.
    retry: false,
    staleTime: 30_000,
  });

  const rows = useMemo(
    () => query.data?.pages.flatMap((page) => page.items) ?? [],
    [query.data],
  );

  return { query, rows };
}
```

- [ ] **Step 4: Run the list test to verify it passes**

Run: `cd frontend && npx vitest run src/features/ai/conversations/use-conversation-list.test.tsx`

Expected: PASS — 6 tests.

- [ ] **Step 5: Write the failing mutations test**

Create `frontend/src/features/ai/conversations/use-conversation-mutations.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { ConversationSummary } from '@compendiq/contracts';
import { useRenameConversation, useDeleteConversation } from './use-conversation-mutations';

const { purgeConversation, toastSuccess, toastError } = vi.hoisted(() => ({
  purgeConversation: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));

/**
 * `purgeConversation` is the delete mutation's one non-network dependency and
 * is the AI context's public seam (Task 4), so the context module is the
 * boundary this test stubs — not an internal component. Mounting the real
 * `AiProvider` would drag the models, embedding-status and page-context queries
 * into a mutation test and prove nothing about either mutation.
 */
vi.mock('../AiContext', () => ({
  useAiContext: () => ({ purgeConversation }),
}));

function summary(id: string, title: string): ConversationSummary {
  return {
    id,
    title,
    titleSource: 'user',
    model: 'test-model',
    pageId: null,
    pageTitle: null,
    createdAt: '2026-08-18T09:00:00.000Z',
    updatedAt: '2026-08-18T09:00:00.000Z',
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function renderMutations() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  const { result } = renderHook(
    () => ({ rename: useRenameConversation(), remove: useDeleteConversation() }),
    { wrapper: Wrapper },
  );
  return { result, invalidate };
}

beforeEach(() => {
  // `mockReset`, not `mockClear`: the ordering test below installs an
  // implementation on `purgeConversation`, and a leftover one would push into a
  // dead array on every later test in the file.
  purgeConversation.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useRenameConversation', () => {
  it('PATCHes the title and invalidates the conversations prefix', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(summary('c1', 'Renamed')));

    const { result, invalidate } = renderMutations();
    await act(async () => {
      await result.current.rename.mutateAsync({ id: 'c1', title: 'Renamed' });
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/llm/conversations/c1',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ title: 'Renamed' }) }),
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['llm', 'conversations'] });
    expect(result.current.rename.data?.title).toBe('Renamed');
  });

  it('stays silent on failure so the row can keep the field open and toast once', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ message: 'Title already used' }, 409));

    const { result, invalidate } = renderMutations();
    await act(async () => {
      await result.current.rename.mutateAsync({ id: 'c1', title: 'x' }).catch(() => undefined);
    });

    expect(result.current.rename.isError).toBe(true);
    expect(result.current.rename.error?.message).toBe('Title already used');
    expect(toastError).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe('useDeleteConversation', () => {
  it('DELETEs, purges the retained thread, invalidates and confirms', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ message: 'Conversation deleted' }));

    const { result, invalidate } = renderMutations();
    await act(async () => {
      await result.current.remove.mutateAsync({ id: 'c1', title: 'Alpha' });
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/llm/conversations/c1',
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(purgeConversation).toHaveBeenCalledWith('c1');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['llm', 'conversations'] });
    expect(toastSuccess).toHaveBeenCalledWith('Conversation deleted');
  });

  it('purges before it invalidates, so the refetch lands on a URL that still exists', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ message: 'Conversation deleted' }));

    const order: string[] = [];
    purgeConversation.mockImplementation(() => order.push('purge'));
    const { result, invalidate } = renderMutations();
    invalidate.mockImplementation(() => {
      order.push('invalidate');
      return Promise.resolve();
    });

    await act(async () => {
      await result.current.remove.mutateAsync({ id: 'c1', title: 'Alpha' });
    });

    expect(order).toEqual(['purge', 'invalidate']);
  });

  it('reports a failed delete and purges nothing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ message: 'Conversation not found' }, 404));

    const { result, invalidate } = renderMutations();
    await act(async () => {
      await result.current.remove.mutateAsync({ id: 'c1', title: 'Alpha' }).catch(() => undefined);
    });

    expect(toastError).toHaveBeenCalledWith('Conversation not found');
    expect(purgeConversation).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('falls back to a plain sentence when the failure carries no message', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 503 }));

    const { result } = renderMutations();
    await act(async () => {
      await result.current.remove.mutateAsync({ id: 'c1', title: 'Alpha' }).catch(() => undefined);
    });

    // `failureMessage` composes "<statusText> (HTTP 503)" or "Request failed
    // (HTTP 503)"; either way it is non-empty, so the fallback string is the
    // belt for a message that is empty rather than absent.
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(String(toastError.mock.calls[0]?.[0])).toContain('503');
  });
});
```

- [ ] **Step 6: Run the mutations test to verify it fails**

Run: `cd frontend && npx vitest run src/features/ai/conversations/use-conversation-mutations.test.tsx`

Expected: FAIL — `Failed to resolve import "./use-conversation-mutations" from "src/features/ai/conversations/use-conversation-mutations.test.tsx". Does the file exist?`

- [ ] **Step 7: Write `use-conversation-mutations.ts`**

Create `frontend/src/features/ai/conversations/use-conversation-mutations.ts`:

```ts
import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { ConversationSummary } from '@compendiq/contracts';
import { apiFetch, type ApiError } from '../../../shared/lib/api';
import { useAiContext } from '../AiContext';

/**
 * The prefix every conversation-changing event invalidates (#1361 §Invalidation).
 * `CONVERSATIONS_LIST_KEY` sits under it, so one invalidation reaches the list
 * without these mutations importing it — and `AiContext` invalidates the same
 * literal from the ask path.
 */
const CONVERSATIONS_KEY = ['llm', 'conversations'] as const;

export interface RenameConversationVariables {
  id: string;
  title: string;
}

export interface DeleteConversationVariables {
  id: string;
  /**
   * Not sent — the request needs only `id`. It rides along because the confirm
   * dialog names it ("<title>" will be permanently deleted.), so the dialog,
   * the mutation and any later optimistic update read one object.
   */
  title: string;
}

/**
 * Inline rename (#1361). Deliberately has **no** `onError`: the spec puts the
 * remedy in the row — on failure the input stays open with the user's text and
 * toasts from there — so a toast here would fire a second one over it and would
 * report an edit as finished while the field is still on screen.
 *
 * The route does not bump `updated_at` (a rename must not re-bucket the row
 * into "Today"), so the invalidation is about the title, not the position.
 */
export function useRenameConversation(): UseMutationResult<
  ConversationSummary,
  ApiError,
  RenameConversationVariables
> {
  const queryClient = useQueryClient();
  return useMutation<ConversationSummary, ApiError, RenameConversationVariables>({
    mutationFn: ({ id, title }) =>
      apiFetch<ConversationSummary>(`/llm/conversations/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ title }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: CONVERSATIONS_KEY });
    },
  });
}

/**
 * Delete (#1361, decision 8 — no undo). `purgeConversation` is the thread-side
 * half: it drops the retained `conv:<id>` thread, clears the id off any other
 * thread carrying it, and navigates to `/ai` when the deleted row is the open
 * one. It runs BEFORE the invalidation so the refetch lands on a URL that still
 * exists.
 */
export function useDeleteConversation(): UseMutationResult<
  void,
  ApiError,
  DeleteConversationVariables
> {
  const queryClient = useQueryClient();
  const { purgeConversation } = useAiContext();
  return useMutation<void, ApiError, DeleteConversationVariables>({
    mutationFn: async ({ id }) => {
      await apiFetch(`/llm/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },
    onSuccess: (_data, { id }) => {
      purgeConversation(id);
      void queryClient.invalidateQueries({ queryKey: CONVERSATIONS_KEY });
      toast.success('Conversation deleted');
    },
    onError: (error) => {
      // `ApiError.message` is already the backend's curated sentence; the
      // fallback covers a failure that carried no readable message at all.
      toast.error(error.message || 'Failed to delete conversation');
    },
  });
}
```

- [ ] **Step 8: Run the mutations test to verify it passes**

Run: `cd frontend && npx vitest run src/features/ai/conversations/use-conversation-mutations.test.tsx`

Expected: PASS — 6 tests.

- [ ] **Step 9: Run the whole `conversations` directory plus the AI suites this touches**

Run:
```bash
cd frontend && npx vitest run src/features/ai/conversations src/features/ai/AiContext.threads.test.tsx
```
Expected: PASS. `AiContext.threads.test.tsx` is included because this task is the first consumer of
`purgeConversation` outside `AiContext` itself — a green run is the evidence that Task 4's export is
the shape this hook calls.

- [ ] **Step 10: Run the guard suites and typecheck**

Run:
```bash
cd frontend && npx vitest run src/flat-components.test.ts src/destructive-treatment.test.ts src/ui-text-legibility.test.ts src/toolbar-rule-alignment.test.ts
npx tsc --noEmit
npx eslint --max-warnings=0 src/features/ai/conversations
```
Expected: all green. The four guard suites scan component markup and CSS; Tasks 7–9 add neither, so
this run is a baseline for Tasks 10–13, which do.

- [ ] **Step 11: Commit**

```bash
git add frontend/src/features/ai/conversations/use-conversation-list.ts frontend/src/features/ai/conversations/use-conversation-list.test.tsx frontend/src/features/ai/conversations/use-conversation-mutations.ts frontend/src/features/ai/conversations/use-conversation-mutations.test.tsx
git commit -m "feat(ai): conversation list query and rename/delete mutations

The pane owns its server state now that AiContext's useState mirror is gone: a
keyset useInfiniteQuery under ['llm','conversations','list'], with rename and
delete invalidating the shared prefix. Delete purges the retained thread before
the refetch; rename stays silent on failure so the row keeps the field open.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 10: `ConversationRowMenu` + `ConversationRow` (+ `nm-action-destructive` `data-highlighted`)

Implements spec §Row anatomy, §Kebab menu, §Inline rename, §Delete, and amendment item 8's
`index.css:925-943` note.

**Files:**
- Create: `frontend/src/features/ai/conversations/ConversationRowMenu.tsx`
- Create: `frontend/src/features/ai/conversations/ConversationRow.tsx`
- Test: `frontend/src/features/ai/conversations/ConversationRow.test.tsx` (covers the menu too)
- Modify: `frontend/src/index.css:925-943` (`nm-action-destructive` gains `&[data-highlighted]`)
- Modify: `frontend/src/destructive-treatment.test.ts` (one new assertion for that branch)

**Interfaces:**
- Consumes: `conversationPath(id)` / `conversationIdFromPath(pathname)` (Task 1,
  `shared/lib/ai-routes`); `useRenameConversation()` / `useDeleteConversation()` (Task 9,
  `./use-conversation-mutations`); `ConversationSummary` (`@compendiq/contracts`);
  `neutralChipClass` (`shared/components/badges/neutral-chip`); `absorbPortalEscape`
  (`shared/lib/absorb-portal-escape`); `ConfirmDialog` (`shared/components/ConfirmDialog`);
  `cn` (`shared/lib/cn`).
- Produces:
  ```ts
  export interface ConversationRowProps { conversation: ConversationSummary; tabIndex: 0 | -1; onRowFocus: (id: string) => void; onRowKeyDown: (event: React.KeyboardEvent, id: string) => void; onNavigate?: () => void }
  export function ConversationRow(props: ConversationRowProps): JSX.Element;         // renders the <li>
  export interface ConversationRowMenuProps { conversation: ConversationSummary; open: boolean; onOpenChange: (open: boolean) => void; onRename: () => void; triggerRef: React.RefObject<HTMLButtonElement | null>; visible: boolean }
  export function ConversationRowMenu(props: ConversationRowMenuProps): JSX.Element; // kebab + menu + confirm
  ```

**Pinned here (decisions the spec/brief left open):**
1. **The row derives "am I the open conversation?" from `useLocation()`**, not from a prop:
   `ConversationRowProps` is a binding interface and carries no `isActive`, while the spec
   requires the kebab to be `opacity-100` on the active row and the kebab is a *sibling* of the
   `NavLink` (so `NavLink`'s own `isActive` render-prop cannot reach it). One `useLocation()`
   per row is safe here and is **not** the #960 regression: that one was a `memo`ized tree row
   whose location subscription defeated the memo comparator; these rows are not memoized and
   the list re-renders on navigation anyway (`ConversationList` reads the same pathname for the
   roving `activeId`). The verdict is then handed to the menu as its `visible` prop — which is
   what that prop is for.
2. **The menu is not rendered while the row is in rename mode.** The input is `w-full` and the
   kebab is `absolute right-1`, so leaving it mounted paints a control on top of the field.
   Unmounting is safe *because* `onCloseAutoFocus` is still preventDefaulted for the rename
   path: Radix's `FocusScope` dispatches its unmount-auto-focus from an effect cleanup, which
   runs after the freshly mounted input has taken focus — without the guard, focus would be
   thrown at a trigger that no longer exists (i.e. at `document.body`).
3. **`ArrowDown` (and Enter/Space) pressed on the kebab is left entirely to Radix**, per the
   spec, so the row handler returns without calling `onRowKeyDown` for *any* key on the kebab
   except `ArrowLeft`. Forwarding would have moved the list's roving focus at the same moment
   Radix opened the menu.
4. The rename input selects its text via `onFocus={(e) => e.currentTarget.select()}` beside
   `autoFocus` — React applies `autoFocus` during commit, and this is the one hook that fires
   for it in jsdom as well as the browser.

> **Prerequisite (once per worktree):** `packages/contracts/dist/` is gitignored and can be
> stale — PR 1's `ConversationSummary` may not be in it yet. If the import fails to resolve,
> run `npm run build -w packages/contracts` from the repo root before continuing.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/features/ai/conversations/ConversationRow.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { ConversationSummary } from '@compendiq/contracts';
import { ConversationRow } from './ConversationRow';

const { purgeConversation } = vi.hoisted(() => ({ purgeConversation: vi.fn() }));

// The mutation hooks reach AiContext for `purgeConversation` — that is the row's
// boundary to the shell, not an internal component, so it is stubbed here
// (Global Constraints; the same allowance Task 9's hook tests use).
vi.mock('../AiContext', () => ({
  useAiContext: () => ({ purgeConversation }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const CONVERSATION: ConversationSummary = {
  id: '11111111-1111-4111-8111-111111111111',
  title: 'Rollout plan',
  titleSource: 'question',
  model: 'llama3',
  pageId: null,
  pageTitle: null,
  createdAt: '2026-08-18T09:00:00.000Z',
  updatedAt: '2026-08-18T09:00:00.000Z',
};

const DOCK_CONVERSATION: ConversationSummary = {
  ...CONVERSATION,
  id: '22222222-2222-4222-8222-222222222222',
  title: 'Why does sync stall?',
  pageId: 42,
  pageTitle: 'Sync runbook',
};

/** Radix menus open on pointerdown; fire click too so either primitive works. */
function openMenu(trigger: HTMLElement) {
  fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' });
  fireEvent.click(trigger);
}

function mockApi() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const method = (init?.method ?? 'GET').toUpperCase();
    if (/\/api\/llm\/conversations\/[^/]+$/.test(url) && method === 'PATCH') {
      const title = (JSON.parse(String(init?.body)) as { title: string }).title;
      return new Response(JSON.stringify({ ...CONVERSATION, title }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (/\/api\/llm\/conversations\/[^/]+$/.test(url) && method === 'DELETE') {
      return new Response(null, { status: 204 });
    }
    return new Response('Not found', { status: 404 });
  });
}

const onRowFocus = vi.fn();
const onRowKeyDown = vi.fn();
const onNavigate = vi.fn();

function renderRow(
  conversation: ConversationSummary = CONVERSATION,
  path = '/ai',
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <ul>
          <ConversationRow
            conversation={conversation}
            tabIndex={0}
            onRowFocus={onRowFocus}
            onRowKeyDown={onRowKeyDown}
            onNavigate={onNavigate}
          />
        </ul>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const link = () => screen.getByRole('link');
const kebab = () => screen.getByRole('button', { name: `Actions for ${CONVERSATION.title}` });

describe('ConversationRow', () => {
  let fetchSpy: ReturnType<typeof mockApi>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = mockApi();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('carries the full title in `title` — the 320px drawer truncates, this is the recovery path', () => {
    renderRow();
    expect(link()).toHaveAttribute('title', 'Rollout plan');
    expect(link()).toHaveAttribute('data-row-id', CONVERSATION.id);
    expect(link()).toHaveAttribute('href', `/ai/c/${CONVERSATION.id}`);
  });

  it('marks the open conversation with aria-current="page" and nothing else with it', () => {
    const { unmount } = renderRow(CONVERSATION, `/ai/c/${CONVERSATION.id}`);
    expect(link()).toHaveAttribute('aria-current', 'page');
    unmount();

    renderRow(CONVERSATION, '/ai');
    expect(link()).not.toHaveAttribute('aria-current');
  });

  it('renders no per-row icon', () => {
    renderRow();
    expect(link().querySelector('svg')).toBeNull();
  });

  it('renders the page chip only for a dock-origin row, with an sr-only "Page: " prefix', () => {
    const { unmount } = renderRow();
    expect(link().querySelector('[title="Sync runbook"]')).toBeNull();
    unmount();

    renderRow(DOCK_CONVERSATION);
    const chip = link().querySelector<HTMLElement>('[title="Sync runbook"]');
    expect(chip).not.toBeNull();
    // The prefix is real text, not an aria-label on a span (prohibited naming),
    // so the link's accessible name reads "<title> Page: <page>".
    expect(chip!.textContent).toBe('Page: Sync runbook');
    expect(chip!.querySelector('.sr-only')?.textContent).toBe('Page: ');
    expect(chip!.className).toContain('max-w-[45%]');
  });

  it('names the kebab after the row it acts on', () => {
    renderRow();
    expect(kebab()).toHaveAttribute('aria-label', 'Actions for Rollout plan');
    expect(kebab()).toHaveAttribute('tabindex', '-1');
    expect(kebab().className).toContain('size-6');
  });

  it('hides the kebab until hover/focus, and never on the active row', () => {
    const { unmount } = renderRow(CONVERSATION, '/ai');
    expect(kebab().className).toContain('opacity-0');
    expect(kebab().className).toContain('group-focus-within/row:opacity-100');
    unmount();

    renderRow(CONVERSATION, `/ai/c/${CONVERSATION.id}`);
    expect(kebab().className).not.toContain('opacity-0');
  });

  it('ArrowRight reaches the kebab and ArrowLeft returns to the link', () => {
    renderRow();
    link().focus();
    fireEvent.keyDown(link(), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(kebab());

    fireEvent.keyDown(kebab(), { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(link());
  });

  it('forwards other keys to the list handler, but never a key pressed on the kebab', () => {
    renderRow();
    fireEvent.keyDown(link(), { key: 'ArrowDown' });
    expect(onRowKeyDown).toHaveBeenCalledTimes(1);
    expect(onRowKeyDown.mock.calls[0]![1]).toBe(CONVERSATION.id);

    onRowKeyDown.mockClear();
    // ArrowDown on the kebab is Radix's Trigger contract; the list must not move.
    fireEvent.keyDown(kebab(), { key: 'ArrowDown' });
    expect(onRowKeyDown).not.toHaveBeenCalled();
  });

  it('opens the menu on Shift+F10', async () => {
    renderRow();
    fireEvent.keyDown(link(), { key: 'F10', shiftKey: true });
    expect(await screen.findByRole('menu')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();
  });

  it('keeps arrows pressed inside the open (portalled) menu away from the list', async () => {
    renderRow();
    openMenu(kebab());
    const rename = await screen.findByRole('menuitem', { name: 'Rename' });
    onRowKeyDown.mockClear();

    // Radix portals content out of the DOM but not out of the React tree and
    // replays events up it, so this keydown really does reach the <li>'s handler.
    fireEvent.keyDown(rename, { key: 'ArrowDown' });
    expect(onRowKeyDown).not.toHaveBeenCalled();
  });

  it('uses the one destructive treatment on Delete', async () => {
    renderRow();
    openMenu(kebab());
    const del = await screen.findByRole('menuitem', { name: 'Delete' });
    expect(del.className).toContain('nm-action-destructive');
    expect(del.className).not.toContain('hover:bg-destructive/');
  });

  it('Delete confirms, sends the DELETE, purges the thread and reports it', async () => {
    renderRow();
    openMenu(kebab());
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));

    const dialog = await screen.findByTestId('confirm-dialog');
    expect(within(dialog).getByText('Delete conversation?')).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        '"Rollout plan" will be permanently deleted. This can\'t be undone.',
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));

    await waitFor(() => {
      expect(purgeConversation).toHaveBeenCalledWith(CONVERSATION.id);
    });
    const deletes = fetchSpy.mock.calls.filter(
      ([, init]) => (init?.method ?? '').toUpperCase() === 'DELETE',
    );
    expect(deletes).toHaveLength(1);
    expect(String(deletes[0]![0])).toContain(`/llm/conversations/${CONVERSATION.id}`);
    expect(toast.success).toHaveBeenCalledWith('Conversation deleted');
  });

  it('cancelling the confirm sends nothing', async () => {
    renderRow();
    openMenu(kebab());
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    fireEvent.click(await screen.findByTestId('confirm-dialog-cancel'));

    await waitFor(() => {
      expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument();
    });
    expect(
      fetchSpy.mock.calls.some(([, init]) => (init?.method ?? '').toUpperCase() === 'DELETE'),
    ).toBe(false);
  });

  async function startRename() {
    openMenu(kebab());
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    return screen.findByRole('textbox', { name: 'Rename Rollout plan' });
  }

  it('renames in place on Enter and never inside a role="menu"', async () => {
    renderRow();
    const input = await startRename();
    expect(input.closest('[role="menu"]')).toBeNull();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'Rollout plan v2' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      const patches = fetchSpy.mock.calls.filter(
        ([, init]) => (init?.method ?? '').toUpperCase() === 'PATCH',
      );
      expect(patches).toHaveLength(1);
      expect(JSON.parse(String(patches[0]![1]!.body))).toEqual({ title: 'Rollout plan v2' });
    });
    await waitFor(() => expect(document.activeElement).toBe(link()));
  });

  it('commits on blur', async () => {
    renderRow();
    const input = await startRename();
    fireEvent.change(input, { target: { value: 'Renamed by blur' } });
    fireEvent.blur(input);

    await waitFor(() => {
      const patches = fetchSpy.mock.calls.filter(
        ([, init]) => (init?.method ?? '').toUpperCase() === 'PATCH',
      );
      expect(patches).toHaveLength(1);
      expect(JSON.parse(String(patches[0]![1]!.body))).toEqual({ title: 'Renamed by blur' });
    });
  });

  it('Escape cancels, does not commit, and does not reach a document keydown listener', async () => {
    const documentListener = vi.fn();
    document.addEventListener('keydown', documentListener);
    try {
      renderRow();
      const input = await startRename();
      fireEvent.change(input, { target: { value: 'Discard me' } });
      fireEvent.keyDown(input, { key: 'Escape' });

      await waitFor(() => expect(document.activeElement).toBe(link()));
      expect(documentListener).not.toHaveBeenCalled();
      expect(
        fetchSpy.mock.calls.some(([, init]) => (init?.method ?? '').toUpperCase() === 'PATCH'),
      ).toBe(false);
    } finally {
      document.removeEventListener('keydown', documentListener);
    }
  });

  it('treats an empty or unchanged title as a silent cancel', async () => {
    renderRow();
    let input = await startRename();
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.getByRole('link')).toBeInTheDocument());

    input = await startRename();
    fireEvent.change(input, { target: { value: '  Rollout plan  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.getByRole('link')).toBeInTheDocument());

    expect(
      fetchSpy.mock.calls.some(([, init]) => (init?.method ?? '').toUpperCase() === 'PATCH'),
    ).toBe(false);
  });

  it('stays in edit mode and reports a failed rename', async () => {
    fetchSpy.mockImplementation(async () =>
      new Response(JSON.stringify({ message: 'Conversation not found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
    );
    renderRow();
    const input = await startRename();
    fireEvent.change(input, { target: { value: 'Nope' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Conversation not found'));
    expect(screen.getByRole('textbox', { name: 'Rename Rollout plan' })).toBeInTheDocument();
  });

  it('closes the drawer through onNavigate when the row is clicked', () => {
    renderRow();
    fireEvent.click(link());
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/features/ai/conversations/ConversationRow.test.tsx`

Expected: FAIL — `Failed to resolve import "./ConversationRow"` (the component does not exist
yet; `./ConversationRowMenu` and `./use-conversation-mutations` follow behind it).

- [ ] **Step 3: Write `ConversationRowMenu`**

Create `frontend/src/features/ai/conversations/ConversationRowMenu.tsx`:

```tsx
import { useRef, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import type { ConversationSummary } from '@compendiq/contracts';
import { cn } from '../../../shared/lib/cn';
import { absorbPortalEscape } from '../../../shared/lib/absorb-portal-escape';
import { ConfirmDialog } from '../../../shared/components/ConfirmDialog';
import { useDeleteConversation } from './use-conversation-mutations';

/**
 * The app's dropdown item recipe, stated once for the two items below
 * (`UserMenu.tsx:50` is the reference callsite). Delete adds
 * `nm-action-destructive` on top — the one inline destructive treatment.
 */
const MENU_ITEM =
  'flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-sm text-muted-foreground outline-none hover:bg-foreground/5 hover:text-foreground data-[highlighted]:bg-foreground/10 data-[highlighted]:text-foreground transition-colors';

export interface ConversationRowMenuProps {
  conversation: ConversationSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Puts the row into inline rename mode; the row owns that state. */
  onRename: () => void;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  /** Force the kebab visible — the row is the open conversation. */
  visible: boolean;
}

export function ConversationRowMenu({
  conversation,
  open,
  onOpenChange,
  onRename,
  triggerRef,
  visible,
}: ConversationRowMenuProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const deleteConversation = useDeleteConversation();
  // Set by Rename's onSelect and read one tick later by onCloseAutoFocus:
  // Radix returns focus to the trigger as the layer unmounts, in the same tick
  // the freshly mounted input takes it, and the input loses (the EditorToolbar
  // trap). It is also what keeps focus in the field when the row stops
  // rendering this menu entirely while editing.
  const renamePendingRef = useRef(false);

  return (
    <>
      <DropdownMenu.Root open={open} onOpenChange={onOpenChange}>
        <DropdownMenu.Trigger asChild>
          <button
            ref={triggerRef}
            type="button"
            // Reached with ArrowRight from the row, never with Tab: the list is
            // one tab stop and the row link is it.
            tabIndex={-1}
            aria-label={`Actions for ${conversation.title}`}
            className={cn(
              // 24x24 (WCAG 2.5.8). `nm-icon-button` is not usable here — it
              // hard-codes 2rem.
              'absolute right-1 flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
              // opacity-0 keeps it focusable; focus-within reveals it the
              // moment it is (WCAG 1.4.13 / 2.1.1). data-[state=open] is what
              // keeps it visible while the portalled menu holds focus.
              'opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100',
              visible && 'opacity-100',
            )}
          >
            <MoreHorizontal size={14} aria-hidden="true" />
          </button>
        </DropdownMenu.Trigger>

        {/* Portalled, as all six existing callsites are: un-portalled it renders
            inside the pane's overflow-y-auto nav inside the chassis's
            overflow-hidden aside and is clipped for rows near the bottom. */}
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={4}
            className="z-50 min-w-[160px] nm-card-elevated p-1"
            onEscapeKeyDown={(event) => absorbPortalEscape(event, () => onOpenChange(false))}
            onCloseAutoFocus={(event) => {
              if (renamePendingRef.current) {
                renamePendingRef.current = false;
                event.preventDefault();
              }
            }}
          >
            <DropdownMenu.Item
              className={MENU_ITEM}
              onSelect={() => {
                renamePendingRef.current = true;
                onRename();
              }}
            >
              <Pencil size={14} aria-hidden="true" />
              Rename
            </DropdownMenu.Item>
            <DropdownMenu.Item
              className={cn(MENU_ITEM, 'nm-action-destructive')}
              onSelect={() => setConfirmOpen(true)}
            >
              <Trash2 size={14} aria-hidden="true" />
              Delete
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      <ConfirmDialog
        open={confirmOpen}
        destructive
        title="Delete conversation?"
        description={`"${conversation.title}" will be permanently deleted. This can't be undone.`}
        confirmLabel="Delete"
        onConfirm={() => {
          setConfirmOpen(false);
          deleteConversation.mutate({ id: conversation.id, title: conversation.title });
        }}
        // Cancel and Escape do nothing but close (spec §Delete).
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}
```

- [ ] **Step 4: Write `ConversationRow`**

Create `frontend/src/features/ai/conversations/ConversationRow.tsx`:

```tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { toast } from 'sonner';
import type { ConversationSummary } from '@compendiq/contracts';
import { ApiError } from '../../../shared/lib/api';
import { cn } from '../../../shared/lib/cn';
import { neutralChipClass } from '../../../shared/components/badges/neutral-chip';
import { conversationIdFromPath, conversationPath } from '../../../shared/lib/ai-routes';
import { useRenameConversation } from './use-conversation-mutations';
import { ConversationRowMenu } from './ConversationRowMenu';

export interface ConversationRowProps {
  conversation: ConversationSummary;
  /** Roving tabindex: exactly one row in the list is a tab stop. */
  tabIndex: 0 | -1;
  onRowFocus: (id: string) => void;
  onRowKeyDown: (event: React.KeyboardEvent, id: string) => void;
  /** Mobile drawer: close on the tap, not only on the pathname effect. */
  onNavigate?: () => void;
}

export function ConversationRow({
  conversation,
  tabIndex,
  onRowFocus,
  onRowKeyDown,
  onNavigate,
}: ConversationRowProps) {
  const location = useLocation();
  // The kebab is a SIBLING of the NavLink, so NavLink's own isActive cannot
  // reach it. These rows are not memoized, and the list already re-renders on
  // navigation, so this subscription is not the #960 tree regression.
  const isActive = conversationIdFromPath(location.pathname) === conversation.id;

  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(conversation.title);
  const rename = useRenameConversation();

  const rowRef = useRef<HTMLLIElement>(null);
  const linkRef = useRef<HTMLAnchorElement>(null);
  const kebabRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Escape cancels; the blur that follows must not commit what Escape discarded.
  const cancelledRef = useRef(false);
  const returnFocusRef = useRef(false);

  // After commit or cancel, focus returns to the row link.
  useEffect(() => {
    if (editing || !returnFocusRef.current) return;
    returnFocusRef.current = false;
    linkRef.current?.focus();
  }, [editing]);

  const startRename = useCallback(() => {
    cancelledRef.current = false;
    setDraft(conversation.title);
    setEditing(true);
  }, [conversation.title]);

  const exitEditing = useCallback(() => {
    returnFocusRef.current = true;
    setEditing(false);
  }, []);

  const commit = useCallback(async () => {
    if (cancelledRef.current) return;
    const next = draft.trim();
    // Empty or unchanged is a silent cancel — never a PATCH.
    if (!next || next === conversation.title) {
      exitEditing();
      return;
    }
    try {
      await rename.mutateAsync({ id: conversation.id, title: next });
      exitEditing();
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : 'The conversation could not be renamed.',
      );
      inputRef.current?.focus();
    }
  }, [draft, conversation.id, conversation.title, rename, exitEditing]);

  const handleInputKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void commit();
        return;
      }
      if (event.key === 'Escape') {
        // Both halves, for different reasons: preventDefault is the flag
        // `use-keyboard-shortcuts` reads (#1206); stopPropagation is what keeps
        // the key off every other document listener. There is no portal here,
        // so absorbPortalEscape does not apply — the calls are made by hand.
        event.preventDefault();
        event.stopPropagation();
        cancelledRef.current = true;
        exitEditing();
      }
    },
    [commit, exitEditing],
  );

  const handleRowKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      // Radix portals its menu content out of the DOM but not out of the React
      // tree and replays events up it (the reason useToolbarRovingFocus guards
      // with root.contains), so an open menu's arrows would otherwise move the
      // list underneath it.
      const row = rowRef.current;
      if (row && event.target instanceof Node && !row.contains(event.target)) return;
      if (editing) return;

      if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
        event.preventDefault();
        setMenuOpen(true);
        return;
      }

      if (event.target === kebabRef.current) {
        if (event.key === 'ArrowLeft') {
          event.preventDefault();
          linkRef.current?.focus();
        }
        // Everything else on the kebab is Radix's Trigger contract (ArrowDown,
        // Enter, Space open the menu). The list must not also travel.
        return;
      }

      if (event.key === 'ArrowRight') {
        event.preventDefault();
        kebabRef.current?.focus();
        return;
      }

      onRowKeyDown(event, conversation.id);
    },
    [editing, onRowKeyDown, conversation.id],
  );

  return (
    <li
      ref={rowRef}
      // `group/row` is what the kebab's hover/focus-within visibility keys on;
      // `relative` is what its `right-1` resolves against.
      className="group/row relative flex h-7 items-center"
      onKeyDown={handleRowKeyDown}
      onFocus={() => onRowFocus(conversation.id)}
    >
      {editing ? (
        <input
          ref={inputRef}
          autoFocus
          className="nm-input h-6 w-full text-[13px]"
          aria-label={`Rename ${conversation.title}`}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onFocus={(event) => event.currentTarget.select()}
          onKeyDown={handleInputKeyDown}
          onBlur={() => void commit()}
        />
      ) : (
        <NavLink
          ref={linkRef}
          to={conversationPath(conversation.id)}
          title={conversation.title}
          data-row-id={conversation.id}
          tabIndex={tabIndex}
          onClick={onNavigate}
          className={({ isActive: active }) =>
            cn(
              // The focus ring is the tree row's: this link is the list's single
              // tab stop, so it must show focus.
              'flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-2 pr-7 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
              active
                ? 'nav-selection font-medium'
                : 'text-muted-foreground hover:bg-[var(--glass-pill-hover)] hover:text-foreground',
            )
          }
        >
          <span className="min-w-0 flex-1 truncate">{conversation.title}</span>
          {conversation.pageTitle && (
            // A label, never a hue (a category, ADR-010). The sr-only prefix is
            // real text: an aria-label on a plain span is prohibited naming.
            <span
              className={cn(neutralChipClass, 'max-w-[45%] truncate')}
              title={conversation.pageTitle}
            >
              <span className="sr-only">Page: </span>
              {conversation.pageTitle}
            </span>
          )}
        </NavLink>
      )}

      {/* Not rendered while renaming: the input is w-full and the kebab is
          absolutely positioned over it. Radix's FocusScope still dispatches its
          unmount-auto-focus, which the menu's onCloseAutoFocus guard swallows,
          so focus stays in the field. */}
      {!editing && (
        <ConversationRowMenu
          conversation={conversation}
          open={menuOpen}
          onOpenChange={setMenuOpen}
          onRename={startRename}
          triggerRef={kebabRef}
          visible={isActive}
        />
      )}
    </li>
  );
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/features/ai/conversations/ConversationRow.test.tsx`

Expected: PASS (all cases). If `Rename ${title}` cannot be found by role `textbox`, check that
Task 9's `use-conversation-mutations.ts` exists and exports both hooks — the row imports them.

- [ ] **Step 6: Write the failing guard for the `data-highlighted` branch**

Append to `frontend/src/destructive-treatment.test.ts`, inside `describe('one destructive treatment', …)`,
immediately after the `it('is defined once, as a utility', …)` block:

```ts
  // Radix highlights a menu item with `data-highlighted` on keyboard travel and
  // never with `:hover`. The conversation row menu (#1361) is this utility's
  // first use on a role="menuitem", so without the branch the one destructive
  // control in the app renders unmarked for anyone arrowing onto it.
  it('covers the keyboard highlight, not only :hover', () => {
    const css = readFileSync(join(SRC, 'index.css'), 'utf-8');
    const start = css.indexOf('@utility nm-action-destructive');
    expect(start, 'utility not found — this guard is stale').toBeGreaterThan(-1);
    const block = css.slice(start, css.indexOf('@utility', start + 1));
    expect(block).toMatch(/&:hover:not\(:disabled\)/);
    expect(block, 'Radix uses data-highlighted, not :hover').toMatch(/&\[data-highlighted\]/);
  });
```

- [ ] **Step 7: Run it to verify it fails**

Run: `cd frontend && npx vitest run src/destructive-treatment.test.ts`

Expected: FAIL — `Radix uses data-highlighted, not :hover: expected '…' to match /&\[data-highlighted\]/`.

- [ ] **Step 8: Extend the utility**

Edit `frontend/src/index.css` (`:929-932`).

Old:
```css
  &:hover:not(:disabled) {
    background-color: oklch(from var(--color-destructive) l c h / 0.1);
    color: var(--color-destructive);
  }
```

New:
```css
  /* `:hover` is the mouse; `[data-highlighted]` is Radix's keyboard highlight on
     a role="menuitem" — the conversation row menu's Delete (#1361) is this
     utility's first such callsite. Both paint the same, or arrowing onto Delete
     leaves the app's one destructive control unmarked. One edit in one place is
     what keeps "one treatment" true. */
  &:hover:not(:disabled),
  &[data-highlighted] {
    background-color: oklch(from var(--color-destructive) l c h / 0.1);
    color: var(--color-destructive);
  }
```

- [ ] **Step 9: Run the guard suites this task touches**

Run: `cd frontend && npx vitest run src/destructive-treatment.test.ts src/ui-text-legibility.test.ts src/flat-components.test.ts src/focus-ring-contrast.test.ts src/workspace-themes.test.ts src/features/ai/conversations/ConversationRow.test.tsx`

Expected: PASS. The hand-rolled-destructive ratchet stays at its measured ≤ 21 — the row menu
uses the utility, and `ConversationRow.test.tsx` pins that Delete carries no
`hover:bg-destructive/NN` of its own.

Then: `cd frontend && npx tsc --noEmit` — expected: clean.

- [ ] **Step 10: Commit**

```bash
git add frontend/src/features/ai/conversations/ConversationRow.tsx \
        frontend/src/features/ai/conversations/ConversationRowMenu.tsx \
        frontend/src/features/ai/conversations/ConversationRow.test.tsx \
        frontend/src/index.css \
        frontend/src/destructive-treatment.test.ts
git commit -m "feat(ai): conversation row with kebab menu, inline rename and delete

One <li> owning the row's keys: NavLink + page chip + a 24x24 kebab reached by
ArrowRight, a portalled Rename/Delete menu and in-place rename. nm-action-destructive
gains a data-highlighted branch — Radix's keyboard highlight is not :hover, and this
is the utility's first role=\"menuitem\" callsite.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: `ConversationList`

Implements spec §List semantics and keyboard, §Filter and Show more, §The three list states,
§Recency groups (consumer side).

**Files:**
- Create: `frontend/src/features/ai/conversations/ConversationList.tsx`
- Test: `frontend/src/features/ai/conversations/ConversationList.test.tsx`
- Modify: `frontend/src/shared/components/layout/SidebarTreeView.tsx:149` (export `SECTION_LABEL`)

**Interfaces:**
- Consumes: `useConversationList()` → `{ query, rows }` (Task 9); `groupByRecency(items, now)`
  (Task 7); `useListRovingFocus({ ids, activeId, containerRef, itemAttr })` (Task 8);
  `ConversationRow` (Task 10); `conversationIdFromPath` (Task 1); `SECTION_LABEL`
  (exported here, from `SidebarTreeView`); `ApiError` (`shared/lib/api`).
- Produces:
  ```ts
  export interface ConversationListProps {
    list: ReturnType<typeof useConversationList>;
    filter: string;
    onNavigate?: () => void;
    now?: () => Date;   // test seam, defaults to () => new Date()
  }
  export function ConversationList(props: ConversationListProps): JSX.Element;
  // SidebarTreeView.tsx: `export const SECTION_LABEL` (was module-private at :149) — Task 12 relies on it too.
  ```

**Pinned here (decisions the spec/brief left open):**
1. **`ConversationList` returns a fragment** — the scrolling `<nav>`, the stale strip above it
   and the Show more row below it as siblings. Amendment item 7 puts Show more *outside* the
   scroller in the aside's `shrink-0` chain, while the brief assigns the button to this
   component; a fragment satisfies both, and its children land as direct flex children of the
   chassis exactly as item 7 describes. Show more never scrolls out of reach.
2. **`now?: () => Date`** is an explicit optional prop (the brief's instruction). Grouping is
   recomputed when the rows or the clock function change, not on a timer — the same
   non-live-updating behaviour every other date label in the rail has.
3. **Copy uses the typographic apostrophe** `Couldn&rsquo;t load conversations`, matching the
   tree's own block (`SidebarTreeView.tsx:1383`); the test matches `/Couldn['’]t load conversations/`.
4. The empty and no-match lines are `text-xs` (12px), not the 11px floor: on an empty pane that
   line is the only content on screen.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/features/ai/conversations/ConversationList.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ConversationListResponse, ConversationSummary } from '@compendiq/contracts';
import { ConversationList } from './ConversationList';
import { useConversationList } from './use-conversation-list';

const { purgeConversation } = vi.hoisted(() => ({ purgeConversation: vi.fn() }));

vi.mock('../AiContext', () => ({
  useAiContext: () => ({ purgeConversation }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

/**
 * A fixed clock, and item dates built from it with LOCAL calendar arithmetic
 * (`setDate`), so "yesterday" is the previous local calendar day in every time
 * zone rather than "24 hours earlier in UTC".
 */
const NOW = new Date('2026-08-18T12:00:00.000Z');
const now = () => NOW;

function daysAgo(n: number): string {
  const d = new Date(NOW);
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

function conversation(over: Partial<ConversationSummary> & { id: string }): ConversationSummary {
  return {
    title: `Conversation ${over.id}`,
    titleSource: 'question',
    model: 'llama3',
    pageId: null,
    pageTitle: null,
    createdAt: daysAgo(0),
    updatedAt: daysAgo(0),
    ...over,
  };
}

const PAGE_ONE: ConversationListResponse = {
  items: [
    conversation({ id: 'a', title: 'Rollout plan', updatedAt: daysAgo(0) }),
    conversation({ id: 'b', title: 'Backup policy', updatedAt: daysAgo(1) }),
    conversation({ id: 'c', title: 'Sync stalls', updatedAt: daysAgo(10) }),
  ],
  nextCursor: null,
};

function mockPages(pages: ConversationListResponse[]) {
  let call = 0;
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(typeof input === 'string' ? input : (input as Request).url ?? input);
    if (url.includes('/llm/conversations')) {
      const page = pages[Math.min(call, pages.length - 1)]!;
      call += 1;
      return new Response(JSON.stringify(page), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('Not found', { status: 404 });
  });
}

function Harness({ filter = '' }: { filter?: string }) {
  const list = useConversationList();
  return <ConversationList list={list} filter={filter} now={now} />;
}

function renderList(props: { filter?: string } = {}, path = '/ai') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <div className="flex flex-col">
          <Harness {...props} />
        </div>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ConversationList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('groups rows by recency against a fixed clock, newest bucket first', async () => {
    mockPages([PAGE_ONE]);
    renderList();

    const nav = await screen.findByRole('navigation', { name: 'Conversation history' });
    const headings = within(nav)
      .getAllByRole('heading', { level: 3 })
      .map((h) => h.textContent);
    expect(headings).toEqual(['Today', 'Yesterday', 'Previous 30 days']);

    // Each group's list is labelled by its own heading.
    const lists = within(nav).getAllByRole('list');
    expect(lists).toHaveLength(3);
    lists.forEach((ul, i) => {
      expect(ul).toHaveAttribute(
        'aria-labelledby',
        within(nav).getAllByRole('heading', { level: 3 })[i]!.id,
      );
    });
  });

  it('gives every row a title and no icon, and marks the open one', async () => {
    mockPages([PAGE_ONE]);
    renderList({}, '/ai/c/b');

    const links = await screen.findAllByRole('link');
    expect(links).toHaveLength(3);
    links.forEach((a) => {
      expect(a).toHaveAttribute('title');
      expect(a.querySelector('svg'), 'the tree carries no per-row icon and neither does this').toBeNull();
    });
    expect(screen.getByRole('link', { name: /Backup policy/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('is one tab stop, and ArrowDown travels', async () => {
    mockPages([PAGE_ONE]);
    renderList();

    const links = await screen.findAllByRole('link');
    expect(links.filter((a) => a.getAttribute('tabindex') === '0')).toHaveLength(1);

    links[0]!.focus();
    fireEvent.keyDown(links[0]!, { key: 'ArrowDown' });
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getAllByRole('link')[1]);
    });
  });

  it('filters case-insensitively over the title, before grouping', async () => {
    mockPages([PAGE_ONE]);
    renderList({ filter: 'ROLL' });

    await waitFor(() => expect(screen.getAllByRole('link')).toHaveLength(1));
    expect(screen.getByRole('link', { name: /Rollout plan/ })).toBeInTheDocument();
    // Applied BEFORE grouping, so a group with no match disappears entirely.
    expect(screen.queryByRole('heading', { level: 3, name: 'Yesterday' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: 'Today' })).toBeInTheDocument();
  });

  it('says so when nothing matches the filter', async () => {
    mockPages([PAGE_ONE]);
    renderList({ filter: 'zzzz' });
    expect(await screen.findByText('No matching conversations')).toBeInTheDocument();
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });

  it('shows the first-run empty state, naming what is saved', async () => {
    mockPages([{ items: [], nextCursor: null }]);
    renderList();
    expect(
      await screen.findByText('Your conversations will appear here. Only Q&A is saved.'),
    ).toBeInTheDocument();
  });

  it('renders skeleton pulses on the first load, never the empty state', () => {
    mockPages([PAGE_ONE]);
    const { container } = renderList();
    expect(container.querySelectorAll('.animate-pulse')).toHaveLength(8);
    expect(
      screen.queryByText('Your conversations will appear here. Only Q&A is saved.'),
    ).not.toBeInTheDocument();
  });

  it('treats a failure with nothing cached as a failure, not an empty history', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ message: 'Bad gateway (HTTP 502)' }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      }),
    );
    renderList();

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/Couldn['’]t load conversations/)).toBeInTheDocument();
    expect(within(alert).getByText('Bad gateway (HTTP 502)')).toBeInTheDocument();
    expect(within(alert).getByRole('button', { name: /Try again/ })).toBeInTheDocument();
  });

  it('degrades to an amber strip when a refresh fails over a cached list', async () => {
    mockPages([
      { items: PAGE_ONE.items, nextCursor: 'cursor-1' },
    ]);
    renderList();
    await screen.findAllByRole('link');

    vi.mocked(globalThis.fetch).mockImplementation(async () =>
      new Response(JSON.stringify({ message: 'Bad gateway (HTTP 502)' }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      }),
    );
    fireEvent.click(screen.getByTestId('conversations-show-more'));

    const strip = await screen.findByRole('status');
    expect(within(strip).getByText('Showing the last loaded conversations')).toBeInTheDocument();
    expect(within(strip).getByRole('button', { name: /Retry/ })).toBeInTheDocument();
    // Red is failure, amber is degraded — the rows are still there.
    expect(screen.getAllByRole('link')).toHaveLength(3);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('pages the server from Show more and retires the button at the end', async () => {
    mockPages([
      { items: [conversation({ id: 'a', title: 'First' })], nextCursor: 'cursor-1' },
      { items: [conversation({ id: 'b', title: 'Second' })], nextCursor: null },
    ]);
    renderList();

    await screen.findByRole('link', { name: /First/ });
    fireEvent.click(screen.getByTestId('conversations-show-more'));

    await screen.findByRole('link', { name: /Second/ });
    await waitFor(() => {
      expect(screen.queryByTestId('conversations-show-more')).not.toBeInTheDocument();
    });
    const listCalls = vi
      .mocked(globalThis.fetch)
      .mock.calls.map((c) => String(c[0]))
      .filter((u) => u.includes('/llm/conversations'));
    expect(listCalls).toHaveLength(2);
    expect(listCalls[1]).toContain('cursor=cursor-1');
  });

  it('keeps Show more available while a filter is active — it loads more rows INTO the filter', async () => {
    mockPages([
      { items: [conversation({ id: 'a', title: 'First' })], nextCursor: 'cursor-1' },
      { items: [conversation({ id: 'b', title: 'Second' })], nextCursor: null },
    ]);
    renderList({ filter: 'zzzz' });

    expect(await screen.findByText('No matching conversations')).toBeInTheDocument();
    expect(screen.getByTestId('conversations-show-more')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/features/ai/conversations/ConversationList.test.tsx`

Expected: FAIL — `Failed to resolve import "./ConversationList"`.

- [ ] **Step 3: Export `SECTION_LABEL` from `SidebarTreeView`**

Edit `frontend/src/shared/components/layout/SidebarTreeView.tsx:149`.

Old:
```ts
const SECTION_LABEL = 'text-[12px] font-semibold uppercase tracking-[0.08em] text-muted-foreground';
```

New:
```ts
// Exported since #1361: the conversations pane renders recency headings in the
// same rail and must not copy the string — SettingsSidebar copied it once and
// drifted to a /80 opacity that failed contrast on Paper.
export const SECTION_LABEL = 'text-[12px] font-semibold uppercase tracking-[0.08em] text-muted-foreground';
```

(Task 12 relies on this export existing; it is added here because `ConversationList` is its
first consumer.)

- [ ] **Step 4: Write `ConversationList`**

Create `frontend/src/features/ai/conversations/ConversationList.tsx`:

```tsx
import { useMemo, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { ApiError } from '../../../shared/lib/api';
import { cn } from '../../../shared/lib/cn';
import { SECTION_LABEL } from '../../../shared/components/layout/SidebarTreeView';
import { useListRovingFocus } from '../../../shared/hooks/use-list-roving-focus';
import { conversationIdFromPath } from '../../../shared/lib/ai-routes';
import { groupByRecency } from './group-by-recency';
import { ConversationRow } from './ConversationRow';
import type { useConversationList } from './use-conversation-list';

export interface ConversationListProps {
  list: ReturnType<typeof useConversationList>;
  filter: string;
  onNavigate?: () => void;
  /** Test seam: the clock the recency buckets are computed against. */
  now?: () => Date;
}

const headingId = (label: string) =>
  `conversations-group-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

/**
 * The recency groups, the three list states and Show more.
 *
 * Returns a FRAGMENT, not a wrapper: the scroller is `min-h-0 flex-1` inside the
 * chassis's flex column, and the degraded strip above it and the Show more row
 * below it are `shrink-0` siblings of it (amendment item 7). Wrapping them in a
 * div would put the button inside the scroll area and let it scroll out of reach.
 */
export function ConversationList({ list, filter, onNavigate, now = () => new Date() }: ConversationListProps) {
  const location = useLocation();
  const activeId = conversationIdFromPath(location.pathname);
  const navRef = useRef<HTMLElement>(null);
  const { query, rows } = list;

  const needle = filter.trim().toLowerCase();
  const filtered = useMemo(
    () => (needle ? rows.filter((row) => row.title.toLowerCase().includes(needle)) : rows),
    [rows, needle],
  );
  const groups = useMemo(() => groupByRecency(filtered, now()), [filtered, now]);
  const ids = useMemo(() => groups.flatMap((g) => g.items.map((i) => i.id)), [groups]);

  const { rovingId, handleRowFocus, handleRowKeyDown } = useListRovingFocus({
    ids,
    activeId,
    containerRef: navRef,
    itemAttr: 'data-row-id',
  });

  // A failed fetch is a failure, not an empty history (the tree learned this).
  // With rows still in hand it is a degradation instead: amber, not red.
  const failedWithNothing = query.isError && rows.length === 0;
  const degraded = query.isError && rows.length > 0;

  let body: React.ReactNode;
  if (query.isPending) {
    body = (
      <div className="space-y-1.5 py-2">
        {Array.from({ length: 8 }, (_, i) => (
          <div
            key={i}
            className="h-7 animate-pulse rounded-lg bg-foreground/5"
            style={{ width: `${60 + ((i * 7) % 30)}%` }}
          />
        ))}
      </div>
    );
  } else if (failedWithNothing) {
    body = (
      <div
        className="flex flex-col items-center px-3 py-8 text-center"
        role="alert"
        data-testid="conversations-error"
      >
        <div className="mb-3 rounded-full bg-muted p-2.5">
          <AlertTriangle size={20} className="text-destructive" aria-hidden="true" />
        </div>
        <p className="text-xs font-medium text-foreground/70">Couldn&rsquo;t load conversations</p>
        <p className="mt-1 break-words line-clamp-3 text-[11px] text-muted-foreground">
          {query.error instanceof ApiError ? query.error.message : 'The request did not complete.'}
        </p>
        <button
          type="button"
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
          className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-action bg-transparent px-3 py-1.5 text-xs font-medium text-action transition-colors hover:bg-action hover:text-action-foreground disabled:opacity-40"
        >
          <RefreshCw size={12} className={cn(query.isFetching && 'animate-spin')} aria-hidden="true" />
          {query.isFetching ? 'Retrying' : 'Try again'}
        </button>
      </div>
    );
  } else if (rows.length === 0) {
    body = (
      <p className="px-2 py-6 text-center text-xs text-muted-foreground">
        Your conversations will appear here. Only Q&A is saved.
      </p>
    );
  } else if (groups.length === 0) {
    body = <p className="px-2 py-4 text-center text-xs text-muted-foreground">No matching conversations</p>;
  } else {
    body = groups.map((group) => {
      const id = headingId(group.label);
      return (
        <section key={group.label} className="pb-2">
          <h3 id={id} className={cn(SECTION_LABEL, 'px-2 py-1')}>
            {group.label}
          </h3>
          <ul role="list" aria-labelledby={id} className="mt-0.5 flex flex-col gap-px">
            {group.items.map((conversation) => (
              <ConversationRow
                key={conversation.id}
                conversation={conversation}
                tabIndex={rovingId === conversation.id ? 0 : -1}
                onRowFocus={handleRowFocus}
                onRowKeyDown={handleRowKeyDown}
                onNavigate={onNavigate}
              />
            ))}
          </ul>
        </section>
      );
    });
  }

  return (
    <>
      {degraded && (
        <div
          role="status"
          data-testid="conversations-stale-notice"
          className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5"
        >
          <AlertTriangle size={12} className="shrink-0 text-warning" aria-hidden="true" />
          <span className="min-w-0 flex-1 text-[11px] text-muted-foreground">
            Showing the last loaded conversations
          </span>
          <button
            type="button"
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
            className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-action transition-colors hover:bg-[var(--glass-pill-hover)] disabled:opacity-40"
          >
            {query.isFetching ? 'Retrying' : 'Retry'}
          </button>
        </div>
      )}

      <nav
        ref={navRef}
        aria-label="Conversation history"
        className="min-h-0 flex-1 overflow-y-auto px-2 pb-3"
      >
        {body}
      </nav>

      {/* Explicit paging, not infinite scroll: a button is reachable and
          announces itself. It stays available while a filter is active — it
          loads more rows INTO the filter. */}
      {query.hasNextPage && (
        <div className="shrink-0 px-2 pb-2">
          <button
            type="button"
            data-testid="conversations-show-more"
            onClick={() => void query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
            className="nm-button-ghost w-full"
          >
            {query.isFetchingNextPage ? 'Loading…' : 'Show more'}
          </button>
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/features/ai/conversations/ConversationList.test.tsx`

Expected: PASS. If the degraded case does not go amber, check Task 9's hook: `useInfiniteQuery`
must keep `data` when `fetchNextPage` rejects (it does with `retry: false`), which is what makes
`isError && rows.length > 0` reachable.

- [ ] **Step 6: Run the guard suites this task touches**

Run: `cd frontend && npx vitest run src/ui-text-legibility.test.ts src/flat-components.test.ts src/focus-ring-contrast.test.ts src/shared/components/layout/SidebarTreeView.test.tsx src/features/ai/conversations/ConversationList.test.tsx src/features/ai/conversations/ConversationRow.test.tsx`

Expected: PASS. `SECTION_LABEL` is 12px uppercase, which is the floor `ui-text-legibility`
enforces for capitals; the tree suite must stay green across the `export` keyword.

Then: `cd frontend && npx tsc --noEmit` — expected: clean.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/features/ai/conversations/ConversationList.tsx \
        frontend/src/features/ai/conversations/ConversationList.test.tsx \
        frontend/src/shared/components/layout/SidebarTreeView.tsx
git commit -m "feat(ai): conversation list — recency groups, roving focus, three states

<nav> of recency sections over the shared SECTION_LABEL (now exported rather than
copied), one tab stop with arrow travel, an explicit Show more, and the tree's own
failed / degraded / empty / loading treatments so a network failure is never reported
as an empty history.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 12: `AiConversationsSidebar` (the chassis)

Implements spec §Chassis **as superseded by amendment items 1, 3 and 7**, §Filter and Show more
(filter half), §Mobile.

**Files:**
- Create: `frontend/src/features/ai/conversations/AiConversationsSidebar.tsx`
- Test: `frontend/src/features/ai/conversations/AiConversationsSidebar.test.tsx`
- Modify: `frontend/src/toolbar-rule-alignment.test.ts:36-40` (`SELF_BORDERED` gains the pane)

**Interfaces:**
- Consumes: `useConversationList()` (Task 9); `ConversationList` (Task 11);
  `startNewConversation()` from `useAiContext()` (Task 2); `useUiStore`
  (`treeSidebarCollapsed` / `toggleTreeSidebar` / `treeSidebarWidth` / `setTreeSidebarWidth`);
  `MainNavStripExpanded` / `MainNavStripCollapsed`; `SidebarSessionChrome`.
- Produces:
  ```ts
  export const CONVERSATION_FILTER_THRESHOLD = 8;
  export function AiConversationsSidebar(props: { onNavigate?: () => void }): JSX.Element;
  ```

**Pinned here (decisions the spec/brief left open):**
1. **Both New chat controls carry `data-testid="conversations-new-chat"`** — the expanded
   pane's full-width button and the collapsed rail's `SquarePen` glyph. They are the same
   action and the two branches never render together, so one id keeps the pane's tests and
   `AppLayout`'s drawer test writing the same query. (`AppLayout` mounts two *instances* —
   drawer + desktop — so those tests scope with `within(...)`, exactly as the existing
   slide-over tests already do for the tree.)
2. **The footer count reads `list.rows.length`** and is labelled "conversation"/"conversations"
   — amendment item 1 requires the loaded row count, i.e. the same number
   `CONVERSATION_FILTER_THRESHOLD` is measured against, not a server total (the keyset list has
   none).
3. **The `,` shortcut is `AppLayout`'s, not the pane's.** The pane only reads
   `treeSidebarCollapsed`, so its test drives the store directly and `AppLayout.test.tsx` keeps
   owning the keystroke.
4. The pane takes **no** `forceCollapsed` / `onForceExpand` (amendment item 3), so its expand
   button is a plain `toggleTreeSidebar` with none of the tree's override branch.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/features/ai/conversations/AiConversationsSidebar.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ConversationListResponse, ConversationSummary } from '@compendiq/contracts';
import { AiConversationsSidebar, CONVERSATION_FILTER_THRESHOLD } from './AiConversationsSidebar';
import { useUiStore } from '../../../stores/ui-store';

const { startNewConversation, purgeConversation } = vi.hoisted(() => ({
  startNewConversation: vi.fn(),
  purgeConversation: vi.fn(),
}));

vi.mock('../AiContext', () => ({
  useAiContext: () => ({ startNewConversation, purgeConversation }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// Same stub SidebarTreeView.test.tsx:19-20 uses — it is what keeps UserMenu's
// auth store out of a chassis test.
vi.mock('../../../shared/components/layout/SidebarSessionChrome', () => ({
  SidebarSessionChrome: () => <div data-testid="sidebar-session-chrome" />,
}));

vi.mock('framer-motion', async () => {
  const actual = await vi.importActual('framer-motion');
  return { ...actual, useReducedMotion: () => true };
});

function conversation(i: number): ConversationSummary {
  return {
    id: `1111111${i}-1111-4111-8111-111111111111`,
    title: `Conversation ${i}`,
    titleSource: 'question',
    model: 'llama3',
    pageId: null,
    pageTitle: null,
    createdAt: '2026-08-18T09:00:00.000Z',
    updatedAt: '2026-08-18T09:00:00.000Z',
  };
}

function mockList(count: number) {
  const page: ConversationListResponse = {
    items: Array.from({ length: count }, (_, i) => conversation(i)),
    nextCursor: null,
  };
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(typeof input === 'string' ? input : (input as Request).url ?? input);
    if (url.includes('/llm/conversations')) {
      return new Response(JSON.stringify(page), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('Not found', { status: 404 });
  });
}

function renderPane(props: { onNavigate?: () => void } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/ai']}>
        <AiConversationsSidebar {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('AiConversationsSidebar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUiStore.setState({ treeSidebarCollapsed: false, treeSidebarWidth: 280 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is a labelled complementary region in BOTH branches', async () => {
    mockList(3);
    const { unmount } = renderPane();
    const expanded = await screen.findByTestId('ai-conversations-sidebar');
    expect(expanded.tagName).toBe('ASIDE');
    expect(expanded).toHaveAttribute('aria-label', 'Conversations');
    expect(within(expanded).getByTestId('sidebar-session-chrome')).toBeInTheDocument();
    unmount();

    useUiStore.setState({ treeSidebarCollapsed: true });
    renderPane();
    const collapsed = await screen.findByTestId('ai-conversations-sidebar');
    expect(collapsed.tagName).toBe('ASIDE');
    expect(collapsed).toHaveAttribute('aria-label', 'Conversations');
    // Collapsing shrinks the region; it never deletes the landmark or the
    // account menu — /ai would otherwise be the only route with neither.
    expect(within(collapsed).getByTestId('sidebar-session-chrome')).toBeInTheDocument();
    expect(within(collapsed).getByTestId('conversations-new-chat')).toBeInTheDocument();
    expect(within(collapsed).queryByRole('navigation', { name: 'Conversation history' })).toBeNull();
  });

  it('carries the rail resize contract verbatim', async () => {
    mockList(3);
    renderPane();
    const handle = await screen.findByRole('separator', { name: 'Resize conversations sidebar' });
    expect(handle).toHaveAttribute('aria-valuemin', '180');
    expect(handle).toHaveAttribute('aria-valuemax', '600');
    expect(handle).toHaveAttribute('aria-valuenow', '280');
    expect(handle).toHaveAttribute('aria-valuetext', '280 pixels');

    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(useUiStore.getState().treeSidebarWidth).toBe(296);
    fireEvent.keyDown(handle, { key: 'Home' });
    expect(useUiStore.getState().treeSidebarWidth).toBe(280);
  });

  it('follows the shared collapse state (the "," shortcut is AppLayout\'s)', async () => {
    mockList(3);
    renderPane();
    expect(await screen.findByRole('navigation', { name: 'Conversation history' })).toBeInTheDocument();

    act(() => useUiStore.getState().toggleTreeSidebar());
    await waitFor(() => {
      expect(screen.queryByRole('navigation', { name: 'Conversation history' })).toBeNull();
    });
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toHaveAttribute(
      'title',
      'Expand sidebar (,)',
    );
  });

  it('shows the filter only past the threshold', async () => {
    mockList(CONVERSATION_FILTER_THRESHOLD);
    const { unmount } = renderPane();
    await screen.findAllByRole('link');
    expect(screen.queryByLabelText('Filter conversations')).toBeNull();
    unmount();
    vi.restoreAllMocks();

    mockList(CONVERSATION_FILTER_THRESHOLD + 1);
    renderPane();
    await screen.findAllByRole('link');
    expect(await screen.findByLabelText('Filter conversations')).toHaveAttribute(
      'placeholder',
      'Filter conversations',
    );
  });

  it('filters the list, and Escape clears then blurs', async () => {
    mockList(9);
    renderPane();
    const filter = (await screen.findByLabelText('Filter conversations')) as HTMLInputElement;

    fireEvent.change(filter, { target: { value: 'Conversation 3' } });
    await waitFor(() => expect(screen.getAllByRole('link')).toHaveLength(1));

    filter.focus();
    fireEvent.keyDown(filter, { key: 'Escape' });
    expect(filter.value).toBe('');
    expect(document.activeElement).toBe(filter);

    fireEvent.keyDown(filter, { key: 'Escape' });
    expect(document.activeElement).not.toBe(filter);
  });

  it('resets the filter when the pane collapses', async () => {
    mockList(9);
    renderPane();
    const filter = (await screen.findByLabelText('Filter conversations')) as HTMLInputElement;
    fireEvent.change(filter, { target: { value: 'Conversation 3' } });
    expect(filter.value).toBe('Conversation 3');

    act(() => useUiStore.getState().toggleTreeSidebar());
    act(() => useUiStore.getState().toggleTreeSidebar());

    await waitFor(() => {
      expect((screen.getByLabelText('Filter conversations') as HTMLInputElement).value).toBe('');
    });
  });

  it('New chat starts one and closes the drawer', async () => {
    mockList(3);
    const onNavigate = vi.fn();
    renderPane({ onNavigate });
    fireEvent.click(await screen.findByTestId('conversations-new-chat'));
    expect(startNewConversation).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it('reports the loaded row count in the footer', async () => {
    mockList(3);
    renderPane();
    expect(await screen.findByText('3 conversations')).toBeInTheDocument();
  });

  it('fetches the list exactly once on mount', async () => {
    const fetchSpy = mockList(3);
    renderPane();
    await screen.findAllByRole('link');
    const listCalls = fetchSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes('/llm/conversations'));
    expect(listCalls).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/features/ai/conversations/AiConversationsSidebar.test.tsx`

Expected: FAIL — `Failed to resolve import "./AiConversationsSidebar"`.

- [ ] **Step 3: Write the chassis**

Create `frontend/src/features/ai/conversations/AiConversationsSidebar.tsx`:

```tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { m, AnimatePresence, useReducedMotion } from 'framer-motion';
import { PanelLeft, PanelLeftClose, SquarePen } from 'lucide-react';
import { MainNavStripExpanded, MainNavStripCollapsed } from '../../../shared/components/layout/MainNavStrip';
import { SidebarSessionChrome } from '../../../shared/components/layout/SidebarSessionChrome';
import { useUiStore } from '../../../stores/ui-store';
import { cn } from '../../../shared/lib/cn';
import { useAiContext } from '../AiContext';
import { useConversationList } from './use-conversation-list';
import { ConversationList } from './ConversationList';

const sidebarSpring = { type: 'spring' as const, stiffness: 400, damping: 30 };

/**
 * A filter is a scale affordance, so it appears only at scale — the tree's own
 * SPACE_FILTER_THRESHOLD precedent. Measured against the LOADED row count, which
 * is also what the footer states.
 */
export const CONVERSATION_FILTER_THRESHOLD = 8;

/**
 * The conversations rail — the third arm of AppLayout's sidebar ternary, mounted
 * on AI routes in place of the Pages tree.
 *
 * It shares `treeSidebarCollapsed` / `treeSidebarWidth` with both trees, so "," and
 * the persisted width carry across routes, and it takes no forceCollapsed /
 * onForceExpand: `AppLayout` gates that compaction on article routes, so no layout
 * preset can act on /ai.
 */
export function AiConversationsSidebar({ onNavigate }: { onNavigate?: () => void } = {}) {
  const treeSidebarCollapsed = useUiStore((s) => s.treeSidebarCollapsed);
  const toggleTreeSidebar = useUiStore((s) => s.toggleTreeSidebar);
  const treeSidebarWidth = useUiStore((s) => s.treeSidebarWidth);
  const setTreeSidebarWidth = useUiStore((s) => s.setTreeSidebarWidth);
  const reduceEffects = useReducedMotion();
  const { startNewConversation } = useAiContext();

  const list = useConversationList();
  const [filter, setFilter] = useState('');
  const [isResizing, setIsResizing] = useState(false);

  const showFilter = list.rows.length > CONVERSATION_FILTER_THRESHOLD;

  // A remembered filter would silently hide conversations from whoever reopens
  // the pane — the space dropdown's rule, applied to the rail.
  useEffect(() => {
    if (treeSidebarCollapsed) setFilter('');
  }, [treeSidebarCollapsed]);

  const handleNewChat = useCallback(() => {
    startNewConversation();
    onNavigate?.();
  }, [startNewConversation, onNavigate]);

  const handleFilterKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key !== 'Escape') return;
      // Two stages: clear the text, then leave the field. Stopped here so the
      // keystroke never reaches a document shortcut listener mid-typing.
      event.stopPropagation();
      if (filter) setFilter('');
      else event.currentTarget.blur();
    },
    [filter],
  );

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsResizing(true);
      const startX = e.clientX;
      const startWidth = treeSidebarWidth;

      function onMouseMove(ev: MouseEvent) {
        setTreeSidebarWidth(startWidth + (ev.clientX - startX));
      }

      function onMouseUp() {
        setIsResizing(false);
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      }

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    },
    [treeSidebarWidth, setTreeSidebarWidth],
  );

  const handleResizeKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setTreeSidebarWidth(treeSidebarWidth - 16);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        setTreeSidebarWidth(treeSidebarWidth + 16);
      } else if (e.key === 'Home') {
        e.preventDefault();
        setTreeSidebarWidth(280);
      }
    },
    [treeSidebarWidth, setTreeSidebarWidth],
  );

  if (treeSidebarCollapsed) {
    return (
      <AnimatePresence mode="wait">
        {/* <aside>, not <div>: both branches are the same region in two sizes,
            and both are named. */}
        <m.aside
          key="collapsed-conversations-rail"
          aria-label="Conversations"
          data-testid="ai-conversations-sidebar"
          initial={reduceEffects ? false : { width: 0, opacity: 0 }}
          animate={{ width: 40, opacity: 1 }}
          exit={{ width: 0, opacity: 0 }}
          transition={reduceEffects ? { duration: 0 } : sidebarSpring}
          className="app-sidebar flex flex-col items-center border-r overflow-hidden"
        >
          <button
            type="button"
            onClick={toggleTreeSidebar}
            className="mt-2 flex items-center rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-[var(--glass-pill-hover)] hover:text-foreground"
            aria-label="Expand sidebar"
            title="Expand sidebar (,)"
          >
            <PanelLeft size={16} />
          </button>

          <MainNavStripCollapsed onNavigate={onNavigate} />

          {/* One glyph, and only this one. Never a Delete; never the list. */}
          <button
            type="button"
            onClick={handleNewChat}
            data-testid="conversations-new-chat"
            className="mt-2 flex items-center rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-[var(--glass-pill-hover)] hover:text-foreground"
            aria-label="New chat"
            title="New chat"
          >
            <SquarePen size={16} />
          </button>

          <div className="mt-auto">
            <SidebarSessionChrome compact />
          </div>
        </m.aside>
      </AnimatePresence>
    );
  }

  return (
    <m.aside
      key="expanded-conversations-sidebar"
      aria-label="Conversations"
      data-testid="ai-conversations-sidebar"
      initial={reduceEffects ? false : { width: 0, opacity: 0 }}
      animate={{ width: treeSidebarWidth, opacity: 1 }}
      transition={reduceEffects || isResizing ? { duration: 0 } : sidebarSpring}
      className={cn(
        'app-sidebar relative flex max-w-full flex-col border-r overflow-hidden',
        isResizing && 'select-none',
      )}
    >
      {/* The 48px line across the top of every pane: h-12 with the hairline in
          the same border box, never py-*. */}
      <div className="panel-toolbar flex h-12 shrink-0 items-center gap-1 border-b px-2">
        <MainNavStripExpanded onNavigate={onNavigate} />
        <button
          type="button"
          onClick={toggleTreeSidebar}
          className="flex shrink-0 items-center rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-[var(--glass-pill-hover)] hover:text-foreground"
          aria-label="Collapse sidebar"
          title="Collapse sidebar (,)"
        >
          <PanelLeftClose size={14} />
        </button>
      </div>

      <div className="shrink-0 px-2 py-2">
        <button
          type="button"
          onClick={handleNewChat}
          data-testid="conversations-new-chat"
          className="nm-button-ghost w-full justify-start gap-2"
        >
          <SquarePen size={14} aria-hidden="true" />
          New chat
        </button>
      </div>

      {showFilter && (
        <div className="shrink-0 px-2 pb-2">
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            onKeyDown={handleFilterKeyDown}
            aria-label="Filter conversations"
            placeholder="Filter conversations"
            className="nm-input h-7 text-[13px]"
          />
        </div>
      )}

      {/* Fragment: the scroller, the degraded strip and Show more land here as
          siblings, so the button is a shrink-0 row rather than scrolling away. */}
      <ConversationList list={list} filter={filter} onNavigate={onNavigate} />

      {/* Loaded row count + session chrome. Out of the scroller so account and
          theme stay reachable under a long list. border-t, never border-b —
          exactly one bordered panel-toolbar row per file (the nav row). */}
      <div className="panel-toolbar flex shrink-0 items-center justify-between gap-2 border-t px-2 py-1.5">
        <span className="min-w-0 truncate text-[11px] text-muted-foreground">
          {`${list.rows.length} ${list.rows.length === 1 ? 'conversation' : 'conversations'}`}
        </span>
        <SidebarSessionChrome />
      </div>

      <div
        role="separator"
        aria-label="Resize conversations sidebar"
        aria-orientation="vertical"
        aria-valuemin={180}
        aria-valuemax={600}
        aria-valuenow={treeSidebarWidth}
        aria-valuetext={`${treeSidebarWidth} pixels`}
        tabIndex={0}
        onMouseDown={handleResizeStart}
        onDoubleClick={() => setTreeSidebarWidth(280)}
        onKeyDown={handleResizeKeyDown}
        className={cn(
          'group absolute bottom-0 right-0 top-0 z-10 flex w-2 cursor-col-resize items-center justify-end outline-none',
          'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
        )}
        title="Drag to resize · Double-click to reset"
      >
        <span
          className={cn(
            'h-full w-px bg-transparent transition-colors group-hover:bg-action/45 group-focus-visible:bg-action/55',
            isResizing && 'bg-action/70',
          )}
          aria-hidden="true"
        />
      </div>
    </m.aside>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/features/ai/conversations/AiConversationsSidebar.test.tsx`

Expected: PASS.

- [ ] **Step 5: Add the pane to the 48px-line guard (failing first)**

Edit `frontend/src/toolbar-rule-alignment.test.ts:36-40`.

Old:
```ts
const SELF_BORDERED = [
  ['shared/components/layout/SidebarTreeView.tsx', "the pages rail's nav row"],
  ['shared/components/layout/SettingsSidebar.tsx', "the settings rail's nav row"],
  ['shared/components/article/ArticleRightPane.tsx', "the inspector's tab row"],
] as const;
```

New:
```ts
const SELF_BORDERED = [
  ['shared/components/layout/SidebarTreeView.tsx', "the pages rail's nav row"],
  ['shared/components/layout/SettingsSidebar.tsx', "the settings rail's nav row"],
  ['features/ai/conversations/AiConversationsSidebar.tsx', "the conversations rail's nav row"],
  ['shared/components/article/ArticleRightPane.tsx', "the inspector's tab row"],
] as const;
```

Run it BEFORE Step 3's file exists to see it fail, or — since the component is already written
— temporarily confirm the guard is live by checking the two cases it adds now run against the
pane:

Run: `cd frontend && npx vitest run src/toolbar-rule-alignment.test.ts`

Expected: PASS with two extra cases named
`features/ai/conversations/AiConversationsSidebar.tsx keeps h-12 on the bordered row (the conversations rail's nav row)`
and its `py-*` sibling. If either fails, the nav row has lost `h-12` or grown a `py-`, or the
footer has been given `border-b` instead of `border-t` (which would make two bordered
`panel-toolbar` rows in one file and trip the `toBe(1)` assertion).

- [ ] **Step 6: Run the guard suites this task touches**

Run: `cd frontend && npx vitest run src/toolbar-rule-alignment.test.ts src/ui-text-legibility.test.ts src/flat-components.test.ts src/focus-ring-contrast.test.ts src/workspace-themes.test.ts src/features/ai/conversations`

Expected: PASS.

Then: `cd frontend && npx tsc --noEmit` and `cd frontend && npm run lint` — expected: clean.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/features/ai/conversations/AiConversationsSidebar.tsx \
        frontend/src/features/ai/conversations/AiConversationsSidebar.test.tsx \
        frontend/src/toolbar-rule-alignment.test.ts
git commit -m "feat(ai): conversations rail chassis

The tree's chassis recipes verbatim — <aside> in both branches, the shared collapse
state and width, the resize handle, the 48px nav row — plus New chat, the past-eight
filter and a session-chrome footer, so /ai is not the one route with no account menu.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 13: `AppLayout` mounts the pane

Implements spec §The conversation pane "Mounted by `AppLayout`" plus amendment items 3, 7 and 8.

**Files:**
- Modify: `frontend/src/shared/components/layout/AppLayout.tsx` (imports; `isAiRoute`;
  drawer ternary `:500-502`; desktop slot `:519-528`)
- Modify: `frontend/src/shared/components/layout/AppLayout.test.tsx` (`beforeEach` fetch stub;
  `spyOnFetch` reuse; the `/ai` leg of `:299-332`; two new cases)

**Interfaces:**
- Consumes: `isAiRoute(pathname)` (Task 1); `AiConversationsSidebar` (Task 12).
- Produces: nothing new — this is the wiring task. After it the branch is usable: `/ai` and
  `/ai/c/:id` render the pane in both the desktop slot and the mobile drawer.

**Pinned here:**
1. **The import is aliased** — `import { isAiRoute as isAiRoutePath }` — so the local boolean
   can be named `isAiRoute`, matching `isArticleRoute` / `isSettingsRoute` beside it.
2. **`AppLayout.test.tsx` gains a suite-wide `fetch` stub in `beforeEach`.** The pane mounts on
   every AI route and consumes `useAiContext`, which wakes `AiProvider`; five existing tests
   render `/ai` and would otherwise issue real requests. The AI-provider describe's private
   `spyOnFetch()` is rewritten to *reuse* that spy rather than layering a second one, so only
   one mock ever records a call.
3. The pane is deliberately **not** mocked in `AppLayout.test.tsx` (amendment item 1/8), which
   is what lets the "exactly one `/llm/conversations` request" test observe a real query. It is
   also why the drawer and desktop instances both render on `/ai` — assertions scope with
   `within(...)`, as the existing slide-over tests already do.

- [ ] **Step 1: Write the failing tests**

Edit `frontend/src/shared/components/layout/AppLayout.test.tsx`.

**1a.** Add the suite-wide stub. Old (inside `describe('AppLayout', …)`'s `beforeEach`, at the end
of the block):
```tsx
    window.innerWidth = 1024;
    // jsdom does not implement Element.scrollTo — stub it so the scroll-reset
    // useEffect in AppLayout does not throw
    Element.prototype.scrollTo = vi.fn();
  });
```

New:
```tsx
    window.innerWidth = 1024;
    // jsdom does not implement Element.scrollTo — stub it so the scroll-reset
    // useEffect in AppLayout does not throw
    Element.prototype.scrollTo = vi.fn();
    // The conversations pane mounts on every AI route (#1361) and consumes
    // AiContext, which wakes AiProvider — so any test rendering /ai now issues
    // requests. Answer them here, at the network boundary, once for the suite;
    // tests that assert on requests read this same spy rather than layering a
    // second one over it.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ items: [], nextCursor: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
```

**1b.** Rewrite the AI-provider describe's helper. Old (`:600-606`):
```tsx
    function spyOnFetch() {
      return vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
        Promise.resolve(
          new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }),
        ),
      );
    }
```

New:
```tsx
    /**
     * The suite-wide beforeEach already answers every request. Reuse that spy —
     * two layers of fetch mocks would disagree about which one recorded a call.
     */
    function spyOnFetch() {
      const spy = vi.mocked(globalThis.fetch);
      spy.mockClear();
      return spy;
    }
```

**1c.** Split the `/ai` leg out of the three-route test and invert it. Old (`:298-332`):
```tsx
  it('shows tree sidebar on /pages and /ai, swaps to settings sidebar on /settings', () => {
    // Pages root — Pages tree visible
    const { unmount } = render(
      <AppLayout>
        <div>page content</div>
      </AppLayout>,
      { wrapper: createWrapper('/') },
    );
    expect(screen.getByTestId('sidebar-tree-view')).toBeInTheDocument();
    expect(screen.queryByTestId('settings-sidebar')).not.toBeInTheDocument();
    unmount();

    // AI route — Pages tree stays (quick page navigation while chatting)
    const { unmount: unmount2 } = render(
      <AppLayout>
        <div>ai page</div>
      </AppLayout>,
      { wrapper: createWrapper('/ai') },
    );
    expect(screen.getByTestId('sidebar-tree-view')).toBeInTheDocument();
    expect(screen.queryByTestId('settings-sidebar')).not.toBeInTheDocument();
    unmount2();

    // Settings route — Pages tree replaced by SettingsSidebar so the main
    // nav strip stays visible alongside the Settings section nav.
    render(
      <AppLayout>
        <div>settings</div>
      </AppLayout>,
      { wrapper: createWrapper('/settings') },
    );
    expect(screen.queryByTestId('sidebar-tree-view')).not.toBeInTheDocument();
    expect(screen.getByTestId('settings-sidebar')).toBeInTheDocument();
  });
```

New:
```tsx
  it('shows the tree sidebar on /pages, swaps to the settings sidebar on /settings', () => {
    // Pages root — Pages tree visible
    const { unmount } = render(
      <AppLayout>
        <div>page content</div>
      </AppLayout>,
      { wrapper: createWrapper('/') },
    );
    expect(screen.getByTestId('sidebar-tree-view')).toBeInTheDocument();
    expect(screen.queryByTestId('settings-sidebar')).not.toBeInTheDocument();
    unmount();

    // Settings route — Pages tree replaced by SettingsSidebar so the main
    // nav strip stays visible alongside the Settings section nav.
    render(
      <AppLayout>
        <div>settings</div>
      </AppLayout>,
      { wrapper: createWrapper('/settings') },
    );
    expect(screen.queryByTestId('sidebar-tree-view')).not.toBeInTheDocument();
    expect(screen.getByTestId('settings-sidebar')).toBeInTheDocument();
  });

  // #1361: the Pages tree leaves /ai entirely. Page navigation there is the
  // command palette and the Pages tab of MainNavStrip; the rail is the
  // conversation history, mirroring what /settings already does.
  it('swaps the tree for the conversations pane on /ai and /ai/c/:id', async () => {
    const { unmount } = render(
      <AppLayout>
        <div>ai page</div>
      </AppLayout>,
      { wrapper: createWrapper('/ai') },
    );
    expect(await screen.findByTestId('ai-conversations-sidebar')).toBeInTheDocument();
    expect(screen.queryByTestId('sidebar-tree-view')).not.toBeInTheDocument();
    expect(screen.queryByTestId('settings-sidebar')).not.toBeInTheDocument();
    unmount();

    render(
      <AppLayout>
        <div>one conversation</div>
      </AppLayout>,
      { wrapper: createWrapper('/ai/c/11111111-1111-4111-8111-111111111111') },
    );
    expect(await screen.findByTestId('ai-conversations-sidebar')).toBeInTheDocument();
    expect(screen.queryByTestId('sidebar-tree-view')).not.toBeInTheDocument();
  });
```

**1d.** Add the drawer case and the request-count case, immediately after the test added in 1c:

```tsx
  it('puts the pane in the mobile drawer and closes it on a New chat tap', async () => {
    render(
      <AppLayout>
        <div>ai page</div>
      </AppLayout>,
      { wrapper: createWrapper('/ai') },
    );

    fireEvent.click(screen.getByLabelText('Open navigation menu'));
    const drawer = await screen.findByRole('dialog', { name: 'Navigation menu' });
    expect(within(drawer).getByTestId('ai-conversations-sidebar')).toBeInTheDocument();

    // New chat on /ai does not change the pathname, so only the pane's own
    // onNavigate can close the drawer — the discriminating half of the
    // "every row and New chat call onNavigate" rule.
    fireEvent.click(within(drawer).getByTestId('conversations-new-chat'));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Navigation menu' })).not.toBeInTheDocument();
    });
  });

  it('fetches the conversation list once on /ai and never on /pages/:id', async () => {
    const fetchSpy = vi.mocked(globalThis.fetch);
    const listCalls = () =>
      fetchSpy.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('/llm/conversations'));

    fetchSpy.mockClear();
    const { unmount } = render(
      <AppLayout>
        <div>ai page</div>
      </AppLayout>,
      { wrapper: createWrapper('/ai') },
    );
    await screen.findByTestId('ai-conversations-sidebar');
    await waitFor(() => expect(listCalls()).toHaveLength(1));
    unmount();

    fetchSpy.mockClear();
    render(
      <AppLayout>
        <div>just a page</div>
      </AppLayout>,
      { wrapper: createWrapper('/pages/abc') },
    );
    await waitFor(() => expect(screen.getByText('just a page')).toBeInTheDocument());
    expect(listCalls()).toEqual([]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/shared/components/layout/AppLayout.test.tsx`

Expected: FAIL — the three new/inverted cases report
`Unable to find an element by: [data-testid="ai-conversations-sidebar"]` (the layout still
renders `sidebar-tree-view` on `/ai`), and the request-count case fails with `[]` instead of one
call.

- [ ] **Step 3: Mount the pane**

Edit `frontend/src/shared/components/layout/AppLayout.tsx`.

**3a.** Imports. Old (`:13-14` and `:29`):
```tsx
import { SidebarTreeView } from './SidebarTreeView';
import { SettingsSidebar } from './SettingsSidebar';
```
New:
```tsx
import { SidebarTreeView } from './SidebarTreeView';
import { SettingsSidebar } from './SettingsSidebar';
import { AiConversationsSidebar } from '../../../features/ai/conversations/AiConversationsSidebar';
```

Old:
```tsx
import { isExistingArticlePath } from '../../lib/article-route';
```
New:
```tsx
import { isExistingArticlePath } from '../../lib/article-route';
import { isAiRoute as isAiRoutePath } from '../../lib/ai-routes';
```

**3b.** The route flag. Old (`:59-63`):
```tsx
  // On /settings* we swap the Pages tree for a Settings-specific sidebar so
  // the main nav (Pages / AI / Graph) stays accessible — otherwise users land
  // in Settings with no in-rail path back to the rest of the app, since the
  // header breadcrumb was retired in the same change.
  const isSettingsRoute = /^\/settings(\/|$)/.test(location.pathname);
```
New:
```tsx
  // On /settings* we swap the Pages tree for a Settings-specific sidebar so
  // the main nav (Pages / AI / Graph) stays accessible — otherwise users land
  // in Settings with no in-rail path back to the rest of the app, since the
  // header breadcrumb was retired in the same change.
  const isSettingsRoute = /^\/settings(\/|$)/.test(location.pathname);
  // #1361: /ai and /ai/c/:id get the conversations pane in the same slot. The
  // Pages tree leaves those routes entirely — page navigation there is the
  // command palette and MainNavStrip's Pages tab.
  const isAiRoute = isAiRoutePath(location.pathname);
```

**3c.** The mobile drawer. Old (`:500-502`):
```tsx
              {isSettingsRoute
                ? <SettingsSidebar onNavigate={closeMobileSidebar} />
                : <SidebarTreeView onNavigate={closeMobileSidebar} />}
```
New:
```tsx
              {isAiRoute
                ? <AiConversationsSidebar onNavigate={closeMobileSidebar} />
                : isSettingsRoute
                  ? <SettingsSidebar onNavigate={closeMobileSidebar} />
                  : <SidebarTreeView onNavigate={closeMobileSidebar} />}
```

**3d.** The desktop slot. Old (`:519-528`):
```tsx
          {isSettingsRoute
            ? <SettingsSidebar />
            : (
              <SidebarTreeView
                forceCollapsed={forceTreeCollapsed}
                onForceExpand={() => setMidWidthTreeExpandedOverride(true)}
              />
            )}
```
New:
```tsx
          {/* The AI arm takes no forceCollapsed / onForceExpand: that compaction
              is the article inspector's, and forceTreeCollapsed is already gated
              on isArticleRoute. Restored layout presets (#1368) reach the pane
              only through the shared treeSidebarCollapsed, which is intended. */}
          {isAiRoute
            ? <AiConversationsSidebar />
            : isSettingsRoute
              ? <SettingsSidebar />
              : (
                <SidebarTreeView
                  forceCollapsed={forceTreeCollapsed}
                  onForceExpand={() => setMidWidthTreeExpandedOverride(true)}
                />
              )}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/shared/components/layout/AppLayout.test.tsx`

Expected: PASS — all cases, including the untouched `keeps session chrome out of the header`
(`:287-297`), `hides article right pane on non-article routes` and the AI-provider describe's
`issues no AI requests on a route with no AI surface mounted` (`:628-643`), which stays green by
construction: the pane mounts only on AI routes and that test renders `/pages/abc`.

- [ ] **Step 5: Confirm the shell guards**

Run: `cd frontend && npx vitest run src/ai-scroll-chain.test.ts src/scroll-padding-mask.test.ts src/toolbar-rule-alignment.test.ts src/shared/components/layout/AppLayout.test.tsx src/features/ai/conversations`

Expected: PASS. `ai-scroll-chain` names only `AppLayout`, `PageTransition` and
`AiAssistantPage`; the pane is a sibling of `<main>` under `panel-wrapper` and owes that chain
nothing (amendment item 7).

Then: `cd frontend && npx tsc --noEmit` and `cd frontend && npm run lint` — expected: clean.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/shared/components/layout/AppLayout.tsx \
        frontend/src/shared/components/layout/AppLayout.test.tsx
git commit -m "feat(ai): mount the conversations pane on AI routes

Third arm of the sidebar ternary in both the desktop slot and the mobile drawer,
gated on isAiRoute. The AI arm takes no forceCollapsed/onForceExpand — no layout
preset can act on /ai — and the drawer passes onNavigate so a tap closes it.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

## Part C — Tree removal and `/ai` simplification (Tasks 14–17)

### Task 14: The Pages tree leaves `/ai`

Implements the spec's *`/ai` page changes* first bullet ("The Pages tree leaves `/ai`") — `docs/superpowers/specs/2026-08-17-ai-conversation-history-design.md`, and amendment item 8's anchor note (`isAiRoute` is still `pathname === '/ai'` at `SidebarTreeView.tsx:513`, still 26 occurrences in its test file).

The pane (Tasks 12–13) replaces the tree on AI routes, so the tree's `/ai` special-casing is dead weight: three producers of `/ai?pageId=`, one `activePageId` branch that reads `?pageId`, one prop threaded through two trees, and one memo-comparator field.

**Files:**
- Modify: `frontend/src/shared/components/layout/SidebarTreeView.tsx` (`:156-161`, `:182`, `:200-208`, `:383`, `:400`, `:444-452`, `:511-513`, `:1154-1159`, `:1436`, `:1456`)
- Modify: `frontend/src/shared/components/layout/DndLocalSpaceTree.tsx` (`:18-19`, `:35`, `:48`, `:107-114`, `:268`, `:285`, `:298`, `:339`)
- Test: `frontend/src/shared/components/layout/SidebarTreeView.test.tsx` (26 `isAiRoute` occurrences removed; both `#417` tests at `:368`/`:374` and the `#960` comparator test at `:1251-1262` deleted; two new assertions added)
- Test: `frontend/src/shared/components/layout/DndLocalSpaceTree.test.tsx` (one new assertion; **no** `isAiRoute` occurrence to remove — see Step 6)

**Interfaces:**
- Consumes: nothing from earlier tasks. (`isAiRoute` from Task 1's `shared/lib/ai-routes.ts` is deliberately **not** imported here — the tree stops caring about the route at all rather than importing a better predicate for the same branch.)
- Produces: `SidebarTreeNodeProps` and `DndLocalSpaceTreeProps` **without** `isAiRoute`. Task 12's `AiConversationsSidebar` copies chassis fragments from `SidebarTreeView.tsx`; those fragments are untouched here. `SECTION_LABEL` is exported by Task 11, not here.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/shared/components/layout/SidebarTreeView.test.tsx`, at the end of the top-level `describe('SidebarTreeView', …)` block (immediately before its closing `});`, i.e. after the `does not subscribe to location (#960)` describe):

```tsx
  // #1361: the conversations pane replaces this tree on AI routes, so the tree
  // has no AI behaviour left. Clicking a page while `/ai` is open navigates to
  // the page like everywhere else — it no longer rewrites the AI route's query
  // string with a page scope that `/ai` has stopped reading.
  describe('no AI-route special casing (#1361)', () => {
    it('navigates to the page, not to /ai?pageId=, while an AI route is open', () => {
      render(<SidebarTreeView />, { wrapper: createWrapper('/ai') });
      fireEvent.click(screen.getByText('API Reference'));
      expect(mockNavigate).toHaveBeenCalledWith('/pages/root-2');
      expect(mockNavigate).not.toHaveBeenCalledWith(
        expect.stringContaining('/ai?pageId='),
        expect.anything(),
      );
    });

    it('does not highlight a row from ?pageId on an AI route', () => {
      render(<SidebarTreeView />, { wrapper: createWrapper('/ai?pageId=child-1') });
      // `?pageId=` is inert everywhere now: `resolveAiPageId` answers null on an
      // AI route (#1361 Task 1) and this tree no longer reads the param at all.
      const installRef = screen.queryByText('Installation');
      if (installRef) expect(installRef.parentElement!.className).not.toContain('nav-selection');
    });

    // A source guard beside the behavioural ones, because the third producer
    // lives in the lazily-loaded local-space tree that only renders for a local
    // space: a behavioural test for it needs the whole dnd harness, and a
    // reintroduced literal in EITHER file is the thing that matters.
    it('neither tree implementation contains an /ai?pageId= literal', () => {
      const files = ['SidebarTreeView.tsx', 'DndLocalSpaceTree.tsx'];
      for (const file of files) {
        const source = readFileSync(join(import.meta.dirname, file), 'utf-8');
        expect(source, `${file} still produces /ai?pageId=`).not.toContain('/ai?pageId=');
        expect(source, `${file} still carries the isAiRoute prop`).not.toContain('isAiRoute');
      }
    });
  });
```

and add the two node imports at the top of the same file, directly under the existing `import { MemoryRouter, useSearchParams } from 'react-router-dom';` line group (exact position does not matter; put them after the last `import` statement of the file's header block):

```tsx
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
```

Append to `frontend/src/shared/components/layout/DndLocalSpaceTree.test.tsx`, inside the top-level `describe('DndLocalSpaceTree', …)` block (immediately before its closing `});`):

```tsx
  // #1361: the conversations pane owns the rail on AI routes, so this tree has
  // no AI branch left. It was the third `/ai?pageId=` producer.
  it('navigates to the page even when an AI route is open (#1361)', () => {
    render(
      <MemoryRouter initialEntries={['/ai']}>
        <DndLocalSpaceTree
          tree={[makeNode('p1', 'Page One')]}
          expandedIds={new Set<string>()}
          toggleExpand={vi.fn()}
          activePageId={undefined}
          reorderPage={{ mutate: vi.fn() }}
          rovingId="p1"
          onRowFocus={vi.fn()}
          onRowKeyDown={vi.fn()}
        />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByText('Page One'));
    expect(mockNavigate).toHaveBeenCalledWith('/pages/p1');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/shared/components/layout/SidebarTreeView.test.tsx src/shared/components/layout/DndLocalSpaceTree.test.tsx`

Expected: FAIL — `navigates to the page, not to /ai?pageId=, while an AI route is open` fails with `expected "spy" to be called with arguments: [ '/pages/root-2' ]` (the row still calls `navigate('/ai?pageId=root-2', { replace: true })`); `does not highlight a row from ?pageId on an AI route` fails on `expected 'group flex h-7 …nav-selection…' not to contain 'nav-selection'`; `neither tree implementation contains an /ai?pageId= literal` fails with `SidebarTreeView.tsx still produces /ai?pageId=`; the Dnd case fails the same way as the first.

- [ ] **Step 3: Delete the `isAiRoute` prop and its branches from `SidebarTreeView.tsx`**

Edit 1 — the prop declaration (`:156-161`):

old
```tsx
  activePageId: string | undefined;
  // #960: derived once by the parent from location.pathname and passed down as
  // a stable prop. Rows must NOT call useLocation() themselves — that subscribed
  // every memoized row to every location/searchParams change, defeating the memo
  // comparator and re-rendering the whole tree on each navigation.
  isAiRoute: boolean;
  // True only in "All Spaces" scope, where sibling rows can come from
```
new
```tsx
  activePageId: string | undefined;
  // #960's `isAiRoute` prop is gone (#1361): the conversations pane replaces
  // this tree on AI routes, so a row has no route-dependent destination left.
  // The rule it existed to enforce still stands — rows must NOT call
  // useLocation() themselves, or every memoized row re-renders on every
  // location/searchParams change and the comparator below never gets to bail.
  // True only in "All Spaces" scope, where sibling rows can come from
```

Edit 2 — the destructured param (`:182`):

old
```tsx
  activePageId,
  isAiRoute,
  showSpaceKey,
```
new
```tsx
  activePageId,
  showSpaceKey,
```

Edit 3 — `handleNavigate` (`:200-208`):

old
```tsx
  const handleNavigate = useCallback(() => {
    if (hasChildren && !isExpanded) toggleExpand(node.page.id);
    if (isAiRoute) {
      navigate(`/ai?pageId=${node.page.id}`, { replace: true });
    } else {
      navigate(`/pages/${node.page.id}`);
    }
  }, [navigate, node.page.id, hasChildren, isExpanded, toggleExpand, isAiRoute]);
```
new
```tsx
  const handleNavigate = useCallback(() => {
    if (hasChildren && !isExpanded) toggleExpand(node.page.id);
    navigate(`/pages/${node.page.id}`);
  }, [navigate, node.page.id, hasChildren, isExpanded, toggleExpand]);
```

Edit 4 — the recursive child (`:383`):

old
```tsx
              activePageId={activePageId}
              isAiRoute={isAiRoute}
              showSpaceKey={showSpaceKey}
```
new
```tsx
              activePageId={activePageId}
              showSpaceKey={showSpaceKey}
```

Edit 5 — the memo comparator (`:400`):

old
```tsx
    prev.expandedSet === next.expandedSet &&
    prev.isAiRoute === next.isAiRoute &&
    prev.showSpaceKey === next.showSpaceKey &&
```
new
```tsx
    prev.expandedSet === next.expandedSet &&
    prev.showSpaceKey === next.showSpaceKey &&
```

Edit 6 — `activePageId` (`:441-453`). `location.search` leaves the dependency array with the branch that read it, so a query-string change no longer re-derives the active row:

old
```tsx
  // Extract active page ID from pathname (useParams is unavailable here
  // because this component is rendered in AppLayout, outside the inner
  // <Routes> that defines /pages/:id).
  // On the AI route, also highlight the article selected via ?pageId query param.
  const activePageId = useMemo(() => {
    const match = location.pathname.match(/^\/pages\/([^/]+)$/);
    if (match) return match[1];
    if (location.pathname === '/ai') {
      const params = new URLSearchParams(location.search);
      return params.get('pageId') ?? undefined;
    }
    return undefined;
  }, [location.pathname, location.search]);
```
new
```tsx
  // Extract active page ID from pathname (useParams is unavailable here
  // because this component is rendered in AppLayout, outside the inner
  // <Routes> that defines /pages/:id).
  // The `/ai?pageId=` branch went with #1361: `/ai` carries no page scope, and
  // `location.search` left the dependency array with it — a query-string change
  // no longer re-derives the active row.
  const activePageId = useMemo(() => {
    const match = location.pathname.match(/^\/pages\/([^/]+)$/);
    if (match) return match[1];
    return undefined;
  }, [location.pathname]);
```

Edit 7 — the derived local (`:510-513`):

old
```tsx
  const isLocalSpace = selectedSpaceOption?.source === 'local';
  // #960: derive the /ai signal once here and thread it into every row as a
  // stable prop so the rows themselves don't subscribe to location.
  const isAiRoute = location.pathname === '/ai';
```
new
```tsx
  const isLocalSpace = selectedSpaceOption?.source === 'local';
```

Edit 8 — the pinned-page button (`:1153-1160`):

old
```tsx
                  onClick={() => {
                    if (isAiRoute) {
                      navigate(`/ai?pageId=${item.id}`, { replace: true });
                    } else {
                      navigate(`/pages/${item.id}`);
                    }
                    onNavigate?.();
                  }}
```
new
```tsx
                  onClick={() => {
                    navigate(`/pages/${item.id}`);
                    onNavigate?.();
                  }}
```

Edit 9 — the `DndLocalSpaceTree` call site (`:1436`):

old
```tsx
              activePageId={activePageId}
              isAiRoute={isAiRoute}
              reorderPage={reorderPage}
```
new
```tsx
              activePageId={activePageId}
              reorderPage={reorderPage}
```

Edit 10 — the `SidebarTreeNode` call site (`:1456`):

old
```tsx
                activePageId={activePageId}
                isAiRoute={isAiRoute}
                showSpaceKey={!treeSidebarSpaceKey}
```
new
```tsx
                activePageId={activePageId}
                showSpaceKey={!treeSidebarSpaceKey}
```

- [ ] **Step 4: Delete the `isAiRoute` prop and its branch from `DndLocalSpaceTree.tsx`**

Edit 1 — `DndLocalSpaceTreeProps` (`:17-19`):

old
```tsx
  activePageId: string | undefined;
  // #960: passed down from the parent so rows don't subscribe to location.
  isAiRoute: boolean;
  reorderPage: { mutate: (args: { id: string; sortOrder: number }) => void };
```
new
```tsx
  activePageId: string | undefined;
  reorderPage: { mutate: (args: { id: string; sortOrder: number }) => void };
```

Edit 2 — `DndSortableTreeNodeProps` (`:35`):

old
```tsx
  activePageId: string | undefined;
  isAiRoute: boolean;
  sortableIndex: number;
```
new
```tsx
  activePageId: string | undefined;
  sortableIndex: number;
```

Edit 3 — the node's destructured params (`:48`):

old
```tsx
  activePageId,
  isAiRoute,
  sortableIndex,
```
new
```tsx
  activePageId,
  sortableIndex,
```

Edit 4 — `handleNavigate` (`:107-114`):

old
```tsx
  const handleNavigate = useCallback(() => {
    if (hasChildren && !isExpanded) toggleExpand(node.page.id);
    if (isAiRoute) {
      navigate(`/ai?pageId=${node.page.id}`, { replace: true });
    } else {
      navigate(`/pages/${node.page.id}`);
    }
  }, [navigate, node.page.id, hasChildren, isExpanded, toggleExpand, isAiRoute]);
```
new
```tsx
  const handleNavigate = useCallback(() => {
    if (hasChildren && !isExpanded) toggleExpand(node.page.id);
    navigate(`/pages/${node.page.id}`);
  }, [navigate, node.page.id, hasChildren, isExpanded, toggleExpand]);
```

Edit 5 — the recursive child (`:268`):

old
```tsx
              activePageId={activePageId}
              isAiRoute={isAiRoute}
              sortableIndex={idx}
```
new
```tsx
              activePageId={activePageId}
              sortableIndex={idx}
```

Edit 6 — the memo comparator (`:285`):

old
```tsx
    prev.expandedSet === next.expandedSet &&
    prev.isAiRoute === next.isAiRoute &&
    prev.sortableIndex === next.sortableIndex &&
```
new
```tsx
    prev.expandedSet === next.expandedSet &&
    prev.sortableIndex === next.sortableIndex &&
```

Edit 7 — the default export's destructured params (`:298`):

old
```tsx
  activePageId,
  isAiRoute,
  reorderPage,
```
new
```tsx
  activePageId,
  reorderPage,
```

Edit 8 — the root row (`:339`):

old
```tsx
            activePageId={activePageId}
            isAiRoute={isAiRoute}
            sortableIndex={idx}
```
new
```tsx
            activePageId={activePageId}
            sortableIndex={idx}
```

- [ ] **Step 5: Delete the three obsolete tests in `SidebarTreeView.test.tsx`**

Delete the two `#417` tests at `:368-379` verbatim (both assert behaviour that no longer exists; the new `no AI-route special casing (#1361)` describe from Step 1 replaces them, asserting the inverse):

```tsx
  it('navigates to /ai?pageId= on click when on AI route (#417)', () => {
    render(<SidebarTreeView />, { wrapper: createWrapper('/ai') });
    fireEvent.click(screen.getByText('API Reference'));
    expect(mockNavigate).toHaveBeenCalledWith('/ai?pageId=root-2', { replace: true });
  });

  it('highlights the article matching ?pageId on the AI route (#417)', () => {
    render(<SidebarTreeView />, { wrapper: createWrapper('/ai?pageId=child-1') });
    const installRef = screen.getByText('Installation');
    const row = installRef.parentElement!;
    expect(row.className).toContain('nav-selection');
  });
```

Delete the `#960` comparator test at `:1251-1262` verbatim (the prop it compares is gone; the comparator's remaining fields keep their own cases directly above and below it):

```tsx
  it('custom comparator returns false (re-render) when isAiRoute changes (#960)', () => {
    const component = SidebarTreeNode as unknown as {
      compare: (prev: SidebarTreeNodeProps, next: SidebarTreeNodeProps) => boolean;
    };
    const node = makeNode('page-1', 'Test');
    const expandedSet = new Set<string>();
    const toggleExpand = vi.fn();
    const prev: SidebarTreeNodeProps = { node, level: 0, expandedSet, toggleExpand, activePageId: undefined, isAiRoute: false, showSpaceKey: false };
    const next: SidebarTreeNodeProps = { node, level: 0, expandedSet, toggleExpand, activePageId: undefined, isAiRoute: true, showSpaceKey: false };

    expect(component.compare(prev, next)).toBe(false);
  });
```

Update the `#960` "does not subscribe to location" comment at `:2030-2034`, which still describes the deleted prop as the fix:

old
```tsx
  // #960: memoized rows used to call useLocation() internally, so every
  // location / searchParams change re-rendered every row in the tree — the
  // memo comparator never got a chance to bail. The /ai signal is now passed
  // in as a stable `isAiRoute` prop derived once by the parent, so a row only
  // re-renders when one of its actually-tracked props changes.
```
new
```tsx
  // #960: memoized rows used to call useLocation() internally, so every
  // location / searchParams change re-rendered every row in the tree — the
  // memo comparator never got a chance to bail. Rows take no location input at
  // all now (#1361 removed the last one, the `/ai` signal), so a row only
  // re-renders when one of its actually-tracked props changes.
```

- [ ] **Step 6: Strip the remaining `isAiRoute` occurrences from the two test files**

After Step 5 there are 23 `isAiRoute` occurrences left in `SidebarTreeView.test.tsx`, all of them the prop being supplied to a render or to a `SidebarTreeNodeProps` literal. They come in exactly two textual shapes; remove both, then verify the count is zero:

Run:
```bash
cd frontend
sed -i '' '/^ *isAiRoute={false}$/d' src/shared/components/layout/SidebarTreeView.test.tsx
sed -i '' '/^ *isAiRoute: false,$/d' src/shared/components/layout/SidebarTreeView.test.tsx
sed -i '' 's/isAiRoute: false, //g' src/shared/components/layout/SidebarTreeView.test.tsx
grep -c isAiRoute src/shared/components/layout/SidebarTreeView.test.tsx || true
```
Expected: `grep -c` prints `0` (grep exits 1, hence the `|| true`).

`DndLocalSpaceTree.test.tsx` needs **no** edit for the prop: its `renderTree` helper's `defaultProps` and its one inline `<DndLocalSpaceTree …>` rerender already omit `isAiRoute` (the file predates it being required, and `tsconfig.json` excludes `src/**/*.test.tsx` so the missing member never failed `tsc`). Verify rather than assume:

Run: `cd frontend && grep -c isAiRoute src/shared/components/layout/DndLocalSpaceTree.test.tsx || true`
Expected: `0`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/shared/components/layout/SidebarTreeView.test.tsx src/shared/components/layout/DndLocalSpaceTree.test.tsx src/shared/components/layout/AppLayout.test.tsx src/shared/components/layout/sidebar-tree-keyboard.test.ts`

Expected: PASS. `AppLayout.test.tsx` is in the list because it mocks `SidebarTreeView` and must stay green through a prop change on the real one.

- [ ] **Step 8: Run the guard suites this task touches, plus typecheck and lint**

Run:
```bash
cd frontend
npx vitest run src/toolbar-rule-alignment.test.ts src/flat-components.test.ts src/ui-text-legibility.test.ts src/focus-ring-contrast.test.ts
npx tsc --noEmit
npm run lint
```
Expected: all pass. `tsc` is the one that proves nothing else in `src/` still passes `isAiRoute` (test files are excluded from it, which is why Step 6 verifies those by `grep` instead).

- [ ] **Step 9: Commit**

```bash
git add frontend/src/shared/components/layout/SidebarTreeView.tsx \
        frontend/src/shared/components/layout/SidebarTreeView.test.tsx \
        frontend/src/shared/components/layout/DndLocalSpaceTree.tsx \
        frontend/src/shared/components/layout/DndLocalSpaceTree.test.tsx
git commit -m "refactor(ui): drop the Pages tree's /ai branch from both tree implementations

The conversations pane replaces the tree in the rail on AI routes (#1361), so
the three /ai?pageId= producers, the ?pageId highlight branch and the isAiRoute
prop threaded through every memoized row have nothing left to serve.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---
### Task 15: `/ai` page simplification + New chat in the header slot

Implements the spec's *`/ai` page changes* bullets 2–4 (*Page scope retired on `/ai`*, *Action selector on `/ai` offers Q&A + Generate*, *The model `<select>` goes*) and its *Loading and error states* bullet, **as superseded by amendment item 2** (New chat moves to the 48px header slot; the sub-header bar stays with Think + `DiagramTypeSelector`; the divider `:384` and the `flex-1` spacer `:298` go).

**Pinned here (three decisions the spec leaves open):**
1. **Improve and Diagram become unreachable on `/ai`, and their page-level tests go with them.** `AI_HOME_ACTIONS` removes the menu items and the URL allow-list removes the deep link, so `mode` on an AI route can only ever be `ask` or `generate`. The page's `mode === 'improve'` / `mode === 'diagram'` arms are **left in the source** (amendment item 2 explicitly keeps `DiagramTypeSelector`, and deleting `ImproveMode`/`DiagramMode` from the page is a change the spec does not ask for), but every `AiAssistantPage.test.tsx` case that reaches them through a `?mode=` deep link is deleted rather than kept alive through a synthetic mode-setter: with `resolveAiPageId` answering `null` on AI routes (Task 1), those cases also assert a resolved page that `/ai` can no longer have, so keeping them would pin a state production cannot enter. The components keep their own suites (`modes/ImproveMode.test.tsx`, `modes/ImproveMode.attachments.test.tsx`, `modes/DiagramMode.test.tsx`) and the live equivalents keep the dock's (`dock/AiDock.improve-type.test.tsx`, `dock/AiDock.upload.test.tsx`, `dock/DockDiffCard.test.tsx`). Two cases are **moved rather than dropped**, because their subject is still live in the dock: *Use in page* (`DiagramPreview` is rendered by `DockPanel` too) moves to `modes/DiagramMode.test.tsx`, and *attachments paused for Diagram* moves to `dock/AiDock.upload.test.tsx`.
2. **The error block's copy.** The spec quotes *Loading conversation…* but not the error heading. This task uses *Couldn't load conversation* (singular — one conversation, not the list, whose heading is Task 11's *Couldn't load conversations*), the body `threadLoadError ?? 'The request did not complete.'` (the shared string from Global Constraints) and the button label **Retry**.
3. **The header cluster's alignment.** `PagesPage.tsx:763-771` is the button recipe; the slot itself is `flex min-w-0 flex-1 items-center gap-3`, so the button carries `ml-auto` to sit at the far end, exactly as `PagesPage`'s right cluster does.

**Files:**
- Create: `frontend/src/features/ai/assistant-actions.ts`
- Test: `frontend/src/features/ai/assistant-actions.test.ts`
- Modify: `frontend/src/features/ai/AssistantActionSelect.tsx` (`:24`, `:110-176`)
- Modify: `frontend/src/features/ai/modes/AskMode.tsx` (`:4`, `:326`), `modes/ImproveMode.tsx` (`:13`, `:273`), `modes/DiagramMode.tsx` (`:5`, `:202`), `modes/GenerateMode.tsx` (`:5`, `:544`), `dock/DockPanel.tsx` (`:19`, `:437`)
- Modify: `frontend/src/features/ai/AiContext.tsx` (`:385-386`, and the `?q=` prefill's route boolean)
- Modify: `frontend/src/features/ai/AiAssistantPage.tsx` (`:1-7`, `:214-228`, `:297-386`, `:497`, `:1461-…`)
- Test: `frontend/src/features/ai/AiAssistantPage.test.tsx`
- Test: `frontend/src/features/ai/modes/DiagramMode.test.tsx` (one moved case)
- Test: `frontend/src/features/ai/dock/AiDock.upload.test.tsx` (one moved case)

**Interfaces:**
- Consumes: Task 1's `isAiRoute(pathname)` from `shared/lib/ai-routes` (already imported by `AiContext.tsx` after Task 1); Task 2's `startNewConversation()`; Task 5's `threadLoadState` / `threadLoadError` / `retryThreadLoad`.
- Produces: `AssistantAction`, `AI_HOME_ACTIONS`, `DOCK_ACTIONS`, `isAiHomeAction` from `features/ai/assistant-actions.ts`; `AssistantActionSelect`'s `actions: readonly AssistantAction[]` prop (`includeGenerate` removed); `data-testid="ai-new-chat"`; `data-testid="ai-thread-loading"`; `data-testid="ai-thread-error"`.

- [ ] **Step 1: Write the failing test for the action allow-list module**

Create `frontend/src/features/ai/assistant-actions.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { AI_HOME_ACTIONS, DOCK_ACTIONS, isAiHomeAction } from './assistant-actions';
import { IMPROVEMENT_TYPES } from './improvement-types';

describe('assistant action allow-lists (#1361)', () => {
  it('offers Q&A and Generate on /ai, in that order', () => {
    expect(AI_HOME_ACTIONS).toEqual(['ask', 'generate']);
  });

  it('offers Q&A, every rewrite skill and Diagram in the dock — never Generate', () => {
    // Generate creates a NEW page rather than acting on the open one, which is
    // why the dock has never offered it (CLAUDE.md's docked-assistant note).
    expect(DOCK_ACTIONS).toEqual(['ask', ...IMPROVEMENT_TYPES, 'diagram']);
    expect(DOCK_ACTIONS).not.toContain('generate');
  });

  it('derives the dock list from the contract rather than restating the skills', () => {
    // A sixth improvement pass added to the contract enum has to reach the dock
    // without this file being edited — the `improvement-types.ts` argument.
    for (const type of IMPROVEMENT_TYPES) expect(DOCK_ACTIONS).toContain(type);
  });

  it('narrows a raw URL mode to the two actions /ai can run', () => {
    expect(isAiHomeAction('ask')).toBe(true);
    expect(isAiHomeAction('generate')).toBe(true);
    for (const rejected of ['improve', 'diagram', 'grammar', 'summarize', 'quality', '', 'ASK']) {
      expect(isAiHomeAction(rejected)).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/features/ai/assistant-actions.test.ts`
Expected: FAIL — `Failed to resolve import "./assistant-actions"`.

- [ ] **Step 3: Create the leaf module**

Create `frontend/src/features/ai/assistant-actions.ts`:

```ts
import { IMPROVEMENT_TYPES, type ImprovementType } from './improvement-types';

/**
 * What the one control beside Send can be set to.
 *
 * The type and the two allow-lists live in this leaf module rather than in
 * `AssistantActionSelect.tsx` (which is where the type used to live) because
 * `AssistantActionSelect` imports `AiContext`, and `AiContext` now has to read
 * the `/ai` list to decide which `?mode=` deep links it accepts — putting the
 * list in the component would close that import cycle. Same shape and same
 * argument as `improvement-types.ts`.
 */
export type AssistantAction = 'ask' | ImprovementType | 'diagram' | 'generate';

/**
 * `/ai` (#1361). Q&A and Generate — the two actions that do not need an open
 * document. The rewrite skills and Diagram act ON the page you are reading,
 * and `/ai` no longer carries a page scope for them to act on: the Pages tree
 * has left the rail and `resolveAiPageId` answers `null` on an AI route.
 */
export const AI_HOME_ACTIONS: readonly AssistantAction[] = ['ask', 'generate'];

/**
 * The article-side dock. Everything except Generate, which creates a NEW page
 * rather than acting on the open one.
 *
 * Spread from the contract-derived `IMPROVEMENT_TYPES` rather than restated, so
 * a sixth pass added to the enum reaches the dock without this file changing.
 */
export const DOCK_ACTIONS: readonly AssistantAction[] = ['ask', ...IMPROVEMENT_TYPES, 'diagram'];

/**
 * Narrows a raw `?mode=` value to the modes an AI route accepts.
 *
 * A predicate rather than `AI_HOME_ACTIONS.includes(value)` because the caller
 * needs the *type* narrowing: `AiContext` assigns the result to `Mode`, and
 * `readonly AssistantAction[]` includes the five improvement types, which are
 * not modes at all.
 */
export function isAiHomeAction(value: string): value is 'ask' | 'generate' {
  return value === 'ask' || value === 'generate';
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/features/ai/assistant-actions.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Write the failing test for the `/ai` action menu**

In `frontend/src/features/ai/AiAssistantPage.test.tsx`, replace the test at `:168-176`:

old
```tsx
  it('offers Q&A, five standalone rewrite skills, Diagram, and Generate', async () => {
    render(<AiAssistantPage />, { wrapper: createWrapper() });
    fireEvent.pointerDown(screen.getByTestId('assistant-action-select'), { button: 0 });
    for (const action of ['ask', 'grammar', 'structure', 'clarity', 'technical', 'completeness', 'diagram', 'generate']) {
      expect(await screen.findByTestId(`assistant-action-${action}`)).toBeInTheDocument();
    }
    expect(screen.queryByText('Summarize')).not.toBeInTheDocument();
    expect(screen.queryByText('Quality')).not.toBeInTheDocument();
  });
```
new
```tsx
  // #1361: the two actions that need no open document. The rewrite skills and
  // Diagram act ON the page you are reading, and `/ai` has no page scope left —
  // the Pages tree has left the rail and `resolveAiPageId` answers null here.
  // They stay in the dock, which does have one (`DOCK_ACTIONS`).
  it('offers Q&A and Generate only', async () => {
    render(<AiAssistantPage />, { wrapper: createWrapper() });
    fireEvent.pointerDown(screen.getByTestId('assistant-action-select'), { button: 0 });
    for (const action of ['ask', 'generate']) {
      expect(await screen.findByTestId(`assistant-action-${action}`)).toBeInTheDocument();
    }
    for (const action of ['grammar', 'structure', 'clarity', 'technical', 'completeness', 'diagram']) {
      expect(screen.queryByTestId(`assistant-action-${action}`)).not.toBeInTheDocument();
    }
    expect(screen.queryByText('Rewrite skills')).not.toBeInTheDocument();
    expect(screen.queryByText('Summarize')).not.toBeInTheDocument();
    expect(screen.queryByText('Quality')).not.toBeInTheDocument();
  });
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/features/ai/AiAssistantPage.test.tsx -t "offers Q&A and Generate only"`
Expected: FAIL — `expected null not to be null` on `assistant-action-grammar` (the flat list still renders all eight items).

- [ ] **Step 7: Give `AssistantActionSelect` an allow-list prop**

Edit 1 — the type moves out (`AssistantActionSelect.tsx:16-24`):

old
```tsx
import { useAiContext, type Mode } from './AiContext';
import {
  IMPROVEMENT_DESCRIPTIONS,
  IMPROVEMENT_TYPES,
  type ImprovementType,
} from './improvement-types';
import { cn } from '../../shared/lib/cn';

export type AssistantAction = 'ask' | ImprovementType | 'diagram' | 'generate';
```
new
```tsx
import { useAiContext, type Mode } from './AiContext';
import {
  IMPROVEMENT_DESCRIPTIONS,
  IMPROVEMENT_TYPES,
  type ImprovementType,
} from './improvement-types';
import { type AssistantAction } from './assistant-actions';
import { cn } from '../../shared/lib/cn';

// The type moved to the leaf module (#1361) so `AiContext` can read the
// allow-lists without closing an import cycle through this component.
// Re-exported here for the callers that already import it from this path.
export type { AssistantAction };
```

Edit 2 — the component takes `actions` (`:110-124`):

old
```tsx
export function AssistantActionSelect({
  includeGenerate = false,
  disabled = false,
  className,
}: {
  includeGenerate?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const { mode, setMode, improvementType, setImprovementType } = useAiContext();
  const selected = resolveAssistantAction(mode, improvementType);
  const available = includeGenerate || selected !== 'generate' ? selected : 'ask';
  const definitions = [CHAT_ACTION, ...IMPROVEMENT_ACTIONS, DIAGRAM_ACTION, ...(includeGenerate ? [GENERATE_ACTION] : [])];
  const current = definitions.find((action) => action.id === available) ?? CHAT_ACTION;
  const { Icon } = current;
```
new
```tsx
export function AssistantActionSelect({
  actions,
  disabled = false,
  className,
}: {
  /**
   * The allow-list this surface offers — `AI_HOME_ACTIONS` on `/ai`,
   * `DOCK_ACTIONS` in the article dock (#1361). It replaced a boolean
   * `includeGenerate`, which could only ever describe one of the two
   * differences between the surfaces.
   */
  actions: readonly AssistantAction[];
  disabled?: boolean;
  className?: string;
}) {
  const { mode, setMode, improvementType, setImprovementType } = useAiContext();
  const selected = resolveAssistantAction(mode, improvementType);
  // A selection this surface does not offer reads as Q&A rather than as a
  // trigger naming an action Send cannot run — the same fallback the old
  // `includeGenerate` form applied to Generate, generalised.
  const available = actions.includes(selected) ? selected : 'ask';
  const chatActions = actions.includes('ask') ? [CHAT_ACTION] : [];
  const rewriteActions = IMPROVEMENT_ACTIONS.filter((action) => actions.includes(action.id));
  const createActions = [DIAGRAM_ACTION, GENERATE_ACTION].filter((action) => actions.includes(action.id));
  const definitions = [...chatActions, ...rewriteActions, ...createActions];
  const current = definitions.find((action) => action.id === available) ?? CHAT_ACTION;
  const { Icon } = current;
```

Edit 3 — the menu body (`:155-176`):

old
```tsx
          <DropdownMenu.Label className="px-2.5 pb-1 pt-1.5 text-xs font-medium text-muted-foreground">
            Assistant chat
          </DropdownMenu.Label>
          <ActionItem action={CHAT_ACTION} selected={available === 'ask'} onSelect={selectAction} />

          <DropdownMenu.Separator className="my-1.5 h-px bg-border" />
          <DropdownMenu.Label className="px-2.5 pb-1 pt-1.5 text-xs font-medium text-muted-foreground">
            Rewrite skills
          </DropdownMenu.Label>
          {IMPROVEMENT_ACTIONS.map((action) => (
            <ActionItem key={action.id} action={action} selected={available === action.id} onSelect={selectAction} />
          ))}

          <DropdownMenu.Separator className="my-1.5 h-px bg-border" />
          <DropdownMenu.Label className="px-2.5 pb-1 pt-1.5 text-xs font-medium text-muted-foreground">
            Create
          </DropdownMenu.Label>
          <ActionItem action={DIAGRAM_ACTION} selected={available === 'diagram'} onSelect={selectAction} />
          {includeGenerate && (
            <ActionItem action={GENERATE_ACTION} selected={available === 'generate'} onSelect={selectAction} />
          )}
```
new
```tsx
          {chatActions.length > 0 && (
            <>
              <DropdownMenu.Label className="px-2.5 pb-1 pt-1.5 text-xs font-medium text-muted-foreground">
                Assistant chat
              </DropdownMenu.Label>
              {chatActions.map((action) => (
                <ActionItem key={action.id} action={action} selected={available === action.id} onSelect={selectAction} />
              ))}
            </>
          )}

          {/* A section header with no items under it is worse than a shorter
              menu, so each group — and the rule above it — renders only when
              this surface's allow-list carries something for it. */}
          {rewriteActions.length > 0 && (
            <>
              <DropdownMenu.Separator className="my-1.5 h-px bg-border" />
              <DropdownMenu.Label className="px-2.5 pb-1 pt-1.5 text-xs font-medium text-muted-foreground">
                Rewrite skills
              </DropdownMenu.Label>
              {rewriteActions.map((action) => (
                <ActionItem key={action.id} action={action} selected={available === action.id} onSelect={selectAction} />
              ))}
            </>
          )}

          {createActions.length > 0 && (
            <>
              <DropdownMenu.Separator className="my-1.5 h-px bg-border" />
              <DropdownMenu.Label className="px-2.5 pb-1 pt-1.5 text-xs font-medium text-muted-foreground">
                Create
              </DropdownMenu.Label>
              {createActions.map((action) => (
                <ActionItem key={action.id} action={action} selected={available === action.id} onSelect={selectAction} />
              ))}
            </>
          )}
```

- [ ] **Step 8: Update all five call sites**

`frontend/src/features/ai/modes/AskMode.tsx` — `:4`:

old
```tsx
import { AssistantActionSelect } from '../AssistantActionSelect';
```
new
```tsx
import { AssistantActionSelect } from '../AssistantActionSelect';
import { AI_HOME_ACTIONS } from '../assistant-actions';
```

`:326`:

old
```tsx
        <AssistantActionSelect includeGenerate disabled={isStreaming} className="self-end" />
```
new
```tsx
        <AssistantActionSelect actions={AI_HOME_ACTIONS} disabled={isStreaming} className="self-end" />
```

`frontend/src/features/ai/modes/ImproveMode.tsx` — `:13`:

old
```tsx
import { AssistantActionSelect } from '../AssistantActionSelect';
```
new
```tsx
import { AssistantActionSelect } from '../AssistantActionSelect';
import { AI_HOME_ACTIONS } from '../assistant-actions';
```

`:273`:

old
```tsx
        <AssistantActionSelect includeGenerate disabled={isStreaming} className="self-end" />
```
new
```tsx
        <AssistantActionSelect actions={AI_HOME_ACTIONS} disabled={isStreaming} className="self-end" />
```

`frontend/src/features/ai/modes/DiagramMode.tsx` — `:5`:

old
```tsx
import { AssistantActionSelect } from '../AssistantActionSelect';
```
new
```tsx
import { AssistantActionSelect } from '../AssistantActionSelect';
import { AI_HOME_ACTIONS } from '../assistant-actions';
```

`:202`:

old
```tsx
        <AssistantActionSelect includeGenerate disabled={isStreaming} className="self-end" />
```
new
```tsx
        <AssistantActionSelect actions={AI_HOME_ACTIONS} disabled={isStreaming} className="self-end" />
```

`frontend/src/features/ai/modes/GenerateMode.tsx` — `:5`:

old
```tsx
import { AssistantActionSelect } from '../AssistantActionSelect';
```
new
```tsx
import { AssistantActionSelect } from '../AssistantActionSelect';
import { AI_HOME_ACTIONS } from '../assistant-actions';
```

`:544`:

old
```tsx
          <AssistantActionSelect includeGenerate disabled={isStreaming} className="self-end" />
```
new
```tsx
          <AssistantActionSelect actions={AI_HOME_ACTIONS} disabled={isStreaming} className="self-end" />
```

`frontend/src/features/ai/dock/DockPanel.tsx` — `:19`:

old
```tsx
import { AssistantActionSelect, resolveAssistantAction } from '../AssistantActionSelect';
```
new
```tsx
import { AssistantActionSelect, resolveAssistantAction } from '../AssistantActionSelect';
import { DOCK_ACTIONS } from '../assistant-actions';
```

`:437`:

old
```tsx
          <AssistantActionSelect disabled={isStreaming || modelsError} className="self-end" />
```
new
```tsx
          <AssistantActionSelect actions={DOCK_ACTIONS} disabled={isStreaming || modelsError} className="self-end" />
```

`ImproveMode.tsx` and `DiagramMode.tsx` are `/ai` composers, so they take `AI_HOME_ACTIONS` like the other two — after this task their modes are unreachable on `/ai`, and the `available` fallback above means the trigger reads "Q&A" rather than naming a missing item if one is ever mounted in that state.

- [ ] **Step 9: Run the tests to verify the menu is right**

Run: `cd frontend && npx vitest run src/features/ai/AiAssistantPage.test.tsx -t "offers Q&A and Generate only" && npx vitest run src/features/ai/dock/AiDock.improve-type.test.tsx`
Expected: both PASS. `AiDock.improve-type.test.tsx:76-89` is the dock's own list assertion (all five skills present, `assistant-action-generate` absent) and proves `DOCK_ACTIONS` did not change the dock.

- [ ] **Step 10: Write the failing test for the URL-mode allow-list**

In `frontend/src/features/ai/AiAssistantPage.test.tsx`, replace the two deep-link tests at `:639-653` (inside `describe('improve mode')`, which Step 14 deletes) by adding this new top-level describe immediately after the `offers Q&A and Generate only` test:

```tsx
  // #1361: `/ai` runs two actions, so its URL parser admits two modes. A
  // deep link naming any other one falls back to Q&A rather than rendering a
  // screen with no way back to the composer the route is for — the same
  // fallback the retired `summarize` / `quality` values already got.
  describe('URL mode allow-list on an AI route (#1361)', () => {
    for (const rejected of ['improve', 'diagram', 'summarize', 'quality']) {
      it(`falls back to Q&A for ?mode=${rejected}`, () => {
        render(<AiAssistantPage />, { wrapper: createWrapper([`/ai?mode=${rejected}`]) });
        expect(screen.getByText('Ask questions about your knowledge base')).toBeInTheDocument();
        expect(screen.getByTestId('assistant-action-select')).toHaveAccessibleName('Selected action: Q&A');
      });
    }

    it('still honours ?mode=generate', () => {
      render(<AiAssistantPage />, { wrapper: createWrapper(['/ai?mode=generate']) });
      expect(screen.getByTestId('assistant-action-select')).toHaveAccessibleName('Selected action: Generate');
    });
  });
```

- [ ] **Step 11: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/features/ai/AiAssistantPage.test.tsx -t "URL mode allow-list"`
Expected: FAIL on `?mode=improve` and `?mode=diagram` with `Unable to find an element with the text: Ask questions about your knowledge base` (the parser still accepts every `Mode`).

- [ ] **Step 12: Narrow the URL-mode parser on AI routes**

`frontend/src/features/ai/AiContext.tsx` — add the import beside the `ai-routes` import Task 1 introduced:

old
```tsx
import { DEFAULT_IMPROVEMENT_TYPE, type ImprovementType } from './improvement-types';
```
new
```tsx
import { DEFAULT_IMPROVEMENT_TYPE, type ImprovementType } from './improvement-types';
import { isAiHomeAction } from './assistant-actions';
```

Then the parser itself (`:385-386` at HEAD, ~`:390` after Tasks 1–5):

old
```tsx
  const rawMode = searchParams.get('mode');
  const urlMode = VALID_MODES.includes(rawMode as Mode) ? (rawMode as Mode) : null;
```
new
```tsx
  // #1361: which modes a `?mode=` deep link may select depends on the surface
  // the provider is serving. On an AI route it is `AI_HOME_ACTIONS`' two
  // (`isAiHomeAction`); on `/pages/:id` — the dock — the full set still
  // applies, because the dock offers the rewrite skills and Diagram. This
  // boolean is read again by the `?q=` prefill below; there is exactly one of
  // it in the provider.
  const onAiRoute = isAiRoute(location.pathname);
  const rawMode = searchParams.get('mode');
  const urlMode = rawMode !== null
    && (onAiRoute ? isAiHomeAction(rawMode) : VALID_MODES.includes(rawMode as Mode))
    ? (rawMode as Mode)
    : null;
```

And the `?q=` prefill's own route boolean, which Task 1 rewrote from `location.pathname === '/ai'` to the shared predicate — hoist it onto the single `onAiRoute` above so the provider carries one:

old (post-Task-1 text)
```tsx
  const isAiRouteHere = isAiRoute(location.pathname);
  const urlQuestion = isAiRouteHere ? searchParams.get('q') : null;
```
new
```tsx
  const urlQuestion = onAiRoute ? searchParams.get('q') : null;
```

If Task 1 left that local under a different name, delete it and use `onAiRoute` at its use site — the provider must end up with exactly one AI-route boolean, computed above the mode parser.

- [ ] **Step 13: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/features/ai/AiAssistantPage.test.tsx -t "URL mode allow-list" && npx vitest run src/features/ai/AiContext.threads.test.tsx`
Expected: both PASS.

- [ ] **Step 14: Delete the page tests that pin the chrome this task removes**

There is no failing-test-first form for a deletion, so the pins go before the code they pin. Delete, in `frontend/src/features/ai/AiAssistantPage.test.tsx`, each whole `it(...)` / `describe(...)` block below (line numbers are HEAD's, before any of this task's edits):

| Block | Lines | Why it goes, and where the behaviour is still covered |
|---|---|---|
| `sends the composed draft and attachments through the rewrite skill selected beside Send` | `:178-242` | `/ai` no longer offers a rewrite skill. Same gesture on the surface that does: `dock/AiDock.improve-type.test.tsx`. |
| `sends attached documents and configuration to the Completeness skill` | `:243-307` | As above; the dock's document path is `dock/AiDock.upload.test.tsx`. |
| `keeps prepared attachments paused while Diagram sends only the shared instruction` | `:308-380` | `/ai` no longer offers Diagram. **Moved** to `dock/AiDock.upload.test.tsx` in Step 20. |
| `clears staged attachments when the page context changes` | `:381-418` | The context chip it clicks is deleted, and `/ai` has no page context to change. The scope-clear rule itself is re-pinned on `activeThreadId` by Task 6. (The plan's `:394-415` is this test's interior; a partial deletion does not parse, so the whole `it` goes.) |
| `does not render a conversations sidebar` | `:433-437` | Inverted by this PR — the pane is exactly what `/ai` now renders, asserted in `AppLayout.test.tsx` (Task 13). |
| `shows "Loading models..." when models have not loaded yet` | `:444-448` | The model `<select>` and its loading chip are deleted. |
| `shows model selector after models load` | `:449-469` | As above. |
| `describe('models error chip (degraded LLM provider)')` (2 tests) | `:470-539` | The chip is deleted from `/ai`; `modelsError` / `refetchModels` stay for the dock, whose own chip is pinned at `dock/AiDock.test.tsx:283`. |
| `describe('improve mode')` (12 tests) | `:540-898` | Improve is unreachable on `/ai`. `modes/ImproveMode.test.tsx` and `modes/ImproveMode.attachments.test.tsx` cover the composer; `dock/DockDiffCard.test.tsx` covers apply. Its two deep-link cases (`:639-653`) are replaced by Step 10's describe. |
| `describe('diagram mode - Use in page')` (3 tests) | `:1252-1390` | Diagram is unreachable on `/ai`. **Moved** to `modes/DiagramMode.test.tsx` in Step 19 — `DiagramPreview` is still rendered by `DockPanel`. |
| `describe('sub-pages toggle')` (5 tests) | `:1391-1539` | The `+ Sub-pages` control is deleted and `pageId` is `null` on every AI route, so both fields the last two cases assert on the `/llm/improve` body are gone from this surface. The dock still sends both (`dock/use-dock-actions.ts`). |
| `names the page the answers are scoped to, and lets it be cleared` | `:1547-1568` | The context chip is deleted. |
| `starts fresh conversation when mounted with different pageId` | `:1569-1596` | Asserts the improve empty state for a page `/ai` cannot resolve. |
| `shows only the correct empty state for improve mode without spurious messages` | `:1643-1657` | Improve is unreachable on `/ai`; the sibling Q&A case at `:1658` stays. |
| `startNewConversation resets model to the current chat default (Finding 2, AC-4)` | `:2230-2296` | #355 AC-4 is retired by Task 2: `startNewConversation` no longer touches the model. A new conversation inherits the admin's chat assignment because that is what `model` already is. |

`describe('AI context page change (#417)')` keeps two of its four tests — `reads the thread from the hoisted provider rather than one of its own (#1126)` (`:1597-1625`) and `defaults to Q&A when a pageId is present but no mode is given` (`:1629-1641`); the second now proves the *absence* of page scope and passes unchanged.

Run: `cd frontend && npx vitest run src/features/ai/AiAssistantPage.test.tsx`
Expected: PASS (a smaller suite; nothing left in it asserts the removed chrome).

- [ ] **Step 15: Rewrite the four `#355` cases that read the deleted `<select>`**

Still in `AiAssistantPage.test.tsx`, `describe('chat use-case default pre-fill (#355)')`. The resolution logic those cases are about lives in `AiContext`, not in the dropdown, and the file already has the pattern for observing it (the AC-4 case rendered a `Capture` inside the provider). `queries /ollama/models with ?usecase=chat (Finding 4 — not ?provider=…)` reads no `<select>` and stays byte-identical.

Replace the body of `pre-fills the model selector from /llm/usecase-default?usecase=chat on mount`:

old
```tsx
      render(<AiAssistantPage />, { wrapper: createWrapper() });

      // Wait for the model dropdown to render (i.e. models loaded).
      await waitFor(() => {
        expect(screen.queryByText('Loading models...')).not.toBeInTheDocument();
      });

      const select = document.querySelector('select') as HTMLSelectElement | null;
      expect(select).not.toBeNull();
      expect(select!.value).toBe('qwen3:8b');
```
new
```tsx
      // #1361 deleted `/ai`'s model dropdown; the resolution it displayed is
      // AiContext's, and both the dock and Ask read it from there.
      let captured: ReturnType<typeof useAiContext> | null = null;
      function Capture() {
        captured = useAiContext();
        return null;
      }
      render(<Capture />, { wrapper: createWrapper() });

      await waitFor(() => expect(captured?.model).toBe('qwen3:8b'));
```

and rename it: `it('pre-fills the chat model from /llm/usecase-default?usecase=chat on mount', async () => {`.

Replace the body of `falls back to /settings model when chat use-case default is unavailable (404)`:

old
```tsx
      render(<AiAssistantPage />, { wrapper: createWrapper() });

      await waitFor(() => {
        expect(screen.queryByText('Loading models...')).not.toBeInTheDocument();
      });

      const select = document.querySelector('select') as HTMLSelectElement | null;
      expect(select).not.toBeNull();
      expect(select!.value).toBe('legacy-llama3');
```
new
```tsx
      let captured: ReturnType<typeof useAiContext> | null = null;
      function Capture() {
        captured = useAiContext();
        return null;
      }
      render(<Capture />, { wrapper: createWrapper() });

      await waitFor(() => expect(captured?.model).toBe('legacy-llama3'));
```

Replace the body of `propagates an admin-side change to the chat UI without remount (Finding 1, AC-3)` from its `render` call to the end:

old
```tsx
      const { Wrapper, queryClient } = createWrapperWithClient();
      render(<AiAssistantPage />, { wrapper: Wrapper });

      // Initial state: dropdown shows qwen3:8b.
      await waitFor(() => {
        const select = document.querySelector('select') as HTMLSelectElement | null;
        expect(select?.value).toBe('qwen3:8b');
      });

      // Verify dropdown options reflect the initial models list.
      const initialOptions = Array.from(document.querySelectorAll('select option')).map(
        (o) => o.textContent,
      );
      expect(initialOptions).toEqual(['qwen3:8b', 'llama3']);
```
new
```tsx
      let captured: ReturnType<typeof useAiContext> | null = null;
      function Capture() {
        captured = useAiContext();
        return null;
      }
      const { Wrapper, queryClient } = createWrapperWithClient();
      render(<Capture />, { wrapper: Wrapper });

      // Initial state: the resolved chat model and its provider's list.
      await waitFor(() => expect(captured?.model).toBe('qwen3:8b'));
      expect(captured!.models.map((m) => m.name)).toEqual(['qwen3:8b', 'llama3']);
```
and its tail:

old
```tsx
      // Models dropdown should now reflect the new provider's models —
      // proving the admin change propagated without a remount.
      await waitFor(() => {
        const opts = Array.from(document.querySelectorAll('select option')).map(
          (o) => o.textContent,
        );
        expect(opts).toEqual(['gpt-4o-mini', 'gpt-4o']);
      });
```
new
```tsx
      // The context should now carry the new provider's models — proving the
      // admin change propagated without a remount.
      await waitFor(() => {
        expect(captured!.models.map((m) => m.name)).toEqual(['gpt-4o-mini', 'gpt-4o']);
      });
```

Run: `cd frontend && npx vitest run src/features/ai/AiAssistantPage.test.tsx -t "chat use-case default"`
Expected: PASS (4 tests) — and they still pass *before* the page edit in Step 17, because they no longer touch the page at all.

- [ ] **Step 16: Write the failing tests for the header slot and the two thread states**

Add to `frontend/src/features/ai/AiAssistantPage.test.tsx`, after the `offers Q&A and Generate only` test. Note `HeaderHost` renders in place when no `#app-header-slot` exists, so the first case needs no shell; the second mounts `AppHeaderMain` to prove the portal and the fallback-title suppression that makes the `<h1>` load-bearing.

```tsx
  // #1361 / amendment item 2. New chat lives in the 48px header, not in the
  // sub-header: the header renders at every width, sits outside the scroll
  // container, and stays reachable with the conversations rail collapsed.
  describe('header slot (#1361)', () => {
    it('claims the slot with the route title and a New chat action', () => {
      render(<AiAssistantPage />, { wrapper: createWrapper() });

      expect(screen.getByRole('heading', { level: 1, name: 'AI' })).toBeInTheDocument();
      const newChat = screen.getByTestId('ai-new-chat');
      expect(newChat).toHaveAttribute('aria-label', 'New chat');
      // `header-slot.tsx:58` hides anything marked with this below `lg`, which
      // would delete the control on exactly the phone it exists for.
      expect(newChat).not.toHaveAttribute('data-header-kpis');
    });

    it('portals into the app header and suppresses its fallback title', async () => {
      render(
        <>
          <AppHeaderMain />
          <AiAssistantPage />
        </>,
        { wrapper: createWrapper() },
      );

      const slot = screen.getByTestId('app-header-slot');
      await waitFor(() => expect(slot).toContainElement(screen.getByTestId('ai-new-chat')));
      expect(slot).toContainElement(screen.getByRole('heading', { level: 1, name: 'AI' }));
      // `AppHeaderMain` drops its own fallback <h1> once the slot has children,
      // which is why the page has to supply one — otherwise /ai loses its
      // heading outright.
      expect(screen.getAllByRole('heading', { level: 1, name: 'AI' })).toHaveLength(1);
    });

    it('New chat starts a fresh conversation', async () => {
      let captured: ReturnType<typeof useAiContext> | null = null;
      function Capture() {
        captured = useAiContext();
        return null;
      }
      render(
        <>
          <AiAssistantPage />
          <Capture />
        </>,
        { wrapper: createWrapper() },
      );

      await act(async () => {
        captured!.setMessages([{ id: 'seed-1', role: 'user', content: 'an earlier question' }]);
      });
      expect(screen.getByText('an earlier question')).toBeInTheDocument();

      fireEvent.click(screen.getByTestId('ai-new-chat'));

      await waitFor(() =>
        expect(screen.queryByText('an earlier question')).not.toBeInTheDocument(),
      );
    });
  });

  // #1361: a `conv:` thread is fetched, so the message pane has two states the
  // draft never had. Neither may render the Ask empty state — "Ask questions
  // about your knowledge base" over a conversation that is still loading says
  // the conversation is empty.
  describe('reopened-conversation states (#1361)', () => {
    function Capture({ onReady }: { onReady: (ctx: ReturnType<typeof useAiContext>) => void }) {
      onReady(useAiContext());
      return null;
    }

    it('shows a polite loading status instead of the empty state', () => {
      render(<AiAssistantPage />, { wrapper: createWrapper(['/ai/c/conv-1']) });

      const status = screen.getByTestId('ai-thread-loading');
      expect(status).toHaveAttribute('role', 'status');
      expect(status).toHaveTextContent('Loading conversation…');
      expect(screen.queryByText('Ask questions about your knowledge base')).not.toBeInTheDocument();
    });

    it('shows the destructive block with a Retry that re-arms the fetch', async () => {
      apiFetchMock.mockImplementation((path: string) => {
        if (path === '/llm/conversations/conv-1') return Promise.reject(new ApiError(500, 'Server unavailable'));
        if (path.startsWith('/ollama/models')) return Promise.resolve([{ name: 'llama3' }]);
        return Promise.resolve([]);
      });

      render(<AiAssistantPage />, { wrapper: createWrapper(['/ai/c/conv-1']) });

      const block = await screen.findByTestId('ai-thread-error');
      expect(block).toHaveAttribute('role', 'alert');
      expect(block).toHaveTextContent('Couldn’t load conversation');
      expect(block).toHaveTextContent('Server unavailable');
      expect(screen.queryByText('Ask questions about your knowledge base')).not.toBeInTheDocument();

      const before = apiFetchMock.mock.calls.filter((c) => c[0] === '/llm/conversations/conv-1').length;
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      await waitFor(() => {
        const after = apiFetchMock.mock.calls.filter((c) => c[0] === '/llm/conversations/conv-1').length;
        expect(after).toBeGreaterThan(before);
      });
    });

    it('renders the empty state once the thread is ready', () => {
      render(<AiAssistantPage />, { wrapper: createWrapper() });
      expect(screen.queryByTestId('ai-thread-loading')).not.toBeInTheDocument();
      expect(screen.getByText('Ask questions about your knowledge base')).toBeInTheDocument();
    });
  });
```

and add the import the two new blocks need, beside the existing `AiAssistantPage` import:

```tsx
import { AppHeaderMain } from '../../shared/components/layout/header-slot';
```

- [ ] **Step 17: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/features/ai/AiAssistantPage.test.tsx -t "header slot" && npx vitest run src/features/ai/AiAssistantPage.test.tsx -t "reopened-conversation states"`
Expected: FAIL — `Unable to find an accessible element with the role "heading" and name "AI"` and `Unable to find an element by: [data-testid="ai-new-chat"]` for the first group; `Unable to find an element by: [data-testid="ai-thread-loading"]` for the second.

- [ ] **Step 18: Simplify the page and add the header slot and the two states**

Edit 1 — imports (`AiAssistantPage.tsx:1-7`):

old
```tsx
import { memo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { m, useReducedMotion } from 'framer-motion';
import {
  Bot, User, Loader2, Brain, AlertTriangle,
  Network, FileText, X,
} from 'lucide-react';
```
new
```tsx
import { memo } from 'react';
import { m, useReducedMotion } from 'framer-motion';
import {
  Bot, User, Brain, AlertTriangle, RefreshCw, SquarePen,
} from 'lucide-react';
```

and add, after the `AssistantAttachmentsScope` import at `:28`:

```tsx
import { HeaderHost } from '../../shared/components/layout/header-slot';
```

Edit 2 — what the page reads from the context (`:214-228`):

old
```tsx
export function AiAssistantPage() {
  const ctx = useAiContext();
  const {
    mode, page, pageHasChildren,
    messages, messagesEndRef, isStreaming, isThinking, thinkingElapsed,
    streamingContent,
    model, models, setModel, modelsError, refetchModels, isLight,
    includeSubPages, setIncludeSubPages,
    thinkingMode, setThinkingMode,
    embeddingStatus,
  } = ctx;

  const shouldReduceMotion = useReducedMotion();
  const [searchParams, setSearchParams] = useSearchParams();
```
new
```tsx
export function AiAssistantPage() {
  const ctx = useAiContext();
  const {
    mode, page,
    messages, messagesEndRef, isStreaming, isThinking, thinkingElapsed,
    streamingContent,
    isLight,
    thinkingMode, setThinkingMode,
    embeddingStatus,
    startNewConversation, threadLoadState, threadLoadError, retryThreadLoad,
  } = ctx;

  const shouldReduceMotion = useReducedMotion();
```

Edit 3 — the header slot, as the FIRST child inside the root `<m.div>` (`:231-…`). Insert immediately after the root element's opening `>` (the line `      className="flex min-h-0 flex-1 flex-col gap-3"` and its `>`), before the sticky sub-header's comment block:

```tsx
      {/* The route's claim on the 48px app header (#1364's HeaderHost), and the
          home of New chat (#1361, amendment item 2 — owner decision 12 amended
          2026-08-18). The header renders at every width, sits outside the
          scroll container, and survives a collapsed conversations rail, which
          the sub-header could not offer all three of.

          The <h1> is required, not decorative: `AppHeaderMain` drops its own
          fallback title the moment the slot has children, so a slot claimed
          with the button alone leaves /ai with no heading.

          FIRST CHILD INSIDE the root <m.div>, never a fragment sibling above
          it — `ai-scroll-chain.test.ts` finds this page's root with
          /return \(\s*<m\.div([\s\S]*?)>/ and throws when that match fails,
          which would take two of its cases down and leave
          `scroll-padding-mask.test.ts` describing a strategy nothing enforces.

          No `data-header-kpis`: `header-slot.tsx:58` hides anything so marked
          below `lg`, i.e. on exactly the phone this control exists for. */}
      <HeaderHost fallbackClassName="flex items-center gap-3">
        <h1 className="min-w-0 truncate text-[15px] font-semibold sm:text-lg">AI</h1>
        <button
          type="button"
          onClick={() => startNewConversation()}
          className="nm-button-ghost ml-auto flex h-8 items-center gap-1.5 px-2.5 text-xs sm:text-sm"
          aria-label="New chat"
          data-testid="ai-new-chat"
        >
          <SquarePen size={15} />
          {/* The label yields the header's width below `sm`; the aria-label
              above is what keeps the accessible name when it does. */}
          <span className="hidden sm:inline">New chat</span>
        </button>
      </HeaderHost>
```

Edit 4 — the sub-header's contents (`:297-386`). The bar, its card and Think stay; the `flex-1` spacer, the model select with its loading and retry states, the context chip, `+ Sub-pages` and the divider go:

old
```tsx
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2 rounded-xl border border-border bg-card px-3 py-2">
        <div className="flex-1" />

        {/* Group B — context + options. Each chip is 28 px tall (h-7),
            border-border at rest, tinted on active. The divider between
            the model dropdown and the toggles separates "infrastructure" the
            user sets once from "context flags" they flip per question. */}
        <div className="flex flex-wrap items-center gap-1.5">
```
new
```tsx
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2 rounded-xl border border-border bg-card px-3 py-2">
        {/* Durable options, and only those (#1361). The model `<select>` went
            with page scope: the model is an admin assignment (ADR-021), not a
            per-question choice, and `modelsError` / `refetchModels` stay on the
            context for the dock's own retry chip. The `flex-1` spacer and the
            divider went with the controls they separated — Think sits left
            rather than being pushed right by a spacer with nothing on its
            left. */}
        <div className="flex flex-wrap items-center gap-1.5">
```

then delete everything from the `{modelsError ? (` line through the divider `<span>` inclusive — that is, this whole run:

```tsx
          {modelsError ? (
            // Models fetch failed (LLM provider down / unreachable): surface
            // the failure with a retry affordance instead of spinning forever.
            <button
              type="button"
              onClick={() => refetchModels()}
              title="Failed to load models from the LLM provider — click to retry"
              className="flex h-7 items-center gap-1.5 rounded-md border border-destructive/40 px-2.5 text-xs text-destructive transition-colors hover:bg-destructive/10"
            >
              <AlertTriangle size={12} /> Models unavailable — retry
            </button>
          ) : models.length === 0 ? (
```
…through…
```tsx
          {/* Divider between "what model + what context" and "what options". */}
          <span aria-hidden className="mx-0.5 h-5 w-px bg-border/50" />

```
leaving the `{/* Thinking mode toggle (#20). …` comment and its `<label>` as the group's only child.

Edit 5 — the message pane's states (`:497`):

old
```tsx
          {messages.length === 0 && (
            <div className="flex min-h-[300px] flex-col items-center justify-center text-center">
```
new
```tsx
          {/* #1361: a `conv:` thread is fetched, so this pane has two states
              the draft never had. Neither may fall through to the empty state
              below — "Ask questions about your knowledge base" over a
              conversation that is still loading, or that failed to load, says
              the conversation is empty. */}
          {threadLoadState === 'loading' && (
            <div
              role="status"
              data-testid="ai-thread-loading"
              className="flex min-h-[300px] items-center justify-center text-sm text-muted-foreground"
            >
              Loading conversation…
            </div>
          )}
          {threadLoadState === 'error' && (
            // The tree's destructive block, verbatim in intent (ADR-010: red is
            // failure, amber is degraded — this request FAILED). `threadLoadError`
            // is ApiError's curated prose, which is the only place the reader
            // learns why.
            <div className="flex flex-col items-center px-3 py-8 text-center" role="alert" data-testid="ai-thread-error">
              <div className="mb-3 rounded-full bg-muted p-2.5">
                <AlertTriangle size={20} className="text-destructive" aria-hidden="true" />
              </div>
              <p className="text-xs font-medium text-foreground/70">Couldn&rsquo;t load conversation</p>
              <p className="mt-1 break-words line-clamp-3 text-[11px] text-muted-foreground">
                {threadLoadError ?? 'The request did not complete.'}
              </p>
              <button
                onClick={() => retryThreadLoad()}
                className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-action bg-transparent px-3 py-1.5 text-xs font-medium text-action transition-colors hover:bg-action hover:text-action-foreground"
              >
                <RefreshCw size={12} aria-hidden="true" />
                Retry
              </button>
            </div>
          )}
          {threadLoadState === 'ready' && messages.length === 0 && (
            <div className="flex min-h-[300px] flex-col items-center justify-center text-center">
```

- [ ] **Step 19: Run the page tests, and move the *Use in page* cases**

Run: `cd frontend && npx vitest run src/features/ai/AiAssistantPage.test.tsx`
Expected: PASS.

Then move the three deleted `diagram mode - Use in page` cases into `frontend/src/features/ai/modes/DiagramMode.test.tsx`, whose `DiagramPreview` subject is still live — `DockPanel.tsx:336` renders it. Add to that file's imports:

old
```tsx
import { DiagramTypeSelector, DiagramModeInput, DIAGRAM_EMPTY_TITLE, diagramEmptySubtitle } from './DiagramMode';
```
new
```tsx
import { DiagramTypeSelector, DiagramModeInput, DiagramPreview, DIAGRAM_EMPTY_TITLE, diagramEmptySubtitle } from './DiagramMode';
```

and add this describe inside `describe('DiagramMode', …)`:

```tsx
  // Moved out of AiAssistantPage.test.tsx by #1361: `/ai` no longer offers
  // Diagram, but `DockPanel` still renders this preview, so "Use in page" is
  // live code and this is the only coverage it has. `/pages/p1` is where a page
  // now resolves — `resolveAiPageId` answers null on every AI route.
  describe('DiagramPreview — Use in page', () => {
    async function generate() {
      streamSSEMock.mockReturnValue((async function* () {
        yield { content: '```mermaid\ngraph TD;\nA-->B;\n```' };
        yield { final: true, done: true };
      })());
      await waitFor(() => expect(screen.getByRole('button', { name: /Generate Diagram/i })).not.toBeDisabled());
      fireEvent.click(screen.getByRole('button', { name: /Generate Diagram/i }));
    }

    it('offers "Use in page" once a diagram exists and a page is open', async () => {
      mockPageData = { data: { id: 'p1', title: 'My Article', bodyHtml: '<p>C</p>', bodyText: 'C', version: 2 } };
      render(
        <>
          <DiagramModeInput />
          <DiagramPreview />
        </>,
        { wrapper: createWrapper(['/pages/p1']) },
      );
      await generate();
      expect(await screen.findByText('Use in page')).toBeInTheDocument();
    });

    it('does not offer it with no page open', async () => {
      mockPageData = { data: undefined };
      render(
        <>
          <DiagramModeInput />
          <DiagramPreview />
        </>,
        { wrapper: createWrapper(['/ai']) },
      );
      streamSSEMock.mockReturnValue((async function* () {
        yield { content: '```mermaid\ngraph TD;\nA-->B;\n```' };
        yield { final: true, done: true };
      })());
      expect(screen.queryByText('Use in page')).not.toBeInTheDocument();
    });

    it('PUTs the diagram into the page when it is clicked', async () => {
      mockPageData = { data: { id: 'p1', title: 'My Article', bodyHtml: '<p>C</p>', bodyText: 'C', version: 2 } };
      render(
        <>
          <DiagramModeInput />
          <DiagramPreview />
        </>,
        { wrapper: createWrapper(['/pages/p1']) },
      );
      await generate();
      fireEvent.click(await screen.findByText('Use in page'));

      await waitFor(() => {
        const put = apiFetchMock.mock.calls.find(
          (c) => typeof c[0] === 'string' && c[0] === '/pages/p1' && (c[1] as RequestInit | undefined)?.method === 'PUT',
        );
        expect(put, 'expected a PUT to /pages/p1').toBeDefined();
      });
    });
  });
```

Run: `cd frontend && npx vitest run src/features/ai/modes/DiagramMode.test.tsx`
Expected: PASS. If the harness's `createWrapper` signature or the generated-diagram shape differs from the assumptions above, adjust the fixture — never the assertion (`Use in page` presence, absence, and the PUT are what moved).

- [ ] **Step 20: Move the "attachments paused for Diagram" case into the dock's suite**

Add to `frontend/src/features/ai/dock/AiDock.upload.test.tsx`, inside `describe('AiDock — reference document (#1131)', …)`:

```tsx
  // Moved from AiAssistantPage.test.tsx by #1361: the dock is the only surface
  // that still offers Diagram, and the rule is the dock's own — an attachment
  // is KEPT (not dropped) while Diagram is selected, and is not sent, because
  // /llm/generate-diagram takes no reference material.
  it('keeps an attached document but does not send it while Diagram is selected', async () => {
    renderDock();
    await openAndSettle();
    await attach();
    await selectAction('diagram');

    expect(screen.getByTestId('ai-dock-attachments-paused')).toBeInTheDocument();
    expect(screen.getByTestId('ai-dock-doc-attachment-card')).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('ai-dock-input'), { target: { value: 'show the retry loop' } });
    fireEvent.click(screen.getByTestId('ai-dock-send'));

    await waitFor(() => {
      const call = streamSSEMock.mock.calls.find((c) => c[0] === '/llm/generate-diagram');
      expect(call, 'expected a /llm/generate-diagram request').toBeDefined();
      expect(call![1]).not.toHaveProperty('referenceText');
    });
  });
```

Run: `cd frontend && npx vitest run src/features/ai/dock/AiDock.upload.test.tsx`
Expected: PASS.

- [ ] **Step 21: Run the affected suites, the guards, typecheck and lint**

Run:
```bash
cd frontend
npx vitest run src/features/ai src/shared/components/layout/AppLayout.test.tsx
npx vitest run src/ai-scroll-chain.test.ts src/scroll-padding-mask.test.ts src/flat-components.test.ts src/ui-text-legibility.test.ts src/destructive-treatment.test.ts src/focus-ring-contrast.test.ts src/workspace-themes.test.ts
npx tsc --noEmit
npm run lint
```
Expected: all pass. `ai-scroll-chain.test.ts` is the sharp one — it must still find the page's root `<m.div>` with `HeaderHost` as its first child. `destructive-treatment.test.ts`'s ratchet is `<= 21` hand-rolled callsites, and deleting the models-error chip (a `text-destructive` + `hover:bg-destructive/10` pair) lowers the count, which the ratchet allows.

- [ ] **Step 22: Commit**

```bash
git add frontend/src/features/ai/assistant-actions.ts \
        frontend/src/features/ai/assistant-actions.test.ts \
        frontend/src/features/ai/AssistantActionSelect.tsx \
        frontend/src/features/ai/AiContext.tsx \
        frontend/src/features/ai/AiAssistantPage.tsx \
        frontend/src/features/ai/AiAssistantPage.test.tsx \
        frontend/src/features/ai/modes/AskMode.tsx \
        frontend/src/features/ai/modes/ImproveMode.tsx \
        frontend/src/features/ai/modes/DiagramMode.tsx \
        frontend/src/features/ai/modes/DiagramMode.test.tsx \
        frontend/src/features/ai/modes/GenerateMode.tsx \
        frontend/src/features/ai/dock/DockPanel.tsx \
        frontend/src/features/ai/dock/AiDock.upload.test.tsx
git commit -m "feat(ai): simplify /ai and move New chat into the 48px header slot

/ai carries no page scope now that the tree has left the rail, so the context
chip, + Sub-pages and the model select go; the action selector takes an explicit
allow-list (Q&A + Generate here, the rewrite skills + Diagram in the dock) and
the URL parser accepts only what /ai can run. New chat claims the header slot
beside the route title, and the message pane gains the loading and error states
a reopened conversation needs.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---
### Task 16: History note, `unavailable` sources, card-thumbnail gate

Implements the spec's *`/ai` page changes* → **History note** bullet and **Reopened answers render as live ones** bullet, plus amendment item 4's last sentence (`SourceCitations` gates its thumbnail on `isImageSource(source) && target.kind !== 'none'`) and item 5 (PR 1 already landed the source mapping and the `source-target.ts` rewording — this task adds only the `unavailable` rule and the `target.kind` half of the gate).

**Pinned here:** the two note test ids are `ask-history-truncated` and `ai-dock-history-truncated`; the shared copy string lives in `source-target.ts` as `UNAVAILABLE_SOURCE_TITLE` so the chip and the card cannot drift (the same argument that put `isImageSource` in its own module).

**Files:**
- Modify: `frontend/src/features/ai/source-target.ts` (`:54`, plus a new exported constant)
- Test: `frontend/src/features/ai/source-target.test.ts`
- Modify: `frontend/src/features/ai/SourceCitations.tsx` (`Source` gains `unavailable?: true`; the inert card's `title`; the thumbnail gate at `:133-139`)
- Test: `frontend/src/features/ai/SourceCitations.test.tsx`
- Modify: `frontend/src/features/ai/CitationChips.tsx` (`:105-114`)
- Test: `frontend/src/features/ai/CitationChips.test.tsx`
- Modify: `frontend/src/features/ai/modes/AskMode.tsx` (`:36-41` destructure, `:283` render)
- Test: `frontend/src/features/ai/modes/AskMode.test.tsx`
- Modify: `frontend/src/features/ai/dock/DockPanel.tsx` (`:92-96` destructure, `:396` render)
- Test: `frontend/src/features/ai/dock/AiDock.test.tsx`

**Interfaces:**
- Consumes: Task 5's `historyTruncated: boolean` on `AiContextValue` (set from each ask's final frame and from `GET /llm/conversations/:id`).
- Produces: `UNAVAILABLE_SOURCE_TITLE` from `features/ai/source-target.ts`; `Source.unavailable?: true`; `data-testid="ask-history-truncated"` / `data-testid="ai-dock-history-truncated"`.

- [ ] **Step 1: Write the failing test for the `unavailable` rule**

Add to `frontend/src/features/ai/source-target.test.ts`, inside `describe('resolveSourceTarget', …)`:

```ts
  it('refuses an unavailable source before every other rule (#1361)', () => {
    // `GET /llm/conversations/:id` annotates a persisted source whose page is
    // trashed or no longer visible to this caller. The stored row still carries
    // its pageId and (for a web source) its url, so the annotation has to be
    // read FIRST — otherwise the citation routes the reader at a page the
    // server just said they cannot have.
    expect(resolveSourceTarget(source({ pageId: 42, unavailable: true })))
      .toEqual({ kind: 'none' });
    expect(resolveSourceTarget(source({ url: 'https://example.com/a', unavailable: true })))
      .toEqual({ kind: 'none' });
    expect(resolveSourceTarget(source({
      kind: 'image',
      pageId: 42,
      attachmentUrl: '/api/attachments/42/x.png',
      unavailable: true,
    }))).toEqual({ kind: 'none' });
  });

  it('leaves an absent flag alone — a live answer never carries one', () => {
    expect(resolveSourceTarget(source({ pageId: 42 })))
      .toEqual({ kind: 'internal', path: '/pages/42' });
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/features/ai/source-target.test.ts`
Expected: FAIL — `expected { kind: 'internal', path: '/pages/42' } to deeply equal { kind: 'none' }`. (TypeScript is not the gate here: `src/**/*.test.ts` is excluded from `tsc`, so the unknown `unavailable` key does not stop the run.)

- [ ] **Step 3: Add the field, the constant and the rule**

`frontend/src/features/ai/SourceCitations.tsx` — add to the `Source` interface, immediately after the `url` field:

old
```tsx
  /** Absolute http(s) URL — present only on web / external-docs sources. */
  url?: string;
  sectionTitle?: string;
```
new
```tsx
  /** Absolute http(s) URL — present only on web / external-docs sources. */
  url?: string;
  /**
   * #1361 — a READ-TIME annotation from `GET /llm/conversations/:id`: the page
   * this stored source names is trashed, or is no longer visible to the caller.
   * Never persisted (the contract's `SourceSchema` says the same), and never
   * present on a live answer, whose sources were retrieved a moment ago under
   * this user's own visibility predicate.
   *
   * `resolveSourceTarget` answers `{ kind: 'none' }` for it before every other
   * rule, so the citation renders inert with {@link UNAVAILABLE_SOURCE_TITLE}.
   * The NUMBER stays either way — the answer text refers to it by position.
   */
  unavailable?: true;
  sectionTitle?: string;
```

`frontend/src/features/ai/source-target.ts` — add the constant above `resolveSourceTarget`'s doc comment:

```ts
/**
 * What an inert citation says when the page behind it is gone (#1361).
 *
 * One string in one module because two surfaces render it — the numbered chip
 * and the source card — and a copy in each is how they drift. It names the
 * READER's access rather than the page's existence ("no longer available to
 * you"), because the read side cannot tell a trashed page from one whose
 * permissions changed, and must not leak which it was.
 */
export const UNAVAILABLE_SOURCE_TITLE = 'This page is no longer available to you';
```

and the rule itself:

old
```ts
export function resolveSourceTarget(source: Source): SourceTarget {
  const absolute = parseAbsolute(source.url) ?? parseAbsolute(source.confluenceId);
```
new
```ts
export function resolveSourceTarget(source: Source): SourceTarget {
  // 0. The read side already looked (#1361). A persisted source keeps its
  //    `pageId` and its `url`, so this has to be checked BEFORE both — routing
  //    either would send the reader at a page the server has just reported as
  //    gone, and for an image source it would re-probe an ACL that has already
  //    answered.
  if (source.unavailable === true) return { kind: 'none' };

  const absolute = parseAbsolute(source.url) ?? parseAbsolute(source.confluenceId);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/features/ai/source-target.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing tests for the two inert renders and the card gate**

Add to `frontend/src/features/ai/CitationChips.test.tsx`, inside `describe('CitationChips', …)` (top level, after the `image sources` describe):

```tsx
  // #1361: a reopened answer can cite a page the reader has since lost. The
  // number stays — the answer text refers to it — but nothing about it is
  // operable, and the title says why.
  describe('unavailable sources', () => {
    it('renders an inert chip naming the reader’s access, not the page', () => {
      render(
        <CitationChips sources={[{ pageTitle: 'Secret Runbook', pageId: 42, unavailable: true }]} />,
        { wrapper: Wrapper },
      );
      const chip = screen.getByTestId('citation-chip-1');
      expect(chip.tagName).toBe('SPAN');
      expect(chip).toHaveTextContent('1');
      expect(chip).toHaveAttribute('title', 'This page is no longer available to you');
      fireEvent.click(chip);
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it('issues no attachment fetch for an unavailable image source', async () => {
      const fetchMock = vi.fn(async () =>
        ({ ok: true, status: 200, blob: async () => new Blob(['x']) } as unknown as Response));
      vi.stubGlobal('fetch', fetchMock);

      render(
        <CitationChips
          sources={[{
            kind: 'image',
            pageTitle: 'Secret Runbook',
            pageId: 42,
            attachmentUrl: '/api/attachments/42/diagram.png',
            similarity: null,
            unavailable: true,
          }]}
        />,
        { wrapper: Wrapper },
      );

      expect(screen.queryByTestId('source-thumbnail')).not.toBeInTheDocument();
      await Promise.resolve();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
```

Add to `frontend/src/features/ai/SourceCitations.test.tsx`, inside `describe('SourceCitations', …)` (after the `image sources` describe):

```tsx
  describe('unavailable sources (#1361)', () => {
    it('renders an inert card naming the reader’s access', () => {
      render(
        <SourceCitations sources={[{ pageTitle: 'Secret Runbook', spaceKey: 'OPS', pageId: 42, unavailable: true }]} />,
        { wrapper: Wrapper },
      );
      fireEvent.click(screen.getByText('Sources (1)'));

      const card = screen.getByTestId('source-card-1');
      expect(card.tagName).toBe('DIV');
      expect(card).toHaveAttribute('title', 'This page is no longer available to you');
      expect(screen.getByText('Secret Runbook')).toBeInTheDocument();
      fireEvent.click(card);
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it('does not re-probe the attachment ACL the read side already answered', async () => {
      // `CitationChips` gets this by construction (it gates its thumbnail on
      // `target.kind === 'internal'`); this card gated only on `isImageSource`,
      // so an unavailable image source fetched the full attachment on every
      // reopen of a thread the reader can no longer see the page for.
      const fetchMock = vi.fn(async () =>
        ({ ok: true, status: 200, blob: async () => new Blob(['x']) } as unknown as Response));
      vi.stubGlobal('fetch', fetchMock);

      render(
        <SourceCitations
          sources={[{
            kind: 'image',
            pageTitle: 'Secret Runbook',
            spaceKey: 'OPS',
            pageId: 42,
            attachmentUrl: '/api/attachments/42/diagram.png',
            similarity: null,
            unavailable: true,
          }]}
        />,
        { wrapper: Wrapper },
      );
      fireEvent.click(screen.getByText('Sources (1)'));

      expect(screen.queryByTestId('source-thumbnail')).not.toBeInTheDocument();
      await Promise.resolve();
      expect(fetchMock).not.toHaveBeenCalled();
      // Still a complete citation: the category label and the title survive.
      expect(screen.getByTestId('source-image-label')).toBeInTheDocument();
    });
  });
```

- [ ] **Step 6: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/features/ai/CitationChips.test.tsx src/features/ai/SourceCitations.test.tsx`
Expected: FAIL — the chip/card `title` assertions fail with the old strings (`Secret Runbook — no page to open` / `This source has no page that can be opened.`), and `does not re-probe the attachment ACL…` fails with `expected "spy" not to be called` (the card still mounts a `SourceThumbnail`).

- [ ] **Step 7: Make both inert renders carry the shared title, and gate the card's thumbnail**

`frontend/src/features/ai/CitationChips.tsx` — the import:

old
```tsx
import { resolveSourceTarget } from './source-target';
```
new
```tsx
import { resolveSourceTarget, UNAVAILABLE_SOURCE_TITLE } from './source-target';
```

and the inert branch:

old
```tsx
        // No usable target — keep the number (the answer text refers to it)
        // but don't render a link that lands on the not-found page.
        return (
          <span
            key={i}
            title={`${source.pageTitle} — no page to open`}
            className={cn(CHIP_CLASS, 'opacity-60')}
            data-testid={testId}
          >
```
new
```tsx
        // No usable target — keep the number (the answer text refers to it)
        // but don't render a link that lands on the not-found page. Two ways to
        // get here now, and they are different facts: the source never had a
        // target, or (#1361) the page behind it is gone from this reader.
        return (
          <span
            key={i}
            title={source.unavailable
              ? UNAVAILABLE_SOURCE_TITLE
              : `${source.pageTitle} — no page to open`}
            className={cn(CHIP_CLASS, 'opacity-60')}
            data-testid={testId}
          >
```

`frontend/src/features/ai/SourceCitations.tsx` — the import:

old
```tsx
import { resolveSourceTarget } from './source-target';
```
new
```tsx
import { resolveSourceTarget, UNAVAILABLE_SOURCE_TITLE } from './source-target';
```

the thumbnail gate:

old
```tsx
                  {/* #1115 P3 — an image source shows the picture where the
                      glyph would be. It renders nothing while loading or on a
                      failed fetch, and the row degrades to the title-only
                      shape below rather than to a broken-image box. */}
                  {isImageSource(source)
                    ? <SourceThumbnail url={source.attachmentUrl!} size={32} className="mt-0.5" />
                    : target.kind === 'external'
```
new
```tsx
                  {/* #1115 P3 — an image source shows the picture where the
                      glyph would be. It renders nothing while loading or on a
                      failed fetch, and the row degrades to the title-only
                      shape below rather than to a broken-image box.
                      #1361: and never for a source the read side has already
                      reported unavailable — fetching the attachment would
                      re-probe an ACL that has answered. `CitationChips` gets
                      this by construction, gating on `kind === 'internal'`. */}
                  {isImageSource(source) && target.kind !== 'none'
                    ? <SourceThumbnail url={source.attachmentUrl!} size={32} className="mt-0.5" />
                    : target.kind === 'external'
```

and the inert card's title:

old
```tsx
                <m.div
                  key={i}
                  {...motionProps}
                  className={cardClass}
                  title="This source has no page that can be opened."
                  data-testid={testId}
                >
```
new
```tsx
                <m.div
                  key={i}
                  {...motionProps}
                  className={cardClass}
                  title={source.unavailable
                    ? UNAVAILABLE_SOURCE_TITLE
                    : 'This source has no page that can be opened.'}
                  data-testid={testId}
                >
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/features/ai/CitationChips.test.tsx src/features/ai/SourceCitations.test.tsx src/features/ai/source-target.test.ts src/features/ai/image-source.test.ts`
Expected: PASS. `image-source.test.ts` is unchanged and must stay so — `isImageSource` is untouched; the new condition is beside it, not inside it.

- [ ] **Step 9: Write the failing tests for the history note on both composers**

Add to `frontend/src/features/ai/modes/AskMode.test.tsx`, inside `describe('AskMode', …)`:

```tsx
  // #1361 decision 10, made visible. `selectReplayableHistory` replays only the
  // whole exchanges that fit the model's budget, so a long conversation quietly
  // stops carrying its own beginning; the flag rides each ask's final frame and
  // `GET /llm/conversations/:id`. Both /llm/ask surfaces render it.
  describe('history-truncated note', () => {
    const NOTE = 'Older messages in this conversation are no longer sent to the model.';

    function settleModels() {
      apiFetchMock.mockImplementation((path: string) => {
        if (path === '/settings') {
          return Promise.resolve({ llmProvider: 'ollama', ollamaModel: 'llama3', openaiModel: null });
        }
        if (path.startsWith('/ollama/models')) return Promise.resolve([{ name: 'llama3' }]);
        if (path === '/llm/conversations') return Promise.resolve([]);
        return Promise.resolve([]);
      });
    }

    it('is absent until the server says the history was clipped', async () => {
      settleModels();
      render(<AskModeInput />, { wrapper: createWrapper() });
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Send message' })).not.toBeDisabled(),
      );
      expect(screen.queryByText(NOTE)).not.toBeInTheDocument();
    });

    it('appears above the composer once an answer reports it', async () => {
      settleModels();
      streamSSEMock.mockImplementation(async function* fakeStream() {
        yield { content: 'Answer' };
        yield { final: true, historyTruncated: true, sources: [], done: true };
      });

      render(<AskModeInput />, { wrapper: createWrapper() });
      fireEvent.change(screen.getByPlaceholderText('Ask a question...'), {
        target: { value: 'and then?' },
      });
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Send message' })).not.toBeDisabled(),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

      const note = await screen.findByTestId('ask-history-truncated');
      expect(note).toHaveTextContent(NOTE);
    });

    it('is muted prose, never a live region', async () => {
      // It is a standing fact about the thread, not an event. In a live region
      // it would be announced again on every re-render the composer does while
      // the user types.
      settleModels();
      streamSSEMock.mockImplementation(async function* fakeStream() {
        yield { content: 'Answer' };
        yield { final: true, historyTruncated: true, sources: [], done: true };
      });

      render(<AskModeInput />, { wrapper: createWrapper() });
      fireEvent.change(screen.getByPlaceholderText('Ask a question...'), { target: { value: 'q' } });
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Send message' })).not.toBeDisabled(),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

      const note = await screen.findByTestId('ask-history-truncated');
      expect(note).not.toHaveAttribute('role');
      expect(note).not.toHaveAttribute('aria-live');
      expect(note.className).toContain('text-[11px]');
      expect(note.className).toContain('text-muted-foreground');
    });
  });
```

Add to `frontend/src/features/ai/dock/AiDock.test.tsx`, inside `describe('AiDock (#1126)', …)`:

```tsx
  // The same mechanism on the second /llm/ask surface (#1361). One of two is
  // the divergence CLAUDE.md's refusal note warns about.
  it('renders the history-truncated note when an answer reports it', async () => {
    streamSSEMock.mockImplementation(() =>
      sse({ content: 'Answer' }, { final: true, historyTruncated: true, sources: [], done: true }));

    renderDock();
    await openAndSettle();
    fireEvent.change(composer(), { target: { value: 'and then?' } });
    fireEvent.click(screen.getByTestId('ai-dock-send'));

    const note = await screen.findByTestId('ai-dock-history-truncated');
    expect(note).toHaveTextContent('Older messages in this conversation are no longer sent to the model.');
    expect(note).not.toHaveAttribute('role');
    expect(note).not.toHaveAttribute('aria-live');
  });

  it('does not render the note when the answer does not report it', async () => {
    streamSSEMock.mockImplementation(() => sse({ content: 'Answer' }, { final: true, sources: [], done: true }));

    renderDock();
    await openAndSettle();
    fireEvent.change(composer(), { target: { value: 'first question' } });
    fireEvent.click(screen.getByTestId('ai-dock-send'));

    await screen.findByText('Answer');
    expect(screen.queryByTestId('ai-dock-history-truncated')).not.toBeInTheDocument();
  });
```

- [ ] **Step 10: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/features/ai/modes/AskMode.test.tsx -t "history-truncated note" && npx vitest run src/features/ai/dock/AiDock.test.tsx -t "history-truncated"`
Expected: FAIL — `Unable to find an element by: [data-testid="ask-history-truncated"]` and `[data-testid="ai-dock-history-truncated"]`. (The `is absent until…` case passes already; that is the point of having it — it is the one that keeps the note from becoming unconditional.)

- [ ] **Step 11: Render the note on both composers**

`frontend/src/features/ai/modes/AskMode.tsx` — the destructure at `:36-41`:

old
```tsx
  const {
    input, setInput, isStreaming, model, conversationId, pageId,
    includeSubPages, thinkingMode, setMessages, runStream,
    chatVision, chatVisionModel,
```
new
```tsx
  const {
    input, setInput, isStreaming, model, conversationId, pageId,
    includeSubPages, thinkingMode, setMessages, runStream,
    chatVision, chatVisionModel, historyTruncated,
```

and the render, immediately before the `{/* Main input row */}` comment (i.e. directly after the `DeepSearchToggle`, so the note is the last thing above the composer box):

old
```tsx
      {/* Main input row */}
      <div className="nm-composer flex-wrap">
```
new
```tsx
      {/* #1361, decision 10 made visible. The backend replays whole exchanges
          only while they fit the model's budget, so a long conversation quietly
          stops carrying its own beginning; the reader is told rather than left
          to infer it from an answer that has forgotten something.

          Muted 11px prose and deliberately NOT a live region: it is a standing
          fact about the thread, not an event, and a live region would announce
          it again on every re-render this composer does while the user types.
          `DockPanel` renders the same line — both surfaces post /llm/ask, and
          the same mechanism on one of two is the divergence CLAUDE.md's refusal
          note warns about. */}
      {historyTruncated && (
        <p className="mb-2 text-[11px] text-muted-foreground" data-testid="ask-history-truncated">
          Older messages in this conversation are no longer sent to the model.
        </p>
      )}

      {/* Main input row */}
      <div className="nm-composer flex-wrap">
```

`frontend/src/features/ai/dock/DockPanel.tsx` — the destructure at `:92-96`:

old
```tsx
  const {
    page, pageId, messages, messagesEndRef, isStreaming, isThinking, thinkingElapsed,
    streamingContent, input, setInput, modelsError, refetchModels, model, chatVision,
    chatVisionModel, mode, setMode, improvementType, abortRef,
  } = useAiContext();
```
new
```tsx
  const {
    page, pageId, messages, messagesEndRef, isStreaming, isThinking, thinkingElapsed,
    streamingContent, input, setInput, modelsError, refetchModels, model, chatVision,
    chatVisionModel, mode, setMode, improvementType, abortRef, historyTruncated,
  } = useAiContext();
```

and the render, immediately before the composer box's own comment block (i.e. after the `DeepSearchToggle` block that ends at `:395`):

old
```tsx
        {/* flex-wrap so attached-source rows stack above the prompt inside the
            same box. One Attach control receives both documents and images;
```
new
```tsx
        {/* The same line `AskModeInput` renders, for the same reason (#1361):
            both surfaces post /llm/ask against the same budgeted history. Muted
            prose, not a live region — a standing fact about the thread. */}
        {historyTruncated && (
          <p className="mb-2 text-[11px] text-muted-foreground" data-testid="ai-dock-history-truncated">
            Older messages in this conversation are no longer sent to the model.
          </p>
        )}

        {/* flex-wrap so attached-source rows stack above the prompt inside the
            same box. One Attach control receives both documents and images;
```

- [ ] **Step 12: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/features/ai/modes/AskMode.test.tsx src/features/ai/dock/AiDock.test.tsx`
Expected: PASS.

- [ ] **Step 13: Run the guard suites this task touches, plus typecheck and lint**

Run:
```bash
cd frontend
npx vitest run src/features/ai
npx vitest run src/ui-text-legibility.test.ts src/flat-components.test.ts src/destructive-treatment.test.ts src/focus-ring-contrast.test.ts
npx tsc --noEmit
npm run lint
```
Expected: all pass. `ui-text-legibility.test.ts` is the relevant one for the note — 11px is the floor for non-uppercase UI text, and `text-[11px]` sits exactly on it.

- [ ] **Step 14: Commit**

```bash
git add frontend/src/features/ai/source-target.ts \
        frontend/src/features/ai/source-target.test.ts \
        frontend/src/features/ai/SourceCitations.tsx \
        frontend/src/features/ai/SourceCitations.test.tsx \
        frontend/src/features/ai/CitationChips.tsx \
        frontend/src/features/ai/CitationChips.test.tsx \
        frontend/src/features/ai/modes/AskMode.tsx \
        frontend/src/features/ai/modes/AskMode.test.tsx \
        frontend/src/features/ai/dock/DockPanel.tsx \
        frontend/src/features/ai/dock/AiDock.test.tsx
git commit -m "feat(ai): say when history stops being sent, and render a lost source inert

A reopened conversation replays only the exchanges that fit the model's budget,
so both /llm/ask composers now say so above the composer. A persisted source
whose page the reader has lost resolves to no target before every other rule,
renders inert with one shared title, and no longer re-probes the attachment ACL
the read side already answered.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 17: `SourceThumbnail` viewport gate

Implements amendment item 4 (owner's decision, 2026-08-18): the bound lives **inside `SourceThumbnail`**, so the 14px chip and the 32px card, live and reopened alike, get it without a per-surface flag.

Today every `SourceThumbnail` fetches the full attachment through `useAuthenticatedSrc` at mount, and `CitationChips` renders on **every** answer. A reopened N-turn thread therefore issues up to `N × MAX_IMAGE_SOURCES` (4) full-attachment requests in one gesture, with no server-side resize (ADR-025 D-no-resize) to make them small.

**Pinned here (two things the amendment leaves to the implementer):**
1. **`rootMargin: '200px'`** on the observer, so a thumbnail just below the fold starts its fetch before it is scrolled to. The gate is about the *unbounded* case (a whole reopened history at once), not about refusing the next screenful.
2. **The stub lives in `src/test-utils.ts`**, not in each test file. `test-setup.ts:5-18` installs an inert global `IntersectionObserver` that drops the callback, so it can never intersect; two test files need to drive one, and a second private copy is how they drift.

**Files:**
- Modify: `frontend/src/features/ai/SourceThumbnail.tsx`
- Modify: `frontend/src/test-utils.ts` (new `installIntersectionObserverStub`)
- Test: `frontend/src/features/ai/CitationChips.test.tsx`
- Test: `frontend/src/features/ai/SourceCitations.test.tsx`

**Interfaces:**
- Consumes: Task 16's `target.kind !== 'none'` gate in `SourceCitations` (unchanged here) and `useAuthenticatedSrc(apiUrl: string | null)`, which already no-ops on `null`.
- Produces: `data-testid="source-thumbnail-sentinel"`; `installIntersectionObserverStub()` from `src/test-utils.ts`.

- [ ] **Step 1: Add the drivable observer stub to the shared test utilities**

Append to `frontend/src/test-utils.ts`:

```ts
/**
 * A drivable `IntersectionObserver` for jsdom.
 *
 * `test-setup.ts` installs a global stub whose constructor DROPS the callback,
 * so nothing can ever intersect — which is right for the outline's scroll-spy
 * (it must not fire) and useless for anything that only does work once it is on
 * screen. This one keeps every callback and every observed target, and
 * `intersectAll()` reports them all as intersecting.
 *
 * `vitest.config.ts` sets `unstubGlobals: true`, so the stub is removed after
 * each test without the caller restoring anything.
 */
export function installIntersectionObserverStub(): {
  intersectAll: () => void;
  observedCount: () => number;
} {
  const instances: Array<{
    callback: IntersectionObserverCallback;
    observer: IntersectionObserver;
    targets: Element[];
  }> = [];

  class DrivableIntersectionObserver {
    readonly root: Element | null = null;
    readonly rootMargin: string = '';
    readonly thresholds: ReadonlyArray<number> = [];
    private readonly targets: Element[] = [];

    constructor(callback: IntersectionObserverCallback) {
      instances.push({
        callback,
        observer: this as unknown as IntersectionObserver,
        targets: this.targets,
      });
    }

    observe(target: Element) {
      this.targets.push(target);
    }

    unobserve(target: Element) {
      const at = this.targets.indexOf(target);
      if (at >= 0) this.targets.splice(at, 1);
    }

    disconnect() {
      this.targets.length = 0;
    }

    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }

  vi.stubGlobal('IntersectionObserver', DrivableIntersectionObserver);

  return {
    observedCount: () => instances.reduce((n, i) => n + i.targets.length, 0),
    intersectAll: () => {
      for (const instance of instances) {
        const targets = [...instance.targets];
        if (targets.length === 0) continue;
        instance.callback(
          targets.map((target) => ({ target, isIntersecting: true }) as IntersectionObserverEntry),
          instance.observer,
        );
      }
    },
  };
}
```

- [ ] **Step 2: Write the failing tests**

In `frontend/src/features/ai/CitationChips.test.tsx`, add the import and a new describe. The import goes beside the existing ones:

```tsx
import { act } from '@testing-library/react';
import { installIntersectionObserverStub } from '../../test-utils';
```

(`act` may already be absent from that file's `@testing-library/react` import — add it to the existing named import instead of a second statement if so.)

```tsx
  // Amendment item 4 (#1361): `CitationChips` renders on EVERY answer, and each
  // image source pulls the FULL attachment (no server-side resize, ADR-025) to
  // paint a 14px square. A reopened N-turn thread would issue N × 4 of them in
  // one gesture. The bound lives inside SourceThumbnail so both surfaces get it.
  describe('thumbnails are viewport-gated', () => {
    const imageSource: Source = {
      kind: 'image',
      pageTitle: 'Turbine assembly',
      pageId: 77,
      attachmentUrl: '/api/attachments/77/turbine.png',
      similarity: null,
    };

    function mockAttachmentFetch() {
      const fetchMock = vi.fn(async () =>
        ({ ok: true, status: 200, blob: async () => new Blob(['x']) } as unknown as Response));
      vi.stubGlobal('fetch', fetchMock);
      return fetchMock;
    }

    it('fetches nothing for eight thumbnails that never come into view', async () => {
      // The assertion that would have failed on the pre-gate component: eight
      // fetches at mount.
      installIntersectionObserverStub();
      const fetchMock = mockAttachmentFetch();

      const sources = Array.from({ length: 8 }, (_, i) => ({
        ...imageSource,
        attachmentUrl: `/api/attachments/77/frame-${i}.png`,
      }));
      render(<CitationChips sources={sources} />, { wrapper: Wrapper });

      await Promise.resolve();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(screen.queryByTestId('source-thumbnail')).not.toBeInTheDocument();
      // Nothing with layout stands in for them, so no placeholder boxes and no
      // layout shift when they do arrive.
      expect(screen.getAllByTestId('source-thumbnail-sentinel')).toHaveLength(8);
    });

    it('fetches exactly the thumbnails that intersect', async () => {
      const observer = installIntersectionObserverStub();
      vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:thumb');
      vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
      const fetchMock = mockAttachmentFetch();

      render(<CitationChips sources={[imageSource]} />, { wrapper: Wrapper });
      expect(fetchMock).not.toHaveBeenCalled();

      await act(async () => {
        observer.intersectAll();
      });

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      expect(fetchMock.mock.calls[0]![0]).toBe('/api/attachments/77/turbine.png');
      expect(await screen.findByTestId('source-thumbnail')).toBeInTheDocument();
    });
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/features/ai/CitationChips.test.tsx -t "viewport-gated"`
Expected: FAIL — `expected "spy" not to be called` with eight calls recorded (the component fetches at mount), and `Unable to find an element by: [data-testid="source-thumbnail-sentinel"]`.

- [ ] **Step 4: Gate the component on a zero-footprint sentinel**

Replace `frontend/src/features/ai/SourceThumbnail.tsx` in full:

```tsx
import { useEffect, useRef, useState } from 'react';
import { cn } from '../../shared/lib/cn';
import { useAuthenticatedSrc } from '../../shared/hooks/use-authenticated-src';

interface SourceThumbnailProps {
  /** `/api/attachments/…` or `/api/local-attachments/…` — an authenticated route. */
  url: string;
  /** Rendered edge length in px. */
  size: number;
  className?: string;
}

/**
 * How far ahead of the viewport a thumbnail starts fetching. The gate exists to
 * bound the UNBOUNDED case — a whole reopened history fetched in one gesture —
 * not to refuse the next screenful, so it is generous.
 */
const PREFETCH_MARGIN = '200px';

/**
 * The picture beside an image source (#1115 P3).
 *
 * Four decisions are load-bearing.
 *
 * **It fetches through `useAuthenticatedSrc`**, the mechanism `ArticleViewer`
 * already uses for every `<img>` in a page body: the attachment routes are
 * behind `fastify.authenticate`, and a browser `<img src>` cannot carry a
 * bearer token, so a plain `src` would 401 on every thumbnail. The hook
 * fetches with the token, hands back a blob URL and revokes it on unmount.
 *
 * **It is DECORATIVE — `alt=""` plus `aria-hidden`** — on every surface that
 * uses it, and every one of them puts the page title on the *control* instead
 * (visible text in the source card, an `aria-label` on the citation chip). A
 * thumbnail with `alt="Page — image"` beside a visible "Page" says the same
 * thing twice to a screen reader while the link, which is the thing you
 * operate, is still the one that has to be named. One rule across all three
 * surfaces beats a per-surface judgement call.
 *
 * **Loading and failure both render NOTHING.** The caller degrades to its
 * title-only shape, which is a complete, operable source citation — an image
 * that will not load must not leave a broken-image glyph or a grey box
 * standing in for a source. It also means an attachment whose ACL has changed
 * since retrieval simply shows as a page link.
 *
 * **It is VIEWPORT-GATED (#1361, owner's decision 2026-08-18).** `CitationChips`
 * renders on every answer and each image source pulls the FULL attachment —
 * ADR-025 deliberately adds no server-side resize — so an N-turn thread costs
 * `N × MAX_IMAGE_SOURCES` (4) full-size requests, and reopening a conversation
 * reaches that state in ONE gesture rather than over a session. So the fetch
 * waits for a zero-footprint sentinel to intersect once, and the gate lives
 * here rather than behind a per-surface flag: the 14px chip and the 32px card,
 * live and reopened, all get it from one place. The sentinel has no layout, so
 * the "loading and failure render nothing" rule above is kept exactly — no
 * placeholder box, no layout shift.
 *
 * Neutral by ADR-010: an image source is a CATEGORY, not a state, so the frame
 * is `--color-border` and nothing here is teal or violet.
 */
export function SourceThumbnail({ url, size, className }: SourceThumbnailProps) {
  const sentinelRef = useRef<HTMLSpanElement>(null);
  // No `IntersectionObserver` at all (an old browser, a non-DOM renderer) means
  // the gate cannot be evaluated — fetch, rather than silently render no
  // thumbnail anywhere for the rest of the session.
  const [inView, setInView] = useState(() => typeof IntersectionObserver === 'undefined');

  useEffect(() => {
    if (inView) return;
    const node = sentinelRef.current;
    if (!node) return;
    if (typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        // Once is enough: the blob URL is held by `useAuthenticatedSrc` until
        // unmount, so scrolling away has nothing to release and scrolling back
        // has nothing to re-fetch.
        setInView(true);
        observer.disconnect();
      },
      { rootMargin: PREFETCH_MARGIN },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [inView]);

  const { blobSrc, error } = useAuthenticatedSrc(inView ? url : null);

  if (!inView || error || !blobSrc) {
    return (
      <span
        ref={sentinelRef}
        aria-hidden
        data-testid="source-thumbnail-sentinel"
        style={{ display: 'inline-block', width: 0, height: 0 }}
      />
    );
  }

  return (
    <img
      src={blobSrc}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      style={{ width: size, height: size }}
      className={cn('shrink-0 rounded border border-border object-cover', className)}
      data-testid="source-thumbnail"
    />
  );
}
```

- [ ] **Step 5: Run the new tests to verify they pass**

Run: `cd frontend && npx vitest run src/features/ai/CitationChips.test.tsx -t "viewport-gated"`
Expected: PASS.

- [ ] **Step 6: Drive intersection in the existing thumbnail cases**

The gate makes every pre-existing case that expects a rendered `<img>`, or a fetch, fail — which is exactly the signal that the gate is real. Update them rather than weaken them.

Run: `cd frontend && npx vitest run src/features/ai/CitationChips.test.tsx src/features/ai/SourceCitations.test.tsx`
Expected: FAIL in `image sources` in both files — `renders a thumbnail inside the numbered chip and names the control` and `renders the thumbnail, the category label and a link to the PAGE` time out on `expect(fetchMock).toHaveBeenCalled()`.

In **both** files, extend the `image sources` describe's `beforeEach` to install the stub and keep the handle:

`CitationChips.test.tsx`:

old
```tsx
    beforeEach(() => {
      vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:thumb');
      vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    });
```
new
```tsx
    // #1361: the thumbnail waits for its sentinel to intersect. jsdom never
    // lays anything out, so the test drives the observer itself.
    let observer: ReturnType<typeof installIntersectionObserverStub>;
    beforeEach(() => {
      observer = installIntersectionObserverStub();
      vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:thumb');
      vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    });

    /** Bring every mounted thumbnail into view. */
    async function scrollIntoView() {
      await act(async () => {
        observer.intersectAll();
      });
    }
```

`SourceCitations.test.tsx`: the same two blocks, verbatim, with the same imports (`act` from `@testing-library/react`, `installIntersectionObserverStub` from `'../../test-utils'`).

Then insert `await scrollIntoView();` in each case that expects a fetch or an `<img>`, immediately after `render(...)` (and, in `SourceCitations.test.tsx`, after the `fireEvent.click(screen.getByText('Sources (N)'))` that expands the cards — the thumbnails do not mount until then):

- `CitationChips.test.tsx`: `renders a thumbnail inside the numbered chip and names the control`, `degrades to the plain numbered chip when the thumbnail cannot be loaded` (it must still reach the fetch to fail it), `tells two pictures from the SAME page apart (review r1)`, `keeps the unqualified name when the URL carries no filename`, and `navigates to the PAGE, never to the attachment`.
- `SourceCitations.test.tsx`: `renders the thumbnail, the category label and a link to the PAGE`, `degrades to the title-only card when the thumbnail cannot be loaded`, `names the picture, so two hits on one page are distinguishable (review r1)`, and `keeps the category label alone when the URL carries no filename`.

The cases asserting **absence** (`leaves an ordinary page chip untouched`, `leaves an ordinary page source alone — no thumbnail, no label`, both `degrades … when kind says image but no URL arrived`) need no change: no `SourceThumbnail` is mounted in them at all.

Task 16's `does not re-probe the attachment ACL the read side already answered` and `issues no attachment fetch for an unavailable image source` **do** need one: add `await scrollIntoView();` (or an inline `installIntersectionObserverStub()` + `intersectAll()` if they sit outside the `image sources` describe, which they do) before the `expect(fetchMock).not.toHaveBeenCalled()`. Without it the gate, not the `target.kind` check, is what makes them pass — and they would then stay green with Task 16's change reverted.

- [ ] **Step 7: Run both files to verify they pass**

Run: `cd frontend && npx vitest run src/features/ai/CitationChips.test.tsx src/features/ai/SourceCitations.test.tsx src/features/ai/image-source.test.ts`
Expected: PASS. `image-source.test.ts` is unchanged — `isImageSource` decides whether a picture EXISTS, and this task only decides when it is fetched.

- [ ] **Step 8: Run the guard suites this task touches, plus typecheck and lint**

Run:
```bash
cd frontend
npx vitest run src/features/ai
npx vitest run src/flat-components.test.ts src/ui-text-legibility.test.ts src/workspace-themes.test.ts src/focus-ring-contrast.test.ts
npx tsc --noEmit
npm run lint
```
Expected: all pass. `flat-components.test.ts` sweeps `.tsx` sources for shadows, transforms, gradients and literal borders — the rewritten component adds an inline `style` with only `display`/`width`/`height`, and no class beyond the ones it already carried.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/features/ai/SourceThumbnail.tsx \
        frontend/src/features/ai/CitationChips.test.tsx \
        frontend/src/features/ai/SourceCitations.test.tsx \
        frontend/src/test-utils.ts
git commit -m "perf(ai): fetch a source thumbnail only once it comes into view

CitationChips renders on every answer and each image source pulls the full
attachment (no server-side resize, ADR-025), so reopening an N-turn thread
issued N x MAX_IMAGE_SOURCES requests in one gesture. The bound lives inside
SourceThumbnail, behind a zero-footprint sentinel, so the 14px chip and the 32px
card get it without a per-surface flag and nothing with layout appears before
the picture does.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

## Part D — Docs and final verification (Task 18)

### Task 18: Docs, guards and final verification

Implements the spec's **PR 2 — frontend › Docs (same PR)** paragraph
(`docs/superpowers/specs/2026-08-17-ai-conversation-history-design.md:1067-1077`) plus
amendment items **4** (viewport-gated thumbnails — closes the two forward references),
**5** (which CLAUDE.md sentences PR 2 owns, and the `#1115` constraint on the new
paragraph) and **8** (the anchors, and `UserMenu.tsx:38-41`'s stale comment fixed in
passing). It is the last task: it edits no component, and its "tests" are the
documentation guards that already run on every PR.

**Files:**
- Modify: `docs/architecture/04-frontend-structure.md:27`, `:33`, `:129-138`, `:259-261`
- Modify: `docs/architecture/09-flow-rag-chat.md:691-693`
- Modify: `docs/architecture/README.md:49` (insert one row after it)
- Modify: `docs/superpowers/specs/2026-07-28-docked-ai-assistant-design.md:5`, `:36-38`
- Modify: `docs/superpowers/specs/2026-08-17-ai-conversation-history-design.md:680-684`, `:1117-1126`
- Modify: `CLAUDE.md:60`, `:265`, `:305`, and one new paragraph before `:307`
- Modify: `docs/USER-GUIDE.md:109-112`
- Modify: `frontend/src/shared/components/layout/MainNavStrip.tsx:6-16`
- Modify: `frontend/src/shared/components/layout/UserMenu.tsx:38-40`
- Test: `frontend/src/architecture-docs-mermaid.test.ts`, `frontend/src/docs-image-retrieval-record.test.ts`,
  `frontend/src/architecture-docs-embedding-model.test.ts` (all existing; no new test file — these
  three are the guards that read the files this task edits)

**Interfaces:**
- Consumes: every name the plan's earlier tasks produced, as prose only —
  `isAiRoute` / `conversationPath` / `AI_HOME_PATH` (Task 1), `activeThreadId` /
  `startNewConversation` (Task 2), `streamingThreadId` (Task 3), `purgeConversation`
  (Task 4), `threadLoadState` / `historyTruncated` (Task 5), `CONVERSATIONS_LIST_KEY`
  (Task 9), `AiConversationsSidebar` / `ConversationList` / `ConversationRow` (Tasks 10-12),
  `AI_HOME_ACTIONS` / `DOCK_ACTIONS` (Task 15), the `SourceThumbnail` viewport gate (Task 17).
- Produces: nothing any task consumes. This task must run **last** — several edits state
  facts (the tree is gone from `/ai`, the thumbnail is gated, the reset keys on
  `activeThreadId`) that are only true once Tasks 6, 14, 15 and 17 have landed.

**Pinned here** (decisions the brief and spec left open, taken in this task):

1. The `04-frontend-structure.md:27` fAI node is **appended to** as amendment item 8
   requires, *and* its first line's route list is corrected (`/ai` → `/ai and /ai/c/:id`).
   "Append, don't replace" guards against clobbering the string #1362 grew; it does not
   ask us to leave the route name wrong.
2. CLAUDE.md's new pane paragraph is inserted **immediately before** the `#1218`
   scroll-chain paragraph (`:307` today), so the three `/ai`-subject paragraphs stay
   adjacent and a reader meets the topology before the scroll rule that depends on it.
3. `docs/architecture/README.md`'s new row goes **immediately after `:49`** (the existing
   frontend row) and is worded as the narrower case, per amendment item 8.
4. **Two CLAUDE.md sentences beyond the brief's three are corrected in the same edits**,
   because PR 2 makes them false: `:60`'s closing guard sentence ("a conversation switch")
   and `:305`'s attachment-scope sentence ("clears on `pageId` changes", which Task 6
   changed to `activeThreadId`). Leaving a paragraph half-true is the drift CLAUDE.md
   rule 6 exists to prevent.
5. `UserMenu.tsx:38-41`'s comment is fixed **here**, not in a code task: amendment item 8
   calls it a fix in passing, and this is the only task in the plan that edits comments.
6. `docs/USER-GUIDE.md`'s AI Chat list keeps its numbering and grows step 4 into the
   mechanism plus a new step 5 for what is *not* saved.
7. Final verification compares against **`origin/dev`**, not the local `dev` ref: the
   worktree's `dev` is stale (`d7b9208b`) while `origin/dev` is `4357f454`, so
   `git log dev..HEAD` lists ten commits that are already on the target branch.

---

- [ ] **Step 1: Pin the mermaid guard as this task's failing test**

There is no new test file: `src/architecture-docs-mermaid.test.ts` and
`src/docs-image-retrieval-record.test.ts` already read every file this task edits, and
they are the assertions that fail when a docs edit is wrong. Confirm they are green
*before* the edits, so a later red is this task's doing and not inherited.

Run: `cd frontend && npx vitest run src/architecture-docs-mermaid.test.ts src/docs-image-retrieval-record.test.ts src/architecture-docs-embedding-model.test.ts`

Expected: PASS (all three). If any is already red, stop — an earlier task broke it and
this task must not bury the failure.

- [ ] **Step 2: `04-frontend-structure.md` — the fAI node (`:27`) and the shell node (`:33`)**

Both are mermaid flowchart node labels inside the `## Provider & feature layout` block.
Old (line 27, one line):

```
        fAI["ai/<br/>AiAssistantPage (/ai — no-document home)<br/>dock/ AiDock · DockPanel · AiDockSheet · DockDiffCard (#1126)<br/>tab inside ArticleRightPane, sheet over the article below md<br/>SourceCitations · CitationChips · SourceThumbnail (#1115 P3)<br/>image-source.ts · source-target.ts · source-confidence.ts"]
```

New (one line):

```
        fAI["ai/<br/>AiAssistantPage (/ai and /ai/c/:id — no-document home)<br/>conversations/ AiConversationsSidebar · ConversationList · ConversationRow (#1361)<br/>ai-routes.ts (shared/lib) · assistant-actions.ts<br/>dock/ AiDock · DockPanel · AiDockSheet · DockDiffCard (#1126)<br/>tab inside ArticleRightPane, sheet over the article below md<br/>SourceCitations · CitationChips · SourceThumbnail (#1115 P3)<br/>image-source.ts · source-target.ts · source-confidence.ts"]
```

Old (line 33, one line):

```
    app --> shell["AppLayout (authenticated shell)<br/>mounts AiProvider above the routes (#1126):<br/>conversations keyed by page and retained,<br/>inert until an AI surface consumes it"]
```

New (one line):

```
    app --> shell["AppLayout (authenticated shell)<br/>mounts AiProvider above the routes (#1126):<br/>dock threads keyed by page, /ai threads by conversation (#1361),<br/>12 retained, inert until an AI surface consumes it"]
```

Both replacements were parsed against the installed mermaid before this plan was
written: all five fenced blocks in the file still parse, and a raw `#`, `/` or `:`
inside a quoted flowchart label is captured whole (the mermaid guard's own header says
so — only *sequence* diagrams have the `[^#\n;]` lexer boundary).

- [ ] **Step 3: `04-frontend-structure.md:129-138` — no tree clears a mode any more**

Old (lines 129-138 verbatim):

```
- `/ai` keeps only the Ask and Generate tabs. The four document actions are
  dock chips; their mode screens still render for `?mode=…` deep links, but
  nothing offers them and nothing in the app builds one — only bookmarks and
  links made before #1126. `SidebarTreeView` is not a source of them and never
  was: its `isAiRoute` clicks navigate to `/ai?pageId=…` with `replace: true`,
  which *drops* any `mode=` already in the URL, and `AiContext` reads the
  mode-less result as Ask (deliberately — a sticky `improve` carried onto a
  plain `/ai` would render a document screen with no tab selected and no way
  back except the URL bar). It is what clears a mode deep link, not what makes
  one.
```

New:

```
- `/ai` offers Q&A and Generate; the dock offers Q&A, the five rewrite skills
  and Diagram. Since #1361 those are two named lists in one leaf module,
  `features/ai/assistant-actions.ts` (`AI_HOME_ACTIONS` / `DOCK_ACTIONS`), and
  `AssistantActionSelect` takes the list as an `actions` prop rather than the
  old `includeGenerate` boolean. The module is a leaf on purpose: it holds the
  `AssistantAction` type, so `AiContext` can read the allow-list without
  importing `AssistantActionSelect`, which imports `AiContext`.
- **No tree clears a mode any more, and the allow-list is what makes a stale
  deep link fall back.** `SidebarTreeView` used to navigate to `/ai?pageId=…`
  with `replace: true` on AI routes, which *dropped* any `mode=` already in the
  URL — an accident that read like a feature. #1361 took the Pages tree off
  `/ai` entirely and with it all three `/ai?pageId=` producers, so nothing
  rewrites the URL on a click. What makes `?mode=improve|diagram` land on Q&A
  is now explicit: `AiContext`'s URL-mode parser accepts, on an AI route, only
  a mode `AI_HOME_ACTIONS` names, exactly as the retired `summarize` /
  `quality` values already fell back. Old bookmarks therefore open the Ask
  composer instead of a document screen with no action selected and no way
  back except the URL bar.
```

- [ ] **Step 4: `04-frontend-structure.md:259-261` — state the thumbnail decision**

This closes the first of the two forward references amendment item 4 names.
Old (lines 259-261, inside the `## Image retrieval on the frontend (#1115)` byte-cost
bullet):

```
  at a time — which is why PR 2 decides whether thumbnails render lazily (see
  the **PR 2 flag** bullet at the end of the `/ai` page changes section of
  `docs/superpowers/specs/2026-08-17-ai-conversation-history-design.md`).
```

New:

```
  at a time — so #1361 bounded it inside `SourceThumbnail` itself rather than
  behind a per-surface flag: the component observes a zero-footprint sentinel
  with `IntersectionObserver` and hands `useAuthenticatedSrc` `null` until that
  sentinel has intersected once, after which the observer disconnects. A
  thumbnail therefore costs a fetch only when it is scrolled into view, and the
  14px chip and the 32px card, live and reopened alike, inherit the gate.
  Nothing with layout renders before intersection, while loading or on failure,
  so the "loading and failure both render nothing" rule above is kept and there
  is no layout shift. "Only the last N turns" was the alternative and was not
  taken: it is a rule about history length that a reader scrolling back
  defeats, while the viewport gate is exact.
```

- [ ] **Step 5: Run the mermaid and embedding-model doc guards**

Run: `cd frontend && npx vitest run src/architecture-docs-mermaid.test.ts src/architecture-docs-embedding-model.test.ts`

Expected: PASS. The mermaid guard parses all five blocks in the edited file; the
embedding-model guard only requires that `09-flow-rag-chat.md` keeps naming
`rag-service.ts` and `routes/knowledge/search.ts`, which Step 6 does not touch.

- [ ] **Step 6: `09-flow-rag-chat.md:691-693` — the deep-search reset keys on `activeThreadId`**

Old (lines 691-693 verbatim):

```
flag, so leaving it lit would show a mode the request is not in), and a
**conversation switch** on `/ai` (the sidebar swaps the thread under a composer
that stays mounted, which no remount tidies up).
```

New:

```
flag, so leaving it lit would show a mode the request is not in), and a
**thread switch** on `/ai`. That second one keys on `AiContext`'s
`activeThreadId`, not on the sidebar: since #1361 a thread is identified by
where you are (`draft`, `conv:<id>`, `page:<id>`) and by an identity stamped at
filing, so New chat, opening a saved conversation from the conversations pane
and Back/Forward between two `/ai/c/:id` URLs all clear the toggle under a
composer that stays mounted, which no remount tidies up — while typing, a `?q=`
prefill and a first answer's promotion from `draft` to `conv:<id>` leave it
alone, because none of those is a different conversation.
```

- [ ] **Step 7: The docked-AI spec — status line and a second amendment block**

Two edits in `docs/superpowers/specs/2026-07-28-docked-ai-assistant-design.md`. The
[Affected files](#affected-files) list at `:242-249` is **not** edited — the spec's own
precedent (the 2026-08-06 block) is that a superseded element is recorded in a dated
amendment, not silently rewritten in the body.

Edit A — old (line 5):

```
**Status:** Shipped, with one element superseded — see the amendment below.
```

New:

```
**Status:** Shipped, with two elements superseded — see the two amendments below.
```

Edit B — old (lines 36-38):

```
> Current topology of record: `docs/architecture/04-frontend-structure.md`.

## Problem
```

New:

```
> Current topology of record: `docs/architecture/04-frontend-structure.md`.

> ## Amendment (2026-08-18, saved conversations on `/ai` — #1361)
>
> **The dock is unchanged; `/ai` is not.** Everything above still describes the
> assistant beside the document, tab container included. What changed is the
> *other* surface this spec touched in passing, and it supersedes two elements:
> one bullet of the 2026-08-06 block and one line of
> [Affected files](#affected-files).
>
> - **"conversations keyed by page" (the 2026-08-06 block's last bullet) is now
>   half true.** `AiContext` keys threads by **location**: `page:<id>` for the
>   dock — unchanged, the open document is still the key — and `draft` /
>   `conv:<id>` for `/ai`, which gained a per-conversation URL `/ai/c/:id`.
>   Each thread also carries an **identity**, so a stream writer follows a
>   re-key (a first answer promotes `draft` to `conv:<id>` mid-stream) and drops
>   its write instead of resurrecting a thread that has been replaced. The
>   12-thread retention and "opening the assistant runs nothing" (#1176) are
>   untouched.
> - **"`/ai` becomes Ask + Generate" (the `AiAssistantPage.tsx` line of Affected
>   files) understates it.** The Pages tree no longer renders on AI routes at
>   all — a conversations pane takes the left rail — and page scope on `/ai` is
>   retired outright: no context chip, no `+ Sub-pages`, and an ask from `/ai`
>   sends no `pageId`, so a dock-origin conversation continued from `/ai`
>   searches the whole corpus. The dock keeps page scope; that asymmetry is the
>   point of this spec and is intact.
>
> Files this adds to the list below: `frontend/src/shared/lib/ai-routes.ts`,
> `frontend/src/features/ai/conversations/*` (the pane),
> `frontend/src/features/ai/assistant-actions.ts`,
> `frontend/src/shared/hooks/use-list-roving-focus.ts`,
> `frontend/src/shared/components/layout/AppLayout.tsx` (the pane is the third
> arm of the sidebar ternary), and
> `frontend/src/shared/components/layout/SidebarTreeView.tsx` +
> `DndLocalSpaceTree.tsx` (the `isAiRoute` prop and every branch keyed on it
> deleted).
>
> Design of record for all of it:
> `docs/superpowers/specs/2026-08-17-ai-conversation-history-design.md`.

## Problem
```

- [ ] **Step 8: The #1361 spec — the PR 2 flag bullet becomes the decision**

The second forward reference amendment item 4 names. In
`docs/superpowers/specs/2026-08-17-ai-conversation-history-design.md`, old (lines
680-684, the last bullet of `## /ai page changes`):

```
- **PR 2 flag, not decided here**: every persisted `kind: 'image'` source reopens as a live
  thumbnail fetch (`useAuthenticatedSrc` pulling the full attachment, up to `MAX_IMAGE_SOURCES`
  = 4 per turn, no server-side resize per ADR-025) — a long thread reopened fetches N turns × 4.
  PR 2 should decide whether reopened thumbnails render lazily (in-viewport, or only the last N
  turns) rather than eagerly for the whole history.
```

New:

```
- **Decided (owner, 2026-08-18; amendment item 4) — thumbnails are viewport-gated, inside
  `SourceThumbnail`.** Every persisted `kind: 'image'` source used to reopen as a live
  thumbnail fetch (`useAuthenticatedSrc` pulling the full attachment, up to `MAX_IMAGE_SOURCES`
  = 4 per turn, no server-side resize per ADR-025), so a long thread reopened fetched N turns
  × 4 at mount. PR 2 puts the bound in the component rather than behind a per-surface flag:
  `SourceThumbnail` observes a zero-footprint sentinel with `IntersectionObserver` and passes
  `useAuthenticatedSrc` `null` until the sentinel has intersected once, after which the
  observer disconnects. The 14px chip and the 32px card, live and reopened alike, inherit it,
  and `typeof IntersectionObserver === 'undefined'` is treated as intersected so a
  non-observing environment degrades to today's behaviour rather than to a blank chip.
  Nothing with layout renders before intersection, while loading or on failure, so the
  "loading and failure both render nothing" rule is kept and there is no layout shift.
  "Only the last N turns" was the alternative and was not taken: it is a rule about history
  length that a reader scrolling back defeats, while the viewport gate is exact.
```

- [ ] **Step 9: The #1361 spec — Architect's calls 9 and 10 marked decided**

Both were settled by PR 1 (#1365) and their anchors are dead; amendment item 8 says to
mark them decided rather than leave them open. Verified in the worktree:
`backend/src/domains/llm/services/history-budget.ts:37` exports `selectReplayableHistory`,
and `backend/src/routes/llm/llm-ask.ts:664` writes `page_ref` with `userCanAccessPage`
authorising the id at `:379`.

Old (lines 1117-1126):

```
9. **A refused exchange's orphan user turn is dropped from replay.** Today the `refused`
   filter strips the assistant half and replays the bare question (`llm-ask.ts:740-742`).
   Defining the budget walk in whole exchanges makes the orphan a decision; dropping it keeps
   the replayed history well-formed for providers that reject consecutive same-role messages
   and costs the model one unanswered question it could not have used.
10. **`page_ref` is authorised at write time.** The ask route never authorised a bare
    `pageId` (only the `includeSubPages` branch did, `llm-ask.ts:274-280`), and the pane would
    have read the title back — a page-title oracle over the whole table. A consequence of
    writing the column at all rather than an owner call, but it adds one `userCanAccessPage`
    query to the first ask of a dock conversation.
```

New:

```
9. **A refused exchange's orphan user turn is dropped from replay. — DECIDED, shipped in
   PR 1 (#1365).** The old `refused` filter stripped the assistant half and replayed the
   bare question; the anchor it cited (`llm-ask.ts:740-742`) no longer exists. The budget
   walk now lives in `backend/src/domains/llm/services/history-budget.ts`
   (`selectReplayableHistory`), walks whole exchanges and drops the orphan, which keeps the
   replayed history well-formed for providers that reject consecutive same-role messages and
   costs the model one unanswered question it could not have used.
10. **`page_ref` is authorised at write time. — DECIDED, shipped in PR 1 (#1365).** The ask
    route never authorised a bare `pageId` (only the `includeSubPages` branch did), and the
    pane reads the title back, which would have been a page-title oracle over the whole
    table. The INSERT beside `llm-ask.ts:664` writes `page_ref` only for an id
    `userCanAccessPage` has cleared, at the cost of one extra query on the first ask of a
    dock conversation.
```

- [ ] **Step 10: `CLAUDE.md:60` — the DeepSearchToggle reset**

Two replacements inside the single line 60 (each substring is unique in the file —
verified with `grep -F -c`).

Edit A — old:

```
It clears at two further boundaries: a **dock chip run** (Improve / Summarize / Diagram / Quality post to routes that do not take the flag — a lit control describing a mode the request is not in) and a **conversation switch on `/ai`** (the sidebar swaps the thread under a mounted composer, which no remount tidies up).
```

New:

```
It clears at two further boundaries: a **dock chip run** (Improve / Summarize / Diagram / Quality post to routes that do not take the flag — a lit control describing a mode the request is not in) and a **thread switch on `/ai`**, which since #1361 keys on `AiContext`'s `activeThreadId` rather than on the sidebar — New chat, opening a saved conversation and Back/Forward between two `/ai/c/:id` URLs all swap the thread under a mounted composer that no remount tidies up, while typing, a `?q=` prefill and a first answer's promotion from `draft` to `conv:<id>` deliberately leave it lit because none of those is a different conversation.
```

Edit B — old:

```
each fail if the flag survives a send, a remount, a chip run or a conversation switch
```

New:

```
each fail if the flag survives a send, a remount, a chip run or an `activeThreadId` change
```

- [ ] **Step 11: `CLAUDE.md:265` — the rail contract gains a third occupant**

Old (the closing sentence of line 265):

```
Both tree implementations (`SidebarTreeView`, `DndLocalSpaceTree`) render in the same rail and must move together.
```

New:

```
Both tree implementations (`SidebarTreeView`, `DndLocalSpaceTree`) render in the same rail and must move together — and since #1361 so does a third occupant, the `/ai` conversations pane (`AiConversationsSidebar`), which is the shell's left rail on `/ai` and `/ai/c/:id` instead of the Pages tree. It shares `ui-store`'s `treeSidebarCollapsed` / `treeSidebarWidth`, the same resize handle, the same `h-12` `panel-toolbar` nav row carrying `MainNavStrip`, and the same `SidebarSessionChrome` footer, so a chassis change lands in all three or the rail visibly changes shape when you switch tabs. `toolbar-rule-alignment.test.ts` holds each of them to exactly one `panel-toolbar` + `border-b` row with no `py-` on it — the footer is `border-t`.
```

- [ ] **Step 12: `CLAUDE.md:305` — two action sets, and the scope keys on the thread**

Two replacements inside line 305 (both unique).

Edit A — old:

```
Both assistant surfaces select the action **inside the composer beside Send**: Q&A, five standalone rewrite skills, and Diagram; `/ai` also offers Generate, while the article-side dock deliberately does not because Generate creates a new page rather than acting on the open one.
```

New:

```
Both assistant surfaces select the action **inside the composer beside Send**, and since #1361 they offer **different sets**, declared once in `features/ai/assistant-actions.ts` and passed to `AssistantActionSelect` as an `actions` allow-list rather than an `includeGenerate` boolean: the dock gets `DOCK_ACTIONS` — Q&A, five standalone rewrite skills and Diagram — and `/ai` gets `AI_HOME_ACTIONS`, which is Q&A and Generate only. The dock has no Generate because Generate creates a new page rather than acting on the open one; `/ai` has no rewrite skills and no Diagram because page scope was retired there and it has no document to act on. That list is also the fallback rule: a `?mode=improve|diagram` deep link on an AI route lands on Q&A because the URL-mode parser checks it, which is a stated allow-list rather than the accident it replaced (a tree click that rewrote the URL and dropped the `mode=` on the way).
```

Edit B — old:

```
The scope clears on `pageId` changes so source material cannot leak into another page context.
```

New:

```
The scope clears on `activeThreadId` changes — New chat, opening a saved conversation, a dock page switch — so source material cannot leak into another conversation.
```

- [ ] **Step 13: `CLAUDE.md` — the new paragraph for the pane and the per-conversation URL**

Inserted immediately before the `#1218` scroll-chain paragraph, so the `/ai` paragraphs
stay adjacent. It **must not contain the string `#1115`**
(`src/docs-image-retrieval-record.test.ts:82-95` fails otherwise); Step 14 proves that
guard actually bites.

Old (the opening of line 307):

```
**`/ai` scrolls its message pane, not the page (#1218).**
```

New (the new paragraph, a blank line, then the old opening unchanged):

```
**`/ai` is a conversation with a URL, and the thread key is the LOCATION (#1361).** Saved Q&A conversations reopen at `/ai/c/:id`; on AI routes the shell's left rail carries `AiConversationsSidebar` instead of the Pages tree, whose `isAiRoute` prop and three `/ai?pageId=` producers are gone. Page scope on `/ai` went with them — no context chip, no `+ Sub-pages`, no `pageId` on the ask — so a dock-origin conversation continued from `/ai` searches the whole corpus, and the row's page chip records **origin, not live scope**. `AiContext` keys its ≤12 retained threads by location (`shared/lib/ai-routes.ts` owns the predicates): `draft` for a fresh `/ai`, `conv:<id>` for a reopened one, `page:<id>` for the dock, which is unchanged. **Every thread also carries an `identity`, and stream writers are bound to it rather than to the key.** A first answer promotes `draft` to `conv:<id>` and replaces the URL mid-stream, so a writer holding a key would write into the wrong thread or lose the answer; a writer whose identity is no longer filed DROPS its write instead of resurrecting a thread the user replaced. `activeThreadId` — that identity as a string — is also what every composer reset keys on: Deep Search, the Ask composer's external URLs and the attachment scope clear on a thread switch and on nothing else, so typing, a `?q=` prefill and the promotion itself leave them alone. Server data is TanStack Query only (`useInfiniteQuery` over the keyset list, invalidated on `['llm', 'conversations']` after every ask, rename and delete); the `useState` mirror this replaced could not be invalidated by a mutation and went stale the moment a second surface wrote. A stale id answers 404 and the turn **fails in place** — *This conversation no longer exists — your next question starts a new one.*, the id cleared, no toast and no navigation — because redirecting out from under a typed draft destroys the one thing the user still has. Only Q&A is saved; Generate, the rewrite skills and Diagram are not. Design of record: `docs/superpowers/specs/2026-08-17-ai-conversation-history-design.md`.

**`/ai` scrolls its message pane, not the page (#1218).**
```

- [ ] **Step 14: Prove the `#1115` guard bites, then run the docs guards**

Temporarily append the string ` See #1115 for the image sources it renders.` to the end
of the new paragraph from Step 13 and run:

Run: `cd frontend && npx vitest run src/docs-image-retrieval-record.test.ts`

Expected: FAIL — `names #1115 nowhere else but the declared cross-references`, with the
new paragraph's first 90 characters printed as the stray entry.

Now remove that sentence again and re-run:

Run: `cd frontend && npx vitest run src/docs-image-retrieval-record.test.ts`

Expected: PASS (four assertions: one retrieval block ≤ 1,300 words, one corpus block
≤ 700 words, no stray `#1115` paragraph, and the backend-module/measured-record checks).

- [ ] **Step 15: `MainNavStrip.tsx:6-16` — the strip now sits above three sidebars**

Old (lines 6-16):

```tsx
/**
 * The "Pages / AI / Graph" strip that appears at the top of every left
 * sidebar — `SidebarTreeView` on `/`, `/pages/*`, `/ai`, and
 * `SettingsSidebar` on `/settings/*`. Extracted into one component so the
 * two sidebars can't drift in order or in styling. The visual order here
 * is the source of truth.
 *
 * Keyboard shortcuts (g p / g a / g g) are owned by `AppLayout` and stay
 * tied to the mnemonic letter, not to the display order — so reordering
 * here doesn't move keys.
 */
```

New:

```tsx
/**
 * The "Pages / AI / Graph" strip that appears at the top of every left
 * sidebar — `SidebarTreeView` on `/` and `/pages/*`,
 * `AiConversationsSidebar` on `/ai` and `/ai/c/:id` (#1361), and
 * `SettingsSidebar` on `/settings/*`. Extracted into one component so the
 * three sidebars can't drift in order or in styling. The visual order here
 * is the source of truth.
 *
 * `isActive` is plain `startsWith` for the AI pill, so `/ai` and
 * `/ai/c/<id>` both light it: a reopened conversation is still the AI tab,
 * and no code change was needed for the per-conversation route.
 *
 * Keyboard shortcuts (g p / g a / g g) are owned by `AppLayout` and stay
 * tied to the mnemonic letter, not to the display order — so reordering
 * here doesn't move keys.
 */
```

- [ ] **Step 16: `UserMenu.tsx:38-40` — the stale `/ai` header comment (amendment item 8)**

The trigger has not been in the top-right of the header since #1364 moved session chrome
into the rails; the `z-50` is still right, but its stated reason is now the sidebar
footer sitting under `/ai`'s sticky sub-header.

Old (lines 38-40):

```tsx
          // z-50 sits above the AI sub-header's z-20 sticky strip; without
          // it the portaled menu is clipped behind that strip when the trigger
          // is in the top-right of the header on /ai.
```

New:

```tsx
          // z-50 sits above the AI sub-header's z-20 sticky strip; without it
          // the portaled menu is clipped behind that strip. Since #1364 the
          // trigger is in the foot of the left rail (SidebarSessionChrome),
          // not the header, and the menu opens upward across /ai's sub-header
          // from there — including from the conversations pane (#1361).
```

- [ ] **Step 17: `docs/USER-GUIDE.md:109-112` — name the mechanism**

Old (lines 109-112):

```
1. Open the **AI** panel from the sidebar (or press `G A`).
2. Type your question or request.
3. Responses stream in real-time via SSE.
4. Conversations are saved and can be continued later.
```

New:

```
1. Open the **AI** panel from the sidebar (or press `G A`).
2. Type your question or request.
3. Responses stream in real-time via SSE.
4. **Q&A conversations are saved.** Past conversations are listed in the left
   pane on the AI page, grouped by when you last used them (Today, Yesterday,
   Previous 7 days, and so on), with a filter box once you have more than
   eight. Selecting one reopens it at its own address (`/ai/c/<id>`), so it can
   be bookmarked and walked with the browser's Back and Forward buttons, and
   your next question continues it. Each row's `⋯` menu **renames** it in place
   (Enter commits, Escape cancels) or **deletes** it permanently. **New chat**
   — in the top bar and at the top of the pane — starts an empty one.
5. Only Q&A is saved. Generate, the rewrite skills and Diagram are not.
   Questions you ask from the assistant beside an article are saved too and
   appear in the list tagged with the page they started on; continuing one from
   the AI page searches the whole knowledge base rather than that page.
```

- [ ] **Step 18: `docs/architecture/README.md` — one new table row after `:49`**

Old (line 49):

```
| A new top-level `frontend/src/features/*` folder or provider | `04-frontend-structure.md` |
```

New (two lines — the existing row, then the new one):

```
| A new top-level `frontend/src/features/*` folder or provider | `04-frontend-structure.md` |
| A new **route** inside an existing `frontend/src/features/*` folder, or a provider's data model changing | `04-frontend-structure.md` |
```

The wording is deliberately the narrower case: `:49` already covers a *new folder or a
new provider*, so a row worded "a new frontend route or provider change" would duplicate
it. `/ai/c/:id` and `AiContext`'s move from page-keyed to location-keyed threads are both
this row and neither is `:49`.

- [ ] **Step 19: Run every guard this task's files are read by**

Run: `cd frontend && npx vitest run src/architecture-docs-mermaid.test.ts src/architecture-docs-embedding-model.test.ts src/docs-image-retrieval-record.test.ts`

Expected: PASS.

Run: `cd frontend && npx tsc --noEmit && npm run lint`

Expected: clean. (`MainNavStrip.tsx` and `UserMenu.tsx` changed only inside comments, so
this is a cheap confirmation that neither comment block was closed wrongly.)

- [ ] **Step 20: Commit the docs**

```bash
git add docs/architecture/04-frontend-structure.md \
        docs/architecture/09-flow-rag-chat.md \
        docs/architecture/README.md \
        docs/superpowers/specs/2026-07-28-docked-ai-assistant-design.md \
        docs/superpowers/specs/2026-08-17-ai-conversation-history-design.md \
        docs/USER-GUIDE.md \
        CLAUDE.md \
        frontend/src/shared/components/layout/MainNavStrip.tsx \
        frontend/src/shared/components/layout/UserMenu.tsx
git commit -m "docs(ai): record saved conversations on /ai — location-keyed threads, the pane, the viewport-gated thumbnail

The two forward references amendment item 4 left open are now answers rather
than questions, the deep-search reset is documented as keying on activeThreadId
instead of \"the sidebar\", and the rail contract names its third occupant.
Architect's calls 9 and 10 are marked decided — PR 1 shipped both.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 21: Final verification — the whole frontend suite**

Run: `cd frontend && npx vitest run`

Expected: PASS, no skipped-by-accident files. Watch specifically for the suites this PR
rewrote or deleted from: `src/features/ai/AiContext.threads.test.tsx`,
`src/features/ai/AiAssistantPage.test.tsx`, `src/features/ai/modes/AskMode.test.tsx`,
`src/features/ai/AiDock.test.tsx`, `src/features/ai/CitationChips.test.tsx`,
`src/features/ai/SourceCitations.test.tsx`,
`src/shared/components/layout/AppLayout.test.tsx`,
`src/shared/components/layout/SidebarTreeView.test.tsx`,
`src/shared/components/layout/DndLocalSpaceTree.test.tsx`, and the new
`src/features/ai/conversations/*` files.

If a failure appears only in the full run and not in the per-file runs, suspect a shared
module-level counter: `nextIdentity()` is module state in `AiContext.tsx`, so a test that
asserts a literal identity value rather than "changed / unchanged" is order-dependent.
Fix the assertion, not the counter.

- [ ] **Step 22: Final verification — types, lint and the guard list**

Run: `cd frontend && npx tsc --noEmit`

Expected: no output.

Run: `cd frontend && npm run lint`

Expected: no output (`eslint --max-warnings=0 src/ scripts/`).

Run the Global Constraints guard list explicitly, so a green full-suite line cannot hide
a guard that was never collected:

```bash
cd frontend && npx vitest run \
  src/ui-text-legibility.test.ts \
  src/flat-components.test.ts \
  src/destructive-treatment.test.ts \
  src/focus-ring-contrast.test.ts \
  src/workspace-themes.test.ts \
  src/ai-scroll-chain.test.ts \
  src/toolbar-rule-alignment.test.ts \
  src/docs-image-retrieval-record.test.ts \
  src/scroll-padding-mask.test.ts \
  src/architecture-docs-mermaid.test.ts
```

Expected: PASS, ten files. Two of them are the ones this PR is most likely to have moved:
`destructive-treatment.test.ts` (the ratchet must still read ≤ 21 — Task 10 used
`nm-action-destructive` and hand-rolled nothing) and `toolbar-rule-alignment.test.ts`
(Task 12 added the pane to `SELF_BORDERED`, so the pane must carry exactly one
`panel-toolbar` + `border-b` row and no `py-` on it).

- [ ] **Step 23: Final verification — the deletions really happened**

These are greps rather than tests, because "a branch that is gone" has no assertion to
write. Run from the repo root:

```bash
# The Pages tree has no AI branch left (the predicate itself lives in shared/lib
# and is legitimately imported by AppLayout, so scope the grep to the two trees).
grep -n "isAiRoute" frontend/src/shared/components/layout/SidebarTreeView.tsx \
                    frontend/src/shared/components/layout/DndLocalSpaceTree.tsx \
                    frontend/src/shared/components/layout/SidebarTreeView.test.tsx \
                    frontend/src/shared/components/layout/DndLocalSpaceTree.test.tsx
# Expected: no output (baseline before this PR: 10 / 9 / 26 / 0).

# No producer of the retired page-scoped AI link survives in the shell.
grep -rn "ai?pageId=" frontend/src/shared/components/layout/
# Expected: no output.

# The useState mirror and its API are gone from AiContext.
grep -n "loadConversation\|setConversations\|deleteConversation" frontend/src/features/ai/AiContext.tsx
# Expected: no output (the hydration successor is `hydrateThread`, module-private).

# The one string the docs guard forbids in a new CLAUDE.md paragraph.
grep -n "#1115" CLAUDE.md | wc -l
# Expected: unchanged from before this PR — this task added no #1115 mention.
```

- [ ] **Step 24: Final verification — the branch itself**

```bash
git fetch origin dev
git log --oneline origin/dev..HEAD
git diff --stat origin/dev...HEAD
git status --short
```

Expected: eighteen commits, one per task, in task order; a clean working tree; and
**`origin/dev`, not the local `dev` ref** — the worktree's `dev` is stale (`d7b9208b`
against `origin/dev` `4357f454`), so `dev..HEAD` lists ten commits that are already on the
target branch and makes the review look twice its size.

Confirm the PR targets `dev` (CLAUDE.md rule 2) and that no `.env`, key or binary is in
the diff (rule 3):

```bash
git diff --name-only origin/dev...HEAD | grep -E '(^|/)\.env|\.pem$|\.key$|\.p12$' || echo "no secrets in the diff"
```

- [ ] **Step 25: Open the PR**

The template is `.github/pull_request_template.md` (Summary / Changes / Checklist /
Related Issues). Write the body to a **task-scoped** scratch file, never a generic name —
parallel agents clobber `pr-body.md`:

```bash
cat > /tmp/pr-body-1361-pr2-frontend.md <<'BODY'
## Summary

The frontend half of #1361, on top of PR 1 (#1365). `/ai` gets a per-conversation URL
(`/ai/c/:id`), a conversations pane in the shell's left rail in place of the Pages tree,
reopenable history with rename and delete, and a simplified `/ai` page with page scope
retired. Design of record:
`docs/superpowers/specs/2026-08-17-ai-conversation-history-design.md` **and its
2026-08-18 amendment block**, which supersedes three sentences of the body (the chassis
footer, New chat's placement, and the thumbnail decision).

The load-bearing idea is that an `AiContext` thread is keyed by **location** — `draft`,
`conv:<id>`, `page:<id>` — and carries an **identity** stamped when it is filed. A first
answer promotes `draft` to `conv:<id>` and replaces the URL while the stream is still
running, so every stream writer dispatches by identity: it follows the re-key, and a
write whose identity is no longer filed is dropped rather than resurrecting a thread the
user has replaced. `activeThreadId` is that identity as a string, and it is the single
key every composer reset now hangs off.

## Changes

- **Routing.** New `shared/lib/ai-routes.ts` (`AI_HOME_PATH`, `isAiRoute`,
  `conversationIdFromPath`, `conversationPath`) and the `/ai/c/:conversationId` route;
  `PageTransition`'s route depth and `AiContext`'s page resolution both read the
  predicate. A legacy `/ai?pageId=x` now resolves to no document.
- **Thread identity.** `AiThread` gains `identity` / `loadState` / `loadError` /
  `historyTruncated`; `activeThreadId` and `streamingThreadId` are exposed; the abort
  effect and the streaming indicators key on them. Promotion, the stale-404 recovery,
  a `conversationId: null` final frame, the completed-exchange mirror and
  `purgeConversation` implement the spec's state machine row by row.
- **Hydration.** Opening a row fetches `GET /llm/conversations/:id` into `conv:<id>`
  (never into the thread you are looking at), maps `refused` → `isRefusal` and `sources`
  back onto the messages, and shows *Loading conversation…* / an error block with Retry.
- **The pane.** `features/ai/conversations/`: `useConversationList` (`useInfiniteQuery`
  over PR 1's keyset list), rename and delete mutations, `groupByRecency`,
  `useListRovingFocus`, `ConversationRow` + `ConversationRowMenu` (kebab, inline rename,
  delete confirm), `ConversationList` (groups, filter, Show more, three list states) and
  `AiConversationsSidebar` (the Pages-tree chassis plus a `SidebarSessionChrome` footer).
  `AppLayout` mounts it as the third arm of the sidebar ternary, in the drawer and on the
  desktop.
- **`/ai` simplified.** The Pages tree leaves AI routes (the `isAiRoute` prop and all
  three `/ai?pageId=` producers are deleted from both trees); the model `<select>`, the
  context chip and `+ Sub-pages` go; New chat moves into the 48px header slot via
  `HeaderHost`; `AssistantActionSelect` takes an `actions` allow-list, so `/ai` is Q&A +
  Generate and a `?mode=improve` deep link falls back to Q&A.
- **Sources.** A `Source` may be `unavailable`, which resolves to `{ kind: 'none' }` and
  renders inert with `title="This page is no longer available to you"`;
  `SourceThumbnail` is viewport-gated with an `IntersectionObserver` sentinel, so a
  reopened N-turn thread no longer fires N × 4 attachment fetches at mount.
- **`AiContext`'s `useState` conversations mirror is deleted** along with
  `conversations` / `setConversations` / `loadConversation` / `deleteConversation`;
  server state is TanStack Query, invalidated on `['llm', 'conversations']`.
- **Docs.** `04-frontend-structure.md`, `09-flow-rag-chat.md`,
  `docs/architecture/README.md`, both specs (the docked-AI spec gains a second dated
  amendment), `docs/USER-GUIDE.md` and `CLAUDE.md`.

## Checklist

- [x] Tests added/updated (`npm test` passes)
- [x] Type checking passes (`npm run typecheck`)
- [x] Linting passes (`npm run lint`)
- [x] Documentation updated (if applicable: `docs/`, `.env.example`, `CLAUDE.md`, `README.md`)
- [ ] Screenshots attached (for UI changes)
- [x] No secrets committed (`.env`, API keys, PATs, passwords)

Screenshots to attach before review — this is a shell-level UI change and the diff does
not show it: the expanded pane on `/ai` in Graphite and in Paper, the collapsed rail, the
mobile drawer with a row selected, the kebab menu open with Delete highlighted (the
`nm-action-destructive` `data-highlighted` state added in `index.css`), a row in inline
rename, and the header slot showing `AI` + New chat.

## Related Issues

Relates to #1361 (PR 2 of 3 — frontend). Builds on #1365 (PR 1 — backend and contracts).
PR 3 is auto-title.
BODY

gh pr create --base dev --head feature/1361-conversations-frontend \
  --title "feat(ai): saved conversations on /ai — /ai/c/:id, the conversations pane, location-keyed threads (#1361, PR 2/3)" \
  --body-file /tmp/pr-body-1361-pr2-frontend.md
```

After posting, re-read the body (`gh pr view --json body -q .body`) rather than trusting
the local file: a parallel agent can overwrite a scratch file between the write and the
`gh` call, and the PR is the artefact that matters.

- [ ] **Step 26: Attach the screenshots and mark the checklist item**

Take the six screenshots listed above against the branch running locally, attach them to
the PR body, and tick the *Screenshots attached* box. The PR is not ready for review
until that box is ticked — every other line of this PR's UI work is invisible in a
unified diff.

