// =============================================================================
// vapor-idx — schema.rs
// Schema validation, record data validation, filter validation, schema hashing.
// validate_filter lives here so query_engine can import it without re-defining it.
// =============================================================================

use crate::types::*;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

pub fn validate_schema(schema: &VaporSchema) -> VaporResult<()> {
    if schema.types.is_empty() {
        return Err(VaporError::Schema(
            "Schema must declare at least one type.".into(),
        ));
    }
    let declared: std::collections::HashSet<&str> =
        schema.types.keys().map(|s| s.as_str()).collect();

    for (type_name, type_def) in &schema.types {
        for (field_name, field_def) in &type_def.fields {
            if field_def.index == IndexStrategy::Range
                && field_def.field_type != FieldType::Number
                && field_def.field_type != FieldType::NumberArray
            {
                return Err(VaporError::Schema(format!(
                    "Field \"{field_name}\" on \"{type_name}\" uses Range index \
                     but is not a number type."
                )));
            }
        }
        for (rel_name, rel_def) in &type_def.relationships {
            for target in &rel_def.target_types {
                if target != "*" && !declared.contains(target.as_str()) {
                    return Err(VaporError::Schema(format!(
                        "Relationship \"{rel_name}\" on \"{type_name}\" references \
                         undeclared type \"{target}\"."
                    )));
                }
            }
        }
    }
    Ok(())
}

pub fn validate_record_data(
    type_name: &str,
    type_def: &TypeDefinition,
    data: &serde_json::Value,
) -> VaporResult<()> {
    let obj = data
        .as_object()
        .ok_or_else(|| VaporError::Schema("Record data must be a JSON object.".into()))?;
    for (field_name, field_def) in &type_def.fields {
        if field_def.required && !obj.contains_key(field_name) {
            return Err(VaporError::Schema(format!(
                "Required field \"{field_name}\" missing on type \"{type_name}\"."
            )));
        }
    }
    Ok(())
}

/// Validate that a FieldFilter's operator is compatible with the declared
/// index strategy on the target field.
/// Defined here (not in query_engine) so it can be imported cleanly with
/// `use crate::schema::validate_filter` without creating a duplicate symbol.
pub fn validate_filter(
    filter: &FieldFilter,
    type_name: &str,
    type_def: &TypeDefinition,
) -> VaporResult<()> {
    let field_def = type_def.fields.get(&filter.field).ok_or_else(|| {
        VaporError::Query(format!(
            "Field \"{}\" not declared on type \"{type_name}\".",
            filter.field
        ))
    })?;

    let valid = match &filter.op {
        FilterOp::Eq | FilterOp::Neq | FilterOp::In | FilterOp::NotIn => {
            field_def.index == IndexStrategy::Exact
        }
        FilterOp::Contains => field_def.index == IndexStrategy::Keyword,
        FilterOp::StartsWith => field_def.index == IndexStrategy::Prefix,
        FilterOp::Gt | FilterOp::Lt | FilterOp::Gte | FilterOp::Lte => {
            field_def.index == IndexStrategy::Range
        }
    };

    if !valid {
        return Err(VaporError::Query(format!(
            "Operator {:?} is not valid for field \"{}\" with index strategy {:?}.",
            filter.op, filter.field, field_def.index
        )));
    }
    Ok(())
}

pub fn hash_schema(schema: &VaporSchema) -> String {
    let mut hasher = DefaultHasher::new();
    let serialised = serde_json::to_string(schema).unwrap_or_default();
    serialised.hash(&mut hasher);
    format!("{:x}", hasher.finish())
}
