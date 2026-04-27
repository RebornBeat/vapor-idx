// =============================================================================
// vapor-idx — schema.rs
// =============================================================================

use crate::types::*;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

pub fn validate_schema(schema: &VaporSchema) -> VaporResult<()> {
    if schema.types.is_empty() {
        return Err(VaporError::Schema("Schema must declare at least one type.".into()));
    }
    let declared: std::collections::HashSet<&str> = schema.types.keys().map(|s| s.as_str()).collect();
    for (type_name, type_def) in &schema.types {
        for (field_name, field_def) in &type_def.fields {
            if field_def.index == IndexStrategy::Range
                && field_def.field_type != FieldType::Number
                && field_def.field_type != FieldType::NumberArray
            {
                return Err(VaporError::Schema(format!(
                    "Field \"{field_name}\" on \"{type_name}\" uses Range index but is not a number type."
                )));
            }
        }
        for (rel_name, rel_def) in &type_def.relationships {
            for target in &rel_def.target_types {
                if target != "*" && !declared.contains(target.as_str()) {
                    return Err(VaporError::Schema(format!(
                        "Relationship \"{rel_name}\" on \"{type_name}\" references undeclared type \"{target}\"."
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
    let obj = data.as_object().ok_or_else(|| VaporError::Schema("Record data must be an object.".into()))?;
    for (field_name, field_def) in &type_def.fields {
        if field_def.required && !obj.contains_key(field_name) {
            return Err(VaporError::Schema(format!(
                "Required field \"{field_name}\" missing on type \"{type_name}\"."
            )));
        }
    }
    Ok(())
}

pub fn hash_schema(schema: &VaporSchema) -> String {
    let mut hasher = DefaultHasher::new();
    let serialised = serde_json::to_string(schema).unwrap_or_default();
    serialised.hash(&mut hasher);
    format!("{:x}", hasher.finish())
}
