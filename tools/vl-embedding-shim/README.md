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

Both build the identical prompt, so a vector from one is comparable to a vector
from the other **within one model** — not across models, and not against
production (see [Fidelity](#fidelity-what-these-vectors-are-and-are-not)).

---

## Quick start

```bash
cd tools/vl-embedding-shim
python3 -m venv .venv && ./.venv/bin/pip install -e '.[dev]'
```

### Backend (b): `llama` — the 8B GGUF

```bash
export QWEN3_VL_GGUF=/path/to/Qwen3-VL-Embedding-8B-Q6_K.gguf
export QWEN3_VL_MMPROJ=/path/to/mmproj-Qwen3-VL-Embedding-8B-f16.gguf
./scripts/run-llama-server.sh                 # llama-server on :8090

./.venv/bin/python -m vl_embedding_shim --backend llama   # shim on :8011
```

The paths are environment variables on purpose. A checkpoint lives wherever you
put it — an LM Studio models folder, a downloads directory — and a hardcoded
`$HOME/.lmstudio/...` in a committed script works on exactly one machine.

### Backend (a): `mlx` — the 2B MLX build

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

`image_url.url` takes a `data:` URI or an `http(s)` URL. The trailing empty
`assistant` message is accepted and required to be empty: with
`continue_final_message: true` it is a continuation point, not a turn, and
non-empty content there would be silently dropped, so it is refused instead.

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

Errors use OpenAI's `{"error": {...}}` envelope. A bad body is **400**, an
unreachable or unhappy backend is **502** — the distinction matters to a caller
with a circuit breaker.

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
punctuation gets a period appended, matching the reference embedder.

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
in v1 — the model server resizes to its own trained budget of **1,310,720 px**
(≈1280 visual tokens; `preprocessor_config.json`'s `max_pixels`, which the paper
confirms is what training saw). Bigger is not better past that point: the
paper's granularity study reports a slight *regression* at the highest resource
levels. `--max-pixels 1310720` turns the budget into a **guard** — an oversized
image is refused with both numbers named — but there is still no resizer.
Unset (the default) nothing is decoded at all.

**(6) One backend per process.** See [RAM](#ram-one-backend-per-process-one-process-at-a-time).

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
| `--no-remote-images` | – | remote URLs allowed |
| `--no-instruct-conversion` | – | conversion on |
| `--request-timeout` | – | `300` s |

`run-llama-server.sh` reads `QWEN3_VL_GGUF`, `QWEN3_VL_MMPROJ`, and optionally
`LLAMA_SERVER`, `LLAMA_PORT` (8090), `LLAMA_HOST`, `LLAMA_CTX` (8192),
`LLAMA_BATCH` (2048).

Port choices: **8011** for the shim and **8090** for llama-server, because 1234
is LM Studio's and 8081 is the app's.

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

### Known upstream problems this shim works around or refuses

* **llama.cpp's media marker is randomised per server process.** The literal
  `<__media__>` from the README no longer works; `/props` reports the real
  marker and a count mismatch produces `mtmd_tokenize: error: number of media
  markers in text (0) does not match number of bitmaps (1)`. The shim reads
  `/props`, substitutes one marker per image, and refuses to send an image at
  all when `/props` reports `modalities.vision != true` or carries no marker.
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
