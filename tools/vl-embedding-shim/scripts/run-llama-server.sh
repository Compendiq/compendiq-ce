#!/usr/bin/env bash
#
# Start llama-server on a Qwen3-VL-Embedding GGUF for the shim's `llama` backend.
#
# The model paths come from the environment on purpose: a checkpoint lives
# wherever the operator put it (an LM Studio folder, a downloads directory),
# and hardcoding one machine's layout into the repository is how a script stops
# working for everyone else.
#
#   export QWEN3_VL_GGUF="$HOME/.lmstudio/models/VesNFF/Qwen3-VL-Embedding-8B-GGUF/Qwen3-VL-Embedding-8B-Q6_K.gguf"
#   export QWEN3_VL_MMPROJ="$HOME/.lmstudio/models/VesNFF/Qwen3-VL-Embedding-8B-GGUF/mmproj-Qwen3-VL-Embedding-8B-f16.gguf"
#   ./scripts/run-llama-server.sh
#
# The flags are not decoration:
#   --pooling last      matches the checkpoint's 1_Pooling ("lasttoken")
#   --embd-normalize 2  matches its 2_Normalize (L2)
#   --mmproj            without it, /props reports modalities.vision=false and
#                       the shim refuses every image rather than embedding a
#                       prompt with an unfilled marker
#   -b/-ub 2048         one image is ~1280 visual tokens; a batch below that
#                       500s on the first image request
set -euo pipefail

: "${QWEN3_VL_GGUF:?set QWEN3_VL_GGUF to the model .gguf (see the header)}"
: "${QWEN3_VL_MMPROJ:?set QWEN3_VL_MMPROJ to the mmproj-*.gguf vision projector}"

LLAMA_SERVER="${LLAMA_SERVER:-llama-server}"
LLAMA_PORT="${LLAMA_PORT:-8090}"
LLAMA_HOST="${LLAMA_HOST:-127.0.0.1}"
LLAMA_CTX="${LLAMA_CTX:-8192}"
LLAMA_BATCH="${LLAMA_BATCH:-2048}"

for path in "$QWEN3_VL_GGUF" "$QWEN3_VL_MMPROJ"; do
  [ -f "$path" ] || { echo "not a file: $path" >&2; exit 1; }
done

exec "$LLAMA_SERVER" \
  -m "$QWEN3_VL_GGUF" \
  --mmproj "$QWEN3_VL_MMPROJ" \
  --embedding \
  --pooling last \
  --embd-normalize 2 \
  -c "$LLAMA_CTX" \
  -b "$LLAMA_BATCH" \
  -ub "$LLAMA_BATCH" \
  --port "$LLAMA_PORT" \
  --host "$LLAMA_HOST" \
  "$@"
