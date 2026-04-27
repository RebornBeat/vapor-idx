# =============================================================================
# vapor-idx — query_engine.py
# Executes queries against RecordStore indexes.
# =============================================================================

from __future__ import annotations
from typing import Any
from .types import VaporRecord, QueryOptions, QueryResult, FieldFilter, VaporQueryError
from .record_store import RecordStore
from .schema import validate_filter


class QueryEngine:
    def __init__(self, store: RecordStore) -> None:
        self._store = store

    def query(self, options: QueryOptions) -> QueryResult:
        types = _resolve_types(options.type, self._store.get_types())
        candidate_ids: set[str] | None = None

        for type_name in types:
            # Access schema via the public property — no mangled-name access.
            type_def = self._store.schema.types.get(type_name)
            if type_def is None:
                continue
            type_id_set = self._store.get_type_id_set(type_name)
            if not type_id_set:
                continue

            filters = _normalise_filters(options.where)
            for filt in filters:
                validate_filter(filt, type_name, type_def)

            filtered       = self._apply_filters(type_name, type_id_set, filters, options.logic)
            after_keywords = self._apply_keywords(type_name, filtered, options.keywords)

            if candidate_ids is None:
                candidate_ids = after_keywords
            else:
                candidate_ids.update(after_keywords)

        if not candidate_ids:
            return QueryResult(records=[], total=0)

        records = [r for i in candidate_ids if (r := self._store.get(i)) is not None]

        if options.order_by:
            field, direction = options.order_by
            records = sorted(
                records,
                key=lambda r: (r.data.get(field) is None, r.data.get(field)),
                reverse=(direction == "desc"),
            )

        total   = len(records)
        offset  = options.offset or 0
        records = records[offset: offset + options.limit if options.limit else None]
        return QueryResult(records=records, total=total)

    # ── Filter application ─────────────────────────────────────────────────────

    def _apply_filters(
        self,
        type_name: str,
        seed:      set[str],
        filters:   list[FieldFilter],
        logic:     str,
    ) -> set[str]:
        if not filters:
            return seed
        if logic == "AND":
            current = set(seed)
            for filt in filters:
                matched  = self._apply_filter(filt, type_name)
                current &= matched
                if not current:
                    break
            return current
        else:  # OR
            union_result: set[str] = set()
            for filt in filters:
                matched = self._apply_filter(filt, type_name)
                union_result.update(matched & seed)
            return union_result

    def _apply_filter(self, filt: FieldFilter, type_name: str) -> set[str]:
        ti = self._store.get_indexes(type_name)
        if ti is None:
            return set()
        op, field, value = filt.op, filt.field, filt.value

        if op == "eq":          return ti.exact.eq(field, value)
        if op == "neq":         return ti.exact.neq(field, value)
        if op == "in":          return ti.exact.find_in(field, value)
        if op == "notIn":       return ti.exact.not_in(field, value)
        if op == "contains":    return ti.keyword.contains(field, value)
        if op == "startsWith":  return ti.prefix.starts_with(field, value)
        if op == "gt":          return ti.range_.gt(field, value)
        if op == "lt":          return ti.range_.lt(field, value)
        if op == "gte":         return ti.range_.gte(field, value)
        if op == "lte":         return ti.range_.lte(field, value)
        raise VaporQueryError(f'Unknown operator "{op}".')

    def _apply_keywords(
        self,
        type_name: str,
        seed:      set[str],
        keywords:  Any,
    ) -> set[str]:
        if not keywords:
            return seed
        ti = self._store.get_indexes(type_name)
        if ti is None:
            return seed
        matched = ti.keyword.search(keywords)
        return seed & matched


# ── Helpers ───────────────────────────────────────────────────────────────────

def _resolve_types(type_opt: Any, all_types: list[str]) -> list[str]:
    if type_opt is None:
        return all_types
    if isinstance(type_opt, list):
        return type_opt
    return [type_opt]


def _normalise_filters(where: Any) -> list[FieldFilter]:
    if not where:
        return []
    if isinstance(where, list):
        return where
    return [where]
