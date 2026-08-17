"""Backend (a): in-process `mlx-embeddings`.

The research pack calls this the highest-fidelity local path: the library
supports Qwen3-VL natively and takes the same `{text, image, instruction}` input
dicts as the CUDA reference, building the conversation through the checkpoint's
own `chat_template.jinja`. It is a **library, not a server** — hence this shim.

(Note that the `mlx-community` model cards for these checkpoints show a
SigLIP-style `generate(...)`/`logits_per_image` snippet that does not apply to
this architecture at all. The API used here was read from
`mlx_embeddings/models/qwen3_vl/{model,processor}.py`, not from the cards.)

Two places the library's behaviour differs from the reference embedder, and
both are compensated here so this backend and the `llama` one build the same
prompt:

1. **No trailing-period rule.** `Processor.format_embedding_input` uses the
   instruction verbatim. So the instruction is normalised here first.
2. **An empty string is still a text part.** `_format_mm_content` substitutes
   the literal `NULL` only when the content list comes out *empty*, so
   `text=''` yields an empty text part instead. The key is therefore omitted
   rather than set to `''`.
"""

from __future__ import annotations

import io
from collections.abc import Callable, Sequence
from typing import Any

from ..template import normalise_instruction
from .base import BackendError, BackendInfo, ResolvedItem

DEFAULT_MODEL = 'mlx-community/Qwen3-VL-Embedding-2B-8bit'

Loader = Callable[[str], tuple[Any, Any]]


def _default_loader(path: str) -> tuple[Any, Any]:
    try:
        from mlx_embeddings import load
    except ImportError as exc:  # pragma: no cover - exercised by the extra, not tests
        raise BackendError(
            'the mlx backend needs the optional dependency group: '
            "pip install -e '.[mlx]'"
        ) from exc
    return load(path)


class MlxBackend:
    def __init__(
        self,
        model_path: str = DEFAULT_MODEL,
        *,
        loader: Loader | None = None,
        model_id: str | None = None,
    ) -> None:
        self._model_path = model_path
        self._loader = loader or _default_loader
        self._model_id = model_id
        self._loaded: tuple[Any, Any] | None = None

    def _load(self) -> tuple[Any, Any]:
        if self._loaded is None:
            try:
                self._loaded = self._loader(self._model_path)
            except BackendError:
                raise
            except Exception as exc:
                raise BackendError(f'could not load {self._model_path}: {exc}') from exc
        return self._loaded

    def info(self) -> BackendInfo:
        return BackendInfo(
            backend='mlx',
            model_id=self._model_id or self._model_path,
            # In-process: the vision tower is part of the checkpoint, so there
            # is no separate projector that could be missing.
            vision=True,
            details={'model_path': self._model_path, 'loaded': self._loaded is not None},
        )

    def embed(self, items: Sequence[ResolvedItem]) -> list[list[float]]:
        model, processor = self._load()
        inputs = [self._to_input(item) for item in items]
        _reset_position_id_cache(model)
        try:
            embeddings = model.process(inputs, processor=processor)
        except Exception as exc:
            raise BackendError(f'mlx-embeddings failed to embed: {exc}') from exc

        rows = embeddings.tolist() if hasattr(embeddings, 'tolist') else list(embeddings)
        if len(rows) != len(items):
            raise BackendError(
                f'mlx-embeddings returned {len(rows)} vectors for {len(items)} inputs'
            )
        return [[float(x) for x in row] for row in rows]

    @staticmethod
    def _to_input(item: ResolvedItem) -> dict[str, Any]:
        payload: dict[str, Any] = {'instruction': normalise_instruction(item.instruction)}
        if item.images:
            payload['image'] = [_to_pil(data) for data in item.images]
        if item.text:
            payload['text'] = item.text
        return payload


def _reset_position_id_cache(model: Any) -> None:
    """Work around `mlx-embeddings` 0.1.0 serving exactly one text request.

    `compute_qwen3_vl_hidden_states` memoises `language_model._position_ids`
    and reads it back as `position_ids = _position_ids[:, :, :n]`. The
    text-only branch stores a **2-D** array, so the second text request dies
    with `ValueError: Too many indices for array with 2 dimensions`. The
    library clears the cache itself — but only inside
    `if pixel_values is not None`, i.e. only for image requests, which is why
    an image call always works and a text call only works first.

    Measured on `mlx-community/Qwen3-VL-Embedding-2B-8bit` (mlx-embeddings
    0.1.0, mlx 0.32.0): call 1 OK, calls 2-5 all `ValueError`; with this reset,
    all five OK and call 2 reproduces call 1 to cosine 1.0000.

    Clearing it is also the semantically right thing regardless of the bug:
    each embedding request is an independent forward pass, so there is no
    incremental-decode state worth carrying between two of them. Written
    defensively (`getattr`/`hasattr`) so a future release that drops or renames
    the attribute degrades to a no-op rather than an AttributeError.
    """
    language_model = getattr(model, 'language_model', None)
    if language_model is None:
        return
    for attr in ('_position_ids', '_rope_deltas'):
        if hasattr(language_model, attr):
            try:
                setattr(language_model, attr, None)
            except AttributeError:  # pragma: no cover - a read-only property
                pass


def _to_pil(data: bytes) -> Any:
    try:
        from PIL import Image
    except ImportError as exc:  # pragma: no cover - Pillow is a declared dependency
        raise BackendError('Pillow is required by the mlx backend') from exc
    try:
        image = Image.open(io.BytesIO(data))
        image.load()
    except Exception as exc:
        raise BackendError(f'could not decode an attached image: {exc}') from exc
    # The model wants RGB; a palette or CMYK source would otherwise reach the
    # vision tower with the wrong channel count.
    return image.convert('RGB') if image.mode != 'RGB' else image
