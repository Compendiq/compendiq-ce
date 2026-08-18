# Runbook — Qwen3-VL-Embedding on a dev machine (#1115)

Answers one question: **how do I get a Qwen3-VL-Embedding model answering the
production request shape on this laptop?**

Production serves this model on **vLLM ≥ 0.14 with `--runner pooling`**, which
accepts `POST /v1/embeddings` with a `messages` array (the chat-template
extension of the OpenAI embeddings API). Nothing you can run locally speaks that
shape: LM Studio's `/v1/embeddings` takes no image input, TEI has no image
concept at all, llama-server's multimodal embeddings live on a **non**-OpenAI
route with a per-process random media marker, and `mlx-embeddings` is a library
rather than a server. So the repository ships a shim:
`tools/vl-embedding-shim/` (design D11).

Read `tools/vl-embedding-shim/README.md` for the rules the shim enforces. This
page is the operator recipe.

---

## What you need

| | |
|---|---|
| machine | Apple Silicon; 24 GB RAM is enough for **one** backend at a time |
| Python | 3.12+ (3.14 works — verified 2026-08-17, every wheel present) |
| for the `llama` backend | `llama-server` (`brew install llama.cpp`) + a GGUF **and its `mmproj-*` vision projector** |
| for the `mlx` backend | `pip install -e '.[mlx]'` + an MLX checkpoint (~2.5 GB for the 2B 8-bit) |

Ports: the shim takes **8011**, llama-server **8090**. 1234 is LM Studio's and
8081 is the app's; do not put this on either.

---

## The `llama` backend — a GGUF through llama-server (e.g. the 8B)

```bash
cd tools/vl-embedding-shim
python3 -m venv .venv && ./.venv/bin/pip install -e '.[dev]'

export QWEN3_VL_GGUF=/path/to/Qwen3-VL-Embedding-8B-Q6_K.gguf
export QWEN3_VL_MMPROJ=/path/to/mmproj-Qwen3-VL-Embedding-8B-f16.gguf
./scripts/run-llama-server.sh            # :8090, ~10 s to load

./.venv/bin/python -m vl_embedding_shim --backend llama   # :8011
curl -s localhost:8011/healthz | jq
```

A healthy answer names the model, the media marker, and — the thing to actually
check — `"vision": true`:

```json
{ "status": "ok", "backend": "llama",
  "model": "Qwen3-VL-Embedding-8B-Q6_K.gguf",
  "vision": true,
  "details": { "media_marker": "<__media_cZ1Fl…__>", "n_ctx": 8192 } }
```

`vision: false` means you started llama-server without `--mmproj`. The shim
refuses every image in that state rather than sending a prompt whose media
markers nothing will fill — which is llama.cpp issues #26201 / #25088,
`mtmd_tokenize: error: number of media markers in text (0) does not match number
of bitmaps (1)`.

**You can restart llama-server under a running shim.** The marker is randomised
per server process, so the shim's cached one dies with it — but `/healthz` and
`/v1/models` always re-read `/props`, and a failed image request re-reads it and
retries once when the marker changed, logging

```
WARNING vl_embedding_shim llama-server answered with a new media marker (… -> …) — it was restarted under this shim; retrying the request once with the new one
```

so you do not have to remember to restart both. (Text-only requests carry no
marker and are unaffected.)

The flags in `run-llama-server.sh` are not decoration: `--pooling last` matches
the checkpoint's `1_Pooling` (`lasttoken`), `--embd-normalize 2` matches its
`2_Normalize`, and `-b/-ub 2048` covers one image's ~1280 visual tokens.

## The `mlx` backend — an MLX checkpoint in-process (e.g. the 2B)

**Stop llama-server first.** 24 GB does not hold both.

```bash
cd tools/vl-embedding-shim
./.venv/bin/pip install -e '.[mlx]'
./.venv/bin/python scripts/download-model.py     # mlx-community/Qwen3-VL-Embedding-2B-8bit
./.venv/bin/python -m vl_embedding_shim --backend mlx
```

`--mlx-model` also takes a local directory, so an existing MLX folder needs no
download. The model loads on the **first request**, not at startup, so the first
call takes a few seconds and `healthz` answers `"loaded": false` until then.

`.[mlx]` deliberately pulls **torchvision**: `mlx-embeddings` loads the slow
`AutoImageProcessor` (`use_fast=False`), which transformers 5 refuses to build
without it, and the library does not declare that dependency itself.

---

## Smoke-testing it

