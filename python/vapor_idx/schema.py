# =============================================================================
# vapor-idx — schema.py
# Schema validation and record data validation.
# =============================================================================

from __future__ import annotations
import json
from .types import (
    VaporSchema, TypeDefinition, FieldDefinition,
    FieldFilter, FilterOp,
    VaporSchemaError, VaporQueryError,
)

VALID_FIELD_TYPES  = {"string", "number", "boolean", "string[]", "number[]"}
VALID_STRATEGIES   = {"none", "exact", "keyword", "prefix", "range"}
RANGE_OPS          = {"gt", "lt", "gte", "lte"}
OP_STRATEGY_MAP: dict[str, list[str]] = {
    "eq":         ["exact"],
    "neq":        ["exact"],
    "in":         ["exact"],
    "notIn":      ["exact"],
    "contains":   ["keyword"],
    "startsWith": ["prefix"],
    "gt":         ["range"],
    "lt":         ["range"],
    "gte":        ["range"],
    "lte":        ["range"],
}


def validate_schema(schema: VaporSchema) -> None:
    if not schema.types:
        raise VaporSchemaError("Schema must declare at least one type.")

    declared_types = set(schema.types.keys())

    for type_name, type_def in schema.types.items():
        _validate_type_name(type_name)
        _validate_type_def(type_name, type_def, declared_types)


def _validate_type_name(name: str) -> None:
    import re
    if not re.match(r'^[A-Za-z][A-Za-z0-9_]*$', name):
        raise VaporSchemaError(
            f'Type name "{name}" must start with a letter and contain only '
            f'letters, digits, and underscores.'
        )


def _validate_type_def(
    type_name: str,
    type_def: TypeDefinition,
    declared_types: set[str],
) -> None:
    if not type_def.fields:
        raise VaporSchemaError(f'Type "{type_name}" must declare at least one field.')

    for field_name, field_def in type_def.fields.items():
        if field_def.type not in VALID_FIELD_TYPES:
            raise VaporSchemaError(
                f'Field "{field_name}" on type "{type_name}" has invalid type '
                f'"{field_def.type}". Valid: {sorted(VALID_FIELD_TYPES)}.'
            )
        if field_def.index not in VALID_STRATEGIES:
            raise VaporSchemaError(
                f'Field "{field_name}" on type "{type_name}" has invalid index '
                f'"{field_def.index}". Valid: {sorted(VALID_STRATEGIES)}.'
            )
        if field_def.index == "range" and not field_def.type.startswith("number"):
            raise VaporSchemaError(
                f'Field "{field_name}" on type "{type_name}" uses "range" index '
                f'but has type "{field_def.type}". Range requires number or number[].'
            )

    for rel_name, rel_def in type_def.relationships.items():
        if not rel_def.targetTypes:
            raise VaporSchemaError(
                f'Relationship "{rel_name}" on type "{type_name}" must declare targetTypes.'
            )
        for target in rel_def.targetTypes:
            if target != "*" and target not in declared_types:
                raise VaporSchemaError(
                    f'Relationship "{rel_name}" on type "{type_name}" references '
                    f'undeclared target type "{target}".'
                )


def validate_record_data(
    type_name: str,
    type_def: TypeDefinition,
    data: dict,
) -> None:
    for field_name, field_def in type_def.fields.items():
        if field_def.required and field_name not in data:
            raise VaporSchemaError(
                f'Required field "{field_name}" is missing on type "{type_name}".'
            )

    for field_name, value in data.items():
        field_def = type_def.fields.get(field_name)
        if field_def is None:
            continue  # unknown fields are stored but not indexed
        if value is None:
            if field_def.required:
                raise VaporSchemaError(
                    f'Required field "{field_name}" on type "{type_name}" must not be None.'
                )
            continue
        _validate_field_value(type_name, field_name, field_def.type, value)


def _validate_field_value(type_name: str, field_name: str, field_type: str, value: object) -> None:
    if field_type == "string" and not isinstance(value, str):
        raise VaporSchemaError(f'Field "{field_name}" on "{type_name}" expects str, got {type(value).__name__}.')
    elif field_type == "number" and not isinstance(value, (int, float)):
        raise VaporSchemaError(f'Field "{field_name}" on "{type_name}" expects number, got {type(value).__name__}.')
    elif field_type == "boolean" and not isinstance(value, bool):
        raise VaporSchemaError(f'Field "{field_name}" on "{type_name}" expects bool, got {type(value).__name__}.')
    elif field_type == "string[]":
        if not isinstance(value, list) or not all(isinstance(i, str) for i in value):
            raise VaporSchemaError(f'Field "{field_name}" on "{type_name}" expects list[str].')
    elif field_type == "number[]":
        if not isinstance(value, list) or not all(isinstance(i, (int, float)) for i in value):
            raise VaporSchemaError(f'Field "{field_name}" on "{type_name}" expects list[number].')


def validate_filter(filt: FieldFilter, type_name: str, type_def: TypeDefinition) -> None:
    field_def = type_def.fields.get(filt.field)
    if field_def is None:
        raise VaporQueryError(
            f'Query references field "{filt.field}" not declared on type "{type_name}".'
        )
    valid_strategies = OP_STRATEGY_MAP.get(filt.op)
    if valid_strategies is None:
        raise VaporQueryError(f'Unknown filter operator "{filt.op}".')
    if field_def.index not in valid_strategies:
        raise VaporQueryError(
            f'Operator "{filt.op}" requires index [{", ".join(valid_strategies)}] '
            f'but field "{filt.field}" on type "{type_name}" uses "{field_def.index}".'
        )
    if filt.op in RANGE_OPS and not isinstance(filt.value, (int, float)):
        raise VaporQueryError(
            f'Operator "{filt.op}" requires a numeric value, got {type(filt.value).__name__}.'
        )


def hash_schema(schema: VaporSchema) -> str:
    serialised = json.dumps(
        {k: str(v) for k, v in schema.types.items()},
        sort_keys=True
    )
    h = 0
    for ch in serialised:
        h = ((h << 5) - h) + ord(ch)
        h &= 0xFFFFFFFF
    return hex(h)[2:]
