#!/usr/bin/env python3
"""Fetch an MLX Qwen3-VL-Embedding checkpoint for the shim's `mlx` backend.

    python scripts/download-model.py                                  # the 2B 8-bit default
    python scripts/download-model.py --repo mlx-community/Qwen3-VL-Embedding-2B-bf16
    python scripts/download-model.py --local-dir ~/models/qwen3-vl-2b  # somewhere specific

A local directory is also accepted directly by the shim
(`--mlx-model /path/to/dir`), so an LM Studio folder that already holds an MLX
build needs no download at all — pass its path and skip this script.

Nothing here writes into the repository: `snapshot_download` lands in the
Hugging Face cache (`$HF_HOME`, else `~/.cache/huggingface`) unless
`--local-dir` says otherwise.
"""

from __future__ import annotations

import argparse
import sys

DEFAULT_REPO = 'mlx-community/Qwen3-VL-Embedding-2B-8bit'

# Weights, tokenizer, processor and — critically — chat_template.jinja. The
# template is what `mlx-embeddings` builds the conversation with; a checkout
# missing it silently falls back to no template at all.
ALLOW_PATTERNS = [
    '*.safetensors',
    '*.safetensors.index.json',
    '*.json',
    '*.jinja',
    '*.txt',
    '*.model',
]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--repo', default=DEFAULT_REPO, help=f'default: {DEFAULT_REPO}')
    parser.add_argument('--local-dir', default=None, help='download here instead of the HF cache')
    parser.add_argument('--revision', default=None)
    parser.add_argument(
        '--everything', action='store_true',
        help='do not filter by pattern (pulls any extra files the repo carries)',
    )
    args = parser.parse_args(argv)

    try:
        from huggingface_hub import snapshot_download
    except ImportError:
        print(
            "huggingface_hub is missing — install the mlx extra:\n"
            "    pip install -e '.[mlx]'",
            file=sys.stderr,
        )
        return 1

    path = snapshot_download(
        repo_id=args.repo,
        revision=args.revision,
        local_dir=args.local_dir,
        allow_patterns=None if args.everything else ALLOW_PATTERNS,
    )
    print(path)
    print(
        f'\nStart the shim against it:\n'
        f'    python -m vl_embedding_shim --backend mlx --mlx-model {args.repo}\n'
        f'or point it at the directory directly:\n'
        f'    python -m vl_embedding_shim --backend mlx --mlx-model {path}',
        file=sys.stderr,
    )
    return 0


if __name__ == '__main__':
    sys.exit(main())
