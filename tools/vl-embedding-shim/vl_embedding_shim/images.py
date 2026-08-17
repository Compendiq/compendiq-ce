"""Resolving an image reference to bytes, and the optional pixel guard.

**The shim does not resize.** The design's D10 says v1 does no server-side pixel
processing; the model server does its own. :data:`TRAINED_MAX_PIXELS` is the
**checkpoint's** budget — 1,310,720 px, ≈1280 visual tokens,
`preprocessor_config.json`'s `max_pixels`, which the paper confirms is what
training saw. Sending more is not an error, it is merely wasted: the paper's
granularity study reports a *regression* at the highest resource levels, so an
over-budget image is plausibly worse than a resized one, not just slower.

**It is the checkpoint's number, not a promise about either server** (review
r3). The `mlx` backend is *held* to it — `mlx-embeddings` 0.1.0 would otherwise
default to the reference script's permissive 1,843,200, so
`backends.mlx._pin_pixel_budget` sets the field after the load. On `llama` the
bytes go to llama-server, which applies whatever preprocessing its `mmproj`
carries; `/props` reports nothing about pixels (verified on build b10450), so
the shim can neither set nor read it there.

`--max-pixels` therefore exists as a **guard, not a resizer**: set it and an
over-budget image is refused with both numbers named, so a caller finds out
rather than silently paying for pixels the encoder throws away. Unset (the
default) this *guard* decodes nothing — which is not the same as "the shim
decodes nothing": the `llama` backend forwards the bytes to llama-server
untouched, while the `mlx` backend always opens them with Pillow and converts
to RGB. So a format Pillow cannot read reaches the model server on `llama` and
is a 502 on `mlx`.

**Remote URLs are opt-in** (`--allow-remote-images`), and redirects are never
followed even then — see `service.EmbeddingService`.
"""

from __future__ import annotations

import base64
import binascii
import io
from collections.abc import Callable
from urllib.parse import urlsplit

from .request import ImageRef

#: The checkpoint's trained pixel budget: 1280 visual tokens x 32x32 px per
#: token. Exposed as a constant so the README, the CLI help, the runbook and
#: `backends.mlx` quote — and pin — one number.
TRAINED_MAX_PIXELS = 1_310_720

Fetcher = Callable[[str], bytes]


class ImageError(ValueError):
    """An image reference could not be turned into usable bytes. Maps to HTTP 400."""


def _decode_data_uri(url: str) -> bytes:
    header, comma, payload = url.partition(',')
    if not comma:
        raise ImageError('malformed data: URI — no comma separating the payload')
    if ';base64' not in header:
        raise ImageError(
            'only base64 data: URIs are supported; a percent-encoded payload is not'
        )
    try:
        data = base64.b64decode(''.join(payload.split()), validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ImageError(f'data: URI payload is not valid base64 ({exc})') from exc
    if not data:
        raise ImageError('data: URI payload is empty')
    return data


def resolve_image(ref: ImageRef, *, fetcher: Fetcher | None = None) -> bytes:
    """The raw bytes behind `ref`.

    The bytes are passed to the backend untouched — no re-encode — so the model
    sees exactly what the caller sent.
    """
    url = ref.url
    # Lowercased once, for every branch. Scheme names are case-insensitive
    # (RFC 3986 §3.1, and RFC 2397 for `data:` specifically), so a raw
    # `url.startswith('data:')` refused `DATA:image/png;base64,…` with a
    # message naming `data` as both the rejected scheme and the expected one —
    # while the http(s) branch below had always lowercased (review r3). The
    # decode still reads the ORIGINAL string: only the scheme is case-folded.
    scheme = urlsplit(url).scheme.lower()
    if scheme == 'data':
        return _decode_data_uri(url)

    if scheme in ('http', 'https'):
        if fetcher is None:
            raise ImageError(
                'remote image URLs are refused by default; send a data: URI, or '
                'start the shim with --allow-remote-images if this server really '
                'should issue GETs on a caller\'s behalf'
            )
        data = fetcher(url)
        if not data:
            raise ImageError(f'fetching {url} returned no bytes')
        return data

    raise ImageError(
        f'unsupported image URL scheme {scheme!r}; expected a data: URI or http(s)'
    )


def measure_pixels(data: bytes) -> tuple[int, int]:
    """`(width, height)` of the encoded image."""
    try:
        from PIL import Image  # imported lazily: unused unless a ceiling is set
    except ImportError as exc:  # pragma: no cover - Pillow is a declared dependency
        raise ImageError('Pillow is required to measure image dimensions') from exc

    try:
        with Image.open(io.BytesIO(data)) as img:
            return img.size
    except Exception as exc:
        raise ImageError(f'could not decode the image to measure it ({exc})') from exc


def guard_pixels(data: bytes, max_pixels: int | None) -> None:
    """Refuse `data` when it exceeds `max_pixels`. A `None` ceiling decodes nothing."""
    if max_pixels is None:
        return
    width, height = measure_pixels(data)
    total = width * height
    if total > max_pixels:
        raise ImageError(
            f'image is {width}x{height} = {total} px, over the --max-pixels '
            f'ceiling of {max_pixels}; the shim does not resize (v1)'
        )
