# =============================================================================
# vapor-idx — record_store.py
# Primary record storage and per-type index management.
# =============================================================================

from __future__ import annotations
import time
from dataclasses import dataclass
from typing import Any

from .types import VaporRecord, VaporSchema, IndexStrategy, VaporError
from .schema import validate_record_data
from .indexes import ExactIndex, KeywordIndex, PrefixIndex, RangeIndex


@dataclass
class _TypeIndexes:
    exact:      ExactIndex
    keyword:    KeywordIndex
    prefix:     PrefixIndex
    range_:     RangeIndex
    strategies: dict[str, IndexStrategy]


class RecordStore:
    def __init__(self, schema: VaporSchema) -> None:
        self._schema     = schema
        self._records:    dict[str, VaporRecord] = {}
        self._by_type:    dict[str, set[str]]    = {}
        self._type_idxs:  dict[str, _TypeIndexes] = {}
        self._counter     = 0
        self._init_indexes()

    def _init_indexes(self) -> None:
        for type_name, type_def in self._schema.types.items():
            strats: dict[str, IndexStrategy] = {
                fn: fd.index for fn, fd in type_def.fields.items()
            }
            self._type_idxs[type_name] = _TypeIndexes(
                exact=ExactIndex(), keyword=KeywordIndex(),
                prefix=PrefixIndex(), range_=RangeIndex(),
                strategies=strats,
            )
            self._by_type[type_name] = set()

    # ── Mutation ───────────────────────────────────────────────────────────────

    def store(self, type_name: str, data: dict[str, Any]) -> str:
        type_def = self._schema.types.get(type_name)
        if type_def is None:
            raise VaporError(f'Unknown type "{type_name}".')
        validate_record_data(type_name, type_def, data)

        record_id = self._next_id()
        now       = int(time.time() * 1000)
        record    = VaporRecord(
            id=record_id, type=type_name, data=dict(data),
            _created_at=now, _updated_at=now,
        )
        self._records[record_id] = record
        self._by_type[type_name].add(record_id)
        self._index_record(type_name, record_id, data)
        return record_id

    def update(self, record_id: str, partial: dict[str, Any]) -> None:
        record = self._records.get(record_id)
        if record is None:
            raise VaporError(f'Record "{record_id}" does not exist.')
        type_def = self._schema.types[record.type]
        merged   = {**record.data, **partial}
        validate_record_data(record.type, type_def, merged)
        self._unindex_fields(record.type, record_id, record.data, list(partial.keys()))
        updated = VaporRecord(
            id=record_id, type=record.type, data=merged,
            _created_at=record._created_at, _updated_at=int(time.time() * 1000),
        )
        self._records[record_id] = updated
        self._index_fields(record.type, record_id, merged, list(partial.keys()))

    def delete(self, record_id: str) -> None:
        record = self._records.pop(record_id, None)
        if record is None:
            return
        self._unindex_record(record.type, record_id, record.data)
        self._by_type.get(record.type, set()).discard(record_id)

    # ── Lookup ─────────────────────────────────────────────────────────────────

    def get(self, record_id: str) -> VaporRecord | None:
        return self._records.get(record_id)

    def has(self, record_id: str) -> bool:
        return record_id in self._records

    def get_all(self) -> list[VaporRecord]:
        return list(self._records.values())

    def get_all_by_type(self, type_name: str) -> list[VaporRecord]:
        ids = self._by_type.get(type_name, set())
        return [self._records[i] for i in ids if i in self._records]

    def get_type_id_set(self, type_name: str) -> set[str]:
        return set(self._by_type.get(type_name, set()))

    def get_indexes(self, type_name: str) -> _TypeIndexes | None:
        return self._type_idxs.get(type_name)

    def get_types(self) -> list[str]:
        return list(self._by_type.keys())

    # ── Indexing ───────────────────────────────────────────────────────────────

    def _index_record(self, type_name: str, record_id: str, data: dict) -> None:
        self._index_fields(type_name, record_id, data, list(data.keys()))

    def _index_fields(self, type_name: str, record_id: str, data: dict, fields: list[str]) -> None:
        ti = self._type_idxs[type_name]
        for field_name in fields:
            value    = data.get(field_name)
            strategy = ti.strategies.get(field_name, "none")
            if strategy == "none":
                continue
            if strategy == "exact":
                ti.exact.add(field_name, value, record_id)
            elif strategy == "keyword":
                ti.keyword.add(field_name, value, record_id)
            elif strategy == "prefix":
                ti.prefix.add(field_name, value, record_id)
            elif strategy == "range":
                ti.range_.add(field_name, value, record_id)

    def _unindex_record(self, type_name: str, record_id: str, data: dict) -> None:
        self._unindex_fields(type_name, record_id, data, list(data.keys()))

    def _unindex_fields(self, type_name: str, record_id: str, data: dict, fields: list[str]) -> None:
        ti = self._type_idxs[type_name]
        for field_name in fields:
            value    = data.get(field_name)
            strategy = ti.strategies.get(field_name, "none")
            if strategy == "none":
                continue
            if strategy == "exact":
                ti.exact.remove(field_name, value, record_id)
            elif strategy == "keyword":
                ti.keyword.remove(record_id)
            elif strategy == "prefix":
                ti.prefix.remove(field_name, value, record_id)
            elif strategy == "range":
                ti.range_.remove(field_name, value, record_id)

    # ── Stats ──────────────────────────────────────────────────────────────────

    @property
    def total_records(self) -> int:
        return len(self._records)

    @property
    def record_counts_by_type(self) -> dict[str, int]:
        return {t: len(ids) for t, ids in self._by_type.items()}

    @property
    def index_stats(self) -> dict:
        exact = keyword = prefix = range_ = 0
        for ti in self._type_idxs.values():
            exact   += ti.exact.entry_count
            keyword += ti.keyword.token_count
            prefix  += ti.prefix.node_count
            range_  += ti.range_.entry_count
        return {
            "exact_entries":  exact,
            "keyword_tokens": keyword,
            "prefix_nodes":   prefix,
            "range_entries":  range_,
        }

    # ── Lifecycle ──────────────────────────────────────────────────────────────

    def clear(self) -> None:
        self._records.clear()
        for ti in self._type_idxs.values():
            ti.exact.clear(); ti.keyword.clear()
            ti.prefix.clear(); ti.range_.clear()
        for s in self._by_type.values():
            s.clear()

    def _next_id(self) -> str:
        self._counter += 1
        ts = int(time.time() * 1000)
        return f"vpr_{ts:x}_{self._counter:x}"
