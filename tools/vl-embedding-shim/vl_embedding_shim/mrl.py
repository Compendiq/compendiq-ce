"""Matryoshka truncation and L2 normalisation.

Two rules, both from the design's D4/§12 and the research pack:

* **Output is always L2-normalised.** The checkpoint's `2_Normalize` module and
  llama-server's `--embd-normalize 2` both do it, but the shim re-does it so
  that a backend which forgets cannot produce a vector whose cosine is silently
  a dot product.
* **`dimensions` truncates to the first N components and re-normalises.** The
  research pack marks vLLM's own post-truncation normalisation UNVERIFIED
  (§2.5); truncation mathematically requires it before cosine comparison. A
  width above native is refused rather than zero-padded — padding would produce
  a vector that compares as if it carried information it does not have.
"""

from __future__ import annotations

import math
from collections.abc import Sequence


class DimensionsError(ValueError):
    """The requested `dimensions` cannot be produced from this vector."""


def l2_norm(vec: Sequence[float]) -> float:
    """Euclidean length of `vec`."""
    return math.sqrt(sum(float(x) * float(x) for x in vec))


def l2_normalize(vec: Sequence[float]) -> list[float]:
    """`vec` scaled to unit length.

    A zero vector is returned unchanged: there is no direction to preserve, and
    dividing by zero would turn a degenerate embedding into NaNs that poison
    every downstream cosine.
    """
    norm = l2_norm(vec)
    if norm == 0.0:
        return [float(x) for x in vec]
    return [float(x) / norm for x in vec]


def apply_mrl(vec: Sequence[float], dimensions: int | None) -> list[float]:
    """`vec` truncated to `dimensions` components and re-normalised.

    `dimensions=None` returns the full width, still re-normalised.
    """
    if dimensions is None:
        return l2_normalize(vec)
    if dimensions < 1:
        raise DimensionsError(f'dimensions must be >= 1, got {dimensions}')
    if dimensions > len(vec):
        raise DimensionsError(
            f'dimensions {dimensions} exceeds the model native width {len(vec)}; '
            'Matryoshka truncation can only shrink an embedding'
        )
    return l2_normalize(list(vec)[:dimensions])
