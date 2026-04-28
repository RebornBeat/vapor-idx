# =============================================================================
# vapor-idx — instance.py  (v2.0 — adds bulk ops: update_where, relate_many,
#                            query_adjacent; all existing methods unchanged)
# =============================================================================

from __future__ import annotations
import time
from .types import (
    VaporSchema, VaporRecord, VaporRelationship,
    QueryOptions, QueryResult,
    TraversalOptions, TraversalResult,
    PathOptions, VaporStats, IndexStats, VaporSnapshot,
    VaporDestroyedError, VaporError, FieldFilter,
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

    # ── NEW: Bulk conditional update ──────────────────────────────────────────

    def update_where(self, type_name: str, where: dict, data: dict) -> int:
        """
        Update all records of type_name whose fields match the where dict.
        where: {field_name: exact_value} — only equality matching supported.
        data: partial update dict applied to every matching record.

        Returns count of records updated.

        Example:
            # Update all pixels in cluster "c0042" to new color
            vapor.update_where("Pixel", {"cluster": "c0042"},
                               {"r": 200.0, "g": 50.0, "b": 50.0})

        Performance: O(matching_records) — far cheaper than N individual update() calls.
        Previously required: query() → iterate → update() per record = N+1 calls.
        Now: single call that applies update in one RecordStore pass.
        """
        self._assert_alive()
        return self._records.update_where(type_name, where, data)

    # ── NEW: Batch relationship insertion ─────────────────────────────────────

    def relate_many(self, edges: list[tuple[str, str, str]],
                    metadata: dict | None = None) -> int:
        """
        Insert multiple relationships in a single call.
        edges: list of (source_id, relationship_type, target_id) tuples.
        metadata: optional metadata dict applied to ALL edges (same dict reused).

        Returns count of edges successfully created.
        Silently skips edges where either source or target does not exist.
        Silently skips edges that would violate cardinality constraints.

        Example:
            # Build ADJACENT_TO for all pixel pairs in one call
            edges = []
            for y in range(0, H, step):
                for x in range(0, W, step):
                    if (x+step, y) in grid: edges.append((grid[(x,y)], "ADJACENT_TO", grid[(x+step,y)]))
                    if (x, y+step) in grid: edges.append((grid[(x,y)], "ADJACENT_TO", grid[(x,y+step)]))
            vapor.relate_many(edges)

        Performance: O(N) but with dramatically lower Python overhead than N relate() calls.
        """
        self._assert_alive()
        meta = metadata or {}
        created = 0
        for (source_id, rel_type, target_id) in edges:
            source = self._records.get(source_id)
            if source is None:
                continue
            target = self._records.get(target_id)
            if target is None:
                continue
            try:
                self._rels.relate(
                    source_id, source.type, rel_type,
                    target_id, target.type, meta
                )
                created += 1
            except VaporError:
                # Cardinality violation or schema error — skip silently
                pass
        return created

    # ── NEW: Filtered neighbor query ──────────────────────────────────────────

    def query_adjacent(self, record_id: str,
                       relationship_type: str,
                       direction: str = "both",
                       where: FieldFilter | list[FieldFilter] | None = None,
                       type_name: str | None = None) -> QueryResult:
        """
        Find neighbors connected via relationship_type that also match
        optional field filter criteria. Runs filter at the index level
        (no Python-side list comprehension needed).

        direction: "outgoing" | "incoming" | "both"
        where: FieldFilter or list of FieldFilter applied to neighbor records
        type_name: optional — restrict neighbors to this type

        Returns QueryResult with matching neighbor records.

        Example:
            # Find all adjacent clusters with semantic_class containing "frog"
            frog_neighbors = vapor.query_adjacent(
                cluster_id,
                "ADJACENT_TO",
                direction="both",
                where=FieldFilter("semantic_class", "contains", "frog"),
                type_name="Cluster",
            )

        Performance: Combines get_relationships() + query() in one optimized call.
        """
        self._assert_alive()

        # Step 1: Get neighbor IDs via relationship index
        neighbor_ids = self._rels.get_neighbour_ids(
            record_id, relationship_type, direction
        )

        if not neighbor_ids:
            return QueryResult(records=[], total=0)

        # Step 2: Fetch neighbor records
        neighbor_records = [
            self._records.get(nid)
            for nid in neighbor_ids
            if self._records.get(nid) is not None
        ]

        # Step 3: Apply type filter
        if type_name:
            neighbor_records = [r for r in neighbor_records if r.type == type_name]

        # Step 4: Apply field filters if provided
        if where is not None:
            filters = where if isinstance(where, list) else [where]
            # Import filter application from query engine
            matching_ids = set(r.id for r in neighbor_records)
            for filt in filters:
                type_of_first = neighbor_records[0].type if neighbor_records else None
                if type_of_first:
                    from .query_engine import _normalise_filters
                    from .schema import validate_filter
                    type_def = self._schema.types.get(type_of_first)
                    if type_def:
                        try:
                            validate_filter(filt, type_of_first, type_def)
                        except Exception:
                            continue  # Skip invalid filters rather than crash
                        matched_by_filter = self._query_eng._apply_filter(filt, type_of_first)
                        matching_ids &= matched_by_filter

            neighbor_records = [r for r in neighbor_records if r.id in matching_ids]

        return QueryResult(records=neighbor_records, total=len(neighbor_records))

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
        """
        Get all relationships for a record.

        DIRECTION RULES — always specify explicitly:
        - "both"     : undirected relationships (ADJACENT_TO, SYMMETRICAL_WITH,
                       CONNECTS, BORDERS)
        - "outgoing" : this record is the source (SAME_CLUSTER from pixel,
                       PART_OF from child, SPATIALLY_ABOVE from the higher cluster,
                       CONTAINS from parent, PARENT_OF from parent joint,
                       PART_OF_FACE from vertex, USES_MATERIAL from face,
                       FLOWS_BEFORE, VISUALLY_ABOVE)
        - "incoming" : this record is the target (SAME_CLUSTER from cluster,
                       PART_OF to parent, CONTAINS to child, PARENT_OF to child)

        NOTE: This method was previously called getRelationships() in some skill
        files. That name DOES NOT EXIST. The correct name is get_relationships().
        """
        self._assert_alive()
        return self._rels.get_edges_for_record(record_id, relationship_type, direction)

    # ── Query ──────────────────────────────────────────────────────────────────

    def query(self, options: QueryOptions) -> QueryResult:
        self._assert_alive()
        return self._query_eng.query(options)

    # ── Traversal ──────────────────────────────────────────────────────────────

    def traverse(self, options: TraversalOptions) -> TraversalResult:
        """
        BFS traversal from a start record through a relationship type.
        The optional `filter` parameter (QueryOptions) restricts which
        neighbor nodes are visited — runs at index level, not Python.

        Example with filter (most powerful usage):
            result = vapor.traverse(TraversalOptions(
                from_id=cluster_id,
                relationship="SPATIALLY_ABOVE",
                direction="incoming",
                depth=8,
                filter=QueryOptions(
                    type="Cluster",
                    where=FieldFilter("semantic_class", "contains", "frog")
                )
            ))
            # result.records = only frog clusters above this one
        """
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
