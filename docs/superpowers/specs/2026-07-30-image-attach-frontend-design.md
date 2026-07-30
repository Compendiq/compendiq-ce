# Images as AI source material — frontend

**Issue:** #1154 (this is the half that closes it)
**Backend:** landed in #1181 (`c53be31`)
**Date:** 2026-07-30
**Status:** design of record

The backend accepts an image as source material for Generate and Improve. Nothing
user-visible ships until this half exists: there is currently no reference to
`vision`, `imageHandle`, `prepare-image` or `SUPPORTED_IMAGE_FORMATS` anywhere in
`frontend/src`.

Backend design of record: `2026-07-29-image-ai-source-material-design.md`.
ADR-021's `#1154` amendment carries the capability and staging rules.

## What the backend already gives us

- `POST /api/llm/prepare-image` — multipart, magic-byte sniffed, stages raw bytes
  in Redis under `llm:img:<userId>:<sha256>` with a 900 s TTL. Returns
  `{ handle, format, width, height, fileSize }`.
- `imageHandle` on `GenerateRequestSchema` and `ImproveRequestSchema`
  (`packages/contracts/src/schemas/llm.ts:61,82`). Refused with 422 unless the
  resolved `chat` model has *probed* as vision-capable; 410 on an expired handle;
  503 when staging is unreachable.
- `vision: z.boolean().nullable()` on `UsecaseDefaultSchema`
  (`packages/contracts/src/llm.ts:90`). `null` means probed-but-undetermined and
  is deliberately distinct from `false`.
- `SUPPORTED_IMAGE_FORMATS = ['png','jpeg','webp','gif']`. **SVG is never
  accepted** by the endpoint.

**This PR needs no backend change.**

## Decisions

### Every Generate/Improve surface takes both attachment kinds

Today the surfaces are inconsistent: `/ai` Generate sends `documentText`, the
dock's Improve chip sends `referenceText`, and `/ai` Improve has no attachment
affordance at all (`ImproveMode.tsx` contains no reference to `document` or
`referenceText`).

| Surface | document | image |
| --- | --- | --- |
| `/ai` Generate (`GenerateMode.tsx`) | exists | **new** |
| `/ai` Improve (`ImproveMode.tsx`) | **new** | **new** |
| dock Improve chip (`DockPanel.tsx`) | exists | **new** |

Adding document upload to `/ai` Improve is a #1131 gap-fill riding along in a
#1154 PR. That is deliberate — the alternative was shipping a screen that accepts
a screenshot but refuses a PDF — and it must be called out in the PR description
so it is not mistaken for scope creep.

### A document and an image can be attached at the same time

Two independent slots, matching the backend, which accepts both fields together.
The cost is a real context-overflow risk, handled under *Error handling* below.

### Every image is normalised in the browser

Fit within **1568 px** on the longest edge, re-encoded **WebP at q=0.92**.

- **Fit, never enlarge.** A 1280×800 image stays 1280×800. 1568 is a ceiling, not
  a target; upscaling costs bytes for zero information.
- 1568 px is where most vision encoders top out, so larger uploads are wasted
  transfer and wasted Redis.
- q=0.92 rather than 0.90 buys back some text sharpness in screenshots — the
  feature's core input — at negligible size, because the payload is already small
  once scaled.
- This is greenfield: `createImageBitmap`, `canvas.toBlob`, `toDataURL`,
  `OffscreenCanvas` and `drawImage` have **zero** occurrences in `frontend/src`
  today. The only image-intake prior art is `Editor.tsx`'s paste handler
  (`:1524-1535`) and its `MIME_TO_EXT` allowlist (`:1132-1137`), which happens to
  list the same four formats.

### The image affordance is always visible, and disabled with a distinct reason

`vision` is a tri-state and the UI must not collapse it to a boolean.

| `vision` | Trigger | Reason surfaced |
| --- | --- | --- |
| `true` | enabled | — |
| `false` | disabled | "`<model>` can't read images — assign a vision-capable model in Settings → LLM" |
| `null` | disabled | "Image support for `<model>` isn't confirmed yet — try again shortly" |

