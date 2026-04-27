# =============================================================================
# vapor-idx — indexes/keyword.py
# Tokenised inverted index: "field:token" → set[record_id]
# Supports: contains (field-scoped), free-text search
# All query tokens are AND-ed.
# =============================================================================

from __future__ import annotations
import re
from collections import defaultdict
from typing import Union


class KeywordIndex:
    def __init__(self) -> None:
        # "field:token" → set[id]
        self._index: dict[str, set[str]] = defaultdict(set)
        # id → set["field:token"] for fast removal
        self._record_keys: dict[str, set[str]] = defaultdict(set)

    # ── Mutation ───────────────────────────────────────────────────────────────

    def add(self, field: str, value: object, record_id: str) -> None:
        if value is None:
            return
        raw_values = value if isinstance(value, list) else [value]
        tokens = [t for v in raw_values for t in tokenise(str(v))]
        if not tokens:
            return
        for token in tokens:
            composite_key = f"{field}:{token}"
            self._index[composite_key].add(record_id)
            self._record_keys[record_id].add(composite_key)

    def remove(self, record_id: str) -> None:
        keys = self._record_keys.pop(record_id, set())
        for key in keys:
            id_set = self._index.get(key)
            if id_set:
                id_set.discard(record_id)
                if not id_set:
                    del self._index[key]

    # ── Lookup ─────────────────────────────────────────────────────────────────

    def search(self, query: Union[str, list[str]]) -> set[str]:
        """Free-text search across all keyword-indexed fields. All tokens AND-ed."""
        queries = query if isinstance(query, list) else [query]
        tokens  = [t for q in queries for t in tokenise(q)]
        if not tokens:
            return set()

        per_token: list[set[str]] = []
        for token in tokens:
            merged: set[str] = set()
            for key, ids in self._index.items():
                if key.endswith(f":{token}"):
                    merged.update(ids)
            per_token.append(merged)

        return _intersect_all(per_token)

    def contains(self, field: str, query: Union[str, list[str]]) -> set[str]:
        """Field-scoped search. All tokens must appear in the given field."""
        queries = query if isinstance(query, list) else [query]
        tokens  = [t for q in queries for t in tokenise(q)]
        if not tokens:
            return set()

        per_token = [
            set(self._index.get(f"{field}:{token}", set()))
            for token in tokens
        ]
        return _intersect_all(per_token)

    # ── Lifecycle ──────────────────────────────────────────────────────────────

    def clear(self) -> None:
        self._index.clear()
        self._record_keys.clear()

    @property
    def token_count(self) -> int:
        return len(self._index)


# ── Helpers ───────────────────────────────────────────────────────────────────

_SPLIT_RE = re.compile(r"[\s\-_.,;:!?'\"()\[\]{}<>/\\|@#$%^&*+=~`]+")


def tokenise(value: str) -> list[str]:
    return [t for t in _SPLIT_RE.split(value.lower()) if len(t) > 2]


def _intersect_all(sets: list[set[str]]) -> set[str]:
    if not sets:
        return set()
    sets.sort(key=len)
    result = set(sets[0])
    for s in sets[1:]:
        result.intersection_update(s)
        if not result:
            break
    return result
