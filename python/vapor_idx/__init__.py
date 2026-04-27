# =============================================================================
# vapor-idx — __init__.py
# Public API surface.
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
