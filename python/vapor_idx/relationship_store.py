# =============================================================================
# vapor-idx — relationship_store.py
# =============================================================================

from __future__ import annotations
import time
from collections import defaultdict
from .types import VaporRelationship, VaporSchema, VaporError, VaporSchemaError


class RelationshipStore:
    def __init__(self, schema: VaporSchema) -> None:
        self._schema  = schema
        self._edges:  dict[str, VaporRelationship] = {}
        self._out:    dict[str, dict[str, set[str]]] = defaultdict(lambda: defaultdict(set))
        self._inc:    dict[str, dict[str, set[str]]] = defaultdict(lambda: defaultdict(set))
        self._by_type: dict[str, set[str]] = defaultdict(set)
        self._counter = 0

    def relate(
        self,
        source_id: str, source_type: str,
        rel_type: str,
        target_id: str, target_type: str,
        metadata: dict,
    ) -> str:
        type_def = self._schema.types.get(source_type)
        if type_def is None:
            raise VaporError(f'Unknown source type "{source_type}".')
        rel_def = type_def.relationships.get(rel_type)
        if rel_def is None:
            raise VaporSchemaError(
                f'Relationship "{rel_type}" not declared on type "{source_type}".'
            )
        if "*" not in rel_def.targetTypes and target_type not in rel_def.targetTypes:
            raise VaporSchemaError(
                f'Relationship "{rel_type}" from "{source_type}" does not allow '
                f'target type "{target_type}". Allowed: {list(rel_def.targetTypes)}.'
            )
        self._enforce_cardinality(source_id, target_id, rel_type, rel_def.cardinality)

        edge_id = self._next_id()
        now     = int(time.time() * 1000)
        edge    = VaporRelationship(
            id=edge_id, relationship_type=rel_type,
            source_id=source_id, target_id=target_id,
            metadata=dict(metadata), _created_at=now,
        )
        self._edges[edge_id] = edge
        self._add_adjacency(source_id, target_id, rel_type, edge_id)
        self._by_type[rel_type].add(edge_id)

        if not rel_def.directed:
            rev_id  = self._next_id()
            rev_meta = {**metadata, "_reverse": True}
            rev_edge = VaporRelationship(
                id=rev_id, relationship_type=rel_type,
                source_id=target_id, target_id=source_id,
                metadata=rev_meta, _created_at=now,
            )
            self._edges[rev_id] = rev_edge
            self._add_adjacency(target_id, source_id, rel_type, rev_id)
            self._by_type[rel_type].add(rev_id)

        return edge_id

    def unrelate(self, edge_id: str) -> None:
        edge = self._edges.pop(edge_id, None)
        if edge is None:
            return
        self._out[edge.source_id][edge.relationship_type].discard(edge_id)
        self._inc[edge.target_id][edge.relationship_type].discard(edge_id)
        self._by_type[edge.relationship_type].discard(edge_id)

    def remove_for_record(self, record_id: str) -> None:
        to_remove: list[str] = []
        for edgeset in self._out.get(record_id, {}).values():
            to_remove.extend(edgeset)
        for edgeset in self._inc.get(record_id, {}).values():
            to_remove.extend(edgeset)
        for eid in to_remove:
            self.unrelate(eid)

    def get_edges_for_record(
        self,
        record_id: str,
        rel_type: str | None = None,
        direction: str = "both",
    ) -> list[VaporRelationship]:
        edge_ids: set[str] = set()
        if direction in ("outgoing", "both"):
            out = self._out.get(record_id, {})
            if rel_type:
                edge_ids.update(out.get(rel_type, set()))
            else:
                for s in out.values():
                    edge_ids.update(s)
        if direction in ("incoming", "both"):
            inc = self._inc.get(record_id, {})
            if rel_type:
                edge_ids.update(inc.get(rel_type, set()))
            else:
                for s in inc.values():
                    edge_ids.update(s)
        return [self._edges[eid] for eid in edge_ids if eid in self._edges]

    def get_neighbour_ids(self, record_id: str, rel_type: str, direction: str = "outgoing") -> list[str]:
        edges = self.get_edges_for_record(record_id, rel_type, direction)
        return [e.target_id if e.source_id == record_id else e.source_id for e in edges]

    def get_all(self) -> list[VaporRelationship]:
        return list(self._edges.values())

    @property
    def total_edges(self) -> int:
        return len(self._edges)

    @property
    def edge_counts_by_type(self) -> dict[str, int]:
        return {t: len(s) for t, s in self._by_type.items()}

    def clear(self) -> None:
        self._edges.clear()
        self._out.clear()
        self._inc.clear()
        self._by_type.clear()

    def _enforce_cardinality(self, source_id, target_id, rel_type, cardinality) -> None:
        if cardinality == "many-to-many":
            return
        out_count = len(self._out.get(source_id, {}).get(rel_type, set()))
        if cardinality in ("one-to-one", "one-to-many") and out_count > 0:
            if cardinality == "one-to-one":
                raise VaporError(f'Cardinality violation: "{rel_type}" is one-to-one.')
        if cardinality == "one-to-one":
            in_count = len(self._inc.get(target_id, {}).get(rel_type, set()))
            if in_count > 0:
                raise VaporError(f'Cardinality violation: "{rel_type}" target already has incoming edge.')

    def _add_adjacency(self, source_id, target_id, rel_type, edge_id) -> None:
        self._out[source_id][rel_type].add(edge_id)
        self._inc[target_id][rel_type].add(edge_id)

    def _next_id(self) -> str:
        self._counter += 1
        return f"vpe_{int(time.time()*1000):x}_{self._counter:x}"
