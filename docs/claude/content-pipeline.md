# Content Pipeline

Moved verbatim from `CLAUDE.md`. Paths are relative to the repository root.

## Content Pipeline (ADR-003)

Confluence DC 9.2 = XHTML Storage Format only (no ADF). Pipeline:
```
Confluence (XHTML) ⇄ confluenceToHtml/htmlToConfluence ⇄ DB (body_storage XHTML, body_html clean, body_text plain)
DB (HTML) ⇄ htmlToMarkdown/markdownToHtml ⇄ {LLM: Markdown, Editor/TipTap: HTML}
```
Custom `turndown` rules per Confluence macro (code blocks, task lists, panels, mentions, page links, draw.io). See `docs/architecture/11-content-pipeline.md`.

PDF export draws text in fonts vendored under `backend/src/core/services/fonts`
(SIL OFL 1.1, rebuilt by `tools/pdf-fonts/prepare.py`; the backend build copies
them into `dist`): Noto Sans Regular, Bold and Italic, Noto Sans Mono for code,
Noto Sans SC for Chinese and Japanese, and Noto Sans KR for Hangul.
A character its style lacks falls back to Mono (in code: Regular), then SC,
KR, Armenian, Georgian, Symbols and Symbols 2, all in regular weight.
Armenian words, Georgian including Mtavruli capitals, Braille patterns, and
text symbols such as ✔ ✘ ☑ ➜ ❤ print and extract as written. Font selection
uses the NFC text of each rendered block, list item and cell separately. Inline
text within a block can compose; text in separate blocks cannot. Only rendered
image labels count. Each document embeds fresh subsets; a missing required
file fails export.
An ideographic space collapsed in prose or trimmed from the ends of a code
block needs no fallback font. Inside a code line or image label it keeps its
printed width and still needs its font.

Arabic, Hebrew, Indic scripts, Thai and emoji rendering are deferred to
#2033. Unsupported visible code points print one U+FFFD each (in CE analytics
PDFs, `?`). This includes uncovered rare CJK. Previously supported monochrome
symbols such as ⚽ still print; new symbol faces do not claim default emoji
presentation characters. Controls, variation selectors and other invisible
characters print nothing. Text is composed (NFC) first; a tab is four spaces
and, outside code blocks, a newline is a space. Each run is measured in the
font that draws it.