```bash
# text, the plain shape
curl -s localhost:8011/v1/embeddings -H 'content-type: application/json' \
  -d '{"model":"m","input":"Der Aussichtsturm ist 120 Meter hoch."}' \
  | jq '.data[0].embedding | length'

# a query, with the canonical retrieval instruction as the SYSTEM message
curl -s localhost:8011/v1/embeddings -H 'content-type: application/json' -d '{
  "model":"m",
  "messages":[
    {"role":"system","content":[{"type":"text","text":"Retrieve images or text relevant to the user'\''s query."}]},
    {"role":"user","content":[{"type":"text","text":"Wie hoch ist der Turm?"}]},
    {"role":"assistant","content":[{"type":"text","text":""}]}],
  "continue_final_message":true, "add_special_tokens":true}' | jq '.data[0].embedding | length'
```

`continue_final_message: true` beside that trailing empty `assistant` turn is
not decoration, and the shim **400s without it**: vLLM defaults the field to
false, which closes the turn with `<|im_end|>` and pools a different position.
(`add_generation_prompt: true` with no trailing assistant is the other accepted
spelling.) An image is a `data:` URI unless you started the shim with
`--allow-remote-images`.

Or run the shipped structural test against the running server:

```bash
cd tools/vl-embedding-shim
VL_SHIM_INTEGRATION=1 ./.venv/bin/python -m pytest tests/test_integration.py -v
```

It checks unit norm, a stable width, `dimensions` truncation, that an image
embeds at all, and that a near-paraphrase pair outscores an unrelated one. That
last is **plumbing, not quality** — see "What local numbers mean" below.

---

## Pointing the retrieval eval at it

The eval (`docs/runbooks/retrieval-eval.md`) drives whatever OpenAI-compatible
embeddings endpoint you name, so the shim slots straight in — it accepts the
plain `{model, input}` shape the eval's `generateEmbedding` posts:

```bash
cd backend
export POSTGRES_URL=postgresql://kb_user:pw@localhost:5433/kb_eval
export EVAL_EMBEDDING_BASE_URL=http://127.0.0.1:8011/v1
export EVAL_EMBEDDING_MODEL=$(curl -s localhost:8011/v1/models | jq -r '.data[0].id')

npx tsx scripts/run-retrieval-eval.ts --out /tmp/vl-2b.json
```

Spell the base URL with the `/v1` on it, exactly as a provider row would be —
the request goes to `<base-url>/embeddings` and nothing guesses a prefix for you.

**`EVAL_EMBEDDING_MODEL` is not a label — it decides what gets sent.** The seed
writes it into `llm_usecase_assignments.model`, so it *is* the app's resolved
embedding model, and `wantsInstructionPrefix` (#1329,
`domains/llm/services/query-instruction.ts`) prefixes a query only when that id
contains **both** `qwen3` and `embed`. Read it from `/v1/models` as above and do
not substitute a placeholder: both served ids qualify
(`Qwen3-VL-Embedding-8B-Q6_K.gguf`, `mlx-community/Qwen3-VL-Embedding-2B-8bit`)
while `EVAL_EMBEDDING_MODEL=m` does not — the flat form is then never emitted,
the conversion below never fires, its log line never appears, and every query is
embedded under the *default* instruction instead of `system={RETRIEVAL_TASK}`.
The run still completes and the report still looks fine, which is the whole
problem. `--model-id` on the shim renames the served id and breaks it the same
way.

Two things this run gets right that a naive one would not:

* **The template.** Every string the eval sends goes through the VL chat
  template under the default instruction, rather than being tokenized bare.
* **The `Instruct:` prefix.** The app prefixes instruction-aware models with
  Qwen3-Embedding's flat `Instruct: {task}\nQuery:{query}` form (#1329). That is
  the *text* family's convention. The shim recognises it and converts it back
  into `system={task}` + `user={query}`, and logs each conversion — so a parity
  number measured through this server reflects a correctly-templated query
  rather than a garbled double instruction. Watch the shim's log for

  ```
  INFO vl_embedding_shim converted flat `Instruct:` input[0] into a system message …
  ```

  If you want to measure the unconverted behaviour on purpose, start the shim
  with `--no-instruct-conversion`.

Do not point the eval at LM Studio and the shim in the same run, and do not load
another model into LM Studio while a run is in flight — the usual rule from the
eval runbook applies unchanged.

### The `--images` axis takes its OWN variables

The run above measures the shim on the TEXT side (the parity gate). To measure
the image leg instead, the axis reads a separate pair and **never falls back**
to `EVAL_EMBEDDING_*` — that endpoint would answer with a well-formed vector
from a different space, which is ADR-021's non-inheriting rule enforced by
refusal:

