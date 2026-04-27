# =============================================================================
# vapor-idx — types.py
# All public type declarations and error classes.
# =============================================================================

from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any, Literal, Optional, Union

# ── Field primitives ──────────────────────────────────────────────────────────

FieldType     = Literal["string", "number", "boolean", "string[]", "number[]"]
IndexStrategy = Literal["none", "exact", "keyword", "prefix", "range"]
FilterOp      = Literal["eq", "neq", "in", "notIn", "contains", "startsWith",
                        "gt", "lt", "gte", "lte"]
Cardinality   = Literal["one-to-one", "one-to-many", "many-to-many"]

# ── Schema declarations ───────────────────────────────────────────────────────

@dataclass(frozen=True)
class FieldDefinition:
    type:     FieldType
    index:    IndexStrategy
    required: bool = False


@dataclass(frozen=True)
class RelationshipDefinition:
    targetTypes:  tuple[str, ...]   # use ('*',) to allow any type
    directed:     bool
    cardinality:  Cardinality


@dataclass(frozen=True)
class TypeDefinition:
    fields:        dict[str, FieldDefinition]
    relationships: dict[str, RelationshipDefinition] = field(default_factory=dict)


@dataclass(frozen=True)
class VaporSchema:
    types: dict[str, TypeDefinition]


# ── Records ───────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class VaporRecord:
    id:          str
    type:        str
    data:        dict[str, Any]
    _created_at: int
    _updated_at: int


# ── Relationships ─────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class VaporRelationship:
    id:                str
    relationship_type: str
    source_id:         str
    target_id:         str
    metadata:          dict[str, Any]
    _created_at:       int


# ── Query DSL ─────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class FieldFilter:
    field: str
    op:    FilterOp
    value: Any


@dataclass
class QueryOptions:
    type:     Optional[Union[str, list[str]]] = None
    where:    Optional[Union[FieldFilter, list[FieldFilter]]] = None
    keywords: Optional[Union[str, list[str]]] = None
    logic:    Literal["AND", "OR"] = "AND"
    limit:    Optional[int] = None
    offset:   int = 0
    order_by: Optional[tuple[str, Literal["asc", "desc"]]] = None


@dataclass
class TraversalOptions:
    from_id:      str
    relationship: str
    direction:    Literal["outgoing", "incoming", "both"] = "outgoing"
    depth:        int = 1
    filter:       Optional[QueryOptions] = None


@dataclass
class PathOptions:
    from_id:      str
    to_id:        str
    relationship: Optional[str] = None
    max_depth:    int = 10


# ── Results ───────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class QueryResult:
    records: list[VaporRecord]
    total:   int


@dataclass(frozen=True)
class TraversalEntry:
    record: VaporRecord
    depth:  int
    via:    list[str]


@dataclass(frozen=True)
class TraversalResult:
    records: list[VaporRecord]
    entries: list[TraversalEntry]


# ── Stats & snapshots ─────────────────────────────────────────────────────────

@dataclass(frozen=True)
class IndexStats:
    exact_entries:  int
    keyword_tokens: int
    prefix_nodes:   int
    range_entries:  int


@dataclass(frozen=True)
class VaporStats:
    total_records:        int
    records_by_type:      dict[str, int]
    total_relationships:  int
    relationships_by_type: dict[str, int]
    index_stats:          IndexStats
    memory_estimate_bytes: int


@dataclass
class VaporSnapshot:
    records:       list[VaporRecord]
    relationships: list[VaporRelationship]
    schema:        VaporSchema
    taken_at:      int
    schema_hash:   str


# ── Errors ────────────────────────────────────────────────────────────────────

class VaporError(Exception):
    def __init__(self, message: str) -> None:
        super().__init__(f"[vapor-idx] {message}")


class VaporSchemaError(VaporError):
    pass


class VaporQueryError(VaporError):
    pass


class VaporDestroyedError(VaporError):
    def __init__(self) -> None:
        super().__init__(
            "This VaporInstance has been destroyed. Create a new instance."
        )
