# =============================================================================
# vapor-idx — instance.py
# =============================================================================

from __future__ import annotations
import time
from .types import (
    VaporSchema, VaporRecord, VaporRelationship,
    QueryOptions, QueryResult,
    TraversalOptions, TraversalResult,
    PathOptions, VaporStats, IndexStats, VaporSnapshot,
    VaporDestroyedError, VaporError,
)
from .schema import validate_schema, hash_schema
from .record_store import RecordStore
from .relationship_store import RelationshipStore
from .query_engine import QueryEngine
from .traversal_engine import TraversalEngine


class VaporInstance:
    def __init__(self, schema: VaporSchema) -> None:
        validate_schema(schema)
        self._schema    = schema
        self._hash      = hash_schema(schema)
        self._records   = RecordStore(schema)
        self._rels      = RelationshipStore(schema)
        self._query_eng = QueryEngine(self._records)
        self._traversal = TraversalEngine(self._records, self._rels, self._query_eng)
        self._destroyed = False

    # ── Record CRUD ────────────────────────────────────────────────────────────

    def store(self, type_name: str, data: dict) -> str:
        self._assert_alive()
        return self._records.store(type_name, data)

    def get(self, record_id: str) -> VaporRecord | None:
        self._assert_alive()
        return self._records.get(record_id)

    def update(self, record_id: str, partial: dict) -> None:
        self._assert_alive()
        self._records.update(record_id, partial)

    def delete(self, record_id: str) -> None:
        self._assert_alive()
        self._rels.remove_for_record(record_id)
        self._records.delete(record_id)

    # ── Relationships ──────────────────────────────────────────────────────────

    def relate(
        self,
        source_id: str,
        relationship_type: str,
        target_id: str,
        metadata: dict | None = None,
    ) -> str:
        self._assert_alive()
        source = self._records.get(source_id)
        if source is None:
            raise VaporError(f'Source record "{source_id}" does not exist.')
        target = self._records.get(target_id)
        if target is None:
            raise VaporError(f'Target record "{target_id}" does not exist.')
        return self._rels.relate(
            source_id, source.type, relationship_type,
            target_id, target.type, metadata or {}
        )

    def unrelate(self, edge_id: str) -> None:
        self._assert_alive()
        self._rels.unrelate(edge_id)

    def get_relationships(
        self,
        record_id: str,
        relationship_type: str | None = None,
        direction: str = "both",
    ) -> list[VaporRelationship]:
        self._assert_alive()
        return self._rels.get_edges_for_record(record_id, relationship_type, direction)

    # ── Query ──────────────────────────────────────────────────────────────────

    def query(self, options: QueryOptions) -> QueryResult:
        self._assert_alive()
        return self._query_eng.query(options)

    # ── Traversal ──────────────────────────────────────────────────────────────

    def traverse(self, options: TraversalOptions) -> TraversalResult:
        self._assert_alive()
        return self._traversal.traverse(options)

    def find_path(self, options: PathOptions) -> list[str] | None:
        self._assert_alive()
        return self._traversal.find_path(options)

    # ── Introspection ──────────────────────────────────────────────────────────

    def stats(self) -> VaporStats:
        self._assert_alive()
        is_  = self._records.index_stats
        idx  = IndexStats(
            exact_entries=is_["exact_entries"],
            keyword_tokens=is_["keyword_tokens"],
            prefix_nodes=is_["prefix_nodes"],
            range_entries=is_["range_entries"],
        )
        mem = (
            self._records.total_records * 500 +
            self._rels.total_edges * 200 +
            idx.exact_entries * 100 +
            idx.keyword_tokens * 80 +
            idx.prefix_nodes * 120 +
            idx.range_entries * 48
        )
        return VaporStats(
            total_records=self._records.total_records,
            records_by_type=self._records.record_counts_by_type,
            total_relationships=self._rels.total_edges,
            relationships_by_type=self._rels.edge_counts_by_type,
            index_stats=idx,
            memory_estimate_bytes=mem,
        )

    # ── Snapshot / restore ─────────────────────────────────────────────────────

    def snapshot(self) -> VaporSnapshot:
        self._assert_alive()
        return VaporSnapshot(
            records=self._records.get_all(),
            relationships=self._rels.get_all(),
            schema=self._schema,
            taken_at=int(time.time() * 1000),
            schema_hash=self._hash,
        )

    def restore(self, snapshot: VaporSnapshot) -> "VaporInstance":
        self._assert_alive()
        if snapshot.schema_hash != self._hash:
            raise VaporError("Cannot restore snapshot: schema hash mismatch.")
        fresh  = VaporInstance(self._schema)
        id_map: dict[str, str] = {}
        sorted_records = sorted(snapshot.records, key=lambda r: r._created_at)
        for record in sorted_records:
            new_id = fresh.store(record.type, dict(record.data))
            id_map[record.id] = new_id
        for edge in snapshot.relationships:
            if edge.metadata.get("_reverse"):
                continue
            ns = id_map.get(edge.source_id)
            nt = id_map.get(edge.target_id)
            if ns and nt:
                meta = {k: v for k, v in edge.metadata.items() if k != "_reverse"}
                fresh.relate(ns, edge.relationship_type, nt, meta)
        return fresh

    # ── Lifecycle ──────────────────────────────────────────────────────────────

    def destroy(self) -> None:
        if self._destroyed:
            return
        self._records.clear()
        self._rels.clear()
        self._destroyed = True

    @property
    def is_destroyed(self) -> bool:
        return self._destroyed

    def _assert_alive(self) -> None:
        if self._destroyed:
            raise VaporDestroyedError()
