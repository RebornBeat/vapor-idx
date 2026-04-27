# =============================================================================
# vapor-idx — indexes/range_.py
# Sorted numeric index using Python's bisect module.
# Supports: gt, lt, gte, lte
# =============================================================================

from __future__ import annotations
import bisect
from typing import Any


class RangeIndex:
    def __init__(self) -> None:
        # field → list of (value, id) sorted ascending
        self._index: dict[str, list[tuple[float, str]]] = {}

    # ── Mutation ───────────────────────────────────────────────────────────────

    def add(self, field: str, value: Any, record_id: str) -> None:
        if value is None:
            return
        raw_values = value if isinstance(value, list) else [value]
        entries = self._index.setdefault(field, [])
        for raw in raw_values:
            num = _to_number(raw)
            if num is None:
                continue
            # bisect_left on (value, id) tuples — tuples compare lexicographically
            pos = bisect.bisect_left(entries, (num, record_id))
            entries.insert(pos, (num, record_id))

    def remove(self, field: str, value: Any, record_id: str) -> None:
        if value is None:
            return
        entries = self._index.get(field)
        if not entries:
            return
        raw_values = value if isinstance(value, list) else [value]
        for raw in raw_values:
            num = _to_number(raw)
            if num is None:
                continue
            pos = bisect.bisect_left(entries, (num, record_id))
            if pos < len(entries) and entries[pos] == (num, record_id):
                entries.pop(pos)
        if not entries:
            del self._index[field]

    # ── Lookup ─────────────────────────────────────────────────────────────────

    def gt(self, field: str, threshold: float) -> set[str]:
        entries = self._index.get(field, [])
        # Find first position where value > threshold
        pos = bisect.bisect_right(entries, (threshold, chr(0x10FFFF)))
        return {e[1] for e in entries[pos:]}

    def gte(self, field: str, threshold: float) -> set[str]:
        entries = self._index.get(field, [])
        pos = bisect.bisect_left(entries, (threshold, ""))
        return {e[1] for e in entries[pos:]}

    def lt(self, field: str, threshold: float) -> set[str]:
        entries = self._index.get(field, [])
        pos = bisect.bisect_left(entries, (threshold, ""))
        return {e[1] for e in entries[:pos]}

    def lte(self, field: str, threshold: float) -> set[str]:
        entries = self._index.get(field, [])
        pos = bisect.bisect_right(entries, (threshold, chr(0x10FFFF)))
        return {e[1] for e in entries[:pos]}

    def get_sorted(self, field: str) -> list[tuple[float, str]]:
        return self._index.get(field, [])

    # ── Lifecycle ──────────────────────────────────────────────────────────────

    def clear(self) -> None:
        self._index.clear()

    @property
    def entry_count(self) -> int:
        return sum(len(v) for v in self._index.values())


def _to_number(value: Any) -> float | None:
    try:
        n = float(value)
        return n if (n == n) else None  # NaN check
    except (TypeError, ValueError):
        return None