```bash
export EVAL_IMAGE_EMBEDDING_BASE_URL=http://127.0.0.1:8011/v1
export EVAL_IMAGE_EMBEDDING_MODEL=$(curl -s localhost:8011/v1/models | jq -r '.data[0].id')
export EVAL_IMAGE_EMBEDDING_DIMENSIONS=2048     # optional; MRL truncation
export EVAL_IMAGE_EMBEDDING_BACKEND=mlx         # optional; a recorded provenance label

npx tsx scripts/run-retrieval-eval.ts --images --out /tmp/images-2b.json
```

`--images` implies `--lang de` and accepts no other language (the corpus is
German Wikipedia; its English slice is a per-label field, not a flag), and a
missing variable is refused *before* the disposable-database guard, so a typo
costs a message rather than a migration run. Omitting `--out` writes
`retrieval-eval-images.json` — a per-axis default, so an image run cannot
overwrite a text report. `_BACKEND` is a label you typed rather than something the harness
probed, which is why `--baseline` compares it only when **both** sides declare
one — set it, or a 2B run and an 8B one differ in a field no guard reads.
Recipe, report fields and how to read the result:
`docs/runbooks/retrieval-eval.md`, "Image axis (`--images`)"; the first
measurement is under "Measured 2026-08-18" there and in ADR-025 **Measured** §B.

---

## What local numbers mean

**Plumbing and ranked-list eyeballing. Nothing that decides anything.** Three
independent shifts sit between a vector produced here and one produced in
production:

* quantisation (Q6_K, 8-bit MLX — neither is bf16);
* MLX/llama.cpp-vs-CUDA numerics, and llama.cpp's fidelity for this model has
  never been published;
* vLLM's own preprocessing divergence from the reference implementation —
  reported at **~0.92 cosine instead of 1.0** for identical inputs, and
  acknowledged in vLLM's own docs.

So never mix vectors from two of these paths in one index, and never quote a
retrieval metric measured here as a production number. Retrieval quality for the
image leg is measured on the prod stack (design §8).

---

## Troubleshooting

| symptom | cause |
|---|---|
| `healthz` 503, `reason` names `/props` | llama-server is not running, or not on `--llama-base-url` — including the case where *something else* answers there: a 200 carrying HTML is reported as degraded, not as a crash |
| `"vision": false` | llama-server started without `--mmproj` |
| 502 `…reports no vision capability…` | same, and you sent an image |
| 502 `/props reported no media_marker` | a llama.cpp build too old for randomised markers |
| 500 from llama-server on the first image | `-b/-ub` below ~1280; use `LLAMA_BATCH=2048` |
| 502 `AutoImageProcessor requires the Torchvision library` | `pip install -e '.[mlx]'` (it pulls torchvision) |
| 502 `Too many indices for array with 2 dimensions` | an `mlx-embeddings` newer than 0.1.0 that moved the `_position_ids` cache the shim resets — see the README's upstream-problems list |
| 400 `dimensions … exceeds the model native width` | MRL can only shrink; 2B is 2048 native, 8B is 4096 |
| 400 `only base64 data: URIs are supported` | send `data:image/png;base64,…`, not a percent-encoded payload |
| 400 `needs continue_final_message: true` / `must end at <\|im_start\|>assistant` | the body would pool a different position on vLLM — add the flag beside the trailing empty `assistant` turn |
| 400 `remote image URLs are refused by default` | send a `data:` URI, or start the shim with `--allow-remote-images` |
| 400 `answered a redirect` | remote fetching does not follow redirects; pass the final URL |
| 400 `served … more than the … left of this request's --max-body-bytes budget` | the images one request fetches are bounded **in total** by the same ceiling as an inbound body — a body naming many URLs cannot pull in more than one carrying them |
| 400 `a text content part may not precede an image part` | put the image parts first — vLLM emits the marker where you put it, and the interleaved prompt embeds differently (cos 0.59 on the 8B) |
| 400 `content part needs a \`type\`` | spell it `{"type": "image_url", "image_url": {"url": …}}`; only a type-less `image_url` is read as an image, and nothing is read as text by default |
| 413 `exceeds the --max-body-bytes ceiling` | a data: URI is base64, so the body is ~4/3 of the image; send fewer/smaller images or raise `--max-body-bytes` |
| 502 `number of media markers … does not match number of bitmaps` **twice in a row** | not a restart (that is retried automatically) — check `/healthz` for `vision` and the marker |
