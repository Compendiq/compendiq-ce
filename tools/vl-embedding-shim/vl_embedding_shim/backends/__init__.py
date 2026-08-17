"""Interchangeable local backends. One per process — see README ("RAM")."""

from .base import Backend, BackendError, BackendInfo, ResolvedItem

__all__ = ['Backend', 'BackendError', 'BackendInfo', 'ResolvedItem']
