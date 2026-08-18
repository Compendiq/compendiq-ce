# Saved Conversations on `/ai` — PR 2 (frontend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/ai` gets a per-conversation URL (`/ai/c/:id`), a conversations pane in the shell's left rail (replacing the Pages tree on AI routes), reopenable history, rename/delete, and a simplified `/ai` page — the frontend half of #1361, on top of PR 1's backend (#1365).

**Architecture:** Threads in `AiContext` are re-keyed from *page* to *location* (`draft` / `conv:<id>` / `page:<id>`) and every thread carries an **identity** so stream writers follow re-keys and drop orphans; the pane is the third arm of `AppLayout`'s sidebar ternary and copies the Pages tree's chassis (ADR-010 v0.6) with a `SidebarSessionChrome` footer; server data lives in TanStack Query (`useInfiniteQuery` over PR 1's keyset list) and `AiContext`'s `useState` mirror is deleted; the New chat control lives in the 48px header slot via `HeaderHost`; `SourceThumbnail` is viewport-gated.

**Tech Stack:** React 19, react-router (`NavLink`, `useLocation`, `useNavigate`), TanStack Query v5 (`useInfiniteQuery`, `useMutation`), Radix `DropdownMenu`, TailwindCSS 4 + the `nm-*` utilities, Zustand `ui-store`, Vitest + jsdom + `@testing-library/react`, `@compendiq/contracts` (`ConversationSummary`, `ConversationDetail`, `ConversationListResponseSchema`, `ATTACHMENT_URL_PATTERN`).

**Spec:** `docs/superpowers/specs/2026-08-17-ai-conversation-history-design.md` — sections *Direction*, *Routing and thread identity*, *The conversation pane*, *`/ai` page changes*, *Accessibility*, *Scope*, *PR 2 — frontend*, **and the `Amendment (2026-08-18, dev drift before PR 2)` block at the top, which supersedes three body sentences (Chassis footer, New chat placement, thumbnails).** Executors read both. Where the body and the amendment disagree, the amendment wins.

## Global Constraints

- Branch `feature/1361-conversations-frontend` from `dev` after #1365 (already cut in the worktree `/Users/simon/Documents/localGIT/compendiq-ce-wt-1361-design`); PR targets `dev`; squash-merge; not stacked.
- Tests required for every task (CLAUDE.md rule 1): Vitest + jsdom + `@testing-library/react`; mock at the network boundary (`fetch` / MSW), never internal components except where the existing test file already stubs a sibling (`SidebarTreeView.test.tsx:19-20` stubs `SidebarSessionChrome` — the pane's own test file does the same; `AppLayout.test.tsx` mocks `SidebarTreeView`, `ArticleRightPane`, `CommandPalette`, `ServiceStatus`, `ThemeToggle`, `use-media-query` and deliberately **not** `SettingsSidebar` — do the same for the pane so its "exactly one `/llm/conversations` request" test observes a real query).
- Run from `frontend/`: `npx vitest run <file>`; `npx tsc --noEmit`; `npm run lint` (`eslint --max-warnings=0`). Contracts are consumed via built `dist/` — after any `packages/contracts/src` edit run `npm run build -w packages/contracts` from the repo root (this PR should not need one).
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

<!-- TASKS -->
