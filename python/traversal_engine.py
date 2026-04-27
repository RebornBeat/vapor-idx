# =============================================================================
# vapor-idx — traversal_engine.py
# =============================================================================

from __future__ import annotations
from collections import deque
from .types import (
    TraversalOptions, TraversalResult, TraversalEntry,
    PathOptions, VaporError,
)
from .record_store import RecordStore
from .relationship_store import RelationshipStore
from .query_engine import QueryEngine


class TraversalEngine:
    def __init__(
        self,
        records: RecordStore,
        relationships: RelationshipStore,
        query: QueryEngine,
    ) -> None:
        self._records       = records
        self._relationships = relationships
        self._query         = query

    def traverse(self, options: TraversalOptions) -> TraversalResult:
        from_id      = options.from_id
        rel_type     = options.relationship
        direction    = options.direction
        max_depth    = options.depth
        filt         = options.filter

        if not self._records.has(from_id):
            raise VaporError(f'Traversal start record "{from_id}" does not exist.')

        visited: set[str]          = {from_id}
        entries: list[TraversalEntry] = []
        result_records               = []

        # BFS: (current_id, depth, via)
        queue: deque[tuple[str, int, list[str]]] = deque([(from_id, 0, [])])

        while queue:
            current_id, current_depth, via = queue.popleft()
            if current_depth >= max_depth:
                continue

            neighbours = self._relationships.get_neighbour_ids(current_id, rel_type, direction)
            for neighbour_id in neighbours:
                if neighbour_id in visited:
                    continue
                visited.add(neighbour_id)

                record = self._records.get(neighbour_id)
                if record is None:
                    continue

                if filt:
                    match = self._query.query(filt)
                    if not any(r.id == neighbour_id for r in match.records):
                        continue

                entry = TraversalEntry(record=record, depth=current_depth + 1, via=list(via) + [current_id])
                entries.append(entry)
                result_records.append(record)

                if current_depth + 1 < max_depth:
                    queue.append((neighbour_id, current_depth + 1, list(via) + [current_id]))

        return TraversalResult(records=result_records, entries=entries)

    def find_path(self, options: PathOptions) -> list[str] | None:
        from_id  = options.from_id
        to_id    = options.to_id
        rel_type = options.relationship
        max_d    = options.max_depth

        if not self._records.has(from_id):
            raise VaporError(f'Path start "{from_id}" does not exist.')
        if not self._records.has(to_id):
            raise VaporError(f'Path end "{to_id}" does not exist.')
        if from_id == to_id:
            return [from_id]

        visited: set[str]               = {from_id}
        queue:   deque[tuple[str, list[str]]] = deque([(from_id, [from_id])])

        while queue:
            current_id, path = queue.popleft()
            if len(path) - 1 >= max_d:
                continue
            edges = self._relationships.get_edges_for_record(current_id, rel_type, "both")
            for edge in edges:
                neighbour_id = edge.target_id if edge.source_id == current_id else edge.source_id
                if neighbour_id in visited:
                    continue
                visited.add(neighbour_id)
                new_path = path + [neighbour_id]
                if neighbour_id == to_id:
                    return new_path
                queue.append((neighbour_id, new_path))
        return None