Always visible rather than hidden, so a user on a text-only model can discover
that the capability exists and that switching models unlocks it. Document attach
stays enabled regardless, since documents need no vision.

The app has **no `Tooltip` primitive** (`@radix-ui/react-tooltip` is not a
dependency), so the reason ships as a native `title`, which is the dominant
pattern on these surfaces already — e.g. `DockPanel.tsx:258-259`.

### The Settings badge annotates the resolved model

`UsecaseAssignmentsSection.tsx`'s fourth column already renders
`→ {providerName} / {model}`; the badge goes there, beside the model it describes.

**Badging the `ModelPicker` dropdown is explicitly out of scope and must stay
that way.** `getVisionCapability` *schedules a background probe on every cache
miss*, so rendering a badge per option against a 30-model dropdown would fire 30
chat-completion probes at the provider on mount.

The badge reads `GET /llm/usecase-default?usecase=chat`, which already returns
`vision`. `/admin/llm-usecases` — the endpoint the section actually renders from
— does not. Using the same TanStack key as `AiContext` (`['llm','usecase-default','chat']`)
means the cache entry is shared, and `LlmTab.tsx:115` already invalidates it on
save, so the badge refreshes after an assignment change with no new wiring.

## Architecture

A headless hook owns attachment logic; the zones are presentational.

The forcing function is three consumers of identical logic, not speculation:
`GenerateMode` holds two `useState`s today, `DockPanel` holds one, `/ai` Improve
holds none. Two slots across three surfaces would otherwise mean six pieces of
hand-rolled state and three copies of drop routing.

```
                    ┌─────────────────────────────┐
  click paperclip ──┤                             │
  drop on composer ─┤   useAttachments.pickFile   │
  paste (Ctrl+V) ───┤                             │
                    └──────────┬──────────────────┘
                               │  route on MIME, then isAccepted()
                  ┌────────────┴────────────┐
                  ▼                         ▼
        downscaleImage()            useExtractDocument()
                  │                         │
                  ▼                         ▼
        usePrepareImage()          { text, filename,
                  │                  pageCount, truncated }
                  ▼
        { handle, format, w, h, previewUrl }
```

### New files

| File | Responsibility |
| --- | --- |
| `shared/lib/downscale-image.ts` | `downscaleImage(file) → { blob, width, height }`. No React. The only place canvas is touched, so the only place canvas needs mocking. |
| `shared/hooks/use-prepare-image.ts` | Multipart `POST /api/llm/prepare-image`. Deliberate near-clone of `use-extract-document.ts`. |
| `shared/hooks/use-attachments.ts` | Owns both slots; routes drop/paste/pick; exposes `{ document, image, pickFile, removeDocument, removeImage, isBusy }`. |
| `shared/components/upload/ImageAttachZone.tsx` | Presentational: trigger, thumbnail chip, tri-state disabled reason. No fetch, no canvas. |
| `shared/components/badges/VisionBadge.tsx` | House pattern: `Record<state, {label,title,badgeClass}>` config plus one `rounded-full` span, tooltip as a `title` config field (cf. `ConfidenceBadge.tsx:26-46`). |

`use-prepare-image.ts` mirrors `use-extract-document.ts` rather than using
`apiFetch`, because `apiFetch` forces a JSON `Content-Type` (see that file's
`:12-14`). It keeps the same one-instance-per-surface contract and its
`isPreparing` flag must be threaded down to consumers — that is the #940 bug.

### Modified files

| File | Change |
| --- | --- |
| `shared/components/upload/DocumentUploadZone.tsx` | Stops calling `extract(file)`; reports the picked file upward and takes attachment state as a prop. |
| `features/ai/AiContext.tsx` | Exposes `chatVision`. The query at `:535-544` already fetches `vision` and discards it, reading only `.model`. |
| `features/ai/modes/GenerateMode.tsx` | Uses the hook; adds `imageHandle`. |
| `features/ai/modes/ImproveMode.tsx` | Uses the hook; adds `referenceText` **and** `imageHandle`. |
| `features/ai/dock/DockPanel.tsx` | Uses the hook; renders `ImageAttachZone`. |
| `features/ai/dock/use-dock-actions.ts` | `imageHandle` option beside `referenceText`. |
| `features/settings/panels/UsecaseAssignmentsSection.tsx` | Renders `VisionBadge` in the resolved-value column. |

