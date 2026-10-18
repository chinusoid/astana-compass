"""Real, attributed OSM snapshots; importing this module never performs I/O."""
from .repository import SnapshotRepository, create_repository

__all__ = ["SnapshotRepository", "create_repository"]
