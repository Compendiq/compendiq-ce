"""Backend (a): in-process `mlx-embeddings`.

The research pack calls this the highest-fidelity local path: the library
supports Qwen3-VL natively and takes the same `{text, image, instruction}` input
dicts as the CUDA reference, building the conversation through the checkpoint's
own `chat_template.jinja`. It is a **library, not a server** — hence this shim.

(Note that the `mlx-community` model cards for these checkpoints show a
SigLIP-style `generate(...)`/`logits_per_image` snippet that does not apply to
this architecture at all. The API used here was read from
`mlx_embeddings/models/qwen3_vl/{model,processor}.py`, not from the cards.)

Three places the library's behaviour differs from what this shim needs, and all
three are compensated here so this backend and the `llama` one send the model
the same thing:

1. **No trailing-period rule.** `Processor.format_embedding_input` uses the
   instruction verbatim. So the instruction is normalised here first.
2. **An empty string is still a text part.** `_format_mm_content` substitutes
   the literal `NULL` only when the content list comes out *empty*, so
   `text=''` yields an empty text part instead. The key is therefore omitted
   rather than set to `''`.

3. **A more permissive pixel budget.** `Processor.from_pretrained` fills
   `max_pixels` from the library's `MAX_PIXELS = 1800 * 32 * 32 = 1_843_200` —
   the reference *script*'s runtime default rather than the 1,310,720 the
   checkpoint declares and the paper says training saw. `_pin_pixel_budget`
   sets the checkpoint's value after the load, because otherwise an image
   between the two figures is encoded differently here than on `llama` while
   the README claims the two are comparable (review r3).

And one that **cannot** be compensated, so it is written down instead: an
*explicitly empty* system message. `processor.py` builds the system turn as
`item.get("instruction") or self.default_embedding_instruction`, so any falsy
instruction becomes the default and the library's API has no way to express an
empty one. The `llama` backend emits `<|im_start|>system\\n<|im_end|>\\n` for
that body (which is what `chat_template.jinja` does); this one emits the
default. Nothing else diverges, and no caller of the design's D4 shape sends an
empty system message — the README says so beside rule (1).
"""

from __future__ import annotations

import io
import logging
from collections.abc import Callable, Sequence
from typing import Any

from ..images import TRAINED_MAX_PIXELS
from ..template import normalise_instruction
from .base import BackendError, BackendInfo, ResolvedItem

DEFAULT_MODEL = 'mlx-community/Qwen3-VL-Embedding-2B-8bit'

log = logging.getLogger('vl_embedding_shim')

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
            _pin_pixel_budget(self._loaded[1])
        return self._loaded

    def info(self, *, refresh: bool = False) -> BackendInfo:
        # `refresh` is accepted and ignored: the model is in-process, so there
        # is no other process whose identity could have changed underneath.
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


def _pin_pixel_budget(processor: Any) -> None:
    """Hold the library to the CHECKPOINT's pixel budget, not its own default.

    `mlx_embeddings` 0.1.0 stamps `min_pixels`/`max_pixels` onto every image
    content block (`processor.py:218-227`) from `Processor` fields that
    `from_pretrained` fills from its module constants. Its
    ``MAX_PIXELS = 1800 * 32 * 32 = 1_843_200`` is the reference *script*'s
    permissive runtime default — 1.41x the 1,310,720 the checkpoint's
    `preprocessor_config.json` declares and the paper states training saw, and
    research §5.1 is explicit that the higher figure is plausibly *worse* rather
    than merely slower. Its ``MIN_PIXELS`` already equals the checkpoint's 4096,
    so the floor is left alone.

    It is set on the loaded processor rather than passed in. `load()` does
    forward a `tokenizer_config` dict into `Processor.from_pretrained`, which
    pops `max_pixels` from it, so the constructor route exists — but it is a
    kwarg into two layers of `**kwargs`, and a release that stops popping it
    would ignore it in silence, while this reads the field the library actually
    uses and says so when it is not there. It also stays on the injected
    `Loader` seam the tests drive, which a kwarg to the real `load()` would not.
    Either way this is the only place the two backends can be made to agree on
    what an image costs, and the README's claim that a vector from one is
    comparable to a vector from the other depends on it (review r3). A release
    that renames the field must degrade to the library's budget with a line in
    the log, not to a 502 on every request.
    """
    if not hasattr(processor, 'max_pixels'):
        log.warning(
            'the loaded mlx-embeddings processor has no `max_pixels` field, so images '
            'are encoded at whatever budget the library defaults to (0.1.0: 1843200 px) '
            'rather than the checkpoint\'s %d — image vectors are not comparable with '
            'the llama backend\'s until this is re-pinned',
            TRAINED_MAX_PIXELS,
        )
        return
    processor.max_pixels = TRAINED_MAX_PIXELS


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
