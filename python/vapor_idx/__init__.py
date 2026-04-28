# =============================================================================
# vapor-idx — __init__.py  (v2.0)
# Public API surface. Now includes update_where, relate_many, query_adjacent.
# =============================================================================

from .instance import VaporInstance
from .types import (
    VaporSchema, TypeDefinition, FieldDefinition, RelationshipDefinition,
    VaporRecord, VaporRelationship,
    QueryOptions, QueryResult, FieldFilter,
    TraversalOptions, TraversalResult, TraversalEntry,
    PathOptions, VaporStats, IndexStats, VaporSnapshot,
    VaporError, VaporSchemaError, VaporQueryError, VaporDestroyedError,
)


def create_vapor(schema_dict: dict) -> VaporInstance:
    """
    Create a new Vapor index instance from a schema dictionary.

    The dictionary mirrors the TypeScript API shape:
    {
        "types": {
            "MyType": {
                "fields": {
                    "name": {"type": "string", "index": "exact", "required": True},
                },
                "relationships": {
                    "LINKS_TO": {
                        "targetTypes": ["MyType"],
                        "directed": True,
                        "cardinality": "many-to-many",
                    }
                }
            }
        }
    }

    New in v2.0 — available on returned VaporInstance:
    - vapor.update_where(type_name, where_dict, data_dict) -> int
    - vapor.relate_many(edges: list[tuple[str,str,str]]) -> int
    - vapor.query_adjacent(record_id, rel_type, direction, where, type_name) -> QueryResult

    get_relationships() direction rules (critical — read carefully):
    - "both"     : undirected: ADJACENT_TO, SYMMETRICAL_WITH, CONNECTS, BORDERS
    - "outgoing" : this is source: SAME_CLUSTER (pixel), PART_OF (child),
                   SPATIALLY_ABOVE (higher cluster), CONTAINS (parent),
                   PARENT_OF (parent joint), PART_OF_FACE (vertex),
                   USES_MATERIAL (face), FLOWS_BEFORE, VISUALLY_ABOVE
    - "incoming" : this is target: SAME_CLUSTER (cluster),
                   CONTAINS (child looking for parent),
                   PARENT_OF (child looking for children)

    NEVER call vapor.getRelationships() — that method does not exist.
    Always use vapor.get_relationships() (snake_case).
    """
    types: dict = {}
    for type_name, type_dict in schema_dict.get("types", {}).items():
        fields = {
            fn: FieldDefinition(
                type=fd["type"],
                index=fd["index"],
                required=fd.get("required", False),
            )
            for fn, fd in type_dict.get("fields", {}).items()
        }
        relationships = {
            rn: RelationshipDefinition(
                targetTypes=tuple(rd["targetTypes"]),
                directed=rd["directed"],
                cardinality=rd["cardinality"],
            )
            for rn, rd in type_dict.get("relationships", {}).items()
        }
        types[type_name] = TypeDefinition(fields=fields, relationships=relationships)

    return VaporInstance(VaporSchema(types=types))


__all__ = [
    "create_vapor",
    "VaporInstance",
    "VaporSchema",
    "TypeDefinition",
    "FieldDefinition",
    "RelationshipDefinition",
    "VaporRecord",
    "VaporRelationship",
    "QueryOptions",
    "QueryResult",
    "FieldFilter",
    "TraversalOptions",
    "TraversalResult",
    "TraversalEntry",
    "PathOptions",
    "VaporStats",
    "IndexStats",
    "VaporSnapshot",
    "VaporError",
    "VaporSchemaError",
    "VaporQueryError",
    "VaporDestroyedError",
]
