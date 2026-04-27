# =============================================================================
# vapor-idx — indexes/exact.py
# Equality index: field → normalised_value → set[record_id]
# Supports: eq, neq, in, notIn
# =============================================================================

from __future__ import annotations
from collections import defaultdict
from typing import Any


class ExactIndex:
    def __init__(self) -> None:
        # field → normalised_value → set[id]
        self._index: dict[str, dict[str, set[str]]] = defaultdict(lambda: defaultdict(set))

    # ── Mutation ───────────────────────────────────────────────────────────────

    def add(self, field: str, value: Any, record_id: str) -> None:
        if value is None:
            return
        values = value if isinstance(value, list) else [value]
        for v in values:
            self._index[field][_normalise(v)].add(record_id)

    def remove(self, field: str, value: Any, record_id: str) -> None:
        if value is None:
            return
        values = value if isinstance(value, list) else [value]
        field_map = self._index.get(field)
        if not field_map:
            return
        for v in values:
            key = _normalise(v)
            id_set = field_map.get(key)
            if id_set:
                id_set.discard(record_id)
                if not id_set:
                    del field_map[key]
        if not field_map:
            del self._index[field]

    # ── Lookup ─────────────────────────────────────────────────────────────────

    def eq(self, field: str, value: Any) -> set[str]:
        return set(self._index.get(field, {}).get(_normalise(value), set()))

    def neq(self, field: str, value: Any) -> set[str]:
        excluded = _normalise(value)
        result: set[str] = set()
        for key, ids in self._index.get(field, {}).items():
            if key != excluded:
                result.update(ids)
        return result

    def find_in(self, field: str, values: list[Any]) -> set[str]:
        result: set[str] = set()
        for v in values:
            result.update(self.eq(field, v))
        return result

    def not_in(self, field: str, values: list[Any]) -> set[str]:
        excluded = {_normalise(v) for v in values}
        result: set[str] = set()
        for key, ids in self._index.get(field, {}).items():
            if key not in excluded:
                result.update(ids)
        return result

    # ── Lifecycle ──────────────────────────────────────────────────────────────

    def clear(self) -> None:
        self._index.clear()

    @property
    def entry_count(self) -> int:
        return sum(len(m) for m in self._index.values())


def _normalise(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value).lower()