`DocumentUploadZone` is the only file carrying regression risk, and the change is
deliberately narrow. Everything that exists because a simpler version broke stays
untouched: `dragDepth` counting rather than toggling (`:195-207`), the ancestor
drop-target widening (`:230-252`), the empty `dragProps` when `dropTargetRef` is
set (`:216-225`), the truncation warning (`:270-279`), and the deliberately-loose
extension-**or**-MIME `isAccepted()` (`:85`).

## Data flow

### Routing

MIME first (`type.startsWith('image/')`), mirroring `Editor.tsx:1524-1535`, then
falling through to `isAccepted()`. Matching neither produces one toast naming both
accepted sets.

**Paste is new to these surfaces.** `DocumentUploadZone` has no clipboard handling
at all. The hook attaches a `paste` listener to the composer container and takes
the first `image/*` item from `clipboardData.items`. A paste carrying both text and
an image leaves the text to the textarea and intercepts only the image.

### Three client-side rejections, each with its own message

- **SVG is refused, not rasterized.** `image/svg+xml` passes a naive `image/*`
  test, and the browser *could* legally draw it to a canvas and hand the server
  WebP — technically satisfying the endpoint. We decline: the docs commit to "SVG
  is never accepted" as a stated boundary, and silently flattening a vector
  diagram to a 1568 px raster is a lossy surprise rather than a convenience.
  Deliberate SVG rasterization is a reasonable follow-up feature; it must not
  arrive as a side effect of MIME matching.
- **Animated GIF flattens to frame 1**, because always-normalize routes it through
  the canvas. This is a side benefit — it disposes of the animated-GIF-rejected-by-provider
  problem — and the chip says so, so the user is not surprised.
- **HEIC fails to decode** in Chrome and Firefox (Safari can). Its own message —
  "Convert to PNG or JPEG first" — not a bare decode error.

### Handle into request body

```
GenerateMode      body.documentText   + body.imageHandle
ImproveMode       body.referenceText  + body.imageHandle     ← referenceText is new here
use-dock-actions  referenceText opt   + imageHandle opt
```

`runStream` (`AiContext.tsx:658`) stays a dumb pass-through, so every field is
added by its caller, exactly as today.

Two properties follow from content-addressed staging: re-attaching identical bytes
yields the **same handle** and merely re-`SET`s the TTL, so a duplicate attach is
free; and the handle survives regenerate/retry inside the 15 minutes, because
staging is not consumed on read.

### Lifecycle

- **Expiry.** **Corrected during Task 7.** Two things this section originally got
  wrong. First, `ApiError`'s field is **`statusCode`**, not `status`
  (`api.ts:5-13`) — `err.status === 410` is `undefined === 410` and never fires.
  Second, and more fundamental: `runStream` **swallows every error**
  (`AiContext.tsx:791-816` catches, toasts, calls `failLastMessage`, and ends in
  `finally` with no rethrow), so a `try/catch` around `runStream` is unreachable
  code.

  The shipped mechanism is an additive `onError?: (err: unknown) => boolean` on
  `runStream`'s options. Returning `true` claims the error: `runStream` skips its
  toast and its inline error bubble because the caller has explained it in
  context. Every existing caller passes nothing and is unchanged — which is why
  this was chosen over making `runStream` rethrow, an option that would have
  turned every current caller into an unhandled rejection.

  On `statusCode === 410` the caller clears the image slot, **restores** the
  prompt text, and toasts "The image expired — attach it again". Note *restores*,
  not *preserves*: `handleGenerate` has already run `setInput('')` by then, so
  leaving the input alone would lose what the user typed.
- **Capability regressed mid-session.** On `422` the slot is kept but disabled and
  the server's message is surfaced verbatim — the server is authoritative, and its
  wording already distinguishes "cannot accept images" from "not confirmed yet".
