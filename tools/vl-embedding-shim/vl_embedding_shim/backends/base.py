"""What both backends must offer."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable


class BackendError(RuntimeError):
    """The backend could not serve the request. Maps to HTTP 502."""


@dataclass
class ResolvedItem:
    """One input, with its images already resolved to bytes."""

    text: str = ''
    #: `None` = no system message from the caller; the backend applies
    #: `template.DEFAULT_INSTRUCTION`.
    instruction: str | None = None
    images: tuple[bytes, ...] = ()


@dataclass
class BackendInfo:
    backend: str
    model_id: str
    #: `True`/`False` when the backend can state it, `None` when it cannot.
    #: Deliberately tri-state for the same reason the app's own vision
    #: capability is (#1154): "probed and refused" is not "never established".
    vision: bool | None = None
    details: dict[str, Any] = field(default_factory=dict)


@runtime_checkable
class Backend(Protocol):
    def info(self, *, refresh: bool = False) -> BackendInfo:
        """Identity and capability. Raises `BackendError` when unreachable.

        `refresh=True` discards whatever the backend cached and asks the thing
        itself. `/healthz` and `/v1/models` pass it: they exist to describe the
        live server, and llama-server's identity — its GGUF and its per-process
        random media marker — changes under a restart the shim never sees.
        """

    def embed(self, items: Sequence[ResolvedItem]) -> list[list[float]]:
        """One raw vector per item, in order. Normalisation/MRL happen above."""
