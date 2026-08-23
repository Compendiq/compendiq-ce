# Saved Conversations on `/ai` — Design

**Date:** 2026-08-17
**Issue:** #1361 (saved conversations in the `/ai` left pane — reopenable `/ai/c/:id`, replaces the page tree and page-click context on `/ai`)
**Status:** Proposed — design of record for the three PRs in [Sequencing](#sequencing). PR 1 shipped (#1365, 2026-08-18); **amended 2026-08-18 and re-amended 2026-08-22** for dev drift before PR 2 — see the amendment block below, which supersedes four sentences of the body.
**Verified against:** `origin/dev` `7c3a7bf8` (2026-08-17). Every `file:line` below was re-read at that commit; where the issue's own citations had drifted, this document carries the corrected anchor.

> The fourteen decisions in the issue's table are the owner's (interview, 2026-08-17). This
> document does not re-argue them. It settles the mechanism under each one, resolves the
> items the issue left as "implementer's call", and pins the contracts, the thread model,
> the pane and the tests precisely enough that three PRs can be written from it without
> reopening the design. Where this document goes beyond the issue it says so, in
> [Architect's calls](#architects-calls-flagged-for-the-owner).

> ## Amendment (2026-08-18, dev drift before PR 2)
>
> First written against `origin/dev` `bbe8118a`. Between this spec's base (`7c3a7bf8`) and that
> point, #1364 (header chrome distilled into a 48px bar; theme + account moved into the
> rails), #1362/#1366/#1367 (#1115 P3–P5: image sources on the `/llm/ask` wire and shown to the
> model), #1368 (layout presets restored, article-only), #1371 (CLAUDE.md consolidation),
> #1373 (the article *format toolbar* moved back out of the header slot into the page column)
> and #1372 (article inspector reading rail) landed. **Two of those six have since been
> reversed** — see the re-verification paragraph below — so read #1364's rails claim and
> #1368's presets claim as history, not as the state of the code.
>
> **Re-verified 2026-08-22 against `origin/dev` `a6a3d329`** (76 further commits, merged into
> the PR 2 branch as `f409a44b`), and amended again against the **owner's three rulings of
> 2026-08-22**. Dev reversed both halves of #1364: **#1377/#1378 moved theme + account back
> out of the rails into the header** (`HeaderSessionCluster`) and **retired the header slot
> entirely** — `HeaderHost` renders in the document column, `#app-header-slot` has no
> producer, and the header band is 44px, not 48. **#1391/#1377 deleted the layout presets**
> and `forceTreeCollapsed` with them. **#1401 put five "create skills" on both assistant
> surfaces** and gave the dock a Generate-shaped path. Items **1, 2 and 3 below are rewritten
> for that**; item 2 carries the owner's re-decided **placement** for New chat (ruling 1),
> and item 9 carries rulings 2 and 3. Routing, thread keys, the state machine and every `/ai`
> page change still hold — `AiAssistantPage.tsx` has had no commit since `4357f454`. Nine
> things moved under the pane; items 1–4 supersede sentences below (2 and 4 with the
> **owner's decisions**), the rest bind the PR 2 plan. The body is left as written (the
> docked-AI spec's precedent); this block is what the plan reads.
>
> 1. **The chassis has NO session-chrome footer; it has a count-and-navigation footer.**
>    (Rewritten 2026-08-22 — the 2026-08-18 version of this item argued the opposite from
>    #1364, which dev has since reversed.) #1377/#1378 moved the theme toggle and the account
>    menu back out of the rails into the **header** — `HeaderSessionCluster`
>    (`NotificationBell` + `ThemeToggle` + `UserMenu`), mounted at `AppLayout.tsx:498` inside
>    `<header>` — and `AppLayout.test.tsx:198`/`:241`/`:263-264` now pin that the header
>    *contains* `header-session-cluster` and `theme-toggle`. `SidebarSessionChrome.tsx` still
>    exists but **has no consumer left**: zero occurrences in `SidebarTreeView.tsx` and
>    `SettingsSidebar.tsx`, and the only live references are its own test plus a now-dead
>    `vi.mock('./SidebarSessionChrome', …)` stub at `SidebarTreeView.test.tsx:19-20`. So the
>    argument the old item rested on ("a pane without it makes `/ai` the only authenticated
>    route with no account menu") is **false** — the account menu is in the header on every
>    route, mobile included, and the pane must not render one.
>
>    The [Chassis](#chassis) structure is therefore nav row → New chat → filter → `<nav>` →
>    Show more → a `panel-toolbar flex shrink-0 items-center gap-2 border-t px-2 py-1.5`
>    footer (`SidebarTreeView.tsx:1348`, byte for byte) whose left cell is the **loaded row
>    count** — the same number `CONVERSATION_FILTER_THRESHOLD` is measured against — in a
>    `min-w-0 flex-1 truncate text-[11px] text-muted-foreground` span. The right cell is
>    **empty**: the tree spends it on a Trash `Button`, and the pane has no equivalent
>    low-frequency destination. The collapsed rail is expand button → `MainNavStripCollapsed`
>    (only when `embedMainNav`) → `SquarePen` New chat, with **no** `mt-auto` footer —
>    matching the tree's collapsed branch, whose one `mt-auto` child is that same Trash
>    button. **`border-t`, never `border-b`**: `toolbar-rule-alignment.test.ts:52-69` now
>    requires **every** `panel-toolbar` + `border-b` line in a `SELF_BORDERED` file to carry
>    `h-12` (it used to check only the first, and the tree now has two such rows), and
>    `:92-105` forbids `/\bpy-\d/` on the first such row. Pane test: **no
>    `SidebarSessionChrome` mock is needed and none may be added**, and **no** mock of the
>    pane in `AppLayout.test.tsx` (item 8).
> 2. **New chat lives at the top of the `/ai` document column, via `HeaderHost` — owner
>    decision 12's intent preserved, its 2026-08-18 placement amendment overtaken by dev and
>    re-decided by the owner on 2026-08-22 (ruling 1).** Decision 12 read *"List in the
>    slide-over drawer + a 'New chat' control in the `/ai` sub-header so a phone user needn't
>    open the drawer"*; the 2026-08-18 interview moved it to the **48px header slot**, and
>    **dev then deleted that slot outright**, so the owner re-decided the placement on
>    2026-08-22. The intent ("a phone user needn't open the drawer") stands and is still
>    served, and Architect's call 2 (renders at every width) stands. The [Mobile](#mobile)
>    sentence and the AC line read "the top of the `/ai` page column" from here on.
>
>    What dev did: #1377/#1378 retired the header slot entirely. `HeaderHost`
>    (`shared/components/layout/header-slot.tsx:7-16`) is now the whole file and renders its
>    children **in place** — `return <div className={fallbackClassName}>{node}</div>`. There
>    is **no `#app-header-slot` element anywhere in `frontend/src`**: `APP_HEADER_SLOT_ID`
>    (`header-slot-utils.ts:1`) has no producer and only tests read it. `AppHeaderMain`, the
>    `occupied` computation and `data-header-kpis` are **all gone** (zero hits), so the old
>    item's `data-header-kpis` warning is moot and its `AppHeaderMain` fallback-title argument
>    names nothing. Three guards fail any attempt to put a route title back in the band:
>    `header-slot.test.tsx:7-19` (*"renders the heading in the document, never in the header
>    slot"* — it appends a real `#app-header-slot` node and asserts nothing lands in it),
>    `app-shell-layout.test.ts:304` (`AppLayout` contains no `AppHeaderMain`) and
>    `AppLayout.test.tsx:140` (*"does not put a route title in the header"*, rendered at
>    `/ai`). The band is also **44px now, not 48** — `index.css` `--app-header-height:
>    2.75rem`, enforced by `app-shell-layout.test.ts:121-131`, which additionally asserts
>    `AppLayout` has no `<header … h-12>` and no `<header … border-b>` — so "the 48px header
>    slot" was doubly wrong. The one live `h-12` line is the *panel toolbars*'
>    (`toolbar-rule-alignment.test.ts`).
>
>    Mechanism: `AiAssistantPage` renders `<HeaderHost fallbackClassName="mb-1">` as the
>    **first child inside** its root `<m.div>` (`AiAssistantPage.tsx:229-252` — insert directly
>    after the root's `className="flex min-h-0 flex-1 flex-col gap-3"` and its `>`), never a
>    fragment sibling above it: `ai-scroll-chain.test.ts:110-126` scopes to
>    `export function AiAssistantPage()`, finds the root with
>    `/return \(\s*<m\.div([\s\S]*?)>/` and then requires a **static** `className="…"` on it,
>    so a moved root or a `cn(...)` root throws and takes two of its cases down. Inside, the
>    Library heading-row pattern (`PagesPage.tsx:1037-1058`): `<h1>AI</h1>` on the h1 recipe
>    `min-w-0 truncate text-[15px] font-semibold sm:text-lg`, plus a ghost `SquarePen` "New
>    chat" (`data-testid="ai-new-chat"`) calling `startNewConversation()`. Because `HeaderHost`
>    renders a plain `<div className={fallbackClassName}>`, the row supplies its own layout —
>    `flex min-w-0 items-center justify-between gap-3` — and needs no `ml-auto`. It renders at
>    every width and stays visible while the log scrolls, because `/ai` scrolls its message
>    pane and not the page (#1218). `routeHeaderTitle` (`header-slot-utils.ts:6-15`) still
>    answers `AI` for `/ai/c/:id` but now has **no runtime consumer at all**, so it is dead
>    code and the follow-up "the conversation title in `/ai`'s sub-header on `/ai/c/:id`"
>    becomes "in the `/ai` heading row". **The pane's own full-width New chat and the collapsed
>    rail's glyph stay** (owner's choice): the page column's is the one that survives a
>    collapsed rail, the pane's is the one inside the mobile drawer. **The sub-header bar
>    stays** (owner, 2026-08-18, unchanged by ruling 1): the
>    sticky wrapper (`:292-296`), the bordered card (`:297`), the Think toggle (`:389-409`) and
>    `DiagramTypeSelector` (`:415`) remain; the divider (`:384`) and the `flex-1` spacer (`:298`)
>    go with the controls they separated, so Think sits left rather than being pushed right by
>    a spacer with nothing on its left. Nothing pins the bar: `ai-scroll-chain.test.ts` names
>    only the root and the message pane.
> 3. **The pane takes no `forceCollapsed` / `onForceExpand`, and dev removed the only
>    producer.** (Rewritten 2026-08-22: the conclusion survives, its cited mechanism does
>    not.) `LayoutPresetMenu.tsx` and `article-layout-controls.tsx` were **deleted** in the
>    #1391/#1377 shell work — `features/pages/edit-affordance.test.ts:60`/`:62` now assert
>    `LayoutPresetMenu`'s *absence* from `PageViewPage` and the inspector — and
>    `forceTreeCollapsed` no longer exists anywhere in `frontend/src`. `AppLayout` passes
>    neither prop to either sidebar, and there is a **new guard against re-adding them**:
>    `app-shell-layout.test.ts:268-269` fails if `forceCollapsed` or `forceTreeCollapsed`
>    reappears in `AppLayout.tsx`. `SidebarTreeView` still *declares* the props
>    (`:431-439`, used at `:749`, `:773`, `:808`) for its own callers; the pane must not grow
>    them, and its expand button is a plain `toggleTreeSidebar`. CLAUDE.md says the same in
>    prose: *"The laptop-width force-collapse of the page tree is gone."*
>
>    **What the desktop arms DO carry is `embedMainNav`.** A chassis-level `<MainNavChassisRail
>    />` now sits outside the workspace card (`AppLayout.tsx:509`), so both desktop sidebars
>    pass `embedMainNav={false}` and both drawer sidebars pass bare `embedMainNav`. The pane
>    needs the same prop (`embedMainNav?: boolean`, defaulting to `true`) or the desktop arm
>    renders a second Pages/AI/Graph strip beside the chassis rail. Two literals in
>    `AppLayout.tsx` are grepped verbatim by `app-shell-layout.test.ts:300-305` —
>    `SettingsSidebar embedMainNav={false}`, `SidebarTreeView embedMainNav={false}` and
>    `SidebarTreeView onNavigate={closeMobileSidebar} embedMainNav` — so the three-arm ternary
>    must not reorder them out of existence, and `:241-250` additionally requires
>    `<SidebarTreeView` to appear inside `app-workspace` and before `id="main-content"`.
> 4. **`SourceThumbnail` is viewport-gated in PR 2 (owner's decision, 2026-08-18).** #1362
>    renders a `SourceThumbnail` in `CitationChips` (on every answer) and `SourceCitations`,
>    each fetching the full attachment through `useAuthenticatedSrc` at mount
>    (`SourceThumbnail.tsx:40-54`); PR 1 persists `kind` + `attachmentUrl` so a reopened answer
>    renders as the live one did, and `04-frontend-structure.md` states the bound per assistant
>    turn on screen — an N-turn thread already multiplies it live, and a reopen reaches that
>    state in one gesture. Rather than accept `answers × MAX_IMAGE_SOURCES` fetches at mount,
>    the owner chose to bound it now, and the bound lives **inside `SourceThumbnail`** so the
>    14px chip and the 32px card, live and reopened alike, get it without a per-surface flag:
>    the component observes a zero-footprint sentinel with `IntersectionObserver` and hands
>    `useAuthenticatedSrc` `null` until the sentinel has intersected once (the hook already
>    skips a `null` url); before that, and while loading or on failure, it still renders
>    NOTHING that has layout — the "loading and failure both render nothing" rule above is kept,
>    so no placeholder box and no layout shift. `test-setup.ts:5-18` stubs
>    `IntersectionObserver` for jsdom (the outline's scroll-spy already depends on it); the
>    existing `CitationChips.test.tsx` / `SourceCitations.test.tsx` thumbnail cases drive the
>    stub's callback to intersect, and a new case mounts N thumbnails with a stub that never
>    intersects and asserts **zero** attachment fetches — the assertion that would have failed
>    on the pre-gate component. It is a #1115 surface, so it is its own task with both test
>    files re-run. **PR 2 also closes the forward references this decision leaves open**:
>    `04-frontend-structure.md:259-261` reads *"which is why PR 2 decides whether thumbnails
>    render lazily (see the PR 2 flag bullet …)"* and the spec's own **PR 2 flag** bullet
>    (`:519-523`) is what this item answers — both are rewritten to state the decision and the
>    mechanism. **Also in PR 2:** `SourceCitations` gates its thumbnail on `isImageSource(source)
>    && target.kind !== 'none'` — an `unavailable` source must not re-probe an ACL the read side
>    already reported gone (`CitationChips` already does this by construction, gating on
>    `target.kind === 'internal'`).
> 5. **PR 1 already landed five items this spec assigned to PR 2**; the plan must not redo
>    them: `loadConversation` maps `sources` (`AiContext.tsx:686-698`; it still calls
>    `setModel(conv.model)` at `:699`, which PR 2 removes per the state machine's *Open a
>    row*); the list query tolerates `{ items }` (`:607-618`, mirror effect `:619-621`);
>    `refusal.tsx:59-66` and `source-target.ts:44-46` are reworded; CLAUDE.md's #1119 paragraph
>    is rewritten for persisted sources, `unavailable` and image identity (it now reads "There
>    are **four** reasons" since #1367's `image_only_context` — do not restate three); and
>    `image-source.ts:1`/`:31` already gates `isImageSource` on the contract's
>    `ATTACHMENT_URL_PATTERN` (`packages/contracts/src/schemas/llm.ts:220`), the last gate
>    before `<img>` — PR 2 adds only the `target.kind !== 'none'` half. PR 2's CLAUDE.md work
>    is the DeepSearchToggle sentence (the reset keys on `activeThreadId`, now `:66`), the
>    rail-contract sentence ("Both tree implementations … render in the same rail", now
>    `:278`), the two-action-sets sentence (now `:318`, and see item 9 — dev has already made
>    its Generate clause false) and the new pane paragraph — which must **not** contain
>    the string `#1115`, or `frontend/src/docs-image-retrieval-record.test.ts:69-95` fails
>    (every `#1115`-mentioning CLAUDE.md paragraph must open with a declared prefix or be a
>    declared cross-reference).
> 6. **`CommandPalette` gained a second `/ai?q=` producer** (#1364's no-results recovery item
>    pushes `path: '/ai?q=' + encodeURIComponent(q)`), so the `?q=` prefill has two callers to
>    keep working; the "exactly three producers of `/ai?pageId=`" count is unchanged.
> 7. **The pane owes the `#1218` chain nothing, footer included.** It is a sibling of `<main>`
>    under `app-workspace` (`AppLayout.tsx:517`), itself under `panel-wrapper` (`:510-516`),
>    and `ai-scroll-chain.test.ts:145-151` names only `AppLayout`, `PageTransition` and
>    `AiAssistantPage`. Inside the aside the footer is one more `shrink-0` row: nav row
>    (`h-12 shrink-0`, rendered only when `embedMainNav`) → New chat → filter → `<nav
>    className="min-h-0 flex-1 overflow-y-auto">` → Show more → footer. One constraint from
>    the neighbouring guard: `scroll-padding-mask.test.ts:82` asserts `AppLayout` contains no
>    responsive `pt-` variant anywhere, so do not add one while wiring the pane.
> 8. **Anchors** (re-read 2026-08-22 at `a6a3d329`). Everything else is renumbering and is
>    carried by the PR 2 plan, not repeated
>    here: `AppLayout.tsx` (drawer ternary `:408-410`, desktop slot `:521-525`, `AiProvider
>    :351`, drawer-close effect `:317-320`, `panel-wrapper :510-516`, `app-workspace :517`,
>    the new `<MainNavChassisRail />` at `:509`, and `isExistingArticlePath` renamed to
>    `isArticlePath` at `:28`), `AppLayout.test.tsx:357-390` (the
>    `/ai` leg to invert is `:368-379`; `SettingsSidebar` is deliberately unmocked there — do
>    the same for the pane; the file now also mocks `NotificationBell` `:67` and `UserMenu`
>    `:71`, and its `use-media-query` stub `:78` gained `useIsInspectorWideLayout`),
>    `AppLayout.test.tsx:742-758` (the "issues no AI requests" test,
>    spec `:678-693`), `SidebarTreeView.tsx` chassis anchors (`SECTION_LABEL` `:151`
>    still module-private; the nav row `:873` now wrapped in `{embedMainNav && (…)}`, with a
>    **second** bordered `panel-toolbar … h-12` space row at `:890` and a second collapse
>    button at `:1087-1096` for the `!embedMainNav` branch; the footer `:1348`; the resize
>    handle `:1373-1401`, whose double-click **resets to 282, not 280** — `ui-store.ts:51`
>    `treeSidebarWidth: 282`; `isAiRoute` still `pathname === '/ai'` at `:522`; both `#417`
>    tests at `SidebarTreeView.test.tsx:368`/`:374`; still 26 `isAiRoute` occurrences),
>    `UserMenu.tsx:34`/`:51` (recipe unchanged, `align` prop added; **its `:39-41` comment has
>    already been corrected in dev** — it now says "in the header session cluster", which is
>    true, so PR 2 has nothing to fix in passing there and the step should be struck),
>    `SettingsSidebar.tsx:147-153`, `index.css:1132-1150` (`nm-action-destructive`, same
>    shape, still `&:hover:not(:disabled)` at `:1136-1139` and still no `&[data-highlighted]`;
>    `destructive-treatment.test.ts`'s ratchet is still 21),
>    `04-frontend-structure.md:27` (the fAI node string **changed again** under the shell work
>    — `AiDock`/`AiDockSheet` dropped and the inspector clause reworded — so re-derive the
>    append from the current string, and `:129-138` is now `:150-159`, `:259-261` now
>    `:278-280`), `09-flow-rag-chat.md:691-693` (the "conversation switch on `/ai`" sentence, spec
>    `:391-397` — moved ~+300 lines by #1115's docs), `docs/architecture/README.md`'s table at
>    `:43-63` — the new row must be worded as the narrower case (a new **route inside an
>    existing feature**, or a provider's data model changing), or it duplicates the row already
>    at `:49` — `shared/lib/article-route.ts` (#1368; the exact module shape `ai-routes.ts`
>    argues for — cite it), and the docked-AI spec, which has no commit since. `AiContext.tsx`
>    shifted ~+5 from PR 1's own edits. Two of this spec's Architect's calls are already
>    settled by PR 1 and their anchors are dead: call 9's `llm-ask.ts:740-742` is gone,
>    replaced by `selectReplayableHistory()` in
>    `backend/src/domains/llm/services/history-budget.ts`, which already implements the
>    whole-exchanges walk with the orphan user turn dropped; call 10's `page_ref` write landed
>    beside `llm-ask.ts:373-379`. Mark both decided rather than open.
> 9. **Create skills (#1401) are intended on BOTH surfaces, and decision 13's `/ai` list grows
>    by five — owner rulings 2 and 3, 2026-08-22.** #1401 added a fifth block of actions to
>    `AssistantActionSelect` — `CreateSkillAction = 'create-spec' | 'create-guide' |
>    'create-notes' | 'create-postmortem' | 'create-custom'` (`:29-30`), rendered
>    unconditionally at `:217-223`, with `applyAssistantAction` mapping `create-*` →
>    `setCreateSkill(id); setMode('generate')` (`:102-125`) — and gave the **dock** a
>    `runCreateSkill` path to `POST /llm/generate` with an *Apply to Page* draft card
>    (`dock/use-dock-actions.ts`, `dock/DockDraftCard.tsx`, the five-item empty-state picker
>    at `DockPanel.tsx:570-600`), deleting the effect that used to keep `generate` off the
>    dock. It is pinned green by `dock/AiDock.create-skills.test.tsx:107-117`.
>
>    **The owner ruled this intended (ruling 2): keep it.** It makes CLAUDE.md's standing
>    sentence *"the article-side dock deliberately does not [offer Generate]"* false in dev
>    already — a pre-existing dev/doc inconsistency PR 2 did not create — so PR 2's docs task
>    rewrites that sentence to the new rule rather than reverting a shipped feature. The same
>    paragraph's closing *"layout presets still expand it"* names the feature item 3 records
>    as deleted, and is fixed in the same edit.
>
>    **Decision 13's "drop the rewrite skills and Diagram from `/ai`" half still stands**, so
>    the `actions` allow-list restructure stays in PR 2, with these three lists (ruling 3):
>    `AI_HOME_ACTIONS = ['ask', 'generate', ...CREATE_SKILL_ACTIONS]`;
>    `DOCK_ACTIONS = ['ask', ...IMPROVEMENT_TYPES, 'diagram', 'generate',
>    ...CREATE_SKILL_ACTIONS]`; `CREATE_SKILL_ACTIONS` = the five `create-*` ids, sourced from
>    `features/ai/assistant-actions.ts` alongside the `AssistantAction` /
>    `CreateSkillAction` type re-export. `AssistantActionSelect` gains `actions` replacing
>    `includeGenerate`, its #1401 create-skills section renders **iff** the passed list
>    carries those ids, and `applyAssistantAction`'s `create-*` mapping is preserved
>    unchanged. **The URL-mode allow-list on AI routes stays `ask | generate` only**:
>    `create-*` is never a URL `mode` value — `mode=generate` is the URL form and the skill is
>    picked in-app — so `isAiHomeAction` needs no create entries.

## Problem

`/ai` cannot go back to a past conversation. Persistence exists (`llm_conversations`,
migration 007, written by `POST /llm/ask`) and `AiContext` exposes `conversations` /
`loadConversation` / `deleteConversation` / `startNewConversation` — but nothing in the UI
calls them, a reload empties the in-memory LRU-12 thread map, there is no per-conversation
URL, and the left pane on `/ai` is the **Pages tree**, whose only `/ai`-specific behaviour is
that clicking a page rescopes the assistant to it via `/ai?pageId=` — the invisible context
#1160 papered over with a chip.

Four things in the current code make the naive fix wrong, and the design below is shaped by
them:

1. **Threads are keyed by page, not by conversation.** `threadKeyFor(pageId)` yields
   `page:<id>` or `no-page` (`AiContext.tsx:304-306`); `loadConversation` writes into
   *whichever thread is active* (`:670-698`), so a loaded conversation clobbers the page
   thread you happen to be on and there is no key a URL could name.
2. **Two composer resets key on two different things.** `DeepSearchToggle` resets on
   `conversationId` (`modes/AskMode.tsx:77-79`); `AssistantAttachmentsScope` clears on `pageId`
   (`AssistantAttachments.tsx`). Once page scope is retired on `/ai`, `pageId` is always
   `null` there and attachments would never clear across conversations.
3. **The save path is thin and racy.** `saveConversation` (`llm-ask.ts:500-522`) rewrites the
   whole `messages` array, never writes `page_id`, never persists sources, silently accepts
   a stale/foreign `conversationId` (a 0-row UPDATE), and replays history unbounded
   (`:736-747`).
4. **The read side is minimal.** `GET /llm/conversations` has no `LIMIT` and no index;
   `IdParamSchema` is `z.string().min(1)`; the contracts `ConversationSchema` is dead code
   that matches no handler; there is no PATCH.

## Direction

`/ai` becomes the **no-document home** the #1126 spec promised: a chat surface whose left
pane lists **conversations**, not pages. A conversation is the unit a person comes back to,
so it gets a URL (`/ai/c/:id`), a title, a row, Rename and Delete. Page-scoped Q&A lives
where the page is — the docked assistant on `/pages/:id` — and nothing on `/ai` silently
scopes a question to a page any more.

No new visual language: the pane is the third arm of the shell's existing sidebar ternary and
copies the Pages tree's chassis (ADR-010 v0.6). One shadow, flat colours, neutral chips, teal
only on actions.

### Topology

```
┌──────────────┬──────────────────────────────────────────────────────────┐
│ Pages AI Grph│  [New chat]                              (sub-header)    │
│──────────────│                                                          │
│ [+ New chat] │  ┌────────────────────────────────────────────────────┐  │
│ Filter…      │  │ You: how do we rotate the PAT?                     │  │
│              │  │                                                    │  │
│ TODAY        │  │ ✦ Rotate it under Settings → Confluence …          │  │
│ ▸ PAT rotat… ⋯│  │   [1] [2]  · confidence high                       │  │
│   Onboardi…  │  │                                                    │  │
│ YESTERDAY    │  │ You: and the schedule?                             │  │
│   Sync inte… │  │ ✦ …                                                │  │
│   Draw.io d… ⌐Runbook¬                                                │  │
│ PREVIOUS 7 D…│  │                                                    │  │
│   …          │  └────────────────────────────────────────────────────┘  │
│ [Show more]  │  Older messages in this conversation are no longer sent… │
│              │  ┌────────────────────────────────────────────────────┐  │
│              │  │ Ask about your knowledge base…       [Q&A ▾] [Send]│  │
│              │  └────────────────────────────────────────────────────┘  │
└──────────────┴──────────────────────────────────────────────────────────┘
   280px (shared)                    /ai/c/3f9c…
```

`⌐Runbook¬` is the neutral **page chip** a dock-origin row carries. `⋯` is the kebab, shown
on hover, on `focus-within` and always on the active row. Below `md` the pane lives in the
slide-over drawer, and the sub-header's **New chat** is the one-tap path to a fresh thread.

## Routing and thread identity

### Routes and predicates

- `App.tsx` gains `<Route path="/ai/c/:conversationId" element={<AiAssistantPage />} />`
  directly beside `/ai` (`App.tsx:214`). Same lazy component.
- New module **`frontend/src/shared/lib/ai-routes.ts`** (shared: `AppLayout` in `shared/` and
  `AiContext` in `features/` both need it; there are no frontend ESLint boundaries and
  `shared/hooks/useClearCacheOnLogout.ts` already imports from `features/`, but a route
  predicate is shell plumbing and belongs in `shared/lib`):

  ```ts
  export const AI_HOME_PATH = '/ai';
  const AI_ROUTE = /^\/ai(?:\/c\/([^/]+))?$/;
  export function isAiRoute(pathname: string): boolean;             // /ai and /ai/c/:id
  export function conversationIdFromPath(pathname: string): string | null;
  export function conversationPath(id: string): string;              // `/ai/c/${id}`
  ```

  `AiProvider` sits **above** `<Routes>` (`AppLayout.tsx:414`), so it cannot use `useParams`;
  it reads the id from `location.pathname` exactly as `resolveAiPageId` reads the article id.
- Every `pathname === '/ai'` test becomes `isAiRoute(pathname)`: the `?q=` prefill guard
  (`AiContext.tsx:532`, #957 — prefill now works on `/ai/c/:id?q=` too), the AppLayout
  sidebar ternary (both slots), `PageTransition.routeDepth` (`PageTransition.tsx:15` — dead
  helper kept for its test; update for consistency). `MainNavStrip.isActive` already uses
  `startsWith('/ai')` and needs no change; `CommandPalette`'s `startsWith('/ai')` is the
  palette's slash-prefix, not a route test, and is untouched — **Ask AI from the palette
  still lands on bare `/ai`** (a new chat) with `?q=`, deliberately.
- `resolveAiPageId` returns `null` on AI routes; its `/pages/:id` branch stays for the dock.
  A legacy `/ai?pageId=` bookmark therefore opens a plain new chat.

### Thread keys

`threadKeyFor` takes the location, not a `pageId`:

| Where | Key | Notes |
|---|---|---|
| `/ai` | `draft` | today's `no-page`, renamed. Exactly one draft exists, filed at provider init. |
| `/ai/c/<id>` | `conv:<id>` | filed on activation, fetched into this key; refetchable. |
| `/pages/:id` (dock) | `page:<id>` | unchanged; filed on activation. |

`MAX_RETAINED_THREADS = 12` stays one shared cap. A `conv:` thread is refetchable, the active
thread is MRU by construction (so eviction never removes it), and the only unrecoverable loss
is a `draft` whose first answer was aborted (decision 9 — accepted).

`AiThread` gains four fields:

```ts
interface AiThread {
  …existing…
  identity: number;                          // stamped when the thread is FILED — see below
  loadState: 'ready' | 'loading' | 'error';  // conv: hydration; 'ready' for draft/page
  loadError: string | null;
  historyTruncated: boolean;                 // last final frame, or GET :id on reopen (decision 10)
}
```

**Filing and identity.** `EMPTY_THREAD` is a template, not an entry: it carries `identity: 0`,
which is never observed. **One function knows what an unfiled thread looks like:**
`seedFor(key)` returns `{ …EMPTY_THREAD, loadState: key.startsWith('conv:') ? 'loading' :
'ready' }`. It is used in three places, so the answer is the same whichever runs first: the
**read path** (`threads.get(threadKey) ?? seedFor(threadKey)` — the first render of `/ai/c/X`
already shows *Loading conversation…*, never the Ask empty state), `touchThread` when a write
arrives for a missing key (`AiContext.tsx:329-332` reads `?? EMPTY_THREAD` today — the widened
`/ai/c/X?q=` prefill is exactly such a write, and with `EMPTY_THREAD` it would file
`loadState: 'ready'` and silently suppress hydration), and provider init for `draft`. A thread
is *filed* when an entry is written into the map, and filing always stamps a fresh
`nextIdentity()`; `touchThread` **preserves** the identity of an existing entry — a write is
not a filing. Hydration is a separate effect keyed on **state, not presence**: whenever the
active thread's `loadState === 'loading'` and no fetch is in flight for that key, fetch
`GET /llm/conversations/:id` into it. Effect order therefore cannot break it, and the empty
state (`AiAssistantPage.tsx:497-518`) renders only when `loadState === 'ready'`.

**Writers are bound to identity, not to key.** `runStream`'s thread writers (`setMessages`,
`setConversationId`, `commitToMessages`, `failLastMessage`) capture the *identity* of the
thread that started the stream and locate it by identity at dispatch (a ≤ 12-entry scan). So
a re-key is followed (the promotion moves the object; later writes still land on it), and a
thread that has since been replaced (New chat while its stream was running) **drops** the
write instead of landing an orphan turn in the fresh draft. Today they dispatch by key string
(`AiContext.tsx:418-462`), which is why this is stated. **The streaming buffer is not thread
state and cannot be bound**: `streamingContent`, `isStreaming` and `isThinking` are one
provider-wide value each (`use-streaming-content.ts:47-129`, `AiContext.tsx:472-479`), and
both renderers decide "this bubble is the in-flight answer" from `isStreaming && isLast`
(`AiAssistantPage.tsx:53-56`, `DockPanel.tsx:329`) — so switching to a retained conversation
mid-stream repaints *its* last answer with the other thread's partial text for at least one
frame. The context therefore exposes **`streamingThreadId: string | null`** (the identity
`runStream` captured; cleared in its `finally` beside `setIsStreaming(false)`), and
`MessageBubble` and `DockMessage` gate `isStreamingThis` and the typing indicator on
`streamingThreadId === activeThreadId`.

### `activeThreadId`

The context exposes `activeThreadId: string`. It is **the one thing every switch-sensitive
effect keys on**: the abort-on-switch effect (`AiContext.tsx:497-502`, today keyed on
`threadKey`), `DeepSearchToggle` (`modes/AskMode.tsx:77-79`, today `conversationId`),
`AssistantAttachmentsScope` (`AssistantAttachments.tsx:39-43`, today `pageId`), and the Ask
composer's `externalUrls`. Definition:

```ts
const activeThreadId = String(threads.get(threadKey)?.identity ?? threadKey);
```

— the filed identity, or the bare key for the one render before the entry is filed (two
unfiled keys therefore still differ). The active key is filed by the end of the first effect
flush after activation — by the filing effect or by a first write such as the `?q=` prefill,
whichever runs first, both through `seedFor` + `nextIdentity()` — so the key→identity
transition happens exactly once, at activation, before a person can type. It changes on
every switch and on nothing else. Contract, in tests:

- open a row → changes; New chat → changes (even on an empty draft); dock page change →
  changes; delete-of-active → changes;
- **typing in the composer, a `?q=` prefill, streaming, and the promotion after the first
  answer → unchanged** (staged attachments survive the first answer, as they do today on the
  no-page thread);
- an evicted `conv:` thread re-filed on open → changes (opening is a switch by definition).

### The state machine

Every transition below is pinned by a test in `AiContext.threads.test.tsx` (listed under
[PR 2](#pr-2--frontend)). "Switch" means the user changes which conversation is on screen; "re-key"
means the same thread object is filed under a new key. **A re-key is not a switch**: it must
not abort an in-flight stream, must not change `activeThreadId`, and must not clear composer
state — which the identity model gives for free.

| Trigger | Effect |
|---|---|
| **Ask on an AI-route thread with no `conversationId`** (`draft`, or a `conv:` thread whose id was cleared), final frame carries an id | Owner: `runStream`, immediately after `commitToMessages()` on the **normal** path only, guarded on **both** "the origin key is `draft` or `conv:*`" **and** "the origin thread had no id when the stream started". **A `page:` origin never promotes** — never re-keys, never navigates (the dock row below); `runStream` is shared by both surfaces, and without the key half of the guard the dock's first answer would re-key its thread out from under `/pages/:id` and teleport the user to `/ai`. **Promote**: re-key the origin object to `conv:<id>`; if the origin key was `draft`, file a fresh `seedFor('draft')` (new identity) under `draft`; if the origin key is still the active key, `navigate(conversationPath(id), { replace: true })` — replace, not push: Back returns to where the user came from, not to an empty draft (ChatGPT's convention). Then invalidate `['llm','conversations']`. An **aborted or errored first answer is never promoted**: its partial stays under the origin key with no id (decision 9), and the URL stays where it was. `onComplete`'s `StreamMeta` does not carry the id and `AskMode` is not the owner. |
| **Ask on `conv:<id>`** with the id | Same key; the frame's id equals `<id>`. If it does not (defensive), log and ignore. Invalidate the list (the row's `updated_at` moved it to the top). |
| **Ask on `page:<id>`** (dock) | As today: `setConversationId` on the page thread — the key is kept and nothing navigates, whether or not the thread had an id before. Invalidate the list (a dock ask creates or bumps a row). |
| **Open a row** | `navigate(conversationPath(id))` (push). The provider derives `conv:<id>` from the location; the read path yields `seedFor('conv:<id>')` (`loadState: 'loading'`) until the entry is filed with `nextIdentity()`, and the hydration effect fetches `GET /llm/conversations/:id` **into that key** — never into "the current thread". Back/Forward walk conversations for free. Opening **loads, never sends** (#1176) and sets `mode` to `'ask'`; it does **not** call `setModel`. Hydration also sets `historyTruncated` from the response. |
| **Load fails** | 404 or 400 → `toast.error('Conversation not found')` and `navigate(AI_HOME_PATH, { replace: true })`, removing the placeholder thread. Any other failure (network, 5xx) → the thread's `loadState = 'error'` with the curated `ApiError.message`; the page renders an in-pane error with **Retry** and the composer disabled. Redirecting on a network blip would lose a URL the user typed. |
| **New chat** | `startNewConversation()`: `abortRef.current?.abort()` explicitly (belt to the identity braces), file a fresh `seedFor('draft')` (new identity) under `draft`, `setMode('ask')` (a new chat is a question, and it is what puts `AskModeInput` on screen for the focus request — `mode` is provider-wide and the URL-mode effect at `AiContext.tsx:514-520` does not fire on a same-path navigation), `navigate(AI_HOME_PATH)` **only when the location is not already `/ai`** (push — Back returns to the conversation; react-router pushes even for a same-path `navigate`, so pressing New chat *n* times on `/ai` must not stack *n* dead entries), bump `composerFocusRequest`. Pressing it on an already-empty draft still files a fresh identity (so Deep Search and staged attachments clear — AC "new→new"), navigates nowhere, and sends nothing. |
| **Any switch** (open, New chat, dock page change, delete-of-active) | `activeThreadId` changes, so the abort effect fires; the in-flight stream's abort path commits its partial answer to the thread that started it if that thread still exists (located by identity), and drops it otherwise. |
| **Delete succeeds** (`purgeConversation(id)`) | Remove `conv:<id>` from the map; for every other retained thread whose `conversationId === id` (a `page:` thread on the page the conversation started from) set `conversationId: null` and keep its messages — its next ask starts a fresh row instead of 404-looping. If the deleted id is the open one, `navigate(AI_HOME_PATH, { replace: true })` (replace: the URL is dead and must not be one Back away). |
| **Ask returns 404 (stale id)** — the server refuses **before** streaming | Handled inside `runStream` before `onError` is consulted, so both surfaces get it: on `ApiError` with `statusCode === 404` and a `conversationId` in the body → `failLastMessage('This conversation no longer exists — your next question starts a new one.')` (the assistant placeholder becomes the error turn; the user turn stays; `isError` is never set on a `role: 'user'` message), clear the thread's `conversationId`, invalidate the list, no toast. **No re-key and no navigation**: the thread and its URL stay put — re-keying onto `draft` would clobber the incumbent draft, and the promotion rule above already gives the next ask a fresh row and a fresh URL. A reload of the dead URL is the "Load fails" row. Never auto-resend (#1176). |
| **Final frame carries `conversationId: null`** on a thread that had one (the append hit 0 rows — deleted mid-answer in another tab) | `StreamChunk.conversationId` widens to `string \| null` and `runStream` reads it with `'conversationId' in chunk && chunk.conversationId !== undefined` — **not** the truthiness guard at `AiContext.tsx:864-866`, which would swallow the `null`. Clear the id; the on-screen exchange stays, history does not get it, the deleted conversation is not resurrected, no navigation. |
| **A completed exchange on a thread with id `C`** | Also mirror the `(user, assistant)` pair (fresh message ids) into every **other** retained thread carrying `C` (the dock's `page:` thread and `conv:C` can both hold the same server row). Server history is the truth; a view of it that silently lags is what this prevents. Mirroring happens once, at commit, never mid-stream. |

### `AiContextValue` changes

Removed: `conversations`, `setConversations`, `loadConversation` (becomes route-driven and
internal), `deleteConversation` (the pane owns the mutation), the model reset in
`startNewConversation` (#355 AC-4 — the dropdown that made it necessary is gone).

Added:

```ts
activeThreadId: string;
streamingThreadId: string | null;              // identity of the thread whose answer is streaming
threadLoadState: 'ready' | 'loading' | 'error';
threadLoadError: string | null;
retryThreadLoad: () => void;
historyTruncated: boolean;
startNewConversation: () => void;              // semantics above
purgeConversation: (id: string) => void;       // semantics above
composerFocusRequest: number;                  // bumped by startNewConversation
```

`model` stays seeded from the chat default (`AiContext.tsx:618-635`) for the `!model` "no
provider configured" guards; nothing on `/ai` writes it any more.

## The conversation pane

Directory **`frontend/src/features/ai/conversations/`**:

| File | Responsibility |
|---|---|
| `AiConversationsSidebar.tsx` | Chassis: `<aside>` in both branches, resize handle, collapsed rail, `MainNavStrip` row, New chat, filter, mounts the list. |
| `ConversationList.tsx` | `<nav>` → recency groups → rows; roving focus; the three list states; Show more. |
| `ConversationRow.tsx` | One row: link, title, page chip, kebab, inline rename. |
| `ConversationRowMenu.tsx` | The kebab (`DropdownMenu`) with Rename / Delete and the delete `ConfirmDialog`. |
| `group-by-recency.ts` | Pure: `groupByRecency(items, now)` → ordered `{ label, items }[]`. |
| `use-conversation-list.ts` | `useInfiniteQuery` keyed `['llm', 'conversations', 'list']` over `GET /llm/conversations` (`getNextPageParam: page => page.nextCursor ?? undefined`; + pending-title polling, PR3). |
| `use-conversation-mutations.ts` | `useRenameConversation`, `useDeleteConversation` (+ invalidation, purge). |
| `frontend/src/shared/hooks/use-list-roving-focus.ts` | Flat vertical roving tabindex (see below). |

**Mounted by `AppLayout`** as the third arm of the sidebar ternary in **both** the desktop slot
(`AppLayout.tsx:551-560`) and the mobile drawer (`:532-534`), gated on `isAiRoute`. The two
slots keep their existing differences — the drawer passes `onNavigate`, the desktop slot passes
the tree's mid-width compaction props and no `onNavigate`:

```tsx
// mobile drawer (:532-534)
{isAiRoute ? <AiConversationsSidebar onNavigate={closeMobileSidebar} />
 : isSettingsRoute ? <SettingsSidebar onNavigate={closeMobileSidebar} />
 : <SidebarTreeView onNavigate={closeMobileSidebar} />}

// desktop slot (:551-560)
{isAiRoute ? <AiConversationsSidebar />
 : isSettingsRoute ? <SettingsSidebar />
 : <SidebarTreeView forceCollapsed={forceTreeCollapsed} onForceExpand={() => setMidWidthTreeExpandedOverride(true)} />}
```

The AI arm takes no `forceCollapsed`/`onForceExpand` — that compaction is for the article
inspector. The pane fetches its list with its **own** query and `AiContext` **deletes
the `useState` mirror** (`AiContext.tsx:403, 607-616`; ADR-009: server data lives in TanStack
Query). Because the pane mounts only on AI routes, `AppLayout.test.tsx`'s "issues no AI
requests on a route with no AI surface mounted" (`:678-693`) stays green by construction; a
new test renders `/ai` and asserts exactly one `/llm/conversations` request.

### Chassis

- `<aside aria-label="Conversations">` in **both** the expanded and the collapsed branch — copy
  `SidebarTreeView.tsx:794-802` / `:877-887`, **not** `SettingsSidebar`, whose collapsed
  branch is an unlabelled `<div>`.
- Shares `treeSidebarCollapsed` / `treeSidebarWidth` (`ui-store.ts`), so `,` and the persisted
  width carry across routes; carries the tree's resize handle recipe verbatim
  (`SidebarTreeView.tsx:1471-1499`: `role="separator"`, `aria-valuemin={180}`,
  `aria-valuemax={600}`, `aria-valuenow`, `aria-valuetext`, ←/→ ±16px, `Home` → 280,
  double-click → 280).
- Top row: `panel-toolbar flex h-12 shrink-0 items-center gap-1 border-b px-2` holding
  `MainNavStripExpanded` and the collapse button, exactly as `SidebarTreeView.tsx:894`. Add
  `['features/ai/conversations/AiConversationsSidebar.tsx', "the conversations rail's nav
  row"]` to `toolbar-rule-alignment.test.ts`'s `SELF_BORDERED`.
- Collapsed rail (40px): expand button (`PanelLeft`, "Expand sidebar (,)"),
  `MainNavStripCollapsed`, and **one** glyph — `SquarePen` "New chat" — which calls
  `startNewConversation()`. Never a Delete; never the list.
- Structure below the nav row, top to bottom: **New chat** (`nm-button-ghost`, full width, in a
  `px-2 py-2` block, `SquarePen` + "New chat", `data-testid="conversations-new-chat"`) → the
  **filter** (rendered only when the loaded row count exceeds `CONVERSATION_FILTER_THRESHOLD =
  8`, the tree's `SPACE_FILTER_THRESHOLD` precedent) → the scrolling `<nav>` → **Show more**.

### List semantics and keyboard

- `<nav aria-label="Conversation history" className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">`
  → one `<section>` per recency group with a `<h3 id className={SECTION_LABEL}>` heading and a
  `<ul role="list" aria-labelledby>` → `<li>` per row. **Export `SECTION_LABEL` from
  `SidebarTreeView`** and import it; do not copy the string (`SettingsSidebar` copied it and
  drifted to `/80`).
- Flat list, not a tree: no `role="tree"`. **One tab stop into the list, arrows travel.** New
  hook `useListRovingFocus({ ids, activeId, containerRef, itemAttr: 'data-row-id' })` returning
  `{ rovingId, handleRowFocus, handleRowKeyDown }` — the same contract shape as
  `useTreeRovingFocus`, the same tie-break (last explicit choice if still present, else the
  active id, else the first), and `ArrowUp`/`ArrowDown`/`Home`/`End`. The tree hook is over-fit
  for a flat list (expand/collapse, `parentId`, `data-page-id` hardcoded) and is left alone.
  `ids` is the visible order across all groups after filtering.
- **The `<li>` owns the row's `onKeyDown` / `onFocus`** (so keys pressed on the kebab, a
  sibling of the link, reach the same handler); the link carries only `tabIndex` and
  `data-row-id`. The handler ignores keydowns whose target is inside an open Radix layer —
  Radix portals content out of the DOM but not out of the React tree and replays events up it
  (the reason `useToolbarRovingFocus` guards with `root.contains(event.target)`), so an open
  row menu's arrows never move the list.
- **From a focused row:** `Enter` opens (it is a link); `ArrowRight` moves focus to the row's
  kebab; `ArrowLeft` on the kebab returns to the link; `Shift+F10` / `ContextMenu` opens the
  menu. `ArrowDown` **on the kebab** is Radix's (the Trigger opens on it) and is left to Radix.
  No `F2` / `Delete` bindings — the kebab is the path.
- The row is a **`NavLink`**, so the open conversation's row carries **`aria-current="page"`**
  and swaps to `nav-selection font-medium` from `isActive` — the `SettingsSidebar` mechanism
  (`SettingsSidebar.tsx:130-142`, pinned by `SettingsLayout.test.tsx:157-169`). The active
  recipe is the neutral pressed one; teal is reserved for actions.

### Row anatomy

`<li class="group/row relative flex h-7 items-center">` containing:

- the link — `<NavLink to={conversationPath(id)} title={title} data-row-id={id}
  tabIndex={rovingId === id ? 0 : -1} onClick={onNavigate}
  className={({ isActive }) => cn('flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-2 pr-7 text-[13px]
  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1
  focus-visible:ring-offset-background', isActive ? 'nav-selection font-medium'
  : 'text-muted-foreground hover:bg-[var(--glass-pill-hover)] hover:text-foreground')}>`
  — the focus ring is the tree row's (`SidebarTreeView.tsx:245`); this link is the list's
  single tab stop, so it must show focus. Inside: `<span className="min-w-0 flex-1
  truncate">{title}</span>` and, for a dock-origin row, the **page chip** — a `<span>` with
  `neutralChipClass` from `shared/components/badges/neutral-chip.ts` (already `text-[11px]`)
  plus `max-w-[45%] truncate`, `title={pageTitle}`, and an `sr-only` "Page: " prefix before
  the visible page title so the link's accessible name reads *"<title> Page: <page>"* (an
  `aria-label` on a plain span is prohibited naming and is ignored). A label, never a hue (a
  category, ADR-010). No per-row icon, no snippet, no timestamp — the group is the timestamp.
- the kebab — a **24×24** `<button>` (`size-6`; only the *geometry* is borrowed from the tree
  chevron, whose recipe deliberately has no focus indicator because it is `tabIndex={-1}` +
  `aria-hidden`; this control is announced and keyboard-reachable), absolutely positioned at
  `right-1`, ``aria-label={`Actions for ${title}`}`` (one identical object-less label on every
  row is the defect the tree chevrons were cured of), `tabIndex={-1}` (reached by
  `ArrowRight`), `MoreHorizontal` glyph, `rounded-md text-muted-foreground hover:bg-accent
  hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
  focus-visible:ring-offset-1 focus-visible:ring-offset-background`. `nm-icon-button` is not
  usable here: it hard-codes 2rem. Visibility: `opacity-0 group-hover/row:opacity-100
  group-focus-within/row:opacity-100 data-[state=open]:opacity-100
  [@media(hover:none)]:opacity-100`, plus `opacity-100` when the row is active. `opacity-0`
  keeps it focusable and `focus-within` reveals it the moment it is (WCAG 1.4.13 / 2.1.1);
  `data-[state=open]` is what keeps it visible while the (portalled) menu holds focus.

Rows navigate declaratively (`NavLink`) and call `onNavigate?.()` from `onClick` — every row,
the `SettingsSidebar` convention (`SettingsSidebar.tsx:132`), not the tree's
rely-on-pathname one.

### Kebab menu

Controlled `DropdownMenu.Root` per row (`open` state also drives the kebab's visibility while
open). `Content` **inside `DropdownMenu.Portal`** — as all six existing callsites do
(`UserMenu.tsx:29` et al.); un-portalled it renders inside the pane's `overflow-y-auto` nav
inside the chassis's `overflow-hidden` aside and is clipped for rows near the bottom —
`align="end" sideOffset={4} className="z-50 min-w-[160px] nm-card-elevated p-1"`, the one
shadow. Items: **Rename** (`Pencil`) and **Delete** (`Trash2`) as `DropdownMenu.Item`s with the
app's item recipe (`hover:bg-foreground/5 data-[highlighted]:bg-foreground/10 …`,
`UserMenu.tsx:45`); Delete carries `nm-action-destructive` (the inline destructive treatment;
`destructive-treatment.test.ts`'s ratchet must not rise — the utility, never
`text-destructive` + `hover:bg-destructive/NN` hand-rolled). **Extend the utility** with an
`&[data-highlighted]` branch mirroring its `&:hover` rule (`index.css:947-966`) — Radix's
keyboard highlight is `data-highlighted`, not `:hover`, and this is the utility's first use on
a `role="menuitem"`; one edit in one place keeps "one treatment". `onEscapeKeyDown` →
`absorbPortalEscape(event, close)`. Rename's `onSelect` sets the row into edit mode; the
menu's `onCloseAutoFocus` is `preventDefault`ed while a rename is pending, or Radix returns
focus to the trigger in the same tick the input takes it (the `EditorToolbar` trap).

### Inline rename

The link is replaced in place by ``<input className="nm-input h-6 w-full text-[13px]"
aria-label={`Rename ${title}`} value autoFocus>`` with the text selected; the row stays
28px. Behaviour:

- `Enter` → `preventDefault()`, commit; `Escape` → `preventDefault()` + `stopPropagation()`,
  cancel (a `cancelledRef` so the ensuing blur does not commit); blur → commit.
- Commit: trim; empty or unchanged → cancel silently; else `PATCH /llm/conversations/:id
  { title }`; on success exit edit mode and invalidate the list; on failure `toast.error` and
  stay in edit mode.
- **The field is never inside `role="menu"`** (typeahead swallows keystrokes) — it lives in the
  row after the menu has closed. There is no portal, so `absorbPortalEscape` does not apply;
  the input's own handler makes the same two calls so the keystroke never reaches
  `use-keyboard-shortcuts` (which would blur the field — its bare-Escape rule yields on
  `defaultPrevented`, #1206) nor any other `document` listener.
- After commit or cancel, focus returns to the row link.

### Delete

Kebab **Delete** → `ConfirmDialog` (`destructive`, title *Delete conversation?*, description
*"<title>" will be permanently deleted. This can't be undone.*, `confirmLabel="Delete"`) →
`useDeleteConversation` → `DELETE /llm/conversations/:id` → on success `purgeConversation(id)`
(navigates to `/ai` if it was the open one), invalidate the list, `toast.success`. No undo
(decision 8). The dialog's Cancel and Escape do nothing.

### Recency groups

`groupByRecency(items, now)` buckets by `updatedAt` against the viewer's **local** calendar:
**Today** (≥ start of today) · **Yesterday** · **Previous 7 days** (≥ start of today − 7d) ·
**Previous 30 days** (≥ start of today − 30d) · then one group per calendar month, labelled
by `Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' })`, newest first. Empty
buckets are omitted. Items arrive sorted `updated_at DESC` and the function preserves order,
so grouping is a single pass. Tested with a fixed `now` and a fixed time zone.

### Filter and Show more

- Filter: `<input aria-label="Filter conversations" placeholder="Filter conversations">`, plain
  local state; case-insensitive substring over `title` only; applied before grouping; groups
  with no match disappear; no match at all → one muted line *No matching conversations*.
  Two-stage `Escape` (clear text, then blur — the space-dropdown precedent,
  `SidebarTreeView.tsx:948-990`). Resets when the pane collapses.
- **Show more**: `nm-button-ghost` full width after the last group, `hasNextPage` only,
  "Loading…" while fetching, `data-testid="conversations-show-more"`. Explicit paging, not
  infinite scroll: a button is reachable and announces itself. It stays available while a
  filter is active (it loads more rows *into* the filter).

### The three list states

Consume `isError` — a failed fetch is a failure, not an empty history (the tree learned this).

| State | Rendering |
|---|---|
| Failed with nothing cached | `role="alert"`, `AlertTriangle` (`text-destructive`), *Couldn't load conversations*, the curated `ApiError.message` or *The request did not complete.*, **Try again**. Copy the tree's block (`SidebarTreeView.tsx:1359-1396`). |
| Failed with cache | Amber `role="status"` strip above an intact list: *Showing the last loaded conversations* + **Retry** (`:1319-1339`). Red is failure, amber is degraded. |
| Genuinely empty | One muted line, no card, no illustration: *Your conversations will appear here. Only Q&A is saved.* — the second sentence is decision 4 made visible. |
| Loading (first time) | Eight `h-7` pulses (`:1349-1358`). |

### Mobile

Same component in the drawer (`AppLayout.tsx:512-534`); every row and New chat call
`onNavigate` so the drawer closes on the tap, not only on the pathname effect (`:336-338`).
The 320px drawer means rows truncate — the `title` attribute is the recovery path. **`/ai`'s
sub-header carries a New chat control** in its free `flex-1` slot (`AiAssistantPage.tsx:298`):
`nm-button-ghost`, `SquarePen` + "New chat", `data-testid="ai-new-chat"`, rendered at every
width (see [Architect's calls](#architects-calls-flagged-for-the-owner)).

### Invalidation

`['llm','conversations']` is invalidated on **every event that changes a row or its
position**: every completed ask on a thread that carries or acquires a `conversationId`
(promotion on `/ai`, every dock ask, every follow-up on `conv:<id>` — `updated_at` moves the
row to the top), the stale-404 recovery (the row is gone elsewhere), rename, delete, and —
PR3 — by **pending-title polling**:
`use-conversation-list.ts` sets `refetchInterval` to `3000` while any loaded row has
`titleSource === 'question'` and `createdAt` within the last 60 s, else `false`. It is
self-terminating, pauses in a hidden tab (TanStack default), and costs at most twenty
requests per new conversation. A one-shot timer would race the model's latency.

## `/ai` page changes

- **The Pages tree leaves `/ai`.** Delete the `isAiRoute` prop and every branch keyed on it in
  `SidebarTreeView.tsx` (`:160, :181, :200-207, :382, :399, :444-452, :512, :1149-1154,
  :1431, :1451`) and `DndLocalSpaceTree.tsx` (`:19, :35, :48, :107-114, :268, :285, :298,
  :339`) — both trees move together. There are exactly three producers of `/ai?pageId=`
  (two in `SidebarTreeView`, one in `DndLocalSpaceTree`); all three go. On `/ai`, page
  navigation is the command palette and the Pages tab of `MainNavStrip`.
- **Page scope retired on `/ai`.** Delete the context chip (`AiAssistantPage.tsx:343-359`) and
  `+ Sub-pages` (`:361-381`). The Ask body sends `pageId` / `includeSubPages` only when a page
  is resolved (i.e. from the dock). `AiContext.threads.test.tsx:196-209` (the
  `/ai?pageId=x ↔ /pages/x` shared-thread contract) is deleted deliberately.
- **Action selector on `/ai` offers Q&A + Generate.** `AssistantActionSelect` gains an
  `actions: readonly AssistantAction[]` allow-list prop replacing `includeGenerate`;
  `AI_HOME_ACTIONS = ['ask', 'generate']` and `DOCK_ACTIONS = ['ask', …IMPROVEMENT_TYPES,
  'diagram']` live with the `AssistantAction` type in a new **leaf module
  `features/ai/assistant-actions.ts`** (the `improvement-types.ts` pattern) — not in
  `AssistantActionSelect.tsx`, which imports from `AiContext` and would close an import cycle
  the moment `AiContext` read the list. A `?mode=improve|diagram` deep
  link on `/ai` falls back to Q&A: `AiContext`'s URL-mode parser (`AiContext.tsx:361,
  514-520`) accepts, on an AI route, only a mode that `AI_HOME_ACTIONS` maps to (`ask` |
  `generate`) — the retired `summarize` / `quality` values already fall back the same way.
  #1318's shared draft is unaffected.
- **The model `<select>` goes** (`AiAssistantPage.tsx:320-334`) with its loading/retry states;
  `modelsError` / `refetchModels` stay for the dock. Delete #355 AC-4's model reset and its
  test (`AiAssistantPage.test.tsx:2230-2296`).
- **History note.** When `historyTruncated` is true for the active thread, a muted line
  directly above the composer — `text-[11px] text-muted-foreground`, **not** a live region —
  reads *Older messages in this conversation are no longer sent to the model.* Rendered by
  `AskModeInput` **and** `DockPanel` (both post `/llm/ask`; the same mechanism on one of two
  surfaces is the divergence CLAUDE.md's refusal note warns about). The flag is set from
  **two** sources or the note is invisible in the case decision 10 exists for: each ask's
  final frame (`historyTruncated` absent ⇒ `false`), and `GET /llm/conversations/:id` on
  reopen, which runs the same budget walk over the stored messages — a 60-turn conversation
  says so the moment it opens, not after the next question has already been clipped.
- **Loading and error states** for a `conv:` thread: `role="status"` *Loading conversation…*
  in the message pane and Send disabled while `threadLoadState === 'loading'`; the tree's
  destructive block with **Retry** when `'error'`.
- **Composer focus.** `AskModeInput` focuses its textarea whenever `composerFocusRequest`
  changes — New chat lands the caret where the next question goes (the #1176 dock
  convention). Opening a row does **not** move focus: a keyboard user is mid-list and
  `aria-current` tells them where they are.
- The empty state on `/ai` (draft) is unchanged.
- **Reopened answers render as live ones**: `loadConversation` maps `refused` → `isRefusal`,
  `sources` → `sources`; `MessageBubble` then shows `CitationChips`, `SourceCitations` and the
  `ConfidenceBadge` (computed from `averageSourceSimilarity`, so no separate confidence is
  persisted) and still suppresses the badge on a refusal (#1119). A source with `unavailable:
  true` resolves to `{ kind: 'none' }` in `resolveSourceTarget` and renders inert with
  `title="This page is no longer available to you"`.
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

## Backend

### Save path (`routes/llm/llm-ask.ts`)

1. **Stale id → 404, early.** At the history load (`:169-181`): if the body carries
   `conversationId` and `SELECT … WHERE id = $1 AND user_id = $2` returns no row, throw
   `fastify.httpErrors.notFound('Conversation not found')` before retrieval and before any SSE
   header. Foreign ids get the same 404 (do not reveal existence). `streamSSE` already throws
   `ApiError(res.status, message)` on a pre-stream non-2xx (`shared/lib/sse.ts:43-47`), so
   `runStream`'s error path can branch on `statusCode === 404`.
2. **Write page scope at INSERT.**
   ```sql
   INSERT INTO llm_conversations (user_id, model, title, messages, page_ref)
   VALUES ($1, $2, $3, $4::jsonb, $5)
   RETURNING id
   ```
   `$5` is the **resolved internal id, authorised**: `resolvePageRef(body.pageId)`
   (`_helpers.ts:63-84` — internal id first, then `confluence_id`, guarded by
   `SAFE_INT4_DIGITS` because a Confluence id parsed as an integer overflows int4 and would
   turn a finished answer into `Stream error`) and then `userCanAccessPage(userId,
   resolved.id)` (today called only inside the `includeSubPages` branch, `:274-280`); anything
   unresolved or unauthorised stores `NULL`. Resolution runs on the INSERT path only (reuse the
   value when the `includeSubPages` branch already resolved it). Never a hand-parsed integer:
   the body `pageId` is `z.string()` and the route's own contract admits both id spaces.
   `messages` stays `$4` so `llm-ask.test.ts`'s positional assertions (`insert[1][3]`) keep
   their index.
3. **Atomic append instead of read-modify-write.**
   ```sql
   UPDATE llm_conversations
      SET messages = messages || $3::jsonb, updated_at = NOW()
    WHERE id = $1 AND user_id = $2
   RETURNING id
   ```
   `$3` is the JSON array of the two new turns. Two tabs asking concurrently interleave at
   pair granularity, so history stays well-formed. `saveConversation` returns
   `{ id, inserted }`; when the UPDATE returns no row the final frame carries
   `conversationId: null` (the row was deleted mid-answer; the exchange is not resurrected).
4. **Persist sources per assistant turn on all three save paths** — stream (`:781`), cache
   hit (`:708`), refusal (`:678`). `StoredChatMessage` becomes
   `ChatMessage & { refused?: boolean; sources?: PersistedSource[] }` where `PersistedSource`
   is the wire `Source` allow-listed to `{ pageTitle, spaceKey, pageId, confluenceId, url,
   sectionTitle, similarity }` (drop the deprecated `score`; order is the array), **with
   `pageId: 0` — the wire's "not a knowledge-base page" sentinel for external-doc and web
   sources (`llm-ask.ts:476, :486`; `SourceCitations.tsx:18-22`) — omitted rather than
   copied**, so the persisted shape satisfies `SourceSchema.pageId: positive()`. This spec
   predates #1115 P3, which landed on `dev` after it was written: the allow-list also
   carries `kind: 'image'` + `attachmentUrl` for an image source — both, or, when the URL is
   empty or outside the attachment routes (`ATTACHMENT_URL_PATTERN` in contracts, the pattern
   both runtime gates import), the entry is dropped entirely because its page is already
   carried by the page-shaped entry for the same result — so a reopened answer renders the
   same thumbnails the live one did; `similarity` on that shape stays `null` regardless (the
   cross-modal band, ADR-025 §8); the frontend's `isImageSource` imports the same pattern, so
   the persist gate and the last gate before `<img>` are one definition. The
   persisted *prose* is unchanged: `llm-ask.test.ts:722-744` and `:496-523` keep asserting
   the persisted refusal text does not say "listed below" / "attached as sources" — the
   sources are now structured data beside it, and the frontend's `RefusalSourcesLabel`
   supplies the heading. Both tests gain an assertion that `sources` is present on the
   assistant turn.
5. **History replay is bounded (decision 10).** New `HISTORY_REPLAY_TOKEN_BUDGET = 4_000`
   (a plain exported constant beside `MAX_DOCUMENT_TEXT_FOR_LLM`; not an env var). After the
   existing `refused` filter (`:740`), walk the history from the newest turn backwards in
   **whole exchanges**, accumulating `estimateTokens(content)`; stop before the exchange that
   would exceed the budget; drop everything older. **Pairing is by role, not by index
   stride**: an `assistant` turn and the nearest preceding `user` turn are one exchange; a
   `user` turn with no assistant turn after it — what a refused exchange leaves behind, since
   `refused` sits on the assistant half only (`:501-507`) — is dropped unconditionally and
   never counted (some providers reject consecutive same-role messages; the honest-refusal
   gate's history exemption never counted it either). The current question is never counted
   or dropped. Sources are stripped before replay (only `{ role, content }` reach the
   provider). The walk is a pure function, `selectReplayableHistory(messages)` in
   `domains/llm/services/history-budget.ts`, returning `{ replay, truncated }`, so `GET :id`
   can run it too. The stream-path final frame carries `historyTruncated: true` when ≥ 1 turn
   was dropped (absent ⇒ false; the cache-hit path only runs on an empty history and the
   refusal path runs no completion). ~4 chars per token is a rough estimator and the constant
   is conservative for 8k-context local models sitting beside retrieved context; a follow-up
   may derive it from the provider's window.
6. **Initial title** = `initialTitleFromQuestion(question)`: collapse whitespace; ≤ 80 chars
   as-is; else cut at 80 and back off to the last whitespace at ≥ 40, strip trailing
   `,;:.!?…-`, append `…`. Pure, tested, in
   `domains/llm/services/conversation-title.ts`.
7. **Auto-title (decision 5, PR3).** On **each of the three save paths**, immediately after
   the response's terminal frame — after `sendCachedSSE(…)` returns on the refusal (`:678`)
   and cache-hit (`:708`) paths (it writes both frames and `end()`s, `_helpers.ts:201-221`),
   and after the hand-written final frame on the stream path (`:801-806`) — and only when
   `saveConversation` reported `inserted`: `void generateConversationTitle({ conversationId,
   userId, question, answer, refused })` — the `emitLlmAudit` fire-and-forget idiom
   (`llm-audit-hook.ts:100`), `try/catch` inside, `logger.warn` on failure, never awaited,
   never delaying the frame. The cache-hit path is the one insert path with a good answer in
   hand and is not skipped.
   Inside: `resolveUsecase('chat')` (no eighth ADR-021 use case — the #1112 argument), inputs
   through `sanitizeLlmInput` (question capped at 1,000 chars, answer at 1,500; the answer is
   omitted when `refused`), `chat(config, model, messages, { maxTokens: 32, timeoutMs:
   20_000 })` — the `reformulateQuery` template (`multi-query-search.ts:303-333`), with a
   longer timeout because nothing waits on it. Prompt:

   > *You write titles for chat conversations. Reply with only the title: at most eight
   > words, one line, no quotes, no markdown, no trailing punctuation, in the language of
   > the question.*

   `normalizeGeneratedTitle(raw)`: first non-empty line; strip surrounding quotes, markdown
   emphasis, a leading `Title:`; collapse whitespace; strip trailing punctuation; cap at 80
   on a word boundary; return `null` if empty. Then the CAS write:
   ```sql
   UPDATE llm_conversations SET title = $3, title_source = 'generated'
    WHERE id = $1 AND user_id = $2 AND title_source = 'question'
   ```
   so a rename that landed in between is never overwritten. Every failure — timeout, open
   breaker, unparseable, empty — leaves the word-boundary fallback in place. Applies to dock
   conversations too. **Not audited** as its own `llm_audit_log` row: it follows #1112's
   reformulation call, which is likewise a side-completion of an audited ask (see Architect's
   calls).

### Read side (`routes/llm/llm-conversations.ts`)

All routes stay `fastify.authenticate` only — history is the user's own data and reading or
deleting it is not model consumption; a user stripped of `llm:query` keeps read/rename/delete
of what they already have and cannot append (the ask route is gated). Recorded as a decision,
not an omission.

- `ConversationIdParamSchema = z.object({ id: z.string().uuid() })` for `:id` routes — a
  malformed id is a 400 (Zod), never a `22P02` 500.
- **`GET /llm/conversations?limit&cursor`** — keyset pagination:
  ```sql
  SELECT c.id, COALESCE(NULLIF(trim(c.title), ''), 'Untitled conversation') AS title,
         c.title_source, c.model, c.page_ref, p.title AS page_title, c.created_at, c.updated_at
    FROM llm_conversations c
    LEFT JOIN pages p ON p.id = c.page_ref AND p.deleted_at IS NULL
   WHERE c.user_id = $1
     AND ($2::timestamptz IS NULL OR (c.updated_at, c.id) < ($2::timestamptz, $3::uuid))
   ORDER BY c.updated_at DESC, c.id DESC
   LIMIT $4
  ```
  fetch `limit + 1`; if more, `nextCursor = base64url(JSON.stringify([updatedAtISO, id]))` of
  the last returned row, else `null`. A malformed cursor is a 400. The handler emits
  `created_at.toISOString()` / `updated_at.toISOString()` (the same string the cursor is built
  from; today's handlers return raw `Date`s, `llm-conversations.ts:25-31`, which the contract's
  `z.string()` would reject in a round-trip test). `p.deleted_at IS NULL` is on the join
  because pages are soft-deleted (`029_standalone_columns.sql`) and `ON DELETE SET NULL` fires
  only on a hard delete — a trashed page yields no chip. No visibility predicate on this join:
  `page_ref` was authorised at write time (Save path 2), and the row records where the user
  started a conversation they were allowed to have; a later ACL revocation hides the page,
  not the memory of it. House style is
  page/limit offset (`admin.ts:62-77`); keyset is chosen because this list is **prepended-to
  on every ask** (`updated_at` bumps), so an offset page shifts under the reader and
  duplicates or skips rows — the one case where the extra pattern earns its keep. Rename
  does not bump `updated_at`, so paging is stable through it.
- **`GET /llm/conversations/:id`** returns the summary columns plus `messages` (with `refused`
  and `sources`), plus **`historyTruncated`** from `selectReplayableHistory(messages).truncated`,
  and **annotates sources**: collect every positive `pageId` across the turns (a source with
  no `pageId` — external doc, web hit — is never annotated) and run one query for the subset
  the caller can see *now* — the retrieval path's own predicate,
  `visiblePagesPredicate(spacesIdx, userIdx)` from `core/services/page-visibility.ts` bound
  with `getUserAccessibleSpacesMemoized(userId)` (`rbac-service.ts:344`, the request-scoped
  variant), plus `deleted_at IS NULL`, exactly as `rag-service.ts:355-356` applies it — and
  set `unavailable: true` on any source whose page is not in the result:
  ```sql
  SELECT cp.id FROM pages cp
   WHERE cp.id = ANY($3::int[]) AND ${visiblePagesPredicate(1, 2)} AND cp.deleted_at IS NULL
  ```
  Annotation is read-time only; nothing is written back. Test consequence (PR 1):
  `llm-conversations.test.ts` mocks `redis-cache.js` with only `RedisCache`
  (`:8-21`) and `rbac-service` imports `getRedisClient` from it, so the mock gains
  `getRedisClient: () => null` and `rbac-service.js` is mocked for
  `getUserAccessibleSpacesMemoized` — the annotation query is then the only new ordered
  `mockQuery` call the file has to account for.
- **`PATCH /llm/conversations/:id { title }`** — `UpdateConversationSchema`
  (`title: z.string().trim().min(1).max(200)`);
  `UPDATE … SET title = $3, title_source = 'user' WHERE id = $1 AND user_id = $2 RETURNING …`;
  0 rows → 404. **No `updated_at` bump** (it would re-bucket the row into Today). Returns the
  updated summary.
- **`DELETE`** stays idempotent (`{ message }` on 0 rows too): a row deleted in another tab must
  not error this one; the list refetch reconciles.

### Migration and contracts

**One migration** at the next free number on `dev` at branch time (`094` as of 2026-08-17;
verify with `git ls-tree origin/dev backend/src/core/db/migrations/` — parallel branches
collide; `migration-filenames.test.ts` fails on a shared prefix):

```sql
-- 094_llm_conversations_history.sql
ALTER TABLE llm_conversations DROP COLUMN page_id;                       -- TEXT, never written
ALTER TABLE llm_conversations
  ADD COLUMN page_ref INTEGER REFERENCES pages(id) ON DELETE SET NULL,   -- house style: INTEGER FK
  ADD COLUMN title_source TEXT NOT NULL DEFAULT 'question'
    CHECK (title_source IN ('question', 'generated', 'user'));
CREATE INDEX IF NOT EXISTS llm_conversations_user_updated_idx
  ON llm_conversations (user_id, updated_at DESC, id DESC);
```

`page_ref` rather than repurposing `page_id`: every other page-linking column in the schema
is `INTEGER REFERENCES pages(id)`; `page_id TEXT` was the odd one out, has never been written
(the INSERT names four columns), and `SET NULL` matches `notifications.source_page_id` — a
deleted page must not delete history. Before the drop, grep `compendiq-enterprise` for
`llm_conversations`; nothing there should read the column, and this is where you find out.
`title` stays nullable in the DB (`COALESCE(NULLIF(trim(…), ''))` on read — the reachable
degenerate value is `''` from a whitespace-only question, not `NULL`) so the migration cannot fail on a
legacy null. `migrations.test.ts`'s `llm_conversations table schema` block gains assertions
for the two columns and the index. `06-data-model.md` and ADR-006 gain the new snapshot.

`packages/contracts/src/schemas/llm.ts` — replace the dead `ConversationSchema` with:

```ts
export const TITLE_SOURCES = ['question', 'generated', 'user'] as const;
export const TitleSourceSchema = z.enum(TITLE_SOURCES);

export const SourceSchema = z.object({
  pageTitle: z.string(),
  spaceKey: z.string().nullable().optional(),
  pageId: z.number().int().positive().optional(),
  confluenceId: z.string().nullable().optional(),
  url: z.string().optional(),
  sectionTitle: z.string().optional(),
  similarity: z.number().nullable().optional(),
  unavailable: z.literal(true).optional(),      // read-time annotation, never stored
});

export const StoredChatMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
  refused: z.boolean().optional(),
  sources: z.array(SourceSchema).optional(),
});

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
export const ConversationDetailSchema = ConversationSummarySchema.extend({
  messages: z.array(StoredChatMessageSchema),
  historyTruncated: z.boolean(),               // selectReplayableHistory(messages).truncated
});
export const ConversationListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(200).optional(),
});
export const ConversationListResponseSchema = z.object({
  items: z.array(ConversationSummarySchema),
  nextCursor: z.string().nullable(),
});
export const UpdateConversationSchema = z.object({ title: z.string().trim().min(1).max(200) });
export const ConversationIdParamSchema = z.object({ id: z.string().uuid() });
```

The frontend imports `ConversationSummary` / `ConversationDetail` (its private
`Conversation` interface, `AiContext.tsx:46-51`, is deleted) and keeps its `Source`
interface, with a type-level test asserting `z.infer<typeof SourceSchema>` is assignable to
it. `StreamChunk` (frontend) gains `historyTruncated?: boolean` and widens `conversationId` to
`string | null`. Rebuild `packages/contracts` before either workspace sees the change
(gitignored `dist/`); a contracts round-trip test uses a fixture with an external-doc source
(no `pageId`) beside a KB source, the live wire shape.

## Accessibility

- Landmarks: `<aside aria-label="Conversations">` in both branches; `<nav aria-label="Conversation
  history">`; group headings via `aria-labelledby`.
- One tab stop into the list; arrows travel; the kebab is reachable from the row; the active
  row is `aria-current="page"`.
- Every operable surface keeps its 1px `--color-border-interactive` (WCAG 1.4.11) or is an
  `nm-*` utility that does; the kebab is 24×24 (2.5.8). The resize handle is inherited as-is
  and is 8px wide (`w-2`, `SidebarTreeView.tsx:1487`) — pre-existing, tracked separately.
- Row titles carry `title`; the filter, kebab and rename input carry `aria-label`s.
- Nothing here is a live region except the two failure/degraded strips (`role="alert"`,
  `role="status"`) and the load status; the history note and the filter's "no match" line
  are deliberately not.
- `prefers-reduced-motion` and `forced-colors` are inherited from the chassis recipes.

## Scope

**In scope** — the three PRs below.

**Untouched** — the dock's page-keyed thread model, its eight actions and its chips; `Apply`
via `POST /llm/improvements/apply`; the `/pages/:id` tree; #1218's scroll chain (the pane is
a sibling of `<main>`, outside the chain).

**Anti-goals** — no page picker on `/ai`; no persistence of Generate / rewrite / Diagram
turns; no pin, archive, full-text search, soft delete or retention; no history inside the
dock; no `g a` that resumes the last conversation (`/ai` is the draft; the list is one click
away). All are follow-ups the issue already lists.

## Sequencing

Three PRs, squash-merged, **not stacked** (stacked PRs get no CI in this repo). Land 1 before
2; 3 after 2 (it changes the pane's polling).

### PR 1 — backend and contracts (no UI change)

Migration 094; contracts above; `.uuid()` id params; `page_ref` at INSERT (`resolvePageRef` +
`userCanAccessPage`);
sources persisted on all three paths (`PersistedSource` allow-list); atomic append with
`RETURNING`; stale-id 404 before streaming; `initialTitleFromQuestion`; history replay budget +
`historyTruncated`; `GET` list with keyset pagination + `pageTitle` + `titleSource`;
`GET :id` with `updatedAt`, `pageId`, `pageTitle`, `titleSource`, `sources`, `unavailable`
annotation and `historyTruncated`; `PATCH`; `DELETE` unchanged in behaviour but under the uuid
schema; `selectReplayableHistory` in `domains/llm/services/history-budget.ts`. **PATCH already
writes `title_source = 'user'`** so a rename made before PR 3 ships is respected by the
generator when it arrives.

Tests: `llm-ask.test.ts` — INSERT params (`page_ref` at `$5` is the resolved id, `NULL` for a
Confluence-length id, an unknown page and an unauthorised page; trimmed title at `$3`),
sources present on stream/cache/refusal turns while the refusal prose assertions stay and an
external-doc source persists without `pageId`, atomic append SQL (`messages || $3::jsonb`)
and `conversationId: null` on 0 rows, stale id → 404 before any `hybridSearch` call and
before any SSE header, `historyTruncated` on the final frame. `history-budget.test.ts` — drops
whole exchanges oldest-first, never the current turn, **a history containing a refused
exchange** (the orphan user turn is dropped and not counted, pairing stays aligned), and an
under-budget history reports `truncated: false`. `llm-conversations.test.ts` — list
SQL/columns incl. `p.deleted_at IS NULL` and ISO timestamps, cursor round-trip and 400 on
garbage, `GET :id` returns `historyTruncated` and marks an invisible page's source
`unavailable` (with the `redis-cache` / `rbac-service` mocks above), PATCH
happy/404/validation and no `updated_at` in its SQL, `.uuid()` → 400.
`conversation-title.test.ts` — word-boundary trim cases. `migrations.test.ts` — columns +
index. Contracts round-trip tests. Docs: 09-flow-rag-chat (the sequence step at `:115`
becomes true and reads *append … (atomic)*; the "sources are never persisted" paragraph at
`:190-196` is rewritten; the refused-marker parenthetical at `:791` — the issue's `:809-812`
drifted; the `resolveSourceTarget` justification at `:1516-1523` — the issue's `:1245-1247`
drifted — whose "sources are not persisted" premise becomes false while its rule still holds
on its other ground, that `/llm/ask` has always emitted `pageId` on KB hits; the same
sentence as a code comment at `frontend/src/features/ai/source-target.ts:45`; add a
*Conversation persistence (#1361)* subsection),
06-data-model ERD at `:131-139` (issue said `:115-123`), ADR-006 new snapshot after `:498-508`
(and annotate the two aspirational comments at `:502`/`:504`), ADR-021 `### #1361` note
(there is no `#1112` section to mirror — the argument lives in CLAUDE.md and 09; follow
`### #1104`'s structure).

### PR 2 — frontend

`ai-routes.ts` + the `/ai/c/:conversationId` route; thread keys `draft` / `conv:<id>`, the
state machine, `activeThreadId`, `purgeConversation`, load states, the mirror rule; the pane
(all files above) in both `AppLayout` slots; tree/`isAiRoute` removal in both tree files;
`/ai` simplification (chip, `+ Sub-pages`, model select, `AI_HOME_ACTIONS`, sub-header New
chat, history note in both composers, reopened sources); the frontend consuming
`ConversationSummary` / `ConversationDetail`; docs.

Tests — **delete**: both `#417` tests in `SidebarTreeView.test.tsx` (`:364-375` — the second,
*highlights the article matching ?pageId on the AI route*, breaks with the `activePageId`
`/ai` branch at `SidebarTreeView.tsx:444-452`) and **every** `isAiRoute` occurrence in that
file (26, through `:2052`, including the `#960` comparator test at `:1247` — the issue's
`:1203-1285` covers eleven of them); `AiAssistantPage.test.tsx:433-437` (the "no conversations sidebar" pin — the
shell owns it now) and `:394-415` (context chip); `AiContext.threads.test.tsx:196-209`;
the #355 AC-4 model-reset test; `modes/AskMode.test.tsx:783-791` `ConversationSwitcher` stub
(replaced by real `startNewConversation` / route switches). **Update**:
`AppLayout.test.tsx:291-322` (`/ai` leg asserts `ai-conversations-sidebar` present and the
tree absent, mirroring `/settings`; add a mobile `/ai` drawer case that selects a row and
closes); `AiContext.threads.test.tsx:335-346` — keep the mode-reset assertion, **delete** the
`context-page` assertion at `:344` and its comment (a legacy `?pageId=` on an AI route now
resolves to no document); `modes/AskMode.test.tsx:920-937` (reset keys on `activeThreadId`; add the
new→new cell and an attachments-clear cell); `DndLocalSpaceTree.test.tsx` (prop removal);
`toolbar-rule-alignment.test.ts` `SELF_BORDERED`; `PageTransition.test.tsx`. **Add**:
`ai-routes.test.ts`; `AiContext.threads.test.tsx` cells for every row of the state-machine
table (promotion re-keys and replaces the URL only while draft is active; a stopped first
answer leaves `/ai` and is not promoted; open fetches into `conv:<id>`; unknown id → toast +
`/ai`; network error → error state, no redirect; Back/Forward walk two conversations; delete
purges a `page:` thread's id; stale 404 clears the id and stays on its URL, then the next ask
promotes to the new id — with a **non-empty draft that survives untouched**; a final frame
with `conversationId: null` clears the id, keeps the messages, does not navigate;
**typing, a `?q=` prefill and the promotion leave `activeThreadId` unchanged**; New chat on
`/ai` while a stream is running aborts it and the aborted commit does **not** land in the
fresh draft; an evicted `conv:` thread reopened is a switch; **a dock ask on a fresh `page:`
thread sets the id, keeps the key and does not navigate**; **`/ai/c/X?q=hi` still hydrates
and shows the loading state, never the Ask empty state**; opening a retained conversation
while a question is in flight leaves that conversation's last answer intact
(`streamingThreadId`); two New chats on `/ai` add one history entry, not two; New chat from
Generate lands on the Ask composer with focus; the mirror rule); pane tests (groups with fixed `now`, `aria-current`, `title` on every row, no
per-row icon, page chip only on dock-origin rows, kebab visible on `focus-within` and always on
the active row, `ArrowRight` reaches the kebab, inline rename Enter/Escape/blur incl. that
Escape does not reach a `document` shortcut listener, delete confirm → DELETE → purge →
navigate, the three list states, filter past 8 + two-stage Escape + reset on collapse, Show
more pages the server, `<aside>` in both branches, resize/`,`, exactly one `/llm/conversations`
request on `/ai` and none on `/pages/:id`); `AssistantActionSelect` allow-list on `/ai` (Q&A +
Generate exactly; `?mode=improve` → Q&A); `/ai` sub-header New chat; history note appears on
`historyTruncated` in both composers and is not a live region; `use-list-roving-focus.test.ts`.
Guards: `ui-text-legibility` (12px uppercase floor), `flat-components`, `destructive-treatment`
(ratchet ≤ 21), `focus-ring-contrast`, `workspace-themes`, `ai-scroll-chain`.

Docs (same PR): `04-frontend-structure.md` `:27` (fAI node gains the pane + route), `:33`
(AppLayout node: dock threads keyed by page, `/ai` threads by conversation), `:129-138`
(rewrite — no tree clears a mode; the allow-list is what makes `?mode=improve` fall back);
`09-flow-rag-chat.md` `:391-397` (deep-search switch keys on `activeThreadId`, not "the
sidebar"); the docked-AI spec — a second dated amendment block and status *two elements
superseded*, with its own affected-files list, not edits to `:242-249`; `CLAUDE.md` `:60`
(same rewording), `:339` (the pane shares the rail contract), `:379` (the two surfaces offer
different action sets), plus the new paragraph for the pane and the per-conversation URL;
`MainNavStrip.tsx:6-15`; `docs/USER-GUIDE.md:112` (name the mechanism);
`docs/architecture/README.md` — add a row for "a new route inside an existing feature or a
provider's data model changing" → `04-frontend-structure.md`.

### PR 3 — auto-title

`generateConversationTitle` + `normalizeGeneratedTitle` in `conversation-title.ts`; the
fire-and-forget call after the terminal frame on each of the three save paths when the save
inserted; the pending-title polling in `use-conversation-list.ts`. Tests: soft-fail on timeout / open breaker / garbage / empty
(title unchanged, no throw, no delay to the final frame — assert the frame is written before
`chat` resolves); CAS write (`title_source = 'question'` in the WHERE, and a row already
`'user'` is untouched); normalisation cases; the refused path titles from the question alone;
**the cache-hit path titles too**; the poll stops once `titleSource` flips or 60 s pass. Docs: the ADR-021 note and the 09
subsection gain the generation paragraph.

## Architect's calls, flagged for the owner

None of these block the PRs; each follows from a decision in the issue and is stated so it can
be reversed cheaply if the owner disagrees.

1. **Continuing a dock-origin conversation from `/ai` is corpus-wide.** Decision 2 retires page
   scope on `/ai`; decision 3 lists dock chats. Opening one on `/ai/c/:id` and asking a
   follow-up sends no `pageId`, so retrieval runs over the whole corpus, and the row's page chip
   records **origin, not live scope**. The server must **not** fall back to `page_ref` for
   retrieval when the body carries no `pageId` — that would be exactly the invisible context
   #1160 complained about. A "Continue on the page" link is a follow-up.
2. **The `/ai` sub-header New chat renders at every width.** The literal reading of decision 12,
   and one control that works everywhere beat a `md:hidden` variant; on desktop it is also the
   New chat that stays reachable with the pane collapsed. Cost: a quiet ghost button in a slot
   that is empty today.
3. **The history note renders in the dock too.** Decision 10 says `/ai`; the dock has the same
   long-thread problem and the same flag, and one line on one of two surfaces is a divergence.
4. **A completed exchange is mirrored into every retained thread carrying the same id.** Not in
   the issue; prevents the dock's page thread and the `/ai` view of the same conversation from
   visibly disagreeing. Six lines at commit time.
5. **The title completion is not audited as its own row**, following #1112's reformulation
   call. If the owner wants side-completions audited, add `'title'` (and `'reformulate'`) to
   `LlmAuditEntry.action` — a closed union the EE consumer may switch on — in one PR for both.
6. **`DELETE` stays idempotent** rather than 404-ing on a missing row; the client purges and
   refetches either way.
7. **`page_ref`, drop `page_id`** — argued under Migration.
8. **Keyset over offset** — argued under Read side.
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

## Follow-ups (already in the issue's out-of-scope list, plus three found here)

A composer page picker; persisting Generate/rewrite/Diagram turns; pin/archive/full-text
search; soft delete/undo, delete-all, retention; persisting the user turn at submit and the
partial answer on stop; the dock resuming its page's latest conversation; audit rows for
rename/delete. Found here: **`e2e/contrast.spec.ts` still expects the retired `slate-steel` /
`frost-steel` theme ids** and a "switch to light mode" button (pre-existing; fix separately;
add `/ai/c/:id` to its routes when a seeded conversation is available); a
provider-window-derived history budget; the conversation title in `/ai`'s sub-header on
`/ai/c/:id`.