- **Object URLs.** The thumbnail is `createObjectURL(downscaledBlob)`, revoked on
  remove and on unmount. This is the one leak this design can introduce, so it
  gets its own test.
- **Page change.** The dock clears its reference document when `pageId` changes
  (`DockPanel.tsx:51-53`); the image follows the same rule, for the same reason —
  it is material for the next action, not part of the conversation.

## Error handling

### The decode is the dangerous part

Always-normalize means every image is decoded, which turns a careless file into a
memory problem: a 20000×20000 PNG is tens of KB compressed and ~1.6 GB decoded.

**Corrected 2026-07-30, during Task 1 review.** An earlier draft of this section
specified `createImageBitmap(file, { resizeWidth, resizeHeight, resizeQuality })`
and claimed it "decodes and scales in one pass and never materialises the
full-size bitmap". **That is not implementable.** `resizeWidth`/`resizeHeight`
require knowing which edge is longest, which requires the intrinsic dimensions,
which requires decoding first. Passing `resizeWidth` alone preserves aspect ratio
but would enlarge small images and leaves the other axis uncapped. Do not
reintroduce it.

What actually happens: `createImageBitmap(file)` decodes at full size, and the
fit-don't-enlarge arithmetic then runs against `bitmap.width`/`bitmap.height`
before the canvas draw.

Two ceilings guard this, and they bound different things:

| Constant | Bounds | Blind to |
| --- | --- | --- |
| `MAX_SOURCE_IMAGE_BYTES` (30 MB) | compressed bytes, before any decode | compression ratio — a near-solid-colour 20000×20000 PNG is tens of KB |
| `MAX_SOURCE_PIXELS` (40 MP) | decoded pixels, immediately after decode | the decode's own peak allocation |

40 MP sits above an 8K screenshot (7680×4320 = 33 MP) and far below the
pathological cases. The pixel check cannot prevent the decode's own allocation —
nothing can, short of parsing dimensions out of the file header, which is
`backend/src/core/services/image-validator.ts`'s job and is not duplicated here.
What it does prevent is the canvas allocating a second buffer on top of the
first, and it turns a pathological image into a clear message rather than a hang.

**Residual risk, accepted:** a file that is small compressed and enormous decoded
spikes memory between the decode and the pixel check. It is the user's own file
in their own tab, and the blast radius is one browser tab. Porting the backend's
header parser to the frontend would close it properly and is the obvious upgrade
if this ever bites.

Both paths are gated by an explicit ceiling on the *input* file, exported from the
same module:

```ts
export const MAX_SOURCE_IMAGE_BYTES = 30 * 1024 * 1024; // 30 MB
```

This is distinct from the backend's `MAX_IMAGE_BYTES` (10 MB), which bounds the
*staged, post-downscale* bytes. 30 MB is generous enough for a raw 5 K screenshot
or a phone photo while refusing a file no legitimate attach produces, and it
applies before any decode is attempted — including on the `createImageBitmap`
path, which still has to parse the container. Exceeding it is a client-side
message, never a request.

### Most backend rejections become unreachable

Because every upload leaves the browser as WebP at ≤1568 px:

| Backend response | Reachable from this UI? |
| --- | --- |
| 415 unsupported format | No — only WebP is ever sent; SVG/HEIC refused client-side |
| 415 extension mismatch | No — the filename is set to match the re-encode |
| 422 oversized dimensions | No — 1568 ≪ 4096 |
| 413 too large | No — a 1568 px WebP is a few hundred KB against a 10 MB cap |
| 503 staging unavailable | **Yes** — Redis down |
| 410 expired handle | **Yes** |
| 422 capability gate | **Yes** |

Not a reason to skip those paths in tests; a reason the client-side messages carry
the real UX weight.

### The two-slot context risk

Both slots filled means up to 80 K characters of document text plus an image plus
(for Improve) the page body. On an 8 K-context model the provider answers with a
context-length error that reads like a bug.

**Advisory, not a block.** When both slots are filled the composer shows the amber
`AlertTriangle` helper line already used for truncation warnings
(`DocumentUploadZone.tsx:271-279`), noting that both attachments will be sent and
a small model may not fit them. Not a block, because a 128 K model handles it
fine and the frontend cannot know the context window — `/v1/models` does not
report it. The provider stays the arbiter; the user is simply not ambushed.

