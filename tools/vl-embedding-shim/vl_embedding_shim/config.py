"""Settings, and the CLI/env that fill them.

**No repository path ever names a model.** The GGUF lives wherever the operator
put it (an LM Studio folder, say); the shim reads `QWEN3_VL_GGUF` /
`QWEN3_VL_MMPROJ` or a flag, and the README carries the example. A hardcoded
`$HOME/.lmstudio/...` would be one machine's layout committed to everyone's
checkout.
"""

from __future__ import annotations

import argparse
import os
from dataclasses import dataclass
from typing import Literal

from .backends.llama import DEFAULT_BASE_URL
from .backends.mlx import DEFAULT_MODEL
from .images import TRAINED_MAX_PIXELS

DEFAULT_PORT = 8011

#: Ceiling on one request body, enforced before it is parsed. A `data:` URI is
#: base64, so a request is ~4/3 of the bytes it carries: this holds several
#: images at the app's own 5 MB `MAX_IMAGE_BYTES` and a corpus-sized batch of
#: text, while still bounding what a single POST can allocate on a 24 GB
#: machine. It is a memory guard, not an image policy — that is `--max-pixels`.
DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024


@dataclass
class Settings:
    #: One backend per process. 24 GB of RAM does not hold an 8B GGUF and a
    #: 2B MLX checkpoint at once — see README ("RAM").
    backend: Literal['llama', 'mlx'] = 'llama'
    host: str = '127.0.0.1'
    port: int = DEFAULT_PORT

    llama_base_url: str = DEFAULT_BASE_URL
    mlx_model: str = DEFAULT_MODEL
    #: What `/v1/models` advertises. Defaults to the backend's own answer.
    served_model_id: str | None = None

    #: Opt-in guard, not a resizer (see images.py). `None` decodes nothing.
    max_pixels: int | None = None
    #: OFF by default. A shim that fetches an arbitrary `image_url` on request
    #: is an SSRF proxy for anything that can reach it, and every caller this
    #: tool exists for — the app, the eval, the README's examples — sends
    #: `data:` URIs. Opening it is a deliberate `--allow-remote-images`.
    allow_remote_images: bool = False
    #: Refused before parsing, in the same error envelope, as a 413.
    max_body_bytes: int = DEFAULT_MAX_BODY_BYTES
    #: Rule (2): recover Qwen3-Embedding's flat `Instruct:` prefix into a
    #: system message. Off is for measuring what an unconverted run does.
    convert_flat_instruct: bool = True
    request_timeout: float = 300.0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog='vl-embedding-shim',
        description=(
            "Dev-only shim exposing vLLM's chat-template embeddings shape for "
            'Qwen3-VL-Embedding (#1115). Production is vLLM >= 0.14 --runner pooling.'
        ),
    )
    parser.add_argument(
        '--backend', choices=('llama', 'mlx'), default=os.environ.get('VL_SHIM_BACKEND', 'llama'),
        help='llama = proxy a running llama-server; mlx = load mlx-embeddings in-process',
    )
    parser.add_argument('--host', default=os.environ.get('VL_SHIM_HOST', '127.0.0.1'))
    parser.add_argument(
        '--port', type=int, default=int(os.environ.get('VL_SHIM_PORT', DEFAULT_PORT)),
    )
    parser.add_argument(
        '--llama-base-url',
        default=os.environ.get('VL_SHIM_LLAMA_BASE_URL', DEFAULT_BASE_URL),
        help='where scripts/run-llama-server.sh put llama-server',
    )
    parser.add_argument(
        '--mlx-model', default=os.environ.get('VL_SHIM_MLX_MODEL', DEFAULT_MODEL),
        help='HF repo id or a local directory (scripts/download-model.py fetches one)',
    )
    parser.add_argument(
        '--model-id', default=os.environ.get('VL_SHIM_MODEL_ID') or None,
        help='the id /v1/models advertises; defaults to the backend\'s own answer',
    )
    parser.add_argument(
        '--max-pixels', type=int, default=_env_int('VL_SHIM_MAX_PIXELS'),
        help=(
            'refuse images above this many pixels. The shim does NOT resize (v1); '
            f'the model server does, to its trained budget of {TRAINED_MAX_PIXELS} px'
        ),
    )
    parser.add_argument(
        '--allow-remote-images', action='store_true',
        default=_env_flag('VL_SHIM_ALLOW_REMOTE_IMAGES'),
        help=(
            'fetch http(s) image URLs. OFF by default: the shim would otherwise '
            'issue arbitrary GETs on behalf of anything that can reach it. Redirects '
            'are never followed even when this is on'
        ),
    )
    parser.add_argument(
        '--max-body-bytes', type=int,
        default=_env_int('VL_SHIM_MAX_BODY_BYTES') or DEFAULT_MAX_BODY_BYTES,
        help=f'413 a request body larger than this (default {DEFAULT_MAX_BODY_BYTES})',
    )
    parser.add_argument(
        '--no-instruct-conversion', action='store_true',
        help=(
            "do not split Qwen3-Embedding's flat `Instruct: …\\nQuery:…` form into a "
            'system message (the conversion is on by default; see README rule 2)'
        ),
    )
    parser.add_argument('--request-timeout', type=float, default=300.0)
    return parser


def _env_int(name: str) -> int | None:
    raw = os.environ.get(name)
    return int(raw) if raw else None


def _env_flag(name: str) -> bool:
    return os.environ.get(name, '').strip().lower() in ('1', 'true', 'yes', 'on')


def settings_from_args(argv: list[str] | None = None) -> Settings:
    args = build_parser().parse_args(argv)
    return Settings(
        backend=args.backend,
        host=args.host,
        port=args.port,
        llama_base_url=args.llama_base_url,
        mlx_model=args.mlx_model,
        served_model_id=args.model_id,
        max_pixels=args.max_pixels,
        allow_remote_images=args.allow_remote_images,
        max_body_bytes=args.max_body_bytes,
        convert_flat_instruct=not args.no_instruct_conversion,
        request_timeout=args.request_timeout,
    )


def build_backend(settings: Settings):
    """The one backend this process serves."""
    if settings.backend == 'mlx':
        from .backends.mlx import MlxBackend

        return MlxBackend(settings.mlx_model, model_id=settings.served_model_id)

    from .backends.llama import LlamaBackend

    return LlamaBackend(
        settings.llama_base_url,
        model_id=settings.served_model_id,
        timeout=settings.request_timeout,
    )