**Intentionally deferred (#2033):** unsupported Arabic, Hebrew, Indic, Thai
and emoji still print U+FFFD in article PDFs and `?` in CE analytics PDFs.
[ADR-028](../ARCHITECTURE-DECISIONS.md#adr-028-complex-text-in-pdf-exports)
selects PDFKit for article bidi and shaping; the writer has not shipped.
Both glyph placement and logical copy/search order must pass before enabling
a script. The analytics renderer stays separate.

**Confluence links live in the href (#1748).** The editor's Link mark keeps no
`data-*` attribute, so `confluenceToHtml` writes an `ac:link` as
`#confluence-page:<title>`, `#confluence-attachment:<filename>` or
`#confluence-anchor:<anchor>`, percent-encoded, then `?` and the link's other
`ac:*` / `ri:*` attributes, and `htmlToConfluence` rebuilds the `ac:link` from
that href alone. Parse and build it only through `core/services/confluence-link.ts`
(the converter, `link-extractor.ts` and the baseline manifest do); keep reading
the pre-#1748 shape, the title or filename as written, as the fallback to the
encoded reading. Deferred, unchanged by #1748 (the converters and Improve keep
these links): the editor loses a link whose body is an image (a block node, so
a save lifts it out of the paragraph) or inline code (StarterKit's Code mark
excludes every other mark, so the Link mark leaves it; a fix changes the Code
mark contract in both schemas), splits a link whose text mixes inline code with
other text into two links around the code, and on a collaborative save splits a
link around a line break (Yjs keeps marks on text only). Pinned by
`content-converter.links.test.ts`.

**Five more link kinds, and one rule for `ri:url` (#1955).** `ri:space`,
`ri:blog-post`, `ri:shortcut`, `ri:content-entity` and `ri:url` links are
carried like the #1748 kinds (`#confluence-space:<key>`,
`#confluence-blog-post:<title>`, `#confluence-shortcut:<key>`,
`#confluence-content-entity:<id>`, `#confluence-url:<value>`; `body=plain|rich`
whenever the link has a body; without one the text is the value with white
space collapsed, or `(empty link)`). The grammar is pure and lives in
`@compendiq/contracts` (`confluence-link-grammar.ts`), re-exported by
`confluence-link.ts`; never parse or build a carrier anywhere else. A `ri:url`
whose value is a lowercase `http:`, `https:` or `mailto:` URL with no white
space, control or format character (`isNavigableConfluenceUrl`) is a real link:
the value is the `href` and the carrier is the `class`, accepted only when it
carries exactly that href (`isConfluenceUrlClassCarrierFor`). Any other value
(`javascript:`, `data:`, relative, `HTTPS:`, empty) is an inert
`#confluence-url:` fragment and is never an href anywhere. On write-back a
navigable `ri:url` is always written; any other `ri:url` is written only where
the origin (the page's stored storage: `previousStorage`, or `linkOrigin`
where a writer keeps `previousStorage` for task ids alone) holds that very
link, same target with the same body or in the same place, and nothing else
stored could be its source (`confluence-url-origin.ts`). Every stored link and
`<a href>` with the same body competes, whatever the label: body_html cannot
tell a link's carrier from a stored anchor with the same href. A link of any
kind without a body competes with the text the forward pass shows for it (its
title, key, anchor or value, white space collapsed as the editor shows it);
one whose shown text is not known (a mention, or a title or own body with
U+2329, U+232A or a C1 control, which the editor may show as another
character) matches no body, is never the same body as another, and when it is
missing from what is written no moved or relabelled link that could be it is
kept. A link that is
not approved becomes what it shows: the nodes of a rich body, the XML text of
a plain body, or the display text of a body-less link. That is judged on the
storage string about to be sent, read as XML by `confluence-storage-reader.ts`
(saxes, never JSDOM, which reads storage as HTML; a tag's start and each
attribute are charged as the parser reads them). `ConfluenceStorageRefusedError`
(422, nothing sent, nothing changed) is thrown instead of a silent loss: the
string may hold a `url` element and cannot be read, the links cannot be judged
within the work limit (written or stored side), or an unapproved link cannot be
taken away without loss (it is no element of the document, it is not the exact
`ac:link` shape and shows something outside a body, or the text shown differs
after the repair). No cap of the judgement drops a link: a body of any length
is evidence. Every writer of a synced page derives the storage once, before it
reserves its intent, and authorizes the page before it plans files or derives
anything; create and relocation have no origin, so they write no unsafe
`ri:url`. The forward pass reads the start tags of a link of the five kinds and
of its resource as XML does (`keepXmlLinkValues`: the storage reader finds the
tags; `&lang;`/`&rang;`, C1 numeric references and literal TAB/LF/CR are spelled
so HTML reads XML's value); text and the #1748 kinds keep the HTML values, as
before #1955. Where the reading of a stored link of the five kinds still differs
(a literal `/>` in a quoted value, folded attribute names, a panel re-parsing
its body so CR becomes LF), a write that would publish it with another target
than the stored XML one is refused before any effect (422 `changed-link-target`,
owner decisions D19/D21, coordinator decision D20). The verdict is the real
forward pass's: the writer runs it over the stored storage with the tags the
reader found in the stored string itself (before CDATA becomes text) marked,
marks each `<a>` it emits with whether it keeps that link's XML target, and
judges only the marked `<a>` left in the completed result; a carrier no
surviving occurrence has (new link, macro parameter dropped later) passes, one
carried both faithfully and not is refused as `ambiguous` (logged detail).
Links of stored storage the reader stopped at a limit (`isStorageLimitStop`;
the unread rest is not certified) are refused with the limit as reason; known
malformed storage is not checked. A stored rival of unknown text is released
only when it alone stood in its place and the one thing written there points
to its target.
`restoreMedia` replaces a token only where it stands as content
(`locateMediaTokens`, parse5): never in an attribute, a comment or raw text,
never under an element the tree builder moved (out of a table, or misnested
formatting), and never where a reparse would drop or move what is spliced in
(a `select`, SVG or MathML, an element holding a start tag the tree builder
ignored, also inside text joined across it). The change is the
storage-derivation feature `link-kinds`. Owner decision D21 (fallback) narrows
what may grant, without proving every unproven non-web occurrence becomes text:
a stored link the forward pass did not deliver to the editor as a link (one
only a discarded macro parameter held) is a competitor only and matches no
written link, ordinary or dormant; a stored link that is itself dormant (in a
template, a style, …) keeps its own round trip; an ordinary anchor in any
letter case competes but never grants. Limits,
all declining: a link the editor splits keeps at most one piece as an unsafe
(not navigable) `ri:url` link; a link both moved and relabelled, one of several
identical links, and a link left when a stored thing with its body and another
target went missing become text; on a page that also stores something else
showing the same text as a link (an `<a>` in any letter case, a page link with
that title), once one of the two is deleted the link is kept only where it
still stands in its own stored place, unchanged around it, and becomes text if
it moved; a row
synced before #1955 holds these links as text until it is re-synced. That
Confluence rejects storage that is not well-formed XML is an assumption, not
tested against a server.

`body_text` is derived from `htmlToText` output on every write path (sync, saves, collab,
imports, drafts, version text; Notion imports join parts with blank lines, restores copy
stored text), so `htmlToText` must equal what the page shows: the HTML parser decodes
entities once and nothing decodes again (#1735). Rows written before #1735 are repaired
by the hourly `body_text` backfill job (`core/services/body-text-backfill.ts`, #1965): it
rewrites `pages.body_text`, `pages.draft_body_text` and `page_versions.body_text` only where
the stored text is exactly the frozen pre-#1940 derivation of the copy's own HTML
(`he.decode(textContent)`, kept verbatim in `body-text-backfill-parser.ts`; never "fix" it)
and differs from `htmlToText`. A page and its history are repaired together in one
transaction or not at all: if any copy the job will not rewrite (baseline-linked or
text-only snapshot, a frozen page's columns, a diverged/current/no-`&` copy) holds the same
stored text as a copy it would correct, or the repair would move the page's snapshot
identity onto an occupied key, the whole page is left as it is and counted. Notion, folder,
diverged and already-current rows, oversized (> 32 MiB) or unparseable columns,
`page_baselines`, `page_relocation_preparations` and `pending_sync_versions` are never
written. Design and limits: `docs/architecture/11-content-pipeline.md`.

PDF tables split tall rows at wrapped-line boundaries across pages, retaining
column positions and borders. A fitting first header row repeats on continuation
pages only when it leaves room for at least one body line; an oversized header
itself continues without repetition. Cells sit on a span-aware grid as wide as
its widest row: thead, tbody, then tfoot rows, each row's own cells covering
their `colspan` (missing, 0 or non-numeric count as 1). `rowspan` is ignored:
cells of the rows below shift left. A spanning cell wraps at the combined width
of its columns within each band, with no border inside it. Grids wider than 14
columns print in bands of at most 14 equal columns (at least 35.38 pt, two
glyphs wide), one below the other. A later band holds only the rows with a
cell starting in it (a crossing cell repeats there), plus the first row's
share if that row starts with `th`. Its carried cell wraps once at the
clipped band width; if it leaves no room for a body line on a fresh page,
its piece stays blank there and in subsequent bands. Later `th`-first rows
follow ordinary band rules. A `colspan` of 1000 can touch up to 73 bands
when offset from the band edge. Bands with no cell starts are skipped,
except the first, which preserves empty rows as bordered boxes.

Article PDFs print a table's own `<caption>` once, above its first band, in
regular body text at the full content width. Keep the caption with the first
row when they fit a fresh page; otherwise keep its last line with at least
the first row fragment. A caption needs no rows to print. An editor caption
outside the table remains ordinary body content. In captions and cells,
HTML block boundaries (including form legends and legacy `<center>`), `<br>`
and nested table cells and rows separate words with a space. Inline marks
preserve the word; author CSS does not determine these boundaries. Nested
tables contribute text, not another grid (#1969).

PDF code blocks wrap at the code box's inner width (475.28 pt, 83 Noto Sans Mono
cells): the rest of a long line continues flush left on the next row, unmarked,
and each row is placed and paginated like a source line. Tabs expand to four
spaces before measuring; blank lines keep their row. Text is measured as drawn
(pdf-lib applies no kerning), and a word wider than its line (URL, hash)
breaks between characters in body text and table cells.
Font selection follows that layout: an ideographic space collapsed in prose
or trimmed from the ends of a code block needs no fallback font. Inside a
code line or image label it keeps its printed width and still needs its font.

**Article PDF export limit (#1962).** One request may print at most **1,000
code rows**, including internal blank lines and wrapped continuations. Empty
or whitespace-only code blocks print no rows. The limit is shared across the
articles the reader can access in a batch. Exceed it and the whole request
returns HTTP 413 with no download: shorten the code or export fewer articles.
This is not an HTML byte limit, a limit on other content, or a concurrency cap.

The renderer reserves source rows after parsing and before font selection,
then charges continuations as it wraps. The fixed limit leaves headroom for
rows with alternating font faces: at 1,000 such rows, a two-article merge and
save peaked at about 337 MiB RSS in a 1 GiB container with a 560 MiB V8 heap limit.
The originating measurement was about 1.9 GB for 500,000 short ASCII rows.
Rendering stays in-process; a worker alone would not bound the work.

Draw.io XML-only attachments remain editable `.drawio` sources, not fake
`.png` files. Publish a preview only after validating PNG chunks, checksums
and raster stream; otherwise the wrapper names the unavailable preview and
retains its source URL. Missing previews and sources are rechecked even on
unchanged pages, without counting an intentionally absent preview as a
permanent download failure. Both TipTap schemas must round-trip that URL and
the `drawio-preview-unavailable` marker so a later preview save removes the
obsolete message. Read and edit mode share `loadDrawioSource`: try XML without
stale cache, then an actual decoded PNG containing editable draw.io metadata.
Validate every XML page, preserving the complete multi-page file and valid empty
graphs. Support the packaged editor's URI/double-URI tEXt and legacy raw-deflate
zTXt formats, with bounded expansion. HTTP 200, MIME type, and filename are not
proof of editable content. Never substitute an empty diagram on load failure.
An attachment-candidate fallback is not an authentication retry: one logical
load may invoke the shared refresh helper only once. Propagate refresh
unavailability immediately, keeping auth state and the helper's marked-busy
retry policy; never replay an uncertain rotation through the PNG candidate.
Synthetic refresh-success fixtures must satisfy the shared `AuthResponseSchema`,
including UUID user IDs. Assert request sequences and preserved session state,
not incidental error-message wording.
A missing local source is unknown upstream availability, not proof of absence:
retain the converted source locator on page-only publication (including PUT,
bulk sync and recovery). The existing authorized attachment GET resolves it
on demand; only validated local raster bytes may become a preview.
Lazy `.drawio` reads also resolve `.xml` and extensionless upstream titles.
All sync and lazy paths classify bytes, including names ending in `.xml` or
`.drawio`: actual PNG becomes a preview, actual XML becomes source, and other
payloads are not cached. A preferred source title containing PNG or unrelated
bytes must not shadow another valid XML source: continue through the supported
source candidates, retaining any validated PNG separately. A Confluence-to-local move
must refuse before any cutover or upstream deletion if a referenced draw.io
source is not preserved as XML in its prepared attachments. Open/save the
diagram first, then retry the move; never rewrite an unpreserved source.
Extensionless previews are classified even beside an existing XML source;
classification receipts suppress repeated downloads of unchanged bare sources.
A version-jump sync removes a diagram's cached `<name>.png`, `<name>.drawio`
and `<name>.drawio.png` together when the incoming body references it, keeps
all three when only local content (body, draft, history) does — by source
locator, or by the `data-diagram-name` wrapper alone in HTML written before
2026-10-28 — and never removes dot-file receipts.
Attachment saves and their recovery publish newly valid previews into existing
HTML under the same writer fence, never by reconverting stale storage. Update
plain text and invalidate persisted collaborative bytes with that presentation.
Incremental sync also reconciles stale presentation when both files exist,
through the existing conflict policy rather than an unconditional body write.
Read mode uses the draw.io schema renderer, not the editor-only React node view,
so the admitted Edit Diagram callback remains reachable for source-only nodes.
Remove its overlay when that callback is withdrawn (including a live freeze).

**Emoticons round-trip (#1750).** `confluenceToHtml` turns each `ac:emoticon` into an
empty `<span class="confluence-emoticon" data-emoticon-attrs="{…}" data-emoticon-label="✅"
role="img" aria-label="tick">`: the JSON object holds every attribute in source order
(`ac:name`, `ac:emoji-*`, any other; `<`/`>` written `\u003c`/`\u003e`); the label (an
emoji, or Confluence's text form `:shortname:`/`(name)`) is drawn by
`.confluence-emoticon::before`, so the span adds no text to `body_text`, embeddings,
Markdown or #1751's task matching. `htmlToConfluence` writes exactly the carried
attributes back, self-closed (`<ac:emoticon ac:name="tick" />`; `<`, `>`, tab, LF and CR in a
value as character references). `confluenceEmoticon`
(inline atom: `emoticonAttrs`, `label`, `name`) is in both TipTap schemas, rendered
by `renderHTML` alone (no node view), never a tab stop. `span.confluence-emoticon` is in `MEDIA_SELECTOR`: AI Improve freezes it
as one inline token, never a div, so a task holding one stays a task (#1752). A
page synced before #1750 shows emoticons only after its body is re-derived.

A pasted image is uploaded once. `planLocalImagesForConfluence` uploads every
`img[src^="/api/attachments/"]` outside a `.confluence-drawio` wrapper that has
neither `data-confluence-filename` nor `data-confluence-image-source`, and gives
it both (`attachment`): the shape `confluenceToHtml` writes for a synced
attachment and `htmlToConfluence` turns into `ri:attachment`. It skips every
`img` with a `.confluence-drawio` ancestor before any marker check or file read:
`htmlToConfluence` replaces that wrapper with the draw.io macro and drops the
preview, so such an `img` is never planned, marked or uploaded (it would
overwrite the plugin's own `<diagramName>.png`), and a missing cached preview
file cannot refuse a Save (#1935). A collaborative Confluence Save copies those markers into
the room's live and persisted Yjs document after its intent settles (#1764);
otherwise the room's next 2 s persist drops them and every later Save uploads
the image again.

**A Confluence task keeps its id (#1751).** `ac:task-id` (canonical, at most
2^63 − 1) rides in `data-task-id`, declared as `taskId` on `taskItem` in both
TipTap schemas (`ConfluenceTaskItem`, registered by the editor and by read mode,
whose copy is serialized with its schema; `keepOnSplit: false`). Every
write-back over an existing page passes the stored `body_storage`: a task keeps
the id it carries (of two carriers of one id, the one with the stored task's
text), a task without one takes the id of a stored task with exactly its text,
and any other task gets the next free number above every id in the page and its
storage (deterministic: publishing a version restore re-derives the digest).
Only on a page synced before #1751 (`legacyTasks`: its stored `body_html` holds
tasks and none carries an id; for a collaborative Save, the room's
`compendiq.meta` Y.Map lacks `confluenceTaskIds`) do the tasks left pair with
the stored tasks left in order when they are as many. Draft publish stores the
ids it wrote in the live body; like the image markers above, a collaborative
Save sets them on the room's task items after its intent settles, in the
transaction that also sets `confluenceTaskIds`. The task body is TaskItem's
content `div`, never its checkbox `<label>`. AI Improve carries no ids (turndown
writes `- [ ]`) and never pairs: only tasks with unchanged text get theirs back
on apply.

**What write-back derives from a stored `body_html` is versioned by named
features (#1953).** A version restore records only a digest of the storage it
derived and derives it again when it publishes, possibly in a recovery on a
later release (`deriveVersionRestoreStorage`, `page-put-intent-reconciler.ts`).
A change to what `htmlToConfluence` writes for HTML that already exists, in the
reverse pass or in the forward conversion write-back runs on `previousStorage`
(`storedTasks`), therefore appends a name to `STORAGE_DERIVATION_FEATURES`
(`storage-derivation.ts`) and gates exactly its step with
`derivationHas(features, '<name>')`. The restore intent records the names in
force (`derivationFeatures`, no key while none is), recovery derives with that
record only, and an intent without it gets the empty set, which must keep
writing the bytes of `__fixtures__/storage-derivation-base-corpus.ts`
(`storage-derivation.corpus.test.ts`; `describeRestoreDerivationFeature` in
`__fixtures__/test-restore-derivation-contract.ts` is the test a registering
change runs). Recovery refuses a recorded name it does not register before it
takes ownership of the intent (`registerPageWriteIntentPreflight`), so a
runtime that registers it still finds the fenced owner.
Every other writer passes no set and derives with all features. The digest
proves the derived storage and the effective title, not the historical row: the
route compares the row's id, title and HTML before the provider PUT.

**`body_html` never contains a raw structured macro (#1438).**
`confluenceToHtml` uses static DOM snapshots, and replacing an outer macro can
clone nested `ac:structured-macro` nodes after their dedicated handler pass.
Conversion therefore repeats to a fixed point with a strict monotonic guard:
the raw macro count must decrease on every pass, or conversion throws rather
than returning partial HTML or deleting the malformed macro. A cloned supported
macro stays raw for the next dedicated pass; it must never be downgraded into
the lossless long-tail `confluence-macro-unknown` node. Native `panel` renders
through the existing info-panel node but carries `data-macro-name="panel"` and
arbitrary direct text parameters through the editor, so write-back emits
`ac:name="panel"` rather than permanently coercing it to `info`.

**Dedicated macro handlers keep every parameter (#1749).** `code`, `toc` and
`status` keep canonical parameters in their own attributes (code `language`
class + `data-title`, toc `data-<name>`, status `data-color` + text) and every
other direct text parameter in `data-macro-params`. `codeBlock`, `mermaidBlock`
(which claims a code macro whose language is mermaid), `confluenceToc` and
`confluenceStatus` declare it as `macroParams` in both TipTap schemas, and so
does read mode's code block, because a copy out of read mode is serialized with
that schema. The parity test is one-way: it fails when the collab schema lacks
an attribute the frontend declares; the frontend declarations are pinned by
Editor.test.tsx, ArticleViewer.test.tsx and MermaidBlockExtension.test.tsx. The
reverse pass skips a carried copy of a canonical name. The code language is the
whole class token (`language-(\S+)`) in the converter, collab-schema.ts and
TitledCodeBlock.ts. AI Improve keeps the frozen toc/status parameters, the
code language and, since #1958, a code block's `data-title`/`data-macro-params`
(below). Only
`body_html` converted after #1749 holds the carriers: a page synced earlier gets
them when its body is next re-derived from Confluence (an upstream change, or
a re-sync: **Re-sync** on selected pages, **Pull from Confluence…** on a page,
or Settings → Spaces & Sync → Sync schedule → **Force Re-sync All**, all calling
`POST /api/pages/bulk/sync`; **Sync Now** is incremental and does not refresh
unchanged pages). A save before that still drops them.

**AI Improve keeps code-block title and options (#1958).** With `layoutTokens`
an annotated `pre` that can travel (one `code` child without elements, not in
a table cell, not draw.io, non-blank, bounded valid metadata, a lossless
projection) is written as its fence with `[[[CODE-META n=<ordinal> title=…
params=…]]]` on the line directly above; every other annotated block is frozen
by `protectMedia` (as are token blocks past 1,000). On Accept the route runs
`beginCodeMetaAccept` → `markdownToHtml(…, { codeMeta })` →
`replayProtectedMedia` → `finalizeCodeMetadata` → (local)
`assertLocalCodeMacroProjections` or (remote) `htmlToConfluence` +
`assertCodeMacroStorage`. Metadata returns only to a fence whose language and
exact lexer text equal the pre-Improve block's, in per-key groups equal element
for element; the stored values are written, never the echoed ones. Two blocks
that end with the same language and code keep metadata only when all carry
identical metadata (R1). The written storage (standalone: both publication
projections, read whatever they spell) is read as XML: every code macro must be
the writer's exact shape and accounted for by the page, else 422
`unapproved-code-macro` (or the read reason) before any intent or write.
Model-written code markup that is not a fence or a plain `pre` is refused (R2).
A placeholder spelled in `pre`/`code`, or one the page itself spells, stays
text; a code-carrying original without exactly one viable placement is
appended once. Details, bounds and limits: `docs/architecture/11-content-pipeline.md`
"AI Improve code-block metadata". #1953-2 consumes `witnesses`,
`codeBlockElements` and `admitLegacyCodeMetadata`.

**Notion picker discovery is metadata-only.** `GET /api/notion/tree` resolves
accessible native, relation and block-host ancestors omitted from Search without
listing every page body; existing bounded row probes only advise table defaults.
Inline wiki databases remain selectable. Normalize UUID spelling, not titles,
and reject cyclic edges without losing nodes. The picker batches confirmed IDs
into requests of up to 200; explicit database exclusions travel with every batch.

The remote tree metadata is cached, but imported markers are read live from
this user's nontrashed standalone pages on EVERY public tree GET, including
cache hits. UUID case/hyphens are normalized; no title or Confluence metadata
row owns an import identity. Enrichment changes only request-owned parsed
nodes after the metadata cache write completes. A failed authoritative marker
read fails the request rather than inventing false or stale markers.

Both successful relocation cutovers clear `notion_page_id` in the same UPDATE
as the source/owner change, keeping the universal page PK and dependencies.
Re-import therefore allocates a distinct standalone page; it must not rebind
the moved copy. The exact original token belongs in relocation preparation
for rollback, not in generic intent metadata. Safe pre-allocation 23505
reconciliation stays distinct from an admitted uncertain failure, which remains
failed and pending rather than being mapped to success or force-cleared.

**Notion import plans before persisting.** Pages and databases share parent-first
allocation, preserving the selected root and wiki home bodies. Actual embedded
child pages/databases expand their owned descendants; mentions never imply
ownership. Property-only embedded databases fold into parent tables, never also
row articles, including later row-only batches. Article-bearing rows keep their
bodies and correct parent; wiki containers remain articles. Successfully imported
direct children use one existing Child pages macro per parent. Return discovered
outcomes too, for failure reporting, cache invalidation and audit. Per-owner plus
selected-ID locks protect dynamic overlaps. Re-import preserves bodies unless
overwrite is requested; never automatically delete older row articles or local
edits to remove duplicates.

**Notion import is not request-scoped.** `POST /api/notion/import` returns 202
and runs `runNotionImport` off the request. `GET /api/notion/import/status` is
the result. A Knowledge Base with nested pages outruns nginx
`proxy_read_timeout 300` at Notion's 3 req/s; waiting on the POST is the FTS
rebuild 504 (browser error, work continues). Never put paced Notion traffic
back on that HTTP request. Start is `SET NX` on a per-user lock with a 10-minute
safety TTL (renewed while the walk runs) — a second POST while the lock is held
is 409. Renew, release, and terminal status writes are Lua compare-and-swap on
the lock token (same as Confluence `SYNC_LOCK_TTL`). `importing` is not a 24h
mutex; a missing Redis status key is idle. Redis SET NX throwing fail-closes.


**That 3 req/s budget is spent by `NotionClient`, not by its callers (#1553).**
`waitForSlot` reserves the next *start* 334 ms out, and it reserves
synchronously — before any `await` — so concurrent callers each take their own
slot and the tree's three `pLimit(5)` waves plus the importer's row-body checks
still overlap. Never serialize on completion instead: that caps the client at
1/(interval + latency) rather than 1/interval (≈1.6 req/s at Notion's typical
latency, half the budget) and silently makes every caller-side `pLimit` inert —
measured `peakConcurrentLookups` of 1, which is why both tree concurrency tests
now assert a floor as well as the cap. 429/529 retry on any method; 500/502/503/504
only on GET/DELETE and on the two POSTs that are reads (`/v1/search`,
`/v1/databases/:id/query` — a transient 5xx mid-pagination is exactly what the
ladder is for, and this client issues no writes, so a future write POST must
stay off that list). Six attempts. `Retry-After` wins over the exponential
ladder but is floored at one pacing slot (a proxy answering `Retry-After: 0`
must not turn the ladder into a hot loop) and capped at 60 s, because that sleep
sits outside `AbortSignal.timeout` and would otherwise park an import past every
request timeout. Notion-hosted attachment bytes live on S3, which is not part of
the integration's budget: `fetchMedia` retries them but takes no slot for a URL
off the API origin.

**Markdown import** on the New Page form is a *conversion*, not a create (#1133).
`POST /api/pages/import/preview` parses YAML front-matter, runs `markdownToHtml` and
sanitizes — and persists nothing. The form loads the result into the editor the way
"Use Template" does, and the normal `POST /api/pages` create saves it with the space,
parent and visibility the user chose. It replaces `POST /api/pages/import`, which
inserted the row itself under a hardcoded `space_key = '_standalone'`. Don't reintroduce
a client-side Markdown→HTML path: `markdownToHtml` has no frontend counterpart.

`markdownToHtml` renders GFM task items as `ul[data-type="taskList"] >
li[data-type="taskItem"][data-checked]`, splitting a list that mixes task and
plain items into runs (ordered plain runs keep `start`), for every caller —
AI Improve Accept included (#1752). A task item holding a `<div>` (raw HTML, a
draw.io fence, or on Improve Accept a placeholder whose original HTML is a div,
which the route names via `protectedMedia`) stays plain with `[x]` / `[ ]` as
text: TipTap's TaskItem parses only the first descendant `div`. Mentions,
status lozenges, Jira links and images are inline and keep their tasks. The
import sanitiser admits exactly `start`, `type`, `data-type`, `data-checked` and
`data-diagram-name` (#1754) by name: never `ALLOW_DATA_ATTR: true`, never `<input>`.

`data-diagram-name` is admitted by name and as URI-safe, so a
` ```drawio ` fence keeps its identity into the editor and the Confluence write-back
(#1754). A diagram name is text: consumers encode it (`encodeURIComponent`,
`safeAttachmentPath`) and never use it as a URL. `htmlToMarkdown` writes a name-only
placeholder's name raw into its fence, so the import drops a name with a line break or other
control character, one that marked reads as a closing fence (three backticks, then only backticks
or tildes), and an empty one (`htmlToConfluence` would write an empty `diagramName`). A fence's
`data-drawio-source` and `data-drawio-xml` stay stripped — another page's attachment, and XML for
the same-origin draw.io editor — and `ALLOW_DATA_ATTR` stays `false`.

Its size limits (#1178) are a **ladder in two different units**, and every rung must clear
the one below: nginx `client_max_body_size 44m` → the route's `bodyLimit` 8 MiB →
`ImportMarkdownSchema`'s 1,000,000 **characters** → the client precheck in `NewPagePage`.
1,000,000 characters is up to 3 MB of UTF-8 and ~6 MB of JSON-escaped request body, so an
edge limit set to the same *number* as the schema still refuses files the schema accepts —
which is what produced an HTML 413 from nginx naming a limit the app had never heard of.
The edge is **shared with every other `/api/` route**, so size it to the largest `bodyLimit`
behind it (the draw.io attachment route's 40 MiB), never to the route you happen to be
working on; `frontend/src/nginx-api-body-limit.test.ts` parses them out of the backend and
fails if the edge drops below any of them.
`parseFrontMatter` tolerates CRLF and a leading BOM because failing to match is **silent**:
the `---` block renders as body and the import reports success with title and labels gone.
It also reads YAML block lists (`tags:` then `  - ops` lines, quoted items, trailing `#`
comments) as arrays — they used to import as no labels without a warning (#1753). Only a
top-level (unindented) key opens a list, and items end at the first line that is not an item,
blank or comment, so a list under another key never reaches `tags`/`labels`. YAML comment
rules apply: `- #ops` is an empty item (write `- '#ops'`). A scalar `tags: ops` is still not a label.
An indented key opens no list but is still read as a top-level key (pre-existing), so a nested
`tags:` replaces a top-level `tags` list with `''`.

**Uploaded documents** (#1131) enter through `core/services/document-extractor.ts`, behind
`POST /api/llm/extract-document`: pdf (`unpdf`), docx (`mammoth` → `htmlToMarkdown`), odt
(structural `content.xml` walk), rtf (control-word strip), md/txt (read directly). The format is decided
by **magic-byte sniffing**, never the client's `Content-Type` — a mismatch against the claimed
extension is a 415. Zip containers (docx/odt) are bounded by `ZIP_LIMITS` and, for docx,
repacked stored before `mammoth` sees them, because mammoth's own inflater is unbounded.
ODT is read by one linear pass over `content.xml` that tracks element depth — never a regex
per element, which ended a paragraph at a nested note's `</text:p>` (#1734): a note or text
box splits its paragraph in document order, at most 64 paragraphs are tracked open, and
character references are decoded once (invalid code points become U+FFFD). It never loads
or interprets a DTD and expands only the five XML entities and numeric references; do not
swap in an XML/DOM parser that expands declared entities (jsdom's XML mode does).
ODT `text:tracked-changes` is skipped whole: text deleted under change tracking lives only there
(`text:deletion`), inserted text stays inline in the body and is kept, and `text:track-changes="false"`
needs no special case. Like every element the walk reads, it is matched by its conventional `text:` prefix
(namespaces are not resolved), so the same element under another prefix is not recognised.
ODT `text:s` honours `text:c` (default one), with combined expansion bounded by
the existing entry limit; do not expand each run without a shared budget.
RTF is one linear token scan over the file's bytes (`rtfToText` takes a `Uint8Array`, never decoded text; a raw
non-ASCII character after `\` or inside a `\ucN` fallback counts as one whole well-formed UTF-8 sequence): `\uN` replaces its group-scoped `\ucN`
fallback, `\'hh` bytes decode through `TextDecoder` in the `\ansicpgN` code page (windows-1252
when absent or unsupported; 932/936/949/950 as double-byte runs, 949 as full Windows cp949, whose `C9`/`FE` rows decode to the private-use area U+E000–U+E0BB;
per-font `\fcharsetN` is not read), `\binN` data is skipped (inside skipped groups too), a backslash followed by a line break (`\`+LF, CR or CRLF as
one break, as TextEdit and `textutil` write every paragraph) is kept as a paragraph break like `\par`
(silent in a skipped group), and malformed input never throws.
Destination groups (#1967) drop whole with everything nested in them, under one decision table:
an ignorable `{\*\name …}` group is **dropped** unless `name` is `shpinst` or `shptxt` (so bookmarks,
`\fldinst` field codes such as `HYPERLINK "url"`, `\expandedcolortbl`, `\panose`, `\listtext`, rsid
tables and unknown names never reach the text, and a `{\*` with no readable name is dropped too); a
plain `{\name …}` group is dropped only when `name` is a listed markup destination (`fonttbl`,
`colortbl`, `stylesheet`, `info`, `pict`, headers/footers, `footnote`, … and `sp`, a shape property
pair). **Kept:** `\fldrslt` (a plain group, so a hyperlink keeps its visible text) and text-box text
in `\shpinst`/`\shptxt`; an unknown ignorable group nested inside a kept `\shpinst` is still dropped.
A group's name is read past raw CR/LF right after its `{` and its `\*`, so a writer's source-line wrap
inside a group header does not change whether the group is dropped.
In visible body text, a raw source line break (without `\`) is kept as a line break outside a pending
`\'hh` byte run (inside one it is ignored, so a multi-byte character is not split), so a writer that
wraps source lines inside a paragraph (LibreOffice) yields extra line breaks.

**Images as AI source material** (#1154) enter the same way but stay bytes, not text: they
never join the Markdown/HTML pipeline above. `POST /api/llm/prepare-image` sniffs the format
by magic bytes (png/jpeg/webp/gif — **SVG is never accepted**, both because vision encoders
need raster and because SVG carries script/XXE risk) and stages the validated bytes in Redis
under a per-user, content-addressed handle (`llm:img:<userId>:<sha256>`, 15-minute TTL). Generate
and Improve accept that handle and are refused with a 422 unless the resolved `chat` model
has separately probed as vision-capable (`llm_model_capabilities`, migration 087) — capability
is probed with a known-content image, never declared, because neither the OpenAI-compatible
`/v1/models` response nor Ollama's off-limits native `/api/show` exposes it. `sanitizeLlmInput`
cannot inspect pixels, so prompt injection rendered as an image is an accepted, documented
risk (ADR-021's `#1154` amendment) — not something this path mitigates.

**That Redis is shared and `noeviction`, so staging is capacity-gated (#1183).** A full
instance rejects *writes* — BullMQ enqueue included — so `stageImage` reads `INFO memory`
first and answers **503** when the write would take Redis past
`IMAGE_STAGING_MAX_REDIS_PERCENT` (default 80) of `maxmemory`: the image feature degrades
instead of sync, re-embed, summary and quality all failing to enqueue. The check **fails
open** — `maxmemory: 0`, an unreadable reply, or an `INFO` that a hardened deployment has
renamed all proceed — because an unreadable reply is not evidence of pressure, and per
request the write is its own backstop: an `OOM` reply from the `SET` maps to the same 503.
**Don't restate that as "the worst case is a slower 503".** It is true per request and false
per deployment: where `INFO` is unreadable the ceiling never engages, staging fills Redis,
and `OOM` only arrives once BullMQ enqueue is failing beside it — such deployments are back
to the per-user mitigation and their operators must watch `used_memory` themselves. Even
where it engages, the check is check-then-write: concurrent uploads inside the window pass
on the same pre-write reading and can collectively overshoot the reserve, so the percentage
is a soft target under burst, not a hard guarantee. Don't add
a cache in front of the check (a stale "there is room" admits every upload in the window on
one reading) and don't replace it with a staged-bytes counter (a TTL expiry can't decrement
one, so it drifts up until the feature wedges). `MAX_IMAGE_BYTES` is **5 MB** and is the only
*memory* ceiling; `MAX_IMAGE_DIMENSION` stays **4096** on purpose — dimensions bound what the
model looks at, not what Redis holds, and 4096 typically stays reachable in WebP or in JPEG at
moderate quality. Both are pinned by tests, so moving either is a deliberate capacity decision.

**The frontend half normalises before it stages.** `shared/lib/downscale-image.ts`
re-encodes **every** attached image — not only oversized ones — to **WebP within a 1568px
longest edge**, so the server never sees anything else and most of its rejections
(format, dimensions, payload size) are unreachable. `shared/hooks/use-attachments.ts` owns
both attachment slots on all three AI composers (`/ai` Generate, `/ai` Improve, the dock):
it routes every intake path — click, drop, paste — decides in **one** place whether a file
is a document or an image, owns the shared composer drop target, and holds the 20 MB
document gate. The upload zones gate nothing; they report the file they were handed and
render what they are given. Two rules follow from that: **SVG is refused client-side**,
never rasterized around the server's sniff; and passing **`isDragOver`** to
`DocumentUploadZone` is what declares "the parent owns the drop target", after which the
component attaches no drag handlers of its own — omit it while the hook is listening and
every drop fires twice.

The **`vision` tri-state must never collapse to a boolean**: `false` means probed and
refused, `null` means never established (an inconclusive probe — rate limit, auth hiccup,
open breaker), and they render different text (`VisionBadge`: "Text-only" vs
"Unconfirmed"). Only `true` enables image attachment. The dock's single **Attach document
or image** control stays available for documents in every state; its shared router refuses
an image with the verdict-specific reason when vision is not `true`. Attachment cards remain
their own DOM rows (`composerRowClass`), and the one shared trigger follows those rows, so
focus follows what the eye reads (WCAG 2.4.3). Don't reintroduce `order-*` anywhere in a
composer; `expectComposerFocusOrder` fails on it.

**A wrong verdict is correctable, and `probe_error` is admin-only** (#1184). Settings → AI Models
carries a **Re-check** control on the chat row — `POST /admin/llm-usecases/chat/reprobe-vision`,
a blocking probe of the pair `resolveUsecase('chat')` resolves — plus a disclosure exposing
`probed_at` and `probe_error` from `GET /admin/llm-usecases/chat/vision-capability`. Both are
`requireAdmin`. **Never extend `UsecaseDefaultSchema` with `probeError`**: `GET
/llm/usecase-default` is `fastify.authenticate` but *not* admin-gated, and the probe error is
the provider's raw body, which `llm-http-error.ts` keeps off client-visible paths because it
can echo request fragments and internal topology. It is truncated at
`PROBE_ERROR_MAX_CHARS` on the way out and rendered as plain JSX text — never
`dangerouslySetInnerHTML`, never a Markdown renderer.

## MCP Sidecar Sessions

The `mcp-docs` sidecar owns the Streamable HTTP session. An unknown or
terminated `mcp-session-id` gets `404` with the SDK's JSON-RPC body
(`-32001 Session not found`) on POST, GET and DELETE; a non-initialize request
without the header gets `400 -32000`. The `/mcp` shared-secret guard runs
before either answer. Idle eviction uses `MCP_DOCS_SESSION_TTL_MS` (default
30 min); it is a sidecar-process variable and is not mapped by the stock
Compose files.

The backend client (`backend/src/core/services/mcp-docs-client.ts`) retries a
request exactly once, after dropping its cached connection, and only on a
transport-level `StreamableHTTPError` whose status is 404 or 400 (400 keeps a
not-yet-upgraded sidecar working). Keep the predicate status-based. Never
retry a tool `isError` result or any other error: a 4xx is produced before a
tool runs, so re-sending cannot double outbound SearXNG/fetch traffic, whereas
retrying a tool error would. The retry re-sends the same URL or keyword query
only — no article content. Concurrent callers must share one in-flight
connect; publish `client`/`transport` only after `initialize` succeeds.

The real-sidecar validation
(`backend/src/core/services/mcp-docs-client.integration.test.ts`) spawns the
worktree's `mcp-docs/src` against a fake SearXNG through idle eviction and a
restart. It installs the sidecar's production dependencies into a temp dir
(`npm ci --omit=dev --prefer-offline`) because `mcp-docs` is not a root
workspace; it runs in the PR Check `Tests` job and must fail, never skip, when
npm, Redis or the sidecar is unavailable.

## SearXNG Sidecar

`fetch_url` caches at most the first 100 000 characters of a document's
markdown (`CACHE_MAX_CHARS` in `mcp-docs/src/cache/redis-cache.ts`, equal to
the tool's `ABSOLUTE_MAX_LENGTH`), whatever the download size: the Redis it
shares with the BullMQ queues runs `noeviction` (#658), so a 5 MiB document
must not become a 5 MiB value (#1770). `contentLength` stays the full length
and `storedLength` says how much is stored; an entry without `storedLength`
predates the bound, holds the whole document and stays readable, so the
`mcp:docs:url:` namespace is not versioned for this additive field. A read the
stored prefix cannot answer in full — a `start_index` at or beyond it, or a
window crossing it — is a cache miss: fetch again, answer from the fresh
document and re-store the bounded entry. Never answer it with a short slice
(a caller paging by `max_length` would lose text), and never raise one of the
two constants alone. Only the markdown is bounded; `title` and `url` are
stored as fetched. `mcp-docs/src/tools/fetch-url.integration.test.ts` pins
this against real Redis (`MCP_DOCS_TEST_REDIS_URL`; never skip).

`mcp-docs` calls SearXNG directly, so `[botdetection].trusted_proxies`
defaults to loopback only; never re-add a blanket Docker subnet. A deployment
that actually proxies SearXNG may set `SEARXNG_TRUSTED_PROXIES` to
comma-separated proxy IPs/CIDRs. The renderer must validate each entry and
fail startup on malformed input; never trust all forwarded headers. The
derived image keeps upstream ClearURLs fetches primary and patches only their
all-failed branch to load the pinned local baseline. Keep the patch strict so
an upstream integration-point change fails the image build.

`search_web` caches only the requested bounded result width and category
list: its Redis key is the sanitized query plus that effective width plus the
`categories` string. Keep the width in cache identity because cached results
are already truncated; a narrower request must not poison a later wider
request, or vice versa. Keep the categories in it because SearXNG answers a
different result set per category list.
Use the versioned `mcp:docs:search:v3:` namespace: `v2` hashed query plus
width, so one `v2` entry would answer every category list (and the
unversioned legacy keys were query-only). Never read a legacy or `v2` entry as
a `v3` result; let their TTL expire without flushing shared Redis. Bump the
version again whenever the identity changes.

Admin settings reach the sidecar as tool arguments on every call — never as a
Redis config key or an environment override (#1769). `fetch_url` takes
`cache_ttl` (60–86400 s: the admin Cache TTL; `CACHE_TTL_SECONDS` when absent;
a cache hit never rewrites an entry's TTL) and a `max_length` the backend caps
at the admin Max Content Length (1000–100000, the sidecar's
`ABSOLUTE_MAX_LENGTH`; callers keep 5000 for web search, 2000 for test-fetch
and 10 000 for attached URLs). `search_web` takes `categories`
(`^[a-z0-9_]+(,[a-z0-9_]+)*$`, at most 200 characters, default `general`).
The SearXNG URL is `SEARXNG_URL` on the sidecar only: no tool argument, Redis
key, admin route or UI field may carry a search host. Stored values outside
these ranges are clamped or fall back on read with a warning
(`getMcpDocsSettings`, `getSearxngSettings`). The sidecar does not depend on
contracts, so `MCP_DOCS_*` / `SearxngCategoriesSchema` and the tool schema are
pinned by literal tests on both sides —
`packages/contracts/src/schemas/{mcp-docs,searxng.categories}.test.ts` and
`mcp-docs/src/admin-settings.integration.test.ts`, which boots the sidecar
with real Redis (`MCP_DOCS_TEST_REDIS_URL`; never skip) and serves
`fetch_url` from a preloaded `fetch` stub because the SSRF guard refuses
loopback. Never widen one side alone.

`search_web` accepts `num_results` 1–10 (`MAX_NUM_RESULTS`). The admin setting
`searxng_max_results` shares that range through
`SEARXNG_MAX_RESULTS_{MIN,MAX,DEFAULT}` in `@compendiq/contracts`; the sidecar
does not depend on contracts, so both sides are pinned with literal tests —
`packages/contracts/src/schemas/searxng.test.ts` for the constants and
`mcp-docs/src/search-web-limits.test.ts`, which boots the sidecar against a
loopback SearXNG and proves the tool accepts 1–10, defaults to 5 and rejects
0/11 (real Redis via `MCP_DOCS_TEST_REDIS_URL`; never skip). Stored values
outside the range are clamped on read (`getSearxngSettings`) with a warning,
and `POST /admin/searxng/test` searches with the saved width. Never widen one
side alone (#1768).

The MCP cache-width regression is mandatory in the sidecar test suite and uses
real Redis; set `MCP_DOCS_TEST_REDIS_URL` to a test-only Redis endpoint. The
PR Check sidecar job provisions Redis and sets this explicitly. Missing
configuration fails the suite rather than skipping the regression.

`search_web` accepts a `query` of at most 200 characters and 30
whitespace-separated words — a data-leakage control (`MAX_QUERY_LENGTH` /
`MAX_WORD_COUNT` in `mcp-docs/src/security/query-sanitizer.ts`; the tool
schema's `max(200)` in `mcp-docs/src/index.ts`). The public LLM contract
enforces the same bounds up front: `searchQuery` on the
ask/generate/improve/summarize request schemas is `WebSearchQuerySchema`
(`trim().min(1).max(WEB_SEARCH_QUERY_MAX_CHARS)` plus a
`WEB_SEARCH_QUERY_MAX_WORDS` refine) in `@compendiq/contracts`, so an
over-long or blank query is a `400 ValidationError` at the API boundary
instead of a silently empty search. The backend never truncates an explicit
`searchQuery`; only the derived default queries are sliced to 200 characters.
The sidecar does not depend on contracts, so both sides are pinned with
literal tests — `packages/contracts/src/schemas/llm.test.ts`,
`mcp-docs/src/security/query-sanitizer.test.ts` and the running-sidecar cases
in `mcp-docs/src/search-web-limits.test.ts`. Never widen one side alone
(#1767).

## Analytics PDF Export

The analytics dashboards' PDF is built in the browser by
`frontend/src/shared/lib/export-helpers.ts`, which loads `pdf-lib` on demand,
unless an EE renderer is registered with `setPdfRendererOverlay` (it receives
the rows and metadata unchanged). WinAnsi-only reports use standard Helvetica
without fetching a font or loading fontkit. The renderer normalizes text to
NFC, replaces non-WinAnsi whitespace with spaces and prints the date range
as `<start> to <end>`. Other glyphs use same-origin Noto Sans Regular or Bold,
then SC and KR (per printed style). Non-CJK symbols can use a small subset
of SC rather than either full CJK file. Downloads are shared within the
session; each PDF embeds only its own subsets. Greek, Cyrillic, Han, kana
and Hangul remain searchable and selectable. There is no bidi, complex
shaping or emoji support: uncovered Arabic, Hebrew, Indic, Thai, emoji
and rare symbols print as `?`. Non-WinAnsi controls, format characters
and default-ignorable characters (including the combining grapheme joiner)
also print as `?`, even if a font maps them. The cover discloses substitutions actually drawn, not
ones hidden by truncation. The hash always covers the original rows. A
missing or corrupt required file rejects the export; the dashboard shows
an error toast and downloads nothing (#1732, #2032).

Columns follow first-seen own keys across every row; absent keys print blank.
If new keys widen the table beyond 18 minimum-width landscape columns, the
remaining columns continue on additional pages with the same row order.
Reports whose first row already names every column retain the old layout.