## Testing

Vitest + jsdom + `@testing-library/react`. Mocked at the **network** boundary,
never at the service-function layer. Pure utilities tested directly.

| Suite | Covers |
| --- | --- |
| `downscale-image.test.ts` | Policy, not pixels: aspect ratio preserved; 5120×2880 → 1568×882; **1280×800 stays 1280×800**; `image/webp` and `0.92` reach `toBlob`; fallback path triggers when the resize overload is absent. |
| `use-attachments.test.ts` | Routing truth table: PNG → prepare, PDF → extract, SVG → own message, HEIC → own message, unknown → one toast naming both sets. Paste carrying text + image leaves the text alone. |
| `use-prepare-image.test.ts` | `FormData` body, bearer header, one-shot 401 refresh, error surfacing. |
| `ImageAttachZone.test.tsx` | The tri-state: `false` and `null` produce **different** text, and the reason names the model. This is the test that stops someone collapsing the tri-state to a boolean. |
| `VisionBadge.test.tsx` | Three states render distinct label and `title`. |
| `GenerateMode` / `ImproveMode` / `DockPanel` | `imageHandle` reaches the body; `ImproveMode` now sends `referenceText`; a 410 clears the image slot and keeps the prompt; send respects `isBusy`. |
| Object-URL lifecycle | Revoked on remove and on unmount. |
| `UsecaseAssignmentsSection` | Badge on the chat row only. |

jsdom has no real canvas and the repo has no canvas dependency, so
`downscale-image.test.ts` mocks `createImageBitmap` and `toBlob` and asserts the
decisions — which is what actually regresses.

### Regression canaries

`GenerateMode.extracting.test.tsx` (the #940 `isExtracting` behaviour) and
`AiDock.upload.test.tsx` guard the `extract()` move out of `DocumentUploadZone`.
Their prop shapes may need updating; **their assertions must not weaken.** Deleting
an assertion in either means the refactor changed behaviour — stop and flag it
rather than adjust the test.

### UI guardrails

- Card surfaces paint a **gradient**, i.e. a background-*image*, so a Tailwind
  `hover:bg-*` utility is painted underneath and does nothing. The chip uses
  **`nm-card-hover`**; a test walks the `.tsx` sources and fails on the wrong
  combination.
- Every interactive surface keeps its 1 px `--color-border-interactive` border for
  WCAG 1.4.11, verified by `neumorphic-themes.test.ts`, which *computes* contrast
  ratios rather than pinning hex values.
- Amber is reserved for warning/attention only (ADR-010), which is why the
  both-slots advisory is amber and the vision badge is not.

## Out of scope

- **Re-probe action and `probe_error` display** → #1184. The badge should land
  first so #1184 has an anchor.
- **Deliberate SVG rasterization** — a separate feature with its own fidelity
  decision, not a side effect of MIME routing.
- **Capability badges in the `ModelPicker` dropdown** — would fire one probe per
  listed model. See the Settings decision above.
- **Redis staging capacity** → #1183. The 1568 px WebP normalisation here reduces
  staged bytes by roughly an order of magnitude versus raw uploads, which makes
  that ceiling far less likely to be reached, but does not raise it.
- **Image input on `/llm/ask`** — the backend does not accept it there.

### If the PR grows too large

The natural seam is `/ai` Improve's **document** upload — the #1131 gap-fill. It is
the only part of this design not required by #1154, and dropping it leaves a
coherent PR (image on all three surfaces, document unchanged from today) at the
cost of keeping the asymmetry one release longer. Split there rather than splitting
the image work across surfaces, which would ship a half-wired capability.

## Accepted risk, restated

Prompt injection rendered as pixels reaches the model untouched.
`sanitizeLlmInput` is text-only and cannot inspect an image; the only mitigation
would be an OCR pass, which the backend design rejects outright. This is recorded
in ADR-021, in `CLAUDE.md`, and on #1154 itself. Nothing in this frontend design
changes it, and no part of this UI should imply otherwise.
