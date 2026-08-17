# vl-embedding-shim — local Qwen3-VL-Embedding, in vLLM's request shape (#1115)

**Dev only. Production is vLLM ≥ 0.14 with `--runner pooling`.** This is not a
supported serving path, it is not deployed, and nothing in `backend/` imports it.
It exists so a laptop can exercise the *same* request/response contract the
production image-embedding client will speak, before that client exists.

It exposes `POST /v1/embeddings` in vLLM's chat-template embeddings shape over
two interchangeable local backends:

| backend | what it is | needs |
|---|---|---|
| `mlx` | in-process [`mlx-embeddings`](https://github.com/Blaizzy/mlx-embeddings) | Apple Silicon, `pip install -e '.[mlx]'`, an MLX checkpoint |
| `llama` | proxy to a `llama-server` you started | `llama-server` with `--mmproj`, a GGUF + its vision projector |

Both build the identical prompt (with one named exception — an explicitly empty
system message, under rule 1 below) and both encode an image at the same pixel
budget (rule 5), so a vector from one is comparable to a vector from the other
**within one model** — not across models, and not against production (see
[Fidelity](#fidelity-what-these-vectors-are-and-are-not)).

---

## Quick start

```bash
cd tools/vl-embedding-shim
python3 -m venv .venv && ./.venv/bin/pip install -e '.[dev]'
```

### The `llama` backend — a GGUF through llama-server

```bash
export QWEN3_VL_GGUF=/path/to/Qwen3-VL-Embedding-8B-Q6_K.gguf
export QWEN3_VL_MMPROJ=/path/to/mmproj-Qwen3-VL-Embedding-8B-f16.gguf
./scripts/run-llama-server.sh                 # llama-server on :8090

./.venv/bin/python -m vl_embedding_shim --backend llama   # shim on :8011
```

The paths are environment variables on purpose. A checkpoint lives wherever you
put it — an LM Studio models folder, a downloads directory — and a hardcoded
`$HOME/.lmstudio/...` in a committed script works on exactly one machine.

### The `mlx` backend — an MLX checkpoint in-process

```bash
./.venv/bin/pip install -e '.[mlx]'
./.venv/bin/python scripts/download-model.py       # ~2.5 GB into the HF cache
./.venv/bin/python -m vl_embedding_shim --backend mlx
```

`--mlx-model` also takes a **local directory**, so an LM Studio folder that
already holds an MLX build needs no download:

```bash
./.venv/bin/python -m vl_embedding_shim --backend mlx --mlx-model ~/models/Qwen3-VL-Embedding-2B-8bit
```

### RAM: one backend per process, one process at a time

The shim serves exactly one backend per process by design, and on a 24 GB
machine you should run **only one of them at a time**. The 8B Q6_K GGUF is
6.2 GB of weights plus a 1.16 GB projector plus an 8192-token KV cache; the 2B
MLX build is 2.5 GB and MLX allocates in unified memory shared with everything
else. Stop `llama-server` before starting the MLX backend.

---

## The request shape

### `messages` — the production shape (design D4)

```bash
curl -s localhost:8011/v1/embeddings -H 'content-type: application/json' -d '{
  "model": "qwen3-vl-embedding",
  "messages": [
    {"role": "system",    "content": [{"type": "text", "text": "Retrieve images or text relevant to the user'\''s query."}]},
    {"role": "user",      "content": [{"type": "image_url", "image_url": {"url": "data:image/png;base64,…"}},
                                      {"type": "text", "text": "ein Turm"}]},
    {"role": "assistant", "content": [{"type": "text", "text": ""}]}
  ],
  "encoding_format": "float",
  "continue_final_message": true,
  "add_special_tokens": true,
  "dimensions": 1024
}'
```

A `messages` array is **one prompt**, so this shape always answers exactly one
embedding — that is vLLM's semantics, not a shim limitation.

#### The continuation is enforced, not assumed

The prompt has to end with `<|im_start|>assistant\n` and nothing after it,
because that final newline is the position whose hidden state becomes the
vector. vLLM's `EmbeddingChatRequest` defaults **both** `continue_final_message`
and `add_generation_prompt` to `false`, so a body carrying neither renders the
user turn closed by `<|im_end|>\n` and pools *that* — silently, with a
plausible-looking vector.

The shim always builds the continued prompt, so accepting such a body would
answer the **right vector for the wrong request**, and a client developed green
against this server would then ship off-distribution vectors to production.
That is the exact mistake this tool exists to let a laptop catch, so it is a
**400**. Two forms are accepted, because vLLM renders both to the same bytes:

* a trailing **empty** `assistant` turn + `continue_final_message: true`
  (vLLM's own example, design D4 — the shape above); or
* **no** trailing assistant + `add_generation_prompt: true` (what the reference
  embedder's `apply_chat_template` call does).

Both at once is refused, because transformers refuses that pair outright. A
trailing assistant with non-empty content is refused too — it is a continuation
point, not a turn, and its content would be silently dropped. **The shim is
deliberately stricter than vLLM here**, in the safe direction: every body it
accepts renders identically on vLLM *apart from two client-side normalisations
the shim performs and vLLM does not* — see
[Fidelity](#fidelity-what-these-vectors-are-and-are-not).

`add_special_tokens` is **accepted in either polarity and ignored**: the shim
hands a prompt *string* to a backend that tokenizes it, so there is no
tokenizer-level flag here to honour, and the template's `<|im_start|>` markers
are ordinary text in that string rather than tokenizer-added specials. Pass
`true`, as vLLM's example does. It is the one field of this shape whose
handling the shim does not verify for you.

#### Content parts: image first, and a part's kind is decided rather than assumed

The prompt is built images-then-text, the reference builder's order. **vLLM does
not do this**: `chat_template.jinja` iterates `message.content` in order and
emits the vision markers where the caller put them, so `[text "a", image,
text "b"]` renders as `a<image>b` there and `<image>ab` here — measured at
**cos 0.588 and 0.657** on the 8B (two different images), a *larger* divergence
either way than the missing-continuation body above, which measures 0.953/0.957
on the same pairs. Silently normalising it is the same mistake as silently
accepting that body, so **a text part before an image part is a 400**: put the
image parts first, as D4 does, and the two agree byte-for-byte. An *empty* text
part before an image is fine — it renders nothing either way, and vLLM's own
image-only example sends exactly that.

A part's kind is read the way this checkpoint reads it. `chat_template.jinja`
calls a part an image when `content.type == 'image' or 'image' in content or
'image_url' in content`, and vLLM accepts a **type-less** `{"image_url": …}` as
its documented simple image form while refusing every other type-less part with
`Missing 'type' field in multimodal part`. So:

| part | here |
|---|---|
| `{"type": "image_url", "image_url": {"url": …}}` | image (the D4 spelling) |
| `{"image_url": …}`, no `type` | image (vLLM's simple form) |
| `{"image": …}` or any other type-less part | **400** — it is an image to the jinja and not a part at all to vLLM |
| `{"type": "image", …}` | **400** — `image` is not a vLLM part type |
| an image part in `system` or the trailing `assistant` | **400** — the jinja renders no marker there, so vLLM would carry one image against zero placeholders |

The type-less rows matter because the alternative is silence: read as text, an
image part becomes an *empty* one, and an image-only body then embeds the
literal string `NULL` and answers 200 — a vector measured **cos 0.169** from
the one the same body produces now.

`image_url.url` takes a `data:` URI, or an `http(s)` URL **only when the shim
was started with `--allow-remote-images`** — off by default, because a server
that fetches an arbitrary URL on request issues GETs on behalf of anything that
can reach it. Redirects are never followed even when it is on, and a fetched
image is bounded by `--max-body-bytes`, the same ceiling as an inbound body: a
request that names a URL reaches the same allocation through a second door.

### `{model, input}` — the plain shape

```bash
curl -s localhost:8011/v1/embeddings -H 'content-type: application/json' \
  -d '{"model": "m", "input": ["erster Satz", "zweiter Satz"]}'
```

One embedding per string, in order — the shape the app's own `generateEmbedding`
posts and the retrieval eval drives. **Each string still goes through the chat
template**, under the default instruction. It is never sent untemplated: a bare
string pools a different position and lands off the training distribution.

### Other routes

* `GET /v1/models` — the served id (also `/models`)
* `GET /healthz` — backend, model, vision, and for `llama` the media marker and
  `n_ctx`. **503** when the backend cannot be reached.
* `POST /embeddings` — alias of `/v1/embeddings`, for curl.

Both diagnostics re-read the backend rather than answer from cache: they are
what you check after restarting llama-server, and that restart is exactly what
invalidates the cached answer.

Errors use OpenAI's `{"error": {...}}` envelope. A bad body is **400**, one over
`--max-body-bytes` is **413**, an unreachable or unhappy backend is **502** —
the distinction matters to a caller with a circuit breaker.

`usage` is always `{"prompt_tokens": 0, "total_tokens": 0}`. The shim does not
tokenize and llama-server's `/embedding` reports no counts; zero is the honest
answer, and an invented estimate is a number someone eventually trusts.

---

## The load-bearing rules

**(1) The default instruction is `Represent the user's input.`, and the shim
never invents one.** Anything without an explicit system message gets that
default — documents *and* queries, unlike Qwen3-Embedding where the corpus side
is deliberately bare. The canonical query instruction is

> `Retrieve images or text relevant to the user's query.`

and it is exported as a constant, **not applied automatically**: a caller who
wants it passes it as the system message. Applying it by default would put a
query instruction on every document too, destroying the asymmetry the official
examples exist to create. Instructions are written in **English even for a
non-English corpus** (model-card guidance). An instruction that does not end in
punctuation gets a period appended, matching the reference embedder — **vLLM
does not do this** and it is worth up to cos 0.95, so a production client has to
append it itself; see [Fidelity](#fidelity-what-these-vectors-are-and-are-not).
An
**explicitly empty** system message is the one thing that is not the default: it
is a system message the caller wrote, `chat_template.jinja` renders it as
`<|im_start|>system\n<|im_end|>\n`, and filling the default in there would be
the shim inventing an instruction the caller declined. (That single body is also
the one place the two backends genuinely differ: `mlx-embeddings` builds its
system turn as `instruction or <its default>`, so an empty instruction becomes
the default there and there is no API to say otherwise. `llama` emits the empty
system message.)

**(2) The plain `{model, input}` shape is accepted, and a flat `Instruct:` form
is converted.** The app prefixes instruction-aware embedding models with
Qwen3-Embedding's flat form (#1329, `query-instruction.ts`):

```
Instruct: {task}\nQuery:{query}
```

That convention belongs to the **text** family. The VL family uses a chat
template instead, and the two are unrelated — sending the flat string through as
user content would nest a task description *inside* the user turn underneath the
default system instruction, so the model would be asked to represent a sentence
that happens to describe a task. The shim therefore splits it back into
`system={task}`, `user={query}` and **logs that it did**, so a text-parity number
measured through this server is template-correct rather than a measurement of a
mistake. The split is byte-narrow (`Instruct: ` + `\nQuery:`, no space after the
colon) and applies to the plain shape only — a caller who spells the flat form
inside a `messages` user turn meant it. `--no-instruct-conversion` turns it off.

**(3) `dimensions` truncates to the first N components and re-normalises.**
Whether vLLM re-normalises after truncation is unverified upstream, and MRL
truncation mathematically requires it before any cosine comparison. `N` above
the model's native width is **refused**, not zero-padded.

**(4) Output is always L2-normalised.** The checkpoint's `2_Normalize` and
llama-server's `--embd-normalize 2` both do it; the shim re-does it so a backend
that forgets cannot ship a vector whose "cosine" is a dot product.

**(5) The shim does not resize images.** Over-budget images are passed through
in v1 and the model server does its own resizing. The **checkpoint's** budget is
**1,310,720 px** (≈1280 visual tokens; `preprocessor_config.json`'s
`max_pixels`, which the paper confirms is what training saw), and bigger is not
better past that point: the paper's granularity study reports a slight
*regression* at the highest resource levels. `--max-pixels 1310720` turns that
number into a **guard** — an oversized image is refused with both numbers named
— but there is still no resizer.

That number is the checkpoint's, **not a promise about either server**. On `mlx`
the shim *holds* the library to it: `mlx-embeddings` 0.1.0 stamps its own
`max_pixels` onto every image and defaults it to the reference script's
permissive **1,843,200** (1800 visual tokens), 1.41× the trained budget and the
figure the research pack warns is plausibly *worse* rather than merely slower,
so the field is re-pinned after the model loads. On `llama` the bytes go to
llama-server, which applies whatever preprocessing its `mmproj` carries; `/props`
reports nothing about pixels (checked on build b10450), so the shim can neither
set nor read it there.
Unset (the default) that *guard* decodes nothing — which is not "the shim
decodes nothing": `llama` forwards the bytes to llama-server untouched, while
`mlx` always opens them with Pillow and converts to RGB, so a format Pillow
cannot read reaches the model server on `llama` and is a **502** on `mlx`.

**(6) One backend per process.** See [RAM](#ram-one-backend-per-process-one-process-at-a-time).

**(7) The `messages` contract is enforced, and remote fetching is opt-in.** A
body vLLM would not render as a continuation is a 400 rather than a vector (see
[The continuation is enforced](#the-continuation-is-enforced-not-assumed)), and
so is a body whose content parts would render differently there — a text part
before an image, or a part whose kind the shim would have to guess at. An
`http(s)` `image_url` needs `--allow-remote-images`, never follows a redirect,
and is read against `--max-body-bytes`; a body over that ceiling (32 MiB) is a
413 before it is parsed.

### Throughput is not a goal

Embedding is **serialised behind one lock**, and the `llama` backend sends one
HTTP request per input. Neither backend wants to be re-entered — `mlx` runs the
model in-process and has its position-id cache reset immediately before each
call, and `llama` is one local server with four slots sharing an 8192-token
context — and the model dominates the wall clock anyway. The work runs in a
threadpool rather than on the event loop, so `/healthz` and `/v1/models` stay
answerable while an embed is in flight.

---

## Flags

| flag | env | default |
|---|---|---|
| `--backend {llama,mlx}` | `VL_SHIM_BACKEND` | `llama` |
| `--host` / `--port` | `VL_SHIM_HOST` / `VL_SHIM_PORT` | `127.0.0.1` / `8011` |
| `--llama-base-url` | `VL_SHIM_LLAMA_BASE_URL` | `http://127.0.0.1:8090` |
| `--mlx-model` | `VL_SHIM_MLX_MODEL` | `mlx-community/Qwen3-VL-Embedding-2B-8bit` |
| `--model-id` | `VL_SHIM_MODEL_ID` | the backend's own answer |
| `--max-pixels` | `VL_SHIM_MAX_PIXELS` | unset (no guard) |
| `--allow-remote-images` | `VL_SHIM_ALLOW_REMOTE_IMAGES` | **off** — `data:` URIs only |
| `--max-body-bytes` | `VL_SHIM_MAX_BODY_BYTES` | `33554432` (32 MiB) — also bounds a fetched image |
| `--no-instruct-conversion` | – | conversion on |
| `--request-timeout` | – | `300` s |

Three of those defaults are security decisions rather than ergonomics — the
shim binds **loopback**, refuses **remote image URLs**, and **caps the body** —
and all three are pinned by tests (`test_config.py`), on the CLI parser as well
as the settings object, because a default nobody asserts is one edit away from
being the unsafe one. The fourth is not a flag at all: the fetching client is
built with `follow_redirects=False`, and that is asserted against **the client
the process builds**. Asserting it through an injected test client proved
nothing — httpx's own default is already `False`, so the real one could be
flipped to `True` with the suite still green (review r2), and a followed
redirect answers 200 with the metadata body and no redirect left to catch.

`run-llama-server.sh` reads `QWEN3_VL_GGUF`, `QWEN3_VL_MMPROJ`, and optionally
`LLAMA_SERVER`, `LLAMA_PORT` (8090), `LLAMA_HOST`, `LLAMA_CTX` (8192),
`LLAMA_BATCH` (2048).

Port choices: **8011** for the shim and **8090** for llama-server, because 1234
is LM Studio's and 8081 is the app's.

**`--model-id` is not a free-form label when the retrieval eval is downstream.**
The served id becomes `EVAL_EMBEDDING_MODEL`, which the app stores as the
resolved embedding model — and `wantsInstructionPrefix` (#1329) only prefixes a
query when that id contains **both `qwen3` and `embed`**. Both backends' own
answers do; `--model-id vl-shim` does not, and the run then silently measures
the un-prefixed query path. See the runbook's eval section.

---

## Tests

```bash
./.venv/bin/python -m pytest                       # unit; no model, no network
VL_SHIM_INTEGRATION=1 ./.venv/bin/python -m pytest tests/test_integration.py
```

**This tool is tested with `pytest`, not Vitest** — a deliberate deviation from
CLAUDE.md's "Vitest everywhere", which is about the TypeScript workspaces. A
Python tool tested through a JS runner would be tested through a subprocess
boundary that hides every assertion.

The exception buys a gate rather than losing one: `pr-check.yml` carries a
**`vl-embedding-shim` job** that installs `.[dev]` and runs this suite,
scoped — like `retrieval-eval` — to PRs that touch `tools/vl-embedding-shim/`,
so the fast path never waits on it. `tools/` is not an npm workspace, so
`npm test` cannot reach the suite and that job is the only thing that runs it.
The `[mlx]` extra is not installed there (mlx is Apple-Silicon only); the mlx
backend's tests drive a fake encoder through the library's `load()` seam and
run without it.

Unit tests mock at the boundary, matching the repo's rule: the `llama` backend
against `httpx.MockTransport` (HTTP), the `mlx` backend against a fake encoder
(the library's `load()` seam), and the pure layers — template, MRL, parsing,
image resolution — against real inputs.

The integration test is env-gated and hits a **running** shim. It asserts
structural properties only — unit norm, stable width, `dimensions` shortening,
an image embedding at all, and a near-paraphrase pair outscoring an unrelated
one. That last is a plumbing check, not a quality metric. There is no
CI-runnable VL model in this repository (the `retrieval-eval` job's Ollama
service container serves `nomic-embed-text`, which is text-only).

---

## Fidelity: what these vectors are, and are not

**Local vectors are for plumbing and for eyeballing ranked lists. Every number
that decides anything is measured on the production stack.** Three independent
shifts sit between here and there:

* **Quantisation.** Q6_K and 8-bit MLX are not bf16.
* **MLX-vs-CUDA numerics**, and llama.cpp-vs-reference fidelity for this model
  has never been published — the path works, nobody has measured its cosine
  agreement with the HF reference.
* **vLLM's own preprocessing divergence.** vLLM uses `transformers`'
  `video_processing_qwen3_vl` where the model officially uses `qwen_vl_utils`;
  the open issue reports **~0.92 cosine instead of 1.0** for identical inputs
  against the reference. vLLM documents the cause itself.

So: never mix vectors from two of these paths in one index, and never quote a
retrieval metric measured here as if it were a production number.

**And five things about the request shape are not identical to vLLM's**, which
matters for a client developed against this server rather than for the vectors.
The first three are refusals; the last two are the shim silently *normalising*
something vLLM renders verbatim, so they are the ones a client author has to
handle in their own code:

* `add_special_tokens` is accepted and **ignored** (the shim does not tokenize),
  so conformance to that one field is the thing this server cannot check for
  you. Everything else about the D4 body it checks strictly — see
  [The continuation is enforced](#the-continuation-is-enforced-not-assumed).
* `encoding_format` must be `float` or absent; **vLLM also accepts `base64`**
  (and the `openai` Python SDK asks for base64 by default when numpy is
  installed). The shim emits float and 400s the rest rather than answer a
  format it did not encode.
* Content parts are refused where vLLM would merely render them differently:
  **a text part before an image part** is a 400 here and an interleaved prompt
  there. That refusal is the direction this tool is stricter in.
* **An instruction that does not end in punctuation gets a period** (rule 1) —
  the reference *embedder* does that, `chat_template.jinja` does not, and vLLM
  runs the template over your messages rather than the embedder. Measured on the
  8B over 12 instruction × query pairs, the period is worth **cos 0.950–0.995**
  (`Find images matching this description` + `Wie hoch ist der Turm?` is the
  0.9502 end) — overlapping the **0.881–0.988** the missing-continuation body
  costs across those same 12 pairs, and that is a body this shim refuses
  outright. A client whose instruction already ends in punctuation is
  unaffected, and every canonical instruction in the research pack's §1.6 does
  — but the app's own `RETRIEVAL_TASK` (#1329) does **not**, and it is the
  0.9945 end of that range.
* **A user turn that comes out empty becomes the literal `NULL`** (the
  reference embedder's substitution; the jinja renders an empty user turn).
  Measured on the 8B at **cos 0.554** — the largest divergence on this page.
  Every accepted spelling of empty reaches it: `content: []`, `content: ""`,
  `{"type": "text"}` with no `text`, `{"type": "text", "text": ""}`, and
  `input: ""` on the plain shape.

Both of those last two are the reference embedder's own behaviour, which is
what a production client should reproduce — but *it* has to reproduce them,
because vLLM will not.

### Known upstream problems this shim works around or refuses

* **llama.cpp's media marker is randomised per server process.** The literal
  `<__media__>` from the README no longer works; `/props` reports the real
  marker and a count mismatch produces `mtmd_tokenize: error: number of media
  markers in text (0) does not match number of bitmaps (1)`. The shim reads
  `/props`, substitutes one marker per image, and refuses to send an image at
  all when `/props` reports `modalities.vision != true` or carries no marker.
  **Restarting llama-server under a running shim is handled**, because that is
  the dev loop (a different GGUF, a bigger batch, an added `--mmproj`): a failed
  *image* request re-reads `/props` once and retries when the marker changed,
  logging that it did, and `/healthz` and `/v1/models` never answer from the
  cache at all. A failure where the marker came back unchanged is not retried —
  nothing was learned, and doubling a real error (a batch too small for one
  image's ~1280 visual tokens, say) helps nobody.
* **llama.cpp's `/v1/embeddings` is text-only.** The PR that would have added
  image+text input there is closed and unmerged. Hence `/embedding` and a
  hand-built template.
* **`mlx-embeddings` 0.1.0 serves exactly one text request per loaded model.**
  It memoises `language_model._position_ids` and reads it back as a 3-D array,
  but the text-only branch stores a 2-D one, so the *second* text call dies with
  `ValueError: Too many indices for array with 2 dimensions`. It clears the
  cache itself only for image requests. The shim clears it before every call —
  which is also semantically right: each embedding request is an independent
  forward pass.
* **`mlx-embeddings` 0.1.0 encodes images at 1,843,200 px, not the checkpoint's
  1,310,720.** `Processor.from_pretrained` fills `max_pixels` from the library's
  own `MAX_PIXELS = 1800 * 32 * 32` — the reference script's permissive default,
  above what training saw — and stamps it onto every image content block.
  The shim sets the field on the loaded processor (`_pin_pixel_budget`) rather
  than passing `load(tokenizer_config={'max_pixels': …})`, so a release that
  stopped honouring that kwarg could not ignore it in silence. Without the pin,
  an image between the two figures is encoded differently on the two backends —
  exactly the comparability this page claims at the top.
* **`mlx-embeddings` needs `torchvision`.** Its processor loads the *slow*
  `AutoImageProcessor` (`use_fast=False`), and transformers 5 requires
  torchvision for that path. It is not in the library's declared dependencies,
  so `pip install -e '.[mlx]'` pulls it in here.
* **The `mlx-community` model cards for these checkpoints are wrong** — they
  carry a boilerplate SigLIP `generate(...)`/`logits_per_image` snippet that
  does not apply to this architecture. The API this shim uses was read from
  `mlx_embeddings/models/qwen3_vl/{model,processor}.py`.
* **Not supported for multimodal at all: LM Studio** (`/v1/embeddings` takes no
  image input) and **TEI** (no image concept anywhere in its OpenAPI spec).

---

## Operator recipe

`docs/runbooks/vl-embedding-dev.md` — including how to point the retrieval eval
at this server.
